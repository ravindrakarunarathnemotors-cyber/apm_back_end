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

const clean = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const toInt = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) ? n : NaN;
};
const money = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 && n <= 999999999 ? Math.round(n * 100) / 100 : 0;
};
const currentUserId = (req) => {
  const n = Number(req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) ? n : null;
};
 
pool.query(`
  CREATE TABLE IF NOT EXISTS job_extra_scope (
    id              serial PRIMARY KEY,
    job_id          integer NOT NULL,
    seq             integer NOT NULL,
    status          text NOT NULL DEFAULT 'OPEN',          -- OPEN | APPROVED | PARTIAL | REJECTED
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,
    estimated_total numeric(12,2) NOT NULL DEFAULT 0,
    sms_sent_at     timestamp,
    created_by      integer,
    created_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at    timestamp,
    UNIQUE (job_id, seq)
  )`).catch((e) => console.error("create job_extra_scope:", e.message));
 
async function loadJob(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, d.name AS "departmentName", c.customer_name AS "customerName", COALESCE(j.price_markup_percent, 0)::float AS "markupPercent",
            COALESCE(NULLIF(c.alt_contact_number, ''), c.contact_number) AS "contactNumber",
            (SELECT activated_at FROM job_activation a WHERE a.job_id = j.id) AS "activatedAt"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
 
// ---- data (stored as jsonb) : sanitised on every save ----
const uid = (v, p) => { const s = String(v ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40); return s || `${p}${Math.random().toString(36).slice(2, 9)}`; };
const arr = (v, max = 200) => (Array.isArray(v) ? v.slice(0, max) : []);
const txt = (v, n) => String(v ?? "").trim().slice(0, n);
function sanitize(b) {
  const labour = arr(b.labour).map((x) => ({ id: uid(x?.id, "l"), childId: Number.isInteger(Number(x?.childId)) && x?.childId !== null && x?.childId !== "" ? Number(x.childId) : null, label: txt(x?.label, 300), description: txt(x?.description, 300), qty: Math.min(Math.max(parseInt(x?.qty, 10) || 1, 1), 9999), amount: money(x?.amount) })).filter((x) => x.description);
  const repairParents = arr(b.repairParents, 100).map((x) => ({ parent: txt(x?.parent, 200), department: txt(x?.department, 100) })).filter((x) => x.parent);
  const parts = arr(b.parts).map((x) => ({
    id: uid(x?.id, "p"), partId: Number.isInteger(Number(x?.partId)) ? Number(x.partId) : null, name: txt(x?.name, 200), brand: txt(x?.brand, 60), quality: txt(x?.quality, 60),
    qty: Math.min(Math.max(parseInt(x?.qty, 10) || 1, 1), 9999), unitPrice: money(x?.unitPrice), source: x?.source === "CATALOG" ? "CATALOG" : "MANUAL",
    stock: ["IN_STOCK", "OUT_OF_STOCK"].includes(x?.stock) ? x.stock : "UNKNOWN",
  })).filter((x) => x.name);
  const quotes = arr(b.quotes).map((x) => ({ id: uid(x?.id, "q"), description: txt(x?.description, 300), photoUrl: txt(x?.photoUrl, 500), qty: Math.min(Math.max(parseInt(x?.qty, 10) || 1, 1), 9999), price: money(x?.price) })).filter((x) => x.description);
  const files = arr(b.files, 50).map((x) => ({ id: uid(x?.id, "f"), name: txt(x?.name, 200), url: txt(x?.url, 600), mime: txt(x?.mime, 100) })).filter((x) => x.url);
  const ids = new Set([...labour, ...parts, ...quotes].map((x) => x.id));
  const inList = (v) => arr(v, 500).map((x) => String(x)).filter((x) => ids.has(x));
  const hours = Number(b.estHours), days = Number(b.estDays);
  return {
    rootCauses: arr(b.rootCauses, 1).map((x) => txt(x, 2000)).filter(Boolean),
    labour, repairParents, parts, quotes, files,
    estHours: Number.isFinite(hours) && hours > 0 && hours <= 9999 ? hours : null,     // decimal hours (1.5 = 1 hr 30 min)
    estDays: Number.isFinite(days) && days > 0 && days <= 999 ? days : null,
    decision: ["APPROVED", "PARTIAL", "REJECTED"].includes(b.decision) ? b.decision : null,
    agreedScope: inList(b.agreedScope),
    partsBy: ["US", "CLIENT"].includes(b.partsBy) ? b.partsBy : null,
    clientParts: inList(b.clientParts),
    sentVia: b.sentVia === "SMS" ? "SMS" : null,
    // price adjustment (%) of this Extra Job Scope. null = follows the one chosen in the Vehicle Job Inspection (job.price_markup_percent); a number = chosen here
    markupPercent: b.markupPercent !== null && b.markupPercent !== undefined && b.markupPercent !== "" && Number.isFinite(Number(b.markupPercent)) && Number(b.markupPercent) >= 0 && Number(b.markupPercent) <= 50 ? Number(b.markupPercent) : null,
  };
}
// totals by what the customer agreed: PARTIAL -> only ticked lines; REJECTED -> nothing; the parts the customer brings are not charged
// the price adjustment (markup %) options of Settings > Pricing (always includes 0 = none); the old fixed list when nothing is saved
async function markupOptions(db) {
  try {
    const r = await db.query("SELECT value FROM app_setting WHERE group_key = 'pricing' AND key = 'adjustmentOptions'");
    const v = r.rows[0]?.value;
    if (Array.isArray(v)) { const l = v.map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x <= 50); return [...new Set([0, ...l])].sort((a, b) => a - b); }
  } catch (_) { /* the settings table does not exist yet */ }
  return [0, 2, 5, 8, 10, 12];
}
 
