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

 
const VIA = ["WHATSAPP", "ERP", "PHONE_CALL", "EMAIL"];
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
const money = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 && n <= 999999999 ? Math.round(n * 100) / 100 : NaN;
};
const duration = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 99999 ? Math.round(n * 10) / 10 : NaN;
};
const lines = (v, max = 300) => (Array.isArray(v) ? v : []).map((x) => clean(x)).filter(Boolean).map((x) => x.slice(0, max)).slice(0, 30);
 
async function loadJob(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
            j.department_id AS "departmentId", d.name AS "departmentName",
            COALESCE(d.has_customer_approval, false) AS "hasApproval", d.customer_approval_stage_no AS "approvalStageNo",
            c.customer_name AS "customerName", c.contact_number AS "contactNumber"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasApproval && job.approvalStageNo && job.stageNo >= job.approvalStageNo;
 
// Everything this stage shows from the earlier stages
async function context(db, jobId) {
  const [parts, quotes, repairs, causes, wash] = await Promise.all([
    db.query(`SELECT name, brand, quality, qty, unit_price::float AS "unitPrice" FROM job_spare_part WHERE job_id = $1 ORDER BY id`, [jobId]).catch(() => ({ rows: [] })),
    db.query(`SELECT description, quoted_price::float AS "quotedPrice" FROM job_spare_quote WHERE job_id = $1 AND quoted_price IS NOT NULL ORDER BY id`, [jobId]).catch(() => ({ rows: [] })),
    db.query(`SELECT description, repair_type AS "repairType", amount::float AS amount FROM job_repair_item WHERE job_id = $1 AND status = 'ACTIVE' ORDER BY id`, [jobId]).catch(() => ({ rows: [] })),
    db.query(`SELECT description FROM job_inspection_item WHERE job_id = $1 AND kind = 'ROOT_CAUSE' ORDER BY sort_order, id`, [jobId]).catch(() => ({ rows: [] })),
    // Wash types + prices come from the Wash department's "Wash Type" / "Repair Type" list (Jobs Dashboard > Repair Type)
    db.query(
      `SELECT o.id, COALESCE(o.group_name, '') AS "groupName", o.name, o.price::float AS price
       FROM complaint_option o
       JOIN complaint_option_list l ON l.id = o.list_id
       JOIN department d ON d.id = l.department_id
       WHERE lower(d.name) = 'wash' AND (l.code IN ('REPAIR_TYPE', 'WASH_TYPE') OR l.title ~* '(wash|repair) type') AND o.is_active AND l.is_active
       ORDER BY o.sort_order, o.id`).catch(() => ({ rows: [] })),
  ]);
  const sparePartsValue = parts.rows.reduce((s, r) => s + r.qty * r.unitPrice, 0) + quotes.rows.reduce((s, q) => s + q.quotedPrice, 0);
  const labourTotal = repairs.rows.reduce((s, r) => s + (r.amount || 0), 0);
  // Only the types a customer can really pick: child types, and parents that have no children
  const all = wash.rows;
  const parentsWithKids = new Set(all.filter((o) => o.groupName).map((o) => o.groupName.toLowerCase()));
  const washOptions = all
    .filter((o) => o.groupName || !parentsWithKids.has(o.name.toLowerCase()))
    .map((o) => ({ id: o.id, name: o.name, group: o.groupName, price: o.price || 0 }));
  return {
    parts: parts.rows, quotes: quotes.rows, sparePartsValue: Math.round(sparePartsValue * 100) / 100,
    labour: repairs.rows, labourTotal: Math.round(labourTotal * 100) / 100,
    rootCauses: causes.rows.map((r) => r.description), washOptions,
  };
}
 
const EMPTY = {
  estHours: null, estDays: null, includeSpareParts: true, includeLabour: true, manualItems: [], washItems: [], estimatedTotal: 0,
  sentVia: [], decision: null, agreedScope: [], extraNote: "", partsBy: null, clientPartsFiles: [], clientListSentAt: null,
  repairRequestSentAt: null, thirdPartyRequest: false, thirdPartyNote: "", thirdPartySentAt: null, completedAt: null,
};
async function loadSaved(db, jobId) {
  const r = await db.query(
    `SELECT est_hours::float AS "estHours", est_days::float AS "estDays", include_spare_parts AS "includeSpareParts", include_labour AS "includeLabour",
            manual_items AS "manualItems", wash_items AS "washItems", estimated_total::float AS "estimatedTotal", sent_via AS "sentVia",
            decision, agreed_scope AS "agreedScope", COALESCE(extra_note, '') AS "extraNote", parts_by AS "partsBy",
            client_parts_files AS "clientPartsFiles", client_list_sent_at AS "clientListSentAt",
            repair_request_sent_at AS "repairRequestSentAt", third_party_request AS "thirdPartyRequest", COALESCE(third_party_note, '') AS "thirdPartyNote",
            third_party_sent_at AS "thirdPartySentAt", completed_at AS "completedAt"
     FROM job_customer_approval WHERE job_id = $1`, [jobId]);
  return r.rows[0] || { ...EMPTY };
}
// estimate = spare parts + (labour + manual lines = cost for repair) + wash
function totals(saved, ctx) {
  const spare = saved.includeSpareParts ? ctx.sparePartsValue : 0;
  const labour = saved.includeLabour ? ctx.labourTotal : 0;
  const manual = saved.manualItems.reduce((s, m) => s + (Number(m.amount) || 0), 0);
  const wash = saved.washItems.reduce((s, w) => s + (Number(w.price) || 0), 0);
  const repairCost = labour + manual;
  return { spare, labour, manual, repairCost, wash, total: Math.round((spare + repairCost + wash) * 100) / 100 };
}
 
// GET /jobs/:id/customer-approval
router.get("/jobs/:id/customer-approval", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasApproval) return res.status(409).json({ message: `Customer Approval is not used in the ${job.departmentName || "selected"} department` });
    const [ctx, saved] = await Promise.all([context(pool, jobId), loadSaved(pool, jobId)]);
    return res.json({ job, saved, context: ctx, totals: totals(saved, ctx), reached: reached(job), canRecord: reached(job) && !saved.completedAt });
  } catch (e) {
    console.error("load customer approval:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
async function guard(req, res) {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) { res.status(400).json({ message: "Invalid job" }); return null; }
  const job = await loadJob(pool, jobId);
  if (!job) { res.status(404).json({ message: "Job not found" }); return null; }
  if (!reached(job)) { res.status(409).json({ message: "This job is not ready for the Customer Approval stage" }); return null; }
  const saved = await loadSaved(pool, jobId);
  if (saved.completedAt) { res.status(409).json({ message: "The Customer Approval stage is already completed" }); return null; }
  return { job, jobId, saved };
}
 
// PUT /jobs/:id/customer-approval   (saves the whole form)
router.put("/jobs/:id/customer-approval", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    const b = req.body || {};
    const estHours = duration(b.estHours), estDays = duration(b.estDays);
    if (Number.isNaN(estHours) || Number.isNaN(estDays)) return res.status(400).json({ message: "Enter a valid estimated time" });
    const manualItems = [];
    for (const m of Array.isArray(b.manualItems) ? b.manualItems.slice(0, 30) : []) {
      const description = clean(m?.description)?.slice(0, 200);
      const amount = money(m?.amount);
      if (!description && !Number(m?.amount)) continue;                  // empty line
      if (!description) return res.status(400).json({ message: "Write the description of every manual line" });
      if (Number.isNaN(amount)) return res.status(400).json({ message: "Enter a valid amount in the manual list" });
      manualItems.push({ description, amount });
    }
    // wash types: the price always comes from the price list, not from the browser
    const ids = [...new Set((Array.isArray(b.washOptionIds) ? b.washOptionIds : []).map(Number).filter(Number.isInteger))];
    const ctx = await context(pool, g.jobId);
    const washItems = ctx.washOptions.filter((o) => ids.includes(o.id)).map((o) => ({ optionId: o.id, name: o.group ? `${o.group} > ${o.name}` : o.name, price: o.price }));
    const sentVia = [...new Set(lines(b.sentVia, 20).filter((x) => VIA.includes(x)))];
    const decision = b.decision === "TOTAL" || b.decision === "PARTIAL" ? b.decision : null;
    const partsBy = b.partsBy === "COMPANY" || b.partsBy === "CLIENT" ? b.partsBy : null;
    const files = (Array.isArray(b.clientPartsFiles) ? b.clientPartsFiles : []).slice(0, 10)
      .map((f) => ({ url: clean(f?.url)?.slice(0, 500), name: clean(f?.name)?.slice(0, 200) || "Spare part list" })).filter((f) => f.url);
    const next = {
      ...g.saved, includeSpareParts: b.includeSpareParts !== false, includeLabour: b.includeLabour !== false, manualItems, washItems,
    };
    const t = totals(next, ctx);
    await pool.query(
      `INSERT INTO job_customer_approval
         (job_id, est_hours, est_days, include_spare_parts, include_labour, manual_items, wash_items, estimated_total, sent_via,
          decision, agreed_scope, extra_note, parts_by, client_parts_files, third_party_request, third_party_note, saved_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17)
       ON CONFLICT (job_id) DO UPDATE SET
         est_hours = EXCLUDED.est_hours, est_days = EXCLUDED.est_days, include_spare_parts = EXCLUDED.include_spare_parts,
         include_labour = EXCLUDED.include_labour, manual_items = EXCLUDED.manual_items, wash_items = EXCLUDED.wash_items,
         estimated_total = EXCLUDED.estimated_total, sent_via = EXCLUDED.sent_via, decision = EXCLUDED.decision,
         agreed_scope = EXCLUDED.agreed_scope, extra_note = EXCLUDED.extra_note, parts_by = EXCLUDED.parts_by,
         client_parts_files = EXCLUDED.client_parts_files, third_party_request = EXCLUDED.third_party_request,
         third_party_note = EXCLUDED.third_party_note, saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
      [g.jobId, estHours, estDays, next.includeSpareParts, next.includeLabour, JSON.stringify(manualItems), JSON.stringify(washItems), t.total, sentVia,
       decision, decision === "PARTIAL" ? lines(b.agreedScope) : [], clean(b.extraNote)?.slice(0, 1000) || null, partsBy, JSON.stringify(files),
       b.thirdPartyRequest === true, clean(b.thirdPartyNote)?.slice(0, 500) || null, currentUserId(req)]);
    const saved = await loadSaved(pool, g.jobId);
    return res.json({ saved, totals: totals(saved, ctx) });
  } catch (e) {
    console.error("save customer approval:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// POST /jobs/:id/customer-approval/client-list-sent   -> records that the client's spare part list was sent to the customer
router.post("/jobs/:id/customer-approval/client-list-sent", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    await pool.query(
      `INSERT INTO job_customer_approval (job_id, client_list_sent_at, saved_by) VALUES ($1, CURRENT_TIMESTAMP, $2)
       ON CONFLICT (job_id) DO UPDATE SET client_list_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`, [g.jobId, currentUserId(req)]);
    return res.json({ saved: await loadSaved(pool, g.jobId) });
  } catch (e) { console.error("client list sent:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/customer-approval/logistics   { kind: "REPAIR" | "THIRD_PARTY", note? }
//   REPAIR      = "Send Repair Request to Logistic and Stock Department"
//   THIRD_PARTY = "Request to purchase from third parties (from Logistic and Stock Department)"
// Both are recorded, and the Logistic & Stock department gets the same link as in the spare parts stage (SMS when LOGISTICS_SMS_NUMBER is set).
router.post("/jobs/:id/customer-approval/logistics", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    const kind = req.body?.kind === "THIRD_PARTY" ? "THIRD_PARTY" : "REPAIR";
    const note = clean(req.body?.note)?.slice(0, 500) || null;
    await pool.query("INSERT INTO job_spare_parts (job_id, saved_by) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING", [g.jobId, currentUserId(req)]);
    const cur = await pool.query("SELECT link_token FROM job_spare_parts WHERE job_id = $1", [g.jobId]);
    const token = cur.rows[0]?.link_token || randomBytes(24).toString("hex");
    await pool.query("UPDATE job_spare_parts SET link_token = $1, link_sent_at = COALESCE(link_sent_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE job_id = $2", [token, g.jobId]);
    if (kind === "REPAIR") {
      await pool.query(
        `INSERT INTO job_customer_approval (job_id, repair_request_sent_at, saved_by) VALUES ($1, CURRENT_TIMESTAMP, $2)
         ON CONFLICT (job_id) DO UPDATE SET repair_request_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`, [g.jobId, currentUserId(req)]);
    } else {
      await pool.query(
        `INSERT INTO job_customer_approval (job_id, third_party_request, third_party_note, third_party_sent_at, saved_by) VALUES ($1, true, $2, CURRENT_TIMESTAMP, $3)
         ON CONFLICT (job_id) DO UPDATE SET third_party_request = true, third_party_note = EXCLUDED.third_party_note, third_party_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
        [g.jobId, note, currentUserId(req)]);
    }
    let sms = null;
    const base = String(process.env.PUBLIC_APP_URL || req.headers.origin || "").replace(/\/+$/, "");
    if (process.env.LOGISTICS_SMS_NUMBER && base) {
      const what = kind === "REPAIR" ? "Repair request" : "Third-party purchase request";
      sms = await sendSms(process.env.LOGISTICS_SMS_NUMBER, `${what} for ${g.job.regNo} (${g.job.jobNo})${note ? `: ${note}` : ""} ${base}/spare-parts/${token}`);
    }
    return res.json({ sms, saved: await loadSaved(pool, g.jobId) });
  } catch (e) { console.error("approval logistics:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/customer-approval/complete -> the stage is finished, the job moves on
router.post("/jobs/:id/customer-approval/complete", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for the Customer Approval stage" }); }
    const lock = await client.query("SELECT job_id FROM job_customer_approval WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (lock.rowCount === 0) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Fill in and save the form first" }); }
    const s = await loadSaved(client, jobId);
    if (s.completedAt) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Already completed" }); }
    const bad = (m) => { client.query("ROLLBACK").catch(() => {}); return res.status(400).json({ message: m }); };
    if (!s.estHours && !s.estDays) return bad("Enter the estimated time of repair");
    if (s.sentVia.length === 0) return bad("Select how the estimation was sent");
    if (!s.decision) return bad("Select the customer confirmation");
    if (s.decision === "PARTIAL" && s.agreedScope.length === 0) return bad("Write the agreed scope");
    if (!s.partsBy) return bad("Select who provides the spare parts");
    if (s.partsBy === "CLIENT" && s.clientPartsFiles.length === 0) return bad("Upload the spare part list of the customer");
    await client.query("UPDATE job_customer_approval SET completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId]);
    let stageNo = job.stageNo;
    if (job.stageNo === job.approvalStageNo) {
      const next = job.approvalStageNo + 1;
      const uid = currentUserId(req);
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.approvalStageNo, uid]);
      await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      stageNo = next;
    }
    await client.query("COMMIT");
    return res.json({ message: "Customer approval completed", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("complete customer approval:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
module.exports = router;
 