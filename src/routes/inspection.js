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

// Who may add / remove / alternate repair items and re-save AFTER the head mechanic has signed ("use security to edit").
// [] = nobody extra (the inspection is locked after signing);  [1] = role_id 1 (admin)
const EDIT_AFTER_SIGN_ROLE_IDS = [1];
 
const REPAIR_TYPES = [
  "I. Periodic Maintenance", "II. General Repairs", "III. Mechanical Repairs", "VII. Suspension Repairs",
  "VIII. Brake Repairs", "IX. Steering Repairs", "X. Air Conditioning Repairs", "XI. Warranty Repairs",
  "XII. Insurance Repairs", "XIII. Accident Repairs", "XIV. Pre-Delivery Inspection (PDI)", "XV. Used Vehicle Inspection",
];
const KINDS = ["FAULT", "IDENTIFIED_FAULT", "ROOT_CAUSE"];
 
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
const lines = (v) => (Array.isArray(v) ? v : []).map((x) => clean(x)).filter(Boolean);
 
async function hasEditRole(req) {
  const uid = currentUserId(req);
  if (!uid || EDIT_AFTER_SIGN_ROLE_IDS.length === 0) return false;
  const r = await pool.query("SELECT role_id FROM admin_user WHERE id = $1", [uid]);
  return r.rowCount > 0 && EDIT_AFTER_SIGN_ROLE_IDS.includes(Number(r.rows[0].role_id));
}
 
// the job + its department's inspection settings
async function loadJob(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
            j.department_id AS "departmentId", d.name AS "departmentName",
            COALESCE(d.has_job_inspection, false) AS "hasJobInspection", d.job_inspection_stage_no AS "inspectionStageNo",
            COALESCE(d.has_spare_parts, false) AS "hasSpareParts", d.spare_parts_stage_no AS "spareStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`,
    [jobId]
  );
  return r.rows[0] || null;
}
 
// can this user record now?  (job open, department uses the inspection, the stage has been reached, and not locked by the signature)
async function recordRights(req, job, signed) {
  const reached = job.status === "IN_PROGRESS" && job.hasJobInspection && job.stageNo >= job.inspectionStageNo;
  const editRole = signed ? await hasEditRole(req) : true;
  return { canRecord: reached && editRole, reached, locked: reached && signed && !editRole };
}
 
const ITEM_SELECT = `SELECT id, description, repair_type AS "repairType", amount::float AS amount, COALESCE(qty, 1) AS qty,
                            COALESCE(unit_price, amount / GREATEST(COALESCE(qty, 1), 1))::float AS "unitPrice", status,
                            replaces_item_id AS "replacesItemId", changed_at AS "changedAt", COALESCE(warranty_claim, false) AS "warrantyClaim" FROM job_repair_item`;
 
