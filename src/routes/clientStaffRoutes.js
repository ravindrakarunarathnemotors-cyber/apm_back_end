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

const S3Service = require('./s3Service');

dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();


router.get("/client-staff", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT admin_user.*, admin_role.role_name
      FROM admin_user
      JOIN admin_role ON admin_user.role_id = admin_role.id
      ORDER BY admin_user.id DESC
    `);

    console.log("rowsclients", result.rows);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/adduser", authenticateToken, async (req, res) => {
  console.log("Received Request Body:", req.body);

  try {
    const {
      firstName, lastName, email, phone, password,
      role, username, nic, branch, user_id,
    } = req.body;

    // Required fields
    if (!firstName || !lastName || !email || !phone || !password || !role || !username || !nic) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // NIC validate (old: 9 digits + V/X, new: 12 digits)
    const nicClean = String(nic).trim().toUpperCase();
    if (!/^(\d{9}[VX]|\d{12})$/.test(nicClean)) {
      return res.status(400).json({ message: "Invalid NIC" });
    }

    // Logged-in (creator) user ge role & branch DB eken gannawa
    const creatorRes = await pool.query(
      "SELECT role_id, branch_id FROM admin_user WHERE id = $1",
      [user_id]
    );
    if (creatorRes.rows.length === 0) {
      return res.status(401).json({ message: "Invalid creator user" });
    }
    const creator = creatorRes.rows[0];

    // Admin (role_id = 1) nam body eke branch eka, anith ayata ayage branch eka
    let branchId;
    if (Number(creator.role_id) === 1) {
      branchId = parseInt(branch, 10);
    } else {
      branchId = parseInt(creator.branch_id, 10);
    }

    if (!Number.isInteger(branchId) || branchId <= 0) {
      return res.status(400).json({ message: "Valid branch is required" });
    }

    // Branch eka thiyenawada / active da
    const branchCheck = await pool.query(
      "SELECT branch_id FROM service_branches WHERE branch_id = $1 AND is_active = true",
      [branchId]
    );
    if (branchCheck.rows.length === 0) {
      return res.status(400).json({ message: "Selected branch not found or inactive" });
    }

    // Phone format
    const mobileNew = formatPhoneNumber(phone);
    if (mobileNew.error) {
      return res.status(400).json({ message: mobileNew.error });
    }
    const formattedPhone = mobileNew.formatted;

    // Username duplicate
    const userNameCheck = await pool.query(
      "SELECT id FROM admin_user WHERE username = $1",
      [username]
    );
    if (userNameCheck.rows.length > 0) {
      return res.status(409).json({ message: "Username already exists" });
    }

    // NIC duplicate
    const nicCheck = await pool.query(
      "SELECT id FROM admin_user WHERE nic = $1",
      [nicClean]
    );
    if (nicCheck.rows.length > 0) {
      return res.status(409).json({ message: "NIC already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const status = "Active";

    const result = await pool.query(
      `INSERT INTO admin_user
        (first_name, last_name, username, email, mobile, password, role_id, status, nic, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, first_name, last_name, username, email, mobile, role_id, status, nic, branch_id`,
      [
        firstName, lastName, username, email, formattedPhone,
        hashedPassword, parseInt(role, 10), status, nicClean, branchId,
      ]
    );

    res.status(201).json({ message: "User added successfully", user: result.rows[0] });
  } catch (error) {
    console.error("Error adding user:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/addrole", authenticateToken, async (req, res) => {
  const user = req.user
  const user_id = user.user_id
  try {
    const { roleName, privileges, dashboardAccess, client_id } = req.body;

    console.log(req.body);

    const status = "active";
    const createdAt = new Date();


    const result = await pool.query(
      "INSERT INTO admin_role (role_name, date, status, privileges, dashboard_access,user_id) VALUES ($1, $2, $3, $4::TEXT[], $5::TEXT[],$6) RETURNING *",
      [roleName, createdAt, status, privileges, dashboardAccess, user_id]
    );

    res.status(201).json({ message: "Role added successfully", role: result.rows[0] });
  } catch (error) {
    console.error("Error adding role:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/sidebar", authenticateToken, async (req, res) => {
  try {
    const { roleid } = req.body;


    const roleResult = await pool.query(
      "SELECT privileges, dashboard_access FROM admin_role WHERE id = $1",
      [roleid]
    );

    if (roleResult.rows.length === 0) {
      return res.status(404).json({ message: "Role not found" });
    }

    const privileges = roleResult.rows[0].privileges;
    // const privileges = [15,53, 119, 118, 17]

    const dashboardAccess = roleResult.rows[0].dashboard_access;

    const menuQuery = `SELECT json_agg(
            json_build_object(
                'menu_id', t.id,
                'name', t.name,
                'route', t.route,
                'parent_id', t.parent_id,
                'children', COALESCE((
                    SELECT json_agg(
                        json_build_object(
                            'menu_id', s.id,
                            'name', s.name,
                            'route', s.route,
                            'parent_id', s.parent_id,
                            'icon', s.icon,
                            'children', COALESCE((
                                SELECT json_agg(
                                    json_build_object(
                                        'menu_id', c.id,
                                        'name', c.name,
                                        'route', c.route,
                                        'parent_id', c.parent_id
                                    ) ORDER BY c.order_index
                                )
                                FROM admin_uimenudata c
                                WHERE c.parent_id = s.id
                                AND c.status = 'active'
                                AND c.id = ANY($1)
                            ), '[]'::json)
                        ) ORDER BY s.order_index
                    )
                    FROM admin_uimenudata s
                    WHERE s.parent_id = t.id
                    AND s.status = 'active'
                    AND s.id = ANY($1)
                ), '[]'::json)
            ) ORDER BY t.order_index
        ) AS menu
        FROM admin_uimenudata t
        WHERE t.parent_id IS NULL AND t.status = 'active' AND t.id = ANY($1)`

    const mainQuery = `SELECT id as menu_id, name, route, parent_id, icon FROM admin_uimenudata WHERE parent_id = 0 AND status = 'active' AND id = ANY($1) ORDER BY order_index`


    const [menuResult, mainResult] = await Promise.all([
      pool.query(menuQuery, [privileges]),
      pool.query(mainQuery, [privileges])
    ])



    let menuItems = menuResult.rows[0].menu;


    if (dashboardAccess && dashboardAccess.length > 0) {
      const dashboardItems = await pool.query(
        "SELECT * FROM admin_uimenudata WHERE privilege_id = ANY($1)",
        [dashboardAccess]
      );


      menuItems = [...dashboardItems.rows, ...menuItems];
    }

    return res.status(200).json({ message: "Success", menu: menuItems, main: mainResult.rows });
  } catch (error) {
    console.error("Error fetching sidebar menu:", error);
    res.status(500).json({ message: "Server error" });
  }
});


router.post("/get-user-details", authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "Client ID is required" });
    }

    const clientQuery = await pool.query(
      `SELECT admin_user.*, admin_role.role_name
       FROM admin_user 
       LEFT JOIN admin_role ON admin_role.id::INTEGER = admin_user.role_id
       WHERE admin_user.id = $1`,
      [user_id]
    );

    if (clientQuery.rows.length === 0) {
      return res.status(404).json({ message: "Client not found" });
    }

    res.json(clientQuery.rows[0]);
  } catch (error) {
    console.error("Error fetching client details:", error);
    res.status(500).json({ message: "Server error" });
  }
});


router.get("/sidebar-items", authenticateToken, async (req, res) => {
  try {

    const query = `
      SELECT json_agg(
    json_build_object(
        'menu_id', t.id,
        'name', t.name,
        'route', t.route,
        'parent_id', t.parent_id,
        'children', COALESCE((
            SELECT json_agg(
                json_build_object(
                    'menu_id', s.id,
                    'name', s.name,
                    'route', s.route,
                    'parent_id', s.parent_id,
                    'icon', s.icon,
                    'children', COALESCE((
                        SELECT json_agg(
                            json_build_object(
                                'menu_id', c.id,
                                'name', c.name,
                                'route', c.route,
                                'parent_id', c.parent_id
                            ) ORDER BY c.order_index
                        )
                        FROM admin_uimenudata c
                        WHERE c.parent_id = s.id
                        AND c.status = 'active'
                    ), '[]'::json)
                ) ORDER BY s.order_index
            )
            FROM admin_uimenudata s
            WHERE s.parent_id = t.id
            AND s.status = 'active'
        ), '[]'::json)
    ) ORDER BY t.order_index
) AS menu
FROM admin_uimenudata t
WHERE t.parent_id IS NULL AND t.status = 'active'
      `


    const otherQuery = `SELECT id, name FROM admin_uimenudata WHERE parent_id = 0 AND status = 'active'`

    const [menuItemsResult, otherResult] = await Promise.all([
      pool.query(query),
      pool.query(otherQuery)
    ])

    const menuItems = menuItemsResult.rows[0].menu;




    // const menuMap = {};
    // const sidebarOptions = [];

    // menuItems.forEach((item) => {
    //   menuMap[item.id] = { ...item, subcategories: [] };
    // });

    // menuItems.forEach((item) => {
    //   if (item.parent_id) {
    //     menuMap[item.parent_id]?.subcategories.push(menuMap[item.id]);
    //   } else {
    //     sidebarOptions.push(menuMap[item.id]);
    //   }
    // });

    res.json({ message: "Sidebar items fetched successfully", menuItems, menuItems, otherResult: otherResult.rows });
  } catch (error) {
    console.error("Error fetching sidebar menu:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/get-roles", authenticateToken, async (req, res) => {

  const { client_id } = req.body

  try {
    const result = await pool.query(
      "SELECT id, role_name,status,privileges FROM admin_role WHERE status ='active' ORDER BY id DESC",

    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching roles:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/get-branches", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT branch_id, branch_code, branch_name
       FROM service_branches
       WHERE is_active = true
       ORDER BY branch_name ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching branches:", error);
    res.status(500).json({ message: "Server error" });
  }
});


router.post("/get-role-table", authenticateToken, async (req, res) => {
  let { client_id, search = '', page = 1, limit = 25 } = req.body;

  // Validate client_id before converting
  if (!client_id || isNaN(client_id)) {
    console.error("Invalid client_id received:", client_id);
    return res.status(400).json({ message: "Invalid client_id" });
  }

  const clientIdNumber = parseInt(client_id, 10);

  if (isNaN(clientIdNumber)) {
    console.error("clientIdNumber is NaN after parsing:", client_id);
    return res.status(400).json({ message: "Invalid client_id format" });
  }

  console.log("clientIdNumber:", clientIdNumber);

  const offset = (page - 1) * limit;

  try {
    let query = `SELECT id, role_name, status, privileges FROM admin_role`;
    let queryParams = [];

    if (search) {
      query += ` WHERE role_name ILIKE $1 OR id::text ILIKE $1`;
      queryParams.push(`%${search}%`);
    }

    query += ` ORDER BY id DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);

    const result = await pool.query(query, queryParams);

    let countQuery = `SELECT COUNT(*) FROM admin_role`;
    let countParams = [];

    if (search) {
      countQuery += ` WHERE role_name ILIKE $1 OR id::text ILIKE $1`;
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countQuery, countParams);
    const totalRoles = parseInt(countResult.rows[0].count, 10);

    res.json({
      roles: result.rows,
      totalRoles,
      totalPages: Math.ceil(totalRoles / limit),
      currentPage: page,
    });
  } catch (error) {
    console.error("Error fetching roles:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/check-username", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ message: "Username is required" });
  }

  try {
    const result = await pool.query("SELECT COUNT(*) FROM admin_user WHERE username = $1", [username]);
    const usernameExists = parseInt(result.rows[0].count) > 0;

    return res.json({ exists: usernameExists });
  } catch (error) {
    console.error("Error checking username:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/client-username", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ message: "Username is required" });
  }

  try {
    const result = await pool.query("SELECT COUNT(*) FROM client_staff WHERE username = $1", [username]);
    const usernameExists = parseInt(result.rows[0].count) > 0;

    return res.json({ exists: usernameExists });
  } catch (error) {
    console.error("Error checking username:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/update-role-status", authenticateToken, async (req, res) => {

  const { roleId, status } = req.body;

  try {
    const result = await pool.query(
      "UPDATE admin_role SET status = $1 WHERE id = $2 RETURNING *",
      [status, roleId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Role not found" });
    }

    res.json({ message: "Role status updated successfully", role: result.rows[0] });
  } catch (error) {
    console.error("Error updating role status:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/update-role-privileges", authenticateToken, async (req, res) => {
  const { roleId, privileges } = req.body;

  if (!roleId || !Array.isArray(privileges) || privileges.length === 0) {
    return res.status(400).json({ message: "Invalid request data" });
  }

  try {
    // Sort privileges in ascending order (Min → Max)
    const sortedPrivileges = privileges.sort((a, b) => a - b);

    // Convert sorted array to PostgreSQL array format {3,6,7,8}
    const formattedPrivileges = `{${sortedPrivileges.join(",")}}`;

    // Update the privileges column in role_list table
    const result = await pool.query(
      "UPDATE admin_role SET privileges = $1 WHERE id = $2 RETURNING *",
      [formattedPrivileges, roleId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Role not found" });
    }

    res.json({ message: "Role privileges updated successfully", role: result.rows[0] });
  } catch (error) {
    console.error("Error updating role privileges:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/get-role-privileges", authenticateToken, async (req, res) => {
  const { roleId } = req.body;

  try {
    // Query to fetch privileges and dashboard access for the role
    const roleQuery = await pool.query(
      "SELECT privileges, dashboard_access FROM admin_role WHERE id = $1",
      [roleId]
    );

    if (roleQuery.rowCount === 0) {
      return res.status(404).json({ message: "Role not found" });
    }

    // Extract privileges and dashboard access from role
    const { privileges = [], dashboard_access = [] } = roleQuery.rows[0];

    console.log("Privileges IDs Array:", privileges);

    // Fetch all privilege data from uimenudata
    const privilegeQuery = await pool.query(
      `SELECT id, parent_id, name, route, icon, privilege_id, order_index FROM admin_uimenudata ORDER BY privilege_id DESC`
    );

    if (privilegeQuery.rowCount === 0) {
      return res.json({ privileges: [], dashboardAccess: dashboard_access });
    }

    // Function to build a hierarchy of privileges
    const buildHierarchy = (parentId) => {
      // Find all children (subcategories) for the given parentId
      return privilegeQuery.rows
        .filter(row => row.parent_id === parentId)
        .map(row => ({
          ...row,
          // Recursively add subcategories if any
          subcategories: buildHierarchy(row.id),
          assigned: privileges.includes(row.id.toString()) // Mark privilege as assigned if in role's privileges
        }));
    };

    // Get top-level privileges (parent components) and mark their assigned status
    const topLevelPrivileges = buildHierarchy(null);

    console.log("Structured Privileges with Subcategories:", topLevelPrivileges);

    // Return the structured data with assigned/unassigned status
    res.json({ privileges: topLevelPrivileges, dashboardAccess: dashboard_access });

  } catch (error) {
    console.error("Error fetching role privileges:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/edit-user", authenticateToken, async (req, res) => {
  const {
    first_name, last_name, email, mobile, nic,
    selected_userId, user_id,
    newPassword, confirmPassword,
    selectedRole, selectedBranch, selectedHub, // selectedHub = frontend eka wenas nokale nam
  } = req.body;

  try {
    // ---------- Case 1: Password update ----------
    if (newPassword && confirmPassword) {
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ message: "Passwords do not match" });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);

      const result = await pool.query(
        `UPDATE admin_user
         SET password = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING id`,
        [hashedPassword, selected_userId]
      );

      if (result.rows.length > 0) {
        return res.status(200).json({ message: "Password updated successfully" });
      }
      return res.status(404).json({ message: "User not found" });
    }

    // ---------- Case 2: User details update ----------
    const mobileNew = formatPhoneNumber(mobile);
    if (mobileNew.error) {
      return res.status(400).json({ message: mobileNew.error });
    }
    const formattedPhone = mobileNew.formatted;

    // Edit karana user (creator) ge role DB eken
    const creatorRes = await pool.query(
      "SELECT role_id FROM admin_user WHERE id = $1",
      [user_id]
    );
    if (creatorRes.rows.length === 0) {
      return res.status(401).json({ message: "Invalid user" });
    }
    const isAdmin = Number(creatorRes.rows[0].role_id) === 1;

    // Edit wenna yana user ge dan thiyena data
    const targetRes = await pool.query(
      "SELECT branch_id, nic FROM admin_user WHERE id = $1",
      [selected_userId]
    );
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    const target = targetRes.rows[0];

    // Branch: admin nam aluth eka, anith ayata wenas karanna denne naha
    let branchId = target.branch_id;
    if (isAdmin) {
      const requestedBranch = parseInt(selectedBranch ?? selectedHub, 10);
      if (Number.isInteger(requestedBranch) && requestedBranch > 0) {
        const branchCheck = await pool.query(
          "SELECT branch_id FROM service_branches WHERE branch_id = $1 AND is_active = true",
          [requestedBranch]
        );
        if (branchCheck.rows.length === 0) {
          return res.status(400).json({ message: "Selected branch not found or inactive" });
        }
        branchId = requestedBranch;
      }
    }

    // NIC: dunnoth validate + duplicate check, nathnam thiyena eka thiyenawa
    let nicValue = target.nic;
    if (nic && String(nic).trim() !== "") {
      const nicClean = String(nic).trim().toUpperCase();
      if (!/^(\d{9}[VX]|\d{12})$/.test(nicClean)) {
        return res.status(400).json({ message: "Invalid NIC" });
      }
      const nicCheck = await pool.query(
        "SELECT id FROM admin_user WHERE nic = $1 AND id <> $2",
        [nicClean, selected_userId]
      );
      if (nicCheck.rows.length > 0) {
        return res.status(409).json({ message: "NIC already exists" });
      }
      nicValue = nicClean;
    }

    const result = await pool.query(
      `UPDATE admin_user
       SET first_name = $1,
           last_name  = $2,
           email      = $3,
           mobile     = $4,
           role_id    = $5,
           branch_id  = $6,
           nic        = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8
       RETURNING id, first_name, last_name, username, email, mobile, role_id, status, nic, branch_id`,
      [
        first_name, last_name, email, formattedPhone,
        parseInt(selectedRole, 10), branchId, nicValue,
        selected_userId,
      ]
    );

    if (result.rows.length > 0) {
      return res.status(200).json({
        message: "User details updated successfully",
        user: result.rows[0],
      });
    }
    return res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error("Error updating user details:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/get-user-logs", authenticateToken, async (req, res) => {
  const { user_id, fromDate, toDate, page = 1, limit = 25, skip = 0 } = req.body;
  const offset = skip;

  try {
    // Base query for fetching logs (NO client_id filter)
    let query = `
      SELECT 
        cl.id, 
        cl.date, 
        cl.user_id, 
        cs.first_name AS user_name,  -- Fetch user's first name
        cl.client_id,  -- Include client_id in result
        cl.module, 
        cl.log 
      FROM client_log cl
      LEFT JOIN client_staff cs ON cl.user_id = cs.id  -- Join with client_staff table
      WHERE 1 = 1  -- Always true condition for dynamic filters
    `;

    let queryParams = [];

    // Apply optional filters
    if (user_id) {
      query += ` AND cl.user_id = $${queryParams.length + 1}`;
      queryParams.push(user_id);
    }
    if (fromDate) {
      query += ` AND cl.date >= $${queryParams.length + 1}`;
      queryParams.push(fromDate);
    }
    if (toDate) {
      query += ` AND cl.date <= $${queryParams.length + 1}`;
      queryParams.push(toDate);
    }

    // Apply pagination
    query += ` ORDER BY cl.id DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);

    // Execute the query
    const result = await pool.query(query, queryParams);

    // Enhanced count query to fetch total logs count
    let countQuery = `
      SELECT COUNT(*) FROM client_log cl
      WHERE 1 = 1
    `;
    let countQueryParams = [];

    if (user_id) {
      countQuery += ` AND cl.user_id = $${countQueryParams.length + 1}`;
      countQueryParams.push(user_id);
    }
    if (fromDate) {
      countQuery += ` AND cl.date >= $${countQueryParams.length + 1}`;
      countQueryParams.push(fromDate);
    }
    if (toDate) {
      countQuery += ` AND cl.date <= $${countQueryParams.length + 1}`;
      countQueryParams.push(toDate);
    }

    // Execute the count query
    const countResult = await pool.query(countQuery, countQueryParams);
    const totalLogs = parseInt(countResult.rows[0].count, 10);

    // Send the response
    res.json({
      logs: result.rows,
      totalLogs,
      totalPages: Math.ceil(totalLogs / limit),
      currentPage: page,
    });
  } catch (error) {
    console.error("Error fetching all user logs:", error);
    res.status(500).json({ message: "Server error" });
  }
});

 


 
// The logged-in system user (admin_user.id) taken from the JWT set by authenticateToken.
// Change "user_id" here if your token payload uses another key.
const currentUserId = (req) => {
  const n = Number(req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) ? n : null;
};
 
const PHONE_RE = /^\d{10,11}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
 
// Values for customer.category_hr_approval_status.
// CHECK your constraint and adjust if needed:
//   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname LIKE '%approval%';
const APPROVAL = {
  PENDING: "PENDING",    // category selected / switched -> waits for HR D. approval
  APPROVED: "APPROVED",  // approved by HR D. -> cannot be changed from the registration form
};
 
/* ----------------------------- helpers ----------------------------- */
 
// "" / undefined / null -> null, otherwise trimmed string
const clean = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
 
// "" -> null, "2018" -> 2018, "abc" -> NaN
const toInt = (v) => {
  const s = clean(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
};
 
function validateCustomer(b) {
  if (!clean(b.customerName)) return "Customer name is required";
  if (!PHONE_RE.test(String(b.contactNumber ?? "").trim())) return "Contact number must be 10 or 11 digits";
 
  const alt = clean(b.altContactNumber);
  if (alt && !PHONE_RE.test(alt)) return "WhatsApp number must be 10 or 11 digits";
 
  const email = clean(b.email);
  if (email && !EMAIL_RE.test(email)) return "Invalid email";
 
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
           updated_at = CURRENT_TIMESTAMP
         WHERE erp_customer_id = $10
         RETURNING id, erp_customer_id, category_hr_approval_status`,
        [...fields, newCategoryId, newStatus, existingErpId, hrRemarks]
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
            category_hr_remarks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, erp_customer_id, category_hr_approval_status`,
        [newId, erpId, ...fields, requestedCategoryId, APPROVAL.PENDING, hrRemarks]
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
       GROUP BY c.id, cat.id
       ORDER BY c.customer_name`,
      [like, likeReg]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("Error searching customers:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
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
    return res.status(201).json({ message: "Job started successfully", jobs });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error creating job:", error);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});
 
/* ------------------ GET /api/jobs (Jobs table) ------------------ */
// Optional filter: GET /api/jobs?department=Mechanical  (used by the department dashboards)
router.get("/jobs", authenticateToken, async (req, res) => {
  const department = clean(req.query.department);
  try {
    const result = await pool.query(
      `SELECT
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
         jc.start_confirmed_at                           AS "startedAt",
         trim(concat(sc.first_name, ' ', sc.last_name))  AS "startedByName",
         j.current_stage_no                              AS "stageNo",
         COALESCE(CASE WHEN COALESCE(d.has_spare_parts, false) AND j.current_stage_no = d.spare_parts_stage_no THEN 'Spare Part Review & Order'
                       WHEN COALESCE(d.has_job_inspection, false) AND j.current_stage_no = d.job_inspection_stage_no THEN 'Vehicle Job Inspection'
                       WHEN COALESCE(d.has_vehicle_evidence, false) AND j.current_stage_no = d.evidence_stage_no THEN 'Vehicle Evidence of Damages'
                       WHEN COALESCE(d.has_damage_report, false) AND j.current_stage_no = d.damage_report_stage_no THEN 'Vehicle Damages Report' END, m.name)  AS "stageName",
         j.status,
         j.created_at                                    AS "createdAt",
         j.updated_at                                    AS "updatedAt",
         j.appointment_date::text                        AS "appointmentDate",
         left(j.appointment_time::text, 5)               AS "appointmentTime",
         j.customer_matter                               AS "customerMatter",
         (SELECT s.started_at FROM job_stage s
           WHERE s.job_id = j.id AND s.stage_no = j.current_stage_no) AS "stageStartedAt",
         (SELECT count(*)::int FROM job_stage_master)    AS "totalStages",
         (SELECT count(*)::int FROM job_stage s
           WHERE s.job_id = j.id AND s.status = 'COMPLETED') AS "completedStages"
       FROM job j
       JOIN customer c   ON c.id = j.customer_id
       JOIN admin_user u ON u.id = j.consultant_id
       LEFT JOIN job_stage_master m ON m.stage_no = j.current_stage_no
       LEFT JOIN department d ON d.id = j.department_id
       LEFT JOIN job_complaint jc ON jc.job_id = j.id
       LEFT JOIN admin_user sc ON sc.id = jc.start_confirmed_by
       WHERE ($1::text IS NULL OR lower(d.name) = lower($1::text))
       ORDER BY j.id DESC
       LIMIT 200`,
      [department]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("Error loading jobs:", error);
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
 
  try {
    const jobRes = await pool.query(
      `SELECT
         j.id, j.job_no, j.status, j.current_stage_no, j.created_at, j.updated_at,
         j.reg_no, j.year_of_manufacture, j.mileage_km, j.colour, j.chassis_no, j.engine_no, j.tyre_size,
         j.appointment_date::text AS appointment_date,
         left(j.appointment_time::text, 5) AS appointment_time,
         j.customer_matter,
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
                       WHEN COALESCE(d.has_vehicle_evidence, false) AND j.current_stage_no = d.evidence_stage_no THEN 'Vehicle Evidence of Damages'
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
                       WHEN COALESCE(d.has_vehicle_evidence, false) AND s.stage_no = d.evidence_stage_no THEN 'Vehicle Evidence of Damages'
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
 
module.exports = router;
 