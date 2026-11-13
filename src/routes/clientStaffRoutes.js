const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");
const { formatPhoneNumber, getBrandingSetting, insertAdminlogs } = require("../models/userModels")
const bcrypt = require("bcrypt");
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { customhookInvoice, sendProvisioningEmailPostmark, customhookQuotation } = require("../models/smstempmodels");
const { Client } = require('ssh2');
const CryptoJS = require('crypto-js');
const axios = require('axios');
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { sendPushToUser } = require("./push");   // <- me line eka
const S3Service = require('./s3Service');

dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();


const ADMIN_ROLE_ID = 1;
const PASSWORD_MIN = 8;
const NAME_RE = /^[\p{L}\s.'-]{1,60}$/u;          // letters of any language, spaces, . ' -   (K.M. Perera, De-Silva, D'Souza)
const USERNAME_RE = /^[A-Za-z0-9._-]{3,30}$/;
const NIC_RE = /^(\d{9}[VX]|\d{12})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
 
const uToInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const uClean = (v) => String(v ?? "").trim();
const safeUser = (row) => { if (!row) return row; const { password, ...rest } = row; return rest; };   // never send the hash
const audit = async (module, log, userId) => { try { await insertAdminlogs(module, log, userId); } catch (e) { console.error("admin log:", e.message); } };
 
// the logged-in user, read from the database by the id in the token (role / branch / status cannot be faked by the browser)
async function loadActor(req) {
  const id = uToInt(req.user?.user_id ?? req.user?.id);
  if (!Number.isInteger(id)) return null;
  const r = await pool.query("SELECT id, role_id, branch_id, status FROM admin_user WHERE id = $1", [id]);
  const u = r.rows[0];
  if (!u || String(u.status).toLowerCase() !== "active") return null;
  return { id: u.id, roleId: Number(u.role_id), branchId: u.branch_id, isAdmin: Number(u.role_id) === ADMIN_ROLE_ID };
}
// wraps a handler: finds the actor, optional admin-only check, one place for errors
const act = (handler, { adminOnly = false } = {}) => async (req, res) => {
  try {
    const actor = await loadActor(req);
    if (!actor) return res.status(401).json({ message: "Your session is not valid. Please log in again." });
    if (adminOnly && !actor.isAdmin) return res.status(403).json({ message: "Only an administrator can do this" });
    return await handler(req, res, actor);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ message: "That value already exists" });
    console.error(`${req.method} ${req.path}:`, e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  }
};
 
const roleIsUsable = async (roleId) => (await pool.query("SELECT 1 FROM admin_role WHERE id = $1 AND lower(status) = 'active'", [roleId])).rowCount > 0;
const activeAdminsExcept = async (userId) =>
  Number((await pool.query("SELECT COUNT(*) FROM admin_user WHERE role_id = $1 AND lower(status) = 'active' AND id <> $2", [ADMIN_ROLE_ID, userId])).rows[0].count);
 
// ---------------------------------------------------------------- users
// An administrator sees every user, anybody else only the users of his / her own branch.
router.get("/client-staff", authenticateToken, act(async (req, res, actor) => {
  const params = [];
  let where = "";
  if (!actor.isAdmin) { params.push(actor.branchId); where = "WHERE admin_user.branch_id = $1"; }
  const result = await pool.query(
    `SELECT admin_user.*, admin_role.role_name
     FROM admin_user JOIN admin_role ON admin_user.role_id = admin_role.id ${where}
     ORDER BY admin_user.id DESC`, params);
  res.json(result.rows.map(safeUser));
}));
 
router.post("/adduser", authenticateToken, act(async (req, res, actor) => {
  const b = req.body || {};
  const firstName = uClean(b.firstName), lastName = uClean(b.lastName), email = uClean(b.email), username = uClean(b.username);
  const password = String(b.password ?? ""), nicClean = uClean(b.nic).toUpperCase(), roleId = uToInt(b.role);
 
  if (!firstName || !lastName || !email || !b.phone || !password || !username || !nicClean || !Number.isInteger(roleId)) {
    return res.status(400).json({ message: "All fields are required" });
  }
  if (!NAME_RE.test(firstName) || !NAME_RE.test(lastName)) return res.status(400).json({ message: "Invalid name" });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ message: "The username can have 3 to 30 letters, numbers, . _ -" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ message: "Invalid email" });
  if (!NIC_RE.test(nicClean)) return res.status(400).json({ message: "Invalid NIC" });
  if (password.length < PASSWORD_MIN) return res.status(400).json({ message: `The password must be at least ${PASSWORD_MIN} characters` });
 
  if (!actor.isAdmin && roleId === ADMIN_ROLE_ID) return res.status(403).json({ message: "Only an administrator can create an administrator" });
  if (!(await roleIsUsable(roleId))) return res.status(400).json({ message: "Selected role not found or inactive" });
 
  // an administrator chooses the branch, everybody else always gets his / her own
  const branchId = actor.isAdmin ? uToInt(b.branch) : uToInt(actor.branchId);
  if (!Number.isInteger(branchId) || branchId <= 0) return res.status(400).json({ message: "Valid branch is required" });
  const branchCheck = await pool.query("SELECT branch_id FROM service_branches WHERE branch_id = $1 AND is_active = true", [branchId]);
  if (branchCheck.rowCount === 0) return res.status(400).json({ message: "Selected branch not found or inactive" });
 
  const mobileNew = formatPhoneNumber(String(b.phone).trim());
  if (mobileNew.error) return res.status(400).json({ message: mobileNew.error });
 
  if ((await pool.query("SELECT 1 FROM admin_user WHERE lower(username) = lower($1)", [username])).rowCount) return res.status(409).json({ message: "Username already exists" });
  if ((await pool.query("SELECT 1 FROM admin_user WHERE nic = $1", [nicClean])).rowCount) return res.status(409).json({ message: "NIC already exists" });
 
  const hashedPassword = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO admin_user (first_name, last_name, username, email, mobile, password, role_id, status, nic, branch_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Active', $8, $9)
     RETURNING id, first_name, last_name, username, email, mobile, role_id, status, nic, branch_id`,
    [firstName, lastName, username, email, mobileNew.formatted, hashedPassword, roleId, nicClean, branchId]);
  await audit("User Management", `Added user ${username} (role ${roleId}, branch ${branchId})`, actor.id);
  res.status(201).json({ message: "User added successfully", user: result.rows[0] });
}));
 
router.post("/edit-user", authenticateToken, act(async (req, res, actor) => {
  const b = req.body || {};
  const targetId = uToInt(b.selected_userId);
  if (!Number.isInteger(targetId)) return res.status(400).json({ message: "Invalid user" });
  const t = (await pool.query("SELECT id, username, role_id, branch_id, nic FROM admin_user WHERE id = $1", [targetId])).rows[0];
  if (!t) return res.status(404).json({ message: "User not found" });
 
  // who may touch this user: an administrator - anybody; the user himself; a branch user - the non-administrators of the same branch
  const isSelf = t.id === actor.id;
  const sameBranch = String(t.branch_id) === String(actor.branchId);
  if (!actor.isAdmin && !isSelf && (!sameBranch || Number(t.role_id) === ADMIN_ROLE_ID)) {
    return res.status(403).json({ message: "You cannot change this user" });
  }
 
  // ---------- password ----------
  if (b.newPassword !== undefined || b.confirmPassword !== undefined) {
    const np = String(b.newPassword ?? ""), cp = String(b.confirmPassword ?? "");
    if (np !== cp) return res.status(400).json({ message: "Passwords do not match" });
    if (np.length < PASSWORD_MIN) return res.status(400).json({ message: `The password must be at least ${PASSWORD_MIN} characters` });
    await pool.query("UPDATE admin_user SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [await bcrypt.hash(np, 10), targetId]);
    await audit("User Management", `Changed the password of ${t.username}`, actor.id);
    return res.status(200).json({ message: "Password updated successfully" });
  }
 
  // ---------- details ----------
  const firstName = uClean(b.first_name), lastName = uClean(b.last_name), email = uClean(b.email);
  if (!firstName || !lastName || !NAME_RE.test(firstName) || !NAME_RE.test(lastName)) return res.status(400).json({ message: "Invalid name" });
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ message: "Invalid email" });
  const mobileNew = formatPhoneNumber(uClean(b.mobile));
  if (mobileNew.error) return res.status(400).json({ message: mobileNew.error });
 
  // role: only an administrator changes it
  let roleId = Number(t.role_id);
  if (actor.isAdmin) {
    const wanted = uToInt(b.selectedRole);
    if (!Number.isInteger(wanted)) return res.status(400).json({ message: "Select the role" });
    if (wanted !== roleId) {
      if (isSelf) return res.status(400).json({ message: "You cannot change your own role" });
      if (!(await roleIsUsable(wanted))) return res.status(400).json({ message: "Selected role not found or inactive" });
      if (roleId === ADMIN_ROLE_ID && (await activeAdminsExcept(targetId)) === 0) return res.status(400).json({ message: "This is the last active administrator" });
      roleId = wanted;
    }
  }
 
  // branch: only an administrator changes it
  let branchId = t.branch_id;
  if (actor.isAdmin) {
    const wantedBranch = uToInt(b.selectedBranch ?? b.selectedHub);
    if (Number.isInteger(wantedBranch) && wantedBranch > 0 && wantedBranch !== Number(branchId)) {
      if ((await pool.query("SELECT 1 FROM service_branches WHERE branch_id = $1 AND is_active = true", [wantedBranch])).rowCount === 0) {
        return res.status(400).json({ message: "Selected branch not found or inactive" });
      }
      branchId = wantedBranch;
    }
  }
 
  let nicValue = t.nic;
  if (uClean(b.nic)) {
    const nicClean = uClean(b.nic).toUpperCase();
    if (!NIC_RE.test(nicClean)) return res.status(400).json({ message: "Invalid NIC" });
    if ((await pool.query("SELECT 1 FROM admin_user WHERE nic = $1 AND id <> $2", [nicClean, targetId])).rowCount) return res.status(409).json({ message: "NIC already exists" });
    nicValue = nicClean;
  }
 
  const result = await pool.query(
    `UPDATE admin_user SET first_name = $1, last_name = $2, email = $3, mobile = $4, role_id = $5, branch_id = $6, nic = $7, updated_at = CURRENT_TIMESTAMP
     WHERE id = $8 RETURNING id, first_name, last_name, username, email, mobile, role_id, status, nic, branch_id`,
    [firstName, lastName, email, mobileNew.formatted, roleId, branchId, nicValue, targetId]);
  await audit("User Management", `Edited user ${t.username}${roleId !== Number(t.role_id) ? ` (role ${t.role_id} -> ${roleId})` : ""}`, actor.id);
  return res.status(200).json({ message: "User details updated successfully", user: result.rows[0] });
}));
 
// the user himself, or an administrator
router.post("/get-user-details", authenticateToken, act(async (req, res, actor) => {
  const id = uToInt(req.body?.user_id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "User ID is required" });
  if (!actor.isAdmin && id !== actor.id) return res.status(403).json({ message: "You cannot view this user" });
  const q = await pool.query(
    `SELECT admin_user.*, admin_role.role_name FROM admin_user LEFT JOIN admin_role ON admin_role.id::INTEGER = admin_user.role_id WHERE admin_user.id = $1`, [id]);
  if (q.rowCount === 0) return res.status(404).json({ message: "User not found" });
  res.json(safeUser(q.rows[0]));
}));
 
// needs a valid token now (it was open to everybody: anybody could test which usernames exist)
router.post("/check-username", authenticateToken, async (req, res) => {
  const username = uClean(req.body?.username);
  if (!username) return res.status(400).json({ message: "Username is required" });
  try {
    const result = await pool.query("SELECT COUNT(*) FROM admin_user WHERE lower(username) = lower($1)", [username]);
    return res.json({ exists: parseInt(result.rows[0].count, 10) > 0 });
  } catch (error) { console.error("Error checking username:", error); return res.status(500).json({ message: "Server error" }); }
});
 
router.post("/client-username", authenticateToken, async (req, res) => {
  const username = uClean(req.body?.username);
  if (!username) return res.status(400).json({ message: "Username is required" });
  try {
    const result = await pool.query("SELECT COUNT(*) FROM client_staff WHERE username = $1", [username]);
    return res.json({ exists: parseInt(result.rows[0].count, 10) > 0 });
  } catch (error) { console.error("Error checking username:", error); return res.status(500).json({ message: "Server error" }); }
});
 
// ---------------------------------------------------------------- roles
router.post("/addrole", authenticateToken, act(async (req, res, actor) => {
  const roleName = uClean(req.body?.roleName);
  if (roleName.length < 2 || roleName.length > 60) return res.status(400).json({ message: "The role name must be 2 to 60 characters" });
  const ids = [...new Set((Array.isArray(req.body?.privileges) ? req.body.privileges : []).map(uToInt))];
  if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) return res.status(400).json({ message: "Select at least one privilege" });
  const known = await pool.query("SELECT id FROM admin_uimenudata WHERE id = ANY($1::int[])", [ids]);
  if (known.rowCount !== ids.length) return res.status(400).json({ message: "Some privileges do not exist" });
  if ((await pool.query("SELECT 1 FROM admin_role WHERE lower(role_name) = lower($1)", [roleName])).rowCount) return res.status(409).json({ message: "A role with this name already exists" });
  const dashboardAccess = (Array.isArray(req.body?.dashboardAccess) ? req.body.dashboardAccess : []).filter((x) => x === "dashboard");
 
  const result = await pool.query(
    "INSERT INTO admin_role (role_name, date, status, privileges, dashboard_access, user_id) VALUES ($1, $2, 'active', $3::TEXT[], $4::TEXT[], $5) RETURNING *",
    [roleName, new Date(), ids.sort((a, b) => a - b).map(String), dashboardAccess, actor.id]);
  await audit("User Management", `Added role ${roleName}`, actor.id);
  res.status(201).json({ message: "Role added successfully", role: result.rows[0] });
}, { adminOnly: true }));
 
// the menu of the logged-in user. An administrator may ask for another role (preview), anybody else always gets his / her own role.
router.post("/sidebar", authenticateToken, act(async (req, res, actor) => {
  const roleid = actor.isAdmin ? (uToInt(req.body?.roleid) || actor.roleId) : actor.roleId;
  const roleResult = await pool.query("SELECT privileges, dashboard_access FROM admin_role WHERE id = $1", [roleid]);
  if (roleResult.rows.length === 0) return res.status(404).json({ message: "Role not found" });
 
  const privileges = roleResult.rows[0].privileges || [];
  const dashboardAccess = roleResult.rows[0].dashboard_access;
 
  const menuQuery = `SELECT json_agg(
          json_build_object(
              'menu_id', t.id, 'name', t.name, 'route', t.route, 'parent_id', t.parent_id,
              'children', COALESCE((
                  SELECT json_agg(
                      json_build_object(
                          'menu_id', s.id, 'name', s.name, 'route', s.route, 'parent_id', s.parent_id, 'icon', s.icon,
                          'children', COALESCE((
                              SELECT json_agg(json_build_object('menu_id', c.id, 'name', c.name, 'route', c.route, 'parent_id', c.parent_id) ORDER BY c.order_index)
                              FROM admin_uimenudata c WHERE c.parent_id = s.id AND c.status = 'active' AND c.id = ANY($1)
                          ), '[]'::json)
                      ) ORDER BY s.order_index
                  )
                  FROM admin_uimenudata s WHERE s.parent_id = t.id AND s.status = 'active' AND s.id = ANY($1)
              ), '[]'::json)
          ) ORDER BY t.order_index
      ) AS menu
      FROM admin_uimenudata t WHERE t.parent_id IS NULL AND t.status = 'active' AND t.id = ANY($1)`;
  const mainQuery = `SELECT id as menu_id, name, route, parent_id, icon FROM admin_uimenudata WHERE parent_id = 0 AND status = 'active' AND id = ANY($1) ORDER BY order_index`;
 
  const [menuResult, mainResult] = await Promise.all([pool.query(menuQuery, [privileges]), pool.query(mainQuery, [privileges])]);
  let menuItems = menuResult.rows[0]?.menu || [];       // null when the role has no menu: spreading null used to crash
 
  if (dashboardAccess && dashboardAccess.length > 0) {
    const dashboardItems = await pool.query("SELECT * FROM admin_uimenudata WHERE privilege_id = ANY($1)", [dashboardAccess]);
    menuItems = [...dashboardItems.rows, ...menuItems];
  }
  return res.status(200).json({ message: "Success", menu: menuItems, main: mainResult.rows });
}));
 
// the whole menu tree (to tick privileges of a role)
router.get("/sidebar-items", authenticateToken, act(async (req, res) => {
  const query = `
    SELECT json_agg(
      json_build_object(
        'menu_id', t.id, 'name', t.name, 'route', t.route, 'parent_id', t.parent_id,
        'children', COALESCE((
          SELECT json_agg(
            json_build_object(
              'menu_id', s.id, 'name', s.name, 'route', s.route, 'parent_id', s.parent_id, 'icon', s.icon,
              'children', COALESCE((
                SELECT json_agg(json_build_object('menu_id', c.id, 'name', c.name, 'route', c.route, 'parent_id', c.parent_id) ORDER BY c.order_index)
                FROM admin_uimenudata c WHERE c.parent_id = s.id AND c.status IN ('active','permission')
              ), '[]'::json)
            ) ORDER BY s.order_index
          )
          FROM admin_uimenudata s WHERE s.parent_id = t.id AND s.status IN ('active','permission')
        ), '[]'::json)
      ) ORDER BY t.order_index
    ) AS menu
    FROM admin_uimenudata t WHERE t.parent_id IS NULL AND t.status IN ('active','permission')`;
  const otherQuery = "SELECT id, name FROM admin_uimenudata WHERE parent_id = 0 AND status = 'active'";
  const [menuItemsResult, otherResult] = await Promise.all([pool.query(query), pool.query(otherQuery)]);
  const menuItems = menuItemsResult.rows[0]?.menu || [];
  res.json({ message: "Sidebar items fetched successfully", menuItems, otherResult: otherResult.rows });
}, { adminOnly: true }));
 
// active roles for the dropdowns. Only an administrator sees (and can pick) the administrator role.
router.post("/get-roles", authenticateToken, act(async (req, res, actor) => {
  const result = await pool.query("SELECT id, role_name, status, privileges FROM admin_role WHERE status = 'active' AND ($1::boolean OR id <> $2) ORDER BY id DESC", [actor.isAdmin, ADMIN_ROLE_ID]);
  res.json(result.rows);
}));
 
router.post("/get-branches", authenticateToken, act(async (req, res) => {
  const result = await pool.query("SELECT branch_id, branch_code, branch_name FROM service_branches WHERE is_active = true ORDER BY branch_name ASC");
  res.json(result.rows);
}));
 
router.post("/get-role-table", authenticateToken, act(async (req, res) => {
  const page = Math.max(1, parseInt(req.body?.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.body?.limit, 10) || 25));
  const search = uClean(req.body?.search);
  const offset = (page - 1) * limit;
 
  const where = search ? "WHERE role_name ILIKE $1 OR id::text ILIKE $1" : "";
  const params = search ? [`%${search}%`] : [];
  const result = await pool.query(`SELECT id, role_name, status, privileges FROM admin_role ${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
  const count = await pool.query(`SELECT COUNT(*) FROM admin_role ${where}`, params);
  const totalRoles = parseInt(count.rows[0].count, 10);
  res.json({ roles: result.rows, totalRoles, totalPages: Math.ceil(totalRoles / limit), currentPage: page });
}, { adminOnly: true }));
 
router.post("/update-role-status", authenticateToken, act(async (req, res, actor) => {
  const roleId = uToInt(req.body?.roleId);
  const status = uClean(req.body?.status).toLowerCase();
  if (!Number.isInteger(roleId) || !["active", "inactive"].includes(status)) return res.status(400).json({ message: "Invalid request data" });
  if (status === "inactive") {
    if (roleId === ADMIN_ROLE_ID) return res.status(400).json({ message: "The administrator role cannot be deactivated" });
    const used = Number((await pool.query("SELECT COUNT(*) FROM admin_user WHERE role_id = $1 AND lower(status) = 'active'", [roleId])).rows[0].count);
    if (used > 0) return res.status(409).json({ message: `${used} active user${used === 1 ? "" : "s"} still use this role. Move them to another role first.` });
  }
  const result = await pool.query("UPDATE admin_role SET status = $1 WHERE id = $2 RETURNING *", [status, roleId]);
  if (result.rowCount === 0) return res.status(404).json({ message: "Role not found" });
  await audit("User Management", `Role ${result.rows[0].role_name} set to ${status}`, actor.id);
  res.json({ message: "Role status updated successfully", role: result.rows[0] });
}, { adminOnly: true }));
 
router.post("/update-role-privileges", authenticateToken, act(async (req, res, actor) => {
  const roleId = uToInt(req.body?.roleId);
  const ids = [...new Set((Array.isArray(req.body?.privileges) ? req.body.privileges : []).map(uToInt))];
  if (!Number.isInteger(roleId) || ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) return res.status(400).json({ message: "Invalid request data" });
  const known = await pool.query("SELECT id FROM admin_uimenudata WHERE id = ANY($1::int[])", [ids]);
  if (known.rowCount !== ids.length) return res.status(400).json({ message: "Some privileges do not exist" });
  const result = await pool.query("UPDATE admin_role SET privileges = $1::TEXT[] WHERE id = $2 RETURNING *", [ids.sort((a, b) => a - b).map(String), roleId]);
  if (result.rowCount === 0) return res.status(404).json({ message: "Role not found" });
  await audit("User Management", `Changed the privileges of role ${result.rows[0].role_name}`, actor.id);
  res.json({ message: "Role privileges updated successfully", role: result.rows[0] });
}, { adminOnly: true }));
 
router.post("/get-role-privileges", authenticateToken, act(async (req, res) => {
  const roleId = uToInt(req.body?.roleId);
  if (!Number.isInteger(roleId)) return res.status(400).json({ message: "Invalid role" });
  const roleQuery = await pool.query("SELECT privileges, dashboard_access FROM admin_role WHERE id = $1", [roleId]);
  if (roleQuery.rowCount === 0) return res.status(404).json({ message: "Role not found" });
  const { privileges = [], dashboard_access = [] } = roleQuery.rows[0];
  const privilegeQuery = await pool.query("SELECT id, parent_id, name, route, icon, privilege_id, order_index FROM admin_uimenudata ORDER BY privilege_id DESC");
  if (privilegeQuery.rowCount === 0) return res.json({ privileges: [], dashboardAccess: dashboard_access });
  const buildHierarchy = (parentId) =>
    privilegeQuery.rows.filter((row) => row.parent_id === parentId).map((row) => ({
      ...row, subcategories: buildHierarchy(row.id), assigned: (privileges || []).includes(row.id.toString()),
    }));
  res.json({ privileges: buildHierarchy(null), dashboardAccess: dashboard_access });
}, { adminOnly: true }));
 
// (legacy: reads client_log / client_staff) administrator only
router.post("/get-user-logs", authenticateToken, act(async (req, res) => {
  const { user_id, fromDate, toDate, page = 1 } = req.body || {};
  const limit = Math.min(100, Math.max(1, parseInt(req.body?.limit, 10) || 25));
  const offset = Math.max(0, parseInt(req.body?.skip, 10) || 0);
  const filters = [], params = [];
  if (user_id) { params.push(user_id); filters.push(`cl.user_id = $${params.length}`); }
  if (fromDate) { params.push(fromDate); filters.push(`cl.date >= $${params.length}`); }
  if (toDate) { params.push(toDate); filters.push(`cl.date <= $${params.length}`); }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT cl.id, cl.date, cl.user_id, cs.first_name AS user_name, cl.client_id, cl.module, cl.log
     FROM client_log cl LEFT JOIN client_staff cs ON cl.user_id = cs.id ${where}
     ORDER BY cl.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
  const count = await pool.query(`SELECT COUNT(*) FROM client_log cl ${where}`, params);
  const totalLogs = parseInt(count.rows[0].count, 10);
  res.json({ logs: result.rows, totalLogs, totalPages: Math.ceil(totalLogs / limit), currentPage: page });
}, { adminOnly: true }));
 
 
 
 
 
 
 
 
 
 
 
// Helpers of the customer / job routes below (empty value -> null, so SQL "$n IS NULL" filters work).
// The user-management routes above have their own uClean / uToInt on purpose: they must not share these.
const clean = (v) => { const s = String(v ?? "").trim(); return s === "" ? null : s; };
const toInt = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};
 