async function loadAll(db, job) {
  const jobId = job.id;
  const [ins, items, files, repairs, concerns, hist, groupRows, treeRows] = await Promise.all([
    db.query(
      `SELECT i.test_run AS "testRun", i.faults_found AS "faultsFound", i.previous_repair AS "previousRepair", i.new_repair AS "newRepair",
              i.warranty, i.history_remarks AS "historyRemarks", i.repair_types AS "repairTypes", COALESCE(i.extra_parents, '[]'::jsonb) AS "extraParents",
              i.signed_by_name AS "signedByName", i.signature_image AS "signatureImage", i.signed_at AS "signedAt", i.updated_at AS "updatedAt"
       FROM job_inspection i WHERE i.job_id = $1`, [jobId]),
    db.query(`SELECT kind, description FROM job_inspection_item WHERE job_id = $1 ORDER BY kind, sort_order, id`, [jobId]),
    db.query(`SELECT id, file_name AS "fileName", file_url AS "fileUrl", mime_type AS "mimeType", created_at AS "createdAt" FROM job_inspection_file WHERE job_id = $1 ORDER BY id`, [jobId]),
    db.query(`${ITEM_SELECT} WHERE job_id = $1 ORDER BY id`, [jobId]),
    db.query(
      `SELECT jc.complaint, o.concern_level AS "level", o.list_title AS "listTitle", o.option_name AS "name"
       FROM job_complaint jc LEFT JOIN job_complaint_option o ON o.job_complaint_id = jc.id WHERE jc.job_id = $1 ORDER BY o.id`, [jobId]),
    db.query(
      `SELECT job_no AS "jobNo", status, created_at AS "createdAt" FROM job WHERE reg_no = $1 AND id <> $2 ORDER BY id DESC LIMIT 5`,
      [job.regNo, jobId]),
    // The repair types picked in the complaint stage (parents) and the child types (with labour price) defined under them
    db.query(
      `SELECT jco.option_name AS parent, c.id AS "childId", c.name AS "childName", c.price::float AS price
       FROM job_complaint jc
       JOIN job_complaint_option jco ON jco.job_complaint_id = jc.id AND jco.list_title ILIKE '%repair type%'
       LEFT JOIN complaint_option p ON p.id = jco.option_id
       LEFT JOIN complaint_option c ON c.list_id = p.list_id AND c.is_active
            AND lower(btrim(c.group_name)) = lower(btrim(p.name))
       WHERE jc.job_id = $1
       ORDER BY jco.id, c.sort_order, c.id`, [jobId]),
    // Every repair type (so the mechanic can add one that was not picked in the complaint stage). The job's own department comes
    // first; the repair types of the other departments follow, so they can be added too.
    db.query(
      `SELECT p.name AS parent, c.id AS "childId", c.name AS "childName", c.price::float AS price,
              d.name AS department, (l.department_id = $1) AS "isCurrent"
       FROM complaint_option_list l
       JOIN department d ON d.id = l.department_id AND d.is_active
       JOIN complaint_option p ON p.list_id = l.id AND p.is_active AND btrim(COALESCE(p.group_name, '')) = ''
       LEFT JOIN complaint_option c ON c.list_id = l.id AND c.is_active AND lower(btrim(c.group_name)) = lower(btrim(p.name))
       WHERE l.is_active AND (l.code ILIKE '%\_TYPE' OR l.title ILIKE '%repair type%' OR l.title ILIKE '%concern type%')
       ORDER BY (l.department_id = $1) DESC, d.name, p.sort_order, p.id, c.sort_order, c.id`, [job.departmentId]),
  ]);
  const repairTree = [];
  for (const r of treeRows.rows) {
    let g = repairTree.find((x) => x.parent === r.parent && x.department === r.department);
    if (!g) { g = { parent: r.parent, department: r.department, isCurrent: r.isCurrent, children: [] }; repairTree.push(g); }
    if (r.childId) g.children.push({ id: r.childId, name: r.childName, price: r.price, label: `${r.parent} > ${r.childName}` });
  }
  const repairGroups = [];
  for (const r of groupRows.rows) {
    let g = repairGroups.find((x) => x.parent === r.parent);
    if (!g) { g = { parent: r.parent, children: [] }; repairGroups.push(g); }
    if (r.childId) g.children.push({ id: r.childId, name: r.childName, price: r.price, label: `${r.parent} > ${r.childName}` });
  }
  const of = (k) => items.rows.filter((r) => r.kind === k).map((r) => r.description);
  const active = repairs.rows.filter((r) => r.status === "ACTIVE");
  const main = concerns.rows.filter((r) => r.name && r.level === "MAIN").map((r) => ({ title: r.listTitle, name: r.name }));
  const sub = concerns.rows.filter((r) => r.name && r.level === "SUB").map((r) => ({ title: r.listTitle, name: r.name }));
  return {
    inspection: ins.rows[0] || null,
    faults: of("FAULT"), identifiedFaults: of("IDENTIFIED_FAULT"), rootCauses: of("ROOT_CAUSE"),
    scannerFiles: files.rows,
    repairItems: repairs.rows,
    totalRepairValue: active.filter((r) => !r.warrantyClaim).reduce((s, r) => s + Number(r.amount), 0),
    concerns: { complaint: concerns.rows[0]?.complaint || "", main, sub },
    history: hist.rows,
    repairGroups, repairTree,
  };
}
 
