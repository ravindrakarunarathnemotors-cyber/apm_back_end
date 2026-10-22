const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const pool = require("../config/db");
const { spawn } = require('child_process');
const fs = require('fs');
const zlib = require('zlib');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const CryptoJS = require('crypto-js');
const axios = require('axios'); // Make sure to install axios: npm install axios

// === Setup Backup Directory ===
const backupDir = path.join(__dirname, 'backups');

if (!fs.existsSync(backupDir)) {
  console.log(`📁 Creating backups directory: ${backupDir}`);
  fs.mkdirSync(backupDir, { recursive: true });
} else {
  console.log(`📁 Backups directory exists: ${backupDir}`);
}

// === Fetch S3 Settings from DB ===
async function getS3SettingsFromDB() {
  try {
    const keys = [
      'db_backup_enabled',
      'db_backup_s3_region',
      'db_backup_s3_endpoint',
      'db_backup_s3_access_key',
      'db_backup_s3_secret_key',
      'db_backup_s3_bucket_name',
      'db_backup_convert_s3_url'
    ];

    const result = await pool.query(
      `SELECT setting_key, setting_value FROM system_settings WHERE setting_key = ANY($1)`,
      [keys]
    );

    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });

    return settings;
  } catch (error) {
    console.error("❌ Error fetching S3 settings from DB:", error);
    throw error;
  }
}

// === Upload to S3 function ===
async function uploadToS3(filePath, serviceName, s3Client, s3Settings) {
  const fileContent = fs.readFileSync(filePath);
  const sanitizedServiceName = serviceName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const fileName = path.basename(filePath);
  const key = `client_backup/${sanitizedServiceName}/${fileName}`;
  
  const params = {
    Bucket: s3Settings.db_backup_s3_bucket_name,
    Key: key,
    Body: fileContent,
    ContentType: "application/gzip",
    // ACL: "public-read",
  };
  
  const command = new PutObjectCommand(params);
  await s3Client.send(command);
  
  const customBase = s3Settings.db_backup_convert_s3_url;
  const finalUrl = `${customBase}/${key}`;
  
  return { finalUrl, key };
}

// === Get all software services ===
async function getAllSoftwareServices() {
  try {
    const query = `
      SELECT 
        ss.id,
        ss.client_id,
        ss.service_name,
        ss.database_server_id
      FROM software_services ss
      WHERE ss.status = 'active'
        AND ss.database_server_id IS NOT NULL
      ORDER BY ss.id
    `;
    
    const result = await pool.query(query);
    console.log(`📋 Found ${result.rows.length} active software service(s)`);
    return result.rows;
  } catch (error) {
    console.error("❌ Error fetching software services:", error);
    throw error;
  }
}

// === Get database server details ===
async function getDatabaseServerDetails(serverId) {
  try {
    const ENCRYPTION_KEY = process.env.SERVER_PASSWORD_KEY;
    
    if (!ENCRYPTION_KEY) {
      throw new Error("SERVER_PASSWORD_KEY not found");
    }
    
    const query = `
      SELECT 
        id,
        node_name,
        ip_address,
        postgresql_username,
        postgresql_password
      FROM server_nodes
      WHERE id = $1 AND server_type = 'database_server'
    `;
    
    const result = await pool.query(query, [serverId]);
    
    if (result.rows.length === 0) {
      console.log(`⚠️ No database server found with ID: ${serverId}`);
      return null;
    }
    
    const server = result.rows[0];
    let decryptedPgPassword = null;
    
    try {
      if (server.postgresql_password) {
        decryptedPgPassword = CryptoJS.AES.decrypt(server.postgresql_password, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8);
      }
    } catch (decErr) {
      console.error(`❌ Decryption error:`, decErr);
    }
    
    return {
      id: server.id,
      node_name: server.node_name,
      ip_address: server.ip_address,
      postgresql_username: server.postgresql_username || 'postgres',
      postgresql_password: decryptedPgPassword,
      postgresql_port: 5432
    };
  } catch (error) {
    console.error(`❌ Error fetching database server:`, error);
    return null;
  }
}

