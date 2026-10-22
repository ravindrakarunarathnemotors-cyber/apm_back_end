const https = require("https");
const pool = require("../config/db");
const axios = require("axios");
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.INVOICE_ENCRYPTION_KEY; // 32 chars
const IV_LENGTH = 16;

/**
 * Normalize a phone number to the format 947XXXXXXXX (Sri Lanka)
 * - Removes all non-digit characters
 * - If number starts with '0', removes the leading zero and prepends '94'
 * - If number starts with '94' already, returns as is
 * - If number starts with '7' and length is 9, prepends '94'
 * - Otherwise returns empty string (invalid)
 */
function normalizePhoneTo94(phone) {
    if (!phone) return '';
    // Remove all non-digit characters
    let digits = phone.replace(/\D/g, '');
    if (digits.length === 0) return '';

    // If already starts with 94 and length is 11, it's valid
    if (digits.startsWith('94') && digits.length === 11) {
        return digits;
    }
    // If starts with 0 (e.g., 077...), remove leading 0 and prepend 94
    if (digits.startsWith('0')) {
        digits = digits.substring(1); // remove leading 0
        if (digits.length === 9) {
            return '94' + digits;
        }
    }
    // If starts with 7 and length is 9 (e.g., 7736715096), prepend 94
    if (digits.startsWith('7') && digits.length === 9) {
        return '94' + digits;
    }
    // If it's exactly 11 digits starting with 94, return
    if (digits.length === 11 && digits.startsWith('94')) {
        return digits;
    }
    // If it's 10 digits starting with 7? (e.g., 7736715096? Actually 9 digits without leading 0 is common)
    // Let's also handle case where it's 9 digits starting with 7 (already handled)
    // If none match, return empty (invalid)
    return '';
}

const encryptInvoiceId = (id) => {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(
        'aes-256-cbc',
        Buffer.from(ENCRYPTION_KEY),
        iv
    );

    let encrypted = cipher.update(id.toString());
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    return iv.toString('hex') + ':' + encrypted.toString('hex');
};

function send_sms(client_id, api_key, sender_id, message, recipient_contact_no, sms_api_endpoint) {
    return new Promise((resolve, reject) => {
        // Extract hostname from API endpoint
        const url = new URL(sms_api_endpoint);
        const hostname = url.hostname;
        const path = `/v1/send/?user_id=${encodeURIComponent(client_id)}&api_key=${encodeURIComponent(api_key)}&sender_id=${encodeURIComponent(sender_id)}&message=${encodeURIComponent(message)}&recipient_contact_no=${encodeURIComponent(recipient_contact_no)}`;

        const options = {
            method: "GET",
            hostname: hostname,
            path: path,
            headers: {},
            maxRedirects: 20
        };

        const req = https.request(options, (res) => {
            let chunks = [];

            res.on("data", (chunk) => {
                chunks.push(chunk);
            });

            res.on("end", () => {
                const body = Buffer.concat(chunks).toString();
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    resolve(body);
                }
            });

            res.on("error", (error) => {
                console.error("SMS API Error:", error);
                reject(error);
            });
        });

        req.end();
    });
}
const getSmsSettings = async () => {
    try {
        // Query to fetch SMS settings from system_settings table
        const smsSettingsResult = await pool.query(
            "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('sms_api_endpoint', 'sms_api_key', 'sms_sender_id', 'sms_user_id','postmark_server_token','billing_email_address')"
        );

        // Convert array of results into an object
        const smsSettings = {};
        smsSettingsResult.rows.forEach(row => {
            smsSettings[row.setting_key] = row.setting_value;
        });

        return smsSettings;
    } catch (error) {
        console.error("Error fetching SMS settings:", error);
        return null; // Return null in case of an error
    }
};

const insertsmslog = async (mobileno, msg, action) => {
    try {
        const insertQuery = `
            INSERT INTO send_sms_temp_log (mobileno, msg, status, date, sentdate, action) 
            VALUES ($1, $2, 'Sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3) 
            RETURNING id;
        `;

        const result = await pool.query(insertQuery, [mobileno, msg, action]);

        return result.rows[0]; // Return inserted row with ID
    } catch (error) {
        console.error("❌ Error inserting SMS log:", error);
        throw error;
    }
};

const insertemaillog = async (email, msg, subject, action) => {
    try {
        const insertQuery = `
            INSERT INTO send_email_temp_log (email, msg, status, date, sentdate, action,subject) 
            VALUES ($1, $2, 'Sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3, $4) 
            RETURNING id;
        `;

        const result = await pool.query(insertQuery, [email, msg, action, subject]);

        return result.rows[0]; // Return inserted row with ID
    } catch (error) {
        console.error("❌ Error inserting email log:", error);
        throw error;
    }
};

async function sendEmailWithPostmark(to, subject, message, apiToken, fromEmail) {

    if (!apiToken) {
        console.error("Error: Postmark API token is missing.");
        return "Postmark API token is not configured.";
    }

    const postData = {
        "From": fromEmail,
        "To": to,
        "Subject": subject,
        "HtmlBody": message,
        "MessageStream": "outbound" // Default message stream for transactional emails
    };

    try {
        const response = await axios.post("https://api.postmarkapp.com/email", postData, {
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-Postmark-Server-Token": apiToken
            }
        });

        console.log("Email sent successfully:", response.data);
        return response.data; // Return full Postmark response
    } catch (error) {
        console.error("Error sending email:", error.response ? error.response.data : error.message);
        return `Error sending email: ${error.response ? JSON.stringify(error.response.data) : error.message}`;
    }
}

const customhookInvoice = async (
    actionId,
    inv_id,
    customer_mobile,
    customer_email
) => {
    try {
        let ressms = null;
        let resemail = null;

        // Only run for send invoice action
        if (actionId === 1 || actionId === 2) {

            //  Send SMS only if mobile exists
            if (customer_mobile) {
                ressms = await sendsmstemp_Send_Invoice(
                    actionId,
                    inv_id,
                    customer_mobile
                );
            }

            //  Send Email only if email exists
            if (customer_email) {
                resemail = await sendemailtemp_Send_Invoice(
                    actionId,
                    inv_id,
                    customer_email
                );
            }
        }

        return {
            sms: ressms,
            email: resemail
        };

    } catch (error) {
        console.error("Error in customhookInvoice:", error);
        throw error;
    }
};