// GET /jobs/:id/inspection  (any logged-in user can read it, so other departments can open the scanner report / repair list)
router.get("/jobs/:id/inspection", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasJobInspection) return res.status(409).json({ message: `The job inspection is not used in the ${job.departmentName || "selected"} department` });
    const data = await loadAll(pool, job);
    const signed = Boolean(data.inspection?.signedAt);
    const rights = await recordRights(req, job, signed);
    const dynamic = data.repairGroups.flatMap((g) => [g.parent, ...g.children.map((c) => c.label)]);
    const mk = await pool.query("SELECT COALESCE(price_markup_percent, 0)::float AS p FROM job WHERE id = $1", [jobId]).catch(() => ({ rows: [] }));
    return res.json({ job, ...data, signed, ...rights, markupPercent: mk.rows[0]?.p || 0, markupOptions: await markupOptions(pool), repairTypes: dynamic.length ? dynamic : REPAIR_TYPES });
  } catch (error) {
    console.error("Error loading the job inspection:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// PUT /jobs/:id/inspection
// { testRun, faultsFound, faults[], identifiedFaults[], rootCauses[], previousRepair, newRepair, warranty, historyRemarks,
//   repairTypes[], complete?, signerName? }
// complete = true -> the head mechanic signs, stage 7 is completed and the job moves on.
router.put("/jobs/:id/inspection", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const b = req.body || {};
  const testRun = ["NECESSARY", "NOT_NECESSARY"].includes(b.testRun) ? b.testRun : null;
  const faultsFound = toBool(b.faultsFound);
  const faults = faultsFound === false ? [] : lines(b.faults);
  const identified = lines(b.identifiedFaults);
  const roots = lines(b.rootCauses);
  if ([...faults, ...identified, ...roots].some((x) => x.length > 300)) return res.status(400).json({ message: "A line is too long (max 300 characters)" });
  const repairTypes = (Array.isArray(b.repairTypes) ? b.repairTypes : []).map((t) => String(t).trim()).filter((t) => t && t.length <= 200).slice(0, 100);
  const historyRemarks = clean(b.historyRemarks);
  // repair types added from a department: [{ parent, department }]
  const extraParents = (Array.isArray(b.extraParents) ? b.extraParents : []).map((x) => ({ parent: String(x?.parent || "").trim().slice(0, 200), department: String(x?.department || "").trim().slice(0, 100) })).filter((x) => x.parent).slice(0, 50);
  if (historyRemarks && historyRemarks.length > 2000) return res.status(400).json({ message: "The history remarks are too long (max 2000 characters)" });
  const complete = b.complete === true;
  const signerName = clean(b.signerName);
  const signatureImage = clean(b.signatureImage);
  if (signatureImage && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureImage) || signatureImage.length > 400000)) return res.status(400).json({ message: "The signature image is not valid" });
  if (complete) {
    if (!testRun) return res.status(400).json({ message: "Select whether a test run is necessary" });
    if (faultsFound === null) return res.status(400).json({ message: "Select Record Faults or No Faults Found" });
    if (faultsFound && faults.length === 0) return res.status(400).json({ message: "Record at least one fault" });
    if (!signerName || signerName.length < 2 || signerName.length > 100) return res.status(400).json({ message: "Enter the head mechanic name" });
    if (!signatureImage) return res.status(400).json({ message: "The head mechanic must draw the signature" });
  }
 
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!job.hasJobInspection) { await client.query("ROLLBACK"); return res.status(409).json({ message: "The job inspection is not used in this department" }); }
    const cur = await client.query("SELECT signed_at FROM job_inspection WHERE job_id = $1 FOR UPDATE", [jobId]);
    const signed = Boolean(cur.rows[0]?.signed_at);
    const rights = await recordRights(req, job, signed);
    if (!rights.reached) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for the job inspection" }); }
    if (!rights.canRecord) { await client.query("ROLLBACK"); return res.status(403).json({ message: "The head mechanic has signed this inspection. Only an authorised user can change it." }); }
 
    // The spare parts are recorded in this same window (departments whose spare parts stage follows the inspection stage).
    // Signing therefore needs the spare parts list (or "No spare parts needed") and completes the spare parts stage too.
    const mergeSpare = Boolean(complete && job.hasSpareParts && job.stageNo === job.inspectionStageNo && job.spareStageNo === job.inspectionStageNo + 1);
    if (mergeSpare) {
      const sp = await client.query("SELECT COUNT(*)::int AS n FROM job_spare_part WHERE job_id = $1", [jobId]);
      const hd = await client.query("SELECT no_parts_needed FROM job_spare_parts WHERE job_id = $1", [jobId]);
      if (sp.rows[0].n === 0 && !hd.rows[0]?.no_parts_needed) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Add the spare parts, or tick 'No spare parts needed'" }); }
    }
 
    const userId = currentUserId(req);
    await client.query(
      `INSERT INTO job_inspection (job_id, test_run, faults_found, previous_repair, new_repair, warranty, history_remarks, repair_types, saved_by, extra_parents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (job_id) DO UPDATE SET test_run = EXCLUDED.test_run, faults_found = EXCLUDED.faults_found,
         previous_repair = EXCLUDED.previous_repair, new_repair = EXCLUDED.new_repair, warranty = EXCLUDED.warranty,
         history_remarks = EXCLUDED.history_remarks, repair_types = EXCLUDED.repair_types, saved_by = EXCLUDED.saved_by, extra_parents = EXCLUDED.extra_parents, updated_at = CURRENT_TIMESTAMP`,
      [jobId, testRun, faultsFound, toBool(b.previousRepair), toBool(b.newRepair), toBool(b.warranty), historyRemarks, repairTypes, userId, JSON.stringify(extraParents)]
    );
    // warranty claims only make sense while "Warranty available?" is Yes
    if (toBool(b.warranty) !== true) {
      await client.query("UPDATE job_repair_item SET warranty_claim = false WHERE job_id = $1 AND warranty_claim", [jobId]);
      await client.query("UPDATE job_spare_part SET warranty_claim = false WHERE job_id = $1 AND warranty_claim", [jobId]).catch(() => {});
    }
    await client.query("DELETE FROM job_inspection_item WHERE job_id = $1", [jobId]);
    for (const [kind, arr] of [["FAULT", faults], ["IDENTIFIED_FAULT", identified], ["ROOT_CAUSE", roots]]) {
      for (let n = 0; n < arr.length; n++) {
        await client.query("INSERT INTO job_inspection_item (job_id, kind, description, sort_order) VALUES ($1, $2, $3, $4)", [jobId, kind, arr[n], n + 1]);
      }
    }
 
    let stageNo = job.stageNo;
    let spareCompleted = false;
    if (complete) {
      await client.query(
        "UPDATE job_inspection SET signed_by_name = $1, signed_by_user = $2, signature_image = $3, signed_at = CURRENT_TIMESTAMP WHERE job_id = $4",
        [signerName, userId, signatureImage, jobId]
      );
      if (job.stageNo === job.inspectionStageNo) {
        const next = job.inspectionStageNo + 1;
        await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.inspectionStageNo, userId]);
        await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
        await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
        stageNo = next;
        if (mergeSpare) {
          const after = job.spareStageNo + 1;
          await client.query("INSERT INTO job_spare_parts (job_id, saved_by) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING", [jobId, userId]);
          await client.query("UPDATE job_spare_parts SET completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId]);
          await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.spareStageNo, userId]);
          await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, after]);
          await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [after, jobId]);
          stageNo = after;
          spareCompleted = true;
        }
      }
    }
    await client.query("UPDATE job SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [jobId]);
    await client.query("COMMIT");
    return res.json({ message: complete ? "Job inspection signed" : "Job inspection saved", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo, spareCompleted });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving the job inspection:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});
 