// === Find pg_dump path ===
function findPgDump() {
  const possiblePaths = [
    '/usr/bin/pg_dump',
    '/usr/local/bin/pg_dump',
    '/usr/lib/postgresql/14/bin/pg_dump',
    '/usr/lib/postgresql/13/bin/pg_dump',
    '/usr/lib/postgresql/12/bin/pg_dump',
    '/opt/bitnami/postgresql/bin/pg_dump'
  ];
  
  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      console.log(` Found pg_dump at: ${testPath}`);
      return testPath;
    }
  }
  
  console.error("❌ pg_dump not found");
  return null;
}

// === Sanitize database name ===
function sanitizeDbName(serviceName) {
  let sanitized = serviceName.toLowerCase();
  sanitized = sanitized.replace(/\s+/g, '_');
  sanitized = sanitized.replace(/[^a-z0-9_-]/g, '');
  return sanitized;
}

// === Delete old backups ===
function deleteOldBackups(currentFileName, serviceBackupDir) {
  if (!fs.existsSync(serviceBackupDir)) return;
  
  const files = fs.readdirSync(serviceBackupDir);
  files.forEach(file => {
    if (file !== currentFileName) {
      try {
        fs.unlinkSync(path.join(serviceBackupDir, file));
        console.log(`🗑️ Deleted old backup: ${file}`);
      } catch (err) {
        console.error(`❌ Failed to delete ${file}: ${err.message}`);
      }
    }
  });
}

// === Send backup record to billing API ===
async function sendBackupRecordToAPI(service, result, startTime) {
  try {
    const billingUrl = process.env.BILLING_BACK_URL;
    const endpoint = `${billingUrl}/db_backup/records`;
    
    const endTime = new Date();
    const backupData = {
      service_id: service.id,
      service_name: service.service_name,
      client_id: service.client_id,
      database_server_id: service.database_server_id,
      backup_status: result.success ? 'success' : 'failed',
      backup_url: result.backupUrl || null,
      file_size_mb: result.fileSizeMB ? parseFloat(result.fileSizeMB) : null,
      duration_seconds: result.duration ? parseFloat(result.duration) : null,
      error_message: result.error || null,
      backup_start_time: startTime.toISOString(),
      backup_end_time: endTime.toISOString(),
      timestamp: new Date().toISOString()
    };
    
    console.log(`   📤 Sending to API: ${endpoint}`);
    console.log(`   📦 Payload:`, JSON.stringify(backupData, null, 2));
    
    const response = await axios.post(endpoint, backupData, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });
    
    if (response.data && response.data.success) {
      console.log(`    Backup record sent to billing system for ${service.service_name}`);
      console.log(`   📋 API Response:`, response.data);
      return true;
    } else {
      console.error(`   ⚠️ API returned unexpected response:`, response.data);
      return false;
    }
  } catch (error) {
    console.error(`   ❌ Failed to send backup record to billing API for ${service.service_name}:`);
    if (error.response) {
      console.error(`   📡 API Error Response: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error(`   📡 No response received from API: ${error.message}`);
    } else {
      console.error(`   📡 Request error: ${error.message}`);
    }
    return false;
  }
}

// === Send backup summary to billing API ===
async function sendBackupSummaryToAPI(results, totalSuccess, totalFailed, startTime, endTime) {
  try {
    const billingUrl = process.env.BILLING_BACK_URL;
    const endpoint = `${billingUrl}/db_backup/summary`;
    
    const totalDuration = ((endTime - startTime) / 1000).toFixed(2);
    
    const summaryData = {
      backup_date: startTime.toISOString(),
      backup_end_date: endTime.toISOString(),
      total_services: results.length,
      successful_backups: totalSuccess,
      failed_backups: totalFailed,
      total_duration_seconds: parseFloat(totalDuration),
      details: results.map(r => ({
        service_id: r.service.id,
        service_name: r.service.service_name,
        client_id: r.service.client_id,
        success: r.success,
        error: r.error || null,
        backup_url: r.backupUrl || null,
        file_size_mb: r.fileSizeMB ? parseFloat(r.fileSizeMB) : null,
        duration_seconds: r.duration ? parseFloat(r.duration) : null
      })),
      timestamp: new Date().toISOString()
    };
    
    console.log(`\n📤 Sending backup summary to API: ${endpoint}`);
    console.log(`📦 Summary Payload:`, JSON.stringify(summaryData, null, 2));
    
    const response = await axios.post(endpoint, summaryData, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000
    });
    
    if (response.data && response.data.success) {
      console.log(` Backup summary successfully sent to billing system`);
      console.log(`📋 API Response:`, response.data);
      return true;
    } else {
      console.error(`⚠️ API returned unexpected response for summary:`, response.data);
      return false;
    }
  } catch (error) {
    console.error(`❌ Failed to send backup summary to billing API:`);
    if (error.response) {
      console.error(`📡 API Error Response: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error(`📡 No response received from API: ${error.message}`);
    } else {
      console.error(`📡 Request error: ${error.message}`);
    }
    return false;
  }
}

