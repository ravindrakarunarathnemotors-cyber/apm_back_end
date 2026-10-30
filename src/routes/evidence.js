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
const { randomBytes } = require("node:crypto");
const S3Service = require('./s3Service');
const { sendSms, toSriLankaNumber } = require("../services/sms.service"); 

dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();

// The stage number of the evidence stage is per department (department.evidence_stage_no, default 7;
// Detailing = 6, because it has no team / bay stage before it).
const DEFAULT_EVIDENCE_STAGE_NO = 7;
// Who may add / rename / remove checklist items:  [] = every logged-in user,  [1] = only role_id 1 (admin)
const MANAGE_ROLE_IDS = [];
const CONDITIONS = ["OK", "DAMAGED", "NA"];
 
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
const toBool = (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);
 
async function canManage(req) {
  if (MANAGE_ROLE_IDS.length === 0) return true;
  const n = currentUserId(req);
  if (!n) return false;
  const r = await pool.query("SELECT role_id FROM admin_user WHERE id = $1", [n]);
  return r.rowCount > 0 && MANAGE_ROLE_IDS.includes(Number(r.rows[0].role_id));
}
const manageOnly = async (req, res, next) => {
  try {
    if (await canManage(req)) return next();
    return res.status(403).json({ message: "You do not have permission to change the inspection checklist" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
};
 
const ITEM_COLS = `id, department_id AS "departmentId", name, sort_order AS "sortOrder", is_active AS "isActive"`;
 
/* ================= checklist items of a department ================= */
// GET /api/evidence-department/:name -> { id, name, hasVehicleEvidence, canManage }   (dashboard looks it up by NAME)
router.get("/evidence-department/:name", authenticateToken, async (req, res) => {
  const name = clean(req.params.name);
  if (!name) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(
      `SELECT id, name, COALESCE(has_vehicle_evidence, false) AS "hasVehicleEvidence",
              COALESCE(evidence_stage_no, ${DEFAULT_EVIDENCE_STAGE_NO}) AS "evidenceStageNo",
              COALESCE(has_job_inspection, false) AS "hasJobInspection", job_inspection_stage_no AS "jobInspectionStageNo",
              COALESCE(has_spare_parts, false) AS "hasSpareParts", spare_parts_stage_no AS "spareStageNo",
              COALESCE(has_customer_approval, false) AS "hasCustomerApproval", customer_approval_stage_no AS "approvalStageNo",
              COALESCE(has_internal_inspection, false) AS "hasInternalInspection", internal_inspection_stage_no AS "internalStageNo",
              COALESCE(has_job_activation, false) AS "hasJobActivation", job_activation_stage_no AS "activationStageNo"
       FROM department WHERE lower(name) = lower($1) AND is_active`,
      [name]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    return res.json({ ...r.rows[0], canManage: await canManage(req) });
  } catch (error) {
    console.error("Error loading evidence department:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// GET /api/departments/:id/inspection-items -> every item (active + inactive)
router.get("/departments/:id/inspection-items", authenticateToken, async (req, res) => {
  const departmentId = toInt(req.params.id);
  if (!Number.isInteger(departmentId)) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(`SELECT ${ITEM_COLS} FROM inspection_item WHERE department_id = $1 ORDER BY sort_order, id`, [departmentId]);
    return res.json({ canManage: await canManage(req), items: r.rows });
  } catch (error) {
    console.error("Error loading inspection items:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
const readItem = (b) => {
  const name = clean(b.name);
  const sortRaw = clean(b.sortOrder);
  const sortOrder = sortRaw === null ? null : Number(sortRaw);
  if (!name) return { error: "Item name is required" };
  if (name.length > 100) return { error: "Item name is too long (max 100 characters)" };
  if (sortOrder !== null && !Number.isInteger(sortOrder)) return { error: "Sort order must be a whole number" };
  return { v: { name, sortOrder, isActive: toBool(b.isActive) ?? true } };
};
 
// POST /api/departments/:id/inspection-items   { name, sortOrder?, isActive? }
router.post("/departments/:id/inspection-items", authenticateToken, manageOnly, async (req, res) => {
  const departmentId = toInt(req.params.id);
  if (!Number.isInteger(departmentId)) return res.status(400).json({ message: "Invalid department" });
  const { error, v } = readItem(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const dep = await pool.query("SELECT 1 FROM department WHERE id = $1", [departmentId]);
    if (dep.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    const r = await pool.query(
      `INSERT INTO inspection_item (department_id, name, sort_order, is_active)
       VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM inspection_item WHERE department_id = $1)), $4)
       RETURNING ${ITEM_COLS}`,
      [departmentId, v.name, v.sortOrder, v.isActive]
    );
    return res.status(201).json({ message: "Item added successfully", item: r.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ message: "This item already exists" });
    console.error("Error adding inspection item:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// PUT /api/inspection-items/:id   { name, sortOrder?, isActive }
router.put("/inspection-items/:id", authenticateToken, manageOnly, async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid item" });
  const { error, v } = readItem(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const r = await pool.query(
      `UPDATE inspection_item SET name = $1, sort_order = COALESCE($2, sort_order), is_active = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING ${ITEM_COLS}`,
      [v.name, v.sortOrder, v.isActive, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Item not found" });
    return res.json({ message: "Item updated successfully", item: r.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ message: "This item already exists" });
    console.error("Error updating inspection item:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// DELETE /api/inspection-items/:id  - removes the item from the checklist. Jobs that already used it keep their copy.
router.delete("/inspection-items/:id", authenticateToken, manageOnly, async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid item" });
  try {
    const r = await pool.query("DELETE FROM inspection_item WHERE id = $1", [id]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Item not found" });
    return res.json({ message: "Item removed" });
  } catch (error) {
    console.error("Error removing inspection item:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ================= The evidence stage of a job (stage 7; Detailing: stage 6) ================= */
const FILE_COLS = `id, item_id AS "itemId", file_name AS "fileName", file_url AS "fileUrl", file_type AS "fileType",
                   mime_type AS "mimeType", file_size AS "size", created_at AS "createdAt", category`;
const loadFiles = async (db, jobId) =>
  (await db.query(
    `SELECT f.id, f.item_id AS "itemId", i.name AS "itemName", f.file_name AS "fileName", f.file_url AS "fileUrl", f.file_type AS "fileType",
            f.mime_type AS "mimeType", f.file_size AS "size", f.created_at AS "createdAt", f.category
     FROM job_evidence_file f LEFT JOIN inspection_item i ON i.id = f.item_id WHERE f.job_id = $1 ORDER BY f.id`,
    [jobId]
  )).rows;
const MAX_FILES_PER_JOB = 80;
 
// "Sub concerns" = what the customer confirmed in the stage 8 Vehicle Damages Report (Repair / Deep check / Both).
// Returns [] when the damages report is not set up (create_damage_report_tables.sql not run) or nothing is confirmed.
async function loadSubConcerns(db, jobId) {
  try {
    const r = await db.query(
      `SELECT a.description, a.action FROM job_damage_report_agreed a
       JOIN job_damage_report r ON r.job_id = a.job_id
       WHERE a.job_id = $1 AND r.customer_decision = 'CONFIRMED' ORDER BY a.sort_order, a.id`,
      [jobId]
    );
    return r.rows;
  } catch (_) {
    return [];
  }
}
 
async function loadEvidence(db, jobId) {
  const [ev, items, dmg] = await Promise.all([
    db.query(
      `SELECT more_details AS "moreDetails", link_token AS "linkToken", link_sent_at AS "linkSentAt",
              sms_sent_at AS "smsSentAt", sms_sent_to AS "smsSentTo", updated_at AS "updatedAt"
       FROM job_evidence WHERE job_id = $1`,
      [jobId]
    ),
    db.query(
      `SELECT item_id AS "itemId", item_name AS "itemName", condition, photos_taken AS "photosTaken",
              videos_taken AS "videosTaken", note
       FROM job_evidence_item WHERE job_id = $1 ORDER BY id`,
      [jobId]
    ),
    db.query("SELECT description FROM job_evidence_damage WHERE job_id = $1 ORDER BY sort_order, id", [jobId]),
  ]);
  if (ev.rowCount === 0) return null;
  return { ...ev.rows[0], items: items.rows, damages: dmg.rows.map((d) => d.description) };
}
 
// GET /api/jobs/:id/vehicle-evidence
router.get("/jobs/:id/vehicle-evidence", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const jobRes = await pool.query(
      `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
              j.department_id AS "departmentId", d.name AS "departmentName",
              COALESCE(d.has_vehicle_evidence, false) AS "hasVehicleEvidence",
              COALESCE(d.evidence_stage_no, ${DEFAULT_EVIDENCE_STAGE_NO}) AS "evidenceStageNo",
              COALESCE(d.evidence_mode, 'FULL') AS "evidenceMode",
              (SELECT COALESCE(NULLIF(c.alt_contact_number, ''), c.contact_number) FROM customer c WHERE c.id = j.customer_id) AS "whatsappNumber"
       FROM job j LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`,
      [jobId]
    );
    if (jobRes.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const job = jobRes.rows[0];
    if (!job.departmentId) return res.status(409).json({ message: "This job has no department yet" });
    if (!job.hasVehicleEvidence) return res.status(409).json({ message: `Vehicle evidence is not used in the ${job.departmentName} department` });
 
    const [items, evidence, files, subConcerns] = await Promise.all([
      pool.query(`SELECT ${ITEM_COLS} FROM inspection_item WHERE department_id = $1 AND is_active ORDER BY sort_order, id`, [job.departmentId]),
      loadEvidence(pool, jobId),
      loadFiles(pool, jobId),
      loadSubConcerns(pool, jobId),
    ]);
    return res.json({
      job,
      evidenceStageNo: job.evidenceStageNo,
      canRecord: job.status === "IN_PROGRESS" && job.stageNo >= job.evidenceStageNo,
      canManage: await canManage(req),
      items: items.rows, // the current checklist; saved rows of removed / inactive items come inside evidence.items
      evidence,
      files, // photos / videos (itemId null = general)
      subConcerns, // confirmed in the stage 8 damages report: [{ description, action }]
    });
  } catch (error) {
    console.error("Error loading vehicle evidence:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// PUT /api/jobs/:id/vehicle-evidence
//   { items: [{ itemId, condition: OK|DAMAGED|NA, photosTaken, videosTaken, note? }], damages: ["..."], moreDetails? }
// Every checklist item is optional: only the answered items are sent / saved. At stage 7 the stage is completed and the job moves to stage 8.
router.put("/jobs/:id/vehicle-evidence", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const b = req.body || {};
 
  const rows = Array.isArray(b.items) ? b.items : [];
  const items = [];
  for (const r of rows) {
    const itemId = toInt(r?.itemId);
    const condition = clean(r?.condition);
    const note = clean(r?.note);
    if (!Number.isInteger(itemId)) return res.status(400).json({ message: "Invalid checklist item" });
    if (!CONDITIONS.includes(condition)) return res.status(400).json({ message: "Select OK, Damaged or N/A for every item you fill in" });
    if (note && note.length > 500) return res.status(400).json({ message: "A note is too long (max 500 characters)" });
    items.push({ itemId, condition, photos: toBool(r?.photosTaken) ?? false, videos: toBool(r?.videosTaken) ?? false, note });
  }
  if (new Set(items.map((i) => i.itemId)).size !== items.length) return res.status(400).json({ message: "Duplicate checklist item" });
 
  const damages = (Array.isArray(b.damages) ? b.damages : []).map(clean).filter(Boolean);
  if (damages.length > 30) return res.status(400).json({ message: "Too many damages listed (max 30)" });
  if (damages.some((d) => d.length > 300)) return res.status(400).json({ message: "A damage description is too long (max 300 characters)" });
  const moreDetails = clean(b.moreDetails);
  if (moreDetails && moreDetails.length > 2000) return res.status(400).json({ message: "More details is too long (max 2000 characters)" });
 
  const userId = currentUserId(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobRes = await client.query(
      `SELECT j.id, j.status, j.current_stage_no, j.department_id, COALESCE(d.has_vehicle_evidence, false) AS has_ev,
              COALESCE(d.evidence_stage_no, ${DEFAULT_EVIDENCE_STAGE_NO}) AS ev_stage
       FROM job j LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1 FOR UPDATE OF j`,
      [jobId]
    );
    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jobRes.rows[0];
    if (!job.has_ev) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Vehicle evidence is not used in this department" });
    }
    if (job.status !== "IN_PROGRESS" || job.current_stage_no < job.ev_stage) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This job is not ready for vehicle evidence" });
    }
 
    // the answered items must be real checklist items of this department (items left blank are simply skipped)
    const cat = await client.query("SELECT id, name FROM inspection_item WHERE department_id = $1", [job.department_id]);
    const byId = new Map(cat.rows.map((r) => [r.id, r]));
    if (items.some((i) => !byId.has(i.itemId))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "A checklist item no longer exists. Reload the window." });
    }
 
    await client.query(
      `INSERT INTO job_evidence (job_id, more_details, saved_by) VALUES ($1, $2, $3)
       ON CONFLICT (job_id) DO UPDATE SET more_details = EXCLUDED.more_details, saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
      [jobId, moreDetails, userId]
    );
    // replace the saved answers of this department's checklist (an item that is now blank is removed; rows of removed items stay)
    await client.query("DELETE FROM job_evidence_item WHERE job_id = $1 AND item_id = ANY($2::int[])", [jobId, cat.rows.map((r) => r.id)]);
    for (const i of items) {
      await client.query(
        `INSERT INTO job_evidence_item (job_id, item_id, item_name, condition, photos_taken, videos_taken, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [jobId, i.itemId, byId.get(i.itemId).name, i.condition, i.photos, i.videos, i.note]
      );
    }
    await client.query("DELETE FROM job_evidence_damage WHERE job_id = $1", [jobId]);
    for (let n = 0; n < damages.length; n++) {
      await client.query("INSERT INTO job_evidence_damage (job_id, description, sort_order) VALUES ($1, $2, $3)", [jobId, damages[n], n + 1]);
    }
 
    let currentStageNo = job.current_stage_no;
    if (job.current_stage_no === job.ev_stage) {
      const next = job.ev_stage + 1;
      await client.query(
        `UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`,
        [jobId, job.ev_stage, userId]
      );
      await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      currentStageNo = next;
    } else {
      await client.query("UPDATE job SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [jobId]);
    }
    await client.query("COMMIT");
    const sms = await smsEvidenceLink(req, jobId); // update -> SMS the customer link again
    return res.json({ message: "Vehicle evidence saved", currentStageNo, sms });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving vehicle evidence:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});
 
// GET /api/jobs/:id/pre-evidence -> { job, files, propertyInside, canAdd }
// Stage 4 "Vehicle Evidence": photos / videos + "Is there customer property inside the vehicle?" (Yes -> photos / videos of it), taken BEFORE the department is selected.
router.get("/jobs/:id/pre-evidence", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const j = await pool.query(`SELECT id, job_no AS "jobNo", reg_no AS "regNo", status, department_id AS "departmentId",
      (SELECT COALESCE(NULLIF(c.alt_contact_number, ''), c.contact_number) FROM customer c WHERE c.id = job.customer_id) AS "whatsappNumber"
      FROM job WHERE id = $1`, [jobId]);
    if (j.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const [files, ev] = await Promise.all([
      pool.query(`SELECT ${FILE_COLS} FROM job_evidence_file WHERE job_id = $1 ORDER BY id`, [jobId]),
      pool.query(`SELECT property_inside AS "propertyInside", more_details AS "remark", link_token AS "linkToken", link_sent_at AS "linkSentAt", sms_sent_at AS "smsSentAt", sms_sent_to AS "smsSentTo" FROM job_evidence WHERE job_id = $1`, [jobId]),
    ]);
    return res.json({
      job: j.rows[0], files: files.rows, propertyInside: ev.rows[0]?.propertyInside ?? null, remark: ev.rows[0]?.remark ?? "", link: ev.rows[0] ? { linkToken: ev.rows[0].linkToken, linkSentAt: ev.rows[0].linkSentAt, smsSentAt: ev.rows[0].smsSentAt, smsSentTo: ev.rows[0].smsSentTo } : null,
      canAdd: j.rows[0].status === "IN_PROGRESS" && !j.rows[0].departmentId,
    });
  } catch (error) {
    console.error("Error loading pre-evidence:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// PUT /api/jobs/:id/pre-evidence   { propertyInside: true | false | null, remark? }
router.put("/jobs/:id/pre-evidence", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const propertyInside = toBool(req.body?.propertyInside);
  const remark = clean(req.body?.remark);
  if (remark && remark.length > 2000) return res.status(400).json({ message: "The remark is too long (max 2000 characters)" });
  try {
    const j = await pool.query("SELECT status, department_id FROM job WHERE id = $1", [jobId]);
    if (j.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    if (j.rows[0].status !== "IN_PROGRESS" || j.rows[0].department_id) return res.status(409).json({ message: "The department is already selected" });
    await pool.query(
      `INSERT INTO job_evidence (job_id, property_inside, more_details, saved_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_id) DO UPDATE SET property_inside = EXCLUDED.property_inside, more_details = EXCLUDED.more_details,
         saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
      [jobId, propertyInside, remark, currentUserId(req)]
    );
    // evidence complete (photos + property answer [+ property photos]) -> SMS the customer link
    const f = await pool.query(`SELECT COUNT(*) FILTER (WHERE category <> 'PROPERTY' OR category IS NULL)::int AS general, COUNT(*) FILTER (WHERE category = 'PROPERTY')::int AS property FROM job_evidence_file WHERE job_id = $1`, [jobId]);
    const complete = f.rows[0].general > 0 && (propertyInside === false || f.rows[0].property > 0);
    const sms = complete ? await smsEvidenceLink(req, jobId) : null;
    return res.json({ message: "Saved", propertyInside, sms });
  } catch (error) {
    console.error("Error saving pre-evidence:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// POST /api/jobs/:id/vehicle-evidence/files   { itemId?, fileName, fileUrl, mimeType, size? }
// The browser uploads the (renamed) file to the file storage first, then registers it here.
router.post("/jobs/:id/vehicle-evidence/files", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const b = req.body || {};
  const itemId = b.itemId === null || b.itemId === undefined || b.itemId === "" ? null : toInt(b.itemId);
  const fileName = clean(b.fileName);
  const fileUrl = clean(b.fileUrl);
  const mime = clean(b.mimeType) || "";
  const category = b.category === "PROPERTY" ? "PROPERTY" : "GENERAL"; // PROPERTY = the customer's property inside the vehicle (stage 4)
  const size = b.size === undefined || b.size === null ? null : Number(b.size);
  if (Number.isNaN(itemId)) return res.status(400).json({ message: "Invalid checklist item" });
  if (!fileName || fileName.length > 200) return res.status(400).json({ message: "Invalid file name" });
  if (!fileUrl || fileUrl.length > 1000 || !/^https?:\/\//i.test(fileUrl)) return res.status(400).json({ message: "Invalid file URL" });
  const fileType = mime.startsWith("image/") ? "IMAGE" : mime.startsWith("video/") ? "VIDEO" : null;
  if (!fileType) return res.status(400).json({ message: "Only images and videos can be added" });
  if (size !== null && (!Number.isFinite(size) || size < 0)) return res.status(400).json({ message: "Invalid file size" });
  try {
    const job = await pool.query(
      `SELECT j.status, j.current_stage_no, j.department_id, COALESCE(d.has_vehicle_evidence, false) AS has_ev,
              COALESCE(d.evidence_stage_no, ${DEFAULT_EVIDENCE_STAGE_NO}) AS ev_stage
       FROM job j LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`,
      [jobId]
    );
    if (job.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const j = job.rows[0];
    const preDepartment = !j.department_id; // photos taken BEFORE the department is selected (no checklist item then)
    if (preDepartment) {
      if (j.status !== "IN_PROGRESS") return res.status(409).json({ message: "This job is not open" });
      if (itemId !== null) return res.status(400).json({ message: "Invalid checklist item" });
    } else {
      if (!j.has_ev) return res.status(409).json({ message: "Vehicle evidence is not used in this department" });
      if (j.status !== "IN_PROGRESS" || j.current_stage_no < j.ev_stage) return res.status(409).json({ message: "This job is not ready for vehicle evidence" });
    }
    if (!preDepartment && itemId !== null) {
      const it = await pool.query("SELECT 1 FROM inspection_item WHERE id = $1 AND department_id = $2", [itemId, j.department_id]);
      if (it.rowCount === 0) return res.status(400).json({ message: "Invalid checklist item" });
    }
    const cnt = await pool.query("SELECT COUNT(*)::int AS n FROM job_evidence_file WHERE job_id = $1", [jobId]);
    if (cnt.rows[0].n >= MAX_FILES_PER_JOB) return res.status(409).json({ message: `A job can have at most ${MAX_FILES_PER_JOB} photos / videos` });
    const r = await pool.query(
      `INSERT INTO job_evidence_file (job_id, item_id, file_name, file_url, file_type, mime_type, file_size, uploaded_by, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${FILE_COLS}`,
      [jobId, itemId, fileName, fileUrl, fileType, mime || null, size, currentUserId(req), category]
    );
    return res.status(201).json({ message: "File added", file: r.rows[0] });
  } catch (error) {
    console.error("Error adding evidence file:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// DELETE /api/vehicle-evidence/files/:id  (removes it from the job; the stored file itself is left in your storage)
router.delete("/vehicle-evidence/files/:id", authenticateToken, async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid file" });
  try {
    const r = await pool.query(
      `DELETE FROM job_evidence_file f USING job j
       WHERE f.id = $1 AND j.id = f.job_id AND j.status = 'IN_PROGRESS'`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "File not found, or the job is no longer open" });
    return res.json({ message: "File removed" });
  } catch (error) {
    console.error("Error removing evidence file:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// After every evidence save: make sure the customer link exists and SMS it to the customer (WhatsApp / alternative number first,
// then the main mobile). Never throws - returns { sent, to?, error? } for the window to show.
async function smsEvidenceLink(req, jobId, phoneOverride = null) {
  try {
    const r = await pool.query(
      `SELECT j.reg_no, e.link_token,
              COALESCE(NULLIF(c.alt_contact_number, ''), c.contact_number) AS phone, c.contact_number AS main_phone
       FROM job j JOIN customer c ON c.id = j.customer_id JOIN job_evidence e ON e.job_id = j.id WHERE j.id = $1`, [jobId]);
    if (r.rowCount === 0) return { sent: false, error: "Evidence is not saved yet" };
    const row = r.rows[0];
    const token = row.link_token || randomBytes(24).toString("hex");
    await pool.query("UPDATE job_evidence SET link_token = $1, link_sent_at = CURRENT_TIMESTAMP WHERE job_id = $2", [token, jobId]);
    const base = String(process.env.PUBLIC_APP_URL || req.headers.origin || "").replace(/\/+$/, "");
    if (!base) return { sent: false, error: "PUBLIC_APP_URL is not set on the server" };
    const text = `Vehicle evidence report for ${row.reg_no}: ${base}/evidence/${token}`;
    let out = await sendSms(phoneOverride || row.phone, text);
    if (!out.sent && !phoneOverride && row.main_phone && row.main_phone !== row.phone) out = await sendSms(row.main_phone, text); // fall back to the main number
    if (out.sent) await pool.query("UPDATE job_evidence SET sms_sent_at = CURRENT_TIMESTAMP, sms_sent_to = $1 WHERE job_id = $2", [out.to, jobId]);
    return out;
  } catch (e) {
    console.error("smsEvidenceLink failed:", e.message);
    return { sent: false, error: "Could not send the SMS" };
  }
}
 
// POST /api/jobs/:id/vehicle-evidence/sms   { phone? }  -> { sms: { sent, to?, error? } }
// "Send by SMS" button: sends the customer link to the typed number (default = the customer's WhatsApp / mobile number).
router.post("/jobs/:id/vehicle-evidence/sms", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const phone = clean(req.body?.phone);
  if (phone && !toSriLankaNumber(phone)) return res.status(400).json({ message: "Enter a valid mobile number (07XXXXXXXX)" });
  const sms = await smsEvidenceLink(req, jobId, phone);
  return res.json({ sms });
});
 
// POST /api/jobs/:id/vehicle-evidence/link  -> { token, path }
// Creates (once) the private customer link of the saved evidence and marks it as sent. The page itself is
// /evidence/<token> (public, read-only).
router.post("/jobs/:id/vehicle-evidence/link", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const cur = await pool.query("SELECT link_token FROM job_evidence WHERE job_id = $1", [jobId]);
    if (cur.rowCount === 0) return res.status(409).json({ message: "Save the vehicle evidence first" });
    const token = cur.rows[0].link_token || randomBytes(24).toString("hex");
    await pool.query("UPDATE job_evidence SET link_token = $1, link_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $2", [token, jobId]);
    return res.json({ message: "Customer link ready", token, path: `/evidence/${token}` });
  } catch (error) {
    console.error("Error creating the evidence link:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// GET /api/public/vehicle-evidence/:token   (NO login - the long random token is the key; no customer data is returned)
router.get("/public/vehicle-evidence/:token", async (req, res) => {
  const token = clean(req.params.token);
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return res.status(404).json({ message: "Report not found" });
  try {
    const r = await pool.query(
      `SELECT e.job_id, e.more_details AS "moreDetails", e.updated_at AS "updatedAt", j.job_no AS "jobNo", j.reg_no AS "regNo", d.name AS "departmentName",
              CASE WHEN d.id IS NULL THEN 'UPLOAD_ONLY' ELSE COALESCE(d.evidence_mode, 'FULL') END AS "evidenceMode",
              e.property_inside AS "propertyInside"
       FROM job_evidence e JOIN job j ON j.id = e.job_id LEFT JOIN department d ON d.id = j.department_id
       WHERE e.link_token = $1`,
      [token]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Report not found" });
    const { job_id: jobId, ...head } = r.rows[0];
    const ev = await loadEvidence(pool, jobId);
    return res.json({ ...head, items: ev.items, damages: ev.damages, files: await loadFiles(pool, jobId), subConcerns: await loadSubConcerns(pool, jobId) });
  } catch (error) {
    console.error("Error loading the public evidence report:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
module.exports = router;
 