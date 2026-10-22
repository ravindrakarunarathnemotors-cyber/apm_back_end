const express = require("express");
const pool = require("../config/db");

const router = express.Router();

router.get("/settings", async (req, res) => {
    try {
        // Query to get branding settings
        const timelineQuery = `
            SELECT background_color,company_name,favicon_url,logo_url,logo_url_white,primary_color,secondary_color,loading_img_url,hotline, logo_icon, bank_account_name, bank_name, bank_account_number, bank_branch_name FROM branding_settings
            WHERE id = $1
        `;

        // Execute query
        const result = await pool.query(timelineQuery, [1]);

        if (result.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Branding settings not found",
            });
        }

        // Send response
        res.status(200).json({
            success: true,
            data: result.rows[0] || {},
        });
    } catch (error) {
        console.error("Error fetching branding settings:", error);
        res.status(500).json({
            success: false,
            message: "Internal Server Error",
        });
    }
});

module.exports = router;