// ---- helpers for the small routes below: job + rights, or an error response ----
async function guard(req, res) {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) { res.status(400).json({ message: "Invalid job" }); return null; }
  const job = await loadJob(pool, jobId);
  if (!job) { res.status(404).json({ message: "Job not found" }); return null; }
  if (!job.hasJobInspection) { res.status(409).json({ message: "The job inspection is not used in this department" }); return null; }
  const s = await pool.query("SELECT signed_at FROM job_inspection WHERE job_id = $1", [jobId]);
  const rights = await recordRights(req, job, Boolean(s.rows[0]?.signed_at));
  if (!rights.reached) { res.status(409).json({ message: "This job is not ready for the job inspection" }); return null; }
  if (!rights.canRecord) { res.status(403).json({ message: "The head mechanic has signed this inspection. Only an authorised user can change it." }); return null; }
  return { job, jobId };
}
const repairList = async (jobId) => {
  const r = await pool.query(`${ITEM_SELECT} WHERE job_id = $1 ORDER BY id`, [jobId]);
  return { repairItems: r.rows, totalRepairValue: r.rows.filter((x) => x.status === "ACTIVE" && !x.warrantyClaim).reduce((s, x) => s + Number(x.amount), 0) };
};
const readItem = (b) => {
  const description = clean(b?.description);
  // the line has a quantity and a unit price; "amount" stays the LINE TOTAL (qty x unit price) so the other stages read it as before
  const qty = Number(b?.qty ?? 1);
  const unitPrice = Number(b?.unitPrice ?? b?.amount ?? 0);
  const repairType = clean(b?.repairType);
  if (!description) return { error: "Enter the repair item" };
  if (description.length > 300) return { error: "The repair item is too long (max 300 characters)" };
  if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return { error: "Enter a valid quantity (1 or more)" };
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 999999999) return { error: "Enter a valid unit price" };
  const amount = Math.round(qty * unitPrice * 100) / 100;
  if (amount > 999999999) return { error: "The amount is too large" };
  if (repairType && repairType.length > 200) return { error: "Invalid repair type" };
  return { description, qty, unitPrice: Math.round(unitPrice * 100) / 100, amount, repairType };
};
 
