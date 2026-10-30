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
            COALESCE(d.has_job_activation, false) AS "hasStage", d.job_activation_stage_no AS "thisStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.thisStageNo && job.stageNo >= job.thisStageNo;
 
async function summary(db, jobId) {
  const [a, parts, insp] = await Promise.all([
    db.query(`SELECT est_hours::float AS "estHours", est_days::float AS "estDays", decision, agreed_scope AS "agreedScope", parts_by AS "partsBy",
                     estimated_total::float AS "estimatedTotal", COALESCE(extra_note, '') AS "extraNote"
              FROM job_customer_approval WHERE job_id = $1`, [jobId]).catch(() => ({ rows: [] })),
    db.query(`SELECT COUNT(*)::int AS n FROM job_spare_part WHERE job_id = $1`, [jobId]).catch(() => ({ rows: [{ n: 0 }] })),
    db.query(`SELECT COALESCE(notes, '') AS notes FROM job_internal_inspection WHERE job_id = $1`, [jobId]).catch(() => ({ rows: [] })),
  ]);
  return { approval: a.rows[0] || null, partsCount: parts.rows[0].n, inspectionNotes: insp.rows[0]?.notes || "" };
}
 
// GET /jobs/:id/job-activation
router.get("/jobs/:id/job-activation", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `Job Activation is not used in the ${job.departmentName || "selected"} department` });
    const h = await pool.query(
      `SELECT a.activated_at AS "activatedAt", trim(concat(u.first_name, ' ', u.last_name)) AS "activatedByName"
       FROM job_activation a LEFT JOIN admin_user u ON u.id = a.activated_by WHERE a.job_id = $1`, [jobId]).catch(() => ({ rows: [] }));
    const header = h.rows[0] || { activatedAt: null, activatedByName: null };
    return res.json({ job, header, ...(await summary(pool, jobId)), reached: reached(job), canRecord: reached(job) && !header.activatedAt });
  } catch (e) { console.error("load job activation:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/job-activation  { aware: true }  -> the job officially starts and moves to the next stage
router.post("/jobs/:id/job-activation", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  if (req.body?.aware !== true) return res.status(400).json({ message: "Confirm that you are fully aware of this job" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for the Job Activation stage" }); }
    const uid = currentUserId(req);
    await client.query("INSERT INTO job_activation (job_id) VALUES ($1) ON CONFLICT (job_id) DO NOTHING", [jobId]);
    const h = await client.query("SELECT activated_at FROM job_activation WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].activated_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is already activated" }); }
    await client.query("UPDATE job_activation SET aware = true, activated_at = CURRENT_TIMESTAMP, activated_by = $2 WHERE job_id = $1", [jobId, uid]);
    let stageNo = job.stageNo;
    if (job.stageNo === job.thisStageNo) {
      const next = job.thisStageNo + 1;
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.thisStageNo, uid]);
      await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      stageNo = next;
    }
    await client.query("COMMIT");
    return res.json({ message: "The job has officially started", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("job activation:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
module.exports = router;
 