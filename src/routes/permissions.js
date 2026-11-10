// Action permissions: which buttons / actions a role may use.
// Mount once (same place as the other route files):   app.use("/api", require("./routes/permissions.routes"));
// Lock a route:
//   const { requirePermission } = require("./permissions.routes");
//   router.post("/departments/:id/teams", authenticateToken, requirePermission("team.manage"), handler);
const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");

const router = express.Router();
const ADMIN_ROLE_ID = 1;

// { roleId, isAdmin, keys[] } of the logged-in user. Read from the database by the id in the token.
async function loadPermissions(req) {
  const uid = Number(req.user?.user_id ?? req.user?.id);
  if (!Number.isInteger(uid)) return null;
  const u = await pool.query("SELECT role_id, status FROM admin_user WHERE id = $1", [uid]);
  if (u.rowCount === 0 || String(u.rows[0].status).toLowerCase() !== "active") return null;
  const roleId = Number(u.rows[0].role_id);
  if (roleId === ADMIN_ROLE_ID) return { roleId, isAdmin: true, keys: [] };   // the administrator may do everything
  const r = await pool.query(
    `SELECT m.perm_key
       FROM admin_role r
       JOIN admin_uimenudata m ON m.perm_key IS NOT NULL AND m.id::text = ANY(r.privileges)
      WHERE r.id = $1 AND lower(r.status) = 'active'`, [roleId]);
  return { roleId, isAdmin: false, keys: r.rows.map((x) => x.perm_key) };
}

// middleware: 403 when the role does not have the permission
const requirePermission = (...keys) => async (req, res, next) => {
  try {
    const p = await loadPermissions(req);
    if (!p) return res.status(401).json({ message: "Your session is not valid. Please log in again." });
    if (p.isAdmin || keys.some((k) => p.keys.includes(k))) return next();
    return res.status(403).json({ message: "You do not have permission to do this" });
  } catch (e) {
    console.error("requirePermission:", e.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/my-permissions  ->  { admin: boolean, keys: ["team.manage", ...] }
router.get("/my-permissions", authenticateToken, async (req, res) => {
  try {
    const p = await loadPermissions(req);
    if (!p) return res.status(401).json({ message: "Your session is not valid. Please log in again." });
    return res.json({ admin: p.isAdmin, keys: p.keys });
  } catch (e) {
    console.error("my-permissions:", e.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
module.exports.requirePermission = requirePermission;
module.exports.loadPermissions = loadPermissions;