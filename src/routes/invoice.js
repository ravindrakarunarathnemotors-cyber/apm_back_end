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
  `ALTER TABLE public.invoice ADD COLUMN IF NOT EXISTS public_token text`,
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE INDEX IF NOT EXISTS customer_name_trgm_idx ON public.customer USING gin (customer_name gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS customer_contact_trgm_idx ON public.customer USING gin (contact_number gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS customer_vehicle_reg_trgm_idx ON public.customer_vehicle USING gin ((regexp_replace(lower(reg_no), '[\\s-]', '', 'g')) gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS customer_vehicle_customer_idx ON public.customer_vehicle (customer_id)`,
  `CREATE INDEX IF NOT EXISTS spare_part_name_trgm_idx ON public.spare_part USING gin (name gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS spare_part_partno_trgm_idx ON public.spare_part USING gin (part_no gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS spare_part_brand_trgm_idx ON public.spare_part USING gin (brand gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS stock_balance_part_idx ON public.stock_balance (part_id)`,
  `ALTER TABLE public.invoice_payment ADD COLUMN IF NOT EXISTS due_date date`,
  `CREATE UNIQUE INDEX IF NOT EXISTS invoice_public_token_uq ON public.invoice (public_token) WHERE public_token IS NOT NULL`,
  `ALTER TABLE public.invoice_line ADD COLUMN IF NOT EXISTS part_id integer, ADD COLUMN IF NOT EXISTS stock_loc integer`,
  `ALTER TABLE public.invoice_line ADD COLUMN IF NOT EXISTS is_manual boolean NOT NULL DEFAULT false`,   // the item was typed in by hand (repair item / spare part not from the lists)
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
  // "job completed -> invoice ready" notification is sent once per job
  `CREATE TABLE IF NOT EXISTS public.job_invoice_notice (job_id integer PRIMARY KEY, notified_at timestamptz NOT NULL DEFAULT now())`,
  // the invoice screens read these by invoice / job on every open
  `CREATE INDEX IF NOT EXISTS invoice_line_invoice_idx ON public.invoice_line (invoice_id)`,
  `CREATE INDEX IF NOT EXISTS invoice_payment_invoice_idx ON public.invoice_payment (invoice_id)`,
  `CREATE INDEX IF NOT EXISTS invoice_created_idx ON public.invoice (created_at DESC)`,
  // sales returns / exchanges (counter sales). The invoice keeps its original lines; the total of the invoice = gross_total - returned_amount,
  // the paid amount = payments - refunded_amount (money given back, or moved to the exchange invoice)
  `ALTER TABLE public.invoice ADD COLUMN IF NOT EXISTS gross_total numeric(14,2) NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS returned_amount numeric(14,2) NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS refunded_amount numeric(14,2) NOT NULL DEFAULT 0`,
  `UPDATE public.invoice SET gross_total = total + returned_amount WHERE gross_total = 0 AND total > 0`,   // invoices made before returns existed
  `CREATE SEQUENCE IF NOT EXISTS public.sales_return_no_seq`,
  // who changed what on an invoice (Invoice window > History)
  `CREATE TABLE IF NOT EXISTS public.invoice_audit (
  id         bigserial PRIMARY KEY,
  invoice_id integer NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    integer,
  action     varchar(24) NOT NULL,
  summary    text NOT NULL,
  details    jsonb
)`,
  `CREATE INDEX IF NOT EXISTS invoice_audit_invoice_idx ON public.invoice_audit (invoice_id, at DESC)`,
  // the end-of-day cash count (Sales Report > Day close). A closed day keeps the figures of that moment; "reopen" keeps the old record.
  `CREATE TABLE IF NOT EXISTS public.day_close (
  id            serial PRIMARY KEY,
  close_date    date NOT NULL,
  opening_cash  numeric(14,2) NOT NULL DEFAULT 0,
  cash_received numeric(14,2) NOT NULL DEFAULT 0,
  cash_refunded numeric(14,2) NOT NULL DEFAULT 0,
  expected_cash numeric(14,2) NOT NULL DEFAULT 0,
  counted_cash  numeric(14,2) NOT NULL DEFAULT 0,
  difference    numeric(14,2) NOT NULL DEFAULT 0,
  note          text,
  snapshot      jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  closed_by     integer,
  closed_at     timestamptz NOT NULL DEFAULT now(),
  reopened_by   integer,
  reopened_at   timestamptz,
  reopen_reason text
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS day_close_active_uq ON public.day_close (close_date) WHERE is_active`,
  `CREATE TABLE IF NOT EXISTS public.sales_return (
  id                  serial PRIMARY KEY,
  return_no           varchar(20) NOT NULL UNIQUE,
  invoice_id          integer NOT NULL REFERENCES public.invoice (id) ON DELETE CASCADE,
  kind                varchar(8) NOT NULL DEFAULT 'RETURN',
  reason              varchar(40) NOT NULL,
  note                text,
  total_value         numeric(14,2) NOT NULL DEFAULT 0,
  refund_amount       numeric(14,2) NOT NULL DEFAULT 0,
  refund_method       varchar(16),
  transfer_amount     numeric(14,2) NOT NULL DEFAULT 0,
  exchange_invoice_id integer,
  late_override       boolean NOT NULL DEFAULT false,
  created_by          integer,
  created_at          timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE INDEX IF NOT EXISTS sales_return_invoice_idx ON public.sales_return (invoice_id)`,
  `CREATE TABLE IF NOT EXISTS public.sales_return_line (
  id              serial PRIMARY KEY,
  return_id       integer NOT NULL REFERENCES public.sales_return (id) ON DELETE CASCADE,
  invoice_line_id integer NOT NULL,
  part_id         integer,
  description     text NOT NULL,
  qty             numeric(10,2) NOT NULL,
  amount          numeric(14,2) NOT NULL DEFAULT 0,
  restock         boolean NOT NULL DEFAULT false
)`,
  `CREATE INDEX IF NOT EXISTS sales_return_line_line_idx ON public.sales_return_line (invoice_line_id)`,
  `CREATE INDEX IF NOT EXISTS sales_return_line_return_idx ON public.sales_return_line (return_id)`,
];
 
// the tables are created by the server itself (create_invoice.sql has the same statements)
(async () => {
  try { await new Promise((r) => setTimeout(r, 4000)); const ids = (await pool.query("SELECT DISTINCT invoice_id AS id FROM invoice_payment WHERE method = 'CREDIT' AND voided_at IS NULL")).rows; for (const x of ids) await recalc(pool, x.id); } catch (e) { console.error("credit recalc:", e.message); }
})();
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
// ---- permissions: the permission rows of admin_uimenudata (perm_key) that a role has ticked (admin_role.privileges holds their ids).
// A permission whose row does not exist yet (permissions_invoice.sql not run) allows everybody, so nothing stops working before the setup.
const PERMS = { return: "invoice.return", discount: "invoice.discount", edit: "invoice.edit", voidPayment: "invoice.void_payment", reopen: "dayclose.reopen", discountOver: "invoice.discount_over_limit" };
async function permsOf(req) {
  const out = {}; for (const k of Object.keys(PERMS)) out[k] = k !== "discountOver";   // discountOver is OFF until it is given (the max discount % keeps working)
  try {
    const r = await pool.query(
      `SELECT m.perm_key AS k, EXISTS (SELECT 1 FROM admin_user u JOIN admin_role r ON r.id = u.role_id WHERE u.id = $1 AND COALESCE(r.status, 'active') = 'active' AND m.id::text = ANY (r.privileges::text[])) AS ok
         FROM admin_uimenudata m WHERE m.perm_key = ANY ($2::text[])`, [currentUserId(req), Object.values(PERMS)]);
    for (const [name, key] of Object.entries(PERMS)) { const row = r.rows.find((x) => x.k === key); if (row) out[name] = row.ok; }
  } catch (e) { console.error("permissions:", e.code, e.message); }
  return out;
}
const denied = async (req, name, what) => ((await permsOf(req))[name] ? null : { error: `You do not have permission to ${what}`, status: 403 });
// ---- audit log: one row per change (written inside the same transaction; a problem with the log never stops the change itself)
async function audit(db, invoiceId, req, action, summary, details = null) {
  try {
    await db.query("SAVEPOINT aud");
    await db.query("INSERT INTO invoice_audit (invoice_id, user_id, action, summary, details) VALUES ($1, $2, $3, $4, $5::jsonb)", [invoiceId, currentUserId(req), action, String(summary).slice(0, 500), details ? JSON.stringify(details) : null]);
    await db.query("RELEASE SAVEPOINT aud");
  } catch (e) { try { await db.query("ROLLBACK TO SAVEPOINT aud"); } catch (_) { /* ignore */ } console.error("audit:", e.code, e.message); }
}
const fmtMoney = (n) => Number(n || 0).toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDisc = (mode, v) => (Number(v) > 0 ? (mode === "PERCENT" ? `${Number(v)}%` : `Rs. ${fmtMoney(v)}`) : "none");
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
  const inv = (await db.query("SELECT status, discount_amount::float AS d, disc_mode AS dm, disc_value::float AS dv, tax_enabled AS t, tax_percent::float AS p, returned_amount::float AS ra, refunded_amount::float AS fa FROM invoice WHERE id = $1 FOR UPDATE", [invoiceId])).rows[0];
  // the discount of every item: a percentage of the item amount, or an amount (never more than the item amount)
  await db.query(
    `UPDATE invoice_line SET disc_amount = LEAST(amount, GREATEST(0, CASE WHEN disc_mode = 'PERCENT' THEN ROUND(amount * disc_value / 100, 2) ELSE disc_value END)) WHERE invoice_id = $1`, [invoiceId]);
  const t = (await db.query("SELECT COALESCE(SUM(amount), 0)::float AS s, COALESCE(SUM(disc_amount), 0)::float AS d FROM invoice_line WHERE invoice_id = $1", [invoiceId])).rows[0];
  const sub = r2(t.s), net = r2(t.s - t.d);                       // sub = before the item discounts, net = after them
  // the discount of the whole invoice: a percentage of the net amount, or an amount
  const discount = Math.min(inv.dm === "PERCENT" ? r2(net * inv.dv / 100) : r2(inv.d), net);
  const taxable = r2(net - discount);
  const tax = inv.t ? r2(taxable * inv.p / 100) : 0;
  const gross = r2(taxable + tax);
  const total = r2(Math.max(0, gross - inv.ra));                   // what the customer owes after the items he returned
  const paid = r2(Math.max(0, (await db.query("SELECT COALESCE(SUM(amount), 0)::float AS s FROM invoice_payment WHERE invoice_id = $1 AND voided_at IS NULL AND method <> 'CREDIT'", [invoiceId])).rows[0].s - inv.fa));   // money received - money given back / moved to the exchange invoice   // "Credit (on account)" is not money received: it stays unpaid until it is paid later
  const status = inv.status === "CANCELLED" ? "CANCELLED" : (total > 0 && paid >= total) || (inv.ra > 0 && total <= 0.005) ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID";   // everything returned = settled
  await db.query("UPDATE invoice SET subtotal = $2, discount_amount = $3, tax_amount = $4, total = $5, paid_amount = $6, status = $7, gross_total = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [invoiceId, sub, discount, tax, total, paid, status, gross]);
}
 
// the lines of the approved statement (same amounts as the Customer Approval total, price adjustment included in each line)
async function approvalLines(db, jobId) {
  const { helpers } = loadSibling(["customer_approval.routes", "customer_approval", "customerApproval", "customer-approval", "customerApproval.routes"]);
  if (!helpers) throw new Error("customer approval routes file: add `module.exports.helpers = { context, loadSaved, billable, totals };` at its end");
  const [ctx, saved] = await Promise.all([helpers.context(db, jobId), helpers.loadSaved(db, jobId)]);
  const { labour, parts, quotes } = helpers.billable(saved, ctx);   // the same lines as the Customer Approval estimate (agreed scope; the parts / third-party items the customer brings are not charged)
  const pct = Number(ctx.markupPercent) || 0;
  const adjU = (u, own) => Math.round((Number(u) || 0) * (100 + (own ?? pct))) / 100;                           // repair + manual lines (own = the line's own %)
  const spct = Number(ctx.sparePercent ?? ctx.markupPercent) || 0;
  const adjS = (u, own) => Math.round((Number(u) || 0) * (100 + (own ?? spct))) / 100;                          // spare parts + quotations (own %)
  const out = [];
  const add = (kind, description, qty, amount, manual = false) => { if (amount > 0) out.push({ kind, description: String(description).slice(0, 300), qty: Number(qty) || 1, amount: r2(amount), manual: Boolean(manual) }); };
  if (saved.includeSpareParts) {
    for (const p of parts) add("PART", `${p.name}${p.brand ? ` (${p.brand})` : ""}`, p.qty, p.qty * adjS(p.unitPrice, p.markupPercent), p.manual);
    for (const q of quotes || ctx.quotes) add("QUOTE", `${q.description} (third party)`, 1, adjS(q.quotedPrice));
  }
  if (saved.includeLabour) for (const l of labour) add("LABOUR", l.description, l.qty || 1, (l.qty || 1) * adjU(l.unitPrice ?? l.amount, l.markupPercent), l.manual);
  // warranty claims are listed on the invoice but NOT charged (amount 0); the value they would have cost is written in the description
  const own = [...(Array.isArray(saved.clientParts) ? saved.clientParts : []), ...(Array.isArray(saved.unusedParts) ? saved.unusedParts : [])].map(Number);   // brought by the customer, or marked "Not used"
  const claim = (description, qty, value) => out.push({ kind: "WARRANTY", description: `${String(description).slice(0, 220)} - Warranty claim (not charged${value > 0 ? `, value LKR ${r2(value).toLocaleString("en-LK", { minimumFractionDigits: 2 })}` : ""})`, qty: Number(qty) || 1, amount: 0 });
  if (saved.includeSpareParts) for (const p of ctx.parts || []) if (p.warrantyClaim && !(saved.partsBy === "CLIENT" && own.includes(Number(p.id)))) claim(`${p.name}${p.brand ? ` (${p.brand})` : ""}`, p.qty, p.qty * adjS(p.unitPrice, p.markupPercent));
  if (saved.includeLabour) for (const l of ctx.labour || []) if (l.warrantyClaim) claim(l.description, l.qty || 1, (l.qty || 1) * adjU(l.unitPrice ?? l.amount, l.markupPercent));
  for (const m of saved.manualItems || []) add("OTHER", m.description || "Other", 1, adjU(Number(m.amount) || 0), true);
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
    const adj = (u, own) => Math.round((Number(u) || 0) * (100 + (own ?? pct))) / 100;            // repair lines (own = the line's individual %)
    const sparePct = d.sparePercent ?? (d.markupPercent != null ? d.markupPercent : jobSparePct);  // spare parts + quotations
    const adjS = (u, own) => Math.round((Number(u) || 0) * (100 + (own ?? sparePct))) / 100;
    const agreed = (x) => d.decision !== "PARTIAL" || (d.agreedScope || []).includes(x.id);
    for (const x of d.labour || []) if (agreed(x)) out.push({ kind: "LABOUR", description: `Extra: ${x.label || x.description || "Repair"}`.slice(0, 300), qty: x.qty || 1, amount: r2((x.qty || 1) * adj(x.amount, x.markupPercent)) });
    for (const x of d.parts || []) if (!(d.partsBy === "CLIENT" && ((d.clientParts || []).includes(x.id) || (d.unusedParts || []).includes(x.id)))) out.push({ kind: "PART", description: `Extra: ${x.name}${x.brand ? ` (${x.brand})` : ""}`.slice(0, 300), qty: x.qty || 1, amount: r2((x.qty || 1) * adjS(x.unitPrice, x.markupPercent)), manual: !x.partId });
    for (const x of d.quotes || []) if (!(d.partsBy === "CLIENT" && ((d.clientParts || []).includes(x.id) || (d.unusedParts || []).includes(x.id)))) out.push({ kind: "QUOTE", description: `Extra: ${x.description} (third party)`.slice(0, 300), qty: x.qty || 1, amount: r2((x.qty || 1) * adjS(x.price, x.markupPercent)) });
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
    await db.query("INSERT INTO invoice_line (invoice_id, source, kind, description, qty, unit_price, amount, sort_order, line_key, disc_mode, disc_value, is_manual) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [invoiceId, source, l.kind, l.description, l.qty, r2(l.amount / (l.qty || 1)), l.amount, n, key, d ? d.disc_mode : "AMOUNT", d ? d.v : 0, Boolean(l.manual)]);
  }
}
 
// creates the invoice of the job when the Customer Approval stage is completed (nothing happens if it exists, or for a transferred job)
// Departments with a Job Activation stage (Mechanical ...): the invoice is created when the job is ACTIVATED, not at Customer Approval
async function notActivatedYet(db, jobId) {
  const r = await db.query(
    `SELECT COALESCE(d.has_job_activation, false) AS en, ja.activated_at AS at
       FROM job j LEFT JOIN department d ON d.id = j.department_id LEFT JOIN job_activation ja ON ja.job_id = j.id WHERE j.id = $1`, [jobId]).catch(() => ({ rows: [] }));
  const x = r.rows[0];
  return Boolean(x && x.en && !x.at);
}
async function createInvoice(db, jobId, userId = null, isRoot = false, pre = null) {
  if (!isRoot) { const root = await rootJobId(db, jobId); if (!root || root !== jobId) return null; }
  const exists = await db.query("SELECT id FROM invoice WHERE job_id = $1", [jobId]);
  if (exists.rowCount) return exists.rows[0].id;
  if (await notActivatedYet(db, jobId)) return null;
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
            (j.status = 'COMPLETED' OR (COALESCE((to_jsonb(d)->>'has_job_end')::boolean, false) AND (to_jsonb(d)->>'job_end_stage_no') IS NOT NULL
              AND (j.current_stage_no > (to_jsonb(d)->>'job_end_stage_no')::int
                   OR EXISTS (SELECT 1 FROM job_stage js WHERE js.job_id = j.id AND js.stage_no = (to_jsonb(d)->>'job_end_stage_no')::int AND js.status = 'COMPLETED')))) AS "isCompleted",
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
 
// the invoice settings / company profile hardly ever change: read them once per 30 seconds, not on every open
const memo = {};
const cachedSettings = async (db) => { const m = memo.cfg; if (m && Date.now() - m.t < 30000) return m.v; const v = await invoiceSettings(db); memo.cfg = { t: Date.now(), v }; return v; };
const cachedCompany = async (db) => { const m = memo.co; if (m && Date.now() - m.t < 30000) return m.v; const v = await companyProfile(db); memo.co = { t: Date.now(), v }; return v; };
// the returns / exchanges of a counter-sale invoice (newest first), with their lines
async function returnsOf(db, invoiceId) {
  const r = await db.query(
    `SELECT r.id, r.return_no AS "returnNo", r.kind, r.reason, COALESCE(r.note, '') AS note, r.total_value::float AS "totalValue", r.refund_amount::float AS "refundAmount", r.refund_method AS "refundMethod",
            r.transfer_amount::float AS "transferAmount", r.late_override AS "lateOverride", r.created_at AS "createdAt", e.invoice_no AS "exchangeInvoiceNo", r.exchange_invoice_id AS "exchangeInvoiceId",
            trim(concat(u.first_name, ' ', u.last_name)) AS "byName",
            COALESCE((SELECT json_agg(json_build_object('description', l.description, 'qty', l.qty::float, 'amount', l.amount::float, 'restock', l.restock, 'isPart', l.part_id IS NOT NULL) ORDER BY l.id) FROM sales_return_line l WHERE l.return_id = r.id), '[]'::json) AS lines
       FROM sales_return r LEFT JOIN invoice e ON e.id = r.exchange_invoice_id LEFT JOIN admin_user u ON u.id = r.created_by
      WHERE r.invoice_id = $1 ORDER BY r.id DESC`, [invoiceId]);
  return r.rows;
}
async function view(db, rootId, saleId = null) {
  const inv = (await db.query(
    `SELECT id, invoice_no AS "invoiceNo", status, subtotal::float AS subtotal, discount_amount::float AS "discountAmount", tax_enabled AS "taxEnabled", tax_percent::float AS "taxPercent",
            tax_amount::float AS "taxAmount", total::float AS total, paid_amount::float AS "paidAmount", COALESCE(notes, '') AS notes, created_at AS "createdAt",
            disc_mode AS "discountMode", disc_value::float AS "discountValue", (job_id IS NULL) AS "isSale",
            CASE WHEN gross_total = 0 THEN total + returned_amount ELSE gross_total END::float AS "grossTotal", returned_amount::float AS "returnedAmount", refunded_amount::float AS "refundedAmount"
     FROM invoice WHERE ${saleId ? "id = $1 AND job_id IS NULL" : "job_id = $1"}`, [saleId || rootId])).rows[0];
  if (!inv) return null;
  const [lines, pays, cfg, company, returns] = await Promise.all([
    db.query(`SELECT id, source, kind, description, qty::float AS qty, unit_price::float AS "unitPrice", amount::float AS amount, part_id AS "partId", COALESCE(is_manual, false) AS "isManual",
                     disc_mode AS "discMode", disc_value::float AS "discValue", disc_amount::float AS "discAmount", (amount - disc_amount)::float AS net,
                     COALESCE((SELECT SUM(rl.qty) FROM sales_return_line rl WHERE rl.invoice_line_id = invoice_line.id), 0)::float AS "returnedQty" FROM invoice_line WHERE invoice_id = $1 ORDER BY sort_order, id`, [inv.id]),
    db.query(`SELECT p.id, p.amount::float AS amount, p.method, COALESCE(p.reference, '') AS reference, COALESCE(p.note, '') AS note, to_char(p.paid_at, 'YYYY-MM-DD') AS "paidAt", p.voided_at AS "voidedAt", p.tendered::float AS tendered, to_char(p.due_date, 'YYYY-MM-DD') AS "dueDate",
                     trim(concat(u.first_name, ' ', u.last_name)) AS "receivedByName"
              FROM invoice_payment p LEFT JOIN admin_user u ON u.id = p.received_by WHERE p.invoice_id = $1 ORDER BY p.paid_at, p.id`, [inv.id]),
    cachedSettings(db),
    cachedCompany(db),
    inv.isSale ? returnsOf(db, inv.id) : Promise.resolve([]),
  ]);
  const doc = {
    footerNote: cfg.footerNote || "", terms: cfg.terms || [],
    bank: cfg.showBank && (cfg.bankName || cfg.bankAccountNo) ? { name: cfg.bankName, accountName: cfg.bankAccountName, accountNo: cfg.bankAccountNo, branch: cfg.bankBranch } : null,
  };
  return { invoice: { ...inv, lineDiscount: r2(lines.rows.reduce((x, l) => x + l.discAmount, 0)), balance: r2(inv.total - inv.paidAmount), creditAmount: r2(pays.rows.filter((p) => !p.voidedAt && p.method === "CREDIT").reduce((x, p) => x + p.amount, 0)), vatRegNo: cfg.vatRegNo || null, company, doc }, lines: lines.rows, payments: pays.rows, returns, methods: cfg.methods, maxDiscountPercent: cfg.maxDiscountPercent };
}
 
// GET /jobs/:id  -> the invoice of the job (created / refreshed when needed). 404 + { exists: false } before the Customer Approval is completed
// GET /list?q=&status=&from=&to=&page=&pageSize=   -> every invoice (Finance > Sales Invoice)
router.get("/list", authenticateToken, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80) || null;
  const status = ["UNPAID", "PARTIAL", "PAID", "CANCELLED", "CREDIT"].includes(req.query.status) ? req.query.status : null;
  const dateOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const from = dateOk(req.query.from), to = dateOk(req.query.to);
  const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = `WHERE ($1::text IS NULL OR i.invoice_no ILIKE '%' || $1 || '%' OR COALESCE(j.job_no, cj.job_no) ILIKE '%' || $1 || '%' OR COALESCE(j.reg_no, i.sale_reg_no) ILIKE '%' || $1 || '%' OR COALESCE(c.customer_name, i.sale_customer_name) ILIKE '%' || $1 || '%')
                   AND ($2::text IS NULL OR (CASE WHEN $2 = 'CREDIT' THEN (i.status IN ('UNPAID','PARTIAL') AND EXISTS (SELECT 1 FROM invoice_payment cp WHERE cp.invoice_id = i.id AND cp.method = 'CREDIT' AND cp.voided_at IS NULL)) ELSE i.status = $2 END)) AND ($3::date IS NULL OR i.created_at::date >= $3::date) AND ($4::date IS NULL OR i.created_at::date <= $4::date)`;
  const from_ = `FROM invoice i LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id`;
  syncOpenInvoices().catch(() => {});   // runs in the background (never makes the list wait): brings open invoices up to date with the approved estimate + Extra Job Scopes
  try {
    const [rows, sum] = await Promise.all([
      pool.query(
        `SELECT i.id, i.invoice_no AS "invoiceNo", i.job_id AS "jobId", CASE WHEN i.job_id IS NULL THEN 's' || i.id ELSE i.job_id::text END AS ref, (i.job_id IS NULL AND i.cancelled_job_id IS NULL) AS "isSale", (i.cancelled_job_id IS NOT NULL) AS "isCancelFee",
                COALESCE(j.job_no, cj.job_no) AS "jobNo", j.status AS "jobStatus", (j.status = 'COMPLETED' OR (COALESCE((to_jsonb(d)->>'has_job_end')::boolean, false) AND (to_jsonb(d)->>'job_end_stage_no') IS NOT NULL               AND (j.current_stage_no > (to_jsonb(d)->>'job_end_stage_no')::int                    OR EXISTS (SELECT 1 FROM job_stage js WHERE js.job_id = j.id AND js.stage_no = (to_jsonb(d)->>'job_end_stage_no')::int AND js.status = 'COMPLETED')))) AS "jobDone", COALESCE(j.reg_no, i.sale_reg_no) AS "regNo", COALESCE(c.customer_name, i.sale_customer_name) AS "customerName",
                i.status, i.subtotal::float AS subtotal, i.discount_amount::float AS discount, i.tax_amount::float AS tax, i.total::float AS total, i.paid_amount::float AS paid,
                GREATEST(i.total - i.paid_amount, 0)::float AS balance, i.created_at AS "createdAt",
                (SELECT MAX(p.paid_at) FROM invoice_payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL AND p.method <> 'CREDIT') AS "lastPaidAt",
                (i.status IN ('UNPAID','PARTIAL') AND EXISTS (SELECT 1 FROM invoice_payment cp WHERE cp.invoice_id = i.id AND cp.method = 'CREDIT' AND cp.voided_at IS NULL)) AS "onCredit",
                (SELECT to_char(MIN(cp.due_date), 'YYYY-MM-DD') FROM invoice_payment cp WHERE cp.invoice_id = i.id AND cp.method = 'CREDIT' AND cp.voided_at IS NULL AND i.status IN ('UNPAID','PARTIAL')) AS "creditDue",
                (SELECT GREATEST(CURRENT_DATE - MIN(cp.due_date), 0) FROM invoice_payment cp WHERE cp.invoice_id = i.id AND cp.method = 'CREDIT' AND cp.voided_at IS NULL AND i.status IN ('UNPAID','PARTIAL'))::int AS "overdueDays"
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

// Re-reads the approved estimate and the approved Extra Job Scopes into every open invoice (UNPAID, no payment, job not cancelled),
// the same refresh that happens when an invoice is opened, so the list totals are never behind.
let syncRunning = false, syncLast = 0;
async function syncOpenInvoices() {
  if (syncRunning || Date.now() - syncLast < 30000) return;     // one run at a time, at most every 30 s
  syncRunning = true;
  try { await syncOpenInvoicesNow(); } finally { syncRunning = false; syncLast = Date.now(); }
}
// Re-reads the approved estimate + Extra Job Scopes into the lines of ONE open invoice (UNPAID, no payment). One at a time per job.
const refreshing = new Set();
async function refreshOne(root, sig) {
  if (refreshing.has(root)) return;
  refreshing.add(root);
  try {
    const [pre, extra] = await Promise.all([approvalLines(pool, root), extraLines(pool, root)]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inv = (await client.query("SELECT id FROM invoice WHERE job_id = $1 AND status = 'UNPAID' FOR UPDATE", [root])).rows[0];
      const paid = inv ? (await client.query("SELECT COUNT(*)::int AS n FROM invoice_payment WHERE invoice_id = $1 AND voided_at IS NULL", [inv.id])).rows[0].n : 1;
      if (inv && paid === 0) {
        if (pre?.completed) await replaceLines(client, inv.id, "APPROVAL", pre.lines);
        await replaceLines(client, inv.id, "EXTRA", extra);
        await recalc(client, inv.id);
      }
      await client.query("COMMIT");
      if (sig) refreshed.set(root, { sig, t: Date.now() });
    } catch (e) { try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ } console.error("refresh invoice", root, e.code, e.message); }
    finally { client.release(); }
  } catch (e) { console.error("refresh invoice (read)", root, e.code, e.message); }
  finally { refreshing.delete(root); }
}
async function syncOpenInvoicesNow() {
  let ids = [];
  try {
    ids = (await pool.query(
      `SELECT i.job_id AS id FROM invoice i
       WHERE i.job_id IS NOT NULL AND i.status = 'UNPAID'
         AND NOT EXISTS (SELECT 1 FROM invoice_payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM job_cancellation c WHERE c.job_id = i.job_id)
       ORDER BY i.id DESC LIMIT 60`)).rows.map((r) => r.id);
  } catch (e) { console.error("sync open invoices (list):", e.code, e.message); return; }
  for (const root of ids) {
    const sig = await jobSignature(root);
    const seen = refreshed.get(root);
    if (sig && seen && seen.sig === sig && Date.now() - seen.t < 600000) continue;   // nothing changed since the last refresh: no heavy reads
    await refreshOne(root, sig);
  }
}

// A cheap fingerprint of everything an invoice is built from (estimate, extra scopes, repair / spare lines). The heavy refresh
// of the invoice lines only runs when it changed (or after 90 s).
const refreshed = new Map();
async function jobSignature(root) {
  try {
    const r = await pool.query(
      `SELECT (SELECT updated_at::text FROM job_customer_approval WHERE job_id = $1) AS a,
              (SELECT md5(COALESCE(string_agg(x::text, ',' ORDER BY x.id), '')) FROM job_extra_scope x WHERE x.job_id = $1) AS b,
              (SELECT md5(COALESCE(string_agg(x::text, ',' ORDER BY x.id), '')) FROM job_spare_part x WHERE x.job_id = $1) AS c,
              (SELECT md5(COALESCE(string_agg(x::text, ',' ORDER BY x.id), '')) FROM job_repair_item x WHERE x.job_id = $1) AS d,
              (SELECT price_markup_percent::text || '/' || COALESCE(spare_markup_percent::text, '-') FROM job WHERE id = $1) AS e,
              (SELECT COUNT(*) FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id WHERE i.job_id = $1) AS f`, [root]);   // ONE round trip
    return JSON.stringify(r.rows[0]);
  } catch (_) { return null; }
}
router.get("/jobs/:id", authenticateToken, async (req, res) => {
  const ref = parseRef(req.params.id);
  if (ref && ref.sale) {                                    // counter sale: no job, no Customer Approval
    try {
      const [v, permissions] = await Promise.all([view(pool, null, ref.sale), permsOf(req)]);
      if (!v) return res.status(404).json({ message: "Invoice not found" });
      const x = (await pool.query("SELECT i.sale_customer_name AS n, i.sale_phone AS p, i.sale_reg_no AS r, cj.job_no AS \"cjNo\" FROM invoice i LEFT JOIN job cj ON cj.id = i.cancelled_job_id WHERE i.id = $1", [ref.sale])).rows[0] || {};
      const job = { id: req.params.id, jobNo: x.cjNo ? `${x.cjNo} (cancelled job)` : "Counter sale", cancelFeeOf: x.cjNo || null, regNo: x.r || "-", customerName: x.n || "Walk-in customer", contactNumber: x.p || null, departmentName: null, status: null };
      return res.json({ job, ...v, permissions, viewedJobId: req.params.id, rootJobId: req.params.id });
    } catch (e) { console.error("load sale invoice:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
  }
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const root = await rootJobId(pool, jobId).catch(() => null);   // outside the transaction (a failed query would abort it)
  if (!root) return res.status(404).json({ message: "Job not found" });
  // The invoice already exists: answer from the database straight away (every database round trip counts).
  //  - cancelled / has payments: its lines never change any more -> just read it
  //  - open: if the estimate / extra scopes / lines changed, the refresh runs in the background and the screen asks again ("refreshing")
  const T0 = Date.now();
  // everything is asked at the same time (one round trip instead of four in a row)
  const [cur0r, sigNow, jobNow, vNow, permissions] = await Promise.all([
    pool.query(`SELECT i.id, i.status, EXISTS (SELECT 1 FROM invoice_payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL) AS "hasPay" FROM invoice i WHERE i.job_id = $1`, [root]).catch(() => ({ rows: [] })),
    jobSignature(root),
    jobInfo(pool, root).catch(() => null),
    view(pool, root).catch(() => null),
    permsOf(req),
  ]);
  const cur0 = cur0r.rows[0];
  if (cur0 && vNow) {
    let stale = false;
    if (cur0.status !== "CANCELLED" && !cur0.hasPay) {
      const seen = refreshed.get(root);
      stale = !(sigNow && seen && seen.sig === sigNow && Date.now() - seen.t < 90000);
      if (stale) refreshOne(root, sigNow);   // background
    }
    if (Date.now() - T0 > 700) console.log(`[invoice open] job ${root} ${Date.now() - T0} ms${stale ? " (refresh in background)" : ""}`);
    return res.json({ job: jobNow, ...vNow, permissions, viewedJobId: jobId, rootJobId: root, refreshing: stale || refreshing.has(root) });
  }
  const T1 = T0;
  const sig = null;
  // everything that is only READ (the approved statement, the extra scope lines) is read before the transaction:
  // those reads tolerate a missing table, and a failed query inside a transaction would abort all the rest of it
  let pre = null, extra = [];
  try {
    // the estimate / extra scope lines are only used while the invoice is open (no payment, not cancelled) or when it must be created
    const cur = (await pool.query(`SELECT i.status, (SELECT COUNT(*)::int FROM invoice_payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL) AS paid FROM invoice i WHERE i.job_id = $1`, [root])).rows[0];
    if (!cur || (cur.status !== "CANCELLED" && cur.paid === 0)) [pre, extra] = await Promise.all([approvalLines(pool, root), extraLines(pool, root)]);
  } catch (e) { console.error("load invoice (read):", e.code, e.message, e.stack); return res.status(500).json({ message: "Server error" }); }
  const cancelledJob = (await pool.query("SELECT 1 FROM job_cancellation WHERE job_id = $1", [jobId]).catch(() => ({ rowCount: 0 }))).rowCount > 0
    || (await pool.query("SELECT 1 FROM job_cancellation WHERE job_id = $1", [root]).catch(() => ({ rowCount: 0 }))).rowCount > 0;
  if (cancelledJob && !(await pool.query("SELECT 1 FROM invoice WHERE job_id = $1", [root])).rowCount) return res.status(404).json({ exists: false, message: "This job was cancelled and has no invoice" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let id = await createInvoice(client, root, currentUserId(req), true, pre);
    if (!id) { await client.query("ROLLBACK"); return res.status(404).json({ exists: false, message: "The invoice is created when the job is activated" }); }
    // the approved Extra Job Scope lines are kept up to date until the invoice has payments
    const inv = (await client.query("SELECT status FROM invoice WHERE id = $1", [id])).rows[0];
    // the approved statement lines are refreshed from the Customer Approval while the invoice has no payment (so the invoice always matches the approved estimate)
    const paidRows = (await client.query("SELECT COUNT(*)::int AS n FROM invoice_payment WHERE invoice_id = $1 AND voided_at IS NULL", [id])).rows[0].n;
    if (!cancelledJob && inv.status !== "CANCELLED" && paidRows === 0 && pre?.completed) await replaceLines(client, id, "APPROVAL", pre.lines);
    if (!cancelledJob && inv.status !== "CANCELLED" && paidRows === 0) { await replaceLines(client, id, "EXTRA", extra); await recalc(client, id); }
    await client.query("COMMIT");
    const T3 = Date.now();
    const [job, v] = await Promise.all([jobInfo(pool, root), view(pool, root)]);
    if (Date.now() - T0 > 700) console.log(`[invoice open] job ${root} ${Date.now() - T0} ms: signature ${T1 - T0}, lines+refresh ${T3 - T1}, read ${Date.now() - T3}`);
    return res.json({ job, ...v, permissions: await permsOf(req), viewedJobId: jobId, rootJobId: root });
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
      ? (await client.query("SELECT id, status, invoice_no AS \"no\", true AS sale, total::float AS total, paid_amount::float AS paid, returned_amount::float AS returned, created_at AS \"createdAt\", sale_customer_id AS cid, sale_customer_name AS cname, sale_phone AS cphone, sale_reg_no AS creg FROM invoice WHERE id = $1 AND job_id IS NULL FOR UPDATE", [ref.sale])).rows[0]
      : root ? (await client.query("SELECT id, status, invoice_no AS \"no\", false AS sale, total::float AS total, paid_amount::float AS paid, returned_amount::float AS returned FROM invoice WHERE job_id = $1 FOR UPDATE", [root])).rows[0] : null;
    if (!row) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Invoice not found" }); }
    const out = await fn(client, row, root);
    if (out && out.error) { await client.query("ROLLBACK"); return res.status(out.status || 400).json({ message: out.error }); }
    await recalc(client, row.id);
    // a change (discount, tax, line edit) must never push the total below what the customer already paid
    const after = (await client.query("SELECT total::float AS total, paid_amount::float AS paid FROM invoice WHERE id = $1", [row.id])).rows[0];
    if (after && row.paid <= row.total + 0.001 && after.paid > after.total + 0.001) { await client.query("ROLLBACK"); return res.status(400).json({ message: `This change would make the invoice total (Rs. ${after.total.toFixed(2)}) less than the amount already paid (Rs. ${after.paid.toFixed(2)}). Void the payment first.` }); }
    await client.query("COMMIT");
    const [vw, permissions] = await Promise.all([view(pool, root, ref.sale || null), permsOf(req)]);
    return res.json({ ok: true, ...(out && out.extra ? out.extra : {}), ...vw, permissions });
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
  if (inv.status === "PAID") return { error: "The invoice is paid in full and locked. Void the payment first to change it." };
  if (inv.returned > 0) return { error: "This invoice has returned items and can no longer be edited" };
  const b = req.body || {};
  if (b.discountValue !== undefined || b.discountAmount !== undefined) { const d = await denied(req, "discount", "give or change a discount"); if (d) return d; }
  if (b.taxEnabled !== undefined || b.taxPercent !== undefined) { const d = await denied(req, "edit", "change the VAT of an invoice"); if (d) return d; }
  const before = (await db.query("SELECT disc_mode AS dm, disc_value::float AS dv, tax_enabled AS te, tax_percent::float AS tp, COALESCE(notes, '') AS notes FROM invoice WHERE id = $1", [inv.id])).rows[0];
  const sets = [], vals = [inv.id], log = [];
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
    const overLimit = Number.isFinite(maxPct) && maxPct < 100 && d > r2(t.n * maxPct / 100) + 0.001;
    if (overLimit && !(await permsOf(req)).discountOver) return { error: `The discount cannot be more than ${maxPct}% of the sub total. A manager can give a bigger discount.`, status: 403 };
    put("disc_mode", mode); put("disc_value", v); put("discount_amount", d);
    if (fmtDisc(before.dm, before.dv) !== fmtDisc(mode, v)) log.push(["DISCOUNT", `Invoice discount: ${fmtDisc(before.dm, before.dv)} -> ${fmtDisc(mode, v)}${overLimit ? ` (more than the ${maxPct}% limit, allowed by permission)` : ""}`, { from: { mode: before.dm, value: before.dv }, to: { mode, value: v } }]);
  }
  if (b.taxEnabled !== undefined) { put("tax_enabled", b.taxEnabled === true); if ((b.taxEnabled === true) !== before.te) log.push(["VAT", `VAT: ${before.te ? `on ${before.tp}%` : "off"} -> ${b.taxEnabled === true ? "on" : "off"}`, null]); }
  if (b.taxPercent !== undefined) { const p = money(b.taxPercent, 100); if (Number.isNaN(p)) return { error: "Invalid tax percentage" }; put("tax_percent", p); if (p !== before.tp) log.push(["VAT", `VAT percentage: ${before.tp}% -> ${p}%`, null]); }
  if (b.notes !== undefined) { const n = clean(b.notes)?.slice(0, 1000) || null; put("notes", n); if ((n || "") !== before.notes) log.push(["NOTE", "Note on the invoice changed", { from: before.notes, to: n || "" }]); }
  if (sets.length) await db.query(`UPDATE invoice SET ${sets.join(", ")} WHERE id = $1`, vals);
  for (const [a, t, d] of log) await audit(db, inv.id, req, a, t, d);
  return null;
}));
 
// POST /jobs/:id/lines  { description, qty, unitPrice }   (a manual line)
router.post("/jobs/:id/lines", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  if (inv.status === "PAID") return { error: "The invoice is paid in full and locked. Void the payment first to change it." };
  if (inv.returned > 0) return { error: "This invoice has returned items and can no longer be edited" };
  { const d = await denied(req, "edit", "add or remove invoice items"); if (d) return d; }
  const partId = inv.sale && req.body?.partId ? toInt(req.body.partId) : null;      // an inventory item (counter sales only): the stock goes down (an empty value is NOT item 0)
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
  await audit(db, inv.id, req, "ITEM_ADD", `Item added: ${description} x ${qty} @ Rs. ${fmtMoney(unit)}`, { description, qty, unit, partId: Number.isInteger(partId) ? partId : null });
  return null;
}));
 
// DELETE /jobs/:id/lines/:lid   (manual lines only; an inventory item of a counter sale goes back to the stock)
router.delete("/jobs/:id/lines/:lid", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  if (inv.status === "PAID") return { error: "The invoice is paid in full and locked. Void the payment first to change it." };
  if (inv.returned > 0) return { error: "This invoice has returned items and can no longer be edited" };
  { const d = await denied(req, "edit", "add or remove invoice items"); if (d) return d; }
  const lid = toInt(req.params.lid);
  if (!Number.isInteger(lid)) return { error: "Invalid line" };
  const r = await db.query("DELETE FROM invoice_line WHERE id = $1 AND invoice_id = $2 AND source = 'MANUAL' RETURNING part_id, qty::float AS qty, stock_loc, description, amount::float AS amount", [lid, inv.id]);
  if (!r.rowCount) return { error: "Only the lines added here can be removed" };
  const l = r.rows[0];
  await audit(db, inv.id, req, "ITEM_REMOVE", `Item removed: ${l.description} x ${l.qty} (Rs. ${fmtMoney(l.amount)})`, { description: l.description, qty: l.qty, amount: l.amount });
  if (inv.sale && l.part_id) await stockBack(db, { partId: l.part_id, qty: l.qty, locationId: l.stock_loc, invoiceNo: inv.no, userId: currentUserId(req) });
  return null;
}));
 
// GET /sale-parts?q=   -> inventory items for a counter sale (with the stock that can be sold)
router.get("/sale-parts", authenticateToken, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 60) || null;
  try {
    const r = await pool.query(
      `WITH m AS (
         SELECT p.id, p.name, p.part_no, p.brand, p.quality, p.unit, p.price, p.barcode, p.sku FROM spare_part p
          WHERE p.is_active AND ($1::text IS NULL OR p.name ILIKE '%' || $1 || '%' OR p.part_no ILIKE '%' || $1 || '%' OR p.brand ILIKE '%' || $1 || '%' OR p.sku ILIKE '%' || $1 || '%' OR p.barcode = $1)
          ORDER BY (p.barcode = $1 OR p.part_no = $1 OR p.sku = $1) DESC NULLS LAST, p.name LIMIT 30)
       SELECT m.id, m.name, m.part_no AS "partNo", m.brand, m.quality, m.unit, m.price::float AS price, m.barcode, m.sku,
              COALESCE((SELECT SUM(b.qty_on_hand - b.qty_reserved) FROM stock_balance b WHERE b.part_id = m.id), 0)::float AS available
         FROM m ORDER BY m.name`, [q]);
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
       ORDER BY d.name, p.sort_order, p.id, c.sort_order, c.id LIMIT 40`, [q]);
    return res.json(r.rows);
  } catch (e) { console.error("sale services:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// GET /sale-customers?q=   -> existing customers for a counter sale
router.get("/sale-customers", authenticateToken, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 60);
  if (q.length < 2) return res.json([]);
  const reg = q.toLowerCase().replace(/[\s-]/g, "");           // vehicle numbers are compared without spaces / dashes ("HDS 7732" = "hds-7732")
  try {
    const r = await pool.query(
      `WITH hit AS (
         SELECT c.id FROM customer c
          WHERE c.customer_name ILIKE '%' || $1 || '%' OR c.contact_number ILIKE '%' || $1 || '%' OR c.alt_contact_number ILIKE '%' || $1 || '%'
         UNION
         SELECT v.customer_id FROM customer_vehicle v WHERE length($2) >= 2 AND regexp_replace(lower(v.reg_no), '[\\s-]', '', 'g') LIKE '%' || $2 || '%'
         LIMIT 12)
       SELECT c.id, c.customer_name AS name, COALESCE(NULLIF(c.contact_number, ''), c.alt_contact_number) AS phone,
              (SELECT v.reg_no FROM customer_vehicle v WHERE v.customer_id = c.id AND length($2) >= 2 AND regexp_replace(lower(v.reg_no), '[\\s-]', '', 'g') LIKE '%' || $2 || '%' ORDER BY v.id LIMIT 1) AS "matchedReg",
              COALESCE((SELECT json_agg(x.reg_no) FROM (SELECT v.reg_no FROM customer_vehicle v WHERE v.customer_id = c.id ORDER BY v.id LIMIT 5) x), '[]'::json) AS vehicles
         FROM customer c WHERE c.id IN (SELECT id FROM hit) ORDER BY c.customer_name LIMIT 10`, [q, reg]);
    return res.json(r.rows);
  } catch (e) { console.error("sale customers:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// creates a counter-sale invoice inside the given transaction: customer + lines (inventory items leave the stock). Used by the sale and by an exchange.
async function createSaleInvoice(client, req, b, input) {
  let name = clean(b.customerName)?.slice(0, 150), phone = clean(b.phone)?.slice(0, 30), cid = b.customerId ? toInt(b.customerId) : NaN;   // no customer picked (walk-in): an empty value must not become id 0
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
    const partId = l.partId ? toInt(l.partId) : NaN;   // repair / custom lines have no part (an empty value must not become 0)
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
  await audit(client, id, req, "CREATE", `Counter sale created (${input.length} item${input.length > 1 ? "s" : ""})${b.notes && String(b.notes).startsWith("Exchange for") ? `: ${clean(b.notes)}` : ""}`, null);
  return { id, no };
}

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
    const { id, no } = await createSaleInvoice(client, req, b, input);
    await client.query("COMMIT");
    return res.status(201).json({ id, ref: `s${id}`, invoiceNo: no });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    if (e.expose) return res.status(e.status || 400).json({ message: e.message });
    console.error("create sale invoice:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

// ---------- Sales return / exchange (counter sales) ----------
const RETURN_REASONS = ["Wrong part", "Defective", "Customer changed mind", "Other"];
const RETURN_DAYS = Number(process.env.RETURN_DAYS ?? 14);          // 0 = no limit
async function stockReturned(db, { partId, qty, locationId, refNo, userId }) {
  const inv = loadSibling(["inventory.routes", "inventory"]);
  const loc = locationId || (await db.query("SELECT id FROM stock_location WHERE is_active ORDER BY id LIMIT 1")).rows[0]?.id;
  if (loc) await inv.postMovement(db, { partId, locationId: loc, type: "RETURN", qty, refNo, note: "Sales return", userId });
}

// POST /jobs/:id/returns  { kind: "RETURN" | "EXCHANGE", reason, note?, override?, lines: [{ lineId, qty, restock? }], refundMethod?, newLines?: [{ partId?, description?, qty, unitPrice? }] }
//   The invoice itself is not edited: a return document (RET-00001) is saved, the invoice total goes down by the value of the returned items
//   (item discount, invoice discount and VAT are returned in proportion), the stock comes back (or is written off as damaged), and the money
//   that was already paid for them is refunded - or, for an exchange, moved to a new invoice that holds the new items.
router.post("/jobs/:id/returns", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  { const d = await denied(req, "return", "accept returns or exchanges"); if (d) return d; }
  if (!inv.sale) return { error: "Returns are only for counter sales" };
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  if (!(inv.paid > 0)) return { error: "Nothing has been paid on this invoice. Remove the item from the invoice instead" };   // a return is for items the customer has paid for
  const b = req.body || {};
  const kind = b.kind === "EXCHANGE" ? "EXCHANGE" : "RETURN";
  const reason = RETURN_REASONS.includes(b.reason) ? b.reason : null;
  if (!reason) return { error: "Select the reason for the return" };
  const want = Array.isArray(b.lines) ? b.lines.filter((l) => Number(l?.qty) > 0) : [];
  if (!want.length) return { error: "Select the items that are returned" };
  // the return window
  const ageDays = (Date.now() - new Date(inv.createdAt).getTime()) / 86400000;
  const late = RETURN_DAYS > 0 && ageDays > RETURN_DAYS;
  if (late && b.override !== true) return { error: `The return period (${RETURN_DAYS} days) has passed for this invoice`, status: 409 };
  await recalc(db, inv.id);                                      // makes sure gross_total is filled (invoices made before returns existed)
  const head = (await db.query("SELECT gross_total::float AS gross, returned_amount::float AS returned FROM invoice WHERE id = $1", [inv.id])).rows[0];
  const rows = (await db.query(
    `SELECT l.id, l.kind, l.part_id AS "partId", l.description, l.qty::float AS qty, l.amount::float AS amount, l.disc_amount::float AS disc, l.stock_loc AS loc,
            COALESCE((SELECT SUM(rl.qty) FROM sales_return_line rl WHERE rl.invoice_line_id = l.id), 0)::float AS ret
       FROM invoice_line l WHERE l.invoice_id = $1 ORDER BY l.id`, [inv.id])).rows;
  const netAll = r2(rows.reduce((x, l) => x + (l.amount - l.disc), 0));
  const factor = netAll > 0 ? head.gross / netAll : 0;           // item amount (after its discount) -> what the customer really paid for it (invoice discount + VAT)
  const byId = new Map(rows.map((l) => [l.id, l]));
  const take = new Map();
  const plan = [];
  let value = 0;
  for (const w of want) {
    const l = byId.get(toInt(w.lineId));
    if (!l) return { error: "Item not found on this invoice" };
    if (take.has(l.id)) return { error: "An item is listed twice" };
    if (!(l.amount > 0) || l.kind === "WARRANTY") return { error: `${l.description}: this item has no price and cannot be returned` };
    const q = r2(Number(w.qty));
    if (!(q > 0) || q > r2(l.qty - l.ret) + 0.001) return { error: `${l.description}: only ${r2(l.qty - l.ret)} can still be returned` };
    take.set(l.id, q);
    const amount = r2((l.amount - l.disc) * (q / l.qty) * factor);
    value = r2(value + amount);
    plan.push({ l, q, amount, restock: Boolean(l.partId) && w.restock !== false });
  }
  // every priced item is back: the invoice goes to exactly 0 (no cents left over from the rounding)
  if (rows.filter((l) => l.amount > 0 && l.kind !== "WARRANTY").every((l) => r2(l.ret + (take.get(l.id) || 0)) >= r2(l.qty) - 0.001)) value = r2(head.gross - head.returned);
  if (!(value > 0)) return { error: "Nothing to return" };
  const newTotal = r2(Math.max(0, head.gross - head.returned - value));
  const overpaid = r2(Math.max(0, inv.paid - newTotal));         // the money already paid that now belongs to the customer
  const cfg = await invoiceSettings(db);
  const returnNo = (await db.query("SELECT 'RET-' || lpad(nextval('sales_return_no_seq')::text, 5, '0') AS n")).rows[0].n;
  let transfer = 0, refund = overpaid, exchange = null;
  if (kind === "EXCHANGE") {
    const input = Array.isArray(b.newLines) ? b.newLines : [];
    if (!input.length) return { error: "Add the new items for the exchange" };
    if (input.length > 100) return { error: "Too many items" };
    exchange = await createSaleInvoice(db, req, { customerId: inv.cid, customerName: inv.cname, phone: inv.cphone, regNo: inv.creg, notes: `Exchange for ${inv.no} (${returnNo})` }, input);
    const nt = (await db.query("SELECT total::float AS t FROM invoice WHERE id = $1", [exchange.id])).rows[0].t;
    transfer = r2(Math.min(overpaid, nt));
    refund = r2(overpaid - transfer);
  }
  let method = null;
  if (refund > 0) {
    method = cfg.methods.find((m) => m === b.refundMethod && m !== "CREDIT") || null;
    if (!method) return { error: "Select how the money is given back" };
  }
  const ins = await db.query(
    `INSERT INTO sales_return (return_no, invoice_id, kind, reason, note, total_value, refund_amount, refund_method, transfer_amount, exchange_invoice_id, late_override, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [returnNo, inv.id, kind, reason, clean(b.note)?.slice(0, 500) || null, value, refund, method, transfer, exchange ? exchange.id : null, late, currentUserId(req)]);
  for (const x of plan) {
    await db.query("INSERT INTO sales_return_line (return_id, invoice_line_id, part_id, description, qty, amount, restock) VALUES ($1, $2, $3, $4, $5, $6, $7)", [ins.rows[0].id, x.l.id, x.l.partId, x.l.description, x.q, x.amount, x.restock]);
    if (x.restock) await stockReturned(db, { partId: x.l.partId, qty: x.q, locationId: x.l.loc, refNo: returnNo, userId: currentUserId(req) });
  }
  // the money that was paid for the exchange items is moved to the new invoice (not cash: it never leaves the drawer)
  if (exchange && transfer > 0) {
    await db.query("INSERT INTO invoice_payment (invoice_id, amount, method, reference, note, paid_at, received_by) VALUES ($1, $2, 'EXCHANGE', $3, $4, CURRENT_DATE, $5)", [exchange.id, transfer, returnNo, `Paid for ${inv.no}`, currentUserId(req)]);
    await recalc(db, exchange.id);
  }
  await audit(db, inv.id, req, kind, `${returnNo} ${kind === "EXCHANGE" ? "exchange" : "return"}: items worth Rs. ${fmtMoney(value)} (${reason})${refund > 0 ? `, Rs. ${fmtMoney(refund)} given back (${method})` : ""}${exchange ? `, new invoice ${exchange.no}` : ""}`, { returnNo, value, refund, transfer, reason, late });
  // withInvoice() runs the recalculation of this invoice after the new numbers are saved
  await db.query("UPDATE invoice SET returned_amount = returned_amount + $2, refunded_amount = refunded_amount + $3 WHERE id = $1", [inv.id, value, r2(refund + transfer)]);
  const ctx = { origin: req.headers.origin, proto: req.headers["x-forwarded-proto"] || req.protocol, host: req.get("host"), baseUrl: req.baseUrl };
  if (!b.noSms) res.once("finish", () => { if (res.statusCode === 200) sendReturnSms(inv.id, { returnNo, value, refund, exchangeInvoiceId: exchange?.id, exchangeInvoiceNo: exchange?.no }, ctx); });
  return { extra: { returnNo, exchangeInvoice: exchange ? { id: exchange.id, ref: `s${exchange.id}`, invoiceNo: exchange.no } : null, refund, transfer } };
}));

// POST /jobs/:id/payments  { amount, method, reference?, note?, paidAt?, tendered? }   (tendered = the cash the customer gave, CASH only)
router.post("/jobs/:id/payments", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv, root) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  if (root) {                                               // a job invoice takes money only after the job is completed (counter sales have no job)
    const j = (await db.query(`SELECT j.status, (j.status = 'COMPLETED' OR (COALESCE((to_jsonb(d)->>'has_job_end')::boolean, false) AND (to_jsonb(d)->>'job_end_stage_no') IS NOT NULL
              AND (j.current_stage_no > (to_jsonb(d)->>'job_end_stage_no')::int
                   OR EXISTS (SELECT 1 FROM job_stage js WHERE js.job_id = j.id AND js.stage_no = (to_jsonb(d)->>'job_end_stage_no')::int AND js.status = 'COMPLETED')))) AS done
         FROM job j LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [root])).rows[0];
    if (j && !j.done && j.status !== "CANCELLED") return { error: "Payments can be recorded after the job is completed" };
  }
  const b = req.body || {};
  const amount = money(b.amount);
  if (Number.isNaN(amount) || !(amount > 0)) return { error: "Enter the payment amount" };
  if (!(await invoiceSettings(db)).methods.includes(b.method)) return { error: "Select the payment method" };
  if (amount > r2(inv.total - inv.paid) + 0.001) return { error: "The payment is more than the balance" };
  if (b.method === "CREDIT") {   // on account: only for a job / customer, never more than what is still unpaid and not yet on credit
    if (!root) return { error: "Credit is only for a job invoice" };
    const onCredit = r2((await db.query("SELECT COALESCE(SUM(amount), 0)::float AS s FROM invoice_payment WHERE invoice_id = $1 AND voided_at IS NULL AND method = 'CREDIT'", [inv.id])).rows[0].s);
    if (amount > r2(inv.total - inv.paid - onCredit) + 0.001) return { error: "That is more than the amount that is not on credit yet" };
  }
  const paidAt = clean(b.paidAt);
  if (paidAt && !/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) return { error: "Invalid payment date" };
  // cash: the money the customer handed over (the change to give back = tendered - amount)
  let tendered = null;
  if (b.method === "CASH" && b.tendered !== undefined && b.tendered !== null && String(b.tendered).trim() !== "") {
    tendered = money(b.tendered);
    if (Number.isNaN(tendered)) return { error: "Enter the cash received from the customer" };
    if (tendered + 0.001 < amount) return { error: "The cash received is less than the payment amount" };
  }
  let dueDate = null;
  if (b.method === "CREDIT") {   // credit needs the date the customer promises to pay by
    dueDate = clean(b.dueDate);
    if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { error: "Select the date the customer will pay by" };
    if (dueDate < (paidAt || new Date().toISOString().slice(0, 10))) return { error: "The due date cannot be before the credit date" };
  }
  await db.query("INSERT INTO invoice_payment (invoice_id, amount, method, reference, note, paid_at, received_by, tendered, due_date) VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8, $9::date)",
    [inv.id, amount, b.method, clean(b.reference)?.slice(0, 120) || null, clean(b.note)?.slice(0, 500) || null, paidAt, currentUserId(req), tendered, dueDate]);
  await audit(db, inv.id, req, b.method === "CREDIT" ? "CREDIT" : "PAYMENT", b.method === "CREDIT" ? `On credit: Rs. ${fmtMoney(amount)}, due ${dueDate}` : `Payment: Rs. ${fmtMoney(amount)} by ${b.method}${b.reference ? ` (${clean(b.reference)})` : ""}`, { amount, method: b.method, reference: clean(b.reference) || null, dueDate });
  // the payment is saved: once the request has been answered successfully, the customer gets the SMS with the invoice link
  const ctx = { origin: req.headers.origin, proto: req.headers["x-forwarded-proto"] || req.protocol, host: req.get("host"), baseUrl: req.baseUrl };
  if (!b.noSms && b.method !== "CREDIT") res.once("finish", () => { if (res.statusCode === 200) sendInvoiceSms(inv.id, amount, ctx); });
  return null;
}));
 
// PUT /jobs/:id/lines/:lid/discount  { mode: "PERCENT" | "AMOUNT", value }   -> the discount of one item (value 0 removes it)
router.put("/jobs/:id/lines/:lid/discount", authenticateToken, (req, res) => withInvoice(req, res, async (db, inv) => {
  if (inv.status === "CANCELLED") return { error: "The invoice is cancelled" };
  if (inv.status === "PAID") return { error: "The invoice is paid in full and locked. Void the payment first to change it." };
  if (inv.returned > 0) return { error: "This invoice has returned items and can no longer be edited" };
  const lid = toInt(req.params.lid);
  if (!Number.isInteger(lid)) return { error: "Invalid item" };
  const mode = req.body?.mode === "PERCENT" ? "PERCENT" : "AMOUNT";
  const v = money(req.body?.value ?? 0, mode === "PERCENT" ? 100 : 999999999);
  if (Number.isNaN(v)) return { error: mode === "PERCENT" ? "Enter a discount between 0 and 100 %" : "Invalid discount" };
  { const d = await denied(req, "discount", "give or change a discount"); if (d) return d; }
  const line = (await db.query("SELECT amount::float AS a, description, disc_mode AS dm, disc_value::float AS dv FROM invoice_line WHERE id = $1 AND invoice_id = $2", [lid, inv.id])).rows[0];
  if (!line) return { error: "Item not found", status: 404 };
  const d = mode === "PERCENT" ? r2(line.a * v / 100) : v;
  if (d > line.a + 0.001) return { error: "The discount is more than the item amount" };
  const maxPct = Number((await invoiceSettings(db)).maxDiscountPercent);
  const overLine = Number.isFinite(maxPct) && maxPct < 100 && d > r2(line.a * maxPct / 100) + 0.001;
  if (overLine && !(await permsOf(req)).discountOver) return { error: `The discount cannot be more than ${maxPct}% of the item amount. A manager can give a bigger discount.`, status: 403 };
  await db.query("UPDATE invoice_line SET disc_mode = $3, disc_value = $4 WHERE id = $1 AND invoice_id = $2", [lid, inv.id, mode, v]);
  if (fmtDisc(line.dm, line.dv) !== fmtDisc(mode, v)) await audit(db, inv.id, req, "ITEM_DISCOUNT", `Item discount (${line.description}): ${fmtDisc(line.dm, line.dv)} -> ${fmtDisc(mode, v)}${overLine ? ` (more than the ${maxPct}% limit, allowed by permission)` : ""}`, { from: { mode: line.dm, value: line.dv }, to: { mode, value: v } });
  return null;
}));
 

let sendPushToUser = null;
{
  const fsx = require("node:fs"), pathx = require("node:path");
  let found = ["push.routes", "push", "pushRoutes", "push.route", "push_routes", "notification.routes", "notifications"].map((n) => `./${n}`);
  try { found = found.concat(fsx.readdirSync(__dirname).filter((x) => /^push.*\.js$/i.test(x) && x !== pathx.basename(__filename)).map((x) => `./${x}`)); } catch (_) { /* ignore */ }
  for (const pth of found) {
    try { const m = require(pth); if (typeof m?.sendPushToUser === "function") { sendPushToUser = m.sendPushToUser; break; } }
    catch (e) { if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes(pth.replace("./", ""))) console.error(`push file ${pth}:`, e.message); }
  }
}


// ---------- the invoice the customer gets by SMS when a payment is recorded (a page of the website, like the evidence report) ----------
const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lkr = (n) => `Rs. ${Number(n || 0).toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// the invoice as one phone-friendly HTML document (built from the database, no script)
async function invoiceDocHtml(db, invoiceId) {
  const row = (await db.query(
    `SELECT i.job_id AS "jobId", COALESCE(c.customer_name, i.sale_customer_name) AS customer, COALESCE(j.reg_no, i.sale_reg_no) AS reg, j.job_no AS "jobNo" FROM invoice i
       LEFT JOIN job j ON j.id = i.job_id LEFT JOIN customer c ON c.id = j.customer_id WHERE i.id = $1`, [invoiceId])).rows[0];
  if (!row) return null;
  const v = await view(db, row.jobId, row.jobId ? null : invoiceId);
  if (!v) return null;
  const I = v.invoice, co = I.company || {}, doc = I.doc || {};
  const pays = v.payments.filter((p) => !p.voidedAt);
  const lines = v.lines.map((l, n) => `<tr><td class="n">${n + 1}</td><td>${esc(l.description)}${l.returnedQty > 0 ? `<div class="small">Returned ${l.returnedQty} of ${l.qty}</div>` : ""}</td><td class="r">${l.qty}</td><td class="r">${lkr(l.unitPrice)}</td><td class="r">${l.discAmount > 0 ? `- ${lkr(l.discAmount)}` : ""}</td><td class="r b">${lkr(l.net)}</td></tr>`).join("");
  const sums = [["Subtotal", lkr(I.subtotal)], I.lineDiscount > 0 ? ["Item discounts", `- ${lkr(I.lineDiscount)}`] : null, I.discountAmount > 0 ? ["Discount", `- ${lkr(I.discountAmount)}`] : null, I.taxEnabled ? [`VAT ${I.taxPercent}%`, lkr(I.taxAmount)] : null, I.returnedAmount > 0 ? ["Returned items", `- ${lkr(I.returnedAmount)}`] : null]
    .filter(Boolean).map(([a, b]) => `<div class="s"><span>${a}</span><span>${b}</span></div>`).join("");
  const stamp = I.returnedAmount > 0 && I.total <= 0.005 ? "RETURNED" : I.status === "PAID" ? "PAID" : I.status === "PARTIAL" ? "PARTLY PAID" : I.status === "CANCELLED" ? "CANCELLED" : "UNPAID";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(I.invoiceNo)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font:14px/1.45 system-ui,'Segoe UI',sans-serif}.wrap{max-width:820px;margin:0 auto;padding:22px 18px}
.top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;border-bottom:3px solid #8f0b0b;padding-bottom:12px}.co b{font-size:18px;color:#8f0b0b;letter-spacing:.03em}.co div{color:#555;font-size:12.5px}
.doc{text-align:right}.doc h1{margin:0;font-size:22px;letter-spacing:.06em}.stamp{display:inline-block;margin-top:4px;padding:2px 12px;border:2px solid #15803d;color:#15803d;font-weight:800;border-radius:6px;letter-spacing:.08em}.stamp.RETURNED{border-color:#6b7280;color:#6b7280}.stamp.UNPAID,.stamp.CANCELLED{border-color:#b91c1c;color:#b91c1c}.stamp.PARTLY{border-color:#d97706;color:#b45309}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}.meta span{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#777}
table{width:100%;border-collapse:collapse;margin-top:6px}th{background:#111;color:#fff;text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;padding:7px 8px}td{padding:7px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top}.r{text-align:right;white-space:nowrap}.b{font-weight:700}.n{color:#888;width:28px}
.tot{margin:14px 0 0 auto;max-width:330px}.s{display:flex;justify-content:space-between;padding:3px 0}.grand{display:flex;justify-content:space-between;border-top:2px solid #111;margin-top:6px;padding-top:6px;font-size:17px;font-weight:800}.due{color:#b91c1c}
h3{margin:20px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8f0b0b}.small{font-size:12px;color:#555}.note{margin-top:16px;border-top:1px solid #ddd;padding-top:10px}
@media(max-width:560px){.doc{text-align:left}th:nth-child(4),td:nth-child(4){display:none}}
</style></head><body><div class="wrap">
<div class="top"><div class="co"><b>${esc(co.name || "")}</b><div>${esc(co.address || "")}</div><div>${esc([co.phone, co.email].filter(Boolean).join(" · "))}</div>${I.vatRegNo ? `<div>VAT Reg. No: ${esc(I.vatRegNo)}</div>` : ""}</div>
<div class="doc"><h1>INVOICE</h1><div><b>${esc(I.invoiceNo)}</b></div><div class="stamp ${stamp.split(" ")[0]}">${stamp}</div></div></div>
<div class="meta"><div><span>Bill to</span><b>${esc(row.customer || "")}</b></div><div><span>Vehicle</span><b>${esc(row.reg || "-")}</b></div><div><span>Date</span><b>${esc(String(I.createdAt instanceof Date ? I.createdAt.toISOString() : I.createdAt).slice(0, 10))}</b></div>${row.jobNo ? `<div><span>Job</span><b>${esc(row.jobNo)}</b></div>` : ""}</div>
<table><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Discount</th><th class="r">Amount</th></tr></thead><tbody>${lines}</tbody></table>
<div class="tot">${sums}<div class="grand"><span>Total</span><span>${lkr(I.total)}</span></div><div class="s"><span>Paid</span><span>${lkr(I.paidAmount)}</span></div><div class="s b ${I.balance > 0 ? "due" : ""}"><span>Balance</span><span>${lkr(I.balance)}</span></div></div>
${pays.length ? `<h3>Payments</h3>${pays.map((p) => `<div class="s"><span>${esc(p.paidAt)} · ${p.method === "EXCHANGE" ? "Exchange credit" : esc(String(p.method).charAt(0) + String(p.method).slice(1).toLowerCase())}${p.reference ? ` · ${esc(p.reference)}` : ""}</span><b>${lkr(p.amount)}</b></div>`).join("")}` : ""}
${(v.returns || []).length ? `<h3>Returns</h3>${v.returns.map((r) => `<div class="s"><span>${esc(r.returnNo)} · ${esc(String(r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt).slice(0, 10))} · ${r.kind === "EXCHANGE" ? "Exchange" : "Return"}${r.exchangeInvoiceNo ? ` (new invoice ${esc(r.exchangeInvoiceNo)})` : ""}</span><b>- ${lkr(r.totalValue)}</b></div>${r.lines.map((x) => `<div class="small">${x.qty} x ${esc(x.description)}</div>`).join("")}${r.refundAmount > 0 ? `<div class="small">Money given back: ${lkr(r.refundAmount)}</div>` : ""}`).join("")}` : ""}
${I.notes ? `<div class="note small">${esc(I.notes)}</div>` : ""}
${doc.bank && I.balance > 0 ? `<h3>Bank details</h3><div class="small">${esc(doc.bank.name || "")} · ${esc(doc.bank.accountName || "")} · ${esc(doc.bank.accountNo || "")}${doc.bank.branch ? ` · ${esc(doc.bank.branch)}` : ""}</div>` : ""}
${doc.footerNote ? `<div class="note small">${esc(doc.footerNote)}</div>` : ""}
</div></body></html>`;
}

async function ensureInvoiceToken(db, invoiceId) {
  const cur = (await db.query("SELECT public_token FROM invoice WHERE id = $1", [invoiceId])).rows[0];
  if (cur?.public_token) return cur.public_token;
  const token = require("crypto").randomBytes(24).toString("hex");
  const r = await db.query("UPDATE invoice SET public_token = $2 WHERE id = $1 AND public_token IS NULL RETURNING public_token", [invoiceId, token]);
  return r.rows[0]?.public_token || (await db.query("SELECT public_token FROM invoice WHERE id = $1", [invoiceId])).rows[0]?.public_token;
}

// SMS to the customer after a payment: the amount received + the link of the invoice (a problem here never affects the payment itself)
async function sendInvoiceSms(invoiceId, amount, ctx) {
  try {
    const { sendSms } = require("../services/sms.service");
    const i = (await pool.query(
      `SELECT i.invoice_no AS no, i.total::float AS total, i.paid_amount::float AS paid, COALESCE(j.reg_no, i.sale_reg_no) AS reg,
              COALESCE(NULLIF(c.alt_contact_number, ''), c.contact_number, i.sale_phone) AS phone, COALESCE(c.contact_number, i.sale_phone) AS "mainPhone"
         FROM invoice i LEFT JOIN job j ON j.id = i.job_id LEFT JOIN customer c ON c.id = j.customer_id WHERE i.id = $1`, [invoiceId])).rows[0];
    if (!i) return;
    const token = await ensureInvoiceToken(pool, invoiceId);
    const app = String(process.env.PUBLIC_APP_URL || ctx.origin || "").replace(/\/+$/, "");
    const api = String(process.env.PUBLIC_API_URL || `${ctx.proto}://${ctx.host}`).replace(/\/+$/, "");
    const mount = ctx.baseUrl || "/invoice";
    const link = app ? `${app}/invoice/${token}?p=${encodeURIComponent(mount)}` : `${api}${mount}/public/invoice/${token}`;
    const balance = r2(i.total - i.paid);
    const text = `Thank you! We received ${lkr(amount)}${i.reg ? ` for ${i.reg}` : ""} (${i.no}).${balance > 0 ? ` Balance ${lkr(balance)}.` : " Paid in full."} View your invoice: ${link}`;
    let sms = await sendSms(i.phone, text, { kind: "invoice" });
    if (!sms?.sent && i.mainPhone && i.mainPhone !== i.phone) sms = await sendSms(i.mainPhone, text, { kind: "invoice" });
    if (!sms?.sent) console.error("invoice sms:", sms?.error);
  } catch (e) { console.error("invoice sms:", e.message); }
}

// SMS to the customer after a return / exchange (a problem here never affects the return itself)
async function sendReturnSms(invoiceId, info, ctx) {
  try {
    const { sendSms } = require("../services/sms.service");
    const i = (await pool.query(
      `SELECT i.invoice_no AS no, i.total::float AS total, i.paid_amount::float AS paid, COALESCE(j.reg_no, i.sale_reg_no) AS reg,
              COALESCE(NULLIF(c.alt_contact_number, ''), c.contact_number, i.sale_phone) AS phone, COALESCE(c.contact_number, i.sale_phone) AS "mainPhone"
         FROM invoice i LEFT JOIN job j ON j.id = i.job_id LEFT JOIN customer c ON c.id = j.customer_id WHERE i.id = $1`, [invoiceId])).rows[0];
    if (!i || !(i.phone || i.mainPhone)) return;
    const linkId = info.exchangeInvoiceId || invoiceId;             // an exchange: the link opens the new invoice
    const token = await ensureInvoiceToken(pool, linkId);
    const app = String(process.env.PUBLIC_APP_URL || ctx.origin || "").replace(/\/+$/, "");
    const api = String(process.env.PUBLIC_API_URL || `${ctx.proto}://${ctx.host}`).replace(/\/+$/, "");
    const mount = ctx.baseUrl || "/invoice";
    const link = app ? `${app}/invoice/${token}?p=${encodeURIComponent(mount)}` : `${api}${mount}/public/invoice/${token}`;
    const text = info.exchangeInvoiceNo
      ? `${info.returnNo}: exchange done for ${i.no}${i.reg ? ` (${i.reg})` : ""}. New invoice ${info.exchangeInvoiceNo}.${info.refund > 0 ? ` Refunded ${lkr(info.refund)}.` : ""} View: ${link}`
      : `${info.returnNo}: return recorded for ${i.no}${i.reg ? ` (${i.reg})` : ""}, items worth ${lkr(info.value)}.${info.refund > 0 ? ` Refunded ${lkr(info.refund)}.` : ""}${r2(i.total - i.paid) > 0 ? ` Balance ${lkr(r2(i.total - i.paid))}.` : ""} View: ${link}`;
    let sms = await sendSms(i.phone || i.mainPhone, text, { kind: "invoice" });
    if (!sms?.sent && i.mainPhone && i.mainPhone !== i.phone) sms = await sendSms(i.mainPhone, text, { kind: "invoice" });
    if (!sms?.sent) console.error("return sms:", sms?.error);
  } catch (e) { console.error("return sms:", e.message); }
}

// GET /public/invoice/:token   (NO login - the long random token is the key)
router.get("/public/invoice/:token", async (req, res) => {
  const token = clean(req.params.token);
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return res.status(404).send("Invoice not found");
  try {
    const r = await pool.query("SELECT id FROM invoice WHERE public_token = $1", [token]);
    const html = r.rows[0] ? await invoiceDocHtml(pool, r.rows[0].id) : null;
    if (!html) return res.status(404).send("Invoice not found");
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("X-Robots-Tag", "noindex");
    res.set("Content-Security-Policy", "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:");
    return res.send(html);
  } catch (e) { console.error("public invoice:", e.code, e.message); return res.status(500).send("Server error"); }
});

// GET /public/invoice-data/:token   (NO login): the invoice document for the website page /invoice/<token>
router.get("/public/invoice-data/:token", async (req, res) => {
  const token = clean(req.params.token);
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return res.status(404).json({ message: "Invoice not found" });
  try {
    const r = await pool.query("SELECT id, invoice_no AS no FROM invoice WHERE public_token = $1", [token]);
    const html = r.rows[0] ? await invoiceDocHtml(pool, r.rows[0].id) : null;
    if (!html) return res.status(404).json({ message: "Invoice not found" });
    res.set("X-Robots-Tag", "noindex");
    return res.json({ html, invoiceNo: r.rows[0].no });
  } catch (e) { console.error("public invoice data:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /jobs/:id/notify-ready -> the job is completed: everybody with the Sales Invoice privilege gets a notification (once per job)
router.post("/jobs/:id/notify-ready", authenticateToken, async (req, res) => {
  try {
    const jobId = toInt(req.params.id);
    if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
    const root = await rootJobId(pool, jobId).catch(() => null);
    if (!root) return res.status(404).json({ message: "Job not found" });
    const job = await jobInfo(pool, root);
    if (!job || job.status === "CANCELLED" || !job.isCompleted) return res.json({ sent: false, reason: "not completed" });
    // the job is finished: its status becomes COMPLETED (the Jobs dashboard / tables show it)
    if (job.status !== "COMPLETED") await pool.query("UPDATE job SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IS DISTINCT FROM 'CANCELLED'", [root]);
    const first = await pool.query("INSERT INTO job_invoice_notice (job_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING job_id", [root]);
    if (!first.rowCount) return res.json({ sent: false, reason: "already sent" });
    const invId = await createInvoice(pool, root, currentUserId(req)).catch(() => null);
    const inv = invId ? (await pool.query("SELECT invoice_no AS no, GREATEST(total - paid_amount, 0)::float AS balance FROM invoice WHERE id = $1", [invId])).rows[0] : null;
    if (!sendPushToUser) { console.error("sales invoice notification: the push file (exports sendPushToUser) was not found in this folder"); return res.json({ sent: false, reason: "no push service" }); }
    const envIds = String(process.env.SALES_INVOICE_MENU_IDS || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x) && Number(x) > 0).map(Number);
    const menu = envIds.length
      ? await pool.query("SELECT id, route FROM admin_uimenudata WHERE id = ANY($1::int[])", [envIds])
      : await pool.query(`SELECT id, route FROM admin_uimenudata WHERE status <> 'permission' AND (name ILIKE '%sales invoice%' OR route ILIKE '%sales-invoice%' OR route ILIKE '%sales_invoice%' OR route ILIKE '%salesinvoice%') ORDER BY (route IS NULL OR route IN ('#', '')), id`);
    if (menu.rowCount === 0) { console.error("sales invoice notification: no Sales Invoice menu row found (set SALES_INVOICE_MENU_IDS in .env)"); return res.json({ sent: false, reason: "no menu" }); }
    const ids = menu.rows.map((m) => m.id);
    const base = process.env.SALES_INVOICE_PUSH_URL || menu.rows.find((m) => m.route && m.route !== "#")?.route || "/";
    const url = `${base}${base.includes("?") ? "&" : "?"}job=${root}`;
    const users = await pool.query(
      `SELECT DISTINCT u.id FROM admin_user u JOIN admin_role r ON r.id = u.role_id
        WHERE r.privileges::text[] && $1::text[] AND COALESCE(r.status, 'active') = 'active'`, [ids.map(String)]);
    for (const u of users.rows) {
      await sendPushToUser(u.id, { title: "Job completed · invoice ready", body: `${job.jobNo} · ${job.regNo}: ${job.customerName}${inv ? ` · ${inv.no}` : ""}${inv && inv.balance > 0 ? ` · balance LKR ${inv.balance.toLocaleString("en-LK", { minimumFractionDigits: 2 })}` : ""}`, url });
    }
    return res.json({ sent: true, users: users.rowCount });
  } catch (e) { console.error("notify ready:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /jobs/:id/ensure -> creates the job invoice (called right after the job is activated; it is also created when the invoice is first opened)
router.post("/jobs/:id/ensure", authenticateToken, async (req, res) => {
  try {
    const jobId = toInt(req.params.id);
    if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
    const id = await createInvoice(pool, jobId, currentUserId(req));
    return res.json({ ok: true, created: Boolean(id) });
  } catch (e) { console.error("ensure invoice:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

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
  { const d = await denied(req, "voidPayment", "void a payment"); if (d) return d; }
  const r = await db.query("UPDATE invoice_payment SET voided_at = CURRENT_TIMESTAMP, voided_by = $3 WHERE id = $1 AND invoice_id = $2 AND voided_at IS NULL RETURNING amount::float AS amount, method", [pid, inv.id, currentUserId(req)]);
  if (!r.rowCount) return { error: "Payment not found" };
  await audit(db, inv.id, req, "PAYMENT_VOID", `Payment voided: Rs. ${fmtMoney(r.rows[0].amount)} (${r.rows[0].method})`, r.rows[0]);
  return null;
}));
 
// GET /jobs/:id/audit  -> who changed what on the invoice (newest first, last 200)
router.get("/jobs/:id/audit", authenticateToken, async (req, res) => {
  const ref = parseRef(req.params.id);
  if (!ref) return res.status(400).json({ message: "Invalid job" });
  try {
    const root = ref.job ? await rootJobId(pool, ref.job).catch(() => null) : null;
    const inv = ref.sale ? { id: ref.sale } : root ? (await pool.query("SELECT id FROM invoice WHERE job_id = $1", [root])).rows[0] : null;
    if (!inv) return res.json([]);
    const r = await pool.query(
      `SELECT a.id, a.at, a.action, a.summary, trim(concat(u.first_name, ' ', u.last_name)) AS "byName" FROM invoice_audit a LEFT JOIN admin_user u ON u.id = a.user_id WHERE a.invoice_id = $1 ORDER BY a.at DESC, a.id DESC LIMIT 200`, [inv.id]);
    return res.json(r.rows);
  } catch (e) { console.error("invoice audit:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// GET /damaged?from=&to=   -> items that came back DAMAGED (returned but not put back in stock): by item and one row per return line
router.get("/damaged", authenticateToken, async (req, res) => {
  const ok = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  let from = ok(req.query.from) || new Date().toISOString().slice(0, 7) + "-01", to = ok(req.query.to) || new Date().toISOString().slice(0, 10);
  if (from > to) [from, to] = [to, from];
  if ((new Date(to) - new Date(from)) / 86400000 > 731) return res.status(400).json({ message: "Select a range of two years or less" });
  try {
    // the cost of the item is read when the spare_part table has a cost column (cost_price / cost / purchase_price)
    const COST = `COALESCE((to_jsonb(p)->>'cost_price')::numeric, (to_jsonb(p)->>'cost')::numeric, (to_jsonb(p)->>'purchase_price')::numeric)`;
    const rows = (await pool.query(
      `SELECT to_char(r.created_at, 'YYYY-MM-DD HH24:MI') AS at, r.return_no AS "returnNo", i.invoice_no AS "invoiceNo", 's' || i.id AS ref, r.reason, l.description, l.qty::float AS qty, l.amount::float AS value, l.part_id AS "partId",
              (${COST} * l.qty)::float AS cost
         FROM sales_return_line l JOIN sales_return r ON r.id = l.return_id JOIN invoice i ON i.id = r.invoice_id LEFT JOIN spare_part p ON p.id = l.part_id
        WHERE l.part_id IS NOT NULL AND NOT l.restock AND r.created_at::date BETWEEN $1::date AND $2::date ORDER BY r.id DESC, l.id DESC LIMIT 500`, [from, to])).rows;
    const by = new Map();
    for (const x of rows) { const k = x.partId; const o = by.get(k) || { partId: k, name: x.description, qty: 0, value: 0, cost: null, n: 0 }; o.qty = r2(o.qty + x.qty); o.value = r2(o.value + x.value); o.n += 1; if (x.cost != null) o.cost = r2((o.cost || 0) + x.cost); by.set(k, o); }
    const byPart = [...by.values()].sort((a, b) => b.value - a.value);
    const hasCost = rows.some((x) => x.cost != null);
    return res.json({ range: { from, to }, rows, byPart, hasCost, totals: { lines: rows.length, qty: r2(rows.reduce((a, x) => a + x.qty, 0)), value: r2(rows.reduce((a, x) => a + x.value, 0)), cost: hasCost ? r2(rows.reduce((a, x) => a + (x.cost || 0), 0)) : null }, truncated: rows.length >= 500 });
  } catch (e) { console.error("damaged report:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// ---------- Day close (the cash count at the end of the day) ----------
// All the figures of a day: money received per method (by payment date), money given back per method (refunds of returns, by return date), the cash that should be in the drawer.
async function dayFigures(db, date) {
  const [pay, ref, sale, ret, close, prev] = await Promise.all([
    db.query("SELECT method, COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS v FROM invoice_payment WHERE voided_at IS NULL AND paid_at = $1::date GROUP BY method", [date]),
    db.query("SELECT refund_method AS method, COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::float AS v FROM sales_return WHERE refund_amount > 0 AND created_at::date = $1::date GROUP BY refund_method", [date]),
    db.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(CASE WHEN gross_total = 0 THEN total + returned_amount ELSE gross_total END), 0)::float AS v FROM invoice WHERE status <> 'CANCELLED' AND created_at::date = $1::date", [date]),
    db.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(total_value), 0)::float AS v, COALESCE(SUM(transfer_amount), 0)::float AS t FROM sales_return WHERE created_at::date = $1::date", [date]),
    db.query(`SELECT d.id, to_char(d.close_date, 'YYYY-MM-DD') AS date, d.opening_cash::float AS opening, d.cash_received::float AS "cashReceived", d.cash_refunded::float AS "cashRefunded", d.expected_cash::float AS expected, d.counted_cash::float AS counted,
                     d.difference::float AS difference, COALESCE(d.note, '') AS note, d.closed_at AS "closedAt", trim(concat(u.first_name, ' ', u.last_name)) AS "closedBy"
                FROM day_close d LEFT JOIN admin_user u ON u.id = d.closed_by WHERE d.close_date = $1::date AND d.is_active`, [date]),
    db.query("SELECT to_char(close_date, 'YYYY-MM-DD') AS date, counted_cash::float AS counted FROM day_close WHERE is_active AND close_date < $1::date ORDER BY close_date DESC LIMIT 1", [date]),
  ]);
  const P = pay.rows, F = ref.rows;
  const methods = [...new Set([...P.map((x) => x.method), ...F.map((x) => x.method)])].filter((m) => m !== "CREDIT" && m !== "EXCHANGE")
    .map((m) => ({ method: m, n: P.find((x) => x.method === m)?.n || 0, received: r2(P.find((x) => x.method === m)?.v || 0), refunded: r2(F.filter((x) => x.method === m).reduce((a, x) => a + x.v, 0)) }))
    .sort((a, b) => b.received - a.received);
  const cashReceived = r2(P.find((x) => x.method === "CASH")?.v || 0), cashRefunded = r2(F.filter((x) => x.method === "CASH").reduce((a, x) => a + x.v, 0));
  const closed = close.rows[0] || null;
  const opening = closed ? closed.opening : (prev.rows[0]?.counted ?? 0);
  return {
    date, methods, onCredit: r2(P.find((x) => x.method === "CREDIT")?.v || 0), exchange: r2(P.find((x) => x.method === "EXCHANGE")?.v || 0),
    sales: { invoices: sale.rows[0].n, value: r2(sale.rows[0].v) }, returns: { n: ret.rows[0].n, value: r2(ret.rows[0].v) },
    received: r2(methods.reduce((a, m) => a + m.received, 0)), refunded: r2(methods.reduce((a, m) => a + m.refunded, 0)),
    cash: { opening: r2(opening), received: cashReceived, refunded: cashRefunded, expected: r2(opening + cashReceived - cashRefunded) },
    suggestedOpening: r2(prev.rows[0]?.counted ?? 0), previousClose: prev.rows[0]?.date || null, close: closed,
  };
}
const dateOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);

// GET /day-close?date=YYYY-MM-DD
router.get("/day-close", authenticateToken, async (req, res) => {
  const date = dateOk(req.query.date) || new Date().toISOString().slice(0, 10);
  try {
    const f = await dayFigures(pool, date);
    // a closed day keeps the figures of the moment it was closed; if the live figures differ now (a payment / return was entered after), say so
    f.changedAfterClose = Boolean(f.close) && (Math.abs(f.cash.expected - f.close.expected) > 0.004);
    f.can = await permsOf(req);
    return res.json(f);
  } catch (e) { console.error("day close:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// GET /day-close/history   -> the last 30 closed days (and the reopened ones)
router.get("/day-close/history", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.id, to_char(d.close_date, 'YYYY-MM-DD') AS date, d.expected_cash::float AS expected, d.counted_cash::float AS counted, d.difference::float AS difference, d.is_active AS "isActive",
              d.closed_at AS "closedAt", trim(concat(u.first_name, ' ', u.last_name)) AS "closedBy", COALESCE(d.note, '') AS note, COALESCE(d.reopen_reason, '') AS "reopenReason"
         FROM day_close d LEFT JOIN admin_user u ON u.id = d.closed_by ORDER BY d.close_date DESC, d.id DESC LIMIT 30`);
    return res.json(r.rows);
  } catch (e) { console.error("day close history:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /day-close  { date, openingCash, countedCash, note? }   (the expected cash is worked out here, never taken from the screen)
router.post("/day-close", authenticateToken, async (req, res) => {
  const b = req.body || {};
  const date = dateOk(b.date);
  if (!date) return res.status(400).json({ message: "Select the date" });
  const opening = money(b.openingCash ?? 0), counted = money(b.countedCash);
  if (Number.isNaN(opening)) return res.status(400).json({ message: "Enter the opening cash" });
  if (b.countedCash === undefined || b.countedCash === null || String(b.countedCash).trim() === "" || Number.isNaN(counted)) return res.status(400).json({ message: "Enter the cash you counted" });
  try {
    const future = (await pool.query("SELECT $1::date > CURRENT_DATE + 1 AS f", [date])).rows[0].f;
    if (future) return res.status(400).json({ message: "A day that has not come yet cannot be closed" });
    const f = await dayFigures(pool, date);
    if (f.close) return res.status(409).json({ message: "This day is already closed" });
    const expected = r2(opening + f.cash.received - f.cash.refunded), diff = r2(counted - expected);
    const note = clean(b.note)?.slice(0, 500) || null;
    if (Math.abs(diff) > 0.004 && !note) return res.status(400).json({ message: `The counted cash is ${diff < 0 ? "short" : "over"} by Rs. ${Math.abs(diff).toFixed(2)}: write a note` });
    await pool.query(   // the unique index (one open record per day) stops two people closing the same day at once
      `INSERT INTO day_close (close_date, opening_cash, cash_received, cash_refunded, expected_cash, counted_cash, difference, note, snapshot, closed_by) VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [date, opening, f.cash.received, f.cash.refunded, expected, counted, diff, note, JSON.stringify({ methods: f.methods, onCredit: f.onCredit, exchange: f.exchange, sales: f.sales, returns: f.returns }), currentUserId(req)]);
    return res.status(201).json({ ok: true, ...(await dayFigures(pool, date)) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ message: "This day is already closed" });
    console.error("day close save:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /day-close/:id/reopen  { reason }   (the old record stays in the history)
router.post("/day-close/:id/reopen", authenticateToken, async (req, res) => {
  const id = toInt(req.params.id), reason = clean(req.body?.reason);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid day close" });
  if (!reason || reason.length < 3) return res.status(400).json({ message: "Write the reason for reopening" });
  try {
    if (!(await permsOf(req)).reopen) return res.status(403).json({ message: "You do not have permission to reopen a closed day" });
    const r = await pool.query("UPDATE day_close SET is_active = false, reopened_by = $2, reopened_at = now(), reopen_reason = $3 WHERE id = $1 AND is_active RETURNING to_char(close_date, 'YYYY-MM-DD') AS date", [id, currentUserId(req), reason.slice(0, 300)]);
    if (!r.rowCount) return res.status(404).json({ message: "This day is not closed" });
    return res.json({ ok: true, ...(await dayFigures(pool, r.rows[0].date)) });
  } catch (e) { console.error("day close reopen:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// ---------- Sales report ----------
// GET /report?from=YYYY-MM-DD&to=YYYY-MM-DD&type=ALL|SALE|JOB&q=   -> everything the Sales Report page shows (one request)
//   Sales = invoices made in the range (before returns); Returns = returns made in the range; Received = payments dated in the range
//   (credit is not money received, an exchange credit is not cash); Outstanding = what is still unpaid on the invoices (not limited to the range).
router.get("/report", authenticateToken, async (req, res) => {
  const ok = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const today = new Date().toISOString().slice(0, 10);
  let from = ok(req.query.from) || today, to = ok(req.query.to) || today;
  if (from > to) [from, to] = [to, from];
  if ((new Date(to) - new Date(from)) / 86400000 > 366) return res.status(400).json({ message: "Select a range of one year or less" });
  const type = ["SALE", "JOB"].includes(req.query.type) ? req.query.type : "ALL";
  const q = String(req.query.q || "").trim().slice(0, 80) || null;
  const F = `${type === "SALE" ? "i.job_id IS NULL AND i.cancelled_job_id IS NULL" : type === "JOB" ? "(i.job_id IS NOT NULL OR i.cancelled_job_id IS NOT NULL)" : "TRUE"}
     AND ($1::text IS NULL OR i.invoice_no ILIKE '%' || $1 || '%' OR COALESCE(j.job_no, cj.job_no) ILIKE '%' || $1 || '%' OR COALESCE(j.reg_no, i.sale_reg_no) ILIKE '%' || $1 || '%' OR COALESCE(c.customer_name, i.sale_customer_name) ILIKE '%' || $1 || '%')`;
  const FROM = `FROM invoice i LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id`;
  const GROSS = `(CASE WHEN i.gross_total = 0 THEN i.total + i.returned_amount ELSE i.gross_total END)`;
  const INV = `i.status <> 'CANCELLED' AND ${F} AND i.created_at::date BETWEEN $2::date AND $3::date`;
  const args = [q, from, to];
  try {
    const [sales, salesDay, payDay, retDay, methods, refunds, retSum, retReason, retList, parts, repairs, open, credit] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(${GROSS}), 0)::float AS gross, COALESCE(SUM(i.tax_amount), 0)::float AS tax FROM invoice i LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id WHERE ${INV}`, args),
      pool.query(`SELECT to_char(i.created_at::date, 'YYYY-MM-DD') AS d, COALESCE(SUM(${GROSS}), 0)::float AS v FROM invoice i LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id WHERE ${INV} GROUP BY 1`, args),
      pool.query(`SELECT to_char(p.paid_at, 'YYYY-MM-DD') AS d, COALESCE(SUM(p.amount), 0)::float AS v FROM invoice_payment p JOIN invoice i ON i.id = p.invoice_id LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                  WHERE p.voided_at IS NULL AND p.method NOT IN ('CREDIT', 'EXCHANGE') AND p.paid_at BETWEEN $2::date AND $3::date AND ${F} GROUP BY 1`, args),
      pool.query(`SELECT to_char(r.created_at::date, 'YYYY-MM-DD') AS d, COALESCE(SUM(r.total_value), 0)::float AS v FROM sales_return r JOIN invoice i ON i.id = r.invoice_id LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                  WHERE r.created_at::date BETWEEN $2::date AND $3::date AND ${F} GROUP BY 1`, args),
      pool.query(`SELECT p.method, COUNT(*)::int AS n, COALESCE(SUM(p.amount), 0)::float AS v FROM invoice_payment p JOIN invoice i ON i.id = p.invoice_id LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                  WHERE p.voided_at IS NULL AND p.paid_at BETWEEN $2::date AND $3::date AND ${F} GROUP BY p.method ORDER BY v DESC`, args),
      pool.query(`SELECT r.refund_method AS method, COUNT(*)::int AS n, COALESCE(SUM(r.refund_amount), 0)::float AS v FROM sales_return r JOIN invoice i ON i.id = r.invoice_id LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                  WHERE r.refund_amount > 0 AND r.created_at::date BETWEEN $2::date AND $3::date AND ${F} GROUP BY r.refund_method`, args),
      pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(r.total_value), 0)::float AS value, COALESCE(SUM(r.refund_amount), 0)::float AS refunded, COALESCE(SUM(r.transfer_amount), 0)::float AS transferred,
                         COUNT(*) FILTER (WHERE r.kind = 'EXCHANGE')::int AS exchanges
                    FROM sales_return r JOIN invoice i ON i.id = r.invoice_id LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                   WHERE r.created_at::date BETWEEN $2::date AND $3::date AND ${F}`, args),
      pool.query(`SELECT r.reason, COUNT(*)::int AS n, COALESCE(SUM(r.total_value), 0)::float AS v FROM sales_return r JOIN invoice i ON i.id = r.invoice_id LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                  WHERE r.created_at::date BETWEEN $2::date AND $3::date AND ${F} GROUP BY r.reason ORDER BY v DESC`, args),
      pool.query(`SELECT r.return_no AS "returnNo", r.kind, r.reason, r.total_value::float AS value, r.refund_amount::float AS refund, to_char(r.created_at, 'YYYY-MM-DD HH24:MI') AS at, i.invoice_no AS "invoiceNo", 's' || i.id AS ref,
                         COALESCE(i.sale_customer_name, '') AS customer,
                         COALESCE((SELECT SUM(l.qty) FROM sales_return_line l WHERE l.return_id = r.id AND l.part_id IS NOT NULL AND NOT l.restock), 0)::float AS damaged
                    FROM sales_return r JOIN invoice i ON i.id = r.invoice_id LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                   WHERE r.created_at::date BETWEEN $2::date AND $3::date AND ${F} ORDER BY r.id DESC LIMIT 15`, args),
      pool.query(`SELECT MIN(l.description) AS name, COALESCE(SUM(l.qty), 0)::float AS qty, COALESCE(SUM(l.amount - l.disc_amount), 0)::float AS amount,
                         COALESCE(SUM((SELECT COALESCE(SUM(rl.qty), 0) FROM sales_return_line rl WHERE rl.invoice_line_id = l.id)), 0)::float AS returned
                    FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                   WHERE ${INV} AND l.kind = 'PART' AND l.amount > 0 GROUP BY COALESCE(l.part_id::text, l.description) ORDER BY amount DESC LIMIT 10`, args),
      pool.query(`SELECT MIN(l.description) AS name, COALESCE(SUM(l.qty), 0)::float AS qty, COALESCE(SUM(l.amount - l.disc_amount), 0)::float AS amount, 0::float AS returned
                    FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                   WHERE ${INV} AND l.kind NOT IN ('PART', 'WARRANTY') AND l.amount > 0 GROUP BY l.description ORDER BY amount DESC LIMIT 10`, args),
      pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(i.total - i.paid_amount), 0)::float AS v FROM invoice i LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                  WHERE i.status IN ('UNPAID', 'PARTIAL') AND i.total - i.paid_amount > 0.004 AND ${F}`, [q]),
      pool.query(`SELECT i.invoice_no AS "invoiceNo", CASE WHEN i.job_id IS NULL THEN 's' || i.id ELSE i.job_id::text END AS ref, COALESCE(c.customer_name, i.sale_customer_name, '') AS customer,
                         (i.total - i.paid_amount)::float AS balance, to_char(d.due, 'YYYY-MM-DD') AS due, GREATEST(0, CURRENT_DATE - d.due)::int AS "overdueDays"
                    FROM invoice i LEFT JOIN job j ON j.id = i.job_id LEFT JOIN job cj ON cj.id = i.cancelled_job_id LEFT JOIN customer c ON c.id = j.customer_id
                    JOIN LATERAL (SELECT MIN(cp.due_date) AS due FROM invoice_payment cp WHERE cp.invoice_id = i.id AND cp.method = 'CREDIT' AND cp.voided_at IS NULL) d ON d.due IS NOT NULL
                   WHERE i.status IN ('UNPAID', 'PARTIAL') AND i.total - i.paid_amount > 0.004 AND ${F} ORDER BY d.due LIMIT 15`, [q]),
    ]);
    // one row per day of the range (days without anything show 0)
    const byDay = new Map();
    for (let d = new Date(from + "T00:00:00Z"); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86400000)) byDay.set(d.toISOString().slice(0, 10), { d: d.toISOString().slice(0, 10), sales: 0, received: 0, returns: 0 });
    for (const r of salesDay.rows) if (byDay.has(r.d)) byDay.get(r.d).sales = r2(r.v);
    for (const r of payDay.rows) if (byDay.has(r.d)) byDay.get(r.d).received = r2(r.v);
    for (const r of retDay.rows) if (byDay.has(r.d)) byDay.get(r.d).returns = r2(r.v);
    const pm = methods.rows, rf = refunds.rows;
    const sumM = (m) => r2(pm.filter((x) => x.method === m).reduce((a, x) => a + x.v, 0));
    const received = r2(pm.filter((x) => x.method !== "CREDIT" && x.method !== "EXCHANGE").reduce((a, x) => a + x.v, 0));
    const refunded = r2(rf.reduce((a, x) => a + x.v, 0));
    const rs = retSum.rows[0];
    return res.json({
      range: { from, to, type, q: q || "" },
      summary: { invoices: sales.rows[0].n, sales: r2(sales.rows[0].gross), tax: r2(sales.rows[0].tax), returns: r2(rs.value), netSales: r2(sales.rows[0].gross - rs.value),
                 received, refunded, netReceived: r2(received - refunded), cashInDrawer: r2(sumM("CASH") - r2(rf.filter((x) => x.method === "CASH").reduce((a, x) => a + x.v, 0))),
                 onCredit: sumM("CREDIT"), outstanding: r2(open.rows[0].v), outstandingCount: open.rows[0].n },
      days: [...byDay.values()],
      methods: [...new Set([...pm.map((x) => x.method), ...rf.map((x) => x.method)])].filter((m) => m !== "CREDIT" && m !== "EXCHANGE").map((m) => ({ method: m, n: pm.find((x) => x.method === m)?.n || 0, received: pm.find((x) => x.method === m)?.v || 0, refunded: r2(rf.filter((y) => y.method === m).reduce((a, y) => a + y.v, 0)) })).sort((a, b) => b.received - a.received),
      credit: { given: sumM("CREDIT"), exchange: sumM("EXCHANGE") },
      returns: { n: rs.n, value: r2(rs.value), refunded: r2(rs.refunded), transferred: r2(rs.transferred), exchanges: rs.exchanges, byReason: retReason.rows, recent: retList.rows },
      topParts: parts.rows, topRepairs: repairs.rows, overdue: credit.rows,
    });
  } catch (e) { console.error("sales report:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

module.exports = router;
module.exports.createInvoice = createInvoice;
module.exports.replaceLines = replaceLines;
module.exports.recalc = recalc;
module.exports.rootJobId = rootJobId;