function totals(d, jobPct = 0, inc = {}) {
  // "Agreed scope only" applies to the repair (labour) lines; the spare parts are always part of the estimate (unless the customer brings them)
  const agreed = (x) => d.decision !== "REJECTED" && (d.decision !== "PARTIAL" || d.agreedScope.includes(x.id));
  const agreedPart = () => d.decision !== "REJECTED";
  const adj = (u) => Math.round(u * (100 + (d.markupPercent ?? jobPct))) / 100;
  const labour = inc.labour === false ? 0 : d.labour.filter(agreed).reduce((s, x) => s + x.qty * adj(x.amount), 0);
  const parts = inc.parts === false ? 0 : d.parts.filter((x) => agreedPart() && !(d.partsBy === "CLIENT" && d.clientParts.includes(x.id))).reduce((s, x) => s + x.qty * adj(x.unitPrice), 0);
  const quotes = inc.parts === false ? 0 : d.quotes.filter(agreedPart).reduce((s, x) => s + x.qty * adj(x.price), 0);
  const r2 = (n) => Math.round(n * 100) / 100;
  const all = { labour: r2(d.labour.reduce((s, x) => s + x.qty * adj(x.amount), 0)), parts: r2(d.parts.reduce((s, x) => s + x.qty * adj(x.unitPrice), 0) + d.quotes.reduce((s, x) => s + x.qty * adj(x.price), 0)) };
  return { labour: r2(labour), spare: r2(parts + quotes), total: r2(labour + parts + quotes), all };
}
const SELECT = `SELECT id, job_id AS "jobId", seq, status, data, estimated_total::float AS "estimatedTotal", sms_sent_at AS "smsSentAt", created_at AS "createdAt", completed_at AS "completedAt" FROM job_extra_scope`;
const shape = (r, jobPct = 0) => ({ ...r, data: { ...sanitize(r.data || {}), sentVia: r.data?.sentVia || null }, jobMarkupPercent: jobPct, totals: totals(sanitize(r.data || {}), jobPct) });
 
