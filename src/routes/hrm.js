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

/* ----------------------------- helpers ----------------------------- */
const currentUserId = (req) => {
  const n = Number(req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) ? n : null;
};
const clean = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const toInt = (v) => {
  const s = clean(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
};

// role_id of the administrator (can choose the branch of a new employee). Everyone else always gets their OWN branch.
const ADMIN_ROLE_ID = 1;

// The logged-in user: role + branch (from admin_user)
async function loadMe(db, userId) {
  if (!userId) return { isAdmin: false, branchId: null };
  const r = await db.query("SELECT role_id, branch_id FROM admin_user WHERE id = $1", [userId]);
  if (r.rowCount === 0) return { isAdmin: false, branchId: null };
  return { isAdmin: Number(r.rows[0].role_id) === ADMIN_ROLE_ID, branchId: r.rows[0].branch_id };
}

const SALUTATIONS = ["Mr", "Mrs", "Ms", "Miss", "Dr", "Rev"];
const GENDERS = ["Male", "Female", "Other"];
const STATUSES = ["Active", "Probation", "Resigned"];
const PHONE_RE = /^\d{10,11}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NIC_RE = /^(\d{9}[VvXx]|\d{12})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s));

// The id the next employee will get (shown read-only in the form).
// Two people saving at the same moment could still swap ids, the saved record always has the real one.
async function nextEmployeeNo() {
  const name = (await pool.query("SELECT pg_get_serial_sequence('employee', 'id') AS name")).rows[0].name;
  if (!name || !/^[\w."]+$/.test(name)) return null;
  const r = await pool.query(`SELECT last_value, is_called FROM ${name}`);
  const next = r.rows[0].is_called ? Number(r.rows[0].last_value) + 1 : Number(r.rows[0].last_value);
  return `EMP-${String(next).padStart(4, "0")}`;
}

/* ------------- GET /api/employee-form-options (dropdowns of the form) ------------- */
router.get("/employee-form-options", authenticateToken, async (req, res) => {
  try {
    const me = await loadMe(pool, currentUserId(req));

    const [designations, departments, branches, employees] = await Promise.all([
      pool.query("SELECT id, name FROM designation WHERE is_active ORDER BY name"),
      pool.query("SELECT id, name FROM department WHERE is_active ORDER BY sort_order, id"),
      pool.query("SELECT branch_id AS id, branch_name AS name FROM service_branches WHERE is_active ORDER BY branch_name"),
      pool.query(
        `SELECT id, employee_no AS "employeeNo", full_name AS name
         FROM employee WHERE status <> 'Resigned' ORDER BY full_name`
      ),
    ]);

    return res.json({
      salutations: SALUTATIONS,
      genders: GENDERS,
      designations: designations.rows,
      departments: departments.rows,
      branches: branches.rows,
      // the logged-in user's own branch (used automatically when the user is not an administrator)
      myBranch: branches.rows.find((x) => x.id === me.branchId) || null,
      canSelectBranch: me.isAdmin,
      reportingCandidates: employees.rows,
      // The Employee ID is NOT typed by the user. It is built from the table id, e.g. id 7 -> EMP-0007.
      nextEmployeeNo: await nextEmployeeNo(),
    });
  } catch (error) {
    console.error("Error loading employee form options:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

/* ------------- GET /api/employees (Employees tab) ------------- */
router.get("/employees", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         e.id                       AS "dbId",
         e.employee_no              AS "id",
         e.salutation,
         e.full_name                AS "name",
         e.email,
         e.nic,
         e.date_of_birth::text      AS "dob",
         e.gender,
         e.mobile,
         e.alt_mobile               AS "altMobile",
         e.address,
         e.about,
         e.designation_id           AS "designationId",
         dg.name                    AS "designation",
         e.department_id            AS "departmentId",
         dp.name                    AS "department",
         e.branch_id                AS "branchId",
         sb.branch_name             AS "branchName",
         e.joining_date::text       AS "joined",
         e.reporting_to             AS "reportingToId",
         rp.full_name               AS "reportingTo",
         e.status
       FROM employee e
       LEFT JOIN designation dg ON dg.id = e.designation_id
       LEFT JOIN department dp  ON dp.id = e.department_id
       LEFT JOIN service_branches sb ON sb.branch_id = e.branch_id
       LEFT JOIN employee rp    ON rp.id = e.reporting_to
       ORDER BY e.id DESC`
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Error loading employees:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

/* ------------- validation shared by Add (POST) and Edit (PUT) ------------- */
// Returns { error } or { v } (cleaned values)
function readEmployee(b) {
  const v = {
    salutation: clean(b.salutation),
    fullName: clean(b.fullName),
    mobile: clean(b.mobile),
    altMobile: clean(b.altMobile),
    email: clean(b.email),
    nic: clean(b.nic),
    gender: clean(b.gender),
    dob: clean(b.dateOfBirth),
    joining: clean(b.joiningDate),
    status: clean(b.status) || "Active",
    address: clean(b.address),
    about: clean(b.about),
    designationId: toInt(b.designationId),
    departmentId: toInt(b.departmentId),
    branchId: toInt(b.branchId),
    reportingTo: toInt(b.reportingTo),
  };

  if (!SALUTATIONS.includes(v.salutation)) return { error: "Select the salutation" };
  if (!v.fullName) return { error: "Employee name is required" };
  if (!v.mobile || !PHONE_RE.test(v.mobile)) return { error: "Mobile number must be 10 or 11 digits" };
  if (v.altMobile && !PHONE_RE.test(v.altMobile)) return { error: "Alternative mobile must be 10 or 11 digits" };
  if (v.email && !EMAIL_RE.test(v.email)) return { error: "Invalid email" };
  if (v.nic && !NIC_RE.test(v.nic)) return { error: "Invalid NIC number" };
  if (v.gender && !GENDERS.includes(v.gender)) return { error: "Invalid gender" };
  if (!STATUSES.includes(v.status)) return { error: "Invalid status" };
  if (v.dob && (!validDate(v.dob) || v.dob > new Date().toISOString().slice(0, 10))) return { error: "Invalid date of birth" };
  if (v.joining && !validDate(v.joining)) return { error: "Invalid joining date" };
  if (!Number.isInteger(v.designationId)) return { error: "Select the designation" };
  if (!Number.isInteger(v.departmentId)) return { error: "Select the department" };
  if (Number.isNaN(v.branchId)) return { error: "Invalid branch" };
  if (Number.isNaN(v.reportingTo)) return { error: "Invalid reporting person" };
  return { v };
}

// Maps duplicate / foreign key database errors to a friendly response
function dbError(res, error) {
  if (error.code === "23505") {
    const info = `${error.constraint || ""} ${error.detail || ""}`;
    if (info.includes("email")) return res.status(409).json({ message: "An employee with this email already exists" });
    if (info.includes("nic")) return res.status(409).json({ message: "An employee with this NIC already exists" });
    if (info.includes("employee_no")) return res.status(409).json({ message: "This Employee ID is already used" });
    return res.status(409).json({ message: "Duplicate record" });
  }
  if (error.code === "23503") {
    return res.status(400).json({ message: "Invalid designation, department, branch or reporting person" });
  }
  return res.status(500).json({ message: "Server error" });
}

async function activeBranchExists(client, id) {
  const r = await client.query("SELECT 1 FROM service_branches WHERE branch_id = $1 AND is_active", [id]);
  return r.rowCount > 0;
}

/* ------------- POST /api/employees (Add employee) -------------
   JSON body:
     salutation, fullName, email, dateOfBirth (YYYY-MM-DD),
     designationId, departmentId, mobile, altMobile, gender, joiningDate, reportingTo (employee db id),
     branchId (administrators only - everyone else gets their own branch), address, about, nic,
     status (optional)
-------------------------------------------------------------------- */
router.post("/employees", authenticateToken, async (req, res) => {
  const { error, v } = readEmployee(req.body || {});
  if (error) return res.status(400).json({ message: error });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Branch: an administrator (role_id = 1) chooses it, everyone else gets his / her own branch
    const me = await loadMe(client, currentUserId(req));
    const finalBranchId = me.isAdmin ? v.branchId : me.branchId;
    if (!Number.isInteger(finalBranchId)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: me.isAdmin ? "Select the branch" : "Your account has no branch assigned" });
    }
    if (!(await activeBranchExists(client, finalBranchId))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid branch" });
    }

    // Employee ID is always generated from the table id (not editable): id 7 -> EMP-0007
    const seq = await client.query("SELECT nextval(pg_get_serial_sequence('employee', 'id')) AS id");
    const newId = seq.rows[0].id;
    const no = `EMP-${String(newId).padStart(4, "0")}`;

    const ins = await client.query(
      `INSERT INTO employee
         (id, employee_no, salutation, full_name, email, nic, date_of_birth, gender, mobile, alt_mobile,
          address, about, designation_id, department_id, branch_id, joining_date,
          reporting_to, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id, employee_no`,
      [
        newId, no, v.salutation, v.fullName, v.email, v.nic, v.dob, v.gender, v.mobile, v.altMobile,
        v.address, v.about, v.designationId, v.departmentId, finalBranchId, v.joining,
        v.reportingTo, v.status, currentUserId(req),
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      message: "Employee added successfully",
      employee: { dbId: ins.rows[0].id, id: ins.rows[0].employee_no },
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error adding employee:", err);
    return dbError(res, err);
  } finally {
    client.release();
  }
});

/* ------------- PUT /api/employees/:id (Edit employee) -------------
   Same JSON body as Add. The Employee ID (employee_no) never changes.
   Administrators can change the branch; everyone else can only edit employees of
   his / her own branch and the branch stays unchanged.
-------------------------------------------------------------------- */
router.put("/employees/:id", authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid employee" });

  const { error, v } = readEmployee(req.body || {});
  if (error) return res.status(400).json({ message: error });
  if (v.reportingTo === id) return res.status(400).json({ message: "An employee cannot report to himself / herself" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cur = await client.query("SELECT branch_id FROM employee WHERE id = $1 FOR UPDATE", [id]);
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Employee not found" });
    }

    const me = await loadMe(client, currentUserId(req));
    if (!me.isAdmin && cur.rows[0].branch_id !== me.branchId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "You can only edit employees of your own branch" });
    }

    const finalBranchId = me.isAdmin ? v.branchId : cur.rows[0].branch_id;
    if (!Number.isInteger(finalBranchId)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select the branch" });
    }
    // an unchanged (possibly now inactive) branch is allowed, a newly chosen one must be active
    if (finalBranchId !== cur.rows[0].branch_id && !(await activeBranchExists(client, finalBranchId))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid branch" });
    }

    const upd = await client.query(
      `UPDATE employee SET
         salutation = $1, full_name = $2, email = $3, nic = $4, date_of_birth = $5, gender = $6,
         mobile = $7, alt_mobile = $8, address = $9, about = $10, designation_id = $11,
         department_id = $12, branch_id = $13, joining_date = $14, reporting_to = $15,
         status = $16, updated_at = CURRENT_TIMESTAMP
       WHERE id = $17
       RETURNING id, employee_no`,
      [
        v.salutation, v.fullName, v.email, v.nic, v.dob, v.gender,
        v.mobile, v.altMobile, v.address, v.about, v.designationId,
        v.departmentId, finalBranchId, v.joining, v.reportingTo,
        v.status, id,
      ]
    );

    await client.query("COMMIT");
    return res.json({
      message: "Employee updated successfully",
      employee: { dbId: upd.rows[0].id, id: upd.rows[0].employee_no },
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error updating employee:", err);
    return dbError(res, err);
  } finally {
    client.release();
  }
});



// Who can add / edit / activate / deactivate:  []  = every logged-in user,  [1] = only role_id 1
const MANAGE_ROLE_IDS = [];
const LEVELS = ["Management", "Senior", "Executive", "Staff", "Junior"];



async function canManage(req) {
  if (MANAGE_ROLE_IDS.length === 0) return true; // no restriction: every logged-in user
  const n = Number(req.user?.user_id ?? req.user?.id);
  if (!Number.isInteger(n)) return false;
  const r = await pool.query("SELECT role_id FROM admin_user WHERE id = $1", [n]);
  return r.rowCount > 0 && MANAGE_ROLE_IDS.includes(Number(r.rows[0].role_id));
}

// guard for write routes - everyone who is logged in can add / edit
const manageOnly = (req, res, next) => next();

const dup = (res, what) => res.status(409).json({ message: `A ${what} with this name already exists` });

/* ============================ DESIGNATIONS ============================ */
// GET /api/designations  -> every designation (active + inactive) with the number of working employees
router.get("/designations", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.id, d.name, d.level, d.is_active AS "isActive",
              COUNT(e.id) FILTER (WHERE e.status <> 'Resigned')::int AS "employeeCount"
       FROM designation d
       LEFT JOIN employee e ON e.designation_id = d.id
       GROUP BY d.id
       ORDER BY d.is_active DESC, d.name`
    );
    return res.json({ canManage: await canManage(req), levels: LEVELS, rows: r.rows });
  } catch (error) {
    console.error("Error loading designations:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

function readDesignation(b) {
  const name = clean(b.name);
  const level = clean(b.level);
  if (!name) return { error: "Designation name is required" };
  if (name.length > 100) return { error: "Name is too long (max 100 characters)" };
  if (level && !LEVELS.includes(level)) return { error: "Invalid level" };
  return { v: { name, level, isActive: b.isActive === undefined ? true : b.isActive === true || b.isActive === "true" } };
}

// POST /api/designations   { name, level?, isActive? }
router.post("/designations", authenticateToken, manageOnly, async (req, res) => {
  const { error, v } = readDesignation(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const same = await pool.query("SELECT 1 FROM designation WHERE lower(name) = lower($1)", [v.name]);
    if (same.rowCount > 0) return dup(res, "designation");

    const r = await pool.query(
      `INSERT INTO designation (name, level, is_active) VALUES ($1, $2, $3)
       RETURNING id, name, level, is_active AS "isActive"`,
      [v.name, v.level, v.isActive]
    );
    return res.status(201).json({ message: "Designation added successfully", designation: r.rows[0] });
  } catch (error) {
    if (error.code === "23505") return dup(res, "designation");
    console.error("Error adding designation:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/designations/:id   { name, level?, isActive }
router.put("/designations/:id", authenticateToken, manageOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid designation" });
  const { error, v } = readDesignation(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const same = await pool.query("SELECT 1 FROM designation WHERE lower(name) = lower($1) AND id <> $2", [v.name, id]);
    if (same.rowCount > 0) return dup(res, "designation");

    const r = await pool.query(
      `UPDATE designation SET name = $1, level = $2, is_active = $3 WHERE id = $4
       RETURNING id, name, level, is_active AS "isActive"`,
      [v.name, v.level, v.isActive, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Designation not found" });
    return res.json({ message: "Designation updated successfully", designation: r.rows[0] });
  } catch (error) {
    if (error.code === "23505") return dup(res, "designation");
    console.error("Error updating designation:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

/* ============================ DEPARTMENTS ============================ */
// GET /api/departments  -> every department (active + inactive) with the number of working employees
router.get("/departments", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.id, d.name, d.sort_order AS "sortOrder", d.is_active AS "isActive",
              d.show_in_job_stage AS "showInJobStage",
              COUNT(e.id) FILTER (WHERE e.status <> 'Resigned')::int AS "employeeCount"
       FROM department d
       LEFT JOIN employee e ON e.department_id = d.id
       GROUP BY d.id
       ORDER BY d.is_active DESC, d.sort_order, d.id`
    );
    return res.json({ canManage: await canManage(req), rows: r.rows });
  } catch (error) {
    console.error("Error loading departments:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

function readDepartment(b) {
  const name = clean(b.name);
  const sortRaw = clean(b.sortOrder);
  const sortOrder = sortRaw === null ? null : Number(sortRaw);
  if (!name) return { error: "Department name is required" };
  if (name.length > 50) return { error: "Name is too long (max 50 characters)" };
  if (sortOrder !== null && !Number.isInteger(sortOrder)) return { error: "Sort order must be a whole number" };
  const bool = (x, d) => (x === undefined ? d : x === true || x === "true");
  return { v: { name, sortOrder, isActive: bool(b.isActive, true), showInJobStage: bool(b.showInJobStage, false) } };
}

// POST /api/departments   { name, sortOrder?, isActive?, showInJobStage? }
// showInJobStage = true  -> the department also appears in the CRM "Select Department" step (job stages).
//                  false -> only used for HR (employees), e.g. Accounts / HR.
router.post("/departments", authenticateToken, manageOnly, async (req, res) => {
  const { error, v } = readDepartment(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const same = await pool.query("SELECT 1 FROM department WHERE lower(name) = lower($1)", [v.name]);
    if (same.rowCount > 0) return dup(res, "department");

    // no sort order given -> put it at the end
    const r = await pool.query(
      `INSERT INTO department (name, sort_order, is_active, show_in_job_stage)
       VALUES ($1, COALESCE($2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM department)), $3, $4)
       RETURNING id, name, sort_order AS "sortOrder", is_active AS "isActive", show_in_job_stage AS "showInJobStage"`,
      [v.name, v.sortOrder, v.isActive, v.showInJobStage]
    );
    return res.status(201).json({ message: "Department added successfully", department: r.rows[0] });
  } catch (error) {
    if (error.code === "23505") return dup(res, "department");
    console.error("Error adding department:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/departments/:id   { name, sortOrder?, isActive, showInJobStage }
router.put("/departments/:id", authenticateToken, manageOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid department" });
  const { error, v } = readDepartment(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const same = await pool.query("SELECT 1 FROM department WHERE lower(name) = lower($1) AND id <> $2", [v.name, id]);
    if (same.rowCount > 0) return dup(res, "department");

    const r = await pool.query(
      `UPDATE department
       SET name = $1, sort_order = COALESCE($2, sort_order), is_active = $3, show_in_job_stage = $4
       WHERE id = $5
       RETURNING id, name, sort_order AS "sortOrder", is_active AS "isActive", show_in_job_stage AS "showInJobStage"`,
      [v.name, v.sortOrder, v.isActive, v.showInJobStage, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    return res.json({ message: "Department updated successfully", department: r.rows[0] });
  } catch (error) {
    if (error.code === "23505") return dup(res, "department");
    console.error("Error updating department:", error);
    return res.status(500).json({ message: "Server error" });
  }
});








const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const COLS = `branch_id AS "id", branch_code AS "code", branch_name AS "name", address, city, district,
  postal_code AS "postalCode", phone_number AS "phone", secondary_phone AS "secondaryPhone", email,
  manager_name AS "managerName", to_char(opening_time, 'HH24:MI') AS "openingTime",
  to_char(closing_time, 'HH24:MI') AS "closingTime", max_daily_capacity AS "maxDailyCapacity",
  is_active AS "isActive"`;

// GET /api/branches -> every branch (active + inactive) with employee / user counts
router.get("/branches", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${COLS},
         (SELECT COUNT(*)::int FROM employee e WHERE e.branch_id = b.branch_id AND e.status <> 'Resigned') AS "employeeCount",
         (SELECT COUNT(*)::int FROM admin_user u WHERE u.branch_id = b.branch_id) AS "userCount"
       FROM service_branches b
       ORDER BY b.is_active DESC, b.branch_name`
    );
    return res.json({ canManage: await canManage(req), rows: r.rows });
  } catch (error) {
    console.error("Error loading branches:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

function readBranch(b) {
  const v = {
    code: clean(b.code),
    name: clean(b.name),
    address: clean(b.address),
    city: clean(b.city),
    district: clean(b.district),
    postalCode: clean(b.postalCode),
    phone: clean(b.phone),
    secondaryPhone: clean(b.secondaryPhone),
    email: clean(b.email),
    managerName: clean(b.managerName),
    openingTime: clean(b.openingTime) || "08:00",
    closingTime: clean(b.closingTime) || "17:00",
    maxDailyCapacity: clean(b.maxDailyCapacity) === null ? 15 : Number(b.maxDailyCapacity),
    isActive: b.isActive === undefined ? true : b.isActive === true || b.isActive === "true",
  };
  if (!v.code) return { error: "Branch code is required" };
  if (v.code.length > 20) return { error: "Branch code is too long (max 20 characters)" };
  if (!v.name) return { error: "Branch name is required" };
  if (v.name.length > 100) return { error: "Branch name is too long (max 100 characters)" };
  if (!v.address) return { error: "Address is required" };
  if (!v.city) return { error: "City is required" };
  if (v.city.length > 50 || (v.district && v.district.length > 50)) return { error: "City / district is too long (max 50 characters)" };
  if (v.postalCode && v.postalCode.length > 10) return { error: "Postal code is too long (max 10 characters)" };
  if (!v.phone || !PHONE_RE.test(v.phone)) return { error: "Phone number must be 10 or 11 digits" };
  if (v.secondaryPhone && !PHONE_RE.test(v.secondaryPhone)) return { error: "Secondary phone must be 10 or 11 digits" };
  if (v.email && (!EMAIL_RE.test(v.email) || v.email.length > 100)) return { error: "Invalid email" };
  if (v.managerName && v.managerName.length > 100) return { error: "Manager name is too long (max 100 characters)" };
  if (!TIME_RE.test(v.openingTime) || !TIME_RE.test(v.closingTime)) return { error: "Invalid opening / closing time" };
  if (v.openingTime >= v.closingTime) return { error: "Closing time must be after the opening time" };
  if (!Number.isInteger(v.maxDailyCapacity) || v.maxDailyCapacity < 1 || v.maxDailyCapacity > 1000) {
    return { error: "Daily capacity must be a whole number between 1 and 1000" };
  }
  return { v };
}

function branchDbError(res, error) {
  if (error.code === "23505") return res.status(409).json({ message: "A branch with this code already exists" });
  if (error.code === "23514") return res.status(400).json({ message: "A value is out of the allowed range (check the daily capacity)" });
  return res.status(500).json({ message: "Server error" });
}

const params = (v) => [
  v.code, v.name, v.address, v.city, v.district, v.postalCode, v.phone, v.secondaryPhone, v.email,
  v.managerName, v.openingTime, v.closingTime, v.maxDailyCapacity, v.isActive,
];

// POST /api/branches
router.post("/branches", authenticateToken, manageOnly, async (req, res) => {
  const { error, v } = readBranch(req.body || {});
  if (error) return res.status(400).json({ message: error });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const same = await client.query("SELECT 1 FROM service_branches WHERE lower(branch_code) = lower($1)", [v.code]);
    if (same.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "A branch with this code already exists" });
    }

    // Does branch_id generate itself? (serial / identity column)  -> then do NOT send an id.
    const col = await client.query(
      `SELECT column_default, is_identity FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'service_branches' AND column_name = 'branch_id'`
    );
    const autoId = col.rowCount > 0 && (col.rows[0].column_default !== null || col.rows[0].is_identity === "YES");

    const cols =
      `branch_code, branch_name, address, city, district, postal_code, phone_number, secondary_phone,
       email, manager_name, opening_time, closing_time, max_daily_capacity, is_active`;
    let r;
    if (autoId) {
      r = await client.query(
        `INSERT INTO service_branches (${cols})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING branch_id AS id`,
        params(v)
      );
    } else {
      // plain integer id: take the next one (the lock stops two people from getting the same id)
      await client.query("LOCK TABLE service_branches IN SHARE ROW EXCLUSIVE MODE");
      const next = await client.query("SELECT COALESCE(MAX(branch_id), 0) + 1 AS id FROM service_branches");
      r = await client.query(
        `INSERT INTO service_branches (branch_id, ${cols})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING branch_id AS id`,
        [next.rows[0].id, ...params(v)]
      );
    }

    await client.query("COMMIT");
    return res.status(201).json({ message: "Branch added successfully", branch: { id: r.rows[0].id } });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error adding branch:", err.code, err.message);
    return branchDbError(res, err);
  } finally {
    client.release();
  }
});

// PUT /api/branches/:id
router.put("/branches/:id", authenticateToken, manageOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid branch" });
  const { error, v } = readBranch(req.body || {});
  if (error) return res.status(400).json({ message: error });

  try {
    const same = await pool.query("SELECT 1 FROM service_branches WHERE lower(branch_code) = lower($1) AND branch_id <> $2", [v.code, id]);
    if (same.rowCount > 0) return res.status(409).json({ message: "A branch with this code already exists" });

    const r = await pool.query(
      `UPDATE service_branches SET
         branch_code = $1, branch_name = $2, address = $3, city = $4, district = $5, postal_code = $6,
         phone_number = $7, secondary_phone = $8, email = $9, manager_name = $10, opening_time = $11,
         closing_time = $12, max_daily_capacity = $13, is_active = $14, updated_at = CURRENT_TIMESTAMP
       WHERE branch_id = $15
       RETURNING branch_id AS id`,
      [...params(v), id]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Branch not found" });
    return res.json({ message: "Branch updated successfully", branch: { id } });
  } catch (err) {
    console.error("Error updating branch:", err.code, err.message);
    return branchDbError(res, err);
  }
});






module.exports = router;