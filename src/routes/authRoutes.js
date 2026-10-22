const express = require("express");
const { login } = require("../controllers/AuthController");
const { refreshAccessToken } = require("../services/AuthService");
const router = express.Router();
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { getBrandingSetting } = require("../models/userModels");

// Login endpoint
router.post("/login", login);

// Refresh token endpoint - READ FROM COOKIE
router.post("/refresh-token", async (req, res) => {
  const refreshToken = req.cookies.refresh_token;

  // No refresh token
  if (!refreshToken) {
    return res.status(401).json({
      message: "Refresh token required",
    });
  }

  jwt.verify(
    refreshToken,
    process.env.REFRESH_TOKEN_SECRET,
    (err, user) => {
      // Invalid or expired refresh token
      if (err) {
        return res.status(403).json({
          message: "Invalid refresh token",
        });
      }

      // Generate new access token with correct fields (matching login)
      const newAccessToken = jwt.sign(
        {
          user_id: user.user_id,
          role_id: user.role_id,
          branch_id	: user.	branch_id,
          client_id: user.client_id,
        },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: "1m" } // Keep as 1 minute or change to match login
      );

      // Set new access token cookie (matching login cookie settings)
      res.cookie("access_token", newAccessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 15 * 60 * 1000, // 1 minute (or change to 15 * 60 * 1000 to match)
        path: '/'
      });

      return res.status(200).json({
        message: "Access token refreshed",
      });
    }
  );
});
// Privileges endpoint - READ FROM COOKIE
router.post("/privileges", async (req, res) => {
  // Get access token from cookie
  const token = req.cookies.access_token;
  
  if (!token) {
    return res.status(401).json({ message: "Access token required" });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const roleId = decoded.role_id;
    const { path } = req.body;

    console.log("Checking privileges for role:", roleId, "path:", path);

    // Fetch role privileges
    const roleResult = await pool.query(
      "SELECT privileges FROM admin_role WHERE id = $1",
      [roleId]
    );

    if (roleResult.rows.length === 0) {
      return res.status(404).json({ message: "Forbidden: Role not found" });
    }

    const allowedPrivilegeIds = roleResult.rows[0].privileges || [];

    // Get allowed routes from uimenudata
    const menuResult = await pool.query(
      "SELECT route FROM admin_uimenudata WHERE id = ANY($1)",
      [allowedPrivilegeIds]
    );

    const allowedRoutes = menuResult.rows.map(row => row.route);

    if (!allowedRoutes.includes(path)) {
      return res.status(403).json({ message: "Forbidden: Access denied" });
    }

    console.log("Access granted for path:", path);
    res.status(200).json({ privileges: allowedRoutes });
    
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: "Access token expired" });
    }
    console.error("Error checking route access:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Logout endpoint - CLEAR COOKIES
router.post("/logout", async (req, res) => {
  // Clear cookies
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/' });
  
  res.json({ success: true, message: "Logged out successfully" });
});

// Invoice images endpoint
router.get("/invoice-images", async (req, res) => {
  const logo = await getBrandingSetting("logo_url_white");
  const logo2 = await getBrandingSetting("logo_url");
  const signature = await getBrandingSetting("signature_url");

  res.json({ logo, logo2, signature });
});

module.exports = router;