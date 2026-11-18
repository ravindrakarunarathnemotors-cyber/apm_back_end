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
  // discount of each item (a percentage or an amount) and the mode of the whole-invoice discount
  `ALTER TABLE public.invoice_line ADD COLUMN IF NOT EXISTS line_key text, ADD COLUMN IF NOT EXISTS disc_mode varchar(7) NOT NULL DEFAULT 'AMOUNT', ADD COLUMN IF NOT EXISTS disc_value numeric(14,2) NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS disc_amount numeric(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE public.invoice_payment ADD COLUMN IF NOT EXISTS tendered numeric(14,2)`,   // cash given by the customer (change = tendered - amount)
  // counter sales (an invoice without a job): who bought, the vehicle (optional) and the inventory item of a line
  `ALTER TABLE public.invoice ALTER COLUMN job_id DROP NOT NULL`,
  `ALTER TABLE public.invoice ADD COLUMN IF NOT EXISTS sale_customer_id integer, ADD COLUMN IF NOT EXISTS sale_customer_name text, ADD COLUMN IF NOT EXISTS sale_phone text, ADD COLUMN IF NOT EXISTS sale_reg_no text`,
  `ALTER TABLE public.invoice_line ADD COLUMN IF NOT EXISTS part_id integer, ADD COLUMN IF NOT EXISTS stock_loc integer`,
  `ALTER TABLE public.invoice ADD COLUMN IF NOT EXISTS disc_mode varchar(7) NOT NULL DEFAULT 'AMOUNT', ADD COLUMN IF NOT EXISTS disc_value numeric(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE public.invoice ADD COLUMN IF NOT EXISTS cancelled_job_id integer`,      // the inspection-fee invoice of a cancelled job
  // a cancelled job keeps its record: why, the inspection fee that was charged (if any), who and when
  `CREATE TABLE IF NOT EXISTS public.job_cancellation (
  id             serial PRIMARY KEY,
  job_id         integer NOT NULL UNIQUE,
  reason         text NOT NULL,
  inspection_fee numeric(14,2) NOT NULL DEFAULT 0,
  stage_no       integer,
  cancelled_by   integer,
  cancelled_at   timestamptz NOT NULL DEFAULT now()
)`,
  `ALTER TABLE public.job_cancellation ADD COLUMN IF NOT EXISTS fee_invoice_id integer`,
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
// "s12" = the counter-sale invoice with id 12 (no job); a number = a job
const parseRef = (v) => { const m = /^s(\d+)$/.exec(String(v || "")); if (m) return { sale: Number(m[1]) }; const n = toInt(v); return Number.isInteger(n) ? { job: n } : null; };
const saleErr = (status, message) => Object.assign(new Error(message), { status, expose: true });
// the item leaves the stock (counter sale) / comes back (line removed): one movement in the stock ledger
async function stockOut(db, { partId, qty, invoiceNo, userId }) {
  const inv = loadSibling(["inventory.routes", "inventory"]);
  const bal = await db.query("SELECT location_id AS loc, (qty_on_hand - qty_reserved)::float AS free FROM stock_balance WHERE part_id = $1 AND qty_on_hand - qty_reserved >= $2 ORDER BY qty_on_hand DESC LIMIT 1", [partId, qty]);
  if (!bal.rowCount) {
    const t = await db.query("SELECT COALESCE(SUM(qty_on_hand - qty_reserved), 0)::float AS free FROM stock_balance WHERE part_id = $1", [partId]);
    throw saleErr(400, `Not enough stock (available ${Math.max(0, t.rows[0].free)})`);
  }
  await inv.postMovement(db, { partId, locationId: bal.rows[0].loc, type: "ISSUE", qty: -qty, refNo: invoiceNo, note: "Counter sale", userId });
  return bal.rows[0].loc;
}
async function stockBack(db, { partId, qty, locationId, invoiceNo, userId }) {
  const inv = loadSibling(["inventory.routes", "inventory"]);
  const loc = locationId || (await db.query("SELECT id FROM stock_location WHERE is_active ORDER BY id LIMIT 1")).rows[0]?.id;
  if (loc) await inv.postMovement(db, { partId, locationId: loc, type: "RETURN", qty, refNo: invoiceNo, note: "Counter sale line removed", userId });
}
async function nextInvoiceNo(db, cfg) {
  const prefix = String(cfg.prefix ?? "INV-").slice(0, 8), digits = Math.min(10, Math.max(3, Number(cfg.digits) || 5));
  return (await db.query("SELECT $1::text || lpad(nextval('invoice_no_seq')::text, $2::int, '0') AS n", [prefix, digits])).rows[0].n;
}

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
  const inv = (await db.query("SELECT status, discount_amount::float AS d, disc_mode AS dm, disc_value::float AS dv, tax_enabled AS t, tax_percent::float AS p FROM invoice WHERE id = $1 FOR UPDATE", [invoiceId])).rows[0];
  // the discount of every item: a percentage of the item amount, or an amount (never more than the item amount)
  await db.query(
    `UPDATE invoice_line SET disc_amount = LEAST(amount, GREATEST(0, CASE WHEN disc_mode = 'PERCENT' THEN ROUND(amount * disc_value / 100, 2) ELSE disc_value END)) WHERE invoice_id = $1`, [invoiceId]);
  const t = (await db.query("SELECT COALESCE(SUM(amount), 0)::float AS s, COALESCE(SUM(disc_amount), 0)::float AS d FROM invoice_line WHERE invoice_id = $1", [invoiceId])).rows[0];
  const sub = r2(t.s), net = r2(t.s - t.d);                       // sub = before the item discounts, net = after them
  // the discount of the whole invoice: a percentage of the net amount, or an amount
  const discount = Math.min(inv.dm === "PERCENT" ? r2(net * inv.dv / 100) : r2(inv.d), net);
  const taxable = r2(net - discount);
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
  const { labour, parts, quotes } = helpers.billable(saved, ctx);   // the same lines as the Customer Approval estimate (agreed scope; the parts / third-party items the customer brings are not charged)
  const pct = Number(ctx.markupPercent) || 0;
  const adjU = (u) => Math.round((Number(u) || 0) * (100 + pct)) / 100;                                        // repair + manual lines
  const spct = Number(ctx.sparePercent ?? ctx.markupPercent) || 0;
  const adjS = (u) => Math.round((Number(u) || 0) * (100 + spct)) / 100;                                       // spare parts + quotations (own %)
  const out = [];
  const add = (kind, description, qty, amount) => { if (amount > 0) out.push({ kind, description: String(description).slice(0, 300), qty: Number(qty) || 1, amount: r2(amount) }); };
  if (saved.includeSpareParts) {
    for (const p of parts) add("PART", `${p.name}${p.brand ? ` (${p.brand})` : ""}`, p.qty, p.qty * adjS(p.unitPrice));
    for (const q of quotes || ctx.quotes) add("QUOTE", `${q.description} (third party)`, 1, adjS(q.quotedPrice));
  }
  if (saved.includeLabour) for (const l of labour) add("LABOUR", l.description, l.qty || 1, (l.qty || 1) * adjU(l.unitPrice ?? l.amount));
  // warranty claims are listed on the invoice but NOT charged (amount 0); the value they would have cost is written in the description
  const own = Array.isArray(saved.clientParts) ? saved.clientParts.map(Number) : [];
  const claim = (description, qty, value) => out.push({ kind: "WARRANTY", description: `${String(description).slice(0, 220)} - Warranty claim (not charged${value > 0 ? `, value LKR ${r2(value).toLocaleString("en-LK", { minimumFractionDigits: 2 })}` : ""})`, qty: Number(qty) || 1, amount: 0 });
  if (saved.includeSpareParts) for (const p of ctx.parts || []) if (p.warrantyClaim && !(saved.partsBy === "CLIENT" && own.includes(Number(p.id)))) claim(`${p.name}${p.brand ? ` (${p.brand})` : ""}`, p.qty, p.qty * adjS(p.unitPrice));
  if (saved.includeLabour) for (const l of ctx.labour || []) if (l.warrantyClaim) claim(l.description, l.qty || 1, (l.qty || 1) * adjU(l.unitPrice ?? l.amount));
  for (const m of saved.manualItems || []) add("OTHER", m.description || "Other", 1, adjU(Number(m.amount) || 0));
  for (const o of (saved.washItems || [])) add("WASH", o.name || o.description || "Wash", 1, Number(o.price) || 0);
  return { lines: out, completed: Boolean(saved.completedAt) };
}
 