const sendsmstemp_Send_Invoice = async (actionId, inv_id, customer_mobile) => {
    try {
        console.log(`Fetching SMS template for actionId: ${actionId}`);

        // 1️⃣ Get SMS template
        const smsResult = await pool.query(
            "SELECT msg, admin, client FROM sms_template WHERE action = $1 AND status = 'Active'",
            [actionId]
        );

        if (!smsResult.rows.length) {
            console.log("No active SMS template found.");
            return null;
        }

        const template = smsResult.rows[0];

        // 2️⃣ Get invoice + client details
        const invoiceResult = await pool.query(
            `SELECT i.*, 
              c.name, 
              c.contact_person_phone AS phone, 
              c.contact_person_email AS email
       FROM invoice_header i
       LEFT JOIN client c ON i.client_id = c.id
       WHERE i.id = $1`,
            [inv_id]
        );

        if (!invoiceResult.rows.length) {
            console.log("No invoice found for this ID:", inv_id);
            return null;
        }

        const invoice = invoiceResult.rows[0];

        // 3️⃣ Get branding
        const brandingResult = await pool.query(
            "SELECT company_name, hotline, support_email, website_url FROM branding_settings LIMIT 1"
        );

        const brandingRow = brandingResult.rows[0] || {};

        const branding = {
            company_name: brandingRow.company_name ?? '',
            hotline: brandingRow.hotline ?? '',
            support_email: brandingRow.support_email ?? '',
            website_url: brandingRow.website_url ?? ''
        };

        // 4️⃣ Get SMS API settings
        const smsSettings = await getSmsSettings();

        const sms_user_id = smsSettings?.sms_user_id ?? '';
        const sms_api_key = smsSettings?.sms_api_key ?? '';
        const sms_sender_id = smsSettings?.sms_sender_id ?? '';
        const sms_api_endpoint = smsSettings?.sms_api_endpoint ?? '';

        const baseUrl = process.env.BILLING_SEND_INVOICE_URL;

        // 🔐 Encrypt invoice ID
        const encryptedId = encryptInvoiceId(invoice.id);

        // Build full link
        const invoiceLink = `${baseUrl}/client/invoice/${encodeURIComponent(encryptedId)}`;


        const placeholders = {
            "[name]": invoice.name || '',
            "[phone]": invoice.phone || '',
            "[email]": invoice.email || '',
            "[Hotline]": branding.hotline,
            "[Webname]": branding.company_name,
            "[company_email]": branding.support_email,
            "[Inv_ID]": invoice.id || '',
            "[Inv_Link]": invoiceLink
        };


        let finalMessage = template.msg;

        for (const [key, value] of Object.entries(placeholders)) {
            finalMessage = finalMessage.replaceAll(key, value.toString());
        }

        // 6️⃣ Get Admin Phones from system_settings
        let adminPhones = [];

        if (template.admin === 'Yes') {
            const adminResult = await pool.query(
                "SELECT setting_value FROM system_settings WHERE setting_key = 'adminMobiles' LIMIT 1"
            );

            if (adminResult.rows.length > 0) {
                adminPhones = adminResult.rows[0].setting_value
                    .split(',')
                    .map(p => p.trim())
                    .filter(Boolean);
            }
        }

        // 7️⃣ Send SMS to Admins
        if (
            template.admin === 'Yes' &&
            adminPhones.length > 0 &&
            sms_user_id &&
            sms_api_key &&
            sms_sender_id &&
            sms_api_endpoint
        ) {
            for (const phone of adminPhones) {
                try {
                    const smsResponse = await send_sms(
                        sms_user_id,
                        sms_api_key,
                        sms_sender_id,
                        finalMessage,
                        phone,
                        sms_api_endpoint
                    );

                    console.log(`SMS sent to admin: ${phone}`, smsResponse);
                    await insertsmslog(phone, finalMessage, actionId);
                } catch (err) {
                    console.error(`Failed to send SMS to admin: ${phone}`, err);
                }
            }
        }

        // 8️⃣ Send SMS to Client
        if (
            template.client === 'Yes' &&
            customer_mobile &&
            sms_user_id &&
            sms_api_key &&
            sms_sender_id &&
            sms_api_endpoint
        ) {
            try {
                const smsResponse = await send_sms(
                    sms_user_id,
                    sms_api_key,
                    sms_sender_id,
                    finalMessage,
                    customer_mobile,
                    sms_api_endpoint
                );

                console.log(`SMS sent to client: ${customer_mobile}`, smsResponse);
                await insertsmslog(customer_mobile, finalMessage, actionId);
            } catch (err) {
                console.error(`Failed to send SMS to client: ${customer_mobile}`, err);
            }
        }

        // 9️⃣ Return result
        return {
            message: finalMessage,
            sendToAdmin: template.admin === 'Yes',
            sendToClient: template.client === 'Yes',
            invoiceDetails: invoice,
            branding
        };

    } catch (error) {
        console.error("Error in sendsmstemp_invoice:", error);
        return null;
    }
};

// Fetch Email Settings (Postmark token, billing email)
const getEmailSettings = async () => {
    try {
        const result = await pool.query(
            "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('postmark_server_token','billing_email_address')"
        );

        const settings = {};
        result.rows.forEach(row => {
            settings[row.setting_key] = row.setting_value;
        });

        return settings;
    } catch (error) {
        console.error("Error fetching email settings:", error);
        return null;
    }
};

// Send email via Postmark
async function sendEmailWithPostmark(to, subject, message, apiToken, fromEmail) {
    if (!apiToken) {
        console.error("Postmark API token is missing.");
        return "Postmark API token is not configured.";
    }

    const postData = {
        From: fromEmail,
        To: to,
        Subject: subject,
        HtmlBody: message,
        MessageStream: "outbound"
    };

    try {
        const response = await axios.post(
            "https://api.postmarkapp.com/email",
            postData,
            {
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "X-Postmark-Server-Token": apiToken
                }
            }
        );
        console.log("Email sent successfully:", response.data);
        return response.data;
    } catch (error) {
        console.error("Error sending email:", error.response ? error.response.data : error.message);
        return `Error sending email: ${error.response ? JSON.stringify(error.response.data) : error.message}`;
    }
}

