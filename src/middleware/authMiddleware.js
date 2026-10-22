// src/middleware/authMiddleware.js
const jwt = require("jsonwebtoken");

const authenticateToken = (req, res, next) => {
  //  First try to get token from cookie
  let token = req.cookies?.access_token;
  
  //  Fallback to Authorization header (for backward compatibility)
  if (!token) {
    const authHeader = req.headers["authorization"];
    token = authHeader && authHeader.split(" ")[1];
  }

  console.log(`Auth check for ${req.method} ${req.url}:`, {
    hasTokenFromCookie: !!req.cookies?.access_token,
    hasTokenFromHeader: !!req.headers["authorization"],
    tokenPresent: !!token
  });

  if (!token) {
    return res.status(401).json({ message: "Access token required" });
  }

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, user) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ message: "Access token expired" });
      }
      return res.status(403).json({ message: "Invalid token" });
    }
    req.user = user;
    next();
  });
};

module.exports = authenticateToken;