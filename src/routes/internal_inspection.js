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



const SECTIONS = [
  ["PRE_REPAIR", "Pre-Repair Preparation"],
  ["PPE", "Personal Protective Equipment (PPE)"],
  ["VEHICLE_PROTECTION", "Customer Vehicle Protection"],
  ["SPARE_PARTS", "Spare Parts"],
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
  const s = clean(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
};

async function loadJob(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
            j.department_id AS "departmentId", d.name AS "departmentName",
            COALESCE(d.has_internal_inspection, false) AS "hasStage", d.internal_inspection_stage_no AS "stageNoOfThis",
            c.customer_name AS "customerName", c.contact_number AS "contactNumber"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.stageNoOfThis && job.stageNo >= job.stageNoOfThis;

async function state(db, job) {
  const [items, checks, extras, head, approval, parts] = await Promise.all([
    db.query(`SELECT id, section, label FROM internal_inspection_item WHERE department_id = $1 AND is_active ORDER BY sort_order, id`, [job.departmentId]),
    db.query(`SELECT item_id AS "itemId" FROM job_internal_inspection_check WHERE job_id = $1`, [job.id]),
    db.query(`SELECT id, section, label, checked FROM job_internal_inspection_extra WHERE job_id = $1 ORDER BY id`, [job.id]),
    db.query(`SELECT COALESCE(notes, '') AS notes, logistics_reminder_at AS "logisticsReminderAt", customer_reminder_at AS "customerReminderAt", completed_at AS "completedAt" FROM job_internal_inspection WHERE job_id = $1`, [job.id]),
    db.query(`SELECT parts_by AS "partsBy", agreed_scope AS "agreedScope", decision, est_hours::float AS "estHours", est_days::float AS "estDays", COALESCE(extra_note, '') AS "extraNote" FROM job_customer_approval WHERE job_id = $1`, [job.id]).catch(() => ({ rows: [] })),
    db.query(`SELECT name, brand, qty FROM job_spare_part WHERE job_id = $1 ORDER BY id`, [job.id]).catch(() => ({ rows: [] })),
  ]);
  const done = new Set(checks.rows.map((c) => c.itemId));
  return {
    sections: SECTIONS.map(([key, title]) => ({
      key, title,
      items: items.rows.filter((i) => i.section === key).map((i) => ({ id: i.id, label: i.label, checked: done.has(i.id) })),
      extras: extras.rows.filter((e) => e.section === key),
    })),
    header: head.rows[0] || { notes: "", logisticsReminderAt: null, customerReminderAt: null, completedAt: null },
    approval: approval.rows[0] || null,
    parts: parts.rows,
  };
}

// GET /jobs/:id/internal-inspection
router.get("/jobs/:id/internal-inspection", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `Internal Inspection is not used in the ${job.departmentName || "selected"} department` });
    const st = await state(pool, job);
    return res.json({ job, ...st, reached: reached(job), canRecord: reached(job) && !st.header.completedAt });
  } catch (e) { console.error("load internal inspection:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

async function guard(req, res) {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) { res.status(400).json({ message: "Invalid job" }); return null; }
  const job = await loadJob(pool, jobId);
  if (!job) { res.status(404).json({ message: "Job not found" }); return null; }
  if (!reached(job)) { res.status(409).json({ message: "This job is not ready for the Internal Inspection stage" }); return null; }
  const h = await pool.query("SELECT completed_at FROM job_internal_inspection WHERE job_id = $1", [jobId]);
  if (h.rows[0]?.completed_at) { res.status(409).json({ message: "This stage is already completed" }); return null; }
  return { job, jobId };
}

// PUT /jobs/:id/internal-inspection   { checkedItemIds: [], extras: [{ section, label, checked }], notes }
router.put("/jobs/:id/internal-inspection", authenticateToken, async (req, res) => {
  const g = await guard(req, res); if (!g) return;
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const ids = [...new Set((Array.isArray(b.checkedItemIds) ? b.checkedItemIds : []).map(Number).filter(Number.isInteger))];
    const keys = SECTIONS.map((s) => s[0]);
    const extras = (Array.isArray(b.extras) ? b.extras : []).slice(0, 40)
      .map((e) => ({ section: keys.includes(e?.section) ? e.section : null, label: clean(e?.label)?.slice(0, 200), checked: e?.checked === true }))
      .filter((e) => e.section && e.label);
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO job_internal_inspection (job_id, notes, saved_by) VALUES ($1, $2, $3)
       ON CONFLICT (job_id) DO UPDATE SET notes = EXCLUDED.notes, saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
      [g.jobId, clean(b.notes)?.slice(0, 1000) || null, currentUserId(req)]);
    await client.query("DELETE FROM job_internal_inspection_check WHERE job_id = $1", [g.jobId]);
    if (ids.length) {
      await client.query(
        `INSERT INTO job_internal_inspection_check (job_id, item_id)
         SELECT $1, id FROM internal_inspection_item WHERE id = ANY($2::int[]) AND department_id = $3 ON CONFLICT DO NOTHING`,
        [g.jobId, ids, g.job.departmentId]);
    }
    await client.query("DELETE FROM job_internal_inspection_extra WHERE job_id = $1", [g.jobId]);
    for (const e of extras) {
      await client.query("INSERT INTO job_internal_inspection_extra (job_id, section, label, checked) VALUES ($1, $2, $3, $4)", [g.jobId, e.section, e.label, e.checked]);
    }
    await client.query("COMMIT");
    return res.json({ ok: true, ...(await state(pool, g.job)) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("save internal inspection:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

// POST /jobs/:id/internal-inspection/reminder   { kind: "LOGISTICS" | "CUSTOMER" }
//   LOGISTICS = "Send reminders to the Logistic and Spare parts division" (SMS with the spare parts link when LOGISTICS_SMS_NUMBER is set)
//   CUSTOMER  = "Send customer reminders to bring spare parts" (recorded; the browser opens WhatsApp)
router.post("/jobs/:id/internal-inspection/reminder", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    const kind = req.body?.kind === "CUSTOMER" ? "CUSTOMER" : "LOGISTICS";
    let sms = null;
    if (kind === "LOGISTICS") {
      await pool.query("INSERT INTO job_spare_parts (job_id, saved_by) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING", [g.jobId, currentUserId(req)]);
      const cur = await pool.query("SELECT link_token FROM job_spare_parts WHERE job_id = $1", [g.jobId]);
      const token = cur.rows[0]?.link_token || randomBytes(24).toString("hex");
      await pool.query("UPDATE job_spare_parts SET link_token = $1, link_sent_at = COALESCE(link_sent_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE job_id = $2", [token, g.jobId]);
      const base = String(process.env.PUBLIC_APP_URL || req.headers.origin || "").replace(/\/+$/, "");
      if (process.env.LOGISTICS_SMS_NUMBER && base) {
        sms = await sendSms(process.env.LOGISTICS_SMS_NUMBER, `Reminder: spare parts for ${g.job.regNo} (${g.job.jobNo}) are needed for the repair. ${base}/spare-parts/${token}`);
      }
    }
    const col = kind === "LOGISTICS" ? "logistics_reminder_at" : "customer_reminder_at";
    await pool.query(
      `INSERT INTO job_internal_inspection (job_id, ${col}, saved_by) VALUES ($1, CURRENT_TIMESTAMP, $2)
       ON CONFLICT (job_id) DO UPDATE SET ${col} = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`, [g.jobId, currentUserId(req)]);
    return res.json({ sms, ...(await state(pool, g.job)) });
  } catch (e) { console.error("internal inspection reminder:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /jobs/:id/internal-inspection/complete
router.post("/jobs/:id/internal-inspection/complete", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for the Internal Inspection stage" }); }
    await client.query("INSERT INTO job_internal_inspection (job_id, saved_by) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING", [jobId, currentUserId(req)]);
    const h = await client.query("SELECT completed_at FROM job_internal_inspection WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Already completed" }); }
    await client.query("UPDATE job_internal_inspection SET completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId]);
    let stageNo = job.stageNo;
    if (job.stageNo === job.stageNoOfThis) {
      const next = job.stageNoOfThis + 1, uid = currentUserId(req);
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.stageNoOfThis, uid]);
      await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      stageNo = next;
    }
    await client.query("COMMIT");
    return res.json({ message: "Internal inspection completed", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("complete internal inspection:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

module.exports = router;