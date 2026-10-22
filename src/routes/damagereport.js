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

dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();
 
const DEFAULT_REPORT_STAGE_NO = 8;
const ACTIONS = ["REPAIR", "DEEP_CHECK", "BOTH"];
const DECISIONS = ["CONFIRMED", "DECLINED"];
 
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
 
/* ---------- helpers ---------- */
const JOB_SQL = `
  SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
         j.department_id AS "departmentId", d.name AS "departmentName",
         COALESCE(d.has_damage_report, false) AS "hasDamageReport",
         COALESCE(d.damage_report_stage_no, ${DEFAULT_REPORT_STAGE_NO}) AS "reportStageNo"
  FROM job j LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`;
 
async function loadReport(db, jobId) {
  const [rep, dmg, agr, lnk] = await Promise.all([
    db.query(
      `SELECT skipped, need_deep_check AS "needDeepCheck", need_repair AS "needRepair", confirm_token AS "confirmToken",
              confirm_sent_at AS "confirmSentAt", customer_decision AS decision, decided_via AS "decidedVia",
              decided_at AS "decidedAt", customer_note AS "customerNote", updated_at AS "updatedAt"
       FROM job_damage_report WHERE job_id = $1`,
      [jobId]
    ),
    db.query("SELECT description FROM job_damage_report_damage WHERE job_id = $1 ORDER BY sort_order, id", [jobId]),
    db.query("SELECT description, action FROM job_damage_report_agreed WHERE job_id = $1 ORDER BY sort_order, id", [jobId]),
    db.query("SELECT damage_no, file_id FROM job_damage_report_damage_file WHERE job_id = $1 ORDER BY file_id", [jobId]),
  ]);
  if (rep.rowCount === 0) return null;
  // damages: [{ description, fileIds: [evidence file ids] }]  (a = first)
  const damages = dmg.rows.map((d, n) => ({ description: d.description, fileIds: lnk.rows.filter((l) => l.damage_no === n + 1).map((l) => l.file_id) }));
  return { ...rep.rows[0], damages, agreed: agr.rows };
}
 
// every photo / video of the job (evidence stage + the ones added in the report)
const loadJobFiles = async (db, jobId) =>
  (await db.query(
    `SELECT id, item_id AS "itemId", file_name AS "fileName", file_url AS "fileUrl", file_type AS "fileType", created_at AS "createdAt"
     FROM job_evidence_file WHERE job_id = $1 ORDER BY id`,
    [jobId]
  )).rows;
 
// The stage is finished when it was skipped, or nothing needs a deep check / repair, or the customer has answered.
const isFinished = (r) => Boolean(r && (r.skipped || (r.needDeepCheck === false && r.needRepair === false) || r.decision));
 
// Completes the report stage (and moves the job on) when the job is exactly at that stage and the report is finished.
async function completeIfFinished(client, jobId, reportStageNo, userId) {
  const job = await client.query("SELECT status, current_stage_no FROM job WHERE id = $1 FOR UPDATE", [jobId]);
  if (job.rowCount === 0) return null;
  const { status, current_stage_no: cur } = job.rows[0];
  if (status !== "IN_PROGRESS" || cur !== reportStageNo) return cur;
  const rep = await loadReport(client, jobId);
  if (!isFinished(rep)) return cur;
  const next = reportStageNo + 1;
  await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, reportStageNo, userId]);
  await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
  await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
  return next;
}
 
