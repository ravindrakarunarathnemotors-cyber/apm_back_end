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
 
// The checklist (keys are stored in job_team_inspection.checks)
const SHEET = [
  ["S1", "Verify repair completion"],
  ["S2", "Check for leaks"],
  ["S3", "Verify fluid levels"],
  ["S4", "Ensure no warning lights remain"],
  ["S5", "Confirm engine starts normally"],
  ["S6", "Torque verification of tyres and other related"],
  ["S7", "Sign the job card / fill the job card detail"],
];
const HOUSEKEEPING = [
  ["H1", "Keep work area clean"],
  ["H2", "Remove waste immediately"],
  ["H3", "Account for all tools before vehicle release"],
  ["H4", "Remove cloths, packaging and foreign objects"],
];
const ALL_KEYS = [...SHEET, ...HOUSEKEEPING].map((x) => x[0]);
 
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
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) ? n : NaN;
};
 
async function loadJob(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
            j.department_id AS "departmentId", d.name AS "departmentName",
            COALESCE(d.has_team_inspection, false) AS "hasStage", d.team_inspection_stage_no AS "thisStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.thisStageNo && job.stageNo >= job.thisStageNo;
 
// normalise what the browser sends
function sanitize(b = {}) {
  const checks = [...new Set((Array.isArray(b.checks) ? b.checks : []).filter((k) => ALL_KEYS.includes(k)))];
  const trialNeeded = b.trialNeeded === true ? true : b.trialNeeded === false ? false : null;
  return {
    checks,
    trialNeeded,
    trialPerson: trialNeeded ? (clean(b.trialPerson)?.slice(0, 120) || null) : null,
    jobCardNote: clean(b.jobCardNote)?.slice(0, 1000) || null,
  };
}
 
async function state(db, job) {
  const h = await db.query(
    `SELECT checks, trial_needed AS "trialNeeded", COALESCE(trial_person, '') AS "trialPerson", COALESCE(job_card_note, '') AS "jobCardNote", completed_at AS "completedAt"
     FROM job_team_inspection WHERE job_id = $1`, [job.id]);
  // the Department Head sent it back (Review Team Inspection Sheet): what must be updated
  const fb = await db.query(
    `SELECT round, COALESCE(note, '') AS note, decided_at AS "decidedAt" FROM job_team_review_round WHERE job_id = $1 AND NOT approved ORDER BY id DESC LIMIT 1`, [job.id]).catch(() => ({ rows: [] }));
  const row = h.rows[0] || { checks: [], trialNeeded: null, trialPerson: "", jobCardNote: "", completedAt: null };
  return {
    sheet: SHEET.map(([key, label]) => ({ key, label })),
    housekeeping: HOUSEKEEPING.map(([key, label]) => ({ key, label })),
    header: { ...row, checks: Array.isArray(row.checks) ? row.checks : [] },
    returned: row.completedAt ? null : fb.rows[0] || null,
  };
}
 
async function save(db, jobId, d, uid) {
  await db.query(
    `INSERT INTO job_team_inspection (job_id, checks, trial_needed, trial_person, job_card_note, saved_by)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6)
     ON CONFLICT (job_id) DO UPDATE SET checks = EXCLUDED.checks, trial_needed = EXCLUDED.trial_needed, trial_person = EXCLUDED.trial_person,
       job_card_note = EXCLUDED.job_card_note, saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
    [jobId, JSON.stringify(d.checks), d.trialNeeded, d.trialPerson, d.jobCardNote, uid]);
}
 
// GET /jobs/:id/team-inspection
router.get("/jobs/:id/team-inspection", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `Team Self-Inspection is not used in the ${job.departmentName || "selected"} department` });
    const st = await state(pool, job);
    return res.json({ job, ...st, reached: reached(job), canRecord: reached(job) && !st.header.completedAt });
  } catch (e) { console.error("load team inspection:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /jobs/:id/team-inspection   { checks: [], trialNeeded, trialPerson, jobCardNote }   (save a draft)
router.put("/jobs/:id/team-inspection", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!reached(job)) return res.status(409).json({ message: "This job is not ready for the Team Self-Inspection stage" });
    const cur = await pool.query("SELECT completed_at FROM job_team_inspection WHERE job_id = $1", [jobId]);
    if (cur.rows[0]?.completed_at) return res.status(409).json({ message: "This stage is already completed" });
    await save(pool, jobId, sanitize(req.body), currentUserId(req));
    return res.json({ ok: true, ...(await state(pool, job)) });
  } catch (e) { console.error("save team inspection:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/team-inspection/complete   same body as PUT; every item must be ticked and the trial question answered
router.post("/jobs/:id/team-inspection/complete", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const d = sanitize(req.body);
  const missing = ALL_KEYS.filter((k) => !d.checks.includes(k));
  if (missing.length) return res.status(400).json({ message: `Tick all the items first (${missing.length} left)` });
  if (d.trialNeeded === null) return res.status(400).json({ message: "Select whether a trial is needed" });
  if (d.trialNeeded && !d.trialPerson) return res.status(400).json({ message: "Enter the responsible person for the trial" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for the Team Self-Inspection stage" }); }
    const uid = currentUserId(req);
    await save(client, jobId, d, uid);
    const h = await client.query("SELECT completed_at FROM job_team_inspection WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Already completed" }); }
    await client.query("UPDATE job_team_inspection SET completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId]);
    let stageNo = job.stageNo;
    if (job.stageNo === job.thisStageNo) {
      const next = job.thisStageNo + 1;
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.thisStageNo, uid]);
      await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      stageNo = next;
    }
    await client.query("COMMIT");
    return res.json({ message: "Team Self-Inspection completed", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("complete team inspection:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
module.exports = router;
module.exports.SHEET = SHEET;
module.exports.HOUSEKEEPING = HOUSEKEEPING;
 