// the approved Extra Job Scope lines (the scope was completed with a customer decision)
async function extraLines(db, jobId) {
  const pctRow = await db.query("SELECT COALESCE(price_markup_percent, 0)::float AS p, COALESCE(spare_markup_percent, price_markup_percent, 0)::float AS sp FROM job WHERE id = $1", [jobId]).catch(() => ({ rows: [] }));
  const jobPct = pctRow.rows[0]?.p || 0, jobSparePct = pctRow.rows[0]?.sp ?? jobPct;
  const rows = await db.query("SELECT seq, data FROM job_extra_scope WHERE job_id = $1 AND status IN ('APPROVED', 'PARTIAL') ORDER BY seq", [jobId]).catch(() => ({ rows: [] }));
  const out = [];
  for (const row of rows.rows) {
    const d = row.data || {};
    const pct = d.markupPercent ?? jobPct;
    const adj = (u) => Math.round((Number(u) || 0) * (100 + pct)) / 100;                          // repair lines
    const sparePct = d.sparePercent ?? (d.markupPercent != null ? d.markupPercent : jobSparePct);  // spare parts + quotations
    const adjS = (u) => Math.round((Number(u) || 0) * (100 + sparePct)) / 100;
    const agreed = (x) => d.decision !== "PARTIAL" || (d.agreedScope || []).includes(x.id);
    for (const x of d.labour || []) if (agreed(x)) out.push({ kind: "LABOUR", description: `Extra: ${x.label || x.description || "Repair"}`.slice(0, 300), qty: x.qty || 1, amount: r2((x.qty || 1) * adj(x.amount)) });
    for (const x of d.parts || []) if (!(d.partsBy === "CLIENT" && (d.clientParts || []).includes(x.id))) out.push({ kind: "PART", description: `Extra: ${x.name}${x.brand ? ` (${x.brand})` : ""}`.slice(0, 300), qty: x.qty || 1, amount: r2((x.qty || 1) * adjS(x.unitPrice)) });
    for (const x of d.quotes || []) if (!(d.partsBy === "CLIENT" && (d.clientParts || []).includes(x.id))) out.push({ kind: "QUOTE", description: `Extra: ${x.description} (third party)`.slice(0, 300), qty: x.qty || 1, amount: r2((x.qty || 1) * adjS(x.price)) });
  }
  return out.filter((l) => l.amount > 0);
}
 
