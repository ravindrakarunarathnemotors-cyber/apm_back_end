// recurringInvoiceCron.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });  // Add this line

const express = require("express");
const pool = require("../config/db");
const cron = require("node-cron");

const router = express.Router();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Format date for PostgreSQL (YYYY-MM-DD)
 */
const formatDateForPostgres = (date) => {
    if (!date) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

/**
 * Calculate next billing date based on frequency
 */
const calculateNextBillingDate = (currentDate, frequency) => {
    const date = new Date(currentDate);
    
    switch (frequency?.toLowerCase()) {
        case 'daily':
            date.setDate(date.getDate() + 1);
            break;
        case 'weekly':
            date.setDate(date.getDate() + 7);
            break;
        case 'monthly':
            date.setMonth(date.getMonth() + 1);
            break;
        case 'quarterly':
            date.setMonth(date.getMonth() + 3);
            break;
        case 'half_yearly':
        case 'half-yearly':
            date.setMonth(date.getMonth() + 6);
            break;
        case 'yearly':
        case 'annual':
            date.setFullYear(date.getFullYear() + 1);
            break;
        default:
            date.setMonth(date.getMonth() + 1);
    }
    
    return formatDateForPostgres(date);
};

/**
 * Calculate due date (30 days from invoice date)
 */
const calculateDueDate = (invoiceDate) => {
    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + 30);
    return formatDateForPostgres(dueDate);
};

/**
 * Add system logs
 */
const addSystemLogs = async (comment, module) => {
    try {
        const query = `INSERT INTO system_log (comment, module, datetime) VALUES ($1, $2, NOW())`;
        const result = await pool.query(query, [comment, module]);
        if (result.rowCount === 0) {
            console.error("❌ Failed to insert log into system_log table.");
        } else {
            console.log("📝 Log inserted into system_log table.");
        }
    } catch (error) {
        console.error("❌ Error inserting system log:", error);
    }
};

// ============================================
// MAIN RECURRING INVOICE PROCESSING FUNCTION
// ============================================