// === Perform backup for single database ===
async function backupSingleDatabase(service, dbServer, startTime, s3Client, s3Settings) {
  const dbName = sanitizeDbName(service.service_name);
  const timestamp = new Date();
  const timestampStr = timestamp.toISOString().replace(/[:.]/g, '-');
  const fileName = `backup-${dbName}-${timestampStr}.sql.gz`;
  
  const serviceBackupDir = path.join(backupDir, dbName);
  if (!fs.existsSync(serviceBackupDir)) {
    fs.mkdirSync(serviceBackupDir, { recursive: true });
  }
  
  const filePath = path.join(serviceBackupDir, fileName);
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 Starting backup: ${service.service_name}`);
  console.log(`📊 Database: ${dbName}`);
  console.log(`🖥️ Server: ${dbServer.ip_address}:${dbServer.postgresql_port}`);
  console.log(`💾 Location: ${filePath}`);
  console.log(`${'='.repeat(60)}`);
  
  let backupSuccess = false;
  let backupError = null;
  let backupUrl = null;
  let fileSizeMB = null;
  let endTime = null;
  let duration = null;
  
  try {
    const pgDumpPath = findPgDump();
    if (!pgDumpPath) {
      throw new Error("pg_dump not found");
    }
    
    // Run pg_dump
    const dumpProcess = spawn(pgDumpPath, [
      '-h', dbServer.ip_address,
      '-p', dbServer.postgresql_port.toString(),
      '-U', dbServer.postgresql_username,
      '-d', dbName,
      '--no-owner',
      '--no-privileges',
      '--no-acl'
    ], {
      env: { ...process.env, PGPASSWORD: dbServer.postgresql_password || '' }
    });
    
    const outStream = fs.createWriteStream(filePath);
    const gzip = zlib.createGzip();
    dumpProcess.stdout.pipe(gzip).pipe(outStream);
    
    let errorOutput = '';
    
    dumpProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    const dumpExitCode = await new Promise((resolve) => {
      dumpProcess.on('close', resolve);
    });
    
    if (dumpExitCode !== 0) {
      throw new Error(`pg_dump failed with code ${dumpExitCode}: ${errorOutput.substring(0, 500)}`);
    }
    
    await new Promise((resolve) => outStream.on('finish', resolve));
    
    const fileStats = fs.statSync(filePath);
    if (fileStats.size === 0) {
      throw new Error('Backup file is empty!');
    }
    
    fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    console.log(`📊 Backup size: ${fileSizeMB} MB`);
    
    const uploadResult = await uploadToS3(filePath, service.service_name, s3Client, s3Settings);
    backupUrl = uploadResult.finalUrl;
    
    endTime = new Date();
    duration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`⏱️ Duration: ${duration} seconds`);
    
    deleteOldBackups(fileName, serviceBackupDir);
    
    backupSuccess = true;
    console.log(` Backup completed: ${service.service_name}\n`);
    
  } catch (error) {
    console.error(`❌ Backup failed for ${service.service_name}:`, error.message);
    backupSuccess = false;
    backupError = error.message;
    endTime = new Date();
    duration = ((endTime - startTime) / 1000).toFixed(2);
  }
  
  return {
    service,
    success: backupSuccess,
    error: backupError,
    backupUrl,
    fileSizeMB,
    duration
  };
}

// === Main backup process ===
async function performBackup() {
  const startTime = new Date();
  console.log("🕒 Backup started:", startTime.toLocaleString('en-GB', { timeZone: 'Asia/Colombo' }));
  console.log(`${'='.repeat(60)}\n`);
  
  try {
    // 1. Fetch S3 settings from DB
    const s3Settings = await getS3SettingsFromDB();

    // 2. Check if backup is globally enabled in settings
    if (s3Settings.db_backup_enabled !== 'true') {
      console.log("🛑 Backup is currently DISABLED in system settings. Exiting...");
      process.exit(0);
    }

    // 3. Initialize S3 Client with DB settings
    const s3Client = new S3Client({
      region: s3Settings.db_backup_s3_region,
      endpoint: `https://${s3Settings.db_backup_s3_endpoint}`,
      credentials: {
        accessKeyId: s3Settings.db_backup_s3_access_key,
        secretAccessKey: s3Settings.db_backup_s3_secret_key,
      },
      forcePathStyle: true,
    });

    // 4. Get all software services
    const services = await getAllSoftwareServices();

    if (services.length === 0) {
      console.log("No services to backup. Exiting...");
      return;
    }
    
    let totalSuccess = 0;
    let totalFailed = 0;
    const results = [];
    
    for (const service of services) {
      const dbServer = await getDatabaseServerDetails(service.database_server_id);
      
      if (!dbServer) {
        console.error(`❌ Skipping ${service.service_name}: Database server not found`);
        totalFailed++;
        results.push({
          service,
          success: false,
          error: "Database server not found",
          backupUrl: null,
          fileSizeMB: null,
          duration: null
        });
        continue;
      }
      
      if (!dbServer.postgresql_username || !dbServer.postgresql_password) {
        console.error(`❌ Skipping ${service.service_name}: PostgreSQL credentials missing`);
        totalFailed++;
        results.push({
          service,
          success: false,
          error: "PostgreSQL credentials missing",
          backupUrl: null,
          fileSizeMB: null,
          duration: null
        });
        continue;
      }
      
      // Pass s3Client and s3Settings to backupSingleDatabase
      const result = await backupSingleDatabase(service, dbServer, startTime, s3Client, s3Settings);
      results.push(result);
      
      if (result.success) {
        totalSuccess++;
      } else {
        totalFailed++;
      }
      
      // Send individual backup record to billing API immediately
      await sendBackupRecordToAPI(service, result, startTime);
      
      // Delay between backups
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log("📊 BACKUP SUMMARY");
    console.log(`${'='.repeat(60)}`);
    console.log(` Successful: ${totalSuccess}`);
    console.log(`❌ Failed: ${totalFailed}`);
    console.log(`📋 Total: ${services.length}`);
    
    console.log(`\n📋 DETAILED RESULTS:`);
    results.forEach(result => {
      const status = result.success ? '' : '❌';
      console.log(`${status} ${result.service.service_name}: ${result.success ? 'Success' : result.error}`);
      if (result.success && result.backupUrl) {
        console.log(`   URL: ${result.backupUrl}`);
        console.log(`   Size: ${result.fileSizeMB} MB`);
        console.log(`   Duration: ${result.duration} seconds`);
      }
    });
    
    const endTime = new Date();
    const totalDuration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`\n⏱️ Total time: ${totalDuration} seconds`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Send backup summary to billing API
    console.log("\n💾 Sending backup summary to billing system...");
    await sendBackupSummaryToAPI(results, totalSuccess, totalFailed, startTime, endTime);
    
    console.log("\n Backup process completed successfully!");
    process.exit(0);
    
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

// Start backup
performBackup();