// Generate HTML email message dynamically based on actionId
async function getEmailMsg(actionId, message, invoiceLink) {
    try {
        const brandingQuery = await pool.query(
            "SELECT company_name, hotline, logo_url, website_url, support_email FROM branding_settings LIMIT 1"
        );

        const branding = brandingQuery.rows.length > 0
            ? brandingQuery.rows[0]
            : {};

        // 🎯 Determine header
        let headerTitle = "Order Notification";
        if (actionId === 1) headerTitle = "Invoice Notification";
        else if (actionId === 2) headerTitle = "Invoice Reminder";

        // 🎯 Create button only if link exists
        const buttonHTML = invoiceLink
            ? `<div style="margin:20px 0; text-align:center;">
                    <a href="${invoiceLink}" 
                       target="_blank"
                       style="
                           display:inline-block;
                           padding:12px 25px;
                           font-size:16px;
                           color:#ffffff;
                           background-color:#1a4e8a;
                           text-decoration:none;
                           border-radius:6px;
                       ">
                       View Invoice
                    </a>
               </div>`
            : '';

        let processedMessage = message;

        //  Replace Button Placeholder
        if (processedMessage.includes("[Inv_Button]")) {
            processedMessage = processedMessage.replaceAll(
                "[Inv_Button]",
                buttonHTML
            );
        } else {
            processedMessage = processedMessage.replaceAll("[Inv_Button]", "");
        }

        //  Replace Link Placeholder
        if (processedMessage.includes("[Inv_Link]")) {
            processedMessage = processedMessage.replaceAll(
                "[Inv_Link]",
                invoiceLink || ""
            );
        } else {
            processedMessage = processedMessage.replaceAll("[Inv_Link]", "");
        }

        return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #dce6f1; border-radius: 8px; background-color: #f4f8fc;">
            
            <div style="text-align: center; padding: 20px 0;">
                <img src="${branding.logo_url || ''}" 
                     alt="Logo" 
                     style="max-width: 150px; margin-bottom: 10px;">
                <h2 style="color: #1a4e8a; margin: 0;">${headerTitle}</h2>
            </div>

            <div style="
                background:#ffffff; 
                padding:20px; 
                border-radius:8px;  
                box-shadow:0px 4px 12px rgba(0,64,128,0.05);
                font-size:16px; 
                color:#333;
            ">
                ${processedMessage}
            </div>

            <div style="margin-top:20px; text-align:center;">
                <p style="color:#555; font-size:14px;">
                    Hotline: <strong>${branding.hotline || ""}</strong>
                </p>
                <p style="font-size:14px;">
                    <a href="${branding.website_url || '#'}"
                       style="color:#1a4e8a; text-decoration:none;">
                       ${branding.website_url || ""}
                    </a>
                </p>
            </div>

            <div style="text-align:center; font-size:12px; color:#777; margin-top:30px;">
                <p>Thank you for choosing 
                   <strong>${branding.company_name || ""}</strong>.
                </p>
            </div>
        </div>
        `;
    } catch (error) {
        console.error("Error generating email HTML:", error.message);
        return null;
    }
}

// Main function to send invoice email
const sendemailtemp_Send_Invoice = async (actionId, inv_id, customer_email) => {
    try {
        console.log(`Fetching email template for actionId: ${actionId}`);

        // 1️⃣ Get email template
        const templateResult = await pool.query(
            "SELECT msg, admin, client, subject FROM email_template WHERE action = $1 AND status = 'Active'",
            [actionId]
        );

        if (!templateResult.rows.length) {
            console.log("No active email template found.");
            return null;
        }

        const template = templateResult.rows[0];

        // 2️⃣ Get invoice + client details
        const invoiceResult = await pool.query(
            `SELECT i.*, c.name, c.contact_person_phone AS phone, c.contact_person_email AS email
       FROM invoice_header i
       LEFT JOIN client c ON i.client_id = c.id
       WHERE i.id = $1`,
            [inv_id]
        );

        if (!invoiceResult.rows.length) {
            console.log("No invoice found for this ID:", inv_id);
            return null;
        }

        const invoice = invoiceResult.rows[0];

        // 3️⃣ Get branding
        const brandingResult = await pool.query(
            "SELECT company_name, hotline, support_email, website_url, logo_url FROM branding_settings LIMIT 1"
        );

        const brandingRow = brandingResult.rows[0] || {};
        const branding = {
            company_name: brandingRow.company_name || '',
            hotline: brandingRow.hotline || '',
            support_email: brandingRow.support_email || '',
            website_url: brandingRow.website_url || '',
            logo_url: brandingRow.logo_url || ''
        };

        // 4️⃣ Get Email API settings
        const settings = await getEmailSettings();
        const billing_email = settings?.billing_email_address;
        const postmark_token = settings?.postmark_server_token;

        if (!billing_email || !postmark_token) {
            console.warn("⚠️ Email settings not configured properly.");
            return null;
        }

        // 🔐 Generate encrypted invoice link
        const baseUrl = process.env.BILLING_SEND_INVOICE_URL;

        const encryptedId = encryptInvoiceId(invoice.id);

        const invoiceLink = `${baseUrl}/client/invoice/${encodeURIComponent(encryptedId)}`;


        const placeholders = {
            "[name]": invoice.name || '',
            "[phone]": invoice.phone || '',
            "[email]": customer_email || '',
            "[Hotline]": branding.hotline,
            "[Webname]": branding.company_name,
            "[company_email]": branding.support_email,
            "[Inv_ID]": invoice.id || '',
            "[Inv_Link]": invoiceLink
        };


        let finalMessage = template.msg;
        for (const [key, value] of Object.entries(placeholders)) {
            finalMessage = finalMessage.replaceAll(key, value.toString());
        }

        // 6️⃣ Generate HTML email body
        const emailHTML = await getEmailMsg(actionId, finalMessage, invoiceLink);

        // 7️⃣ Send Admin Emails
        if (template.admin === 'Yes') {
            const adminResult = await pool.query(
                "SELECT setting_value FROM system_settings WHERE setting_key = 'adminEmails' LIMIT 1"
            );

            let adminEmails = [];
            if (adminResult.rows.length > 0) {
                adminEmails = adminResult.rows[0].setting_value
                    .split(',')
                    .map(e => e.trim())
                    .filter(Boolean);
            }

            for (const email of adminEmails) {
                try {
                    await sendEmailWithPostmark(email, template.subject, emailHTML, postmark_token, billing_email);
                    console.log(` Email sent to admin: ${email}`);
                    await insertemaillog(email, finalMessage, template.subject, actionId);
                } catch (err) {
                    console.error(`❌ Failed to send email to admin: ${email}`, err);
                }
            }
        }

        // 8️⃣ Send Client Email
        if (template.client === 'Yes' && customer_email) {
            try {
                await sendEmailWithPostmark(customer_email, template.subject, emailHTML, postmark_token, billing_email);
                console.log(` Email sent to client: ${customer_email}`);
                await insertemaillog(customer_email, finalMessage, template.subject, actionId);
            } catch (err) {
                console.error(`❌ Failed to send email to client: ${customer_email}`, err);
            }
        }

        // 9️⃣ Return result
        return {
            message: finalMessage,
            sendToAdmin: template.admin === 'Yes',
            sendToClient: template.client === 'Yes',
            invoiceDetails: invoice,
            branding
        };

    } catch (error) {
        console.error("❌ Error in sendemailtemp_Send_Invoice:", error);
        return null;
    }
};

async function sendProvisioningEmailPostmark({
  nodeName,
  serverType,
  ipAddress,
  port,
  username,
  databaseUsername,
  databasePassword
}) {
  try {
    // 1️⃣ Get email settings
    const settings = await getEmailSettings();

    if (!settings || !settings.postmark_server_token || !settings.billing_email_address) {
      console.error("Postmark settings missing.");
      return;
    }

    // 2️⃣ Get admin emails from system settings
    const adminEmailsResult = await pool.query(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'adminEmails' LIMIT 1"
    );

    let toEmails = [];
    if (adminEmailsResult.rows.length > 0) {
      toEmails = adminEmailsResult.rows[0].setting_value
        .split(',')
        .map(e => e.trim())
        .filter(Boolean);
    }

    // 3️⃣ Fallback to billing email if no admin emails configured
    if (toEmails.length === 0) {
      toEmails = [settings.billing_email_address];
    }

    // 4️⃣ PHPPgAdmin login URL
    const phpPgAdminUrl = `http://${ipAddress}/phppgadmin/`;

    // 5️⃣ Build email message content
    let messageContent = `
      <p><strong>Node Name:</strong> ${nodeName}</p>
      <p><strong>Server Type:</strong> ${serverType}</p>
      <p><strong>IP Address:</strong> ${ipAddress}</p>
    `;

    if (serverType === 'database_server') {
      messageContent += `
        <p><strong>Database Username:</strong> ${databaseUsername}</p>
        <p><strong>Database Password:</strong> ${databasePassword}</p>
        <p><strong>PHPPgAdmin URL:</strong> <a href="${phpPgAdminUrl}">${phpPgAdminUrl}</a></p>
      `;
    }

    // 6️⃣ Fetch branding
    const brandingQuery = await pool.query(
      "SELECT company_name, hotline, logo_url, website_url, support_email FROM branding_settings LIMIT 1"
    );
    const branding = brandingQuery.rows.length > 0 ? brandingQuery.rows[0] : {};

    // 7️⃣ Build branded HTML
    const emailHTML = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #dce6f1; border-radius: 8px; background-color: #f4f8fc;">
          
          <div style="text-align: center; padding: 20px 0;">
              <img src="${branding.logo_url || ''}" 
                   alt="Logo" 
                   style="max-width: 150px; margin-bottom: 10px;">
              <h2 style="color: #1a4e8a; margin: 0;">Server Node Provisioned Successfully</h2>
          </div>

          <div style="
              background:#ffffff; 
              padding:20px; 
              border-radius:8px;  
              box-shadow:0px 4px 12px rgba(0,64,128,0.05);
              font-size:16px; 
              color:#333;
          ">
              ${messageContent}
          </div>

          <div style="margin-top:20px; text-align:center;">
              <p style="color:#555; font-size:14px;">
                  Hotline: <strong>${branding.hotline || ""}</strong>
              </p>
              <p style="font-size:14px;">
                  <a href="${branding.website_url || '#'}"
                     style="color:#1a4e8a; text-decoration:none;">
                     ${branding.website_url || ""}
                  </a>
              </p>
          </div>

          <div style="text-align:center; font-size:12px; color:#777; margin-top:30px;">
              <p>Thank you for choosing 
                 <strong>${branding.company_name || ""}</strong>.
              </p>
          </div>
      </div>
    `;

    // 8️⃣ Send email to all admin recipients
    for (const to of toEmails) {
      try {
        await sendEmailWithPostmark(
          to,
          `Server ${nodeName} Provisioned Successfully`,
          emailHTML,
          settings.postmark_server_token,
          settings.billing_email_address
        );
        console.log(` Notification email sent to ${to}`);
      } catch (err) {
        console.error(`❌ Failed to send email to ${to}`, err);
      }
    }

  } catch (error) {
    console.error("❌ Error in sendProvisioningEmailPostmark:", error);
  }
}

const sendServiceInstallationEmail = async (actionId, serviceId) => {
    try {
        console.log(`Fetching email template for actionId: ${actionId}`);

        // 1️⃣ Get email template
        const templateResult = await pool.query(
            "SELECT msg, admin, client, subject FROM email_template WHERE action = $1 AND status = 'Active'",
            [actionId]
        );

        if (!templateResult.rows.length) {
            console.log("No active email template found.");
            return null;
        }
        const template = templateResult.rows[0];

        // 2️⃣ Get service + client details
        const serviceResult = await pool.query(
            `SELECT s.id AS service_id,
                    s.service_name,
                    s.domain_name,
                    s.status,
                    c.id AS client_id,
                    c.name AS client_name,
                    c.contact_person_name,
                    c.contact_person_email,
                    c.contact_person_phone,
                    c.company_name,
                    c.company_email
             FROM software_services s
             JOIN client c ON s.client_id = c.id
             WHERE s.id = $1`,
            [serviceId]
        );

        if (!serviceResult.rows.length) {
            console.log("No service found for ID:", serviceId);
            return null;
        }
        const service = serviceResult.rows[0];

        // 3️⃣ Get deployment details (component URLs and ports)
        const deploymentResult = await pool.query(
            `SELECT component, domain, port
             FROM service_deployment_details
             WHERE service_id = $1`,
            [serviceId]
        );
        const deployments = deploymentResult.rows;

        // Build lists of URLs for website and admin frontends
        const websiteUrls = deployments
            .filter(d => d.component.includes('website-frontend'))
            .map(d => d.domain)
            .join(', ');
        const adminUrls = deployments
            .filter(d => d.component.includes('admin-frontend'))
            .map(d => d.domain)
            .join(', ');

        // 4️⃣ Default credentials (customize as needed)
        // Option 1: Fetch from a temporary store (if you saved them during deployment)
        // Option 2: Provide a generic message or a password‑reset link
       // 4️⃣ Default credentials (as provided)
const defaultCredentials = "Username: tekoadmin\nPassword: 123456789\n\nPlease change your password after first login.";

        // 5️⃣ Get branding settings
        const brandingResult = await pool.query(
            "SELECT company_name, hotline, support_email, website_url, logo_url FROM branding_settings LIMIT 1"
        );
        const branding = brandingResult.rows[0] || {
            company_name: '',
            hotline: '',
            support_email: '',
            website_url: '',
            logo_url: ''
        };

        // 6️⃣ Get email API settings
        const settings = await getEmailSettings();
        const fromEmail = settings?.billing_email_address || branding.support_email;
        const postmarkToken = settings?.postmark_server_token;

        if (!fromEmail || !postmarkToken) {
            console.warn("⚠️ Email settings not configured properly.");
            return null;
        }

        // 7️⃣ Prepare placeholders
        const placeholders = {
            "[name]": service.contact_person_name || service.client_name || '',
            "[phone]": service.contact_person_phone || '',
            "[email]": service.contact_person_email || service.company_email || '',
            "[Servise_Name]": service.service_name,
            "[Servise_ID]": service.service_id,
            "[Website_URLs]": websiteUrls || 'N/A',
            "[Admin_URLs]": adminUrls || 'N/A',
            "[Default_Credentials]": defaultCredentials,
            "[Hotline]": branding.hotline,
            "[Webname]": branding.company_name,
            "[company_email]": branding.support_email
        };

        let finalMessage = template.msg;
        for (const [key, value] of Object.entries(placeholders)) {
            finalMessage = finalMessage.replaceAll(key, value.toString());
        }

        // 8️⃣ Generate HTML email body (adapted for installation)
        const emailHTML = await getServiceInstallationEmailMsg(
            actionId,
            finalMessage,
            { websiteUrls, adminUrls, service, branding }
        );

        // 9️⃣ Send to admin (if required)
        if (template.admin === 'Yes') {
            const adminResult = await pool.query(
                "SELECT setting_value FROM system_settings WHERE setting_key = 'adminEmails' LIMIT 1"
            );

            let adminEmails = [];
            if (adminResult.rows.length > 0) {
                adminEmails = adminResult.rows[0].setting_value
                    .split(',')
                    .map(e => e.trim())
                    .filter(Boolean);
            }

            for (const email of adminEmails) {
                try {
                    await sendEmailWithPostmark(email, template.subject, emailHTML, postmarkToken, fromEmail);
                    console.log(` Email sent to admin: ${email}`);
                    await insertemaillog(email, finalMessage, template.subject, actionId);
                } catch (err) {
                    console.error(`❌ Failed to send email to admin: ${email}`, err);
                }
            }
        }

        // 🔟 Send to client (if required)
        if (template.client === 'Yes' && placeholders["[email]"]) {
            try {
                await sendEmailWithPostmark(
                    placeholders["[email]"],
                    template.subject,
                    emailHTML,
                    postmarkToken,
                    fromEmail
                );
                console.log(` Email sent to client: ${placeholders["[email]"]}`);
                await insertemaillog(placeholders["[email]"], finalMessage, template.subject, actionId);
            } catch (err) {
                console.error(`❌ Failed to send email to client: ${placeholders["[email]"]}`, err);
            }
        }

        return {
            message: finalMessage,
            sendToAdmin: template.admin === 'Yes',
            sendToClient: template.client === 'Yes',
            service,
            branding
        };

    } catch (error) {
        console.error("❌ Error in sendServiceInstallationEmail:", error);
        return null;
    }
};

async function getServiceInstallationEmailMsg(actionId, message, data) {
    try {
        const branding = data.branding || {};

        // Optional: set a different header for installation
        let headerTitle = "Service Installation Notification";
        if (actionId === 3) headerTitle = "New Service Deployed"; // adjust actionId as needed

        // Check which parts of the summary have data
        const hasServiceName = data.service && data.service.service_name;
        const hasWebsiteUrls = data.websiteUrls && data.websiteUrls.trim() !== '' && data.websiteUrls !== 'N/A';
        const hasAdminUrls = data.adminUrls && data.adminUrls.trim() !== '' && data.adminUrls !== 'N/A';

        // Build summary HTML only if at least one piece of data exists
        let summaryHTML = '';
        if (hasServiceName || hasWebsiteUrls || hasAdminUrls) {
            summaryHTML = '<div style="margin:20px 0; padding:15px; background:#f0f7ff; border-radius:6px;">';
            if (hasServiceName) {
                summaryHTML += `<p><strong>Service:</strong> ${data.service.service_name}</p>`;
            }
            if (hasWebsiteUrls) {
                summaryHTML += `<p><strong>Website URLs:</strong> ${data.websiteUrls}</p>`;
            }
            if (hasAdminUrls) {
                summaryHTML += `<p><strong>Admin URLs:</strong> ${data.adminUrls}</p>`;
            }
            summaryHTML += '</div>';
        }

        return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #dce6f1; border-radius: 8px; background-color: #f4f8fc;">
            
            <div style="text-align: center; padding: 20px 0;">
                <img src="${branding.logo_url || ''}" 
                     alt="Logo" 
                     style="max-width: 150px; margin-bottom: 10px;">
                <h2 style="color: #1a4e8a; margin: 0;">${headerTitle}</h2>
            </div>

            <div style="
                background:#ffffff; 
                padding:20px; 
                border-radius:8px;  
                box-shadow:0px 4px 12px rgba(0,64,128,0.05);
                font-size:16px; 
                color:#333;
            ">
                ${summaryHTML}
                ${message}
            </div>

            <div style="margin-top:20px; text-align:center;">
                <p style="color:#555; font-size:14px;">
                    Hotline: <strong>${branding.hotline || ""}</strong>
                </p>
                <p style="font-size:14px;">
                    <a href="${branding.website_url || '#'}"
                       style="color:#1a4e8a; text-decoration:none;">
                       ${branding.website_url || ""}
                    </a>
                </p>
            </div>

            <div style="text-align:center; font-size:12px; color:#777; margin-top:30px;">
                <p>Thank you for choosing 
                   <strong>${branding.company_name || ""}</strong>.
                </p>
            </div>
        </div>
        `;
    } catch (error) {
        console.error("Error generating installation email HTML:", error.message);
        return null;
    }
}