async function processRecurringInvoices() {
    console.log("🔥 FUNCTION ENTERED");

    let client = null;

    try {
        console.log("🔌 Connecting to DB...");
        console.log(`📡 DB Host: ${process.env.DB_HOST}:${process.env.DB_PORT}`); // Debug line
        
        client = await pool.connect();
        console.log(" DB Connected");

        await client.query('BEGIN');

        console.log(`\n[${new Date().toISOString()}] ========================================`);
        console.log(`[${new Date().toISOString()}] STARTING RECURRING INVOICE CHECK`);
        console.log(`[${new Date().toISOString()}] ========================================`);

        // Get today's date in Asia/Colombo timezone
        const today = dayjs().tz("Asia/Colombo").format('YYYY-MM-DD');
        console.log(`[${new Date().toISOString()}] Today's date (Asia/Colombo): ${today}`);

        // First, let's check what invoices exist in the database
        const checkQuery = await client.query(
            `SELECT id, client_id, next_billing_date, status, cycles_generated, total_cycles 
             FROM recurrung_invoice_header 
             WHERE next_billing_date = $1::date`,
            [today]
        );
        
        console.log(`[${new Date().toISOString()}] Database check: Found ${checkQuery.rows.length} total invoices with next_billing_date = ${today}`);
        if (checkQuery.rows.length > 0) {
            console.log(`[${new Date().toISOString()}] Invoices in DB:`, JSON.stringify(checkQuery.rows, null, 2));
        }

        // Get all recurring invoices where next_billing_date = today
        const recurringQuery = await client.query(
            `SELECT 
                rih.id,
                rih.client_id,
                rih.servise_id,
                rih.invoice_date,
                rih.next_billing_date,
                rih.last_generated_date,
                rih.item_total_amount,
                rih.item_total_discount,
                rih.status,
                rih.balance,
                rih.discount_type,
                rih.global_discount_value,
                rih.invoice_type,
                rih.created_by,
                rih.is_recurring,
                rih.billing_frequency,
                rih.recurring_start_date,
                rih.total_cycles,
                rih.cycles_generated,
                rih.parent_invoice_id,
                rih.currency,
                rid.id as detail_id,
                rid.software_service_id,
                rid.package_id,
                rid.item_type,
                rid.item_name,
                rid.description,
                rid.quantity,
                rid.unit_price,
                rid.setup_fee,
                rid.monthly_fee,
                rid.amount,
                rid.discount,
                rid.discount_type as detail_discount_type,
                rid.discount_value
            FROM recurrung_invoice_header rih
            LEFT JOIN recurrung_invoice_details rid ON rih.id = rid.invoice_id
            WHERE rih.next_billing_date = $1::date
                AND rih.status IN ('active', 'unpaid')
                AND (rih.total_cycles = -1 OR rih.cycles_generated < rih.total_cycles)
            ORDER BY rih.id`,
            [today]
        );

        // Group the results by invoice header
        const recurringMap = new Map();
        
        for (const row of recurringQuery.rows) {
            if (!recurringMap.has(row.id)) {
                recurringMap.set(row.id, {
                    header: {
                        id: row.id,
                        client_id: row.client_id,
                        servise_id: row.servise_id,
                        invoice_date: row.invoice_date,
                        next_billing_date: row.next_billing_date,
                        last_generated_date: row.last_generated_date,
                        item_total_amount: row.item_total_amount,
                        item_total_discount: row.item_total_discount,
                        status: row.status,
                        balance: row.balance,
                        discount_type: row.discount_type,
                        global_discount_value: row.global_discount_value,
                        invoice_type: row.invoice_type,
                        created_by: row.created_by,
                        is_recurring: row.is_recurring,
                        billing_frequency: row.billing_frequency,
                        recurring_start_date: row.recurring_start_date,
                        total_cycles: row.total_cycles,
                        cycles_generated: row.cycles_generated,
                        parent_invoice_id: row.parent_invoice_id,
                        currency: row.currency || 'LKR'
                    },
                    details: []
                });
            }
            
            if (row.detail_id) {
                recurringMap.get(row.id).details.push({
                    software_service_id: row.software_service_id,
                    package_id: row.package_id,
                    item_type: row.item_type,
                    item_name: row.item_name,
                    description: row.description,
                    quantity: row.quantity,
                    unit_price: row.unit_price,
                    setup_fee: row.setup_fee,
                    monthly_fee: row.monthly_fee,
                    amount: row.amount,
                    discount: row.discount,
                    discount_type: row.detail_discount_type,
                    discount_value: row.discount_value
                });
            }
        }

        const recurringInvoices = Array.from(recurringMap.values());
        
        console.log(`[${new Date().toISOString()}] Found ${recurringInvoices.length} eligible recurring invoices with next_billing_date = ${today}`);

        if (recurringInvoices.length === 0) {
            console.log(`[${new Date().toISOString()}] No eligible invoices to process today. Exiting.`);
            await client.query('COMMIT');
            
            await addSystemLogs(
                `Recurring invoice check: No eligible invoices to process on ${today}`, 
                "Recurring Invoice Cron"
            );
            
            return {
                success: true,
                processed: 0,
                generated: 0,
                message: "No eligible invoices to process today"
            };
        }

        // Log the IDs of invoices that will be processed
        console.log(`[${new Date().toISOString()}] Processing invoice IDs: ${recurringInvoices.map(inv => inv.header.id).join(', ')}`);

        let generatedCount = 0;
        let errorCount = 0;
        const generatedInvoices = [];

        // Process each recurring invoice
        for (const recurring of recurringInvoices) {
            try {
                const header = recurring.header;
                const details = recurring.details;

                console.log(`\n[${new Date().toISOString()}] ========================================`);
                console.log(`[${new Date().toISOString()}] Processing recurring invoice ID: ${header.id}`);
                console.log(`[${new Date().toISOString()}] Client ID: ${header.client_id}`);
                console.log(`[${new Date().toISOString()}] Amount: ${header.item_total_amount}`);
                console.log(`[${new Date().toISOString()}] Current Status: ${header.status}`);
                console.log(`[${new Date().toISOString()}] Next billing date: ${header.next_billing_date}`);
                console.log(`[${new Date().toISOString()}] Current cycles: ${header.cycles_generated}/${header.total_cycles === -1 ? '∞' : header.total_cycles}`);

                if (details.length === 0) {
                    console.error(`[${new Date().toISOString()}] ERROR: No details found for recurring invoice ID: ${header.id}`);
                    errorCount++;
                    continue;
                }

                console.log(`[${new Date().toISOString()}] Found ${details.length} detail items`);

                // Calculate next billing date based on frequency
                const nextBillingDate = calculateNextBillingDate(
                    header.next_billing_date,
                    header.billing_frequency
                );

                const now = new Date();
                const formattedNow = formatDateForPostgres(now);

                console.log(`[${new Date().toISOString()}] Creating invoice with date: ${formattedNow}`);
                console.log(`[${new Date().toISOString()}] Next billing date will be: ${nextBillingDate}`);

                // Insert into invoice_header
                const invoiceHeaderResult = await client.query(
                    `INSERT INTO invoice_header (
                        client_id, servise_id, invoice_date, due_date,
                        item_total_amount, item_total_discount, status, balance,
                        discount_type, global_discount_value, invoice_type,
                        created_by, is_recurring, billing_frequency,
                        recurring_start_date, total_cycles, cycles_generated,
                        parent_invoice_id, currency
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
                    RETURNING id`,
                    [
                        header.client_id,
                        header.servise_id,
                        formattedNow,
                        calculateDueDate(formattedNow),
                        header.item_total_amount,
                        header.item_total_discount,
                        'unpaid',
                        header.balance,
                        header.discount_type,
                        header.global_discount_value,
                        'recurring',
                        1,
                        true,
                        header.billing_frequency,
                        header.recurring_start_date,
                        header.total_cycles,
                        header.cycles_generated + 1,
                        header.id,
                        header.currency || 'LKR'
                    ]
                );

                const newInvoiceId = invoiceHeaderResult.rows[0].id;
                console.log(`[${new Date().toISOString()}]  Created invoice header with ID: ${newInvoiceId}`);

                // Insert invoice details
                for (let i = 0; i < details.length; i++) {
                    const detail = details[i];
                    await client.query(
                        `INSERT INTO invoice_details (
                            invoice_id, software_service_id, package_id,
                            item_type, item_name, description,
                            quantity, unit_price, setup_fee, monthly_fee,
                            amount, discount, discount_type, discount_value
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                        [
                            newInvoiceId,
                            detail.software_service_id,
                            detail.package_id,
                            detail.item_type || 'existing',
                            detail.item_name || 'Monthly Fee',
                            detail.description,
                            detail.quantity || 1,
                            detail.unit_price || 0,
                            detail.setup_fee || 0,
                            detail.monthly_fee || 0,
                            detail.amount,
                            detail.discount || 0,
                            detail.discount_type,
                            detail.discount_value || 0
                        ]
                    );
                    console.log(`[${new Date().toISOString()}] Added detail item ${i + 1}: ${detail.item_name || 'Monthly Fee'}`);
                }

                // Determine new status
                let newStatus = 'active';
                if (header.total_cycles !== -1 && 
                    header.cycles_generated + 1 >= header.total_cycles) {
                    newStatus = 'completed';
                }

                // Update recurring invoice header
                await client.query(
                    `UPDATE recurrung_invoice_header
                    SET cycles_generated = cycles_generated + 1,
                        last_generated_date = $1,
                        next_billing_date = $2,
                        status = $3
                    WHERE id = $4`,
                    [formattedNow, nextBillingDate, newStatus, header.id]
                );

                generatedCount++;
                generatedInvoices.push({
                    recurringId: header.id,
                    invoiceId: newInvoiceId,
                    clientId: header.client_id,
                    amount: header.item_total_amount,
                    status: newStatus
                });

                console.log(`[${new Date().toISOString()}]  Successfully generated invoice #${newInvoiceId} for recurring ID: ${header.id}`);
                console.log(`[${new Date().toISOString()}] Updated recurring invoice - cycles: ${header.cycles_generated + 1}, next billing: ${nextBillingDate}, status: ${newStatus}`);
                console.log(`[${new Date().toISOString()}] ========================================`);

            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error processing recurring invoice ID ${recurring.header.id}:`, error.message);
                console.error(error.stack);
                errorCount++;
            }
        }

        await client.query('COMMIT');

        // Generate summary
        const summaryText = `
========================================
RECURRING INVOICE SUMMARY - ${dayjs().tz("Asia/Colombo").format('YYYY-MM-DD HH:mm:ss')}
========================================
Date: ${today}
Total Due Today: ${recurringInvoices.length}
Successfully Generated: ${generatedCount}
Errors: ${errorCount}

Generated Invoices:
${generatedInvoices.map(inv => 
  `- Invoice #${inv.invoiceId} | Client ID: ${inv.clientId} | Amount: Rs. ${inv.amount} | Status: ${inv.status}`
).join('\n')}

${errorCount > 0 ? `\nErrors: ${errorCount}` : ''}
========================================`;

        console.log(summaryText);

        // Log to system_log
        await addSystemLogs(
            `Recurring invoice cron: ${today} - Processed ${recurringInvoices.length}, Generated ${generatedCount}, Errors ${errorCount}`,
            "Recurring Invoice Cron"
        );

        return {
            success: true,
            date: today,
            processed: recurringInvoices.length,
            generated: generatedCount,
            errors: errorCount,
            invoices: generatedInvoices
        };

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error(`[${new Date().toISOString()}] ❌ CRITICAL ERROR:`, error);
        
        // Try to log, but don't fail if it doesn't work
        try {
            await addSystemLogs(
                `Recurring invoice cron failed: ${error.message}`,
                "Recurring Invoice Cron Error"
            );
        } catch (logError) {
            console.error('Failed to log error to database:', logError.message);
        }
        
        return {
            success: false,
            error: error.message
        };
    } finally {
        if (client) {
            client.release();
        }
    }
}

// ============================================
// CRON SCHEDULE - Run at 12:10 AM every day
// ============================================

// Production schedule - run at 12:10 AM daily
// cron.schedule("10 0 * * *", async () => {
//     const now = dayjs().tz("Asia/Colombo");
//     console.log(`\n[${new Date().toISOString()}] ⏰ 12:10 AM Asia/Colombo time reached. Generating recurring invoices for today.`);
//     await processRecurringInvoices();
// });

// For testing - run every minute (remove in production)
cron.schedule("10 0 * * *", async () => {
    try {
        const now = dayjs().tz("Asia/Colombo");
        console.log(`\n[${new Date().toISOString()}] ⏰ Running recurring invoice check at ${now.format("HH:mm")} Asia/Colombo`);
        
        const result = await processRecurringInvoices();
        
        console.log(`[${new Date().toISOString()}]  Cron finished:`, result);
        
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ❌ CRON ERROR:`, err);
    }
});

module.exports = router;