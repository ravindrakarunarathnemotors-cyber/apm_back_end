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
const toInt = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) ? n : NaN;
};
 
async function loadJob(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
            j.department_id AS "departmentId", d.name AS "departmentName",
            COALESCE(d.has_job_end, false) AS "hasStage", d.job_end_stage_no AS "thisStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.thisStageNo && job.stageNo >= job.thisStageNo;
 
async function header(db, jobId) {
  const h = await db.query(
    `SELECT e.ended_at AS "endedAt", trim(concat(u1.first_name, ' ', u1.last_name)) AS "endedByName",
            e.copied_at AS "copiedAt", trim(concat(u2.first_name, ' ', u2.last_name)) AS "copiedByName"
     FROM job_end e LEFT JOIN admin_user u1 ON u1.id = e.ended_by LEFT JOIN admin_user u2 ON u2.id = e.copied_by WHERE e.job_id = $1`, [jobId]);
  return h.rows[0] || { endedAt: null, endedByName: null, copiedAt: null, copiedByName: null };
}
 
// GET /jobs/:id/job-end
router.get("/jobs/:id/job-end", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `This stage is not used in the ${job.departmentName || "selected"} department` });
    const header_ = await header(pool, jobId);
    return res.json({ job, header: header_, reached: reached(job), canRecord: reached(job) && !header_.copiedAt });
  } catch (e) { console.error("load job end:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/job-end/end   -> Job Completed
router.post("/jobs/:id/job-end/end", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!reached(job)) return res.status(409).json({ message: "This job is not ready for this stage" });
    await pool.query("INSERT INTO job_end (job_id) VALUES ($1) ON CONFLICT (job_id) DO NOTHING", [jobId]);
    await pool.query("UPDATE job_end SET ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP), ended_by = COALESCE(ended_by, $2) WHERE job_id = $1 AND copied_at IS NULL", [jobId, currentUserId(req)]);
    return res.json({ message: "Job Completed", header: await header(pool, jobId) });
  } catch (e) { console.error("job end:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/job-end/confirm   -> the job card is copied to the Account Department (Confirmed); the stage completes
router.post("/jobs/:id/job-end/confirm", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for this stage" }); }
    const h = await client.query("SELECT ended_at, copied_at FROM job_end WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (!h.rows[0]?.ended_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "End the job first (Job Completed)" }); }
    if (h.rows[0].copied_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Already confirmed" }); }
    const uid = currentUserId(req);
    await client.query("UPDATE job_end SET copied_at = CURRENT_TIMESTAMP, copied_by = $2 WHERE job_id = $1", [jobId, uid]);
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
    return res.json({ message: "Confirmed", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("job end confirm:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
module.exports = router;
 