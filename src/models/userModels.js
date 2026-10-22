const pool = require("../config/db");

const getUserByEmail = async (email) => {
  const result = await pool.query("SELECT * FROM admin_user WHERE username = $1 AND status = 'Active'", [email]);
  return result.rows[0];
};

const checkPrivilegesForRole = async (role_id) => {
  try {
 
    const result = await pool.query("SELECT privileges FROM role_list WHERE id = $1", [role_id]);
    
    if (result.rows.length === 0) {
      return { error: "Role not found" };
    }

    
    const privileges = result.rows[0].privileges;
    
  
    const hasPrivilege1 = privileges.includes("1");
    const hasPrivilege2 = privileges.includes("2");

  
    if (hasPrivilege1 && hasPrivilege2) {
      return { privileges: 'Both' };
    } else if (hasPrivilege1) {
      return { privileges: 'one' };
    } else if (hasPrivilege2) {
      return { privileges: 'two' };
    } else {
      return { privileges: 'No relevant privileges' };
    }
  } catch (err) {
    console.error("Error checking privileges:", err);
    return { error: "Error checking privileges" };
  }
};

const getClientynamebyID = async(client_id)=>{
  try {
    const userResult = await pool.query(
      "SELECT first_name FROM clients WHERE id = $1",
      [client_id]
    );
    const clientFirstName = userResult.rows.length > 0 ? userResult.rows[0].first_name : "Unknown User";
   return clientFirstName
  } catch (error) {
    console.error("Error inserting user log:", error);
  }
}

const formatPhoneNumber = (phone) => {
  const phoneRegex = /^[0-9]+$/; // Ensure only numbers are allowed

  if (!phoneRegex.test(phone)) {
    return { error: "Invalid phone number. Only digits are allowed." };
  }

  if (phone.startsWith("07") && phone.length === 10) {
    return { formatted: "94" + phone.substring(1) }; // Convert 07xxxxxxxx to 947xxxxxxxx
  } else if (phone.startsWith("+94") && phone.length === 12) {
    return { formatted: phone.substring(1) }; // Remove "+" to make it 94xxxxxxxxxx
  } else if (phone.startsWith("7") && phone.length === 9) {
    return { formatted: "94" + phone }; // Convert 7xxxxxxxx to 947xxxxxxxx
  } else if (phone.startsWith("94") && phone.length === 11) {
    return { formatted: phone }; // Keep as is
  }

  return { error: "Invalid phone number format." };
};

const formatEmail = (email) => { 
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { error: "Invalid email format." };
  }
  return { formatted: email }; 
};

const getBrandingSetting = async (fieldName) => {
  try {
    const query = `SELECT ${fieldName} FROM branding_settings LIMIT 1;`;
    const result = await pool.query(query);
    
    return result.rows.length > 0 ? result.rows[0][fieldName] : null;
  } catch (error) {
    console.error(`Error fetching ${fieldName} from branding_setting:`, error);
    return null;
  }
};

const insertAdminLog = async ( user_id, module, log) => {
  try {
    const query = `
      INSERT INTO admin_log (user_id, module, log, date) 
      VALUES ($1, $2, $3, NOW())`;
    
    await pool.query(query, [user_id, module, log]);
    console.log(`User Log Added: ${module} - ${log}`);
  } catch (error) {
    console.error("Error inserting user log:", error);
  }
};

const insertAdminlogs = async (module, log, user) => {
  const result = await pool.query("INSERT INTO admin_log (date, module, log, user_id) VALUES ( NOW(), $1, $2, $3)", [module, log, user]);
  return result;
};

const getAdminhubID = async (id) => {
  const result = await pool.query("SELECT u.hub_id, h.name FROM admin_user u INNER JOIN hub h ON u.hub_id = h.id WHERE u.id = $1 AND u.status = 'Active'", [id]);
  return result.rows[0];
};


const getAgentNameByID = async (id) => {
  try {
    const query = "SELECT first_name, last_name FROM admin_user WHERE id = $1 AND role_id = '4'";
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return null; 
    }

    return result.rows[0];
  } catch (error) {
    console.error("Error fetching agent by ID:", error);
    throw new Error("Database query failed"); 
  }
};

