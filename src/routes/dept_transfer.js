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

 
const FIRST_DEPARTMENT_STAGE = 5;   // the new job starts at the complaint stage of its department
 
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
            COALESCE(d.has_dept_transfer, false) AS "hasStage", d.dept_transfer_stage_no AS "thisStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.thisStageNo && job.stageNo >= job.thisStageNo;
 
async function state(db, job) {
  const [deps, done, head] = await Promise.all([
    db.query(`SELECT id, name FROM department WHERE is_active AND show_in_job_stage AND id <> $1 ORDER BY sort_order, id`, [job.departmentId]),
    db.query(`SELECT t.department_id AS "departmentId", d.name AS "departmentName", t.transferred, t.new_job_id AS "newJobId", nj.job_no AS "newJobNo"
              FROM job_dept_transfer t JOIN department d ON d.id = t.department_id LEFT JOIN job nj ON nj.id = t.new_job_id WHERE t.job_id = $1`, [job.id]),
    db.query(`SELECT completed_at AS "completedAt" FROM job_dept_transfer_header WHERE job_id = $1`, [job.id]),
  ]);
  return {
    departments: deps.rows,       // the departments the job can be transferred to (one is selected)
    saved: done.rows,             // the transfer already made
    header: head.rows[0] || { completedAt: null },
  };
}
 
// GET /jobs/:id/dept-transfer
router.get("/jobs/:id/dept-transfer", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `Department transfer is not used in the ${job.departmentName || "selected"} department` });
    const st = await state(pool, job);
    return res.json({ job, ...st, reached: reached(job), canRecord: reached(job) && !st.header.completedAt });
  } catch (e) { console.error("load dept transfer:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/dept-transfer   { transfer: true|false, departmentId? }
//   No  -> the stage completes without a transfer.
//   Yes -> exactly one department is selected; a linked job is created there and the stage completes.
router.post("/jobs/:id/dept-transfer", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  if (typeof req.body?.transfer !== "boolean") return res.status(400).json({ message: "Select Yes or No" });
  const transfer = req.body.transfer;
  const departmentId = toInt(req.body?.departmentId);
  if (transfer && !Number.isInteger(departmentId)) return res.status(400).json({ message: "Select the department" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for the transfer stage" }); }
    const uid = currentUserId(req);
    await client.query("INSERT INTO job_dept_transfer_header (job_id) VALUES ($1) ON CONFLICT (job_id) DO NOTHING", [jobId]);
    const h = await client.query("SELECT completed_at FROM job_dept_transfer_header WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This stage is already completed" }); }
 
    const created = [];
    if (transfer) {
      const st = await state(client, job);
      if (!st.departments.some((d) => d.id === departmentId)) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Invalid department" }); }
      // the related department's process: a new linked job for the same customer & vehicle, department selected, starting at the complaint stage
      const seq = await client.query("SELECT nextval(pg_get_serial_sequence('job', 'id')) AS id");
      const newJobId = Number(seq.rows[0].id);
      const newJobNo = `JOB-${String(newJobId).padStart(5, "0")}`;
      await client.query(
        `INSERT INTO job
           (id, job_no, customer_id, vehicle_id, consultant_id, reg_no, year_of_manufacture, mileage_km,
            colour, chassis_no, engine_no, tyre_size, appointment_date, appointment_time, customer_matter, appointment_department_id, sales_officer, vehicle_type,
            department_id, current_stage_no, status, created_by, source_job_id)
         SELECT $1::int, $2, customer_id, vehicle_id, consultant_id, reg_no, year_of_manufacture, mileage_km,
                colour, chassis_no, engine_no, tyre_size, appointment_date, appointment_time, customer_matter, appointment_department_id, sales_officer, vehicle_type,
                $3::int, $4::int, 'IN_PROGRESS', $5::int, id
         FROM job WHERE id = $6::int`,
        [newJobId, newJobNo, departmentId, FIRST_DEPARTMENT_STAGE, uid, jobId]);
      await client.query(
        `INSERT INTO job_stage (job_id, stage_no, status, started_at, completed_at, completed_by)
         SELECT $1::int, stage_no,
                CASE WHEN stage_no < $2::int THEN 'COMPLETED' WHEN stage_no = $2::int THEN 'IN_PROGRESS' ELSE 'PENDING' END,
                CASE WHEN stage_no <= $2::int THEN CURRENT_TIMESTAMP END,
                CASE WHEN stage_no < $2::int THEN CURRENT_TIMESTAMP END,
                CASE WHEN stage_no < $2::int THEN $3::int END
         FROM job_stage_master`,
        [newJobId, FIRST_DEPARTMENT_STAGE, uid]);
      await client.query("INSERT INTO job_dept_transfer (job_id, department_id, transferred, new_job_id, decided_by) VALUES ($1, $2, true, $3, $4) ON CONFLICT (job_id, department_id) DO UPDATE SET transferred = true, new_job_id = EXCLUDED.new_job_id, decided_by = EXCLUDED.decided_by, decided_at = CURRENT_TIMESTAMP", [jobId, departmentId, newJobId, uid]);
      created.push({ departmentId, jobId: newJobId, jobNo: newJobNo });
    }
 
    await client.query("UPDATE job_dept_transfer_header SET completed_at = CURRENT_TIMESTAMP, completed_by = $2 WHERE job_id = $1", [jobId, uid]);
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
    return res.json({ message: created.length ? "Transferred" : "Completed", created, currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("dept transfer:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
module.exports = router;
 