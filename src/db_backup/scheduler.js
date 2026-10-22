// scheduler.js
const cron = require('node-cron');
const { exec } = require('child_process');
const path = require('path');
require("dotenv").config();


cron.schedule('0 1 * * *', () => {
  console.log('⏰ Running scheduled backup...');
  const backupScriptPath = path.join(__dirname, 'backup.js');

  exec(`node "${backupScriptPath}"`, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Error running backup: ${error.message}`);
      return;
    }
    console.log(stdout);
  });
});