// The logged-in system user (admin_user.id) taken from the JWT set by authenticateToken.
// Change "user_id" here if your token payload uses another key.
const currentUserId = (req) => {
  const n = Number(req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) ? n : null;
};
 
const PHONE_RE = /^\d{10,11}$/;
 
// Values for customer.category_hr_approval_status.
// CHECK your constraint and adjust if needed:
//   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname LIKE '%approval%';
const APPROVAL = {
  PENDING: "PENDING",    // category selected / switched -> waits for HR D. approval
  APPROVED: "APPROVED",  // approved by HR D. -> cannot be changed from the registration form
};
 
/* ----------------------------- helpers ----------------------------- */
 
 
// Referral codes: KAZ-XXXXXX (no 0 / O / 1 / I, so they are easy to read out over the phone)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newReferralCode = () => {
  let c = "KAZ-";
  for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
};
const normCode = (v) => (clean(v) || "").toUpperCase().replace(/\s+/g, "");
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
 
function validateCustomer(b) {
  if (!clean(b.customerName)) return "Customer name is required";
  if (!PHONE_RE.test(String(b.contactNumber ?? "").trim())) return "Contact number must be 10 or 11 digits";
 
  const alt = clean(b.altContactNumber);
  if (alt && !PHONE_RE.test(alt)) return "WhatsApp number must be 10 or 11 digits";
 
  const email = clean(b.email);
  if (email && !EMAIL_RE.test(email)) return "Invalid email";
 
  const birth = clean(b.birthDate);
  if (birth && (!isDate(birth) || birth > new Date().toISOString().slice(0, 10) || birth < "1900-01-01")) return "Invalid birthday";
 
  if (!Array.isArray(b.vehicles) || b.vehicles.length === 0) return "Add at least one vehicle";
 
  const seen = new Set();
  for (let i = 0; i < b.vehicles.length; i++) {
    const v = b.vehicles[i] || {};
    const label = `Vehicle ${i + 1}`;
 
    const reg = clean(v.regNo);
    if (!reg) return `${label}: registration number is required`;
    if (seen.has(reg.toUpperCase())) return `${label}: duplicate registration number`;
    seen.add(reg.toUpperCase());
 
    const year = toInt(v.year);
    if (Number.isNaN(year) || (year !== null && (year < 1950 || year > new Date().getFullYear() + 1))) {
      return `${label}: invalid year of manufacture`;
    }
    const mileage = toInt(v.mileage);
    if (Number.isNaN(mileage) || (mileage !== null && mileage < 0)) return `${label}: invalid mileage`;
  }
  return null;
}
 
