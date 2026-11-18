// routes/extra_scope.routes.js  — Extra Job Scope (extra work found AFTER a job is activated)
// Mount:  app.use("/extra-scope", require("./routes/extra_scope.routes"));   (needs express.json())
// New tables / columns are created automatically when the server starts (no SQL to run).
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
const { sendSms, toSriLankaNumber, renderSms } = require("../services/sms.service");

dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();

// ---- notification for the Inventory & Spare Parts team (same as the spare parts upload of the Vehicle Job Inspection) ----
let sendPushToUser = null;
{
  const fs = require("node:fs");
  const path = require("node:path");
  const names = ["push.routes", "push", "pushRoutes", "push.route", "push_routes", "push.js", "notification.routes", "notifications"];
  let found = names.map((n) => `./${n}`);
  try { found = found.concat(fs.readdirSync(__dirname).filter((x) => /^push.*\.js$/i.test(x) && x !== path.basename(__filename)).map((x) => `./${x}`)); } catch (_) { /* ignore */ }
  for (const p of found) {
    try { const m = require(p); if (typeof m?.sendPushToUser === "function") { sendPushToUser = m.sendPushToUser; break; } }
    catch (e) { if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes(p.replace("./", ""))) console.error(`push file ${p}:`, e.message); }
  }
}
async function notifyInventory(job, seq, nParts, nQuotes) {
  try {
    if (!sendPushToUser) { console.error("inventory notification: the push file (the one that exports sendPushToUser) was not found in this folder (no notification sent)."); return; }
    const envIds = String(process.env.INVENTORY_MENU_IDS || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x) && Number(x) > 0).map(Number);
    const menu = envIds.length
      ? await pool.query("SELECT id, route FROM admin_uimenudata WHERE id = ANY($1::int[])", [envIds])
      : await pool.query(`SELECT id, route FROM admin_uimenudata WHERE status <> 'permission' AND (name ILIKE '%inventory%' OR route ILIKE '%inventory%') ORDER BY (route IS NULL OR route IN ('#', '')), id`);
    if (menu.rowCount === 0) { console.error("inventory notification: no menu row found for Inventory & Spare Parts (set INVENTORY_MENU_IDS in .env)"); return; }
    const ids = menu.rows.map((m) => m.id);
    const base = process.env.INVENTORY_PUSH_URL || menu.rows.find((m) => m.route && m.route !== "#")?.route || "/";
    const url = `${base}${base.includes("?") ? "&" : "?"}tab=jobcards&job=${job.id}`;   // opens Inventory -> Job Cards -> Spare part orders with this job expanded
    const users = await pool.query(
      `SELECT DISTINCT u.id FROM admin_user u JOIN admin_role r ON r.id = u.role_id
        WHERE r.privileges::text[] && $1::text[] AND COALESCE(r.status, 'active') = 'active'`, [ids.map(String)]);
    console.log(`inventory notification: job ${job.jobNo} (Extra Job Scope #${seq}) -> ${users.rowCount} user(s) with the Inventory privilege (menu ${ids.join(",")}), url ${url}`);
    const what = [nParts > 0 ? `${nParts} part${nParts === 1 ? "" : "s"}` : "", nQuotes > 0 ? `${nQuotes} quotation request${nQuotes === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ") || "spare parts";
    for (const u of users.rows) {
      await sendPushToUser(u.id, { title: "Spare part request (Extra Job Scope)", body: `${job.jobNo} · ${job.regNo}: Extra #${seq}: ${what} (${job.departmentName || "-"})`, url });
    }
  } catch (e) { console.error("inventory notification:", e.message); }
}

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
  )`).then(async () => {
  // the estimate page (link in the SMS), and what was uploaded to Inventory & Spare Parts; the Extra Job Scope lines carry extra_scope_id in the spare part tables
  for (const q of [
    "ALTER TABLE job_extra_scope ADD COLUMN IF NOT EXISTS estimate_token text, ADD COLUMN IF NOT EXISTS estimate_html text, ADD COLUMN IF NOT EXISTS inventory_sent_at timestamp, ADD COLUMN IF NOT EXISTS inventory_sig text",
    "ALTER TABLE job_spare_part ADD COLUMN IF NOT EXISTS extra_scope_id integer, ADD COLUMN IF NOT EXISTS extra_item_id text",
    "ALTER TABLE job_spare_quote ADD COLUMN IF NOT EXISTS extra_scope_id integer, ADD COLUMN IF NOT EXISTS extra_item_id text",
  ]) { try { await pool.query(q); } catch (e) { console.error("extra scope setup:", e.code, e.message); } }
}).catch((e) => console.error("create job_extra_scope:", e.message));

// The customer's address column (named differently in some databases): found once, empty when the customer table has none
let addressColumn;
async function findAddressColumn(db) {
  if (addressColumn !== undefined) return addressColumn;
  try {
    const r = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'customer' AND column_name = ANY($1::text[])
        ORDER BY array_position($1::text[], column_name::text) LIMIT 1`,
      [["address", "customer_address", "address_line1", "address1", "residential_address", "postal_address"]]);
    addressColumn = r.rows[0]?.column_name || null;
  } catch (_) { addressColumn = null; }
  return addressColumn;
}

