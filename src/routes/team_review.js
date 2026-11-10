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


// The checklist of the Team Self-Inspection stage (same keys as team_inspection.routes.js)
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
            COALESCE(d.has_team_review, false) AS "hasStage", d.team_review_stage_no AS "thisStageNo",
            d.team_inspection_stage_no AS "teamStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.thisStageNo && job.stageNo >= job.thisStageNo;
 
const cleanExtras = (v) => (Array.isArray(v) ? v : []).slice(0, 30)
  .map((e) => ({ label: clean(e?.label)?.slice(0, 200), checked: e?.checked === true })).filter((e) => e.label);
 
async function state(db, job) {
  const [t, h, rounds] = await Promise.all([
    db.query(`SELECT checks, trial_needed AS "trialNeeded", COALESCE(trial_person, '') AS "trialPerson", COALESCE(job_card_note, '') AS "jobCardNote", completed_at AS "completedAt"
              FROM job_team_inspection WHERE job_id = $1`, [job.id]).catch(() => ({ rows: [] })),
    db.query(`SELECT round, approved_at AS "approvedAt", signed_by_name AS "signedByName", signature_image AS "signatureImage" FROM job_team_review WHERE job_id = $1`, [job.id]),
    db.query(`SELECT r.round, r.approved, COALESCE(r.note, '') AS note, r.extras, r.decided_at AS "decidedAt", trim(concat(u.first_name, ' ', u.last_name)) AS "decidedByName"
              FROM job_team_review_round r LEFT JOIN admin_user u ON u.id = r.decided_by WHERE r.job_id = $1 ORDER BY r.id`, [job.id]),
  ]);
  const insp = t.rows[0] || { checks: [], trialNeeded: null, trialPerson: "", jobCardNote: "", completedAt: null };
  const checks = Array.isArray(insp.checks) ? insp.checks : [];
  return {
    sheet: SHEET.map(([key, label]) => ({ key, label, checked: checks.includes(key) })),
    housekeeping: HOUSEKEEPING.map(([key, label]) => ({ key, label, checked: checks.includes(key) })),
    inspection: { trialNeeded: insp.trialNeeded, trialPerson: insp.trialPerson, jobCardNote: insp.jobCardNote, completedAt: insp.completedAt },
    header: h.rows[0] || { round: 1, approvedAt: null, signedByName: null, signatureImage: null },
    rounds: rounds.rows,
  };
}
 
// GET /jobs/:id/team-review
router.get("/jobs/:id/team-review", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `The team inspection review is not used in the ${job.departmentName || "selected"} department` });
    const st = await state(pool, job);
    return res.json({ job, ...st, reached: reached(job), canRecord: reached(job) && !st.header.approvedAt });
  } catch (e) { console.error("load team review:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/team-review
//   { approved: true,  signerName, signatureImage, extras? }  -> approved, the stage completes
//   { approved: false, note, extras? }                       -> Team Self-Inspection is reopened for the team to update the sheet
router.post("/jobs/:id/team-review", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const b = req.body || {};
  if (typeof b.approved !== "boolean") return res.status(400).json({ message: "Select Approved Yes or No" });
  const extras = cleanExtras(b.extras);
  const note = clean(b.note)?.slice(0, 1000) || null;
  const signerName = clean(b.signerName)?.slice(0, 120) || null;
  const signature = clean(b.signatureImage);
  if (b.approved) {
    if (!signerName) return res.status(400).json({ message: "Enter the name of the Department Head" });
    if (!signature || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > 400000) return res.status(400).json({ message: "The Department Head must draw the signature" });
  } else if (!note) return res.status(400).json({ message: "Enter what must be updated (the reason it is not approved)" });
 
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for the review stage" }); }
    const uid = currentUserId(req);
    await client.query("INSERT INTO job_team_review (job_id) VALUES ($1) ON CONFLICT (job_id) DO NOTHING", [jobId]);
    const h = await client.query("SELECT round, approved_at FROM job_team_review WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].approved_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Already approved" }); }
    const round = h.rows[0].round;
    await client.query("INSERT INTO job_team_review_round (job_id, round, approved, note, extras, decided_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
      [jobId, round, b.approved, b.approved ? null : note, JSON.stringify(extras), uid]);
 
    let stageNo = job.stageNo, reopened = false;
    if (b.approved) {
      await client.query("UPDATE job_team_review SET approved_at = CURRENT_TIMESTAMP, approved_by = $2, signed_by_name = $3, signature_image = $4 WHERE job_id = $1", [jobId, uid, signerName, signature]);
      if (job.stageNo === job.thisStageNo) {
        const next = job.thisStageNo + 1;
        await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.thisStageNo, uid]);
        await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
        await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
        stageNo = next;
      }
    } else {
      // not approved -> reopen Team Self-Inspection (the ticks stay, the team checks and updates them), next review round
      reopened = true;
      await client.query("UPDATE job_team_review SET round = round + 1 WHERE job_id = $1", [jobId]);
      await client.query("UPDATE job_team_inspection SET completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId]);
      if (job.stageNo >= job.thisStageNo) {
        await client.query(`UPDATE job_stage SET status = 'PENDING', started_at = NULL, completed_at = NULL, completed_by = NULL WHERE job_id = $1 AND stage_no = $2`, [jobId, job.thisStageNo]);
        await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', completed_at = NULL, completed_by = NULL WHERE job_id = $1 AND stage_no = $2`, [jobId, job.teamStageNo]);
        await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [job.teamStageNo, jobId]);
        stageNo = job.teamStageNo;
      }
    }
    await client.query("COMMIT");
    return res.json({ message: b.approved ? "Approved" : "Sent back to the team", approved: b.approved, reopened, currentStageNo: stageNo, stageCompleted: b.approved && stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("team review:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
module.exports = router;
 