/* ================= lookup by department NAME ================= */
// GET /api/damage-report-department/:name -> { id, name, hasDamageReport, damageReportStageNo }
router.get("/damage-report-department/:name", authenticateToken, async (req, res) => {
  const name = clean(req.params.name);
  if (!name) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(
      `SELECT id, name, COALESCE(has_damage_report, false) AS "hasDamageReport",
              COALESCE(damage_report_stage_no, ${DEFAULT_REPORT_STAGE_NO}) AS "damageReportStageNo"
       FROM department WHERE lower(name) = lower($1)`,
      [name]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    return res.json(r.rows[0]);
  } catch (error) {
    console.error("Error loading the damage report department:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
/* ================= the report of a job ================= */
// GET /api/jobs/:id/damage-report
router.get("/jobs/:id/damage-report", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const jr = await pool.query(JOB_SQL, [jobId]);
    if (jr.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const job = jr.rows[0];
    if (!job.departmentId) return res.status(409).json({ message: "This job has no department yet" });
    if (!job.hasDamageReport) return res.status(409).json({ message: `The damages report is not used in the ${job.departmentName} department` });
 
    const [report, ev, evDamages, files] = await Promise.all([
      loadReport(pool, jobId),
      pool.query(`SELECT link_token AS "linkToken", link_sent_at AS "linkSentAt" FROM job_evidence WHERE job_id = $1`, [jobId]),
      pool.query("SELECT description FROM job_evidence_damage WHERE job_id = $1 ORDER BY sort_order, id", [jobId]),
      loadJobFiles(pool, jobId),
    ]);
    return res.json({
      job,
      reportStageNo: job.reportStageNo,
      canRecord: job.status === "IN_PROGRESS" && job.stageNo >= job.reportStageNo,
      report, // null until saved
      evidence: ev.rows[0] || null, // the stage 7 customer link (the "report sent to customer")
      evidenceDamages: evDamages.rows.map((d) => d.description), // pre-fills "Considerable damage found"
      files, // all photos / videos of the job: a damage can use any of them
    });
  } catch (error) {
    console.error("Error loading the damage report:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// PUT /api/jobs/:id/damage-report
//   { skip: true }                                                    -> "Skip this step: Yes"
//   { skip: false, damages: [".."], needDeepCheck, needRepair, agreed: [{ description, action: REPAIR|DEEP_CHECK|BOTH }] }
router.put("/jobs/:id/damage-report", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const b = req.body || {};
  const skip = b.skip === true || b.skip === "true";
 
  let damages = [];
  let needDeep = null;
  let needRepair = null;
  let agreed = [];
  if (!skip) {
    // each damage: "text"  or  { description, fileIds: [evidence file ids] }
    damages = (Array.isArray(b.damages) ? b.damages : [])
      .map((d) => (typeof d === "string" ? { description: clean(d), fileIds: [] } : { description: clean(d?.description), fileIds: [...new Set((Array.isArray(d?.fileIds) ? d.fileIds : []).map(toInt))] }))
      .filter((d) => d.description);
    if (damages.length > 30) return res.status(400).json({ message: "Too many damages listed (max 30)" });
    if (damages.some((d) => d.description.length > 300)) return res.status(400).json({ message: "A damage description is too long (max 300 characters)" });
    if (damages.some((d) => d.fileIds.some((f) => !Number.isInteger(f)) || d.fileIds.length > 40)) return res.status(400).json({ message: "Invalid photo / video" });
    needDeep = toBool(b.needDeepCheck);
    needRepair = toBool(b.needRepair);
    if (needDeep || needRepair) {
      for (const a of Array.isArray(b.agreed) ? b.agreed : []) {
        const description = clean(a?.description);
        if (!description) continue; // blank line
        if (description.length > 300) return res.status(400).json({ message: "An agreed item is too long (max 300 characters)" });
        if (!ACTIONS.includes(a?.action)) return res.status(400).json({ message: "Select Repair, Deep check or Both for every agreed item" });
        agreed.push({ description, action: a.action });
      }
      if (agreed.length > 30) return res.status(400).json({ message: "Too many agreed items (max 30)" });
      if (agreed.length === 0) return res.status(400).json({ message: "Write what was agreed to do (a, b, c ...)" });
    }
  }
 
  const userId = currentUserId(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jr = await client.query(JOB_SQL.replace("WHERE j.id = $1", "WHERE j.id = $1 FOR UPDATE OF j"), [jobId]);
    if (jr.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jr.rows[0];
    if (!job.hasDamageReport) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "The damages report is not used in this department" });
    }
    if (job.status !== "IN_PROGRESS" || job.stageNo < job.reportStageNo) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This job is not ready for the damages report" });
    }
    const cur = await loadReport(client, jobId);
    if (cur?.decision) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "The customer has already answered. Reset the answer first to change the report." });
    }
 
    await client.query(
      `INSERT INTO job_damage_report (job_id, skipped, need_deep_check, need_repair, saved_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_id) DO UPDATE SET skipped = EXCLUDED.skipped, need_deep_check = EXCLUDED.need_deep_check,
         need_repair = EXCLUDED.need_repair, saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
      [jobId, skip, needDeep, needRepair, userId]
    );
    // photos / videos can only be the ones of this job
    const allIds = [...new Set(damages.flatMap((d) => d.fileIds))];
    if (allIds.length) {
      const ok = await client.query("SELECT id FROM job_evidence_file WHERE job_id = $1 AND id = ANY($2::int[])", [jobId, allIds]);
      if (ok.rowCount !== allIds.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "A selected photo / video no longer exists. Reload the window." });
      }
    }
    await client.query("DELETE FROM job_damage_report_damage_file WHERE job_id = $1", [jobId]);
    await client.query("DELETE FROM job_damage_report_damage WHERE job_id = $1", [jobId]);
    for (let n = 0; n < damages.length; n++) {
      await client.query("INSERT INTO job_damage_report_damage (job_id, description, sort_order) VALUES ($1, $2, $3)", [jobId, damages[n].description, n + 1]);
      for (const fid of damages[n].fileIds) {
        await client.query("INSERT INTO job_damage_report_damage_file (job_id, damage_no, file_id) VALUES ($1, $2, $3)", [jobId, n + 1, fid]);
      }
    }
    await client.query("DELETE FROM job_damage_report_agreed WHERE job_id = $1", [jobId]);
    for (let n = 0; n < agreed.length; n++) {
      await client.query("INSERT INTO job_damage_report_agreed (job_id, description, action, sort_order) VALUES ($1, $2, $3, $4)", [jobId, agreed[n].description, agreed[n].action, n + 1]);
    }
 
    const stageNo = await completeIfFinished(client, jobId, job.reportStageNo, userId);
    if (stageNo === job.stageNo) await client.query("UPDATE job SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [jobId]);
    await client.query("COMMIT");
    return res.json({ message: skip ? "Step skipped" : "Damages report saved", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving the damage report:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});
 
// POST /api/jobs/:id/damage-report/link -> { token, path }   private link for the customer to confirm what was agreed
router.post("/jobs/:id/damage-report/link", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const rep = await loadReport(pool, jobId);
    if (!rep || rep.skipped) return res.status(409).json({ message: "Save the damages report first" });
    const token = rep.confirmToken || randomBytes(24).toString("hex");
    await pool.query("UPDATE job_damage_report SET confirm_token = $1, confirm_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $2", [token, jobId]);
    return res.json({ message: "Customer link ready", token, path: `/damage-report/${token}` });
  } catch (error) {
    console.error("Error creating the damage report link:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// POST /api/jobs/:id/damage-report/decision   { decision: "CONFIRMED" | "DECLINED" | null, note? }
// Staff records the customer's answer (e.g. given by phone). decision null = reset the answer.
router.post("/jobs/:id/damage-report/decision", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const decision = req.body?.decision === null || req.body?.decision === undefined ? null : String(req.body.decision);
  const note = clean(req.body?.note);
  if (decision !== null && !DECISIONS.includes(decision)) return res.status(400).json({ message: "Invalid answer" });
  if (note && note.length > 500) return res.status(400).json({ message: "The note is too long (max 500 characters)" });
  const userId = currentUserId(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jr = await client.query(JOB_SQL.replace("WHERE j.id = $1", "WHERE j.id = $1 FOR UPDATE OF j"), [jobId]);
    if (jr.rowCount === 0 || !jr.rows[0].hasDamageReport) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jr.rows[0];
    const rep = await loadReport(client, jobId);
    if (!rep || rep.skipped || rep.agreed.length === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Save the damages report with what was agreed first" });
    }
    if (decision === null) {
      await client.query("UPDATE job_damage_report SET customer_decision = NULL, decided_via = NULL, decided_at = NULL, decided_by = NULL, customer_note = NULL, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId]);
    } else {
      await client.query(
        `UPDATE job_damage_report SET customer_decision = $2, decided_via = 'STAFF', decided_at = CURRENT_TIMESTAMP, decided_by = $3,
                customer_note = $4, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1`,
        [jobId, decision, userId, note]
      );
    }
    const stageNo = decision ? await completeIfFinished(client, jobId, job.reportStageNo, userId) : job.stageNo;
    await client.query("COMMIT");
    return res.json({ message: decision ? "Customer answer saved" : "Customer answer reset", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving the customer answer:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});
 
/* ================= public pages for the customer (NO login - the long random token is the key) ================= */
const validToken = (t) => Boolean(t && /^[a-f0-9]{16,64}$/.test(t));
 
// GET /api/public/damage-report/:token  (no customer data is returned)
router.get("/public/damage-report/:token", async (req, res) => {
  const token = clean(req.params.token);
  if (!validToken(token)) return res.status(404).json({ message: "Report not found" });
  try {
    const r = await pool.query(
      `SELECT r.job_id, r.need_deep_check AS "needDeepCheck", r.need_repair AS "needRepair", r.customer_decision AS decision,
              r.decided_at AS "decidedAt", r.customer_note AS "customerNote", j.job_no AS "jobNo", j.reg_no AS "regNo", d.name AS "departmentName"
       FROM job_damage_report r JOIN job j ON j.id = r.job_id LEFT JOIN department d ON d.id = j.department_id
       WHERE r.confirm_token = $1 AND NOT r.skipped`,
      [token]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Report not found" });
    const { job_id: jobId, ...head } = r.rows[0];
    const rep = await loadReport(pool, jobId);
    const files = await loadJobFiles(pool, jobId);
    const damages = rep.damages.map((d) => ({ description: d.description, files: d.fileIds.map((id) => files.find((f) => f.id === id)).filter(Boolean).map((f) => ({ fileUrl: f.fileUrl, fileType: f.fileType, fileName: f.fileName })) }));
    return res.json({ ...head, damages, agreed: rep.agreed });
  } catch (error) {
    console.error("Error loading the public damage report:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// POST /api/public/damage-report/:token/decision   { decision: "CONFIRMED" | "DECLINED", note? }  - answers only once
router.post("/public/damage-report/:token/decision", async (req, res) => {
  const token = clean(req.params.token);
  if (!validToken(token)) return res.status(404).json({ message: "Report not found" });
  const decision = String(req.body?.decision || "");
  const note = clean(req.body?.note);
  if (!DECISIONS.includes(decision)) return res.status(400).json({ message: "Invalid answer" });
  if (note && note.length > 500) return res.status(400).json({ message: "The note is too long (max 500 characters)" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `SELECT r.job_id, r.customer_decision, COALESCE(d.damage_report_stage_no, ${DEFAULT_REPORT_STAGE_NO}) AS rep_stage
       FROM job_damage_report r JOIN job j ON j.id = r.job_id LEFT JOIN department d ON d.id = j.department_id
       WHERE r.confirm_token = $1 AND NOT r.skipped FOR UPDATE OF r`,
      [token]
    );
    if (r.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Report not found" });
    }
    if (r.rows[0].customer_decision) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This has already been answered", decision: r.rows[0].customer_decision });
    }
    const jobId = r.rows[0].job_id;
    await client.query(
      `UPDATE job_damage_report SET customer_decision = $2, decided_via = 'LINK', decided_at = CURRENT_TIMESTAMP, decided_by = NULL,
              customer_note = $3, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1`,
      [jobId, decision, note]
    );
    await completeIfFinished(client, jobId, r.rows[0].rep_stage, null);
    await client.query("COMMIT");
    return res.json({ message: "Thank you. Your answer has been recorded.", decision });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving the customer's answer:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});
 
module.exports = router;
 