// GET /jobs/:id/repair-tree   -> every repair type (parent) with its child types and labour price, of ALL departments (the job's own department first)
router.get("/jobs/:id/repair-tree", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const j = await pool.query("SELECT department_id FROM job WHERE id = $1", [jobId]);
    if (!j.rowCount) return res.status(404).json({ message: "Job not found" });
    const r = await pool.query(
      `SELECT p.name AS parent, c.id AS "childId", c.name AS "childName", c.price::float AS price, d.name AS department, (l.department_id = $1) AS "isCurrent"
       FROM complaint_option_list l
       JOIN department d ON d.id = l.department_id AND d.is_active
       JOIN complaint_option p ON p.list_id = l.id AND p.is_active AND btrim(COALESCE(p.group_name, '')) = ''
       LEFT JOIN complaint_option c ON c.list_id = l.id AND c.is_active AND lower(btrim(c.group_name)) = lower(btrim(p.name))
       WHERE l.is_active AND (l.code ILIKE '%\_TYPE' OR l.title ILIKE '%repair type%' OR l.title ILIKE '%concern type%')
       ORDER BY (l.department_id = $1) DESC, d.name, p.sort_order, p.id, c.sort_order, c.id`, [j.rows[0].department_id]);
    const tree = [];
    for (const x of r.rows) {
      let g = tree.find((t) => t.parent === x.parent && t.department === x.department);
      if (!g) { g = { parent: x.parent, department: x.department, isCurrent: x.isCurrent, children: [] }; tree.push(g); }
      if (x.childId) g.children.push({ id: x.childId, name: x.childName, price: x.price, label: `${x.parent} > ${x.childName}` });
    }
    return res.json(tree);
  } catch (e) { console.error("extra scope repair tree:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// GET /jobs/:id/scopes   -> { job, canAdd, scopes[] }
router.get("/jobs/:id/scopes", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    const r = await pool.query(`${SELECT} WHERE job_id = $1 ORDER BY seq`, [jobId]);
    const o = await pool.query("SELECT kind, name FROM spare_part_option WHERE is_active ORDER BY kind, sort_order, id").catch(() => ({ rows: [] }));
    const options = { brands: o.rows.filter((x) => x.kind === "BRAND").map((x) => x.name), qualities: o.rows.filter((x) => x.kind === "QUALITY").map((x) => x.name), markups: await markupOptions(pool) };
    return res.json({ job, canAdd: job.status === "IN_PROGRESS" && Boolean(job.activatedAt), options, scopes: r.rows.map((x) => shape(x, job.markupPercent)) });
  } catch (e) { console.error("load extra scopes:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/scopes   -> starts the Extra Job Scope of the job (only for an activated job); returns the existing one if there is already one
router.post("/jobs/:id/scopes", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const client = await pool.connect();
  try {
    const job = await loadJob(client, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (job.status !== "IN_PROGRESS" || !job.activatedAt) return res.status(409).json({ message: "Extra Job Scope can be added only after the job is activated" });
    await client.query("BEGIN");
    await client.query("SELECT id FROM job WHERE id = $1 FOR UPDATE", [jobId]);
    // one Extra Job Scope per job: when it already exists, that one is returned
    const have = await client.query("SELECT id FROM job_extra_scope WHERE job_id = $1 ORDER BY seq LIMIT 1", [jobId]);
    if (have.rowCount) { await client.query("COMMIT"); return res.status(200).json({ id: have.rows[0].id }); }
    const r = await client.query(
      `INSERT INTO job_extra_scope (job_id, seq, data, created_by) VALUES ($1, COALESCE((SELECT MAX(seq) FROM job_extra_scope WHERE job_id = $1), 0) + 1, $2, $3) RETURNING id`,
      [jobId, JSON.stringify(sanitize({})), currentUserId(req)]);
    await client.query("COMMIT");
    return res.status(201).json({ id: r.rows[0].id });
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error("add extra scope:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
  finally { client.release(); }
});
 
async function openScope(req, res) {
  const jobId = toInt(req.params.id), sid = toInt(req.params.sid);
  if (!Number.isInteger(jobId) || !Number.isInteger(sid)) { res.status(400).json({ message: "Invalid request" }); return null; }
  const r = await pool.query(`${SELECT} WHERE id = $1 AND job_id = $2`, [sid, jobId]);
  if (!r.rowCount) { res.status(404).json({ message: "Extra Job Scope not found" }); return null; }
  if (r.rows[0].completed_at || r.rows[0].completedAt) { res.status(409).json({ message: "This Extra Job Scope is already completed" }); return null; }
  const jp = await pool.query("SELECT COALESCE(price_markup_percent, 0)::float AS p FROM job WHERE id = $1", [jobId]).catch(() => ({ rows: [] }));
  return { jobId, sid, row: r.rows[0], pct: jp.rows[0]?.p || 0 };
}
 
// PUT /jobs/:id/scopes/:sid   { ...data }   (auto-save)
router.put("/jobs/:id/scopes/:sid", authenticateToken, async (req, res) => {
  try {
    const g = await openScope(req, res); if (!g) return;
    const d = sanitize(req.body || {});
    await pool.query("UPDATE job_extra_scope SET data = $3, estimated_total = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND job_id = $2", [g.sid, g.jobId, JSON.stringify(d), totals(d, g.pct).total]);
    return res.json({ totals: totals(d, g.pct) });
  } catch (e) { console.error("save extra scope:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// DELETE /jobs/:id/scopes/:sid   (only while nothing has been sent to the customer)
router.delete("/jobs/:id/scopes/:sid", authenticateToken, async (req, res) => {
  try {
    const g = await openScope(req, res); if (!g) return;
    if (g.row.smsSentAt) return res.status(409).json({ message: "The estimate was already sent to the customer" });
    await pool.query("DELETE FROM job_extra_scope WHERE id = $1 AND job_id = $2", [g.sid, g.jobId]);
    return res.json({ message: "Deleted" });
  } catch (e) { console.error("delete extra scope:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/scopes/:sid/send-sms   { phone? }   -> the customer gets the estimate total by SMS
router.post("/jobs/:id/scopes/:sid/send-sms", authenticateToken, async (req, res) => {
  try {
    const g = await openScope(req, res); if (!g) return;
    const phone = clean(req.body?.phone);
    if (phone && !toSriLankaNumber(phone)) return res.status(400).json({ message: "Enter a valid mobile number (07XXXXXXXX)" });
    const job = await loadJob(pool, g.jobId);
    const d = sanitize(g.row.data || {});
    const approved = req.body?.approved === true;   // the approved total (what the customer agreed) instead of the full estimate
    const inc = approved ? {} : { labour: req.body?.includeLabour !== false, parts: req.body?.includeParts !== false };
    const t = approved ? totals(d, g.pct) : totals({ ...d, decision: d.decision === "REJECTED" ? null : d.decision }, g.pct, inc);   // the estimate shows the full price even when it was not approved
    if (!(t.total > 0)) return res.status(400).json({ message: "The estimate total is Rs. 0.00" });
    const hh = Math.floor((d.estHours || 0) + 1e-6), mm = Math.round(((d.estHours || 0) - hh) * 60);
    const time = [d.estDays ? `${d.estDays} day${d.estDays === 1 ? "" : "s"}` : "", hh ? `${hh} hrs` : "", mm ? `${mm} min` : ""].filter(Boolean).join(" ");
    const amount = t.total.toLocaleString("en-LK", { minimumFractionDigits: 2 });
    const text = approved
      ? await renderSms("extraApproved", { regNo: job.regNo, amount, time })
      : await renderSms("extraEstimate", { regNo: job.regNo, amount, time: req.body?.includeTime !== false ? time : "" });
    const trySms = async (to) => { try { return await sendSms(to, text, { kind: approved ? "extraApproved" : "extraEstimate" }); } catch (e) { console.error("extra scope sms:", e.message); return { sent: false, error: "Could not send the SMS" }; } };
    const sms = await trySms(phone || job.contactNumber);
    if (sms?.sent && !approved) {
      d.sentVia = "SMS";
      await pool.query("UPDATE job_extra_scope SET data = $3, sms_sent_at = CURRENT_TIMESTAMP, estimated_total = $4 WHERE id = $1 AND job_id = $2", [g.sid, g.jobId, JSON.stringify(d), t.total]).catch((e) => console.error("extra scope sms mark:", e.message));
    }
    return res.json({ sms, total: t.total });
  } catch (e) { console.error("extra scope send sms:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/scopes/:sid/complete   -> closes this Extra Job Scope with the customer's decision
router.post("/jobs/:id/scopes/:sid/complete", authenticateToken, async (req, res) => {
  try {
    const g = await openScope(req, res); if (!g) return;
    const d = sanitize(g.row.data || {});
    const bad = (m) => res.status(400).json({ message: m });
    if (d.labour.length === 0 && d.parts.length === 0 && d.quotes.length === 0) return bad("Add the extra work (labour) or the spare parts first");
    if (d.estHours === null && d.estDays === null) return bad("Enter the estimated time of repair");
    if (!d.decision) return bad("Select the customer confirmation");
    if (d.decision === "PARTIAL" && d.labour.length > 0 && d.agreedScope.length === 0) return bad("Tick the repair items the customer agreed");
    if (d.decision !== "REJECTED") {
      if (!d.partsBy && d.parts.length + d.quotes.length > 0) return bad("Select who provides the spare parts");
      if (d.partsBy === "CLIENT" && d.clientParts.length === 0) return bad("Tick the spare parts the customer brings");
    }
    const t = totals(d, g.pct);
    await pool.query("UPDATE job_extra_scope SET status = $3, estimated_total = $4, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND job_id = $2", [g.sid, g.jobId, d.decision, t.total]);
    return res.json({ message: "Completed", totals: t });
  } catch (e) { console.error("complete extra scope:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
module.exports = router;
 