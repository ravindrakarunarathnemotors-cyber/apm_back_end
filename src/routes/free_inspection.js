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
            COALESCE(d.has_free_inspection, false) AS "hasStage", d.free_inspection_stage_no AS "thisStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.thisStageNo && job.stageNo >= job.thisStageNo;

async function state(db) {
  return (await db.query("SELECT id, name FROM department WHERE is_active AND show_in_job_stage ORDER BY sort_order, id")).rows;
}
async function header(db, jobId) {
  const h = await db.query(
    `SELECT f.explained, f.willing, to_char(f.sched_date, 'YYYY-MM-DD') AS "schedDate", to_char(f.sched_time, 'HH24:MI') AS "schedTime",
            f.sched_department_id AS "schedDepartmentId", d.name AS "schedDepartmentName",
            f.signed_by_name AS "signedByName", f.signature_image AS "signatureImage", f.completed_at AS "completedAt"
     FROM job_free_inspection f LEFT JOIN department d ON d.id = f.sched_department_id WHERE f.job_id = $1`, [jobId]);
  return h.rows[0] || { explained: null, willing: null, schedDate: null, schedTime: null, schedDepartmentId: null, schedDepartmentName: null, signedByName: null, signatureImage: null, completedAt: null };
}

// GET /jobs/:id/free-inspection
router.get("/jobs/:id/free-inspection", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `This stage is not used in the ${job.departmentName || "selected"} department` });
    const [departments, h] = await Promise.all([state(pool), header(pool, jobId)]);
    return res.json({ job, departments, header: h, reached: reached(job), canRecord: reached(job) && !h.completedAt });
  } catch (e) { console.error("load free inspection:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /jobs/:id/free-inspection/complete
//   { explained: true, willing: "YES"|"NOT_NOW", schedDate?, schedTime?, schedDepartmentId?, signerName, signatureImage }
router.post("/jobs/:id/free-inspection/complete", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const b = req.body || {};
  if (b.explained !== true) return res.status(400).json({ message: "Explain why this is important to the customer first (Done)" });
  if (b.willing !== "YES" && b.willing !== "NOT_NOW") return res.status(400).json({ message: "Select the customer willingness: Yes / Not now" });
  const yes = b.willing === "YES";
  const date = clean(b.schedDate), time = clean(b.schedTime), deptId = toInt(b.schedDepartmentId);
  if (yes) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: "Select the schedule date" });
    if (!time || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ message: "Select the schedule time" });
    if (!Number.isInteger(deptId)) return res.status(400).json({ message: "Select the schedule department" });
  }
  const signerName = clean(b.signerName)?.slice(0, 120) || null;
  const signature = clean(b.signatureImage);
  if (!signerName) return res.status(400).json({ message: "Select the Department Head" });
  if (!signature || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > 400000) return res.status(400).json({ message: "The Department Head must draw the signature" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for this stage" }); }
    if (yes) {
      const d = await client.query("SELECT 1 FROM department WHERE id = $1 AND is_active", [deptId]);
      if (d.rowCount === 0) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Invalid department" }); }
    }
    const uid = currentUserId(req);
    await client.query("INSERT INTO job_free_inspection (job_id) VALUES ($1) ON CONFLICT (job_id) DO NOTHING", [jobId]);
    const h = await client.query("SELECT completed_at FROM job_free_inspection WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Already completed" }); }
    await client.query(
      `UPDATE job_free_inspection SET explained = true, willing = $2, sched_date = $3, sched_time = $4, sched_department_id = $5,
              signed_by_name = $6, signature_image = $7, completed_at = CURRENT_TIMESTAMP, completed_by = $8 WHERE job_id = $1`,
      [jobId, b.willing, yes ? date : null, yes ? time : null, yes ? deptId : null, signerName, signature, uid]);
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
    return res.json({ message: "GREAT JOB", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("complete free inspection:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

module.exports = router;