const sendsmstemp_Service_Installation = async (actionId, serviceId) => {
    try {
        console.log(`Fetching SMS template for actionId: ${actionId}`);

        // 1️⃣ Get active SMS template
        const smsResult = await pool.query(
            "SELECT msg, admin, client FROM sms_template WHERE action = $1 AND status = 'Active'",
            [actionId]
        );

        if (!smsResult.rows.length) {
            console.log("No active SMS template found.");
            return null;
        }
        const template = smsResult.rows[0];

        // 2️⃣ Get service + client details
        const serviceResult = await pool.query(
            `SELECT s.id AS service_id,
                    s.service_name,
                    c.id AS client_id,
                    c.name AS client_name,
                    c.contact_person_name,
                    c.company_phone_1,
                    c.contact_person_email
             FROM software_services s
             JOIN client c ON s.client_id = c.id
             WHERE s.id = $1`,
            [serviceId]
        );

        if (!serviceResult.rows.length) {
            console.log("No service found for ID:", serviceId);
            return null;
        }
        const service = serviceResult.rows[0];

        // 3️⃣ Get deployment details (component URLs)
        const deploymentResult = await pool.query(
            `SELECT component, domain
             FROM service_deployment_details
             WHERE service_id = $1`,
            [serviceId]
        );
        const deployments = deploymentResult.rows;

        const websiteUrls = deployments
            .filter(d => d.component.includes('website-frontend'))
            .map(d => d.domain)
            .join(', ');
        const adminUrls = deployments
            .filter(d => d.component.includes('admin-frontend'))
            .map(d => d.domain)
            .join(', ');

        // 4️⃣ Default credentials (as provided)
        const defaultCredentials = "Username: tekoadmin, Password: 123456789. Please change after first login.";

        // 5️⃣ Get branding
        const brandingResult = await pool.query(
            "SELECT company_name, hotline, support_email FROM branding_settings LIMIT 1"
        );
        const branding = brandingResult.rows[0] || {
            company_name: '',
            hotline: '',
            support_email: ''
        };

        // 6️⃣ Get SMS API settings
        const smsSettings = await getSmsSettings();
        const sms_user_id = smsSettings?.sms_user_id ?? '';
        const sms_api_key = smsSettings?.sms_api_key ?? '';
        const sms_sender_id = smsSettings?.sms_sender_id ?? '';
        const sms_api_endpoint = smsSettings?.sms_api_endpoint ?? '';

        // 7️⃣ Prepare placeholders
        const rawClientPhone = service.company_phone_1 || '';
        const clientPhone = normalizePhoneTo94(rawClientPhone);

        const placeholders = {
            "[name]": service.contact_person_name || service.client_name || '',
            "[phone]": clientPhone, // normalized
            "[email]": service.contact_person_email || '',
            "[Servise_Name]": service.service_name,
            "[Servise_ID]": service.service_id,
            "[Website_URLs]": websiteUrls || 'N/A',
            "[Admin_URLs]": adminUrls || 'N/A',
            "[Default_Credentials]": defaultCredentials,
            "[Hotline]": branding.hotline || '',
            "[Webname]": branding.company_name || '',
            "[company_email]": branding.support_email || ''
        };

        let finalMessage = template.msg;
        for (const [key, value] of Object.entries(placeholders)) {
            finalMessage = finalMessage.replaceAll(key, value.toString());
        }

        // 8️⃣ Get Admin Phones from system_settings and normalize them
        let adminPhones = [];
        if (template.admin === 'Yes') {
            const adminResult = await pool.query(
                "SELECT setting_value FROM system_settings WHERE setting_key = 'adminMobiles' LIMIT 1"
            );
            if (adminResult.rows.length > 0) {
                const rawPhones = adminResult.rows[0].setting_value
                    .split(',')
                    .map(p => p.trim())
                    .filter(Boolean);
                // Normalize each admin phone
                adminPhones = rawPhones.map(p => normalizePhoneTo94(p)).filter(Boolean);
            }
        }

        // Flags to track overall success
        let adminSent = false;
        let clientSent = false;

        // 9️⃣ Send SMS to Admins
        if (
            template.admin === 'Yes' &&
            adminPhones.length > 0 &&
            sms_user_id &&
            sms_api_key &&
            sms_sender_id &&
            sms_api_endpoint
        ) {
            for (const phone of adminPhones) {
                try {
                    const smsResponse = await send_sms(
                        sms_user_id,
                        sms_api_key,
                        sms_sender_id,
                        finalMessage,
                        phone,
                        sms_api_endpoint
                    );
                    console.log(`SMS sent to admin: ${phone}`, smsResponse);
                    await insertsmslog(phone, finalMessage, actionId);
                    adminSent = true; // at least one admin SMS succeeded
                } catch (err) {
                    console.error(`Failed to send SMS to admin: ${phone}`, err);
                }
            }
        }

        // 🔟 Send SMS to Client
        if (
            template.client === 'Yes' &&
            clientPhone && // normalized phone exists
            sms_user_id &&
            sms_api_key &&
            sms_sender_id &&
            sms_api_endpoint
        ) {
            try {
                const smsResponse = await send_sms(
                    sms_user_id,
                    sms_api_key,
                    sms_sender_id,
                    finalMessage,
                    clientPhone,
                    sms_api_endpoint
                );
                console.log(`SMS sent to client: ${clientPhone}`, smsResponse);
                await insertsmslog(clientPhone, finalMessage, actionId);
                clientSent = true;
            } catch (err) {
                console.error(`Failed to send SMS to client: ${clientPhone}`, err);
            }
        }

        // 📊 Summary log
        console.log(`📱 SMS sending summary - Admin sent: ${adminSent}, Client sent: ${clientSent}`);

        // Return result
        return {
            message: finalMessage,
            sendToAdmin: template.admin === 'Yes',
            sendToClient: template.client === 'Yes',
            service,
            branding
        };

    } catch (error) {
        console.error("Error in sendsmstemp_Service_Installation:", error);
        return null;
    }
};