// POST /jobs/:id/inspection/repair-items   { description, amount, repairType? }   -> add
router.post("/jobs/:id/inspection/repair-items", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    const v = readItem(req.body); if (v.error) return res.status(400).json({ message: v.error });
    await pool.query("INSERT INTO job_repair_item (job_id, description, repair_type, qty, unit_price, amount, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)", [g.jobId, v.description, v.repairType, v.qty, v.unitPrice, v.amount, currentUserId(req)]);
    return res.status(201).json(await repairList(g.jobId));
  } catch (e) { console.error("add repair item:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /jobs/:id/inspection/repair-items/:itemId   { description, amount, repairType? }   -> ALTERNATE: the old line is kept as ALTERNATED, a new line replaces it
router.put("/jobs/:id/inspection/repair-items/:itemId", authenticateToken, async (req, res) => {
  const itemId = toInt(req.params.itemId);
  if (!Number.isInteger(itemId)) return res.status(400).json({ message: "Invalid item" });
  try {
    const g = await guard(req, res); if (!g) return;
    const v = readItem(req.body); if (v.error) return res.status(400).json({ message: v.error });
    const uid = currentUserId(req);
    const upd = await pool.query("UPDATE job_repair_item SET status = 'ALTERNATED', changed_by = $3, changed_at = CURRENT_TIMESTAMP WHERE id = $1 AND job_id = $2 AND status = 'ACTIVE' RETURNING id", [itemId, g.jobId, uid]);
    if (upd.rowCount === 0) return res.status(404).json({ message: "Repair item not found" });
    await pool.query("INSERT INTO job_repair_item (job_id, description, repair_type, qty, unit_price, amount, replaces_item_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [g.jobId, v.description, v.repairType, v.qty, v.unitPrice, v.amount, itemId, uid]);
    return res.json(await repairList(g.jobId));
  } catch (e) { console.error("alternate repair item:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /jobs/:id/inspection/markup   { percent }   -> price adjustment for the whole job (0, 2, 5, 8, 10 or 12 %)
// the price adjustment (markup %) options of Settings > Pricing (always includes 0 = none); the old fixed list when nothing is saved
async function markupOptions(db) {
  try {
    const r = await db.query("SELECT value FROM app_setting WHERE group_key = 'pricing' AND key = 'adjustmentOptions'");
    const v = r.rows[0]?.value;
    if (Array.isArray(v)) { const l = v.map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x <= 50); return [...new Set([0, ...l])].sort((a, b) => a - b); }
  } catch (_) { /* the settings table does not exist yet */ }
  return [0, 2, 5, 8, 10, 12];
}
router.put("/jobs/:id/inspection/markup", authenticateToken, async (req, res) => {
  const percent = Number(req.body?.percent ?? 0);
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) return res.status(400).json({ message: "Select the price adjustment from the list" });
  try {
    const g = await guard(req, res); if (!g) return;
    const opts = await markupOptions(pool);
    const cur = (await pool.query("SELECT COALESCE(price_markup_percent, 0)::float AS p FROM job WHERE id = $1", [g.jobId]).catch(() => ({ rows: [] }))).rows[0]?.p;
    if (!opts.includes(percent) && percent !== cur) return res.status(400).json({ message: `Select one of: ${opts.map((x) => (x === 0 ? "None" : `${x}%`)).join(", ")}` });
    await pool.query("UPDATE job SET price_markup_percent = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [percent, g.jobId]);
    return res.json({ markupPercent: percent });
  } catch (e) { console.error("set markup:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PATCH /jobs/:id/inspection/repair-items/:itemId/qty   { qty }   -> change only the quantity of an active line (amount = qty x unit price)
router.patch("/jobs/:id/inspection/repair-items/:itemId/qty", authenticateToken, async (req, res) => {
  const itemId = toInt(req.params.itemId);
  if (!Number.isInteger(itemId)) return res.status(400).json({ message: "Invalid item" });
  const qty = Number(req.body?.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return res.status(400).json({ message: "Enter a valid quantity (1 or more)" });
  try {
    const g = await guard(req, res); if (!g) return;
    const r = await pool.query(
      `UPDATE job_repair_item
          SET unit_price = COALESCE(unit_price, amount / GREATEST(COALESCE(qty, 1), 1)),
              qty = $3::int,
              amount = ROUND(COALESCE(unit_price, amount / GREATEST(COALESCE(qty, 1), 1)) * $3::int, 2),
              changed_by = $4, changed_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND job_id = $2 AND status = 'ACTIVE' RETURNING id`, [itemId, g.jobId, qty, currentUserId(req)]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Repair item not found" });
    return res.json(await repairList(g.jobId));
  } catch (e) { console.error("repair item qty:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PATCH /jobs/:id/inspection/repair-items/:itemId/warranty   { claim }   -> mark / unmark an active line as a warranty claim (not charged)
router.patch("/jobs/:id/inspection/repair-items/:itemId/warranty", authenticateToken, async (req, res) => {
  const itemId = toInt(req.params.itemId);
  if (!Number.isInteger(itemId)) return res.status(400).json({ message: "Invalid item" });
  try {
    const g = await guard(req, res); if (!g) return;
    const r = await pool.query("UPDATE job_repair_item SET warranty_claim = $3::boolean, changed_by = $4, changed_at = CURRENT_TIMESTAMP WHERE id = $1 AND job_id = $2 AND status = 'ACTIVE' RETURNING id", [itemId, g.jobId, Boolean(req.body?.claim), currentUserId(req)]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Repair item not found" });
    return res.json(await repairList(g.jobId));
  } catch (e) { console.error("repair item warranty:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// DELETE /jobs/:id/inspection/repair-items/:itemId   -> remove (kept as REMOVED so the history stays)
router.delete("/jobs/:id/inspection/repair-items/:itemId", authenticateToken, async (req, res) => {
  const itemId = toInt(req.params.itemId);
  if (!Number.isInteger(itemId)) return res.status(400).json({ message: "Invalid item" });
  try {
    const g = await guard(req, res); if (!g) return;
    const r = await pool.query("UPDATE job_repair_item SET status = 'REMOVED', changed_by = $3, changed_at = CURRENT_TIMESTAMP WHERE id = $1 AND job_id = $2 AND status = 'ACTIVE' RETURNING id", [itemId, g.jobId, currentUserId(req)]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Repair item not found" });
    return res.json(await repairList(g.jobId));
  } catch (e) { console.error("remove repair item:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/inspection/files   { fileName, fileUrl, mimeType, size? }   (the browser uploads to /file/upload first, then registers it here)
router.post("/jobs/:id/inspection/files", authenticateToken, async (req, res) => {
  const fileName = clean(req.body?.fileName), fileUrl = clean(req.body?.fileUrl);
  if (!fileName || !fileUrl) return res.status(400).json({ message: "fileName and fileUrl are required" });
  try {
    const g = await guard(req, res); if (!g) return;
    const r = await pool.query(
      `INSERT INTO job_inspection_file (job_id, file_name, file_url, mime_type, size_bytes, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, file_name AS "fileName", file_url AS "fileUrl", mime_type AS "mimeType", created_at AS "createdAt"`,
      [g.jobId, fileName.slice(0, 255), fileUrl, clean(req.body?.mimeType)?.slice(0, 100) || null, toInt(req.body?.size) || null, currentUserId(req)]
    );
    return res.status(201).json(r.rows[0]);
  } catch (e) { console.error("add inspection file:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// DELETE /inspection/files/:fileId
router.delete("/inspection/files/:fileId", authenticateToken, async (req, res) => {
  const fileId = toInt(req.params.fileId);
  if (!Number.isInteger(fileId)) return res.status(400).json({ message: "Invalid file" });
  try {
    const f = await pool.query("SELECT job_id FROM job_inspection_file WHERE id = $1", [fileId]);
    if (f.rowCount === 0) return res.status(404).json({ message: "File not found" });
    req.params.id = String(f.rows[0].job_id);
    const g = await guard(req, res); if (!g) return;
    await pool.query("DELETE FROM job_inspection_file WHERE id = $1", [fileId]);
    return res.json({ message: "Removed" });
  } catch (e) { console.error("remove inspection file:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
module.exports = router;
 