async function loadJob(db, jobId) {
  const col = await findAddressColumn(pool);   // one of the fixed names above, so it is safe to put in the query
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, d.name AS "departmentName", c.customer_name AS "customerName", COALESCE(j.price_markup_percent, 0)::float AS "markupPercent", COALESCE(j.spare_markup_percent, j.price_markup_percent, 0)::float AS "sparePercent",
            COALESCE(NULLIF(c.alt_contact_number, ''), c.contact_number) AS "contactNumber", c.email AS "customerEmail",
            ${col ? `c.${col}::text` : "NULL::text"} AS "customerAddress",
            j.chassis_no AS "chassisNo", j.engine_no AS "engineNo", j.year_of_manufacture AS "yearOfManufacture", j.colour AS "colour", j.mileage_km AS "mileageKm", j.tyre_size AS "tyreSize",
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
    // price adjustment (%) of the SPARE PARTS + third-party items of this scope. null = follows the repair adjustment of this scope
    sparePercent: b.sparePercent !== null && b.sparePercent !== undefined && b.sparePercent !== "" && Number.isFinite(Number(b.sparePercent)) && Number(b.sparePercent) >= 0 && Number(b.sparePercent) <= 50 ? Number(b.sparePercent) : null,
  };
}
// totals by what the customer agreed: PARTIAL -> only ticked lines; REJECTED -> nothing; the parts the customer brings are not charged
// the price adjustment (markup %) options of Settings > Pricing (always includes 0 = none); the old fixed list when nothing is saved
pool.query("ALTER TABLE job ADD COLUMN IF NOT EXISTS spare_markup_percent NUMERIC(6,2)").catch(() => {});   // spare parts price adjustment (also added by the inspection routes)
async function markupOptions(db) {
  try {
    const r = await db.query("SELECT value FROM app_setting WHERE group_key = 'pricing' AND key = 'adjustmentOptions'");
    const v = r.rows[0]?.value;
    if (Array.isArray(v)) { const l = v.map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x <= 50); return [...new Set([0, ...l])].sort((a, b) => a - b); }
  } catch (_) { /* the settings table does not exist yet */ }
  return [0, 2, 5, 8, 10, 12];
}