/* ------------------ POST /api/customers  (create / update) ------------------
   Body = the whole wizard form: customerId?, customerName, nic, companyName, contactNumber,
   altContactNumber, email, profession, vehicles[], category ("BLUE"...), hrRemarks
   - No customerId       -> new customer (ERP id is generated: CUS-00001)
   - customerId present  -> existing customer picked from the search box -> updated, no duplicate
   Customer + all vehicles are saved in ONE transaction.
------------------------------------------------------------------------------ */
router.post("/customers", authenticateToken, async (req, res) => {
  const b = req.body || {};
 
  const problem = validateCustomer(b);
  if (problem) return res.status(400).json({ message: problem });
 
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
 
    // 1) Category requested from the form (if any)
    let requestedCategoryId = null;
    if (clean(b.category)) {
      const cat = await client.query(
        "SELECT id FROM customer_category WHERE lower(name) = lower($1)",
        [String(b.category).trim()]
      );
      if (cat.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Unknown customer category" });
      }
      requestedCategoryId = cat.rows[0].id;
    }
 
    // HR D. Remarks (reason for the category selection / switch)
    const hrRemarks = clean(b.hrRemarks);
 
    // 1b) How the customer found us + the friend's referral code (when the source is "Friend / Referral")
    const birthDate = clean(b.birthDate);
    let groupId = null;
    if (clean(b.groupId)) {
      const g = await client.query("SELECT id FROM customer_group WHERE id = $1 AND is_active", [toInt(b.groupId)]);
      if (g.rowCount === 0) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Unknown customer group" }); }
      groupId = g.rows[0].id;
    }
    let sourceId = null, referredById = null;
    if (clean(b.sourceId)) {
      const src = await client.query("SELECT id, requires_referral FROM customer_source WHERE id = $1 AND is_active", [toInt(b.sourceId)]);
      if (src.rowCount === 0) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Unknown source" }); }
      sourceId = src.rows[0].id;
      const code = src.rows[0].requires_referral ? normCode(b.referredByCode) : "";
      if (code) { // friend's referral code is optional; if entered it must be valid
        const friend = await client.query("SELECT id, erp_customer_id FROM customer WHERE referral_code = $1", [code]);
        if (friend.rowCount === 0) { await client.query("ROLLBACK"); return res.status(400).json({ message: "This referral code was not found" }); }
        if (friend.rows[0].erp_customer_id === clean(b.customerId)) { await client.query("ROLLBACK"); return res.status(400).json({ message: "A customer cannot use his own referral code" }); }
        referredById = friend.rows[0].id;
      }
    }
 
    // 2) Customer (insert or update)
    const fields = [
      clean(b.customerName),
      clean(b.nic),
      clean(b.companyName),
      String(b.contactNumber).trim(),
      clean(b.altContactNumber),
      clean(b.email),
      clean(b.profession),
    ];
 
    let customer;
    const existingErpId = clean(b.customerId);
 
    if (existingErpId) {
      const current = await client.query(
        `SELECT customer_category_id, category_hr_approval_status
           FROM customer WHERE erp_customer_id = $1 FOR UPDATE`,
        [existingErpId]
      );
      if (current.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Customer not found" });
      }
      const cur = current.rows[0];
 
      // A category already APPROVED by HR D. cannot be changed from this form
      const locked =
        cur.customer_category_id !== null && cur.category_hr_approval_status === APPROVAL.APPROVED;
      const newCategoryId = locked ? null : requestedCategoryId;
      const newStatus = newCategoryId ? APPROVAL.PENDING : null;
 
      const upd = await client.query(
        `UPDATE customer SET
           customer_name = $1, nic_passport_no = $2, company_name = $3, contact_number = $4,
           alt_contact_number = $5, email = $6, profession = $7,
           customer_category_id = COALESCE($8, customer_category_id),
           category_hr_approval_status = COALESCE($9, category_hr_approval_status),
           category_hr_remarks = CASE WHEN $8::int IS NULL THEN category_hr_remarks ELSE $11 END,
           birth_date = $12,
           source_id = $13,
           referred_by_customer_id = CASE WHEN $13::int IS NULL THEN referred_by_customer_id ELSE $14 END,
           referral_code = COALESCE(referral_code, $15),
           customer_group_id = COALESCE($16, customer_group_id),
           updated_at = CURRENT_TIMESTAMP
         WHERE erp_customer_id = $10
         RETURNING id, erp_customer_id, category_hr_approval_status, referral_code, loyalty_points`,
        [...fields, newCategoryId, newStatus, existingErpId, hrRemarks, birthDate, sourceId, referredById, newReferralCode(), groupId]
      );
      customer = upd.rows[0];
    } else {
      // Reserve the next id first so the ERP id can be built from it
      const seq = await client.query("SELECT nextval(pg_get_serial_sequence('customer', 'id')) AS id");
      const newId = seq.rows[0].id;
      const erpId = `CUS-${String(newId).padStart(5, "0")}`;
 
      // New customer: any selected category waits for HR D. approval
      const ins = await client.query(
        `INSERT INTO customer
           (id, erp_customer_id, customer_name, nic_passport_no, company_name, contact_number,
            alt_contact_number, email, profession, customer_category_id, category_hr_approval_status,
            category_hr_remarks, birth_date, source_id, referred_by_customer_id, referral_code, customer_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id, erp_customer_id, category_hr_approval_status, referral_code, loyalty_points`,
        [newId, erpId, ...fields, requestedCategoryId, APPROVAL.PENDING, hrRemarks, birthDate, sourceId, referredById, newReferralCode(), groupId]
      );
      customer = ins.rows[0];
    }
 
    // 3) Vehicles (same customer + same reg no -> updated instead of duplicated)
    const vehicles = [];
    for (const v of b.vehicles) {
      const r = await client.query(
        `INSERT INTO customer_vehicle
           (customer_id, reg_no, year_of_manufacture, mileage_km, colour, appointment_date,
            appointment_time, chassis_no, engine_no, tyre_size, customer_matter, appointment_department_id, sales_officer, vehicle_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (customer_id, reg_no) DO UPDATE SET
           year_of_manufacture = EXCLUDED.year_of_manufacture,
           mileage_km          = EXCLUDED.mileage_km,
           colour              = EXCLUDED.colour,
           appointment_date    = EXCLUDED.appointment_date,
           appointment_time    = EXCLUDED.appointment_time,
           chassis_no          = EXCLUDED.chassis_no,
           engine_no           = EXCLUDED.engine_no,
           tyre_size           = EXCLUDED.tyre_size,
           customer_matter     = EXCLUDED.customer_matter,
           appointment_department_id = EXCLUDED.appointment_department_id,
           sales_officer       = EXCLUDED.sales_officer,
           vehicle_type        = EXCLUDED.vehicle_type,
           updated_at          = CURRENT_TIMESTAMP
         RETURNING id, reg_no`,
        [
          customer.id,
          clean(v.regNo).toUpperCase(),
          toInt(v.year),
          toInt(v.mileage),
          clean(v.color),
          clean(v.appointmentDate),
          clean(v.appointmentTime),
          clean(v.chassisNo),
          clean(v.engineNo),
          clean(v.tyreSize),
          clean(v.matter),
          v.isAppointment === false ? null : toInt(v.appointmentDepartmentId),
          v.isAppointment === false ? null : clean(v.salesOfficer),
          clean(v.vehicleType),
        ]
      );
      vehicles.push({ id: r.rows[0].id, regNo: r.rows[0].reg_no });
    }
 
    await client.query("COMMIT");
 
    return res.status(201).json({
      message: existingErpId ? "Customer updated successfully" : "Customer saved successfully",
      customer: {
        id: customer.id,                       // DB id (use this later for the job table)
        customerId: customer.erp_customer_id,  // ERP id, e.g. CUS-00001
        categoryApprovalStatus: customer.category_hr_approval_status,
        referralCode: customer.referral_code,   // this customer's own code, to give to friends
        loyaltyPoints: Number(customer.loyalty_points || 0),
        vehicles,
      },
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving customer:", error);
 
    if (error.code === "23505") {
      const info = `${error.constraint || ""} ${error.detail || ""}`;
      if (info.includes("nic")) {
        return res.status(409).json({ message: "A customer with this NIC / Passport number already exists" });
      }
      if (info.includes("referral")) {
        return res.status(409).json({ message: "Could not create a referral code, please try again" });
      }
      if (info.includes("erp")) {
        return res.status(409).json({ message: "ERP customer id already exists, please try again" });
      }
      return res.status(409).json({ message: "Duplicate record" });
    }
    if (error.code === "23502") {
      return res.status(400).json({ message: `Required value missing: ${error.column}` });
    }
    if (error.code === "23514") {
      return res.status(400).json({ message: "A value is not allowed by a database rule (check constraint)" });
    }
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});
 
/* ------------- GET /api/customers/search?q=...  (search box) -------------
   Matches name / NIC / mobile / alt mobile / vehicle number (spaces and dashes ignored).
   Returns the same shape the frontend CustomerSearch expects.
-------------------------------------------------------------------------- */
router.get("/customers/search", authenticateToken, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
 
  const escaped = q.replace(/[\\%_]/g, "\\$&");
  const like = `%${escaped}%`;
  const likeReg = `%${escaped.toLowerCase().replace(/[\s-]/g, "")}%`;
 
  try {
    const result = await pool.query(
      `SELECT
         c.id                 AS "dbId",
         c.erp_customer_id    AS "customerId",
         c.customer_name      AS "customerName",
         COALESCE(c.nic_passport_no, '')    AS "nic",
         COALESCE(c.company_name, '')       AS "companyName",
         c.contact_number                   AS "contactNumber",
         COALESCE(c.alt_contact_number, '') AS "altContactNumber",
         COALESCE(c.email, '')              AS "email",
         COALESCE(c.profession, '')         AS "profession",
         COALESCE(c.birth_date::text, '')   AS "birthDate",
         COALESCE(c.source_id::text, '')    AS "sourceId",
         COALESCE(c.customer_group_id::text, '') AS "groupId",
         COALESCE(c.referral_code, '')      AS "ownReferralCode",
         c.loyalty_points::float            AS "loyaltyPoints",
         COALESCE(rb.referral_code, '')     AS "referredByCode",
         cat.name                           AS "categoryName",
         c.category_hr_approval_status      AS "categoryApprovalStatus",
         COALESCE(
           json_agg(
             json_build_object(
               'regNo',           v.reg_no,
               'vehicleType',     COALESCE(v.vehicle_type, ''),
               'year',            COALESCE(v.year_of_manufacture::text, ''),
               'mileage',         COALESCE(v.mileage_km::text, ''),
               'color',           COALESCE(v.colour, ''),
               'appointmentDate', COALESCE(v.appointment_date::text, ''),
               'appointmentTime', COALESCE(left(v.appointment_time::text, 5), ''),
               'appointmentDepartmentId', COALESCE(v.appointment_department_id::text, ''),
               'salesOfficer',    COALESCE(v.sales_officer, ''),
               'chassisNo',       COALESCE(v.chassis_no, ''),
               'engineNo',        COALESCE(v.engine_no, ''),
               'tyreSize',        COALESCE(v.tyre_size, ''),
               'matter',          COALESCE(v.customer_matter, '')
             ) ORDER BY v.id
           ) FILTER (WHERE v.id IS NOT NULL),
           '[]'::json
         ) AS vehicles
       FROM customer c
       LEFT JOIN customer_category cat ON cat.id = c.customer_category_id
       LEFT JOIN customer rb ON rb.id = c.referred_by_customer_id
       LEFT JOIN customer_vehicle v ON v.customer_id = c.id
       WHERE c.id IN (
         SELECT c2.id
         FROM customer c2
         LEFT JOIN customer_vehicle v2 ON v2.customer_id = c2.id
         WHERE c2.customer_name       ILIKE $1
            OR c2.nic_passport_no     ILIKE $1
            OR c2.contact_number      ILIKE $1
            OR c2.alt_contact_number  ILIKE $1
            OR regexp_replace(lower(v2.reg_no), '[\\s-]', '', 'g') LIKE $2
         LIMIT 8
       )
       GROUP BY c.id, cat.id, rb.id
       ORDER BY c.customer_name`,
      [like, likeReg]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("Error searching customers:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ GET /api/customer-groups  (Edu Care, Business Care, Sports, Senior Citizen, Common Care ...) ------------------ */
router.get("/customer-groups", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name FROM customer_group WHERE is_active ORDER BY sort_order, id`);
    return res.json(r.rows);
  } catch (error) {
    console.error("Error loading customer groups:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ GET /api/customer-sources  (the "How did you find us?" selector) ------------------ */
router.get("/customer-sources", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, requires_referral AS "requiresReferral" FROM customer_source WHERE is_active ORDER BY sort_order, id`);
    return res.json(r.rows);
  } catch (error) {
    console.error("Error loading customer sources:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ GET /api/customers/referral/:code  (checks a friend's referral code) ------------------
   -> { valid: true, customerName, customerId }  (only the first name + the ERP id are shown) */
router.get("/customers/referral/:code", authenticateToken, async (req, res) => {
  const code = normCode(req.params.code);
  if (!code) return res.json({ valid: false });
  try {
    const r = await pool.query("SELECT erp_customer_id, customer_name FROM customer WHERE referral_code = $1", [code]);
    if (r.rowCount === 0) return res.json({ valid: false });
    return res.json({ valid: true, customerId: r.rows[0].erp_customer_id, customerName: r.rows[0].customer_name });
  } catch (error) {
    console.error("Error checking referral code:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ POST /api/customers/:id/points   { points, reason, refType?, refId? } ------------------
   Adds (or, with a negative number, takes) loyalty points of a customer. Call it from the payment flow:
   e.g. after a payment is saved:  POST /customers/12/points { points: 150, reason: "Payment JOB-00031", refType: "PAYMENT", refId: paymentId }
   (The same logic is exported as addCustomerPoints(db, customerId, points, ...) for server side use.) */
async function addCustomerPoints(db, customerId, points, { reason = null, refType = null, refId = null, userId = null } = {}) {
  const p = Math.round(Number(points) * 100) / 100;
  if (!Number.isFinite(p) || p === 0) throw new Error("Invalid points");
  const upd = await db.query(
    `UPDATE customer SET loyalty_points = GREATEST(loyalty_points + $1, 0), updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING loyalty_points::float AS points`,
    [p, customerId]);
  if (upd.rowCount === 0) throw new Error("Customer not found");
  await db.query(
    `INSERT INTO customer_points_log (customer_id, points, reason, ref_type, ref_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [customerId, p, reason, refType, refId, userId]);
  return upd.rows[0].points;
}
router.post("/customers/:id/points", authenticateToken, async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid customer" });
  try {
    const uid = Number(req.user?.user_id ?? req.user?.id);
    const points = await addCustomerPoints(pool, id, req.body?.points, {
      reason: clean(req.body?.reason)?.slice(0, 200), refType: clean(req.body?.refType)?.slice(0, 30),
      refId: toInt(req.body?.refId), userId: Number.isInteger(uid) ? uid : null,
    });
    return res.json({ loyaltyPoints: points });
  } catch (error) {
    if (error.message === "Customer not found") return res.status(404).json({ message: error.message });
    if (error.message === "Invalid points") return res.status(400).json({ message: "Enter the points (a number other than 0)" });
    console.error("Error adding points:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
router.addCustomerPoints = addCustomerPoints;
 
/* ------------------ GET /api/customer-categories ------------------ */
router.get("/customer-categories", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, features FROM customer_category ORDER BY id");
    return res.json(
      result.rows.map((c) => ({
        id: c.id,
        name: c.name,
        features: String(c.features || "").split("\n").filter(Boolean),
      }))
    );
  } catch (error) {
    console.error("Error loading categories:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ GET /api/departments (Stage 3) ------------------
   Only departments with show_in_job_stage = true are returned.
   Run add_department_visibility.sql first.
------------------------------------------------------------------- */
router.get("/departments", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name FROM department WHERE is_active AND show_in_job_stage ORDER BY sort_order, id"
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("Error loading departments:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ GET /api/consultants (Stage 3) ------------------
   Active admin users with role_id = 2 (consultants).
   NEVER select the password column here.
------------------------------------------------------------------- */
router.get("/consultants", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, username, mobile, email, profile_image
       FROM admin_user
       WHERE role_id = 2 AND lower(status) = 'active'
       ORDER BY first_name, last_name`
    );
    return res.json(
      result.rows.map((u) => ({
        id: u.id,
        name: `${u.first_name} ${u.last_name}`.trim(),
        username: u.username,
        mobile: u.mobile,
        email: u.email,
        profileImage: u.profile_image,
      }))
    );
  } catch (error) {
    console.error("Error loading consultants:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ POST /api/jobs  (Start Job) ------------------
   Body: { customerId (DB id), consultantId, vehicleIds: [DB ids] }
   Creates ONE job per vehicle, copies the vehicle details into the job,
   marks stages 1-3 as COMPLETED and stage 4 as IN_PROGRESS.
   Run create_job_tables.sql first.
----------------------------------------------------------------- */
const INITIAL_COMPLETED_STAGES = 3; // Add Customer, Customer Category, Consultant
 
router.post("/jobs", authenticateToken, async (req, res) => {
  const userId = currentUserId(req); // who is starting the job
  const customerId = toInt(req.body?.customerId);
  const consultantId = toInt(req.body?.consultantId);
  const vehicleIds = (Array.isArray(req.body?.vehicleIds) ? req.body.vehicleIds : [])
    .map(toInt)
    .filter((n) => Number.isInteger(n));
 
  if (!Number.isInteger(customerId)) return res.status(400).json({ message: "Customer is required" });
  if (!Number.isInteger(consultantId)) return res.status(400).json({ message: "Please select a consultant" });
  if (vehicleIds.length === 0) return res.status(400).json({ message: "Select at least one vehicle" });
 
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
 
    // Consultant must be an active admin user with role_id = 2
    const consultant = await client.query(
      "SELECT id FROM admin_user WHERE id = $1 AND role_id = 2 AND lower(status) = 'active'",
      [consultantId]
    );
    if (consultant.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid consultant" });
    }
 
    // The vehicles must belong to this customer
    const vehicles = await client.query(
      "SELECT id, reg_no FROM customer_vehicle WHERE customer_id = $1 AND id = ANY($2::int[]) ORDER BY id",
      [customerId, vehicleIds]
    );
    if (vehicles.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Vehicle not found for this customer" });
    }
 
    const jobs = [];
    for (const v of vehicles.rows) {
      const seq = await client.query("SELECT nextval(pg_get_serial_sequence('job', 'id')) AS id");
      const jobId = seq.rows[0].id;
      const jobNo = `JOB-${String(jobId).padStart(5, "0")}`;
 
      // Job + vehicle details copied straight from customer_vehicle
      await client.query(
        `INSERT INTO job
           (id, job_no, customer_id, vehicle_id, consultant_id, reg_no, year_of_manufacture, mileage_km,
            colour, chassis_no, engine_no, tyre_size, appointment_date, appointment_time, customer_matter, appointment_department_id, sales_officer, vehicle_type,
            current_stage_no, status, created_by)
         SELECT $1::int, $2, v.customer_id, v.id, $3::int, v.reg_no, v.year_of_manufacture, v.mileage_km,
                v.colour, v.chassis_no, v.engine_no, v.tyre_size, v.appointment_date, v.appointment_time,
                v.customer_matter, v.appointment_department_id, v.sales_officer, v.vehicle_type, $4::int, 'IN_PROGRESS', $6::int
         FROM customer_vehicle v WHERE v.id = $5::int`,
        [jobId, jobNo, consultantId, INITIAL_COMPLETED_STAGES + 1, v.id, userId]
      );
 
      // All stages: 1-3 COMPLETED, 4 IN_PROGRESS, the rest PENDING
      await client.query(
        `INSERT INTO job_stage (job_id, stage_no, status, started_at, completed_at, completed_by)
         SELECT $1::int, stage_no,
                CASE WHEN stage_no <= $2::int THEN 'COMPLETED'
                     WHEN stage_no = $2::int + 1 THEN 'IN_PROGRESS'
                     ELSE 'PENDING' END,
                CASE WHEN stage_no <= $2::int + 1 THEN CURRENT_TIMESTAMP END,
                CASE WHEN stage_no <= $2::int THEN CURRENT_TIMESTAMP END,
                CASE WHEN stage_no <= $2::int THEN $3::int END
         FROM job_stage_master`,
        [jobId, INITIAL_COMPLETED_STAGES, userId]
      );
 
      jobs.push({ id: jobId, jobNo, regNo: v.reg_no, currentStageNo: INITIAL_COMPLETED_STAGES + 1 });
    }
 
    await client.query("COMMIT");
 
    // Push notification to the selected consultant (fire and forget - a failed push never breaks Start Job)
    const many = jobs.length > 1;
    sendPushToUser(consultantId, {
      title: many ? `${jobs.length} new jobs assigned to you` : "New job assigned to you",
      body: jobs.map((j) => `${j.jobNo} · ${j.regNo}`).join(", "),
      tag: `new-job-${jobs[0].id}`,
    });
 
    return res.status(201).json({ message: "Job started successfully", jobs });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error creating job:", error);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});
 
/* ------------------ Who sees which jobs ------------------
   Roles in OWN_JOBS_ROLE_IDS (2 = consultant) see ONLY the jobs where they are the consultant.
   Everybody else (administrator, other roles) sees all jobs.
   The role is read from the database by the id in the token, so the browser cannot fake it. */
const OWN_JOBS_ROLE_IDS = [2];
async function ownJobsOf(req) {
  const uid = Number(req.user?.user_id ?? req.user?.id);
  if (!Number.isInteger(uid)) return -1;                        // unknown user -> sees nothing
  const r = await pool.query("SELECT role_id FROM admin_user WHERE id = $1", [uid]);
  if (r.rowCount === 0) return -1;
  return OWN_JOBS_ROLE_IDS.includes(Number(r.rows[0].role_id)) ? uid : null;   // null = sees all jobs
}
// false when this user may not open this job
async function canOpenJob(req, jobId) {
  const own = await ownJobsOf(req);
  if (own === null) return true;
  const r = await pool.query("SELECT 1 FROM job WHERE id = $1 AND consultant_id = $2", [jobId, own]);
  return r.rowCount > 0;
}
 
// A live job whose current stage has been open longer than this is "overdue" (dashboard badge + Overdue tab)
const OVERDUE_HOURS = 24;
const overdueSql = (alias) => `(${alias}.status = 'IN_PROGRESS' AND EXISTS (
  SELECT 1 FROM job_stage os WHERE os.job_id = ${alias}.id AND os.stage_no = ${alias}.current_stage_no
     AND os.started_at < now() - make_interval(hours => ${OVERDUE_HOURS})))`;
 
/* ------------------ Jobs table: shared SELECT / FROM ------------------ */
const JOB_COLUMNS = `SELECT
         j.id,
         j.job_no                                        AS "jobNo",
         c.customer_name                                 AS "customerName",
         c.contact_number                                AS "contactNumber",
         j.reg_no                                        AS "regNo",
         trim(concat(u.first_name, ' ', u.last_name))    AS "consultantName",
         u.mobile                                        AS "consultantMobile",
         d.name                                          AS "departmentName",
         COALESCE(d.requires_initial_approval, false)    AS "requiresStart",
         (jc.id IS NOT NULL)                             AS "complaintSaved",
         COALESCE(d.has_team_allocation, false)          AS "requiresTeam",
         (ta.id IS NOT NULL)                             AS "teamAllocated",
         ta.team_name                                    AS "teamName",
         COALESCE(d.has_bay_allocation, false)           AS "requiresBay",
         (ba.id IS NOT NULL)                             AS "bayAllocated",
         COALESCE(ba.bay_name, ta.bay_name)              AS "bayName",
         jc.start_confirmed_at                           AS "startedAt",
         trim(concat(sc.first_name, ' ', sc.last_name))  AS "startedByName",
         j.current_stage_no                              AS "stageNo",
         COALESCE(d.has_job_activation, false)           AS "activationEnabled",
         ja.activated_at                                 AS "activatedAt",
         COALESCE(CASE WHEN j.current_stage_no = 6 AND COALESCE(d.has_bay_allocation, false) AND NOT COALESCE(d.has_team_allocation, false) THEN 'Bay Allocation'
                       WHEN COALESCE(d.has_spare_parts, false) AND j.current_stage_no = d.spare_parts_stage_no THEN 'Spare Part Review & Order'
                       WHEN COALESCE(d.has_job_inspection, false) AND j.current_stage_no = d.job_inspection_stage_no THEN 'Vehicle Job Inspection'
                       WHEN COALESCE(d.has_job_check, false) AND j.current_stage_no = d.job_check_stage_no THEN 'Vehicle Job Inspection'
                       WHEN COALESCE(d.has_team_check, false) AND j.current_stage_no = d.team_check_stage_no THEN 'Team Self-Inspection'
                       WHEN COALESCE(d.has_drying_check, false) AND j.current_stage_no = d.drying_check_stage_no THEN 'Drying Area'
                       WHEN COALESCE(d.has_internal_check, false) AND j.current_stage_no = d.internal_check_stage_no THEN 'Internal Inspection 2'
                       WHEN COALESCE(d.has_dept_transfer, false) AND j.current_stage_no = d.dept_transfer_stage_no THEN 'Transfer to Other Departments'
                       WHEN COALESCE(d.has_handover_check, false) AND j.current_stage_no = d.handover_check_stage_no AND lower(d.name) = 'wash' THEN 'Delivery Arrangement'
                       WHEN COALESCE(d.has_wash_delivery, false) AND j.current_stage_no = d.wash_delivery_stage_no THEN 'Delivery Review'
                       WHEN COALESCE(d.has_free_inspection, false) AND j.current_stage_no = d.free_inspection_stage_no AND lower(d.name) = 'wash' THEN 'Free Inspection Schedule'
                       WHEN COALESCE(d.has_vehicle_evidence, false) AND j.current_stage_no = d.evidence_stage_no THEN 'Vehicle Evidence of Damages'
                       WHEN COALESCE(d.has_customer_approval, false) AND j.current_stage_no = d.customer_approval_stage_no THEN 'Customer Approval'
                       WHEN COALESCE(d.has_internal_inspection, false) AND j.current_stage_no = d.internal_inspection_stage_no THEN 'Internal Inspection - 1'
                       WHEN COALESCE(d.has_job_activation, false) AND j.current_stage_no = d.job_activation_stage_no THEN 'Job Activation'
                       WHEN COALESCE(d.has_damage_report, false) AND j.current_stage_no = d.damage_report_stage_no THEN 'Vehicle Damages Report' END, m.name)  AS "stageName",
         j.status,
         j.created_at                                    AS "createdAt",
         j.updated_at                                    AS "updatedAt",
         j.appointment_date::text                        AS "appointmentDate",
         left(j.appointment_time::text, 5)               AS "appointmentTime",
         j.customer_matter                               AS "customerMatter",
         j.sales_officer                                 AS "salesOfficer",
         apd.name                                        AS "appointmentDepartmentName",
         (SELECT s.started_at FROM job_stage s
           WHERE s.job_id = j.id AND s.stage_no = j.current_stage_no) AS "stageStartedAt",
         (SELECT count(*)::int FROM job_stage_master)    AS "totalStages",
         (SELECT count(*)::int FROM job_stage s
           WHERE s.job_id = j.id AND s.status = 'COMPLETED') AS "completedStages"
`;
const JOB_FROM = `       FROM job j
       JOIN customer c   ON c.id = j.customer_id
       JOIN admin_user u ON u.id = j.consultant_id
       LEFT JOIN job_stage_master m ON m.stage_no = j.current_stage_no
       LEFT JOIN department d ON d.id = j.department_id
       LEFT JOIN department apd ON apd.id = j.appointment_department_id
       LEFT JOIN job_complaint jc ON jc.job_id = j.id
       LEFT JOIN admin_user sc ON sc.id = jc.start_confirmed_by
       LEFT JOIN job_activation ja ON ja.job_id = j.id
       LEFT JOIN job_team_allocation ta ON ta.job_id = j.id
       LEFT JOIN job_bay_allocation ba ON ba.job_id = j.id
`;
 
/* ------------------ GET /api/jobs (dashboards, tab counts) ------------------ */
// Optional filter: GET /api/jobs?department=Mechanical  (used by the department dashboards)
router.get("/jobs", authenticateToken, async (req, res) => {
  const department = clean(req.query.department);
  try {
    const own = await ownJobsOf(req);
    const result = await pool.query(
      `${JOB_COLUMNS}
       ${JOB_FROM}
       WHERE ($1::text IS NULL OR lower(d.name) = lower($1::text))
         AND ($2::int IS NULL OR j.consultant_id = $2::int)
       ORDER BY j.id DESC
       LIMIT 200`,
      [department, own]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("Error loading jobs:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ GET /api/jobs/summary (dashboard KPIs, department cards, tab counts) ------------------
   Counts only, computed in SQL -> the dashboards no longer download every job.
   (The newer stage columns are read through to_jsonb(d), so the summary keeps working even before the stage SQL files are run.)
   -> { total, active, done, today, noDept, departments: [{ name, active, done, avgProgress, stages: [{ stageNo, stageName, n }] }] } */
router.get("/jobs/summary", authenticateToken, async (req, res) => {
  try {
    const own = await ownJobsOf(req);
    const [tot, deps, stg] = await Promise.all([
      pool.query(`SELECT count(*)::int AS total,
                         count(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS active,
                         count(*) FILTER (WHERE status = 'COMPLETED')::int AS done,
                         count(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS today,
                         count(*) FILTER (WHERE department_id IS NULL)::int AS "noDept",
                         count(*) FILTER (WHERE ${overdueSql("job")})::int AS overdue
                  FROM job WHERE ($1::int IS NULL OR consultant_id = $1::int)`, [own]),
      pool.query(`SELECT d.name,
                         count(j.id) FILTER (WHERE j.status = 'IN_PROGRESS')::int AS active,
                         count(j.id) FILTER (WHERE j.status = 'COMPLETED')::int AS done,
                         COALESCE(round(avg(CASE WHEN j.status = 'IN_PROGRESS' AND ms.n > 0 THEN 100.0 * cs.n / ms.n END)), 0)::int AS "avgProgress"
                  FROM department d
                  LEFT JOIN job j ON j.department_id = d.id AND ($1::int IS NULL OR j.consultant_id = $1::int)
                  LEFT JOIN LATERAL (SELECT count(*) AS n FROM job_stage s WHERE s.job_id = j.id AND s.status = 'COMPLETED') cs ON true
                  CROSS JOIN (SELECT count(*) AS n FROM job_stage_master) ms
                  GROUP BY d.name ORDER BY d.name`, [own]),
      pool.query(`SELECT d.name AS dept, j.current_stage_no AS "stageNo",
                         COALESCE(CASE WHEN COALESCE(d.has_spare_parts, false) AND j.current_stage_no = d.spare_parts_stage_no THEN 'Spare Part Review & Order'
                                       WHEN COALESCE(d.has_job_inspection, false) AND j.current_stage_no = d.job_inspection_stage_no THEN 'Vehicle Job Inspection'
                                       WHEN COALESCE(d.has_job_check, false) AND j.current_stage_no = d.job_check_stage_no THEN 'Vehicle Job Inspection'
                                       WHEN COALESCE(d.has_team_check, false) AND j.current_stage_no = d.team_check_stage_no THEN 'Team Self-Inspection'
                                       WHEN COALESCE(d.has_drying_check, false) AND j.current_stage_no = d.drying_check_stage_no THEN 'Drying Area'
                                       WHEN COALESCE(d.has_internal_check, false) AND j.current_stage_no = d.internal_check_stage_no THEN 'Internal Inspection 2'
                                       WHEN COALESCE(d.has_dept_transfer, false) AND j.current_stage_no = d.dept_transfer_stage_no THEN 'Transfer to Other Departments'
                                       WHEN COALESCE(d.has_handover_check, false) AND j.current_stage_no = d.handover_check_stage_no AND lower(d.name) = 'wash' THEN 'Delivery Arrangement'
                                       WHEN COALESCE(d.has_wash_delivery, false) AND j.current_stage_no = d.wash_delivery_stage_no THEN 'Delivery Review'
                                       WHEN COALESCE(d.has_free_inspection, false) AND j.current_stage_no = d.free_inspection_stage_no AND lower(d.name) = 'wash' THEN 'Free Inspection Schedule'
                                       WHEN COALESCE(d.has_vehicle_evidence, false) AND j.current_stage_no = d.evidence_stage_no THEN 'Vehicle Evidence of Damages'
                                       WHEN COALESCE((to_jsonb(d)->>'has_customer_approval')::boolean, false) AND j.current_stage_no = (to_jsonb(d)->>'customer_approval_stage_no')::int THEN 'Customer Approval'
                                       WHEN COALESCE((to_jsonb(d)->>'has_internal_inspection')::boolean, false) AND j.current_stage_no = (to_jsonb(d)->>'internal_inspection_stage_no')::int THEN 'Internal Inspection - 1'
                                       WHEN COALESCE((to_jsonb(d)->>'has_job_activation')::boolean, false) AND j.current_stage_no = (to_jsonb(d)->>'job_activation_stage_no')::int THEN 'Job Activation'
                                       WHEN COALESCE(d.has_damage_report, false) AND j.current_stage_no = d.damage_report_stage_no THEN 'Vehicle Damages Report' END, m.name) AS "stageName",
                         count(*)::int AS n
                  FROM job j JOIN department d ON d.id = j.department_id
                  LEFT JOIN job_stage_master m ON m.stage_no = j.current_stage_no
                  WHERE j.status = 'IN_PROGRESS' AND ($1::int IS NULL OR j.consultant_id = $1::int)
                  GROUP BY d.name, j.current_stage_no, 3 ORDER BY j.current_stage_no`, [own]),
    ]);
    const departments = deps.rows.map((d) => ({ ...d, stages: stg.rows.filter((x) => x.dept === d.name).map(({ stageNo, stageName, n }) => ({ stageNo, stageName, n })) }));
    return res.json({ ...tot.rows[0], overdueHours: OVERDUE_HOURS, departments });
  } catch (error) {
    console.error("Error loading jobs summary:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ GET /api/jobs/page (CRM Jobs table, paginated) ------------------
   ?page=1&pageSize=10&search=&consultant=&department=&stage=&appointment=ANY|TODAY|UPCOMING|PAST|NONE
   department = a name, or "__none__" for jobs without a department yet
   -> { rows, total, page, pageSize, filters: { consultants, departments, stages } }
   Must stay ABOVE GET /jobs/:id. */
router.get("/jobs/page", authenticateToken, async (req, res) => {
  const pageSize = [10, 25, 50, 100].includes(toInt(req.query.pageSize)) ? toInt(req.query.pageSize) : 10;
  const search = (clean(req.query.search) || "").toLowerCase().replace(/[\s-]/g, "");
  const consultant = clean(req.query.consultant);
  const department = clean(req.query.department);
  const stage = toInt(req.query.stage);
  const status = ["IN_PROGRESS", "COMPLETED", "CANCELLED", "TODAY"].includes(req.query.status) ? req.query.status : null;   // dashboard KPI filter
  const appointment = ["ANY", "TODAY", "UPCOMING", "PAST", "NONE"].includes(req.query.appointment) ? req.query.appointment : null;
  const where = `
       WHERE ($1::text = '' OR replace(replace(lower(concat_ws(' ', j.job_no, c.customer_name, c.contact_number, j.reg_no, u.first_name, u.last_name, j.sales_officer)), ' ', ''), '-', '') LIKE '%' || $1::text || '%')
         AND ($2::text IS NULL OR trim(concat(u.first_name, ' ', u.last_name)) = $2::text)
         AND ($3::text IS NULL OR (lower($3::text) = '__none__' AND d.id IS NULL) OR lower(d.name) = lower($3::text))
         AND ($4::int IS NULL OR j.current_stage_no = $4::int)
         AND ($5::text IS NULL OR ($5::text = 'TODAY' AND j.created_at::date = CURRENT_DATE) OR j.status = $5::text)
         AND ($6::text IS NULL
              OR ($6::text = 'ANY'      AND j.appointment_date IS NOT NULL)
              OR ($6::text = 'TODAY'    AND j.appointment_date = CURRENT_DATE)
              OR ($6::text = 'UPCOMING' AND j.appointment_date > CURRENT_DATE)
              OR ($6::text = 'PAST'     AND j.appointment_date < CURRENT_DATE)
              OR ($6::text = 'NONE'     AND j.appointment_date IS NULL))
         AND ($7::int IS NULL OR j.consultant_id = $7::int)
         AND ($8::boolean IS NOT TRUE OR ${overdueSql("j")})`;
  try {
    const own = await ownJobsOf(req);
    const params = [search, consultant, department, Number.isInteger(stage) ? stage : null, status, appointment, own, req.query.overdue === "1"];
    const count = await pool.query(`SELECT count(*)::int AS n ${JOB_FROM} ${where}`, params);
    const total = count.rows[0].n;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(toInt(req.query.page) || 1, 1), pages);
    const [rows, cons, deps, stages] = await Promise.all([
      pool.query(`${JOB_COLUMNS} ${JOB_FROM} ${where} ORDER BY j.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
      pool.query(`SELECT DISTINCT trim(concat(u.first_name, ' ', u.last_name)) AS name FROM job j JOIN admin_user u ON u.id = j.consultant_id WHERE ($1::int IS NULL OR j.consultant_id = $1::int) ORDER BY 1`, [own]),
      pool.query(`SELECT DISTINCT d.name FROM job j JOIN department d ON d.id = j.department_id WHERE ($1::int IS NULL OR j.consultant_id = $1::int) ORDER BY 1`, [own]),
      pool.query(`SELECT DISTINCT j.current_stage_no AS "stageNo", m.name AS "stageName" FROM job j LEFT JOIN job_stage_master m ON m.stage_no = j.current_stage_no WHERE ($1::int IS NULL OR j.consultant_id = $1::int) ORDER BY 1`, [own]),
    ]);
    return res.json({
      rows: rows.rows, total, page, pageSize, overdueHours: OVERDUE_HOURS, scope: own === null ? "all" : "own",
      filters: { consultants: cons.rows.map((r) => r.name).filter(Boolean), departments: deps.rows.map((r) => r.name), stages: stages.rows },
    });
  } catch (error) {
    console.error("Error loading jobs page:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------- PATCH /api/jobs/:id/department  (Stage 4) -------------
   Body: { departmentId }
   Selected from the Jobs table. Completes stage 4 and moves the job to stage 5.
   Run job_department_stage.sql first.
----------------------------------------------------------------- */
const DEPARTMENT_STAGE_NO = 4;
 
router.patch("/jobs/:id/department", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  const departmentId = toInt(req.body?.departmentId);
 
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  if (!Number.isInteger(departmentId)) return res.status(400).json({ message: "Please select a department" });
 
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
 
    const job = await client.query(
      "SELECT id, current_stage_no, status FROM job WHERE id = $1 FOR UPDATE",
      [jobId]
    );
    if (job.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    if (job.rows[0].status !== "IN_PROGRESS" || job.rows[0].current_stage_no !== DEPARTMENT_STAGE_NO) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This job is not waiting for a department" });
    }
 
    // stage 4 = Vehicle Evidence of Damages first: at least one photo / video, then the department
    const ev = await client.query(
      `SELECT (SELECT count(*)::int FROM job_evidence_file WHERE job_id = $1 AND category = 'GENERAL') AS general,
              (SELECT count(*)::int FROM job_evidence_file WHERE job_id = $1 AND category = 'PROPERTY') AS property,
              (SELECT property_inside FROM job_evidence WHERE job_id = $1) AS inside`,
      [jobId]
    );
    const e = ev.rows[0];
    if (e.general === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Upload the Vehicle Evidence (photos / videos) before selecting the department" });
    }
    if (e.inside === null) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Answer: is there customer property inside the vehicle? (Vehicle Evidence)" });
    }
    if (e.inside === true && e.property === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Add photos / videos of the property inside the vehicle (Vehicle Evidence)" });
    }
 
    const dept = await client.query(
      "SELECT id, name FROM department WHERE id = $1 AND is_active AND show_in_job_stage",
      [departmentId]
    );
    if (dept.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid department" });
    }
 
    const nextStage = DEPARTMENT_STAGE_NO + 1;
 
    await client.query(
      "UPDATE job SET department_id = $1, current_stage_no = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
      [departmentId, nextStage, jobId]
    );
    await client.query(
      "UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2",
      [jobId, DEPARTMENT_STAGE_NO, currentUserId(req)]
    );
    await client.query(
      "UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2",
      [jobId, nextStage]
    );
 
    await client.query("COMMIT");
    return res.json({
      message: "Department selected",
      job: { id: jobId, departmentName: dept.rows[0].name, currentStageNo: nextStage },
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error setting job department:", error);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});
 
/* ------------------ GET /api/jobs/:id  (View: full details + timeline) ------------------
   Customer, vehicle, job info and every stage with the date it was done and the system user who did it.
   Run add_job_audit.sql first (job.created_by).
----------------------------------------------------------------------------------- */
router.get("/jobs/:id", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try { if (!(await canOpenJob(req, jobId))) return res.status(404).json({ message: "Job not found" }); }
  catch (e) { console.error("job scope:", e.message); return res.status(500).json({ message: "Server error" }); }
 
  try {
    const jobRes = await pool.query(
      `SELECT
         j.id, j.job_no, j.status, j.current_stage_no, j.created_at, j.updated_at,
         j.reg_no, j.year_of_manufacture, j.mileage_km, j.colour, j.chassis_no, j.engine_no, j.tyre_size,
         j.appointment_date::text AS appointment_date,
         left(j.appointment_time::text, 5) AS appointment_time,
         j.customer_matter, j.sales_officer, apd.name AS appointment_department_name,
         c.id AS customer_db_id, c.erp_customer_id, c.customer_name, c.nic_passport_no, c.company_name,
         c.contact_number, c.alt_contact_number, c.email, c.profession,
         c.category_hr_approval_status, c.category_hr_remarks,
         cat.name AS category_name,
         cu.id AS consultant_id,
         trim(concat(cu.first_name, ' ', cu.last_name)) AS consultant_name,
         cu.mobile AS consultant_mobile, cu.email AS consultant_email,
         d.name AS department_name,
         cr.id AS created_by_id,
         trim(concat(cr.first_name, ' ', cr.last_name)) AS created_by_name,
         cr.username AS created_by_username,
         COALESCE(CASE WHEN COALESCE(d.has_spare_parts, false) AND j.current_stage_no = d.spare_parts_stage_no THEN 'Spare Part Review & Order'
                       WHEN COALESCE(d.has_job_inspection, false) AND j.current_stage_no = d.job_inspection_stage_no THEN 'Vehicle Job Inspection'
                       WHEN COALESCE(d.has_job_check, false) AND j.current_stage_no = d.job_check_stage_no THEN 'Vehicle Job Inspection'
                       WHEN COALESCE(d.has_team_check, false) AND j.current_stage_no = d.team_check_stage_no THEN 'Team Self-Inspection'
                       WHEN COALESCE(d.has_drying_check, false) AND j.current_stage_no = d.drying_check_stage_no THEN 'Drying Area'
                       WHEN COALESCE(d.has_internal_check, false) AND j.current_stage_no = d.internal_check_stage_no THEN 'Internal Inspection 2'
                       WHEN COALESCE(d.has_dept_transfer, false) AND j.current_stage_no = d.dept_transfer_stage_no THEN 'Transfer to Other Departments'
                       WHEN COALESCE(d.has_handover_check, false) AND j.current_stage_no = d.handover_check_stage_no AND lower(d.name) = 'wash' THEN 'Delivery Arrangement'
                       WHEN COALESCE(d.has_wash_delivery, false) AND j.current_stage_no = d.wash_delivery_stage_no THEN 'Delivery Review'
                       WHEN COALESCE(d.has_free_inspection, false) AND j.current_stage_no = d.free_inspection_stage_no AND lower(d.name) = 'wash' THEN 'Free Inspection Schedule'
                       WHEN COALESCE(d.has_vehicle_evidence, false) AND j.current_stage_no = d.evidence_stage_no THEN 'Vehicle Evidence of Damages'
                       WHEN COALESCE(d.has_customer_approval, false) AND j.current_stage_no = d.customer_approval_stage_no THEN 'Customer Approval'
                       WHEN COALESCE(d.has_internal_inspection, false) AND j.current_stage_no = d.internal_inspection_stage_no THEN 'Internal Inspection - 1'
                       WHEN COALESCE(d.has_job_activation, false) AND j.current_stage_no = d.job_activation_stage_no THEN 'Job Activation'
                       WHEN COALESCE(d.has_damage_report, false) AND j.current_stage_no = d.damage_report_stage_no THEN 'Vehicle Damages Report' END, m.name) AS stage_name,
         jc.start_confirmed_at,
         trim(concat(sc.first_name, ' ', sc.last_name)) AS start_confirmed_by_name,
         (SELECT count(*)::int FROM job_stage_master) AS total_stages
       FROM job j
       JOIN customer c            ON c.id = j.customer_id
       LEFT JOIN job_complaint jc ON jc.job_id = j.id
       LEFT JOIN admin_user sc    ON sc.id = jc.start_confirmed_by
       LEFT JOIN customer_category cat ON cat.id = c.customer_category_id
       JOIN admin_user cu         ON cu.id = j.consultant_id
       LEFT JOIN department d     ON d.id = j.department_id
       LEFT JOIN department apd   ON apd.id = j.appointment_department_id
       LEFT JOIN admin_user cr    ON cr.id = j.created_by
       LEFT JOIN job_stage_master m ON m.stage_no = j.current_stage_no
       WHERE j.id = $1`,
      [jobId]
    );
    if (jobRes.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const r = jobRes.rows[0];
 
    // Timeline: every stage + who completed it
    const stagesRes = await pool.query(
      `SELECT
         s.stage_no                                     AS "stageNo",
         COALESCE(CASE WHEN COALESCE(d.has_spare_parts, false) AND s.stage_no = d.spare_parts_stage_no THEN 'Spare Part Review & Order'
                       WHEN COALESCE(d.has_job_inspection, false) AND s.stage_no = d.job_inspection_stage_no THEN 'Vehicle Job Inspection'
                       WHEN COALESCE(d.has_job_check, false) AND s.stage_no = d.job_check_stage_no THEN 'Vehicle Job Inspection'
                       WHEN COALESCE(d.has_team_check, false) AND s.stage_no = d.team_check_stage_no THEN 'Team Self-Inspection'
                       WHEN COALESCE(d.has_drying_check, false) AND s.stage_no = d.drying_check_stage_no THEN 'Drying Area'
                       WHEN COALESCE(d.has_internal_check, false) AND s.stage_no = d.internal_check_stage_no THEN 'Internal Inspection 2'
                       WHEN COALESCE(d.has_dept_transfer, false) AND s.stage_no = d.dept_transfer_stage_no THEN 'Transfer to Other Departments'
                       WHEN COALESCE(d.has_handover_check, false) AND s.stage_no = d.handover_check_stage_no AND lower(d.name) = 'wash' THEN 'Delivery Arrangement'
                       WHEN COALESCE(d.has_wash_delivery, false) AND s.stage_no = d.wash_delivery_stage_no THEN 'Delivery Review'
                       WHEN COALESCE(d.has_free_inspection, false) AND s.stage_no = d.free_inspection_stage_no AND lower(d.name) = 'wash' THEN 'Free Inspection Schedule'
                       WHEN COALESCE(d.has_vehicle_evidence, false) AND s.stage_no = d.evidence_stage_no THEN 'Vehicle Evidence of Damages'
                       WHEN COALESCE(d.has_customer_approval, false) AND s.stage_no = d.customer_approval_stage_no THEN 'Customer Approval'
                       WHEN COALESCE(d.has_internal_inspection, false) AND s.stage_no = d.internal_inspection_stage_no THEN 'Internal Inspection - 1'
                       WHEN COALESCE(d.has_job_activation, false) AND s.stage_no = d.job_activation_stage_no THEN 'Job Activation'
                       WHEN COALESCE(d.has_damage_report, false) AND s.stage_no = d.damage_report_stage_no THEN 'Vehicle Damages Report' END, m.name) AS "stageName",
         s.status,
         s.started_at                                   AS "startedAt",
         s.completed_at                                 AS "completedAt",
         trim(concat(u.first_name, ' ', u.last_name))   AS "completedByName",
         u.username                                     AS "completedByUsername",
         s.remarks
       FROM job_stage s
       JOIN job_stage_master m ON m.stage_no = s.stage_no
       JOIN job jj             ON jj.id = s.job_id
       LEFT JOIN department d  ON d.id = jj.department_id
       LEFT JOIN admin_user u  ON u.id = s.completed_by
       WHERE s.job_id = $1
       ORDER BY s.stage_no`,
      [jobId]
    );
 
    // Extra customer fields (birthday, group, source, referral code, points). Separate query: works even before the new SQL files are run.
    const extra = await pool.query(
      `SELECT c.birth_date::text AS "birthDate", g.name AS "groupName", s.name AS "sourceName",
              c.referral_code AS "referralCode", c.loyalty_points::float AS "loyaltyPoints", rb.customer_name AS "referredByName"
         FROM customer c
         LEFT JOIN customer_group g  ON g.id = c.customer_group_id
         LEFT JOIN customer_source s ON s.id = c.source_id
         LEFT JOIN customer rb       ON rb.id = c.referred_by_customer_id
        WHERE c.id = $1`, [r.customer_db_id]).then((x) => x.rows[0] || {}).catch(() => ({}));
 
    return res.json({
      job: {
        id: r.id,
        jobNo: r.job_no,
        status: r.status,
        stageNo: r.current_stage_no,
        stageName: r.stage_name,
        totalStages: r.total_stages,
        departmentName: r.department_name,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
      customer: {
        id: r.customer_db_id,
        customerId: r.erp_customer_id,
        name: r.customer_name,
        nic: r.nic_passport_no,
        companyName: r.company_name,
        contactNumber: r.contact_number,
        altContactNumber: r.alt_contact_number,
        email: r.email,
        profession: r.profession,
        categoryName: r.category_name,
        categoryApprovalStatus: r.category_hr_approval_status,
        categoryRemarks: r.category_hr_remarks,
        ...extra,
      },
      vehicle: {
        regNo: r.reg_no,
        year: r.year_of_manufacture,
        mileage: r.mileage_km,
        colour: r.colour,
        chassisNo: r.chassis_no,
        engineNo: r.engine_no,
        tyreSize: r.tyre_size,
        appointmentDate: r.appointment_date,
        appointmentTime: r.appointment_time,
        matter: r.customer_matter,
        salesOfficer: r.sales_officer,
        appointmentDepartment: r.appointment_department_name,
      },
      consultant: {
        id: r.consultant_id,
        name: r.consultant_name,
        mobile: r.consultant_mobile,
        email: r.consultant_email,
      },
      createdBy: r.created_by_id
        ? { id: r.created_by_id, name: r.created_by_name, username: r.created_by_username }
        : null,
      // Stage 4 A: initial start confirmed (Wash)
      jobStart: r.start_confirmed_at
        ? { confirmedAt: r.start_confirmed_at, confirmedByName: r.start_confirmed_by_name, departmentName: r.department_name }
        : null,
      stages: stagesRes.rows,
    });
  } catch (error) {
    console.error("Error loading job details:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
 
/* ------------------ GET /api/jobs/:id/stage-details  (View window: every stage, loaded only when the tab is opened) ------------------
   Each block is its own small query (all by job_id) and runs in parallel. A block whose table does not exist yet is just empty.
   -> { complaint, allocation, evidence, inspection, spare, estimate, internal, activation, damageReport } */
const safe = (p) => p.catch(() => ({ rows: [] }));
router.get("/jobs/:id/stage-details", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try { if (!(await canOpenJob(req, jobId))) return res.status(404).json({ message: "Job not found" }); }
  catch (e) { console.error("job scope:", e.message); return res.status(500).json({ message: "Server error" }); }
  try {
    const q = (sql) => safe(pool.query(sql, [jobId]));
    const [cmp, cmpOpts, team, bay, evFiles, evMeta, insp, inspItems, inspRepairs, inspFiles, spHdr, spParts, spQuotes, appr, intHdr, intItems, intChecks, intExtra, act, drep, drDam, drAgr] = await Promise.all([
      q(`SELECT jc.id, jc.complaint, jc.remarks, jc.vehicle_pass_issued AS "vehiclePassIssued", jc.initial_customer_approval AS "initialApproval",
                jc.start_confirmed_at AS "startConfirmedAt", jc.created_at AS "createdAt", trim(concat(u.first_name, ' ', u.last_name)) AS "recordedBy"
           FROM job_complaint jc LEFT JOIN admin_user u ON u.id = jc.recorded_by WHERE jc.job_id = $1`),
      q(`SELECT o.list_title AS "listTitle", o.concern_level AS "level", o.group_name AS "group", o.option_name AS name, o.price::float AS price
           FROM job_complaint_option o JOIN job_complaint jc ON jc.id = o.job_complaint_id WHERE jc.job_id = $1 ORDER BY o.id`),
      q(`SELECT team_name AS "teamName", bay_name AS "bayName", team_leader_name AS "leader", ppe_used AS "ppe", vehicle_protection_applied AS "protection", created_at AS "at" FROM job_team_allocation WHERE job_id = $1`),
      q(`SELECT bay_name AS "bayName", created_at AS "at" FROM job_bay_allocation WHERE job_id = $1`),
      q(`SELECT id, file_name AS name, file_url AS url, file_type AS type, category FROM job_evidence_file WHERE job_id = $1 ORDER BY id LIMIT 60`),
      q(`SELECT property_inside AS "propertyInside" FROM job_evidence WHERE job_id = $1`),
      q(`SELECT test_run AS "testRun", faults_found AS "faultsFound", previous_repair AS "previousRepair", new_repair AS "newRepair", warranty,
                history_remarks AS "historyRemarks", repair_types AS "repairTypes", signed_by_name AS "signedBy", signed_at AS "signedAt" FROM job_inspection WHERE job_id = $1`),
      q(`SELECT kind, description FROM job_inspection_item WHERE job_id = $1 ORDER BY kind, sort_order, id`),
      q(`SELECT description, repair_type AS "repairType", amount::float AS amount, COALESCE(qty, 1) AS qty, COALESCE(unit_price, amount / GREATEST(COALESCE(qty, 1), 1))::float AS "unitPrice", status, COALESCE(warranty_claim, false) AS "warrantyClaim" FROM job_repair_item WHERE job_id = $1 ORDER BY id`),
      q(`SELECT file_name AS name, file_url AS url, mime_type AS mime FROM job_inspection_file WHERE job_id = $1 ORDER BY id LIMIT 40`),
      q(`SELECT no_parts_needed AS "noParts", link_sent_at AS "linkSentAt", completed_at AS "completedAt" FROM job_spare_parts WHERE job_id = $1`),
      q(`SELECT id, name, brand, quality, qty, unit_price::float AS "unitPrice", stock_status AS "stock", price_source AS "source", COALESCE(warranty_claim, false) AS "warrantyClaim" FROM job_spare_part WHERE job_id = $1 ORDER BY id`),
      q(`SELECT description, quoted_price::float AS "quotedPrice" FROM job_spare_quote WHERE job_id = $1 ORDER BY id`),
      q(`SELECT est_hours::float AS "estHours", est_days::float AS "estDays", include_spare_parts AS "includeSpareParts", include_labour AS "includeLabour",
                manual_items AS "manualItems", wash_items AS "washItems", estimated_total::float AS "estimatedTotal", sent_via AS "sentVia", decision,
                agreed_scope AS "agreedScope", extra_note AS "extraNote", parts_by AS "partsBy", COALESCE(client_parts, '[]'::jsonb) AS "clientParts", repair_request_sent_at AS "repairRequestSentAt",
                third_party_request AS "thirdPartyRequest", third_party_note AS "thirdPartyNote", completed_at AS "completedAt"
           FROM job_customer_approval WHERE job_id = $1`),
      q(`SELECT notes, logistics_reminder_at AS "logisticsReminderAt", customer_reminder_at AS "customerReminderAt", completed_at AS "completedAt" FROM job_internal_inspection WHERE job_id = $1`),
      q(`SELECT i.id, i.section, i.label FROM internal_inspection_item i JOIN job j ON j.department_id = i.department_id AND j.id = $1 WHERE i.is_active ORDER BY i.section, i.sort_order, i.id`),
      q(`SELECT item_id AS "itemId" FROM job_internal_inspection_check WHERE job_id = $1`),
      q(`SELECT section, label, checked FROM job_internal_inspection_extra WHERE job_id = $1 ORDER BY id`),
      q(`SELECT a.activated_at AS "activatedAt", trim(concat(u.first_name, ' ', u.last_name)) AS "activatedBy"
           FROM job_activation a LEFT JOIN admin_user u ON u.id = a.activated_by WHERE a.job_id = $1`),
      q(`SELECT skipped, need_deep_check AS "needDeepCheck", need_repair AS "needRepair", customer_decision AS "decision", decided_at AS "decidedAt", customer_note AS "customerNote" FROM job_damage_report WHERE job_id = $1`),
      q(`SELECT description FROM job_damage_report_damage WHERE job_id = $1 ORDER BY sort_order, id`),
      q(`SELECT description, action FROM job_damage_report_agreed WHERE job_id = $1 ORDER BY sort_order, id`),
    ]);
 
    // Estimate (same rule as the Customer Approval stage): spare parts + labour + manual lines + wash
    const parts = spParts.rows, quotes = spQuotes.rows.filter((x) => x.quotedPrice != null);
    const sparePartsValue = parts.filter((x) => !x.warrantyClaim).reduce((t, x) => t + x.qty * x.unitPrice, 0) + quotes.reduce((t, x) => t + x.quotedPrice, 0);
    const labourTotal = inspRepairs.rows.filter((x) => x.status === "ACTIVE" && !x.warrantyClaim).reduce((t, x) => t + (x.amount || 0), 0);
    const a = appr.rows[0] || null;
    let estimate = null;
    if (a) {
      // by what the customer agreed: "Agreed scope only" counts only the ticked repair items; the spare parts the customer brings are not charged
      const own = (a.clientParts || []).map(Number);
      const labLines = inspRepairs.rows.filter((x) => x.status === "ACTIVE" && !x.warrantyClaim && (a.decision !== "PARTIAL" || (a.agreedScope || []).includes(x.repairType || x.description)));
      const partLines = parts.filter((x) => !x.warrantyClaim && !(a.partsBy === "CLIENT" && own.includes(Number(x.id))));
      const spare = a.includeSpareParts ? partLines.reduce((t, x) => t + x.qty * x.unitPrice, 0) + quotes.reduce((t, x) => t + x.quotedPrice, 0) : 0;
      const labour = a.includeLabour ? labLines.reduce((t, x) => t + (x.amount || 0), 0) : 0;
      const manual = (a.manualItems || []).reduce((t, m) => t + (Number(m.amount) || 0), 0);
      const wash = (a.washItems || []).reduce((t, w) => t + (Number(w.price) || 0), 0);
      const mk = await pool.query("SELECT COALESCE(price_markup_percent, 0)::float AS p FROM job WHERE id = $1", [jobId]).catch(() => ({ rows: [] }));
      const markupPercent = mk.rows[0]?.p || 0;
      // the % is added to the UNIT PRICE of each line: markup of a line = qty x (unit price + % - unit price)
      const lineAdj = (q, u) => Math.round((Number(q) || 0) * (Math.round((Number(u) || 0) * (100 + markupPercent)) / 100 - (Number(u) || 0)) * 100) / 100;
      const markup = Math.round((
        (a.includeSpareParts ? partLines.reduce((s, x) => s + lineAdj(x.qty, x.unitPrice), 0) + quotes.reduce((s, x) => s + lineAdj(1, x.quotedPrice), 0) : 0)
        + (a.includeLabour ? labLines.reduce((s, x) => s + lineAdj(x.qty || 1, x.unitPrice ?? x.amount), 0) : 0)
        + (a.manualItems || []).reduce((s, m) => s + lineAdj(1, m.amount), 0)
      ) * 100) / 100;
      estimate = { ...a, spare, labour, manual, wash, markup, markupPercent, total: Math.round((spare + labour + manual + markup + wash) * 100) / 100 };
    }
    const checked = new Set(intChecks.rows.map((x) => x.itemId));
    return res.json({
      complaint: cmp.rows[0] ? { ...cmp.rows[0], options: cmpOpts.rows } : null,
      allocation: team.rows[0] ? { type: "TEAM", ...team.rows[0] } : bay.rows[0] ? { type: "BAY", ...bay.rows[0] } : null,
      evidence: { files: evFiles.rows, propertyInside: evMeta.rows[0]?.propertyInside ?? null },
      inspection: insp.rows[0] || inspItems.rows.length || inspRepairs.rows.length
        ? { ...(insp.rows[0] || {}), items: inspItems.rows, repairs: inspRepairs.rows, files: inspFiles.rows } : null,
      spare: spHdr.rows[0] || parts.length || quotes.length
        ? { ...(spHdr.rows[0] || {}), parts, quotes, value: Math.round(sparePartsValue * 100) / 100 } : null,
      estimate,
      internal: intHdr.rows[0] || intChecks.rows.length
        ? { ...(intHdr.rows[0] || {}), items: intItems.rows.map((x) => ({ ...x, checked: checked.has(x.id) })), extras: intExtra.rows } : null,
      activation: act.rows[0] || null,
      damageReport: drep.rows[0] ? { ...drep.rows[0], damages: drDam.rows.map((x) => x.description), agreed: drAgr.rows } : null,
    });
  } catch (error) {
    console.error("Error loading stage details:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ------------------ GET /api/jobs/:id/history  (View window: previous jobs of this customer / vehicle) ------------------
   -> { sameVehicle: [...], other: [...], lastJob: {...} | null }  (newest first, 25 rows max, only light columns) */
router.get("/jobs/:id/history", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try { if (!(await canOpenJob(req, jobId))) return res.status(404).json({ message: "Job not found" }); }
  catch (e) { console.error("job scope:", e.message); return res.status(500).json({ message: "Server error" }); }
  try {
    const cur = await pool.query("SELECT customer_id, reg_no, created_at FROM job WHERE id = $1", [jobId]);
    if (cur.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const { customer_id, reg_no } = cur.rows[0];
    const rows = await pool.query(
      `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo", m.name AS "stageName",
              d.name AS "departmentName", j.created_at AS "createdAt", j.mileage_km AS mileage,
              ca.estimated_total::float AS "estimatedTotal", ca.decision,
              jc.complaint,
              (lower(replace(j.reg_no, ' ', '')) = lower(replace($3::text, ' ', ''))) AS "sameVehicle"
         FROM job j
         LEFT JOIN job_stage_master m ON m.stage_no = j.current_stage_no
         LEFT JOIN department d       ON d.id = j.department_id
         LEFT JOIN job_customer_approval ca ON ca.job_id = j.id
         LEFT JOIN job_complaint jc   ON jc.job_id = j.id
        WHERE j.customer_id = $1 AND j.id <> $2
        ORDER BY j.id DESC LIMIT 25`, [customer_id, jobId, reg_no]).catch(async () => {
      // estimate / complaint tables missing: plain list
      return pool.query(
        `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo", m.name AS "stageName",
                d.name AS "departmentName", j.created_at AS "createdAt", j.mileage_km AS mileage,
                (lower(replace(j.reg_no, ' ', '')) = lower(replace($3::text, ' ', ''))) AS "sameVehicle"
           FROM job j LEFT JOIN job_stage_master m ON m.stage_no = j.current_stage_no LEFT JOIN department d ON d.id = j.department_id
          WHERE j.customer_id = $1 AND j.id <> $2 ORDER BY j.id DESC LIMIT 25`, [customer_id, jobId, reg_no]);
    });
    const all = rows.rows;
    const sameVehicle = all.filter((x) => x.sameVehicle);
    return res.json({ sameVehicle, other: all.filter((x) => !x.sameVehicle), lastJob: sameVehicle[0] || all[0] || null });
  } catch (error) {
    console.error("Error loading job history:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
module.exports = router;
 