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

const S3Service = require('./s3Service');

dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();

/// routes/complaint.routes.js
// Stage 5: "Customer Complaint recording / Review" for every department.
// Mount in your app:  app.use("/api", require("./routes/complaint.routes"));
// Run create_complaint_tables.sql first.


const COMPLAINT_STAGE_NO = 5;

// SECURITY: only these admin_user.role_id values may add / edit / remove the type lists.
// (role_id 1 = admin in your admin_user table. Add more role ids if needed.)
const MANAGE_LIST_ROLE_IDS = [1];

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
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
};

// "" / null -> null, "1500" -> 1500, "abc" -> NaN
const toPrice = (v) => {
  const s = clean(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

async function canManageLists(db, userId) {
  if (!userId) return false;
  const r = await db.query("SELECT role_id FROM admin_user WHERE id = $1", [userId]);
  return r.rowCount > 0 && MANAGE_LIST_ROLE_IDS.includes(Number(r.rows[0].role_id));
}

const requireListManager = async (req, res, next) => {
  try {
    if (!(await canManageLists(pool, currentUserId(req)))) {
      return res.status(403).json({ message: "You do not have permission to edit these lists" });
    }
    return next();
  } catch (error) {
    console.error("Permission check failed:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// Lists + items of one department
async function loadLists(db, departmentId, includeInactive) {
  const lists = await db.query(
    `SELECT id, code, title, selection, has_price AS "hasPrice", concern_level AS "concernLevel",
            show_in_stage_no AS "showInStageNo"
     FROM complaint_option_list
     WHERE department_id = $1 AND ($2::boolean OR is_active)
     ORDER BY sort_order, id`,
    [departmentId, includeInactive]
  );
  const options = await db.query(
    `SELECT o.id, o.list_id AS "listId", o.group_name AS "groupName", o.name, o.description,
            o.price::float AS price, o.is_active AS "isActive", o.sort_order AS "sortOrder"
     FROM complaint_option o
     JOIN complaint_option_list l ON l.id = o.list_id
     WHERE l.department_id = $1 AND ($2::boolean OR o.is_active)
     ORDER BY o.sort_order, o.id`,
    [departmentId, includeInactive]
  );
  return lists.rows.map((l) => ({ ...l, options: options.rows.filter((o) => o.listId === l.id) }));
}

/* ------------- GET /api/jobs/:id/complaint  (opens the form) -------------
   The job, the type lists of the job's department, the saved complaint (if any),
   the other departments (for "Shift To Other Department") and whether the user can edit the lists.
-------------------------------------------------------------------------- */
router.get("/jobs/:id/complaint", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });

  try {
    const jobRes = await pool.query(
      `SELECT j.id, j.job_no, j.reg_no, j.status, j.current_stage_no, j.department_id,
              d.name AS department_name, d.requires_initial_approval,
              c.customer_name, c.contact_number
       FROM job j
       JOIN customer c        ON c.id = j.customer_id
       LEFT JOIN department d ON d.id = j.department_id
       WHERE j.id = $1`,
      [jobId]
    );
    if (jobRes.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const j = jobRes.rows[0];
    if (!j.department_id) return res.status(409).json({ message: "Select a department for this job first" });

    const lists = await loadLists(pool, j.department_id, false);

    const saved = await pool.query(
      `SELECT jc.id, jc.complaint, jc.remarks, jc.vehicle_pass_issued, jc.initial_customer_approval,
              jc.updated_at, trim(concat(u.first_name, ' ', u.last_name)) AS recorded_by_name,
              jc.start_confirmed_at, trim(concat(su.first_name, ' ', su.last_name)) AS start_confirmed_by_name
       FROM job_complaint jc
       LEFT JOIN admin_user u  ON u.id = jc.recorded_by
       LEFT JOIN admin_user su ON su.id = jc.start_confirmed_by
       WHERE jc.job_id = $1`,
      [jobId]
    );
    let complaint = null;
    if (saved.rowCount > 0) {
      const s = saved.rows[0];
      const sel = await pool.query(
        "SELECT option_id FROM job_complaint_option WHERE job_complaint_id = $1 AND option_id IS NOT NULL",
        [s.id]
      );
      complaint = {
        complaint: s.complaint,
        remarks: s.remarks,
        vehiclePassIssued: s.vehicle_pass_issued,
        initialCustomerApproval: s.initial_customer_approval,
        selectedOptionIds: sel.rows.map((r) => r.option_id),
        recordedAt: s.updated_at,
        recordedByName: s.recorded_by_name,
        startConfirmedAt: s.start_confirmed_at,
        startConfirmedByName: s.start_confirmed_by_name,
      };
    }

    const others = await pool.query(
      `SELECT id, name FROM department
       WHERE is_active AND show_in_job_stage AND id <> $1
       ORDER BY sort_order, id`,
      [j.department_id]
    );

    return res.json({
      job: {
        id: j.id,
        jobNo: j.job_no,
        regNo: j.reg_no,
        status: j.status,
        stageNo: j.current_stage_no,
        customerName: j.customer_name,
        contactNumber: j.contact_number,
        departmentId: j.department_id,
        departmentName: j.department_name,
      },
      config: { requiresInitialApproval: j.requires_initial_approval, lists },
      complaint,
      otherDepartments: others.rows,
      canManage: await canManageLists(pool, currentUserId(req)),
    });
  } catch (error) {
    console.error("Error loading complaint form:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// ONLY THIS ROUTE CHANGED in complaint.routes.js:  router.post("/jobs/:id/complaint", ...)
// Replace the existing  router.post("/jobs/:id/complaint", ...)  route (the comment above it too) with this one.
// New: for Wash the complaint can be SAVED first and the job STARTED later (stage 5 stays open until the start is confirmed).

/* ------------- POST /api/jobs/:id/complaint  (save) -------------
   Body: { complaint, remarks, vehiclePassIssued, initialCustomerApproval, startConfirmed, optionIds: [] }
   startConfirmed = the user answered Yes to "Are you sure about initial starting?" (Stage 4 A, Wash).
   The first save completes stage 5 and moves the job to stage 6 (Wash: only when startConfirmed = true, so the
   complaint can be saved first and the job started later). Later saves only update the record.
------------------------------------------------------------------ */
router.post("/jobs/:id/complaint", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });

  const b = req.body || {};
  const complaint = clean(b.complaint);
  const remarks = clean(b.remarks);
  const vehiclePassIssued = b.vehiclePassIssued === true;
  const approval = typeof b.initialCustomerApproval === "boolean" ? b.initialCustomerApproval : null;
  const startConfirmed = b.startConfirmed === true;
  const optionIds = [...new Set((Array.isArray(b.optionIds) ? b.optionIds : []).map(toInt))].filter((n) =>
    Number.isInteger(n)
  );

  if (!complaint && optionIds.length === 0) {
    return res.status(400).json({ message: "Write the complaint or select a type" });
  }

  const userId = currentUserId(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jobRes = await client.query(
      `SELECT j.id, j.status, j.current_stage_no, j.department_id, d.requires_initial_approval
       FROM job j LEFT JOIN department d ON d.id = j.department_id
       WHERE j.id = $1 FOR UPDATE OF j`,
      [jobId]
    );
    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jobRes.rows[0];
    if (job.status !== "IN_PROGRESS" || !job.department_id || job.current_stage_no < COMPLAINT_STAGE_NO) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This job is not ready for the complaint stage" });
    }
    // Wash: the complaint can be SAVED first and the job STARTED later.
    // Starting (Stage 4 A) needs the Initial Customer Approval answer (Yes / No).
    if (job.requires_initial_approval && startConfirmed && approval === null) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select Initial Customer Approval (Yes / No)" });
    }

    // The selected items must belong to this department's active lists
    let picked = [];
    if (optionIds.length > 0) {
      const opts = await client.query(
        `SELECT o.id, o.group_name, o.name, o.price, l.id AS list_id, l.title, l.selection, l.concern_level
         FROM complaint_option o
         JOIN complaint_option_list l ON l.id = o.list_id
         WHERE o.id = ANY($1::int[]) AND l.department_id = $2 AND o.is_active AND l.is_active`,
        [optionIds, job.department_id]
      );
      if (opts.rowCount !== optionIds.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid selection" });
      }
      picked = opts.rows;

      const perList = {};
      for (const o of picked) {
        perList[o.list_id] = (perList[o.list_id] || 0) + 1;
        if (o.selection === "SINGLE" && perList[o.list_id] > 1) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: `Select only one: ${o.title}` });
        }
      }
    }

    // Save (insert or update) the complaint
    const jc = await client.query(
      `INSERT INTO job_complaint
         (job_id, complaint, remarks, vehicle_pass_issued, initial_customer_approval, recorded_by,
          start_confirmed_at, start_confirmed_by)
       VALUES ($1, $2, $3, $4, $5, $6,
               CASE WHEN $7::boolean THEN CURRENT_TIMESTAMP END,
               CASE WHEN $7::boolean THEN $6::int END)
       ON CONFLICT (job_id) DO UPDATE SET
         complaint = EXCLUDED.complaint,
         remarks = EXCLUDED.remarks,
         vehicle_pass_issued = EXCLUDED.vehicle_pass_issued,
         initial_customer_approval = EXCLUDED.initial_customer_approval,
         recorded_by = EXCLUDED.recorded_by,
         start_confirmed_at = COALESCE(job_complaint.start_confirmed_at, EXCLUDED.start_confirmed_at),
         start_confirmed_by = COALESCE(job_complaint.start_confirmed_by, EXCLUDED.start_confirmed_by),
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [jobId, complaint, remarks, vehiclePassIssued, approval, userId, startConfirmed]
    );
    const complaintId = jc.rows[0].id;

    // Selected types (name / price are copied)
    await client.query("DELETE FROM job_complaint_option WHERE job_complaint_id = $1", [complaintId]);
    for (const o of picked) {
      await client.query(
        `INSERT INTO job_complaint_option
           (job_complaint_id, option_id, list_title, concern_level, group_name, option_name, price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [complaintId, o.id, o.title, o.concern_level, o.group_name, o.name, o.price]
      );
    }

    // Complete stage 5 and move to stage 6:
    //  - normal departments: on the first save
    //  - departments with "initial start" (Wash): only when the start is confirmed (Stage 4 A)
    let currentStageNo = job.current_stage_no;
    const canCompleteStage = !job.requires_initial_approval || startConfirmed;
    if (job.current_stage_no === COMPLAINT_STAGE_NO && canCompleteStage) {
      const next = COMPLAINT_STAGE_NO + 1;
      await client.query(
        `UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3
         WHERE job_id = $1 AND stage_no = $2`,
        [jobId, COMPLAINT_STAGE_NO, userId]
      );
      await client.query(
        `UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP
         WHERE job_id = $1 AND stage_no = $2`,
        [jobId, next]
      );
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [
        next,
        jobId,
      ]);
      currentStageNo = next;
    } else {
      await client.query("UPDATE job SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [jobId]);
    }

    await client.query("COMMIT");
    return res.json({
      message: "Complaint saved",
      currentStageNo,
      started: Boolean(job.requires_initial_approval && startConfirmed),
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving complaint:", error);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

/* ------------- PATCH /api/jobs/:id/shift-department -------------
   "Shift To Other Department". Body: { departmentId, reason }
   Allowed only while the complaint window (stage 5) is open.
------------------------------------------------------------------ */
router.patch("/jobs/:id/shift-department", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  const departmentId = toInt(req.body?.departmentId);
  const reason = clean(req.body?.reason);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  if (!Number.isInteger(departmentId)) return res.status(400).json({ message: "Select a department" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jobRes = await client.query(
      "SELECT id, status, current_stage_no, department_id FROM job WHERE id = $1 FOR UPDATE",
      [jobId]
    );
    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jobRes.rows[0];
    if (job.status !== "IN_PROGRESS" || job.current_stage_no !== COMPLAINT_STAGE_NO) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "A job can only be shifted while its complaint stage is open" });
    }
    if (job.department_id === departmentId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "The job is already in this department" });
    }

    const dept = await client.query(
      "SELECT id, name FROM department WHERE id = $1 AND is_active AND show_in_job_stage",
      [departmentId]
    );
    if (dept.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid department" });
    }

    await client.query("UPDATE job SET department_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [
      departmentId,
      jobId,
    ]);
    await client.query(
      `INSERT INTO job_department_log (job_id, from_department_id, to_department_id, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, job.department_id, departmentId, reason, currentUserId(req)]
    );

    await client.query("COMMIT");
    return res.json({ message: "Job shifted", departmentName: dept.rows[0].name });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error shifting job:", error);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

/* =====================================================================
   MANAGE THE TYPE LISTS (add / alter / remove) - only for MANAGE_LIST_ROLE_IDS
   ===================================================================== */

// All lists of a department, including removed items (for the "Manage lists" window)
router.get("/departments/:id/complaint-lists", authenticateToken, requireListManager, async (req, res) => {
  const departmentId = toInt(req.params.id);
  if (!Number.isInteger(departmentId)) return res.status(400).json({ message: "Invalid department" });
  try {
    return res.json(await loadLists(pool, departmentId, true));
  } catch (error) {
    console.error("Error loading lists:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// Add an item (a removed item with the same name is brought back)
router.post("/complaint-lists/:listId/options", authenticateToken, requireListManager, async (req, res) => {
  const listId = toInt(req.params.listId);
  const name = clean(req.body?.name);
  const price = toPrice(req.body?.price);
  if (!Number.isInteger(listId)) return res.status(400).json({ message: "Invalid list" });
  if (!name) return res.status(400).json({ message: "Name is required" });
  if (Number.isNaN(price)) return res.status(400).json({ message: "Invalid price" });

  try {
    const result = await pool.query(
      `INSERT INTO complaint_option (list_id, group_name, name, description, price, sort_order)
       VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT max(sort_order) FROM complaint_option WHERE list_id = $1), 0) + 1)
       ON CONFLICT (list_id, name) DO UPDATE SET
         is_active = true, group_name = EXCLUDED.group_name, description = EXCLUDED.description,
         price = EXCLUDED.price, updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [listId, clean(req.body?.groupName), name, clean(req.body?.description), price]
    );
    return res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    if (error.code === "23503") return res.status(404).json({ message: "List not found" });
    console.error("Error adding option:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// Alter an item. Send only the fields that change: name, groupName, description, price, isActive, sortOrder
router.patch("/complaint-options/:id", authenticateToken, requireListManager, async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid item" });

  const b = req.body || {};
  const sets = [];
  const values = [];
  const add = (column, value) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if ("name" in b) {
    const name = clean(b.name);
    if (!name) return res.status(400).json({ message: "Name is required" });
    add("name", name);
  }
  if ("groupName" in b) add("group_name", clean(b.groupName));
  if ("description" in b) add("description", clean(b.description));
  if ("price" in b) {
    const price = toPrice(b.price);
    if (Number.isNaN(price)) return res.status(400).json({ message: "Invalid price" });
    add("price", price);
  }
  if ("isActive" in b) add("is_active", b.isActive === true);
  if ("sortOrder" in b) {
    const n = toInt(b.sortOrder);
    if (!Number.isInteger(n)) return res.status(400).json({ message: "Invalid order" });
    add("sort_order", n);
  }
  if (sets.length === 0) return res.status(400).json({ message: "Nothing to update" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE complaint_option SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING id`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Item not found" });
    return res.json({ message: "Updated" });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ message: "An item with this name already exists in the list" });
    console.error("Error updating option:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// Remove an item. It is only switched off (is_active = false), so jobs that already used it keep their record.
router.delete("/complaint-options/:id", authenticateToken, requireListManager, async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid item" });
  try {
    const result = await pool.query(
      "UPDATE complaint_option SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Item not found" });
    return res.json({ message: "Removed" });
  } catch (error) {
    console.error("Error removing option:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;