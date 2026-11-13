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

const DDL = [
  `CREATE SEQUENCE IF NOT EXISTS public.invoice_no_seq START 1`,
  `CREATE TABLE IF NOT EXISTS public.invoice_setting (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  vat_percent     numeric(5,2) NOT NULL DEFAULT 18,
  vat_default_on  boolean NOT NULL DEFAULT true,       
  vat_reg_no      varchar(60)
)`,
  `INSERT INTO public.invoice_setting (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  `ALTER TABLE public.invoice_setting ADD COLUMN IF NOT EXISTS company_address text, ADD COLUMN IF NOT EXISTS company_phone varchar(60), ADD COLUMN IF NOT EXISTS company_email varchar(120)`,
  `CREATE TABLE IF NOT EXISTS public.invoice (
  id              serial PRIMARY KEY,
  invoice_no      varchar(20) NOT NULL UNIQUE,         
  job_id          integer NOT NULL UNIQUE REFERENCES public.job (id) ON DELETE CASCADE,   
  status          varchar(12) NOT NULL DEFAULT 'UNPAID',   
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_enabled     boolean NOT NULL DEFAULT false,      
  tax_percent     numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount      numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount     numeric(14,2) NOT NULL DEFAULT 0,
  notes           text,
  created_by      integer REFERENCES public.admin_user (id),
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_invoice_status CHECK (status IN ('UNPAID', 'PARTIAL', 'PAID', 'CANCELLED'))
)`,
  `CREATE TABLE IF NOT EXISTS public.invoice_line (
  id          serial PRIMARY KEY,
  invoice_id  integer NOT NULL REFERENCES public.invoice (id) ON DELETE CASCADE,
  source      varchar(10) NOT NULL DEFAULT 'APPROVAL',   
  kind        varchar(10) NOT NULL DEFAULT 'OTHER',      
  description text NOT NULL,
  qty         numeric(10,2) NOT NULL DEFAULT 1,
  unit_price  numeric(14,2) NOT NULL DEFAULT 0,
  amount      numeric(14,2) NOT NULL DEFAULT 0,
  sort_order  integer NOT NULL DEFAULT 0
)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_line_invoice ON public.invoice_line (invoice_id)`,
  `CREATE TABLE IF NOT EXISTS public.invoice_payment (
  id          serial PRIMARY KEY,
  invoice_id  integer NOT NULL REFERENCES public.invoice (id) ON DELETE CASCADE,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  method      varchar(16) NOT NULL,                       
  reference   varchar(120),                               
  note        text,
  paid_at     date NOT NULL DEFAULT CURRENT_DATE,
  received_by integer REFERENCES public.admin_user (id),
  voided_at   timestamptz,
  voided_by   integer REFERENCES public.admin_user (id),
  created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_payment_invoice ON public.invoice_payment (invoice_id)`,
];
 
// the tables are created by the server itself (create_invoice.sql has the same statements)
(async () => { for (const q of DDL) { try { await pool.query(q); } catch (e) { console.error("invoice setup:", e.code, e.message); } } })();
 
// the file names of the routes differ between projects: the first one that exists is used (put the real file name first if it is another one)
function loadSibling(names) {
  let last;
  for (const n of names) {
    try { return require(`./${n}`); } catch (e) { if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes(`./${n}`)) throw e; last = e; }
  }
  throw last;
}
 
const METHODS = ["CASH", "CARD", "BANK_TRANSFER", "CHEQUE", "ONLINE", "MOBILE_WALLET", "CREDIT"];
 
// Settings > Tax & invoice (app_setting group "invoice"); the old invoice_setting row is the fallback for VAT %, VAT default and the VAT reg. no
const INV_DEFAULTS = {
  vatDefaultOn: true, vatPercent: 18, vatRegNo: "", prefix: "INV-", digits: 5, methods: METHODS, maxDiscountPercent: 100,
  showBank: false, bankName: "", bankAccountName: "", bankAccountNo: "", bankBranch: "", footerNote: "", terms: [],
};
async function invoiceSettings(db = pool) {
  const out = { ...INV_DEFAULTS };
  try {
    const old = (await db.query("SELECT vat_percent::float AS p, vat_default_on AS d, vat_reg_no AS r FROM invoice_setting WHERE id = 1").catch(() => ({ rows: [] }))).rows[0];
    if (old) { out.vatPercent = old.p; out.vatDefaultOn = old.d; out.vatRegNo = old.r || ""; }
    const r = await db.query("SELECT key, value FROM app_setting WHERE group_key = 'invoice'");
    for (const x of r.rows) if (x.key in INV_DEFAULTS) out[x.key] = x.value;
  } catch (_) { /* the settings table does not exist yet: defaults */ }
  out.methods = (Array.isArray(out.methods) ? out.methods : METHODS).filter((m) => METHODS.includes(m));
  if (!out.methods.length) out.methods = METHODS;
  return out;
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
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
const money = (v, max = 999999999) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? r2(n) : NaN;
};
 
// the job whose invoice it is: a transferred (Wash / Detail) job uses the invoice of the job it came from
async function rootJobId(db, jobId) {
  try {
    const r = await db.query("SELECT id, source_job_id AS \"sourceId\" FROM job WHERE id = $1", [jobId]);
    return r.rows[0] ? r.rows[0].sourceId || r.rows[0].id : null;
  } catch (_) {
    // source_job_id does not exist yet (create_dept_transfer.sql not run): every job has its own invoice
    const r = await db.query("SELECT id FROM job WHERE id = $1", [jobId]);
    return r.rows[0]?.id || null;
  }
}
 
async function recalc(db, invoiceId) {
  const inv = (await db.query("SELECT status, discount_amount::float AS d, tax_enabled AS t, tax_percent::float AS p FROM invoice WHERE id = $1 FOR UPDATE", [invoiceId])).rows[0];
  const sub = r2((await db.query("SELECT COALESCE(SUM(amount), 0)::float AS s FROM invoice_line WHERE invoice_id = $1", [invoiceId])).rows[0].s);
  const discount = Math.min(r2(inv.d), sub);
  const taxable = r2(sub - discount);
  const tax = inv.t ? r2(taxable * inv.p / 100) : 0;
  const total = r2(taxable + tax);
  const paid = r2((await db.query("SELECT COALESCE(SUM(amount), 0)::float AS s FROM invoice_payment WHERE invoice_id = $1 AND voided_at IS NULL", [invoiceId])).rows[0].s);
  const status = inv.status === "CANCELLED" ? "CANCELLED" : total > 0 && paid >= total ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID";
  await db.query("UPDATE invoice SET subtotal = $2, discount_amount = $3, tax_amount = $4, total = $5, paid_amount = $6, status = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [invoiceId, sub, discount, tax, total, paid, status]);
}
 
// the lines of the approved statement (same amounts as the Customer Approval total, price adjustment included in each line)
async function approvalLines(db, jobId) {
  const { helpers } = loadSibling(["customer_approval.routes", "customer_approval", "customerApproval", "customer-approval", "customerApproval.routes"]);
  if (!helpers) throw new Error("customer approval routes file: add `module.exports.helpers = { context, loadSaved, billable, totals };` at its end");
  const [ctx, saved] = await Promise.all([helpers.context(db, jobId), helpers.loadSaved(db, jobId)]);
  const { labour, parts } = helpers.billable(saved, ctx);
  const pct = Number(ctx.markupPercent) || 0;
  const adjU = (u) => Math.round((Number(u) || 0) * (100 + pct)) / 100;
  const out = [];
  const add = (kind, description, qty, amount) => { if (amount > 0) out.push({ kind, description: String(description).slice(0, 300), qty: Number(qty) || 1, amount: r2(amount) }); };
  if (saved.includeSpareParts) {
    for (const p of parts) add("PART", `${p.name}${p.brand ? ` (${p.brand})` : ""}`, p.qty, p.qty * adjU(p.unitPrice));
    for (const q of ctx.quotes) add("QUOTE", `${q.description} (third party)`, 1, adjU(q.quotedPrice));
  }
  if (saved.includeLabour) for (const l of labour) add("LABOUR", l.description, l.qty || 1, (l.qty || 1) * adjU(l.unitPrice ?? l.amount));
  for (const m of saved.manualItems || []) add("OTHER", m.description || "Other", 1, adjU(Number(m.amount) || 0));
  for (const o of (saved.washItems || [])) add("WASH", o.name || o.description || "Wash", 1, Number(o.price) || 0);
  return { lines: out, completed: Boolean(saved.completedAt) };
}
 
// the approved Extra Job Scope lines (the scope was completed with a customer decision)
async function extraLines(db, jobId) {
  const pctRow = await db.query("SELECT COALESCE(price_markup_percent, 0)::float AS p FROM job WHERE id = $1", [jobId]).catch(() => ({ rows: [] }));
  const jobPct = pctRow.rows[0]?.p || 0;
  const rows = await db.query("SELECT seq, data FROM job_extra_scope WHERE job_id = $1 AND status IN ('APPROVED', 'PARTIAL') ORDER BY seq", [jobId]).catch(() => ({ rows: [] }));
  const out = [];
  for (const row of rows.rows) {
    const d = row.data || {};
    const pct = d.markupPercent ?? jobPct;
    const adj = (u) => Math.round((Number(u) || 0) * (100 + pct)) / 100;
    const agreed = (x) => d.decision !== "PARTIAL" || (d.agreedScope || []).includes(x.id);
    for (const x of d.labour || []) if (agreed(x)) out.push({ kind: "LABOUR", description: `Extra: ${x.label || x.description || "Repair"}`.slice(0, 300), qty: x.qty || 1, amount: r2((x.qty || 1) * adj(x.amount)) });
    for (const x of d.parts || []) if (!(d.partsBy === "CLIENT" && (d.clientParts || []).includes(x.id))) out.push({ kind: "PART", description: `Extra: ${x.name}${x.brand ? ` (${x.brand})` : ""}`.slice(0, 300), qty: x.qty || 1, amount: r2((x.qty || 1) * adj(x.unitPrice)) });
    for (const x of d.quotes || []) out.push({ kind: "QUOTE", description: `Extra: ${x.description} (third party)`.slice(0, 300), qty: x.qty || 1, amount: r2((x.qty || 1) * adj(x.price)) });
  }
  return out.filter((l) => l.amount > 0);
}
 
async function replaceLines(db, invoiceId, source, lines) {
  await db.query("DELETE FROM invoice_line WHERE invoice_id = $1 AND source = $2", [invoiceId, source]);
  let n = source === "EXTRA" ? 1000 : 0;
  for (const l of lines) {
    n += 1;
    await db.query("INSERT INTO invoice_line (invoice_id, source, kind, description, qty, unit_price, amount, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [invoiceId, source, l.kind, l.description, l.qty, r2(l.amount / (l.qty || 1)), l.amount, n]);
  }
}
 
// creates the invoice of the job when the Customer Approval stage is completed (nothing happens if it exists, or for a transferred job)
async function createInvoice(db, jobId, userId = null, isRoot = false, pre = null) {
  if (!isRoot) { const root = await rootJobId(db, jobId); if (!root || root !== jobId) return null; }
  const exists = await db.query("SELECT id FROM invoice WHERE job_id = $1", [jobId]);
  if (exists.rowCount) return exists.rows[0].id;
  const { lines, completed } = pre || await approvalLines(db, jobId);
  if (!completed) return null;
  const cfg = await invoiceSettings(pool);   // read on its own connection: a failed read must not abort the caller's transaction
  const st = { p: cfg.vatPercent, defaultOn: cfg.vatDefaultOn };
  const prefix = String(cfg.prefix ?? "INV-").slice(0, 8), digits = Math.min(10, Math.max(3, Number(cfg.digits) || 5));
  const no = (await db.query("SELECT $1::text || lpad(nextval('invoice_no_seq')::text, $2::int, '0') AS n", [prefix, digits])).rows[0].n;
  const ins = await db.query("INSERT INTO invoice (invoice_no, job_id, tax_enabled, tax_percent, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id", [no, jobId, st.defaultOn, st.p, userId]);
  await replaceLines(db, ins.rows[0].id, "APPROVAL", lines);
  await recalc(db, ins.rows[0].id);
  return ins.rows[0].id;
}
 
async function jobInfo(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo", d.name AS "departmentName",
            c.customer_name AS "customerName", c.contact_number AS "contactNumber"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
 
// the company profile of the Settings module (name, logo, address, phone, email, website)
async function companyProfile(db) {
  const base = { name: "KARUNARATHNE AUTO ZONE", logoUrl: "", address: "", phone: "", email: "", website: "" };
  try {
    const r = await db.query("SELECT key, value FROM app_setting WHERE group_key = 'company'");
    const saved = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    const old = (await db.query("SELECT company_address AS a, company_phone AS p, company_email AS e FROM invoice_setting WHERE id = 1").catch(() => ({ rows: [] }))).rows[0] || {};
    return { ...base, address: old.a || "", phone: old.p || "", email: old.e || "", ...saved };
  } catch (_) { return base; }
}
 
async function view(db, rootId) {
  const inv = (await db.query(
    `SELECT id, invoice_no AS "invoiceNo", status, subtotal::float AS subtotal, discount_amount::float AS "discountAmount", tax_enabled AS "taxEnabled", tax_percent::float AS "taxPercent",
            tax_amount::float AS "taxAmount", total::float AS total, paid_amount::float AS "paidAmount", COALESCE(notes, '') AS notes, created_at AS "createdAt"
     FROM invoice WHERE job_id = $1`, [rootId])).rows[0];
  if (!inv) return null;
  const [lines, pays, cfg] = await Promise.all([
    db.query(`SELECT id, source, kind, description, qty::float AS qty, unit_price::float AS "unitPrice", amount::float AS amount FROM invoice_line WHERE invoice_id = $1 ORDER BY sort_order, id`, [inv.id]),
    db.query(`SELECT p.id, p.amount::float AS amount, p.method, COALESCE(p.reference, '') AS reference, COALESCE(p.note, '') AS note, to_char(p.paid_at, 'YYYY-MM-DD') AS "paidAt", p.voided_at AS "voidedAt",
                     trim(concat(u.first_name, ' ', u.last_name)) AS "receivedByName"
              FROM invoice_payment p LEFT JOIN admin_user u ON u.id = p.received_by WHERE p.invoice_id = $1 ORDER BY p.paid_at, p.id`, [inv.id]),
    invoiceSettings(db),
  ]);
  const company = await companyProfile(db);
  const doc = {
    footerNote: cfg.footerNote || "", terms: cfg.terms || [],
    bank: cfg.showBank && (cfg.bankName || cfg.bankAccountNo) ? { name: cfg.bankName, accountName: cfg.bankAccountName, accountNo: cfg.bankAccountNo, branch: cfg.bankBranch } : null,
  };
  return { invoice: { ...inv, balance: r2(inv.total - inv.paidAmount), vatRegNo: cfg.vatRegNo || null, company, doc }, lines: lines.rows, payments: pays.rows, methods: cfg.methods, maxDiscountPercent: cfg.maxDiscountPercent };
}
 
// GET /jobs/:id  -> the invoice of the job (created / refreshed when needed). 404 + { exists: false } before the Customer Approval is completed
router.get("/jobs/:id", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const root = await rootJobId(pool, jobId).catch(() => null);   // outside the transaction (a failed query would abort it)
  if (!root) return res.status(404).json({ message: "Job not found" });
  // everything that is only READ (the approved statement, the extra scope lines) is read before the transaction:
  // those reads tolerate a missing table, and a failed query inside a transaction would abort all the rest of it
  let pre = null, extra = [];
  try {
    const has = await pool.query("SELECT 1 FROM invoice WHERE job_id = $1", [root]);
    if (!has.rowCount) pre = await approvalLines(pool, root);
    extra = await extraLines(pool, root);
  } catch (e) { console.error("load invoice (read):", e.code, e.message, e.stack); return res.status(500).json({ message: "Server error" }); }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let id = await createInvoice(client, root, currentUserId(req), true, pre);
    if (!id) { await client.query("ROLLBACK"); return res.status(404).json({ exists: false, message: "The invoice is created when the Customer Approval stage is completed" }); }
    // the approved Extra Job Scope lines are kept up to date until the invoice has payments
    const inv = (await client.query("SELECT status FROM invoice WHERE id = $1", [id])).rows[0];
    if (inv.status !== "CANCELLED") { await replaceLines(client, id, "EXTRA", extra); await recalc(client, id); }
    await client.query("COMMIT");
    const [job, v] = await Promise.all([jobInfo(pool, root), view(pool, root)]);
    return res.json({ job, ...v, viewedJobId: jobId, rootJobId: root });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("load invoice:", e.code, e.message, e.detail || "", e.stack);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
async function withInvoice(req, res, fn) {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const root = await rootJobId(pool, jobId).catch(() => null);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = root ? (await client.query("SELECT id, status, total::float AS total, paid_amount::float AS paid FROM invoice WHERE job_id = $1 FOR UPDATE", [root])).rows[0] : null;
    if (!row) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Invoice not found" }); }
    const out = await fn(client, row, root);
    if (out && out.error) { await client.query("ROLLBACK"); return res.status(out.status || 400).json({ message: out.error }); }
    await recalc(client, row.id);
    await client.query("COMMIT");
    return res.json({ ok: true, ...(await view(pool, root)) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("invoice update:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
}
 
// PUT /jobs/:id  { discountAmount?, taxEnabled?, taxPercent?, notes? }
router.put("/jobs/:id", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  const b = req.body || {};
  const sets = [], vals = [inv.id];
  const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.discountAmount !== undefined) {
    const d = money(b.discountAmount); if (Number.isNaN(d)) return { error: "Invalid discount" };
    const maxPct = Number((await invoiceSettings(db)).maxDiscountPercent);
    const sub = (await db.query("SELECT subtotal::float AS s FROM invoice WHERE id = $1", [inv.id])).rows[0].s;
    if (Number.isFinite(maxPct) && maxPct < 100 && d > r2(sub * maxPct / 100) + 0.001) return { error: `The discount cannot be more than ${maxPct}% of the sub total` };
    put("discount_amount", d);
  }
  if (b.taxEnabled !== undefined) put("tax_enabled", b.taxEnabled === true);
  if (b.taxPercent !== undefined) { const p = money(b.taxPercent, 100); if (Number.isNaN(p)) return { error: "Invalid tax percentage" }; put("tax_percent", p); }
  if (b.notes !== undefined) put("notes", clean(b.notes)?.slice(0, 1000) || null);
  if (sets.length) await db.query(`UPDATE invoice SET ${sets.join(", ")} WHERE id = $1`, vals);
  return null;
}));
 
// POST /jobs/:id/lines  { description, qty, unitPrice }   (a manual line)
router.post("/jobs/:id/lines", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  const description = clean(req.body?.description)?.slice(0, 300);
  const qty = Number(req.body?.qty ?? 1), unit = money(req.body?.unitPrice);
  if (!description) return { error: "Enter the description" };
  if (!(qty > 0 && qty <= 9999)) return { error: "Invalid quantity" };
  if (Number.isNaN(unit) || !(unit > 0)) return { error: "Enter the price" };
  const n = (await db.query("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM invoice_line WHERE invoice_id = $1 AND source = 'MANUAL'", [inv.id])).rows[0].n;
  await db.query("INSERT INTO invoice_line (invoice_id, source, kind, description, qty, unit_price, amount, sort_order) VALUES ($1, 'MANUAL', 'OTHER', $2, $3, $4, $5, $6)", [inv.id, description, qty, unit, r2(qty * unit), 2000 + Number(n)]);
  return null;
}));
 
// DELETE /jobs/:id/lines/:lid   (manual lines only)
router.delete("/jobs/:id/lines/:lid", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  const lid = toInt(req.params.lid);
  if (!Number.isInteger(lid)) return { error: "Invalid line" };
  const r = await db.query("DELETE FROM invoice_line WHERE id = $1 AND invoice_id = $2 AND source = 'MANUAL'", [lid, inv.id]);
  return r.rowCount ? null : { error: "Only the lines added here can be removed" };
}));
 
// POST /jobs/:id/payments  { amount, method, reference?, note?, paidAt? }
router.post("/jobs/:id/payments", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  const b = req.body || {};
  const amount = money(b.amount);
  if (Number.isNaN(amount) || !(amount > 0)) return { error: "Enter the payment amount" };
  if (!(await invoiceSettings(db)).methods.includes(b.method)) return { error: "Select the payment method" };
  if (amount > r2(inv.total - inv.paid) + 0.001) return { error: "The payment is more than the balance" };
  const paidAt = clean(b.paidAt);
  if (paidAt && !/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) return { error: "Invalid payment date" };
  await db.query("INSERT INTO invoice_payment (invoice_id, amount, method, reference, note, paid_at, received_by) VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7)",
    [inv.id, amount, b.method, clean(b.reference)?.slice(0, 120) || null, clean(b.note)?.slice(0, 500) || null, paidAt, currentUserId(req)]);
  return null;
}));
 
// DELETE /jobs/:id/payments/:pid   (void a payment; it stays in the list as voided)
router.delete("/jobs/:id/payments/:pid", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  const pid = toInt(req.params.pid);
  if (!Number.isInteger(pid)) return { error: "Invalid payment" };
  const r = await db.query("UPDATE invoice_payment SET voided_at = CURRENT_TIMESTAMP, voided_by = $3 WHERE id = $1 AND invoice_id = $2 AND voided_at IS NULL", [pid, inv.id, currentUserId(req)]);
  return r.rowCount ? null : { error: "Payment not found" };
}));
 
module.exports = router;
module.exports.createInvoice = createInvoice;
module.exports.replaceLines = replaceLines;
module.exports.recalc = recalc;
module.exports.rootJobId = rootJobId;
 