async function getEmailMsgQuotation(username, message, quotationLink) {
    try {
        const brandingQuery = await pool.query(
            "SELECT company_name, hotline, logo_url, website_url, support_email FROM branding_settings LIMIT 1"
        );
        const branding = brandingQuery.rows.length > 0 ? brandingQuery.rows[0] : {};

        // Create button only if link exists
        const buttonHTML = quotationLink
            ? `<div style="margin:20px 0; text-align:center;">
                    <a href="${quotationLink}" 
                       style="
                           display:inline-block;
                           padding:12px 25px;
                           font-size:16px;
                           color:#ffffff;
                           background-color:#1a4e8a;
                           text-decoration:none;
                           border-radius:6px;
                       ">
                       View Quotation
                    </a>
               </div>`
            : '';

        let processedMessage = message;

        //  Replace placeholder only if exists
        if (processedMessage.includes("[Quo_Button]")) {
            processedMessage = processedMessage.replaceAll(
                "[Quo_Button]",
                buttonHTML
            );
        } else {
            // Remove if exists accidentally
            processedMessage = processedMessage.replaceAll("[Quo_Button]", "");
        }

        return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #dce6f1; border-radius: 8px; background-color: #f4f8fc;">
            
            <div style="text-align: center; padding: 20px 0;">
                <img src="${branding.logo_url || ''}" 
                     alt="Logo" 
                     style="max-width: 150px; margin-bottom: 10px;">
                <h2 style="color: #1a4e8a; margin: 0;">Quotation Notification</h2>
            </div>

            <div style="
                background:#ffffff; 
                padding:20px; 
                border-radius:8px;  
                box-shadow:0px 4px 12px rgba(0,64,128,0.05);
                font-size:16px; 
                color:#333;
            ">
                ${processedMessage}
            </div>

            <div style="text-align:center; font-size:12px; color:#777; margin-top:30px;">
                <p>Thank you for considering <strong>${branding.company_name || ""}</strong>.</p>
            </div>
        </div>
        `;
    } catch (error) {
        console.error("Error generating quotation email message:", error.message);
        return null;
    }
}


const formatPhone = (phone) => {
    if (!phone) return '';

    // remove spaces
    phone = phone.trim();

    // 0771234567 → 94771234567
    if (phone.startsWith('0')) {
        return '94' + phone.substring(1);
    }

    // +94771234567 → 94771234567
    if (phone.startsWith('+94')) {
        return phone.substring(1);
    }

    // already correct (9477...)
    if (phone.startsWith('94')) {
        return phone;
    }

    return phone; // fallback
};


const sendsmstemp_quotation = async (actionId, quotation_id, customer_mobile) => {
    try {
        console.log(`📩 Fetching SMS template for actionId: ${actionId}`);

        const smsResult = await pool.query(
            "SELECT msg, admin, client FROM sms_template WHERE action = $1 AND status = 'Active'",
            [actionId]
        );

        if (!smsResult.rows.length) {
            console.log("❌ No active SMS template found.");
            return null;
        }

        const template = smsResult.rows[0];

        const quotationResult = await pool.query(
            `SELECT q.*, 
                    c.name, 
                    c.contact_person_phone AS phone, 
                    c.contact_person_email AS email
             FROM quotation_header q
             LEFT JOIN client c ON q.client_id = c.id
             WHERE q.id = $1`,
            [quotation_id]
        );

        if (!quotationResult.rows.length) {
            console.log("❌ No quotation found:", quotation_id);
            return null;
        }

        const quotation = quotationResult.rows[0];
        const quotationLink = quotation.qutation_url || '';

        const brandingResult = await pool.query(
            "SELECT company_name, hotline, support_email, website_url FROM branding_settings LIMIT 1"
        );

        const branding = brandingResult.rows[0] || {};

        const smsSettings = await getSmsSettings();

        let finalMessage = template.msg;

        const placeholders = {
            "[name]": quotation.name || '',
            "[phone]": quotation.phone || '',
            "[email]": quotation.email || '',
            "[Hotline]": branding.hotline || '',
            "[Webname]": branding.company_name || '',
            "[company_email]": branding.support_email || '',
            "[Quo_ID]": quotation.id || '',
            "[Quo_Link]": quotationLink
        };

        for (const [key, value] of Object.entries(placeholders)) {
            finalMessage = finalMessage.replaceAll(key, value.toString());
        }

        //  Send to client (your main requirement)
        if (
            template.client === 'Yes' &&
            customer_mobile &&
            smsSettings?.sms_user_id
        ) {
            try {
             const formattedMobile = formatPhone(customer_mobile);

const response = await send_sms(
    smsSettings.sms_user_id,
    smsSettings.sms_api_key,
    smsSettings.sms_sender_id,
    finalMessage,
    formattedMobile,
    smsSettings.sms_api_endpoint
);

console.log("📡 SMS API RESPONSE:", response);
console.log(` SMS sent to client: ${formattedMobile}`);

await insertsmslog(formattedMobile, finalMessage, actionId);

            } catch (err) {
                console.error("❌ SMS send error:", err);
            }
        }

        return { message: finalMessage };

    } catch (error) {
        console.error("❌ SMS function error:", error);
        return null;
    }
};

const sendemailtemp_quotation = async (actionId, quotation_id, customer_email) => {
    try {
        console.log(`📧 Fetching EMAIL template for actionId: ${actionId}`);

        const templateResult = await pool.query(
            "SELECT msg, admin, client, subject FROM email_template WHERE action = $1 AND status = 'Active'",
            [actionId]
        );
        if (!templateResult.rows.length) return null;
        const template = templateResult.rows[0];

        const quotationResult = await pool.query(
            `SELECT q.*, 
                    c.name, 
                    c.contact_person_phone AS phone, 
                    c.contact_person_email AS email
             FROM quotation_header q
             LEFT JOIN client c ON q.client_id = c.id
             WHERE q.id = $1`,
            [quotation_id]
        );
        if (!quotationResult.rows.length) return null;
        const quotation = quotationResult.rows[0];

        const quotationLink = quotation.qutation_url || '';

        const brandingResult = await pool.query(
            "SELECT company_name, hotline, support_email, website_url FROM branding_settings LIMIT 1"
        );
        const brandingRow = brandingResult.rows[0] || {};
        const branding = {
            company_name: brandingRow.company_name ?? '',
            hotline: brandingRow.hotline ?? '',
            support_email: brandingRow.support_email ?? '',
            website_url: brandingRow.website_url ?? ''
        };

        // Email settings
        const settings = await getSmsSettings();
        const billing_email = settings?.billing_email_address ?? '';
        const postmark_token = settings?.postmark_server_token ?? '';

        console.log("⚙️ EMAIL SETTINGS:");
        console.log("Billing Email:", billing_email);
        console.log("Postmark Token:", postmark_token ? " Exists" : "❌ Missing");

        const placeholders = {
            "[name]": quotation.name || '',
            "[phone]": quotation.phone || '',
            "[email]": quotation.email || '',
            "[Hotline]": branding.hotline,
            "[Webname]": branding.company_name,
            "[company_email]": branding.support_email,
            "[Quo_ID]": quotation.id || '',
            "[Quo_Link]": quotationLink
        };

        let finalMessage = template.msg;
        for (const [key, value] of Object.entries(placeholders)) {
            finalMessage = finalMessage.replaceAll(key, value.toString());
        }

        const emailHTML = await getEmailMsgQuotation(
            quotation.name,
            finalMessage,
            quotationLink
        );

        // Admin Emails
        let adminEmails = [];
        if (template.admin === 'Yes') {
            const adminResult = await pool.query(
                "SELECT setting_value FROM system_settings WHERE setting_key = 'adminEmails' LIMIT 1"
            );
            if (adminResult.rows.length > 0) {
                adminEmails = adminResult.rows[0].setting_value
                    .split(',')
                    .map(e => e.trim())
                    .filter(Boolean);
            }
        }

        console.log("👨‍💼 ADMIN EMAILS:", adminEmails);
        console.log("📧 CLIENT EMAIL:", customer_email);

        const finalEmail = customer_email || quotation.email;

        // Send Email to Admins
        if (template.admin === 'Yes' && adminEmails.length > 0 && billing_email && postmark_token) {
            for (const email of adminEmails) {
                try {
                    const response = await sendEmailWithPostmark(
                        email,
                        template.subject,
                        emailHTML,
                        postmark_token,
                        billing_email
                    );
                    console.log(` Email sent to admin: ${email}`, response);
                    const logMessage = finalMessage.replaceAll("[Quo_Button]", "");
                    await insertemaillog(email, logMessage, template.subject, actionId);
                } catch (err) {
                    console.error(`❌ Failed to send email to admin: ${email}`, err);
                }
            }
        }

        // Send Email to Client
        if (template.client === 'Yes' && finalEmail && billing_email && postmark_token) {
            try {
                const response = await sendEmailWithPostmark(
                    finalEmail,
                    template.subject,
                    emailHTML,
                    postmark_token,
                    billing_email
                );
                console.log(` Email sent to client: ${finalEmail}`, response);
                const logMessage = finalMessage.replaceAll("[Quo_Button]", "");
                await insertemaillog(finalEmail, logMessage, template.subject, actionId);
            } catch (err) {
                console.error(`❌ Failed to send email to client: ${finalEmail}`, err);
            }
        }

        return {
            message: finalMessage,
            sendToAdmin: template.admin === 'Yes',
            sendToClient: template.client === 'Yes',
            quotationDetails: quotation,
            branding
        };

    } catch (error) {
        console.error("❌ Error in sendemailtemp_quotation:", error);
        return null;
    }
};

const customhookQuotation = async (actionId, quotation_id, customer_mobile, customer_email) => {
    try {
        console.log("🚀 Hook Triggered:", { actionId, quotation_id });

        let ressms = null;
        let resemail = null;

        if (actionId === 4) {
            ressms = await sendsmstemp_quotation(actionId, quotation_id, customer_mobile);
            resemail = await sendemailtemp_quotation(actionId, quotation_id, customer_email);
        }

        return {
            sms: ressms,
            email: resemail
        };

    } catch (error) {
        console.error("❌ Hook error:", error);
        throw error;
    }
};

async function sendTerminationEmailPostmark({
  serviceName,
  serviceId,
  terminatedBy,
  terminationReason,
  clientName,
  clientId,
  domainName,
  terminationDate
}) {
  try {
    // 1️⃣ Get email settings
    const settings = await getEmailSettings();

    if (!settings || !settings.postmark_server_token || !settings.billing_email_address) {
      console.error("Postmark settings missing.");
      return;
    }

    // 2️⃣ Get admin emails from system settings
    const adminEmailsResult = await pool.query(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'adminEmails' LIMIT 1"
    );

    let toEmails = [];
    if (adminEmailsResult.rows.length > 0) {
      toEmails = adminEmailsResult.rows[0].setting_value
        .split(',')
        .map(e => e.trim())
        .filter(Boolean);
    }

    // 3️⃣ Fallback to billing email if no admin emails configured
    if (toEmails.length === 0) {
      toEmails = [settings.billing_email_address];
    }

    // 4️⃣ Format termination date
    const formattedDate = terminationDate ? new Date(terminationDate).toLocaleString() : new Date().toLocaleString();
    
    // 5️⃣ Format reason (handle null/undefined)
    const reason = terminationReason || 'Not specified';
    
    // 6️⃣ Build email message content
    let messageContent = `
      <div style="margin-bottom: 20px; padding: 15px; background-color: #fff3f3; border-left: 4px solid #dc3545; border-radius: 4px;">
        <p style="margin: 0 0 10px 0; font-size: 16px; color: #721c24;">
          <strong>⚠️ Service Termination Alert</strong>
        </p>
      </div>
      
      <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
        <tr style="background-color: #f8f9fa;">
          <td style="padding: 10px; border: 1px solid #dee2e6; font-weight: bold; width: 40%;">Service Name:</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${serviceName || 'N/A'}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #dee2e6; font-weight: bold;">Service ID:</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${serviceId || 'N/A'}</td>
        </tr>
        <tr style="background-color: #f8f9fa;">
          <td style="padding: 10px; border: 1px solid #dee2e6; font-weight: bold;">Domain Name:</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${domainName || 'N/A'}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #dee2e6; font-weight: bold;">Client Name:</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${clientName || 'N/A'}</td>
        </tr>
        <tr style="background-color: #f8f9fa;">
          <td style="padding: 10px; border: 1px solid #dee2e6; font-weight: bold;">Client ID:</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${clientId || 'N/A'}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #dee2e6; font-weight: bold;">Terminated By:</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${terminatedBy || 'N/A'}</td>
        </tr>
        <tr style="background-color: #f8f9fa;">
          <td style="padding: 10px; border: 1px solid #dee2e6; font-weight: bold;">Termination Date:</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${formattedDate}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #dee2e6; font-weight: bold;">Termination Reason:</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${reason}</td>
        </tr>
      </table>
    `;

    // 7️⃣ Fetch branding
    const brandingQuery = await pool.query(
      "SELECT company_name, hotline, logo_url, website_url, support_email FROM branding_settings LIMIT 1"
    );
    const branding = brandingQuery.rows.length > 0 ? brandingQuery.rows[0] : {};

    // 8️⃣ Build branded HTML
    const emailHTML = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #dce6f1; border-radius: 8px; background-color: #f4f8fc;">
          
          <div style="text-align: center; padding: 20px 0;">
              <img src="${branding.logo_url || ''}" 
                   alt="Logo" 
                   style="max-width: 150px; margin-bottom: 10px;">
              <h2 style="color: #dc3545; margin: 0;">Service Terminated</h2>
              <p style="color: #6c757d; margin: 5px 0 0 0;">Service has been successfully terminated</p>
          </div>

          <div style="
              background:#ffffff; 
              padding:20px; 
              border-radius:8px;  
              box-shadow:0px 4px 12px rgba(0,64,128,0.05);
              font-size:16px; 
              color:#333;
          ">
              ${messageContent}
          </div>

          ${branding.support_email ? `
          <div style="margin-top: 20px; padding: 15px; background-color: #e7f3ff; border-radius: 8px; text-align: center;">
            <p style="margin: 0; color: #004085;">
              <strong>Need assistance?</strong> Contact our support team at 
              <a href="mailto:${branding.support_email}" style="color: #0056b3;">${branding.support_email}</a>
            </p>
          </div>
          ` : ''}

          <div style="margin-top:20px; text-align:center;">
              <p style="color:#555; font-size:14px;">
                  Hotline: <strong>${branding.hotline || "N/A"}</strong>
              </p>
              <p style="font-size:14px;">
                  <a href="${branding.website_url || '#'}"
                     style="color:#1a4e8a; text-decoration:none;">
                     ${branding.website_url || ""}
                  </a>
              </p>
          </div>

          <div style="text-align:center; font-size:12px; color:#777; margin-top:30px;">
              <p>This is an automated notification from 
                 <strong>${branding.company_name || "System"}</strong>.
              </p>
              <p>Please do not reply to this email.</p>
          </div>
      </div>
    `;

    // 9️⃣ Send email to all admin recipients
    for (const to of toEmails) {
      try {
        await sendEmailWithPostmark(
          to,
          `⚠️ Service Terminated: ${serviceName} (ID: ${serviceId})`,
          emailHTML,
          settings.postmark_server_token,
          settings.billing_email_address
        );
        console.log(` Termination notification email sent to ${to}`);
      } catch (err) {
        console.error(`❌ Failed to send termination email to ${to}`, err);
      }
    }

  } catch (error) {
    console.error("❌ Error in sendTerminationEmailPostmark:", error);
  }
}