function totals(d, jobPct = 0, inc = {}, jobSparePct = null) {
  // "Agreed scope only" applies to the repair (labour) lines; the spare parts are always part of the estimate (unless the customer brings them)
  const agreed = (x) => d.decision !== "REJECTED" && (d.decision !== "PARTIAL" || d.agreedScope.includes(x.id));
  const agreedPart = () => d.decision !== "REJECTED";
  const adj = (u) => Math.round(u * (100 + (d.markupPercent ?? jobPct))) / 100;                                   // repair lines
  // spare parts + third-party items: own % of this scope, else the repair % chosen in this scope, else the job's spare %
  const sparePct = d.sparePercent ?? (d.markupPercent != null ? d.markupPercent : (jobSparePct ?? jobPct));
  const adjS = (u) => Math.round(u * (100 + sparePct)) / 100;
  const labour = inc.labour === false ? 0 : d.labour.filter(agreed).reduce((s, x) => s + x.qty * adj(x.amount), 0);
  const parts = inc.parts === false ? 0 : d.parts.filter((x) => agreedPart() && !(d.partsBy === "CLIENT" && d.clientParts.includes(x.id))).reduce((s, x) => s + x.qty * adjS(x.unitPrice), 0);
  // third-party items: their own switch (inc.quotes, default = follows inc.parts); the ones the customer brings are not charged
  const quotes = (inc.quotes ?? inc.parts) === false ? 0 : d.quotes.filter((x) => agreedPart() && !(d.partsBy === "CLIENT" && d.clientParts.includes(x.id))).reduce((s, x) => s + x.qty * adjS(x.price), 0);
  const r2 = (n) => Math.round(n * 100) / 100;
  const all = { labour: r2(d.labour.reduce((s, x) => s + x.qty * adj(x.amount), 0)), parts: r2(d.parts.reduce((s, x) => s + x.qty * adjS(x.unitPrice), 0) + d.quotes.reduce((s, x) => s + x.qty * adjS(x.price), 0)) };
  return { labour: r2(labour), spare: r2(parts + quotes), total: r2(labour + parts + quotes), all };
}
const SELECT = `SELECT id, job_id AS "jobId", seq, status, data, estimated_total::float AS "estimatedTotal", sms_sent_at AS "smsSentAt", created_at AS "createdAt", completed_at AS "completedAt", inventory_sent_at AS "inventorySentAt", inventory_sig AS "inventorySig" FROM job_extra_scope`;
// what Inventory & Spare Parts gets: the spare parts + the third-party items (not their prices, which come back from Inventory)
const sigOf = (d) => JSON.stringify([d.parts.map((x) => [x.id, x.partId, x.name, x.brand, x.quality, x.qty, x.unitPrice]), d.quotes.map((x) => [x.id, x.description, x.photoUrl, x.qty])]);
const inventoryState = (r, d) => ({ sentAt: r.inventorySentAt || null, needsUpload: d.parts.length + d.quotes.length > 0 && sigOf(d) !== (r.inventorySig || "") });
const shape = (r, jobPct = 0, jobSparePct = null) => {
  const d = sanitize(r.data || {});
  const { inventorySig, ...rest } = r;
  return { ...rest, data: { ...d, sentVia: r.data?.sentVia || null }, jobMarkupPercent: jobPct, jobSparePercent: jobSparePct ?? jobPct, totals: totals(d, jobPct, {}, jobSparePct), inventory: inventoryState(r, d) };
};
// the price Inventory & Spare Parts gave for a third-party item comes back into the scope
async function withQuotedPrices(db, shaped) {
  if (!shaped.data.quotes.length) return shaped;
  const q = await db.query("SELECT extra_item_id AS id, quoted_price::float AS price FROM job_spare_quote WHERE job_id = $1 AND extra_scope_id = $2 AND status = 'QUOTED' AND quoted_price IS NOT NULL", [shaped.jobId, shaped.id]).catch(() => ({ rows: [] }));
  if (!q.rowCount) return shaped;
  const m = new Map(q.rows.map((x) => [x.id, x.price]));
  const data = { ...shaped.data, quotes: shaped.data.quotes.map((x) => (m.has(x.id) ? { ...x, price: m.get(x.id), priceFromInventory: true } : x)) };
  return { ...shaped, data, totals: totals(sanitize(data), shaped.jobMarkupPercent, {}, shaped.jobSparePercent) };
}

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
    return res.json({ job, canAdd: job.status === "IN_PROGRESS" && Boolean(job.activatedAt), options, scopes: await Promise.all(r.rows.map((x) => withQuotedPrices(pool, shape(x, job.markupPercent, job.sparePercent)))) });
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
  const jp = await pool.query("SELECT COALESCE(price_markup_percent, 0)::float AS p, COALESCE(spare_markup_percent, price_markup_percent, 0)::float AS sp FROM job WHERE id = $1", [jobId]).catch(() => ({ rows: [] }));
  return { jobId, sid, row: r.rows[0], pct: jp.rows[0]?.p || 0, spct: jp.rows[0]?.sp ?? (jp.rows[0]?.p || 0) };
}

