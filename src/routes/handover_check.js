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

const ITEMS = [
  ["B", "Customer property is ready to return"],
  ["C", "Keys available"],
  ["D", "ERP updated"],
  ["E", "Customer awareness is ready to present"],
];
const KEYS = ITEMS.map((x) => x[0]);

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
            COALESCE(d.has_handover_check, false) AS "hasStage", d.handover_check_stage_no AS "thisStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.thisStageNo && job.stageNo >= job.thisStageNo;

const sanitize = (b = {}) => ({
  checks: [...new Set((Array.isArray(b.checks) ? b.checks : []).filter((k) => KEYS.includes(k)))],
  answer: b.answer === "YES" || b.answer === "RECHECK" ? b.answer : null,
  note: clean(b.note)?.slice(0, 1000) || null,
});

async function state(db, jobId) {
  const h = await db.query(`SELECT checks, answer, COALESCE(note, '') AS note, completed_at AS "completedAt" FROM job_handover_check WHERE job_id = $1`, [jobId]);
  const row = h.rows[0] || { checks: [], answer: null, note: "", completedAt: null };
  return { items: ITEMS.map(([key, label]) => ({ key, label })), header: { ...row, checks: Array.isArray(row.checks) ? row.checks : [] } };
}

async function save(db, jobId, d, uid) {
  await db.query(
    `INSERT INTO job_handover_check (job_id, checks, answer, note, saved_by) VALUES ($1, $2::jsonb, $3, $4, $5)
     ON CONFLICT (job_id) DO UPDATE SET checks = EXCLUDED.checks, answer = EXCLUDED.answer, note = EXCLUDED.note, saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
    [jobId, JSON.stringify(d.checks), d.answer, d.note, uid]);
}

// GET /jobs/:id/handover-check
router.get("/jobs/:id/handover-check", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `This stage is not used in the ${job.departmentName || "selected"} department` });
    const st = await state(pool, jobId);
    return res.json({ job, ...st, reached: reached(job), canRecord: reached(job) && !st.header.completedAt });
  } catch (e) { console.error("load handover check:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// PUT /jobs/:id/handover-check   { checks, answer, note }   (save; "Need to recheck" is saved here and the stage stays open)
router.put("/jobs/:id/handover-check", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!reached(job)) return res.status(409).json({ message: "This job is not ready for this stage" });
    const cur = await pool.query("SELECT completed_at FROM job_handover_check WHERE job_id = $1", [jobId]);
    if (cur.rows[0]?.completed_at) return res.status(409).json({ message: "This stage is already completed" });
    const d = sanitize(req.body);
    if (d.answer === "RECHECK" && !d.note) return res.status(400).json({ message: "Enter what must be rechecked" });
    await save(pool, jobId, d, currentUserId(req));
    return res.json({ ok: true, ...(await state(pool, jobId)) });
  } catch (e) { console.error("save handover check:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /jobs/:id/handover-check/complete   { checks, answer: "YES" }   every item must be ticked
router.post("/jobs/:id/handover-check/complete", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const d = sanitize(req.body);
  if (d.answer !== "YES") return res.status(400).json({ message: "Select Yes: all the facts are cleared" });
  const left = KEYS.filter((k) => !d.checks.includes(k));
  if (left.length) return res.status(400).json({ message: `Tick all the items first (${left.length} left)` });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for this stage" }); }
    const uid = currentUserId(req);
    await save(client, jobId, { ...d, note: null }, uid);
    const h = await client.query("SELECT completed_at FROM job_handover_check WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Already completed" }); }
    await client.query("UPDATE job_handover_check SET completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId]);
    let stageNo = job.stageNo;
    if (job.stageNo === job.thisStageNo) {
      const next = job.thisStageNo + 1;
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.thisStageNo, uid]);
      const has = await client.query("SELECT 1 FROM job_stage_master WHERE stage_no = $1", [next]);   // the last stage has no next one
      if (has.rowCount > 0) {
        await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
        await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
        stageNo = next;
      }
    }
    await client.query("COMMIT");
    return res.json({ message: "Completed", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("complete handover check:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

module.exports = router;