// (async () => {
//   try {
//     const result = await sendsmstemp_Service_Installation(
//       3,              // actionId (example)
//       136           // invoice ID (existing invoice id)
//     );

//     console.log("Function Result:", result);
//   } catch (err) {
//     console.error("Test Error:", err);
//   }
// })();

// (async () => {
//     try {
//         const result = await sendemailtemp_Send_Invoice(
//             2,              // actionId (example)
//             67,           // invoice ID (existing invoice id)
//             "raveendrapushpakumaraspark@gmail.com"    // customer mobile
//         );

//         console.log("Function Result:", result);
//     } catch (err) {
//         console.error("Test Error:", err);
//     }
// })();


// (async () => {
//     try {
//         const result = await customhookQuotation(
//             4,
//             18,
//             "94773671596",
//             "raveendrapushpakumaraspark@gmail.com"
//         );

//         console.log("🎯 Result:", result);

//     } catch (err) {
//         console.error("❌ Test Error:", err);
//     }
// })();

// const decryptInvoiceId = (text) => {
//     const textParts = text.split(':');
//     const iv = Buffer.from(textParts.shift(), 'hex');
//     const encryptedText = Buffer.from(textParts.join(':'), 'hex');

//     const decipher = crypto.createDecipheriv(
//         'aes-256-cbc',
//         Buffer.from(ENCRYPTION_KEY),
//         iv
//     );

//     let decrypted = decipher.update(encryptedText);
//     decrypted = Buffer.concat([decrypted, decipher.final()]);

//     return decrypted.toString();
// };

module.exports = { send_sms, customhookInvoice,sendProvisioningEmailPostmark,sendServiceInstallationEmail,sendsmstemp_Service_Installation,customhookQuotation,sendTerminationEmailPostmark };