// PUT /jobs/:id/scopes/:sid   { ...data }   (auto-save)
router.put("/jobs/:id/scopes/:sid", authenticateToken, async (req, res) => {
  try {
    const g = await openScope(req, res); if (!g) return;
    const d = sanitize(req.body || {});
    await pool.query("UPDATE job_extra_scope SET data = $3, estimated_total = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND job_id = $2", [g.sid, g.jobId, JSON.stringify(d), totals(d, g.pct, {}, g.spct).total]);
    return res.json({ totals: totals(d, g.pct, {}, g.spct) });
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
    const inc = approved ? {} : { labour: req.body?.includeLabour !== false, parts: req.body?.includeParts !== false, quotes: req.body?.includeQuotes !== false };
    const t = approved ? totals(d, g.pct, {}, g.spct) : totals({ ...d, decision: d.decision === "REJECTED" ? null : d.decision }, g.pct, inc, g.spct);   // the estimate shows the full price even when it was not approved
    if (!(t.total > 0)) return res.status(400).json({ message: "The estimate total is Rs. 0.00" });
    const hh = Math.floor((d.estHours || 0) + 1e-6), mm = Math.round(((d.estHours || 0) - hh) * 60);
    const time = [d.estDays ? `${d.estDays} day${d.estDays === 1 ? "" : "s"}` : "", hh ? `${hh} hrs` : "", mm ? `${mm} min` : ""].filter(Boolean).join(" ");
    const amount = t.total.toLocaleString("en-LK", { minimumFractionDigits: 2 });
    // the estimate document (made by the screen) is saved and the SMS gets a link to it, like the evidence report
    let link = "";
    const docHtml = typeof req.body?.html === "string" && req.body.html.length > 200 && req.body.html.length < 400000 ? req.body.html : null;
    if (docHtml) {
      try {
        const cur = await pool.query("SELECT estimate_token FROM job_extra_scope WHERE id = $1", [g.sid]);
        const token = cur.rows[0]?.estimate_token || randomBytes(24).toString("hex");
        await pool.query("UPDATE job_extra_scope SET estimate_token = $2, estimate_html = $3 WHERE id = $1", [g.sid, token, docHtml]);
        const app = String(process.env.PUBLIC_APP_URL || req.headers.origin || "").replace(/\/+$/, "");
        const api = String(process.env.PUBLIC_API_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        link = app ? `${app}/estimate/${token}?p=${encodeURIComponent(req.baseUrl || "/extra-scope")}` : `${api}${req.baseUrl || "/extra-scope"}/public/estimate/${token}`;
      } catch (e) { console.error("extra scope estimate link:", e.code, e.message); }
    }
    let text = approved
      ? await renderSms("extraApproved", { regNo: job.regNo, amount, time, link })
      : await renderSms("extraEstimate", { regNo: job.regNo, amount, time: req.body?.includeTime !== false ? time : "", link });
    if (link && !text.includes(link)) text = `${text} View estimate: ${link}`;   // also when the saved SMS template has no {link}
    const trySms = async (to) => { try { return await sendSms(to, text, { kind: approved ? "extraApproved" : "extraEstimate" }); } catch (e) { console.error("extra scope sms:", e.message); return { sent: false, error: "Could not send the SMS" }; } };
    const sms = await trySms(phone || job.contactNumber);
    if (sms?.sent && !approved) {
      d.sentVia = "SMS";
      await pool.query("UPDATE job_extra_scope SET data = $3, sms_sent_at = CURRENT_TIMESTAMP, estimated_total = $4 WHERE id = $1 AND job_id = $2", [g.sid, g.jobId, JSON.stringify(d), t.total]).catch((e) => console.error("extra scope sms mark:", e.message));
    }
    return res.json({ sms, total: t.total });
  } catch (e) { console.error("extra scope send sms:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// GET /public/estimate-data/:token   (NO login - the long random token is the key): the estimate document for the website page /estimate/<token>
router.get("/public/estimate-data/:token", async (req, res) => {
  const token = clean(req.params.token);
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return res.status(404).json({ message: "Estimate not found" });
  try {
    const r = await pool.query("SELECT e.estimate_html AS html, j.job_no AS \"jobNo\" FROM job_extra_scope e JOIN job j ON j.id = e.job_id WHERE e.estimate_token = $1", [token]);
    if (!r.rows[0]?.html) return res.status(404).json({ message: "Estimate not found" });
    res.set("X-Robots-Tag", "noindex");
    return res.json({ html: r.rows[0].html, jobNo: r.rows[0].jobNo });
  } catch (e) { console.error("public extra estimate data:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
// GET /public/estimate/:token   (the page itself, used when PUBLIC_APP_URL is not set)
router.get("/public/estimate/:token", async (req, res) => {
  const token = clean(req.params.token);
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return res.status(404).send("Estimate not found");
  try {
    const r = await pool.query("SELECT estimate_html FROM job_extra_scope WHERE estimate_token = $1", [token]);
    let html = r.rows[0]?.estimate_html;
    if (!html) return res.status(404).send("Estimate not found");
    html = html.replace("<head>", `<head><meta name="viewport" content="width=device-width,initial-scale=1">`);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("X-Robots-Tag", "noindex");
    res.set("Content-Security-Policy", "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:");
    return res.send(html);
  } catch (e) { console.error("public extra estimate:", e.code, e.message); return res.status(500).send("Server error"); }
});

// POST /jobs/:id/scopes/:sid/upload-inventory -> the spare parts + the third-party items of this Extra Job Scope go to Inventory & Spare Parts
// (Job Cards > Spare part orders: Reserve / Issue / Return, and the third-party prices), the Inventory team gets a notification.
router.post("/jobs/:id/scopes/:sid/upload-inventory", authenticateToken, async (req, res) => {
  const g = await openScope(req, res); if (!g) return;
  const client = await pool.connect();
  try {
    const job = await loadJob(pool, g.jobId);
    const d = sanitize(g.row.data || {});
    if (d.parts.length + d.quotes.length === 0) { client.release(); return res.status(400).json({ message: "Add the spare parts or the third-party items first" }); }
    const sig = sigOf(d);   // taken BEFORE any line is adjusted below, so it matches what the next read gives
    const uidn = currentUserId(req);
    await client.query("BEGIN");
    await client.query("INSERT INTO job_spare_parts (job_id, saved_by) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING", [g.jobId, uidn]);
    await client.query("UPDATE job_spare_parts SET link_sent_at = COALESCE(link_sent_at, CURRENT_TIMESTAMP) WHERE job_id = $1", [g.jobId]);
    // spare parts
    // a part id that is not an inventory item (0, deleted, typed by hand) must not break the foreign key: such a line is kept as a manual line
    const ids = [...new Set(d.parts.map((p) => p.partId).filter((x) => Number.isInteger(x) && x > 0))];
    const okIds = new Set(ids.length ? (await client.query("SELECT id FROM spare_part WHERE id = ANY($1::int[])", [ids])).rows.map((r) => r.id) : []);
    for (const p of d.parts) if (!okIds.has(p.partId)) p.partId = null;
    const have = (await client.query("SELECT id, extra_item_id AS \"itemId\", (reserved_qty + issued_qty - returned_qty)::float AS held FROM job_spare_part WHERE job_id = $1 AND extra_scope_id = $2", [g.jobId, g.sid])).rows;
    for (const p of d.parts) {
      const row = have.find((h) => h.itemId === p.id);
      if (row) {
        await client.query("UPDATE job_spare_part SET name = $2, brand = $3, quality = $4, qty = $5, unit_price = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [row.id, p.name, p.brand || null, p.quality || null, Math.max(p.qty, Math.ceil(row.held)), p.unitPrice]);
      } else {
        await client.query(
          `INSERT INTO job_spare_part (job_id, part_id, name, brand, quality, qty, unit_price, price_source, stock_status, created_by, extra_scope_id, extra_item_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [g.jobId, p.partId, p.name, p.brand || null, p.quality || null, p.qty, p.unitPrice, p.source, p.stock, uidn, g.sid, p.id]);
      }
    }
    const keep = new Set(d.parts.map((p) => p.id));
    for (const h of have) if (!keep.has(h.itemId) && h.held <= 0) await client.query("DELETE FROM job_spare_part WHERE id = $1", [h.id]);
    // third-party items
    const haveQ = (await client.query("SELECT id, extra_item_id AS \"itemId\", status FROM job_spare_quote WHERE job_id = $1 AND extra_scope_id = $2", [g.jobId, g.sid])).rows;
    for (const q of d.quotes) {
      const desc = q.qty > 1 ? `${q.description} × ${q.qty}` : q.description;
      const row = haveQ.find((h) => h.itemId === q.id);
      if (row) { if (row.status !== "QUOTED") await client.query("UPDATE job_spare_quote SET description = $2, photo_url = $3 WHERE id = $1", [row.id, desc, q.photoUrl || null]); }
      else await client.query("INSERT INTO job_spare_quote (job_id, photo_url, description, status, created_by, extra_scope_id, extra_item_id) VALUES ($1, $2, $3, 'SENT', $4, $5, $6)", [g.jobId, q.photoUrl || null, desc, uidn, g.sid, q.id]);
    }
    const keepQ = new Set(d.quotes.map((q) => q.id));
    for (const h of haveQ) if (!keepQ.has(h.itemId) && h.status !== "QUOTED") await client.query("DELETE FROM job_spare_quote WHERE id = $1", [h.id]);
    await client.query("UPDATE job_extra_scope SET inventory_sent_at = CURRENT_TIMESTAMP, inventory_sig = $2 WHERE id = $1", [g.sid, sig]);
    await client.query("COMMIT");
    console.log(`extra scope uploaded: job ${job.jobNo} #${g.row.seq} (${d.parts.length} parts, ${d.quotes.length} third-party items)`);
    notifyInventory(job, g.row.seq, d.parts.length, d.quotes.length);   // fire and forget
    return res.json({ inventory: { sentAt: new Date().toISOString(), needsUpload: false }, parts: d.parts.length, quotes: d.quotes.length });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("extra scope upload:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
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
    // the spare parts / third-party items must be uploaded to Inventory & Spare Parts first (and again after any change)
    if (d.decision !== "REJECTED" && d.parts.length + d.quotes.length > 0 && sigOf(d) !== (g.row.inventorySig || "")) {
      return res.status(409).json({ message: "First upload to Inventory: press \"Upload to ERP System\" in the spare parts section, then complete this Extra Job Scope." });
    }
    // what the customer rejected / brings himself is taken off the Inventory list again (only the lines nobody has reserved or issued yet)
    try {
      const drop = d.decision === "REJECTED" ? new Set([...d.parts, ...d.quotes].map((x) => x.id)) : new Set(d.partsBy === "CLIENT" ? d.clientParts : []);
      if (drop.size) {
        await pool.query("DELETE FROM job_spare_part WHERE job_id = $1 AND extra_scope_id = $2 AND extra_item_id = ANY($3::text[]) AND (reserved_qty + issued_qty - returned_qty) <= 0", [g.jobId, g.sid, [...drop]]);
        await pool.query("DELETE FROM job_spare_quote WHERE job_id = $1 AND extra_scope_id = $2 AND extra_item_id = ANY($3::text[]) AND status <> 'QUOTED'", [g.jobId, g.sid, [...drop]]);
      }
    } catch (e) { console.error("extra scope prune inventory:", e.code, e.message); }
    const t = totals(d, g.pct, {}, g.spct);
    await pool.query("UPDATE job_extra_scope SET status = $3, estimated_total = $4, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND job_id = $2", [g.sid, g.jobId, d.decision, t.total]);
    return res.json({ message: "Completed", totals: t });
  } catch (e) { console.error("complete extra scope:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

module.exports = router;