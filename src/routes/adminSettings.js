const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");
const { formatPhoneNumber, insertAdminlogs } = require("../models/userModels");
const { useDetails, updateUser, changePassword } = require("../controllers/adminController");
const axios = require('axios')
const UAParser = require("ua-parser-js");

const router = express.Router();

router.post('/update-general-settings', authenticateToken, async (req, res) => {
  try {
    const { role_id, user_id, timezone, date_format, default_currency, auto_logout_time } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }
    if (!timezone) {
      return res.status(400).json({ message: "timezone is required" });
    }
    if (!date_format) {
      return res.status(400).json({ message: "date_format is required" });
    }
    if (!default_currency) {
      return res.status(400).json({ message: "default_currency is required" });
    }
    if (!auto_logout_time) {
      return res.status(400).json({ message: "auto_logout_time is required" });
    }

    // Update the system settings dynamically
    const updateQueries = [
      { key: 'timezone', value: timezone },
      { key: 'date_format', value: date_format },
      { key: 'default_currency', value: default_currency },
      { key: 'auto_logout_time', value: auto_logout_time }
    ];

    for (const setting of updateQueries) {
      await pool.query(
        `UPDATE system_settings 
                 SET setting_value = $1, updated_at = NOW() 
                 WHERE setting_key = $2`,
        [setting.value, setting.key]
      );
    }

    // Log the action with user ID
    const logMessage = `updated general settings by User ID: ${user_id}`;
    await insertAdminlogs("System Settings", logMessage, user_id); // Insert admin log

    return res.status(200).json({
      message: "General settings updated successfully",
      updated_settings: { timezone, date_format, default_currency, auto_logout_time }
    });

  } catch (error) {
    console.error("Error updating general settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/get-general-settings', authenticateToken, async (req, res) => {
  try {
    const { user_id, role_id } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    // Fetch general settings from system_settings table
    const query = `
            SELECT setting_key, setting_value 
            FROM system_settings
            WHERE setting_key IN ('timezone', 'date_format', 'default_currency', 'auto_logout_time');
        `;

    const result = await pool.query(query);

    // Convert rows into key-value pairs
    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });

    return res.status(200).json({
      message: "General settings retrieved successfully",
      settings
    });

  } catch (error) {
    console.error("Error fetching general settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/get-smsgateway-settings', authenticateToken, async (req, res) => {
  try {
    const { user_id, role_id } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    // Fetch general settings from system_settings table
    const query = `
            SELECT setting_key, setting_value 
            FROM system_settings
            WHERE setting_key IN ('sms_gateway_provider', 'sms_api_key', 'sms_sender_id', 'sms_user_id', 'sms_notification_status', 'sms_api_endpoint');
        `;

    const result = await pool.query(query);

    // Convert rows into key-value pairs
    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });

    return res.status(200).json({
      message: "sms settings retrieved successfully",
      settings
    });

  } catch (error) {
    console.error("Error fetching general settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/get-courier', authenticateToken, async (req, res) => {
  try {

    // Fetch general settings from system_settings table
    const query = `
            SELECT setting_key, setting_value 
            FROM system_settings
            WHERE setting_key IN ('external_active', 'courier');
        `;

    const result = await pool.query(query);

    // Convert rows into key-value pairs
    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });

    return res.status(200).json({
      message: "sms settings retrieved successfully",
      settings
    });

  } catch (error) {
    console.error("Error fetching general settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/save-get-courier', authenticateToken, async (req, res) => {
  try {
    const { external_active, courier } = req.body;

    const user = req.user
    const user_id = user.user_id


    // Update the system settings dynamically
    const updateQueries = [
      { key: 'external_active', value: external_active },
      { key: 'courier', value: courier }
    ];

    for (const setting of updateQueries) {
      await pool.query(
        `UPDATE system_settings 
                 SET setting_value = $1, updated_at = NOW() 
                 WHERE setting_key = $2`,
        [setting.value, setting.key]
      );
    }

    // Log the action with user ID
    const logMessage = `updated Courier by User ID: ${user_id}`;
    await insertAdminlogs("System Settings", logMessage, user_id); // Insert admin log

    return res.status(200).json({
      message: "SMS settings updated successfully"
    });

  } catch (error) {
    console.error("Error updating SMS settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});


router.post('/get-notification-settings', authenticateToken, async (req, res) => {
  try {
    const { user_id /*, role_id */ } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    // Keys we care about
    const KEYS = [
      'registerSMS',
      'registerEmail',
      'activationSMS',
      'activationEmail',
      'adminSmsEnabled',
      'adminEmailEnabled',
      'adminMobiles',
      'adminEmails',
    ];

    // Sensible defaults (strings to match your payload style)
    const defaults = {
      registerSMS: '0',
      registerEmail: '0',
      activationSMS: '0',
      activationEmail: '0',
      adminSmsEnabled: '0',
      adminEmailEnabled: '0',
      adminMobiles: '',
      adminEmails: '',
    };

    // Fetch settings
    const { rows } = await pool.query(
      `SELECT setting_key, setting_value
         FROM system_settings
        WHERE setting_key = ANY($1::text[])`,
      [KEYS]
    );

    // Build result with defaults, then overlay DB values
    const settings = { ...defaults };
    const coerce01 = (v) => (v === '1' ? '1' : '0');

    rows.forEach(({ setting_key, setting_value }) => {
      if (['registerSMS', 'registerEmail', 'activationSMS', 'activationEmail', 'adminSmsEnabled', 'adminEmailEnabled']
        .includes(setting_key)) {
        // ensure toggles are strictly "0"/"1"
        settings[setting_key] = coerce01(String(setting_value ?? '0'));
      } else {
        // lists (mobiles/emails) as-is (strings)
        settings[setting_key] = String(setting_value ?? '');
      }
    });

    return res.status(200).json({
      message: "notification settings retrieved successfully",
      settings,
    });

  } catch (error) {
    console.error("Error fetching notification settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});



router.post('/update-sms-settings', authenticateToken, async (req, res) => {
  try {
    const { role_id, user_id, sms_gateway_provider, sms_api_key, sms_sender_id, sms_user_id, sms_notification_status, sms_api_endpoint } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }
    if (!sms_gateway_provider) {
      return res.status(400).json({ message: "sms_gateway_provider is required" });
    }
    if (!sms_api_key) {
      return res.status(400).json({ message: "sms_api_key is required" });
    }
    if (!sms_sender_id) {
      return res.status(400).json({ message: "sms_sender_id is required" });
    }
    if (!sms_user_id) {
      return res.status(400).json({ message: "sms_user_id is required" });
    }


    // Update the system settings dynamically
    const updateQueries = [
      { key: 'sms_gateway_provider', value: sms_gateway_provider },
      { key: 'sms_api_key', value: sms_api_key },
      { key: 'sms_sender_id', value: sms_sender_id },
      { key: 'sms_user_id', value: sms_user_id },
      { key: 'sms_notification_status', value: sms_notification_status },
      { key: 'sms_api_endpoint', value: sms_api_endpoint }
    ];

    for (const setting of updateQueries) {
      await pool.query(
        `UPDATE system_settings 
                 SET setting_value = $1, updated_at = NOW() 
                 WHERE setting_key = $2`,
        [setting.value, setting.key]
      );
    }

    // Log the action with user ID
    const logMessage = `updated sms settings by User ID: ${user_id}`;
    await insertAdminlogs("System Settings", logMessage, user_id); // Insert admin log

    return res.status(200).json({
      message: "SMS settings updated successfully",
      updated_settings: { sms_gateway_provider, sms_api_key, sms_sender_id, sms_user_id, sms_notification_status, sms_api_endpoint }
    });

  } catch (error) {
    console.error("Error updating SMS settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/get-maintenance-settings', async (req, res) => {
  try {
    const { user_id, role_id } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    // Fetch general settings from system_settings table
    const query = `
            SELECT id,setting_key, setting_value, title, message
            FROM system_settings
            WHERE setting_key IN (
                'system_wide_maintenance', 
                'client_panel_maintenance', 
                'client_api_maintenance', 
                'client_mobile_app_maintenance', 
                'hub_maintenance', 
                'rider_app_maintenance', 
                'website_maintenance'
            );
        `;

    const result = await pool.query(query);

    return res.status(200).json({
      message: "Maintenance settings retrieved successfully",
      settings: result.rows
    });

  } catch (error) {
    console.error("Error fetching maintenance settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

//  Update Maintenance Settings API
router.post('/update-maintenance-settings', authenticateToken, async (req, res) => {
  try {
    const { user_id, role_id, settings } = req.body;

    //  Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    // setting is a array
    if (!settings || settings.length === 0) {
      return res.status(400).json({ message: "settings array is required" });
    }

    for (const setting of settings) {
      const id = setting.id
      const setting_value = setting.setting_value
      const title = setting.title
      const message = setting.message

      const query = `UPDATE system_settings SET setting_value = $1, title = $2, message = $3, updated_at = NOW() WHERE id = $4`
      const { rowCount } = await pool.query(query, [setting_value, title, message, id])

      if (rowCount === 0) {
        return res.status(400).json({ message: `Setting with ID ${id} not found` });
      }



    }

    //  All updates completed
    return res.status(200).json({
      message: " Maintenance settings updated successfully",
      updated_settings: settings
    });



  } catch (error) {
    console.error("❌ Error updating maintenance settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});


router.post('/get-emailgateway-settings', authenticateToken, async (req, res) => {
  try {
    const { user_id, role_id } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    // Fetch general settings from system_settings table
    const query = `
            SELECT setting_key, setting_value 
            FROM system_settings
            WHERE setting_key IN ('billing_email_address', 'system_email_address', 'support_email_address', 'enable_email_notifications_status', 'postmark_server_token', 'smtp_host','smtp_port','smtp_username','smtp_password','smtp_encryption');
        `;

    const result = await pool.query(query);

    // Convert rows into key-value pairs
    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });

    return res.status(200).json({
      message: "email settings retrieved successfully",
      settings
    });

  } catch (error) {
    console.error("Error fetching email settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/update-email-settings', authenticateToken, async (req, res) => {
  try {
    const {
      role_id, user_id,
      billing_email_address = "",
      system_email_address = "",
      support_email_address = "",
      enable_email_notifications_status,
      postmark_server_token = "",
      smtp_host = "",
      smtp_port = "",
      smtp_username = "",
      smtp_password = "",
      smtp_encryption = ""
    } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    // Convert boolean to string (if necessary)
    const emailNotificationsStatus = enable_email_notifications_status === true || enable_email_notifications_status === "true" ? "true" : "false";

    // Settings to be updated dynamically
    const settingsToUpdate = [
      { key: 'billing_email_address', value: billing_email_address },
      { key: 'system_email_address', value: system_email_address },
      { key: 'support_email_address', value: support_email_address },
      { key: 'enable_email_notifications_status', value: emailNotificationsStatus },
      { key: 'postmark_server_token', value: postmark_server_token },
      { key: 'smtp_host', value: smtp_host },
      { key: 'smtp_port', value: smtp_port },
      { key: 'smtp_username', value: smtp_username },
      { key: 'smtp_password', value: smtp_password },
      { key: 'smtp_encryption', value: smtp_encryption }
    ];

    // Execute each update separately
    for (const setting of settingsToUpdate) {
      await pool.query(
        `UPDATE system_settings 
                 SET setting_value = $1, updated_at = NOW() 
                 WHERE setting_key = $2`,
        [setting.value, setting.key]
      );
    }

    // Log the action with user ID
    const logMessage = `Updated Email settings by User ID: ${user_id}`;
    await insertAdminlogs("System Settings", logMessage, user_id); // Insert admin log

    return res.status(200).json({
      message: "Email settings updated successfully",
      updated_settings: {
        billing_email_address,
        system_email_address,
        support_email_address,
        enable_email_notifications_status: emailNotificationsStatus,
        postmark_server_token,
        smtp_host,
        smtp_port,
        smtp_username,
        smtp_password,
        smtp_encryption
      }
    });

  } catch (error) {
    console.error("Error updating email settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/update-company-details', authenticateToken, async (req, res) => {
  try {
    const {
      user_id,
      companyName,
      address1,
      address2,
      phone,
      facebook,
      twitter,
      instagram,
      linkedin,
      website,
      clientPortal,
      adminPortal,
      hubUrl
    } = req.body;


    if (!user_id) {
      return res.status(400).json({ message: "address1 is required" });
    }
    if (!companyName) {
      return res.status(400).json({ message: "phone is required" });
    }

    await pool.query(
      `UPDATE branding_settings 
             SET 
                company_name = $1,
                company_address_1 = $2,
                company_address_2 = $3,
                hotline = $4,
                facebook_url = $5,
                twitter_url = $6,
                instagram_url = $7,
                linkedin_url = $8,
                website_url = $9,
                client_portal_url = $10,
                admin_portal_url = $11,
                hub_url = $12,
                updated_at = NOW()
             WHERE id = 1`,
      [
        companyName,
        address1,
        address2 || '',
        phone,
        facebook || '',
        twitter || '',
        instagram || '',
        linkedin || '',
        website || '',
        clientPortal || '',
        adminPortal || '',
        hubUrl || ''
      ]
    );

    // Log the action with user ID
    const logMessage = `Updated Company Details by User ID: ${user_id}`;
    await insertAdminlogs("branding settings", logMessage, user_id); // Insert admin log

    return res.status(200).json({
      message: "Company branding settings updated successfully",
      updated_settings: {
        companyName,
        address1,
        address2,
        phone,
        facebook,
        twitter,
        instagram,
        linkedin,
        website,
        clientPortal,
        adminPortal,
        hubUrl
      }
    });

  } catch (error) {
    console.error("❌ Error updating company branding settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/get-company-details', authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;

    //  Validate Required Fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    //  Fetch company branding settings from the `branding_settings` table
    const query = `
            SELECT 
            logo_url,
                company_name, 
                company_address_1, 
                company_address_2, 
                hotline AS phone, 
                facebook_url AS facebook, 
                twitter_url AS twitter, 
                instagram_url AS instagram, 
                linkedin_url AS linkedin, 
                website_url AS website,
                client_portal_url AS clientPortal,
                admin_portal_url AS adminPortal,
                hub_url AS hubUrl
            FROM branding_settings
            WHERE id = 1;  -- Change if necessary
        `;

    const result = await pool.query(query);

    //  If no settings found, return an error
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Company settings not found" });
    }

    //  Return settings as a JSON response
    return res.status(200).json({
      message: "Company settings retrieved successfully",
      settings: result.rows[0]
    });

  } catch (error) {
    console.error("❌ Error fetching company settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});


router.post('/update-bank-details', authenticateToken, async (req, res) => {
  try {
    const {
      user_id,
      bankAccountName,
      bankName,
      bankAddress,
      bankAccountNumber,
      bankBranchName,
      bankSwiftCode
    } = req.body;

    //  Validate Required Fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }
    if (!bankAccountName) {
      return res.status(400).json({ message: "bankAccountName is required" });
    }
    if (!bankName) {
      return res.status(400).json({ message: "bankName is required" });
    }
    if (!bankAccountNumber) {
      return res.status(400).json({ message: "bankAccountNumber is required" });
    }

    //  Update the `branding_settings` Table with Bank Details
    await pool.query(
      `UPDATE branding_settings 
             SET 
                bank_account_name = $1,
                bank_name = $2,
                bank_address = $3,
                bank_account_number = $4,
                bank_branch_name = $5,
                bank_swift_code = $6,
                updated_at = NOW()
             WHERE id = 1`,  // Change ID if necessary
      [
        bankAccountName,
        bankName,
        bankAddress || '',
        bankAccountNumber,
        bankBranchName || '',
        bankSwiftCode || ''
      ]
    );

    // Log the action with user ID
    const logMessage = `Updated Bank Details by User ID: ${user_id}`;
    await insertAdminlogs("branding settings", logMessage, user_id); // Insert admin log

    return res.status(200).json({
      message: "Bank details updated successfully",
      updated_settings: {
        bankAccountName,
        bankName,
        bankAddress,
        bankAccountNumber,
        bankBranchName,
        bankSwiftCode
      }
    });

  } catch (error) {
    console.error("❌ Error updating bank details:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/get-bank-details', authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;

    //  Validate Required Fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    //  Fetch bank details from the `branding_settings` table
    const query = `
            SELECT 
                bank_account_name,
                bank_name,
                bank_address,
                bank_account_number,
                bank_branch_name,
                bank_swift_code
            FROM branding_settings
            WHERE id = 1;  -- Change if necessary
        `;

    const result = await pool.query(query);

    //  If no bank details found, return an error
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Bank details not found" });
    }

    //  Return bank details as a JSON response
    return res.status(200).json({
      message: "Bank details retrieved successfully",
      bank_details: result.rows[0]
    });

  } catch (error) {
    console.error("❌ Error fetching bank details:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});


router.post('/get-system-color', authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;

    //  Validate Required Fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    //  Fetch system color settings from the `branding_settings` table
    const query = `
            SELECT 
                primary_color,
                secondary_color
            FROM branding_settings
            WHERE id = 1;  -- Change if necessary
        `;

    const result = await pool.query(query);

    //  If no color settings found, return an error
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "System colors not found" });
    }



    //  Return system colors as a JSON response
    return res.status(200).json({
      message: "System colors retrieved successfully",
      system_colors: result.rows[0]
    });

  } catch (error) {
    console.error("❌ Error fetching system colors:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});


router.post('/update-system-color', authenticateToken, async (req, res) => {
  try {
    const {
      user_id,
      primaryColor,
      secondaryColor
    } = req.body;

    //  Validate Required Fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }


    //  Update the `branding_settings` Table with System Colors
    await pool.query(
      `UPDATE branding_settings 
             SET 
                primary_color = $1,
                secondary_color = $2,
                updated_at = NOW()
             WHERE id = 1`,  // Change ID if necessary
      [
        primaryColor,
        secondaryColor
      ]
    );

    // Log the action with user ID
    const logMessage = `Updated System colors by User ID: ${user_id}`;
    await insertAdminlogs("branding settings", logMessage, user_id); // Insert admin log

    return res.status(200).json({
      message: "System colors updated successfully",
      updated_settings: {
        primaryColor,
        secondaryColor
      }
    });

  } catch (error) {
    console.error("❌ Error updating system colors:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/update-system-images', authenticateToken, async (req, res) => {
  try {
    const { user_id, images } = req.body;

    //  Validate Required Fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }
    if (!images || !Array.isArray(images)) {
      return res.status(400).json({ message: "Valid images array is required" });
    }

    // Extract image URLs from the received images array
    let logoUrl = null;
    let faviconUrl = null;
    let logoUrlWhite = null;
    let adminWelcomeImg = null;
    let clientWelcomeImg = null;
    let clientMaintenanceImg = null;
    let lodingImgUrl = null;

    images.forEach(image => {
      if (image.name === "Company Logo") {
        logoUrl = image.imageUrl;
      } else if (image.name === "Fav Icon") {
        faviconUrl = image.imageUrl;
      } else if (image.name === "White Logo") {
        logoUrlWhite = image.imageUrl;
      } else if (image.name === "Admin Welcome") {
        adminWelcomeImg = image.imageUrl;
      } else if (image.name === "Client Welcome") {
        clientWelcomeImg = image.imageUrl;
      } else if (image.name === "Client Maintenance") {
        clientMaintenanceImg = image.imageUrl;
      } else if (image.name === "Loading Image") {
        lodingImgUrl = image.imageUrl;
      }
    });

    //  Update the `branding_settings` Table with Image URLs
    await pool.query(
      `UPDATE branding_settings 
             SET 
                logo_url = $1,
                favicon_url = $2,
                logo_url_white = $3,
                admin_welcome_img_url = $4,
                client_welcome_image_url = $5,
                client_maintenance_img_url = $6,
                loading_img_url = $7,
                updated_at = NOW()
             WHERE id = 1`,
      [
        logoUrl,
        faviconUrl,
        logoUrlWhite,
        adminWelcomeImg,
        clientWelcomeImg,
        clientMaintenanceImg,
        lodingImgUrl
      ]
    );

    // Log the action with user ID
    const logMessage = `Updated System images by User ID: ${user_id}`;
    await insertAdminlogs("branding settings", logMessage, user_id); // Insert admin log

    return res.status(200).json({
      message: "System images updated successfully",
      updated_images: {
        logoUrl,
        faviconUrl,
        logoUrlWhite,
        adminWelcomeImg,
        clientWelcomeImg,
        clientMaintenanceImg,
        lodingImgUrl
      }
    });

  } catch (error) {
    console.error("❌ Error updating system images:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/get-system-images', authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;

    //  Validate Required Fields
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    //  Fetch system images from the `branding_settings` table
    const query = `
            SELECT 
                logo_url,
                favicon_url,
                logo_url_white,
                admin_welcome_img_url,
                client_welcome_image_url,
                client_maintenance_img_url,
                loading_img_url
            FROM branding_settings
            WHERE id = 1;  -- Change ID if necessary
        `;

    const result = await pool.query(query);

    //  If no records found, return an error
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "System images not found" });
    }

    //  Map database keys to the expected frontend format
    const formattedImages = {
      "Company Logo": result.rows[0].logo_url || "",
      "White Logo": result.rows[0].logo_url_white || "",
      "Fav Icon": result.rows[0].favicon_url || "",
      "Admin Welcome": result.rows[0].admin_welcome_img_url || "",
      "Client Welcome": result.rows[0].client_welcome_image_url || "",
      "Client Maintenance": result.rows[0].client_maintenance_img_url || "",
      "Loading Image": result.rows[0].loading_img_url || ""
    };

    //  Return formatted response
    return res.status(200).json({
      message: "System images retrieved successfully",
      system_images: formattedImages
    });

  } catch (error) {
    console.error("❌ Error fetching system images:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});


router.get("/get-loading-images", async (req, res) => {
  try {
    // Fetch system images from the branding_settings table
    const query = `
        SELECT 
          logo_url,
          favicon_url,
          logo_url_white,
          admin_welcome_img_url,
          client_welcome_image_url,
          client_maintenance_img_url,
          loading_img_url,
          hotline
        FROM branding_settings
        WHERE id = 1; -- Change ID if necessary
      `;

    const result = await pool.query(query);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "System images not found" });
    }

    // Format response
    const formattedImages = {
      "Company Logo": result.rows[0].logo_url || "",
      "White Logo": result.rows[0].logo_url_white || "",
      "Fav Icon": result.rows[0].favicon_url || "",
      "Admin Welcome": result.rows[0].admin_welcome_img_url || "",
      "Client Welcome": result.rows[0].client_welcome_image_url || "",
      "Client Maintenance": result.rows[0].client_maintenance_img_url || "",
      "Loading Image": result.rows[0].loading_img_url || "",
      "hotline": result.rows[0].hotline || ""
    };

    return res.status(200).json({
      message: "System images retrieved successfully",
      system_images: formattedImages
    });

  } catch (error) {
    console.error("❌ Error fetching system images:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});


router.post('/update-notification-settings', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    let {
      user_id,
      role_id, // optional
      registerSMS,
      registerEmail,
      activationSMS,
      activationEmail,
      adminSmsEnabled,
      adminEmailEnabled,
      adminMobiles,
      adminEmails,

      // optional override: if true, clear lists when disabling toggles
      clearListsWhenDisabled = false,
    } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    // ---- helpers ----
    const sanitizeCommaList = (v = '') =>
      String(v).replace(/\s+/g, '').replace(/,+/g, ',').replace(/^,|,$/g, '');

    const splitCommaList = (v = '') =>
      sanitizeCommaList(v).split(',').filter(Boolean);

    const slMobileStrictRegex = /^94\d{9}$/;
    const normalizeTo94 = (raw = '') => {
      if (!raw) return '';
      if (raw.startsWith('+94')) return '94' + raw.slice(3);
      if (raw.startsWith('0') && raw.length === 10) return '94' + raw.slice(1);
      return raw;
    };

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const limitTo10 = (list) => list.slice(0, 10);
    const valid01 = ['0', '1'];

    // ---- normalize toggles to "0"/"1" ----
    registerSMS = registerSMS !== undefined ? String(registerSMS) : '0';
    registerEmail = registerEmail !== undefined ? String(registerEmail) : '0';
    activationSMS = activationSMS !== undefined ? String(activationSMS) : '0';
    activationEmail = activationEmail !== undefined ? String(activationEmail) : '0';
    adminSmsEnabled = adminSmsEnabled !== undefined ? String(adminSmsEnabled) : '0';
    adminEmailEnabled = adminEmailEnabled !== undefined ? String(adminEmailEnabled) : '0';

    if (![registerSMS, registerEmail, activationSMS, activationEmail, adminSmsEnabled, adminEmailEnabled]
      .every(v => valid01.includes(v))) {
      return res.status(400).json({ message: "Invalid toggle value(s). Must be '0' or '1'." });
    }

    // ---- lists: only validate/update when the toggle is ON ----
    let finalMobiles; // undefined => don't update column
    if (adminSmsEnabled === '1') {
      const mobiles = limitTo10(splitCommaList(adminMobiles || '').map(normalizeTo94));
      const bad = mobiles.filter(m => !slMobileStrictRegex.test(m));
      if (bad.length) {
        return res.status(400).json({
          message: "Invalid mobile(s). Required format 94XXXXXXXXX.",
          invalid_mobiles: bad
        });
      }
      finalMobiles = mobiles.join(','); // update when enabled (even if empty, that's intentional clear)
    } else {
      // disabled: preserve existing unless explicitly asked to clear
      if (clearListsWhenDisabled) finalMobiles = ''; // only clear if you explicitly request it
      // else leave undefined => no column update (preserve)
    }

    let finalEmails; // undefined => don't update column
    if (adminEmailEnabled === '1') {
      const emails = limitTo10(splitCommaList(adminEmails || ''));
      const bad = emails.filter(e => !emailRegex.test(e));
      if (bad.length) {
        return res.status(400).json({
          message: "Invalid email address(es).",
          invalid_emails: bad
        });
      }
      finalEmails = emails.join(','); // update when enabled (even if empty, intentional clear)
    } else {
      if (clearListsWhenDisabled) finalEmails = '';
    }

    // ---- perform updates in a txn ----
    await client.query('BEGIN');

    // always update toggles
    const updates = [
      { key: 'activationSMS', value: activationSMS },
      { key: 'activationEmail', value: activationEmail },
      { key: 'registerSMS', value: registerSMS },
      { key: 'registerEmail', value: registerEmail },
      { key: 'adminSmsEnabled', value: adminSmsEnabled },
      { key: 'adminEmailEnabled', value: adminEmailEnabled },
      // lists only if value is not undefined (i.e., we intend to update)
      ...(finalMobiles !== undefined ? [{ key: 'adminMobiles', value: finalMobiles }] : []),
      ...(finalEmails !== undefined ? [{ key: 'adminEmails', value: finalEmails }] : []),
    ];

    for (const { key, value } of updates) {
      const r = await client.query(
        `UPDATE system_settings
           SET setting_value = $1, updated_at = NOW()
         WHERE setting_key = $2`,
        [value, key]
      );
      if (r.rowCount === 0) {
        await client.query(
          `INSERT INTO system_settings (setting_key, setting_value, created_at, updated_at)
           VALUES ($1, $2, NOW(), NOW())`,
          [key, value]
        );
      }
    }

    await client.query('COMMIT');

    await insertAdminlogs(
      'notification settings',
      `Updated Notification settings (status-only when disabled) by User ID: ${user_id}`,
      user_id
    );

    return res.status(200).json({
      message: "Notification settings updated successfully",
      updated_settings: {
        activationSMS,
        activationEmail,
        registerSMS,
        registerEmail,
        adminSmsEnabled,
        adminEmailEnabled,
        // lists only included if we actually updated them; otherwise they’re preserved server-side
        ...(finalMobiles !== undefined ? { adminMobiles: finalMobiles } : {}),
        ...(finalEmails !== undefined ? { adminEmails: finalEmails } : {}),
      }
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('Error updating Notification settings:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    client.release();
  }
});



//kalana
router.post('/get-website-images', authenticateToken, async (req, res) => {
  try {


    //  Fetch system images from the `branding_settings` table
    const query = `
            SELECT 
                logo_url,
                favicon_url,
                logo_url_white,
                admin_welcome_img_url,
                client_welcome_image_url,
                client_maintenance_img_url,
                company_address_1,
                company_address_2,
                company_name,
                hotline
            FROM branding_settings
            WHERE id = 1; 
        `;

    const result = await pool.query(query);

    //  If no records found, return an error
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "System images not found" });
    }

    //  Map database keys to the expected frontend format
    const formattedImages = {
      "Company_Logo": result.rows[0].logo_url || "",
      "White_Logo": result.rows[0].logo_url_white || "",
      "Fav_Icon": result.rows[0].favicon_url || "",
      "Admin_Welcome": result.rows[0].admin_welcome_img_url || "",
      "Client_Welcome": result.rows[0].client_welcome_image_url || "",
      "Client_Maintenance": result.rows[0].client_maintenance_img_url || "",
      "company_address_1": result.rows[0].company_address_1 || "",
      "company_address_2": result.rows[0].company_address_2 || "",
      "company_name": result.rows[0].company_name || "",
      "hotline": result.rows[0].hotline || ""

    };

    //  Return formatted response
    return res.status(200).json({
      message: "System images retrieved successfully",
      result: formattedImages
    });

  } catch (error) {
    console.error("❌ Error fetching system images:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/spark-balance', async (req, res) => {
  try {
    const query = `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('spark_balance', 'spark_per_parcel_rate')`;
    const { rows } = await pool.query(query);

    if (rows.length === 0) {
      return res.status(404).json({ message: "System images not found" });
    }

    const response = {}

    rows.forEach(row => {
      response[row.setting_key] = row.setting_value
    })

    console.log(response)

    return res.status(200).json({
      message: "System images retrieved successfully",
      result: response
    });
  } catch (error) {
    console.error("❌ Error fetching system images:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post('/update-invoice-terms', authenticateToken, async (req, res) => {
  try {
    const { terms, quotation_terms } = req.body;

    // Get user_id from authenticateToken middleware
    const user_id = req.user?.user_id;

    if (!user_id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Prepare updates
    const updates = [];
    const updateQueries = [];

    // Validate and add invoice terms if provided
    if (terms !== undefined) {
      if (!Array.isArray(terms) || terms.length === 0) {
        return res.status(400).json({ message: "Invoice terms must be a non-empty array" });
      }
      const termsJson = JSON.stringify(terms);
      updates.push({ key: 'invoice_terms_conditions', value: termsJson });
      updateQueries.push(
        pool.query(
          `UPDATE system_settings
           SET setting_value = $1, updated_at = NOW()
           WHERE setting_key = $2`,
          [termsJson, 'invoice_terms_conditions']
        )
      );
    }

    // Validate and add quotation terms if provided
    if (quotation_terms !== undefined) {
      if (!Array.isArray(quotation_terms) || quotation_terms.length === 0) {
        return res.status(400).json({ message: "Quotation terms must be a non-empty array" });
      }
      const quotationTermsJson = JSON.stringify(quotation_terms);
      updates.push({ key: 'quotation_terms_conditions', value: quotationTermsJson });
      updateQueries.push(
        pool.query(
          `UPDATE system_settings
           SET setting_value = $1, updated_at = NOW()
           WHERE setting_key = $2`,
          [quotationTermsJson, 'quotation_terms_conditions']
        )
      );
    }

    // If no updates provided
    if (updates.length === 0) {
      return res.status(400).json({ message: "No terms provided to update" });
    }

    // Execute all updates
    const results = await Promise.all(updateQueries);

    // Check if any updates failed (rowCount === 0)
    const failedUpdates = results.filter(result => result.rowCount === 0);

    if (failedUpdates.length > 0) {
      return res.status(404).json({
        message: "Some settings not found. Please create them first.",
        missingSettings: updates.filter((_, index) => results[index].rowCount === 0).map(u => u.key)
      });
    }

    // Log the admin action
    const updatedFields = updates.map(u => u.key === 'invoice_terms_conditions' ? 'Invoice Terms' : 'Quotation Terms').join(', ');
    await insertAdminlogs(
      "System Settings",
      `Updated ${updatedFields} by User ID: ${user_id}`,
      user_id
    );

    return res.status(200).json({
      message: "Terms & Conditions updated successfully",
      updatedFields: updates.map(u => u.key),
      terms: terms || undefined,
      quotation_terms: quotation_terms || undefined
    });

  } catch (error) {
    console.error("Error updating terms:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});
// GET /settings/get-invoice-terms
router.get('/get-invoice-terms', authenticateToken, async (req, res) => {
  try {
    // Fetch both invoice and quotation terms in parallel
    const [invoiceResult, quotationResult] = await Promise.all([
      pool.query(
        `SELECT setting_value FROM system_settings WHERE setting_key = $1`,
        ['invoice_terms_conditions']
      ),
      pool.query(
        `SELECT setting_value FROM system_settings WHERE setting_key = $1`,
        ['quotation_terms_conditions']
      )
    ]);

    // Parse invoice terms
    let invoiceTerms = [];
    if (invoiceResult.rows.length > 0 && invoiceResult.rows[0].setting_value) {
      try {
        invoiceTerms = JSON.parse(invoiceResult.rows[0].setting_value);
      } catch (e) {
        console.error('Error parsing invoice terms:', e);
        invoiceTerms = [];
      }
    }

    // Parse quotation terms
    let quotationTerms = [];
    if (quotationResult.rows.length > 0 && quotationResult.rows[0].setting_value) {
      try {
        quotationTerms = JSON.parse(quotationResult.rows[0].setting_value);
      } catch (e) {
        console.error('Error parsing quotation terms:', e);
        quotationTerms = [];
      }
    }

    return res.status(200).json({
      terms: invoiceTerms,
      quotation_terms: quotationTerms
    });

  } catch (error) {
    console.error("Error fetching terms:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});
router.get("/get-email-template", authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const actionParam = req.query.action?.trim();
    const offset = (page - 1) * limit;

    let searchCondition = "";
    let queryParams = [];

    // If 'action' is passed, add it to the WHERE clause
    if (actionParam) {
      const actionId = parseInt(actionParam, 10);
      if (!isNaN(actionId)) {
        searchCondition = `WHERE et.action = $1`;
        queryParams.push(actionId);
      }
    }

    // Main query to get email templates
    const queryText = `
      SELECT 
        et.id, 
        et.subject,
        et.msg, 
        sa.name AS action_name, 
        et.admin, 
        et.client, 
        et."user", 
        et.status, 
        et.addby, 
        et.createddate
      FROM email_template et
      LEFT JOIN sms_action sa ON et.action = sa.id
      ${searchCondition}
      ORDER BY et.id DESC
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `;

    queryParams.push(limit, offset);

    const result = await pool.query(queryText, queryParams);

    // Query to get total count for pagination
    const totalCountQuery = `
      SELECT COUNT(*) FROM email_template et
      ${searchCondition}
    `;
    const countParams = queryParams.slice(0, queryParams.length - 2);
    const totalResult = await pool.query(totalCountQuery, countParams);

    const totalTemplates = parseInt(totalResult.rows[0].count, 10);

    // Respond with paginated data
    res.json({
      emailTemplates: result.rows,
      totalPages: Math.ceil(totalTemplates / limit),
      currentPage: page,
      totalTemplates,
    });
  } catch (error) {
    console.error("Error in /get-email-template:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

router.post("/add-email-template", authenticateToken, async (req, res) => {
  const { user_id, sms, action, Admin, Client, status, subject } = req.body;

  if (!user_id) {
    return res.status(400).json({ message: "User ID is required" });
  }

  try {
    const adminValue = Admin ? "Yes" : "";
    const clientValue = Client ? "Yes" : "";
    const actionValue = parseInt(action, 10);

    const result = await pool.query(
      `INSERT INTO email_template 
       (msg, action, admin, client, "user", status, addby, createddate,subject)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
       RETURNING *`,
      [
        sms,
        actionValue,
        adminValue,
        clientValue,
        user_id,
        status,
        user_id,
        subject,
      ]
    );

    res.status(201).json({
      message: "Email Template Added Successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error inserting Email template:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/email-template-status", authenticateToken, async (req, res) => {
  const { tempid, status, user_id } = req.body; //  Use `tempid` instead of `roleId`

  try {
    // Begin a transaction
    await pool.query("BEGIN");

    //  Update status in `sms_template` table
    const result = await pool.query(
      "UPDATE email_template SET status = $1, updateddate = NOW() WHERE id = $2 RETURNING *",
      [status, tempid]
    );

    // If no rows were affected, return an error
    if (result.rowCount === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).json({ message: "SMS Template not found" });
    }

    //  Insert log entry
    // const logMessage = `SMS Template ID ${tempid} was marked as ${status}`;
    // await insertAdminLog(user_id, "SMS Management", logMessage);

    // Commit the transaction
    await pool.query("COMMIT");

    res.json({
      message: "SMS Template status updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await pool.query("ROLLBACK"); // Rollback transaction on error
    console.error("Error updating SMS template status:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET email template by ID with action name
router.get("/email-template/:id", async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ message: "Missing template ID" });
  }

  try {
    const result = await pool.query(
      `SELECT 
          e.id,
          e.subject,
          e.msg,
          e.admin,
          e.client,
          e.status,
          a.name AS action_name
        FROM email_template e
        LEFT JOIN sms_action a ON e.action = a.id
        WHERE e.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Template not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching email template:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/update-email-template", authenticateToken, async (req, res) => {
  const { id, user_id, sms, action, admin, client, status, subject } = req.body;

  if (!id || !user_id) {
    return res
      .status(400)
      .json({ message: "Template ID and User ID are required" });
  }

  try {
    const adminValue = admin === "Yes" ? "Yes" : "No"; // Ensure "Yes" or "No"
    const clientValue = client === "Yes" ? "Yes" : "No"; // Ensure "Yes" or "No"
    const actionValue = parseInt(action, 10);

    const result = await pool.query(
      `UPDATE email_template 
         SET msg = $1, action = $2, admin = $3, client = $4, "user" = $5, status = $6, updateddate = NOW(), subject = $8
         WHERE id = $7 RETURNING *`,
      [sms, actionValue, adminValue, clientValue, user_id, status, id, subject]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Email Template not found" });
    }

    // Log the update action
    // const logMessage = `SMS Template ID: ${id} updated with new message "${sms}" and action ID: ${action} by User ID: ${user_id}`;
    // await insertAdminlogs("SMS Management", logMessage, user_id);

    res.status(200).json({
      message: "Email Template Updated Successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating Email template:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/get-email-temp-log", authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const action = req.query.action?.trim() || null;
    const email = req.query.email?.trim() || null;
    const status = req.query.status?.trim() || null;
    const startDate = req.query.startDate
      ? new Date(req.query.startDate)
      : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    const offset = (page - 1) * limit;

    let searchConditions = [];
    let queryParams = [];

    //  Filtering by action
    if (action) {
      searchConditions.push(`st.action = $${queryParams.length + 1}`);
      queryParams.push(action);
    }

    //  Filtering by mobile number
    if (email) {
      searchConditions.push(`st.email ILIKE $${queryParams.length + 1}`);
      queryParams.push(`%${email}%`);
    }

    //  Filtering by status
    if (status) {
      searchConditions.push(`st.status = $${queryParams.length + 1}`);
      queryParams.push(status);
    }

    //  Filtering by date range
    if (startDate) {
      searchConditions.push(`st.date >= $${queryParams.length + 1}`);
      queryParams.push(startDate);
    }
    if (endDate) {
      searchConditions.push(`st.date <= $${queryParams.length + 1}`);
      queryParams.push(endDate);
    }

    let whereClause =
      searchConditions.length > 0
        ? `WHERE ${searchConditions.join(" AND ")}`
        : "";

    //  Main Query with Pagination
    const queryText = `
            SELECT 
                st.id, 
                st.email, 
                st.msg, 
                st.status, 
                st.date, 
                st.sentdate, 
                                st.subject, 

                st.batche_id
            FROM send_email_temp_log st
            ${whereClause}
            ORDER BY st.id DESC
            LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
        `;

    queryParams.push(limit, offset);

    const result = await pool.query(queryText, queryParams);

    //  Total Count Query for Pagination
    const totalCountQuery = `
            SELECT COUNT(*) FROM send_email_temp_log st
            ${whereClause}
        `;
    const totalResult = await pool.query(
      totalCountQuery,
      queryParams.slice(0, -2)
    );
    const totalTemplates = parseInt(totalResult.rows[0].count, 10);

    res.json({
      smsTemplates: result.rows,
      totalPages: Math.ceil(totalTemplates / limit),
      currentPage: page,
      totalTemplates,
    });
  } catch (error) {
    console.error("Error in /get-email-temp-log:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

router.put("/update-sms-template", authenticateToken, async (req, res) => {
  const { id, user_id, sms, action, admin, client, status } = req.body;

  if (!id || !user_id) {
    return res
      .status(400)
      .json({ message: "Template ID and User ID are required" });
  }

  try {
    const adminValue = admin === "Yes" ? "Yes" : "No"; // Ensure "Yes" or "No"
    const clientValue = client === "Yes" ? "Yes" : "No"; // Ensure "Yes" or "No"
    const actionValue = parseInt(action, 10);

    const result = await pool.query(
      `UPDATE sms_template 
         SET msg = $1, action = $2, admin = $3, client = $4, "user" = $5, status = $6, updateddate = NOW()
         WHERE id = $7 RETURNING *`,
      [sms, actionValue, adminValue, clientValue, user_id, status, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "SMS Template not found" });
    }

    // Log the update action
    // const logMessage = `SMS Template ID: ${id} updated with new message "${sms}" and action ID: ${action} by User ID: ${user_id}`;
    // await insertAdminlogs("SMS Management", logMessage, user_id);

    res.status(200).json({
      message: "SMS Template Updated Successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating SMS template:", error);
    res.status(500).json({ message: "Server error" });
  }
});


router.post('/user-details', authenticateToken, useDetails)

router.post('/update-user-details', authenticateToken, updateUser)

router.post('/change-password', authenticateToken, changePassword)

// GET /settings/get-git-settings
router.get('/get-git-settings', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT setting_key, setting_value 
       FROM system_settings 
       WHERE setting_key = ANY($1)`,
      [['git_username', 'git_email', 'git_token']]
    );

    const gitSettings = {
      git_username: '',
      git_email: '',
      git_token: ''
    };

    result.rows.forEach(row => {
      gitSettings[row.setting_key] = row.setting_value;
    });

    return res.status(200).json(gitSettings);

  } catch (error) {
    console.error("Error fetching Git settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});
// POST /settings/update-git-settings
router.post('/update-git-settings', authenticateToken, async (req, res) => {
  const { git_username, git_email, git_token } = req.body;

  try {
    // Update each setting
    await pool.query(
      `UPDATE system_settings 
       SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
       WHERE setting_key = 'git_username'`,
      [git_username]
    );

    await pool.query(
      `UPDATE system_settings 
       SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
       WHERE setting_key = 'git_email'`,
      [git_email]
    );

    await pool.query(
      `UPDATE system_settings 
       SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
       WHERE setting_key = 'git_token'`,
      [git_token]
    );

    return res.status(200).json({ message: "Git settings updated successfully" });

  } catch (error) {
    console.error("Error updating Git settings:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});
// POST /settings/add-domain-settings
router.post('/add-domain-settings', authenticateToken, async (req, res) => {
  const { domain_name, zone_id, cloudflare_api_token } = req.body

  if (!domain_name || !zone_id || !cloudflare_api_token) {
    return res.status(400).json({ message: "All fields are required" })
  }

  try {
    // 1️⃣ Validate token & zone with Cloudflare
    const cfResponse = await axios.get(
      `https://api.cloudflare.com/client/v4/zones/${zone_id}`,
      {
        headers: {
          Authorization: `Bearer ${cloudflare_api_token}`,
          'Content-Type': 'application/json'
        }
      }
    )

    if (!cfResponse.data.success) {
      return res.status(400).json({
        message: "Invalid Cloudflare API token or Zone ID",
        errors: cfResponse.data.errors
      })
    }

    // 2️⃣ Insert into DB
    const result = await pool.query(
      `INSERT INTO domain_settings (domain_name, zone_id, cloudflare_api_token)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [domain_name, zone_id, cloudflare_api_token]
    )

    return res.status(201).json({
      message: "Domain added successfully",
      data: result.rows[0]
    })

  } catch (error) {
    if (error.response && error.response.data) {
      // Cloudflare API returned an error
      return res.status(400).json({
        message: "Cloudflare validation failed",
        errors: error.response.data.errors
      })
    }

    if (error.code === '23505') {
      return res.status(400).json({ message: "Domain already exists" })
    }

    console.error("Error adding domain:", error)
    return res.status(500).json({ message: "Internal Server Error" })
  }
})
// GET /settings/get-all-domains?page=1&limit=10
router.get('/get-all-domains', authenticateToken, async (req, res) => {
  try {
    // Parse query params with defaults
    const page = parseInt(req.query.page) || 1;  // default page 1
    const limit = parseInt(req.query.limit) || 10; // default 10 items per page
    const offset = (page - 1) * limit;

    // Fetch total count
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM domain_settings`
    );
    const total = parseInt(countResult.rows[0].total);

    // Fetch paginated data
    const result = await pool.query(
      `SELECT id, domain_name, zone_id, created_at
       FROM domain_settings
       ORDER BY id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return res.status(200).json({
      data: result.rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error("Error fetching domains:", error);
    return res.status(500).json({
      message: "Internal Server Error"
    });
  }
});
// Update a domain by ID
router.put('/update-domains/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { domain_name, zone_id, cloudflare_api_token } = req.body;

  // Validate input
  if (!domain_name || !zone_id || !cloudflare_api_token) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    // 1️⃣ Validate token & zone with Cloudflare
    const cfResponse = await axios.get(
      `https://api.cloudflare.com/client/v4/zones/${zone_id}`,
      {
        headers: {
          Authorization: `Bearer ${cloudflare_api_token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!cfResponse.data.success) {
      return res.status(400).json({
        message: "Invalid Cloudflare API token or Zone ID",
        errors: cfResponse.data.errors
      });
    }

    // 2️⃣ Update domain in database
    const result = await pool.query(
      `UPDATE domain_settings
       SET domain_name = $1,
           zone_id = $2,
           cloudflare_api_token = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [domain_name, zone_id, cloudflare_api_token, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Domain not found" });
    }

    return res.status(200).json({
      message: "Domain updated successfully",
      data: result.rows[0]
    });

  } catch (error) {
    // Handle Cloudflare API error
    if (error.response && error.response.data) {
      return res.status(400).json({
        message: "Cloudflare validation failed",
        errors: error.response.data.errors
      });
    }

    // Handle duplicate domain_name (unique constraint)
    if (error.code === '23505') {
      return res.status(400).json({ message: "Domain name already exists" });
    }

    console.error("Error updating domain:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.get('/servers/file', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, node_name, ip_address, port, status
       FROM server_nodes
       WHERE server_type = 'file_server'
       AND status = 'active'
       ORDER BY id DESC`
    )

    return res.status(200).json(result.rows)

  } catch (error) {
    console.error('Error fetching file servers:', error)
    return res.status(500).json({ message: 'Internal Server Error' })
  }
})

router.get('/servers/postgres', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, node_name, ip_address, postgresql_username, status
       FROM server_nodes
       WHERE server_type = 'database_server'
       AND status = 'active'
       ORDER BY id DESC`
    )

    return res.status(200).json(result.rows)

  } catch (error) {
    console.error('Error fetching postgres servers:', error)
    return res.status(500).json({ message: 'Internal Server Error' })
  }
})

router.get('/domains/list', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, domain_name
       FROM domain_settings
       ORDER BY id DESC`
    )

    return res.status(200).json(result.rows)

  } catch (error) {
    console.error('Error fetching domains:', error)
    return res.status(500).json({ message: 'Internal Server Error' })
  }
})

router.get('/auto-deploy', authenticateToken, async (req, res) => {
  try {
    const keys = [
      'auto_deploy_enabled',
      'auto_deploy_server_id',
      'auto_deploy_postgres_server_id',
      'auto_deploy_domain_id'
    ]

    const result = await pool.query(
      `SELECT setting_key, setting_value
       FROM system_settings
       WHERE setting_key = ANY($1)`,
      [keys]
    )

    const settings = {}
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value
    })

    return res.status(200).json({
      enabled: settings.auto_deploy_enabled === 'true',
      server_id: settings.auto_deploy_server_id || null,
      postgres_server_id: settings.auto_deploy_postgres_server_id || null,
      domain_id: settings.auto_deploy_domain_id || null
    })

  } catch (error) {
    console.error('Error fetching auto deploy settings:', error)
    return res.status(500).json({ message: 'Internal Server Error' })
  }
})

router.put('/auto-deploy', authenticateToken, async (req, res) => {
  const {
    enabled,
    server_id,
    postgres_server_id,
    domain_id
  } = req.body

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const updates = [
      { key: 'auto_deploy_enabled', value: String(enabled) },
      { key: 'auto_deploy_server_id', value: server_id },
      { key: 'auto_deploy_postgres_server_id', value: postgres_server_id },
      { key: 'auto_deploy_domain_id', value: domain_id },
    ]

    for (const item of updates) {
      await client.query(
        `INSERT INTO system_settings (setting_key, setting_value)
         VALUES ($1, $2)
         ON CONFLICT (setting_key)
         DO UPDATE SET 
            setting_value = EXCLUDED.setting_value,
            updated_at = CURRENT_TIMESTAMP`,
        [item.key, item.value]
      )
    }

    await client.query('COMMIT')

    return res.status(200).json({
      message: 'Auto deployment settings updated successfully'
    })

  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error updating auto deploy settings:', error)
    return res.status(500).json({ message: 'Internal Server Error' })
  } finally {
    client.release()
  }
})

router.get('/default-recurring-day', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT setting_key, setting_value 
       FROM system_settings 
       WHERE setting_key = $1`,
      ['default_recurring_day']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Default recurring day not found' });
    }

    const defaultRecurringDay = Number(result.rows[0].setting_value);

    return res.status(200).json({ defaultRecurringDay });

  } catch (error) {
    console.error("Error fetching default recurring day:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

// GET /settings/check-domain?subDomain=...&domain=...
router.get('/check-domain', authenticateToken, async (req, res) => {
  const { subDomain, domain } = req.query

  if (!subDomain || !domain) {
    return res.status(400).json({ message: 'subDomain and domain are required' })
  }

  const fullDomain = `${subDomain}.${domain}`

  const client = await pool.connect()

  try {
    // 1️⃣ Get domain settings from DB
    const result = await client.query(
      'SELECT zone_id, cloudflare_api_token FROM domain_settings WHERE domain_name = $1 LIMIT 1',
      [domain]
    )

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Domain not found in settings' })
    }

    const { zone_id: ZONE_ID, cloudflare_api_token: CLOUDFLARE_API_TOKEN } = result.rows[0]

    // 2️⃣ Call Cloudflare API
    const response = await axios.get(
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`,
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        params: { name: fullDomain },
      }
    )

    const exists = response.data.result.length > 0

    return res.status(200).json({ exists })
  } catch (error) {
    console.error('Cloudflare API error:', error.response?.data || error.message)
    return res.status(500).json({ message: 'Failed to check subdomain' })
  } finally {
    client.release()
  }
})

// Add this to your backend routes file
router.get('/get-quotation-terms', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT setting_value FROM system_settings WHERE setting_key = $1`,
      ['quotation_terms_conditions']
    );

    const terms = result.rows.length ? JSON.parse(result.rows[0].setting_value) : [];

    return res.status(200).json({ terms });

  } catch (error) {
    console.error("Error fetching quotation terms:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.get("/get-sms-template", authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const action = req.query.action?.trim() || null;
    const offset = (page - 1) * limit;

    let searchCondition = "";
    let queryParams = [];

    // Filter by action if provided
    if (action) {
      searchCondition = `WHERE st.action = $1`;
      queryParams.push(action);
    }

    // Query to fetch sms templates with action name from sms_action table
    const queryText = `
            SELECT 
                st.id, 
                st.msg, 
                st.action,
                sa.name AS action_name,
                st.admin,
                st.client,
                st."user", 
                st.status, 
                st.addby, 
                st.createddate, 
                st.updateddate
            FROM sms_template st
            LEFT JOIN sms_action sa ON st.action = sa.id
            ${searchCondition}
            ORDER BY st.id DESC
            LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
        `;

    queryParams.push(limit, offset);

    const result = await pool.query(queryText, queryParams);

    // Count query for pagination
    const totalCountQuery = `
            SELECT COUNT(*) FROM sms_template st
            ${searchCondition}
        `;
    const totalResult = await pool.query(totalCountQuery, queryParams.slice(0, -2));
    const totalTemplates = parseInt(totalResult.rows[0].count, 10);

    res.json({
      smsTemplates: result.rows,
      totalPages: Math.ceil(totalTemplates / limit),
      currentPage: page,
      totalTemplates,
    });

  } catch (error) {
    console.error("Error in /get-sms-template:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

router.get('/backup-settings', authenticateToken, async (req, res) => {
  try {
    const keys = [
      'db_backup_enabled',
      'db_backup_s3_region',
      'db_backup_s3_endpoint',
      'db_backup_s3_access_key',
      'db_backup_s3_secret_key',
      'db_backup_s3_bucket_name',
      'db_backup_convert_s3_url'
    ]

    const result = await pool.query(
      `SELECT setting_key, setting_value 
       FROM system_settings 
       WHERE setting_key = ANY($1)`,
      [keys]
    )

    const settings = {}
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value
    })

    return res.status(200).json({
      enabled: settings.db_backup_enabled === 'true',
      db_backup_s3_region: settings.db_backup_s3_region || '',
      db_backup_s3_endpoint: settings.db_backup_s3_endpoint || '',
      db_backup_s3_access_key: settings.db_backup_s3_access_key || '',
      db_backup_s3_secret_key: settings.db_backup_s3_secret_key || '',
      db_backup_s3_bucket_name: settings.db_backup_s3_bucket_name || '',
      db_backup_convert_s3_url: settings.db_backup_convert_s3_url || ''
    })

  } catch (error) {
    console.error('Error fetching backup settings:', error)
    return res.status(500).json({ message: 'Internal Server Error' })
  }
})


router.put('/backup-settings', authenticateToken, async (req, res) => {
  const {
    enabled,
    db_backup_s3_region,
    db_backup_s3_endpoint,
    db_backup_s3_access_key,
    db_backup_s3_secret_key,
    db_backup_s3_bucket_name,
    db_backup_convert_s3_url
  } = req.body

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const updates = [
      { key: 'db_backup_enabled', value: String(enabled) },
      { key: 'db_backup_s3_region', value: db_backup_s3_region },
      { key: 'db_backup_s3_endpoint', value: db_backup_s3_endpoint },
      { key: 'db_backup_s3_access_key', value: db_backup_s3_access_key },
      { key: 'db_backup_s3_secret_key', value: db_backup_s3_secret_key },
      { key: 'db_backup_s3_bucket_name', value: db_backup_s3_bucket_name },
      { key: 'db_backup_convert_s3_url', value: db_backup_convert_s3_url },
    ]

    for (const item of updates) {
      await client.query(
        `INSERT INTO system_settings (setting_key, setting_value)
         VALUES ($1, $2)
         ON CONFLICT (setting_key)
         DO UPDATE SET 
            setting_value = EXCLUDED.setting_value,
            updated_at = CURRENT_TIMESTAMP`,
        [item.key, String(item.value || '')] // Ensure value is a string for the text column
      )
    }

    await client.query('COMMIT')

    return res.status(200).json({
      message: 'Backup settings updated successfully'
    })

  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error updating backup settings:', error)
    return res.status(500).json({ message: 'Internal Server Error' })
  } finally {
    client.release()
  }
})

// POST /api/settings/update-profile-picture
router.post('/update-profile-picture', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.user_id;
        // Accept either field name
        const profile_image = req.body.profile_image || req.body.profile_picture;
        
        if (!profile_image) {
            return res.status(400).json({ 
                success: false, 
                message: 'Profile image URL is required. Please provide profile_image or profile_picture field.' 
            });
        }

        // Update database with the profile image URL
        const query = `
            UPDATE admin_user 
            SET profile_image = $1, updated_at = NOW() 
            WHERE id = $2 
            RETURNING id, first_name, last_name, email, profile_image
        `;
        
        const result = await pool.query(query, [profile_image, userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found' 
            });
        }

        res.status(200).json({ 
            success: true, 
            message: 'Profile image updated successfully',
            profile_image: result.rows[0].profile_image,
            result: result.rows[0]
        });
        
    } catch (error) {
        console.error('Error updating profile image:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to update profile image',
            error: error.message 
        });
    }
});

 //System Log

router.post("/systemlogsA", authenticateToken, async (req, res) => {
  const { page = 1, limit = 25, skip, zone_name, hubid, sys_id, date, log } = req.body;

  // =========================
  // GET CLIENT IP ADDRESS
  // =========================
  const ipAddress =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    req.ip;

  // =========================
  // GET DEVICE / BROWSER INFO
  // =========================
  const userAgent = req.headers["user-agent"];

  const parser = new UAParser(userAgent);
  const deviceInfo = parser.getResult();

  console.log("IP Address:", ipAddress);

  console.log("User Agent:", userAgent);

  console.log("Device Details:", {
    browser: deviceInfo.browser.name,
    browserVersion: deviceInfo.browser.version,
    os: deviceInfo.os.name,
    osVersion: deviceInfo.os.version,
    deviceType: deviceInfo.device.type || "desktop",
    deviceVendor: deviceInfo.device.vendor,
    deviceModel: deviceInfo.device.model,
  });

  // =========================
  // PAGINATION
  // =========================
  const offset = skip || (page - 1) * limit;

  const queryParams = [limit, offset];

  try {
    let query = `
      SELECT *
      FROM system_log AS sy
      WHERE 1=1
    `;

    if (sys_id) {
      query += ` AND sy.id = $${queryParams.length + 1}`;
      queryParams.push(sys_id);
    }

    if (date) {
      query += ` AND sy.datetime::date = $${queryParams.length + 1}`;
      queryParams.push(date);
    }

    if (log) {
      query += ` AND sy.comment ILIKE $${queryParams.length + 1}`;
      queryParams.push(`%${log}%`);
    }

    query += ` ORDER BY id DESC LIMIT $1 OFFSET $2`;

    const result = await pool.query(query, queryParams);

    // =========================
    // COUNT QUERY
    // =========================
    let countQueryParams = [];

    let countQuery = `
      SELECT COUNT(*)
      FROM system_log AS sy
      WHERE 1=1
    `;

    if (sys_id) {
      countQuery += ` AND sy.id = $${countQueryParams.length + 1}`;
      countQueryParams.push(sys_id);
    }

    if (date) {
      countQuery += ` AND sy.datetime::date = $${countQueryParams.length + 1}`;
      countQueryParams.push(date);
    }

    if (log) {
      countQuery += ` AND sy.comment ILIKE $${countQueryParams.length + 1}`;
      countQueryParams.push(`%${log}%`);
    }

    const countResult = await pool.query(countQuery, countQueryParams);

    const totalLogs = parseInt(countResult.rows[0].count, 10);

    res.json({
      logs: result.rows,
      totalLogs,
      totalPages: Math.ceil(totalLogs / limit),
      currentPage: page,

      // EXTRA INFO
      requestInfo: {
        ipAddress,
        browser: deviceInfo.browser.name,
        os: deviceInfo.os.name,
        deviceType: deviceInfo.device.type || "desktop",
      },
    });

  } catch (error) {
    console.error("Error fetching admin logs:", error);

    res.status(500).json({
      message: "Server error",
    });
  }
});
module.exports = router;