// routes/wash_delivery.routes.js   (NEW file)
// Wash "Delivery Review" stage: checklist a-f, OTP sent to the customer's mobile to release the vehicle,
// "Are you all done?" Yes (JOB Done Confirmed) / Need to recheck.
// Mount (same prefix as the other stage routes):   app.use("/evidence", require("./routes/wash_delivery.routes"));      (needs express.json())
// Run wash_delivery_review.sql first.
const crypto = require("crypto");
const express = require("express");
const router = express.Router();

// the file names differ between projects: the first one that exists is used
function tryLoad(paths) {
  for (const q of paths) {
    try { return require(q); } catch (e) { if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes(`'${q}'`)) throw e; }
  }
  return null;
}
const pool = tryLoad(["../config/db", "../db"]);
const authenticateToken = tryLoad(["../middleware/authMiddleware", "../middleware/authenticateToken"]);
if (!pool || !authenticateToken) throw new Error("wash_delivery: the db / auth middleware path is wrong (check the two require lines at the top)");
const perms = tryLoad(["./permissions"]); // requirePermission("washdelivery.override")
const requireOverride = perms?.requirePermission ? perms.requirePermission("washdelivery.override") : (_req, res) => res.status(503).json({ message: "permissions.routes was not found on the server" });
const sms = tryLoad(["../services/sms.service", "./sms.service", "../sms.service"]); // SMSlenz sender (sendSms(to, text, { kind }))

const ITEMS = [
  ["A", "Check payment review (if the payment is done)"],
  ["B", "Provide maintenance guide"],
  ["C", "Customer awareness"],
  ["D", "Key handover"],
  ["E", "Issue warranty certificate handed over"],
  ["F", "Explain future needs if required"],
];
const KEYS = ITEMS.map((x) => x[0]);
const OTP_MINUTES = 10;       // the code is valid for 10 minutes
const OTP_RESEND_SECONDS = 60; // the next SMS can be sent after 1 minute
const OTP_MAX_ATTEMPTS = 5;   // wrong codes before a new OTP is needed

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
const hashCode = (jobId, code) => crypto.createHash("sha256").update(`${jobId}:${code}:${process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || "otp"}`).digest("hex");
const maskPhone = (p) => { const s = String(p || "").replace(/\s+/g, ""); return s.length > 5 ? `${s.slice(0, 2)}${"*".repeat(s.length - 5)}${s.slice(-3)}` : s; };

async function loadJob(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo", j.source_job_id AS "sourceJobId",
            j.department_id AS "departmentId", d.name AS "departmentName",
            COALESCE(d.has_wash_delivery, false) AS "hasStage", d.wash_delivery_stage_no AS "thisStageNo",
            c.customer_name AS "customerName", c.contact_number AS "phone"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.thisStageNo && job.stageNo >= job.thisStageNo;

const sanitize = (b = {}) => ({
  checks: [...new Set((Array.isArray(b.checks) ? b.checks : []).filter((k) => KEYS.includes(k)))],
  answer: b.answer === "YES" || b.answer === "RECHECK" ? b.answer : null,
  note: clean(b.note)?.slice(0, 1000) || null,
});

async function payment(db, job) {
  // "a. Check payment review": a job transferred from another job uses the invoice of the main (source) job
  try {
    const r = await db.query(
      `SELECT invoice_no AS "invoiceNo", status, total::float AS total, paid_amount::float AS paid FROM invoice WHERE job_id = COALESCE($1::int, $2::int) OR job_id = $2::int ORDER BY (job_id = $2::int) LIMIT 1`,
      [job.sourceJobId, job.id]);
    return r.rows[0] || null;
  } catch (_) { return null; } // the invoice module is not installed
}

async function state(db, job) {
  const [h, o] = await Promise.all([
    db.query(`SELECT checks, answer, COALESCE(note, '') AS note, completed_at AS "completedAt" FROM job_wash_delivery WHERE job_id = $1`, [job.id]),
    db.query(`SELECT sent_to AS "sentTo", sent_at AS "sentAt", expires_at AS "expiresAt", verified_at AS "verifiedAt", attempts, override_reason AS "overrideReason", override_at AS "overrideAt" FROM job_wash_delivery_otp WHERE job_id = $1`, [job.id]),
  ]);
  const row = h.rows[0] || { checks: [], answer: null, note: "", completedAt: null };
  const otp = o.rows[0] ? { sentTo: maskPhone(o.rows[0].sentTo), sentAt: o.rows[0].sentAt, expiresAt: o.rows[0].expiresAt, verifiedAt: o.rows[0].verifiedAt, overrideReason: o.rows[0].overrideReason, overrideAt: o.rows[0].overrideAt, attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - o.rows[0].attempts) } : null;
  return {
    items: ITEMS.map(([key, label]) => ({ key, label })),
    header: { ...row, checks: Array.isArray(row.checks) ? row.checks : [] },
    otp,
    payment: await payment(db, job),
    customerPhone: maskPhone(job.phone),
    resendSeconds: OTP_RESEND_SECONDS,
  };
}