async function replaceLines(db, invoiceId, source, lines) {
  // the lines are rebuilt from the approved statement; the discount given to an item stays with that item (matched by kind + description + occurrence)
  const keep = new Map((await db.query("SELECT line_key, disc_mode, disc_value::float AS v FROM invoice_line WHERE invoice_id = $1 AND source = $2 AND line_key IS NOT NULL AND disc_value > 0", [invoiceId, source])).rows.map((x) => [x.line_key, x]));
  await db.query("DELETE FROM invoice_line WHERE invoice_id = $1 AND source = $2", [invoiceId, source]);
  let n = source === "EXTRA" ? 1000 : 0;
  const seen = new Map();
  for (const l of lines) {
    n += 1;
    const base = `${source}|${l.kind}|${l.description}`;
    const occ = (seen.get(base) || 0) + 1; seen.set(base, occ);
    const key = `${base}|${occ}`, d = keep.get(key);
    await db.query("INSERT INTO invoice_line (invoice_id, source, kind, description, qty, unit_price, amount, sort_order, line_key, disc_mode, disc_value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [invoiceId, source, l.kind, l.description, l.qty, r2(l.amount / (l.qty || 1)), l.amount, n, key, d ? d.disc_mode : "AMOUNT", d ? d.v : 0]);
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
            c.customer_name AS "customerName", c.contact_number AS "contactNumber",
            (SELECT jsonb_build_object('reason', cn.reason, 'inspectionFee', cn.inspection_fee::float, 'cancelledAt', cn.cancelled_at,
              'feeInvoiceRef', CASE WHEN cn.fee_invoice_id IS NULL THEN NULL ELSE 's' || cn.fee_invoice_id END,
              'feeInvoiceNo', (SELECT fi.invoice_no FROM invoice fi WHERE fi.id = cn.fee_invoice_id)) FROM job_cancellation cn WHERE cn.job_id = j.id) AS cancellation
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
 
async function view(db, rootId, saleId = null) {
  const inv = (await db.query(
    `SELECT id, invoice_no AS "invoiceNo", status, subtotal::float AS subtotal, discount_amount::float AS "discountAmount", tax_enabled AS "taxEnabled", tax_percent::float AS "taxPercent",
            tax_amount::float AS "taxAmount", total::float AS total, paid_amount::float AS "paidAmount", COALESCE(notes, '') AS notes, created_at AS "createdAt",
            disc_mode AS "discountMode", disc_value::float AS "discountValue", (job_id IS NULL) AS "isSale"
     FROM invoice WHERE ${saleId ? "id = $1 AND job_id IS NULL" : "job_id = $1"}`, [saleId || rootId])).rows[0];
  if (!inv) return null;
  const [lines, pays, cfg] = await Promise.all([
    db.query(`SELECT id, source, kind, description, qty::float AS qty, unit_price::float AS "unitPrice", amount::float AS amount, part_id AS "partId",
                     disc_mode AS "discMode", disc_value::float AS "discValue", disc_amount::float AS "discAmount", (amount - disc_amount)::float AS net FROM invoice_line WHERE invoice_id = $1 ORDER BY sort_order, id`, [inv.id]),
    db.query(`SELECT p.id, p.amount::float AS amount, p.method, COALESCE(p.reference, '') AS reference, COALESCE(p.note, '') AS note, to_char(p.paid_at, 'YYYY-MM-DD') AS "paidAt", p.voided_at AS "voidedAt", p.tendered::float AS tendered,
                     trim(concat(u.first_name, ' ', u.last_name)) AS "receivedByName"
              FROM invoice_payment p LEFT JOIN admin_user u ON u.id = p.received_by WHERE p.invoice_id = $1 ORDER BY p.paid_at, p.id`, [inv.id]),
    invoiceSettings(db),
  ]);
  const company = await companyProfile(db);
  const doc = {
    footerNote: cfg.footerNote || "", terms: cfg.terms || [],
    bank: cfg.showBank && (cfg.bankName || cfg.bankAccountNo) ? { name: cfg.bankName, accountName: cfg.bankAccountName, accountNo: cfg.bankAccountNo, branch: cfg.bankBranch } : null,
  };
  return { invoice: { ...inv, lineDiscount: r2(lines.rows.reduce((x, l) => x + l.discAmount, 0)), balance: r2(inv.total - inv.paidAmount), vatRegNo: cfg.vatRegNo || null, company, doc }, lines: lines.rows, payments: pays.rows, methods: cfg.methods, maxDiscountPercent: cfg.maxDiscountPercent };
}
 
// GET /jobs/:id  -> the invoice of the job (created / refreshed when needed). 404 + { exists: false } before the Customer Approval is completed
// GET /list?q=&status=&from=&to=&page=&pageSize=   -> every invoice (Finance > Sales Invoice)
router.get("/list", authenticateToken, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80) || null;
  const status = ["UNPAID", "PARTIAL", "PAID", "CANCELLED"].includes(req.query.status) ? req.query.status : null;
  const dateOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const from = dateOk(req.query.from), to = dateOk(req.query.to);
  const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = `WHERE ($1::text IS NULL OR i.invoice_no ILIKE '%' || $1 || '%' OR COALESCE(j.job_no, cj.job_no) ILIKE '%' || $1 || '%' OR COALESCE(j.reg_no, i.sale_reg_no) ILIKE '%' || $1 || '%' OR COALESCE(c.customer_name, i.sale_customer_name) ILIKE '%' || $1 || '%')
                   AND ($2::text IS NULL OR i.status = $2) AND ($3::date IS NULL OR i.created_at::date >= $3::date) AND ($4::date IS NULL OR i.created_at::date <= $4::date)`;
  const from_ = `FROM invoice i LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id`;
  try {
    const [rows, sum] = await Promise.all([
      pool.query(
        `SELECT i.id, i.invoice_no AS "invoiceNo", i.job_id AS "jobId", CASE WHEN i.job_id IS NULL THEN 's' || i.id ELSE i.job_id::text END AS ref, (i.job_id IS NULL AND i.cancelled_job_id IS NULL) AS "isSale", (i.cancelled_job_id IS NOT NULL) AS "isCancelFee",
                COALESCE(j.job_no, cj.job_no) AS "jobNo", j.status AS "jobStatus", COALESCE(j.reg_no, i.sale_reg_no) AS "regNo", COALESCE(c.customer_name, i.sale_customer_name) AS "customerName",
                i.status, i.subtotal::float AS subtotal, i.discount_amount::float AS discount, i.tax_amount::float AS tax, i.total::float AS total, i.paid_amount::float AS paid,
                GREATEST(i.total - i.paid_amount, 0)::float AS balance, i.created_at AS "createdAt",
                (SELECT MAX(p.paid_at) FROM invoice_payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL) AS "lastPaidAt"
         ${from_} ${where} ORDER BY i.id DESC LIMIT $5 OFFSET $6`, [q, status, from, to, pageSize, (page - 1) * pageSize]),
      pool.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(i.total) FILTER (WHERE i.status <> 'CANCELLED'), 0)::float AS invoiced,
                COALESCE(SUM(i.paid_amount) FILTER (WHERE i.status <> 'CANCELLED'), 0)::float AS collected,
                COALESCE(SUM(GREATEST(i.total - i.paid_amount, 0)) FILTER (WHERE i.status <> 'CANCELLED'), 0)::float AS outstanding,
                COUNT(*) FILTER (WHERE i.status IN ('UNPAID', 'PARTIAL'))::int AS open
         ${from_} ${where}`, [q, status, from, to]),
    ]);
    const t = sum.rows[0];
    return res.json({ invoices: rows.rows, summary: t, page, pageSize, totalPages: Math.max(1, Math.ceil(t.count / pageSize)) });
  } catch (e) { console.error("invoice list:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

router.get("/jobs/:id", authenticateToken, async (req, res) => {
  const ref = parseRef(req.params.id);
  if (ref && ref.sale) {                                    // counter sale: no job, no Customer Approval
    try {
      const v = await view(pool, null, ref.sale);
      if (!v) return res.status(404).json({ message: "Invoice not found" });
      const x = (await pool.query("SELECT i.sale_customer_name AS n, i.sale_phone AS p, i.sale_reg_no AS r, cj.job_no AS \"cjNo\" FROM invoice i LEFT JOIN job cj ON cj.id = i.cancelled_job_id WHERE i.id = $1", [ref.sale])).rows[0] || {};
      const job = { id: req.params.id, jobNo: x.cjNo ? `${x.cjNo} (cancelled job)` : "Counter sale", cancelFeeOf: x.cjNo || null, regNo: x.r || "-", customerName: x.n || "Walk-in customer", contactNumber: x.p || null, departmentName: null, status: null };
      return res.json({ job, ...v, viewedJobId: req.params.id, rootJobId: req.params.id });
    } catch (e) { console.error("load sale invoice:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
  }
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const root = await rootJobId(pool, jobId).catch(() => null);   // outside the transaction (a failed query would abort it)
  if (!root) return res.status(404).json({ message: "Job not found" });
  // everything that is only READ (the approved statement, the extra scope lines) is read before the transaction:
  // those reads tolerate a missing table, and a failed query inside a transaction would abort all the rest of it
  let pre = null, extra = [];
  try {
    pre = await approvalLines(pool, root);   // read every time: the lines follow the Customer Approval estimate until the first payment
    extra = await extraLines(pool, root);
  } catch (e) { console.error("load invoice (read):", e.code, e.message, e.stack); return res.status(500).json({ message: "Server error" }); }
  const cancelledJob = (await pool.query("SELECT 1 FROM job_cancellation WHERE job_id = $1", [jobId]).catch(() => ({ rowCount: 0 }))).rowCount > 0
    || (await pool.query("SELECT 1 FROM job_cancellation WHERE job_id = $1", [root]).catch(() => ({ rowCount: 0 }))).rowCount > 0;
  if (cancelledJob && !(await pool.query("SELECT 1 FROM invoice WHERE job_id = $1", [root])).rowCount) return res.status(404).json({ exists: false, message: "This job was cancelled and has no invoice" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let id = await createInvoice(client, root, currentUserId(req), true, pre);
    if (!id) { await client.query("ROLLBACK"); return res.status(404).json({ exists: false, message: "The invoice is created when the Customer Approval stage is completed" }); }
    // the approved Extra Job Scope lines are kept up to date until the invoice has payments
    const inv = (await client.query("SELECT status FROM invoice WHERE id = $1", [id])).rows[0];
    // the approved statement lines are refreshed from the Customer Approval while the invoice has no payment (so the invoice always matches the approved estimate)
    const paidRows = (await client.query("SELECT COUNT(*)::int AS n FROM invoice_payment WHERE invoice_id = $1 AND voided_at IS NULL", [id])).rows[0].n;
    if (!cancelledJob && inv.status !== "CANCELLED" && paidRows === 0 && pre?.completed) await replaceLines(client, id, "APPROVAL", pre.lines);
    if (!cancelledJob && inv.status !== "CANCELLED") { await replaceLines(client, id, "EXTRA", extra); await recalc(client, id); }
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
  const ref = parseRef(req.params.id);
  if (!ref) return res.status(400).json({ message: "Invalid job" });
  const root = ref.job ? await rootJobId(pool, ref.job).catch(() => null) : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = ref.sale
      ? (await client.query("SELECT id, status, invoice_no AS \"no\", true AS sale, total::float AS total, paid_amount::float AS paid FROM invoice WHERE id = $1 AND job_id IS NULL FOR UPDATE", [ref.sale])).rows[0]
      : root ? (await client.query("SELECT id, status, invoice_no AS \"no\", false AS sale, total::float AS total, paid_amount::float AS paid FROM invoice WHERE job_id = $1 FOR UPDATE", [root])).rows[0] : null;
    if (!row) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Invoice not found" }); }
    const out = await fn(client, row, root);
    if (out && out.error) { await client.query("ROLLBACK"); return res.status(out.status || 400).json({ message: out.error }); }
    await recalc(client, row.id);
    await client.query("COMMIT");
    return res.json({ ok: true, ...(await view(pool, root, ref.sale || null)) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    if (e.expose) return res.status(e.status || 400).json({ message: e.message });
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
  // the discount of the whole invoice: { discountMode: "PERCENT" | "AMOUNT", discountValue }  (discountAmount = an amount, kept for the old screens)
  if (b.discountValue !== undefined || b.discountAmount !== undefined) {
    const mode = b.discountMode === "PERCENT" ? "PERCENT" : "AMOUNT";
    const v = money(b.discountValue !== undefined ? b.discountValue : b.discountAmount, mode === "PERCENT" ? 100 : 999999999);
    if (Number.isNaN(v)) return { error: mode === "PERCENT" ? "Enter a discount between 0 and 100 %" : "Invalid discount" };
    const maxPct = Number((await invoiceSettings(db)).maxDiscountPercent);
    const t = (await db.query("SELECT COALESCE(SUM(amount - disc_amount), 0)::float AS n FROM invoice_line WHERE invoice_id = $1", [inv.id])).rows[0];
    const d = mode === "PERCENT" ? r2(t.n * v / 100) : v;
    if (d > t.n + 0.001) return { error: "The discount is more than the invoice amount" };
    if (Number.isFinite(maxPct) && maxPct < 100 && d > r2(t.n * maxPct / 100) + 0.001) return { error: `The discount cannot be more than ${maxPct}% of the sub total` };
    put("disc_mode", mode); put("disc_value", v); put("discount_amount", d);
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
  const partId = inv.sale ? toInt(req.body?.partId) : null;      // an inventory item (counter sales only): the stock goes down
  let description = clean(req.body?.description)?.slice(0, 300), unitIn = req.body?.unitPrice;
  const qty = Number(req.body?.qty ?? 1);
  if (!(qty > 0 && qty <= 9999)) return { error: "Invalid quantity" };
  if (Number.isInteger(partId)) {
    const p = (await db.query("SELECT name, brand, price::float AS price FROM spare_part WHERE id = $1 AND is_active", [partId])).rows[0];
    if (!p) return { error: "Item not found" };
    description = description || [p.name, p.brand].filter(Boolean).join(" - ").slice(0, 300);
    if (unitIn === undefined || unitIn === null || unitIn === "") unitIn = p.price;
  }
  const unit = money(unitIn);
  if (!description) return { error: "Enter the description" };
  if (Number.isNaN(unit) || !(unit > 0)) return { error: "Enter the price" };
  let loc = null;
  if (Number.isInteger(partId)) loc = await stockOut(db, { partId, qty, invoiceNo: inv.no, userId: currentUserId(req) });
  const n = (await db.query("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM invoice_line WHERE invoice_id = $1 AND source = 'MANUAL'", [inv.id])).rows[0].n;
  await db.query("INSERT INTO invoice_line (invoice_id, source, kind, description, qty, unit_price, amount, sort_order, part_id, stock_loc) VALUES ($1, 'MANUAL', $2, $3, $4, $5, $6, $7, $8, $9)",
    [inv.id, Number.isInteger(partId) ? "PART" : "OTHER", description, qty, unit, r2(qty * unit), 2000 + Number(n), Number.isInteger(partId) ? partId : null, loc]);
  return null;
}));
 
// DELETE /jobs/:id/lines/:lid   (manual lines only; an inventory item of a counter sale goes back to the stock)
router.delete("/jobs/:id/lines/:lid", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  const lid = toInt(req.params.lid);
  if (!Number.isInteger(lid)) return { error: "Invalid line" };
  const r = await db.query("DELETE FROM invoice_line WHERE id = $1 AND invoice_id = $2 AND source = 'MANUAL' RETURNING part_id, qty::float AS qty, stock_loc", [lid, inv.id]);
  if (!r.rowCount) return { error: "Only the lines added here can be removed" };
  const l = r.rows[0];
  if (inv.sale && l.part_id) await stockBack(db, { partId: l.part_id, qty: l.qty, locationId: l.stock_loc, invoiceNo: inv.no, userId: currentUserId(req) });
  return null;
}));
 
// GET /sale-parts?q=   -> inventory items for a counter sale (with the stock that can be sold)
router.get("/sale-parts", authenticateToken, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 60) || null;
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.part_no AS "partNo", p.brand, p.quality, p.unit, p.price::float AS price,
              COALESCE(SUM(b.qty_on_hand - b.qty_reserved), 0)::float AS available
       FROM spare_part p LEFT JOIN stock_balance b ON b.part_id = p.id
       WHERE p.is_active AND ($1::text IS NULL OR p.name ILIKE '%' || $1 || '%' OR p.part_no ILIKE '%' || $1 || '%' OR p.brand ILIKE '%' || $1 || '%' OR p.sku ILIKE '%' || $1 || '%' OR p.barcode = $1)
       GROUP BY p.id ORDER BY p.name LIMIT 30`, [q]);
    return res.json(r.rows);
  } catch (e) { console.error("sale parts:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// GET /sale-services?q=   -> the repair types of every department (parent > child, with the labour price) for a counter sale
router.get("/sale-services", authenticateToken, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 60) || null;
  try {
    const r = await pool.query(
      `SELECT d.name AS department, p.name AS parent, c.id, c.name, c.price::float AS price
       FROM complaint_option_list l
       JOIN department d ON d.id = l.department_id AND d.is_active
       JOIN complaint_option p ON p.list_id = l.id AND p.is_active AND btrim(COALESCE(p.group_name, '')) = ''
       JOIN complaint_option c ON c.list_id = l.id AND c.is_active AND lower(btrim(c.group_name)) = lower(btrim(p.name))
       WHERE l.is_active AND (l.code ILIKE '%\\_TYPE' OR l.title ILIKE '%repair type%' OR l.title ILIKE '%concern type%')
         AND ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%' OR d.name ILIKE '%' || $1 || '%')
       ORDER BY d.name, p.sort_order, p.id, c.sort_order, c.id LIMIT 200`, [q]);
    return res.json(r.rows);
  } catch (e) { console.error("sale services:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// GET /sale-customers?q=   -> existing customers for a counter sale
router.get("/sale-customers", authenticateToken, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 60) || null;
  try {
    const r = await pool.query(
      `SELECT id, customer_name AS name, contact_number AS phone FROM customer
       WHERE $1::text IS NULL OR customer_name ILIKE '%' || $1 || '%' OR contact_number ILIKE '%' || $1 || '%' ORDER BY customer_name LIMIT 20`, [q]);
    return res.json(r.rows);
  } catch (e) { console.error("sale customers:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /sale  { customerId?, customerName?, phone?, regNo?, notes?, lines: [{ partId?, description?, qty, unitPrice? }] }
//   -> a counter-sale invoice (no job). Inventory items leave the stock; the invoice then opens like any other (discount, VAT, payments).
router.post("/sale", authenticateToken, async (req, res) => {
  const b = req.body || {};
  const input = Array.isArray(b.lines) ? b.lines : [];
  if (!input.length) return res.status(400).json({ message: "Add at least one item" });
  if (input.length > 100) return res.status(400).json({ message: "Too many items" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let name = clean(b.customerName)?.slice(0, 150), phone = clean(b.phone)?.slice(0, 30), cid = toInt(b.customerId);
    if (Number.isInteger(cid)) {
      const c = (await client.query("SELECT customer_name AS n, contact_number AS p FROM customer WHERE id = $1", [cid])).rows[0];
      if (!c) throw saleErr(400, "Customer not found");
      name = name || c.n; phone = phone || c.p;
    } else cid = null;
    if (!name) throw saleErr(400, "Enter the customer name");
    const cfg = await invoiceSettings(pool);
    const no = await nextInvoiceNo(client, cfg);
    const ins = await client.query(
      `INSERT INTO invoice (invoice_no, job_id, tax_enabled, tax_percent, notes, created_by, sale_customer_id, sale_customer_name, sale_phone, sale_reg_no)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [no, cfg.vatDefaultOn, cfg.vatPercent, clean(b.notes)?.slice(0, 1000) || null, currentUserId(req), cid, name, phone || null, clean(b.regNo)?.slice(0, 20)?.toUpperCase() || null]);
    const id = ins.rows[0].id;
    let n = 0;
    for (const l of input) {
      n += 1;
      const qty = Number(l.qty ?? 1);
      if (!(qty > 0 && qty <= 9999)) throw saleErr(400, `Item ${n}: invalid quantity`);
      const partId = toInt(l.partId);
      let description = clean(l.description)?.slice(0, 300), unitIn = l.unitPrice;
      if (Number.isInteger(partId)) {
        const p = (await client.query("SELECT name, brand, price::float AS price FROM spare_part WHERE id = $1 AND is_active", [partId])).rows[0];
        if (!p) throw saleErr(400, `Item ${n}: item not found`);
        description = description || [p.name, p.brand].filter(Boolean).join(" - ").slice(0, 300);
        if (unitIn === undefined || unitIn === null || unitIn === "") unitIn = p.price;
      }
      const unit = money(unitIn);
      if (!description) throw saleErr(400, `Item ${n}: enter the description`);
      if (Number.isNaN(unit) || !(unit > 0)) throw saleErr(400, `Item ${n}: enter the price`);
      let loc = null;
      if (Number.isInteger(partId)) {
        try { loc = await stockOut(client, { partId, qty, invoiceNo: no, userId: currentUserId(req) }); }
        catch (e) { if (e.expose) throw saleErr(400, `${description}: ${e.message}`); throw e; }
      }
      await client.query("INSERT INTO invoice_line (invoice_id, source, kind, description, qty, unit_price, amount, sort_order, part_id, stock_loc) VALUES ($1, 'MANUAL', $2, $3, $4, $5, $6, $7, $8, $9)",
        [id, Number.isInteger(partId) ? "PART" : "OTHER", description, qty, unit, r2(qty * unit), 2000 + n, Number.isInteger(partId) ? partId : null, loc]);
    }
    await recalc(client, id);
    await client.query("COMMIT");
    return res.status(201).json({ id, ref: `s${id}`, invoiceNo: no });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    if (e.expose) return res.status(e.status || 400).json({ message: e.message });
    console.error("create sale invoice:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

// PUT /jobs/:id/lines/:lid/discount  { mode: "PERCENT" | "AMOUNT", value }   -> the discount of one item (value 0 removes it)
router.put("/jobs/:id/lines/:lid/discount", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  const lid = toInt(req.params.lid);
  if (!Number.isInteger(lid)) return { error: "Invalid item" };
  const mode = req.body?.mode === "PERCENT" ? "PERCENT" : "AMOUNT";
  const v = money(req.body?.value ?? 0, mode === "PERCENT" ? 100 : 999999999);
  if (Number.isNaN(v)) return { error: mode === "PERCENT" ? "Enter a discount between 0 and 100 %" : "Invalid discount" };
  const line = (await db.query("SELECT amount::float AS a FROM invoice_line WHERE id = $1 AND invoice_id = $2", [lid, inv.id])).rows[0];
  if (!line) return { error: "Item not found", status: 404 };
  const d = mode === "PERCENT" ? r2(line.a * v / 100) : v;
  if (d > line.a + 0.001) return { error: "The discount is more than the item amount" };
  const maxPct = Number((await invoiceSettings(db)).maxDiscountPercent);
  if (Number.isFinite(maxPct) && maxPct < 100 && d > r2(line.a * maxPct / 100) + 0.001) return { error: `The discount cannot be more than ${maxPct}% of the item amount` };
  await db.query("UPDATE invoice_line SET disc_mode = $3, disc_value = $4 WHERE id = $1 AND invoice_id = $2", [lid, inv.id, mode, v]);
  return null;
}));
 

// POST /jobs/:id/cancel  { reason, inspectionFee? }
// The job is cancelled and a record is kept (reason, fee, who, when). With an inspection fee the invoice holds ONLY that fee;
// without a fee the invoice is cancelled (nothing to pay).
router.post("/jobs/:id/cancel", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const reason = clean(req.body?.reason)?.slice(0, 500);
  if (!reason || reason.length < 3) return res.status(400).json({ message: "Type the reason for cancelling the job" });
  const feeRaw = req.body?.inspectionFee;
  const fee = feeRaw === undefined || feeRaw === null || feeRaw === "" ? 0 : money(feeRaw, 100000000);
  if (!Number.isFinite(fee)) return res.status(400).json({ message: "Enter a valid inspection fee" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = (await client.query("SELECT id, status, current_stage_no AS \"stageNo\" FROM job WHERE id = $1 FOR UPDATE", [jobId])).rows[0];
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (job.status === "CANCELLED") { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is already cancelled" }); }
    if (job.status === "COMPLETED") { await client.query("ROLLBACK"); return res.status(409).json({ message: "A completed job cannot be cancelled" }); }
    // spare parts that are issued to the technician must go back to the stock first (a reservation alone is released below)
    const out = (await client.query("SELECT name, brand, (issued_qty - returned_qty)::float AS net FROM job_spare_part WHERE job_id = $1 AND issued_qty - returned_qty > 0 ORDER BY id", [jobId])).rows;
    if (out.length) {
      await client.query("ROLLBACK");
      const list = out.slice(0, 5).map((x) => `${x.name}${x.brand ? ` (${x.brand})` : ""} x ${x.net}`).join(", ") + (out.length > 5 ? ` and ${out.length - 5} more` : "");
      return res.status(409).json({ code: "PARTS_ISSUED", message: `Return the issued spare parts to the stock before cancelling the job: ${list}` });
    }
    const root = await rootJobId(client, jobId);
    let inv = (await client.query("SELECT id, paid_amount::float AS paid FROM invoice WHERE job_id = $1 FOR UPDATE", [root])).rows[0];
    if (inv && inv.paid > 0) { await client.query("ROLLBACK"); return res.status(409).json({ message: "A payment is already recorded on the job invoice. Void the payment first." }); }

    await client.query("INSERT INTO job_cancellation (job_id, reason, inspection_fee, stage_no, cancelled_by) VALUES ($1, $2, $3, $4, $5)", [jobId, reason, fee, job.stageNo, currentUserId(req)]);
    await client.query("UPDATE job SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [jobId]);
    // the stock that was only RESERVED for this job goes back to the available stock
    const held = (await client.query("SELECT id, part_id, reserve_location_id AS loc, reserved_qty::float AS qty FROM job_spare_part WHERE job_id = $1 AND reserved_qty > 0 FOR UPDATE", [jobId])).rows;
    for (const h of held) {
      if (h.loc) await client.query("UPDATE stock_balance SET qty_reserved = GREATEST(0, qty_reserved - $3) WHERE part_id = $1 AND location_id = $2", [h.part_id, h.loc, h.qty]);
      await client.query("UPDATE job_spare_part SET reserved_qty = 0, reserve_location_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [h.id]);
    }

    // the invoice that was already created stays as it was (its lines are kept for the record) but is marked CANCELLED
    if (inv) await client.query("UPDATE invoice SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [inv.id]);
    // an inspection fee gets its OWN new invoice (linked to the cancelled job)
    if (fee > 0) {
      const cfg = await invoiceSettings(pool);
      const who = (await client.query("SELECT c.id AS cid, c.customer_name AS name, c.contact_number AS phone, j.reg_no AS reg, j.job_no AS no FROM job j JOIN customer c ON c.id = j.customer_id WHERE j.id = $1", [jobId])).rows[0];
      const no = await nextInvoiceNo(client, cfg);
      const fi = (await client.query(
        `INSERT INTO invoice (invoice_no, job_id, tax_enabled, tax_percent, notes, created_by, sale_customer_id, sale_customer_name, sale_phone, sale_reg_no, cancelled_job_id)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [no, cfg.vatDefaultOn, cfg.vatPercent, `Inspection fee - job ${who.no} was cancelled`, currentUserId(req), who.cid, who.name, who.phone || null, who.reg || null, jobId])).rows[0];
      await client.query("INSERT INTO invoice_line (invoice_id, source, kind, description, qty, unit_price, amount, sort_order) VALUES ($1, 'MANUAL', 'OTHER', 'Inspection fee', 1, $2, $2, 1)", [fi.id, fee]);
      await recalc(client, fi.id);
      await client.query("UPDATE job_cancellation SET fee_invoice_id = $2 WHERE job_id = $1", [jobId, fi.id]);
    }
    await client.query("COMMIT");
    return res.json({ ok: true, job: await jobInfo(pool, jobId), inspectionFee: fee });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    if (e.code === "23505") return res.status(409).json({ message: "This job is already cancelled" });
    console.error("cancel job:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

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