const saveCsvUploadHistory = async (client, csvLink, successCount, unsuccessCount, unsuccessRows, clientId, userId,upload_key,succes_row) => {
  try {
    const insertQuery = `
      INSERT INTO upload_csv_history (date,csv_link, success_count, unsuccess_count, unsuccess_row, client_id, user_id,upload_key,succes_row)
      VALUES (NOW(),$1, $2, $3, $4, $5, $6,$7,$8)
      RETURNING id;
    `;
    
    const values = [
      csvLink,
      successCount,
      unsuccessCount,
      JSON.stringify(unsuccessRows),  // Convert failed rows array to JSON
      clientId,
      userId,
      upload_key,
      JSON.stringify(succes_row)
    ];
    
    const result = await client.query(insertQuery, values);
    console.log(`Upload history recorded with ID: ${result.rows[0].id}`);
  } catch (error) {
    console.error("Error inserting upload history:", error);
  }
};


const getUsernamebyID = async(id)=>{
  try {
    const userResult = await pool.query(
      "SELECT first_name FROM admin_user WHERE id = $1",
      [id]
    );
    const clientFirstName = userResult.rows.length > 0 ? userResult.rows[0].first_name : "Unknown User";
   return clientFirstName
  } catch (error) {
    console.error("Error inserting user log:", error);
  }
}

// Modified saveBackupRecord function
async function saveBackupRecord(service, result, startTime) {
  try {
    console.log(`   📝 Saving record for ${service.service_name}...`);
    
    const recordQuery = `
      INSERT INTO backup_records (
        service_id,
        service_name,
        database_server_id,
        backup_status,
        backup_url,
        file_size_mb,
        duration_seconds,
        error_message,
        backup_start_time,
        backup_end_time
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;
    
    const endTime = new Date();
    const values = [
      service.id,
      service.service_name,
      service.database_server_id,
      result.success ? 'success' : 'failed',
      result.backupUrl || null,
      result.fileSizeMB ? parseFloat(result.fileSizeMB) : null,
      result.duration ? parseFloat(result.duration) : null,
      result.error || null,
      startTime,
      endTime
    ];
    
    const dbResult = await pool.query(recordQuery, values);
    
    // IMPORTANT: Force commit after each insert
    await pool.query('COMMIT');
    
    console.log(`    Record saved for ${service.service_name} (ID: ${dbResult.rows[0].id})`);
  } catch (error) {
    console.error(`   ❌ Failed to save backup record for ${service.service_name}:`, error);
    // Try to rollback if there's an error
    try {
      await pool.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError);
    }
  }
}

// Modified saveBackupSummary function
async function saveBackupSummary(results, totalSuccess, totalFailed, startTime, endTime) {
  try {
    console.log("📝 Attempting to save backup summary...");
    
    const summaryQuery = `
      INSERT INTO backup_history (
        backup_date,
        total_services,
        successful_backups,
        failed_backups,
        total_duration_seconds,
        details
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;
    
    const totalDuration = ((endTime - startTime) / 1000).toFixed(2);
    const details = JSON.stringify(results.map(r => ({
      service_name: r.service.service_name,
      success: r.success,
      error: r.error || null,
      backup_url: r.backupUrl || null,
      file_size_mb: r.fileSizeMB || null,
      duration_seconds: r.duration || null
    })));
    
    const result = await pool.query(summaryQuery, [
      startTime,
      results.length,
      totalSuccess,
      totalFailed,
      totalDuration,
      details
    ]);
    
    // IMPORTANT: Force commit
    await pool.query('COMMIT');
    
    console.log(` Backup summary saved to database (ID: ${result.rows[0].id})`);
    return result.rows[0].id;
  } catch (error) {
    console.error("❌ Failed to save backup summary to database:", error);
    // Try to rollback
    try {
      await pool.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError);
    }
    return null;
  }
}

module.exports = { getUserByEmail ,formatPhoneNumber,checkPrivilegesForRole,formatEmail,insertAdminLog, insertAdminlogs, getAdminhubID,getBrandingSetting,getAgentNameByID,getClientynamebyID,saveCsvUploadHistory, getUsernamebyID,saveBackupSummary,saveBackupRecord};