async function save(db, jobId, d, uid) {
  await db.query(
    `INSERT INTO job_wash_delivery (job_id, checks, answer, note, saved_by) VALUES ($1, $2::jsonb, $3, $4, $5)
     ON CONFLICT (job_id) DO UPDATE SET checks = EXCLUDED.checks, answer = EXCLUDED.answer, note = EXCLUDED.note, saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
    [jobId, JSON.stringify(d.checks), d.answer, d.note, uid]);
}

const publicJob = (j) => ({ id: j.id, jobNo: j.jobNo, regNo: j.regNo, customerName: j.customerName, departmentName: j.departmentName, stageNo: j.stageNo, thisStageNo: j.thisStageNo });

/* GET /wash-delivery-department/:name -> { hasWashDelivery, washDeliveryStageNo } */
router.get("/wash-delivery-department/:name", authenticateToken, async (req, res) => {
  const name = clean(req.params.name);
  if (!name) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(
      `SELECT id, name, COALESCE(has_wash_delivery, false) AS "hasWashDelivery", wash_delivery_stage_no AS "washDeliveryStageNo"
         FROM department WHERE lower(name) = lower($1) AND is_active`, [name]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    return res.json(r.rows[0]);
  } catch (e) { console.error("wash-delivery-department:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

/* GET /jobs/:id/wash-delivery */
router.get("/jobs/:id/wash-delivery", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `This stage is not used in the ${job.departmentName || "selected"} department` });
    const st = await state(pool, job);
    return res.json({ job: publicJob(job), ...st, reached: reached(job), canRecord: reached(job) && !st.header.completedAt });
  } catch (e) { console.error("load wash delivery:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

/* PUT /jobs/:id/wash-delivery   { checks, answer, note }   (save; "Need to recheck" is saved here and the stage stays open) */
router.put("/jobs/:id/wash-delivery", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!reached(job)) return res.status(409).json({ message: "This job is not ready for this stage" });
    const cur = await pool.query("SELECT completed_at FROM job_wash_delivery WHERE job_id = $1", [jobId]);
    if (cur.rows[0]?.completed_at) return res.status(409).json({ message: "This stage is already completed" });
    const d = sanitize(req.body);
    if (d.answer === "RECHECK" && !d.note) return res.status(400).json({ message: "Enter what must be rechecked" });
    await save(pool, jobId, d, currentUserId(req));
    return res.json({ ok: true });
  } catch (e) { console.error("save wash delivery:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

/* POST /jobs/:id/wash-delivery/otp/send   -> a new 6 digit code is sent by SMS to the customer's mobile number */
router.post("/jobs/:id/wash-delivery/otp/send", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!reached(job)) return res.status(409).json({ message: "This job is not ready for this stage" });
    const done = await pool.query("SELECT completed_at FROM job_wash_delivery WHERE job_id = $1", [jobId]);
    if (done.rows[0]?.completed_at) return res.status(409).json({ message: "This stage is already completed" });
    if (!sms?.sendSms) return res.status(503).json({ message: "The SMS service file was not found on the server (services/sms.service.js)" });
    // the OTP goes to the customer's number, or to another number typed by the staff (the customer's number changed / the person who collects the vehicle)
    const other = clean(req.body?.phone);
    const target = other || job.phone;
    if (other && !(sms.toSriLankaNumber ? sms.toSriLankaNumber(other) : /^\+?\d{9,15}$/.test(other.replace(/[\s-]/g, "")))) return res.status(400).json({ message: "Enter a valid mobile number (07XXXXXXXX)" });
    if (!clean(target)) return res.status(400).json({ message: "The customer has no mobile number. Type a mobile number to send the OTP." });

    const cur = await pool.query("SELECT sent_at, verified_at FROM job_wash_delivery_otp WHERE job_id = $1", [jobId]);
    if (cur.rows[0]?.verified_at) return res.status(409).json({ message: "The OTP is already verified" });
    if (cur.rows[0]) {
      const wait = OTP_RESEND_SECONDS - Math.floor((Date.now() - new Date(cur.rows[0].sent_at).getTime()) / 1000);
      if (wait > 0) return res.status(429).json({ message: `Wait ${wait} seconds to send the OTP again`, waitSeconds: wait });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const company = (await sms.getSmsSettings?.().catch(() => null))?.companyName || "KARUNARATHNE AUTO ZONE";
    const text = `${code} is your OTP to release vehicle ${job.regNo} (${job.jobNo}). Valid for ${OTP_MINUTES} minutes. Share it only when you receive your vehicle. - ${company}`;
    const out = await sms.sendSms(target, text, { kind: "deliveryOtp" });
    if (!out.sent) return res.status(502).json({ message: `The OTP SMS was not sent: ${out.error || "unknown error"}` });

    await pool.query(
      `INSERT INTO job_wash_delivery_otp (job_id, code_hash, sent_to, sent_at, expires_at, attempts, send_count, verified_at, verified_by)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($4 || ' minutes')::interval, 0, 1, NULL, NULL)
       ON CONFLICT (job_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, sent_to = EXCLUDED.sent_to, sent_at = CURRENT_TIMESTAMP,
         expires_at = EXCLUDED.expires_at, attempts = 0, send_count = job_wash_delivery_otp.send_count + 1, verified_at = NULL, verified_by = NULL,
         override_reason = NULL, override_by = NULL, override_at = NULL`,
      [jobId, hashCode(jobId, code), out.to || target, String(OTP_MINUTES)]);
    return res.json({ message: "OTP sent", sentTo: maskPhone(out.to || target), expiresInMinutes: OTP_MINUTES });
  } catch (e) { console.error("wash delivery otp send:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

/* POST /jobs/:id/wash-delivery/otp/verify   { code } */
router.post("/jobs/:id/wash-delivery/otp/verify", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  const code = clean(req.body?.code);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  if (!code || !/^\d{6}$/.test(code)) return res.status(400).json({ message: "Enter the 6 digit code" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job || !reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for this stage" }); }
    const r = await client.query("SELECT code_hash, expires_at, attempts, verified_at FROM job_wash_delivery_otp WHERE job_id = $1 FOR UPDATE", [jobId]);
    const o = r.rows[0];
    if (!o) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Send the OTP to the customer first" }); }
    if (o.verified_at) { await client.query("ROLLBACK"); return res.json({ message: "Already verified", verified: true }); }
    if (new Date(o.expires_at).getTime() < Date.now()) { await client.query("ROLLBACK"); return res.status(400).json({ message: "The OTP expired. Send a new one." }); }
    if (o.attempts >= OTP_MAX_ATTEMPTS) { await client.query("ROLLBACK"); return res.status(429).json({ message: "Too many wrong codes. Send a new OTP." }); }
    const ok = crypto.timingSafeEqual(Buffer.from(hashCode(jobId, code)), Buffer.from(o.code_hash));
    if (!ok) {
      await client.query("UPDATE job_wash_delivery_otp SET attempts = attempts + 1 WHERE job_id = $1", [jobId]);
      await client.query("COMMIT");
      return res.status(400).json({ message: `Wrong code. ${Math.max(0, OTP_MAX_ATTEMPTS - o.attempts - 1)} tries left.` });
    }
    await client.query("UPDATE job_wash_delivery_otp SET verified_at = CURRENT_TIMESTAMP, verified_by = $2 WHERE job_id = $1", [jobId, currentUserId(req)]);
    await client.query("COMMIT");
    return res.json({ message: "OTP verified", verified: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("wash delivery otp verify:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

/* POST /jobs/:id/wash-delivery/otp/override   { reason }
   The SMS did not arrive / the gateway is down: a user who has the permission "washdelivery.override" releases the vehicle without the OTP.
   The reason (at least 5 characters), the user and the time are kept. */
router.post("/jobs/:id/wash-delivery/otp/override", authenticateToken, requireOverride, async (req, res) => {
  const jobId = toInt(req.params.id);
  const reason = clean(req.body?.reason);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  if (!reason || reason.length < 5) return res.status(400).json({ message: "Enter the reason (at least 5 characters)" });
  if (reason.length > 500) return res.status(400).json({ message: "The reason is too long (max 500 characters)" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!reached(job)) return res.status(409).json({ message: "This job is not ready for this stage" });
    const done = await pool.query("SELECT completed_at FROM job_wash_delivery WHERE job_id = $1", [jobId]);
    if (done.rows[0]?.completed_at) return res.status(409).json({ message: "This stage is already completed" });
    const uid = currentUserId(req);
    await pool.query(
      `INSERT INTO job_wash_delivery_otp (job_id, code_hash, sent_to, sent_at, expires_at, attempts, send_count, verified_at, verified_by, override_reason, override_by, override_at)
       VALUES ($1, 'OVERRIDE', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 0, CURRENT_TIMESTAMP, $2, $3, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (job_id) DO UPDATE SET verified_at = CURRENT_TIMESTAMP, verified_by = $2, override_reason = $3, override_by = $2, override_at = CURRENT_TIMESTAMP`,
      [jobId, uid, reason]);
    return res.json({ message: "Released without OTP", verified: true });
  } catch (e) { console.error("wash delivery otp override:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

/* POST /jobs/:id/wash-delivery/complete   { checks, answer: "YES" }   every item ticked + the OTP verified */
router.post("/jobs/:id/wash-delivery/complete", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const d = sanitize(req.body);
  if (d.answer !== "YES") return res.status(400).json({ message: "Select Yes: you are all done" });
  const left = KEYS.filter((k) => !d.checks.includes(k));
  if (left.length) return res.status(400).json({ message: `Tick all the items first (${left.length} left)` });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for this stage" }); }
    const otp = await client.query("SELECT verified_at FROM job_wash_delivery_otp WHERE job_id = $1", [jobId]);
    if (!otp.rows[0]?.verified_at) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Send the OTP to the customer and verify it to release the vehicle" }); }
    const uid = currentUserId(req);
    await save(client, jobId, { ...d, note: null }, uid);
    const h = await client.query("SELECT completed_at FROM job_wash_delivery WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Already completed" }); }
    await client.query("UPDATE job_wash_delivery SET completed_at = CURRENT_TIMESTAMP, completed_by = $2, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId, uid]);
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
    return res.json({ message: "JOB Done Confirmed", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("complete wash delivery:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

module.exports = router;