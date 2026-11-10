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

 
// Adds the columns of the "customer brings the spare parts" report by itself (so no SQL file has to be run by hand)
pool.query("ALTER TABLE job_customer_approval ADD COLUMN IF NOT EXISTS client_parts jsonb NOT NULL DEFAULT '[]'::jsonb, ADD COLUMN IF NOT EXISTS client_parts_token text")
  .catch((e) => console.error("customer approval: could not add the client_parts columns (run add_client_parts.sql):", e.code, e.message));
 
const VIA = ["SMS", "WHATSAPP", "ERP", "PHONE_CALL", "EMAIL"];   // the window now offers SMS only; the old values stay valid for saved jobs
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
  return Number.isFinite(n) && n >= 0 && n <= 99999 ? Math.round(n * 10000) / 10000 : NaN; // hours keep minute precision (1 min = 0.0167 h)
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
  const [parts, quotes, repairs, causes, wash, mk, treeRows] = await Promise.all([
    db.query(`SELECT id, name, brand, quality, qty, unit_price::float AS "unitPrice", COALESCE(warranty_claim, false) AS "warrantyClaim" FROM job_spare_part WHERE job_id = $1 ORDER BY id`, [jobId]).catch(() => ({ rows: [] })),
    db.query(`SELECT description, quoted_price::float AS "quotedPrice" FROM job_spare_quote WHERE job_id = $1 AND quoted_price IS NOT NULL ORDER BY id`, [jobId]).catch(() => ({ rows: [] })),
    db.query(`SELECT description, repair_type AS "repairType", amount::float AS amount, COALESCE(qty, 1) AS qty, COALESCE(unit_price, amount / GREATEST(COALESCE(qty, 1), 1))::float AS "unitPrice", COALESCE(warranty_claim, false) AS "warrantyClaim" FROM job_repair_item WHERE job_id = $1 AND status = 'ACTIVE' ORDER BY id`, [jobId]).catch(() => ({ rows: [] })),
    db.query(`SELECT description FROM job_inspection_item WHERE job_id = $1 AND kind = 'ROOT_CAUSE' ORDER BY sort_order, id`, [jobId]).catch(() => ({ rows: [] })),
    // Wash types + prices come from the Wash department's "Wash Type" / "Repair Type" list (Jobs Dashboard > Repair Type)
    db.query(
      `SELECT o.id, COALESCE(o.group_name, '') AS "groupName", o.name, o.price::float AS price
       FROM complaint_option o
       JOIN complaint_option_list l ON l.id = o.list_id
       JOIN department d ON d.id = l.department_id
       WHERE lower(d.name) = 'wash' AND (l.code IN ('REPAIR_TYPE', 'WASH_TYPE') OR l.title ~* '(wash|repair) type') AND o.is_active AND l.is_active
       ORDER BY o.sort_order, o.id`).catch(() => ({ rows: [] })),
    db.query("SELECT COALESCE(price_markup_percent, 0)::float AS p FROM job WHERE id = $1", [jobId]).catch(() => ({ rows: [] })),
    // every repair type with its child types + labour price (the job's own department first), to add an extra agreed item
    db.query(
      `SELECT p.name AS parent, c.id AS "childId", c.name AS "childName", c.price::float AS price, d.name AS department, (l.department_id = j.department_id) AS "isCurrent"
       FROM job j
       CROSS JOIN complaint_option_list l
       JOIN department d ON d.id = l.department_id AND d.is_active
       JOIN complaint_option p ON p.list_id = l.id AND p.is_active AND btrim(COALESCE(p.group_name, '')) = ''
       LEFT JOIN complaint_option c ON c.list_id = l.id AND c.is_active AND lower(btrim(c.group_name)) = lower(btrim(p.name))
       WHERE j.id = $1 AND l.is_active AND (l.code ILIKE '%\_TYPE' OR l.title ILIKE '%repair type%' OR l.title ILIKE '%concern type%')
       ORDER BY (l.department_id = j.department_id) DESC, d.name, p.sort_order, p.id, c.sort_order, c.id`, [jobId]).catch(() => ({ rows: [] })),
  ]);
  const repairTree = [];
  for (const r of treeRows.rows) {
    let g = repairTree.find((x) => x.parent === r.parent && x.department === r.department);
    if (!g) { g = { parent: r.parent, department: r.department, isCurrent: r.isCurrent, children: [] }; repairTree.push(g); }
    if (r.childId) g.children.push({ id: r.childId, name: r.childName, price: r.price, label: `${r.parent} > ${r.childName}` });
  }
  const sparePartsValue = parts.rows.filter((r) => !r.warrantyClaim).reduce((s, r) => s + r.qty * r.unitPrice, 0) + quotes.rows.reduce((s, q) => s + q.quotedPrice, 0);
  const labourTotal = repairs.rows.filter((r) => !r.warrantyClaim).reduce((s, r) => s + (r.amount || 0), 0);
  // Only the types a customer can really pick: child types, and parents that have no children
  const all = wash.rows;
  const parentsWithKids = new Set(all.filter((o) => o.groupName).map((o) => o.groupName.toLowerCase()));
  const washOptions = all
    .filter((o) => o.groupName || !parentsWithKids.has(o.name.toLowerCase()))
    .map((o) => ({ id: o.id, name: o.name, group: o.groupName, price: o.price || 0 }));
  return {
    parts: parts.rows, quotes: quotes.rows, sparePartsValue: Math.round(sparePartsValue * 100) / 100,
    labour: repairs.rows, labourTotal: Math.round(labourTotal * 100) / 100,
    rootCauses: causes.rows.map((r) => r.description), washOptions, repairTree, markupPercent: mk.rows[0]?.p || 0,
  };
}
 
const EMPTY = {
  estHours: null, estDays: null, includeSpareParts: true, includeLabour: true, manualItems: [], washItems: [], estimatedTotal: 0,
  sentVia: [], decision: null, agreedScope: [], extraNote: "", partsBy: null, clientPartsFiles: [], clientParts: [], clientListSentAt: null,
  repairRequestSentAt: null, thirdPartyRequest: false, thirdPartyNote: "", thirdPartySentAt: null, completedAt: null,
};
async function loadSaved(db, jobId) {
  const r = await db.query(
    `SELECT est_hours::float AS "estHours", est_days::float AS "estDays", include_spare_parts AS "includeSpareParts", include_labour AS "includeLabour",
            manual_items AS "manualItems", wash_items AS "washItems", estimated_total::float AS "estimatedTotal", sent_via AS "sentVia",
            decision, agreed_scope AS "agreedScope", COALESCE(extra_note, '') AS "extraNote", parts_by AS "partsBy",
            client_parts_files AS "clientPartsFiles", COALESCE(client_parts, '[]'::jsonb) AS "clientParts", client_list_sent_at AS "clientListSentAt",
            repair_request_sent_at AS "repairRequestSentAt", third_party_request AS "thirdPartyRequest", COALESCE(third_party_note, '') AS "thirdPartyNote",
            third_party_sent_at AS "thirdPartySentAt", completed_at AS "completedAt"
     FROM job_customer_approval WHERE job_id = $1`, [jobId]);
  return r.rows[0] || { ...EMPTY };
}
// estimate = spare parts + (labour + manual lines = cost for repair) + wash
// The lines that really count in the estimate, by what the customer agreed:
//   "Agreed scope only" -> only the ticked repair items;   spare parts the customer brings himself are not charged.
const scopeKey = (l) => l.repairType || l.description;
function billable(saved, ctx) {
  const agreed = Array.isArray(saved.agreedScope) ? saved.agreedScope : [];
  const own = Array.isArray(saved.clientParts) ? saved.clientParts.map(Number) : [];
  const labour = ctx.labour.filter((l) => !l.warrantyClaim && (saved.decision !== "PARTIAL" || agreed.includes(scopeKey(l))));
  const parts = ctx.parts.filter((p) => !p.warrantyClaim && !(saved.partsBy === "CLIENT" && own.includes(Number(p.id))));
  return { labour, parts };
}
function totals(saved, ctx) {
  const { labour: labourLines, parts: partLines } = billable(saved, ctx);
  const spare = saved.includeSpareParts ? partLines.reduce((s, r) => s + r.qty * r.unitPrice, 0) + ctx.quotes.reduce((s, q) => s + q.quotedPrice, 0) : 0;
  const labour = saved.includeLabour ? labourLines.reduce((s, r) => s + (r.amount || 0), 0) : 0;
  const manual = saved.manualItems.reduce((s, m) => s + (Number(m.amount) || 0), 0);
  const wash = saved.washItems.reduce((s, w) => s + (Number(w.price) || 0), 0);
  const repairCost = labour + manual;
  // price adjustment (markup %) of the job: added to EACH spare part / quotation / repair / manual line separately (not on wash)
  const pct = Number(ctx.markupPercent) || 0;
  // the % is added to the UNIT PRICE of each line: markup of a line = qty x (unit price + % - unit price)
  const lineAdj = (q, u) => Math.round((Number(q) || 0) * (Math.round((Number(u) || 0) * (100 + pct)) / 100 - (Number(u) || 0)) * 100) / 100;
  let markup = 0;
  if (saved.includeSpareParts) markup += partLines.reduce((s, r) => s + lineAdj(r.qty, r.unitPrice), 0) + ctx.quotes.reduce((s, q) => s + lineAdj(1, q.quotedPrice), 0);
  if (saved.includeLabour) markup += labourLines.reduce((s, r) => s + lineAdj(r.qty || 1, r.unitPrice ?? r.amount), 0);
  markup += saved.manualItems.reduce((s, m) => s + lineAdj(1, m.amount), 0);
  markup = Math.round(markup * 100) / 100;
  return { spare, labour, manual, repairCost, markup, markupPercent: Number(ctx.markupPercent) || 0, wash, total: Math.round((spare + repairCost + markup + wash) * 100) / 100 };
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
    // the spare parts the customer brings (ids of this job's spare parts)
    const partIds = new Set(ctx.parts.map((p) => p.id));
    const clientParts = [...new Set((Array.isArray(b.clientParts) ? b.clientParts : []).map(Number).filter((n) => Number.isInteger(n) && partIds.has(n)))];
    const next = {
      ...g.saved, includeSpareParts: b.includeSpareParts !== false, includeLabour: b.includeLabour !== false, manualItems, washItems,
      decision, agreedScope: decision === "PARTIAL" ? lines(b.agreedScope) : [], partsBy, clientParts,
    };
    const t = totals(next, ctx);
    await pool.query(
      `INSERT INTO job_customer_approval
         (job_id, est_hours, est_days, include_spare_parts, include_labour, manual_items, wash_items, estimated_total, sent_via,
          decision, agreed_scope, extra_note, parts_by, client_parts_files, third_party_request, third_party_note, saved_by, client_parts)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::jsonb)
       ON CONFLICT (job_id) DO UPDATE SET
         est_hours = EXCLUDED.est_hours, est_days = EXCLUDED.est_days, include_spare_parts = EXCLUDED.include_spare_parts,
         include_labour = EXCLUDED.include_labour, manual_items = EXCLUDED.manual_items, wash_items = EXCLUDED.wash_items,
         estimated_total = EXCLUDED.estimated_total, sent_via = EXCLUDED.sent_via, decision = EXCLUDED.decision,
         agreed_scope = EXCLUDED.agreed_scope, extra_note = EXCLUDED.extra_note, parts_by = EXCLUDED.parts_by,
         client_parts_files = EXCLUDED.client_parts_files, third_party_request = EXCLUDED.third_party_request,
         third_party_note = EXCLUDED.third_party_note, saved_by = EXCLUDED.saved_by, client_parts = EXCLUDED.client_parts, updated_at = CURRENT_TIMESTAMP`,
      [g.jobId, estHours, estDays, next.includeSpareParts, next.includeLabour, JSON.stringify(manualItems), JSON.stringify(washItems), t.total, sentVia,
       decision, decision === "PARTIAL" ? lines(b.agreedScope) : [], clean(b.extraNote)?.slice(0, 1000) || null, partsBy, JSON.stringify(files),
       b.thirdPartyRequest === true, clean(b.thirdPartyNote)?.slice(0, 500) || null, currentUserId(req), JSON.stringify(clientParts)]);
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
 
// POST /jobs/:id/customer-approval/send-parts-sms   { phone? }
// SMSes the customer a link to the "spare parts the customer brings" report (a normal SMS, not WhatsApp). The report page is
// GET /public/client-parts/:token below. The link base is PUBLIC_API_URL (the public address of this server) when set.
router.post("/jobs/:id/customer-approval/send-parts-sms", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    const phoneOverride = clean(req.body?.phone);
    if (phoneOverride && !toSriLankaNumber(phoneOverride)) return res.status(400).json({ message: "Enter a valid mobile number (07XXXXXXXX)" });
    const s = g.saved;
    if ((s.clientParts || []).length === 0 && (s.clientPartsFiles || []).length === 0) return res.status(400).json({ message: "Select the spare parts the customer brings first" });
    const cur = await pool.query("SELECT client_parts_token FROM job_customer_approval WHERE job_id = $1", [g.jobId]);
    const token = cur.rows[0]?.client_parts_token || randomBytes(24).toString("hex");
    await pool.query("UPDATE job_customer_approval SET client_parts_token = $1, client_list_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $2", [token, g.jobId]);
    const base = String(process.env.PUBLIC_API_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
    const text = await renderSms("partsList", { regNo: g.job.regNo, jobNo: g.job.jobNo, link: `${base}/evidence/public/client-parts/${token}` });
    const c = await pool.query(
      `SELECT COALESCE(NULLIF(c.alt_contact_number, ''), c.contact_number) AS phone, c.contact_number AS main_phone
       FROM job j JOIN customer c ON c.id = j.customer_id WHERE j.id = $1`, [g.jobId]);
    const row = c.rows[0] || {};
    let sms = await sendSms(phoneOverride || row.phone, text, { kind: "partsList" });
    if (!sms.sent && !phoneOverride && row.main_phone && row.main_phone !== row.phone) sms = await sendSms(row.main_phone, text, { kind: "partsList" });
    return res.json({ sms, saved: await loadSaved(pool, g.jobId) });
  } catch (e) { console.error("approval send parts sms:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// GET /public/client-parts/:token   (NO login - the long random token is the key): the spare parts report page for the customer (plain HTML, no prices)
router.get("/public/client-parts/:token", async (req, res) => {
  const token = clean(req.params.token);
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return res.status(404).send("Report not found");
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  try {
    const r = await pool.query(
      `SELECT a.client_parts, a.client_parts_files, j.id AS job_id, j.job_no, j.reg_no
       FROM job_customer_approval a JOIN job j ON j.id = a.job_id WHERE a.client_parts_token = $1`, [token]);
    if (r.rowCount === 0) return res.status(404).send("Report not found");
    const row = r.rows[0];
    const ids = (Array.isArray(row.client_parts) ? row.client_parts : []).map(Number).filter(Number.isInteger);
    const parts = ids.length ? (await pool.query("SELECT name, brand, quality, qty FROM job_spare_part WHERE job_id = $1 AND id = ANY($2::int[]) ORDER BY id", [row.job_id, ids])).rows : [];
    const files = (Array.isArray(row.client_parts_files) ? row.client_parts_files : []).filter((f) => /^https?:\/\//i.test(f?.url || ""));
    const extra = await pool.query(
      `SELECT c.customer_name, to_char(CURRENT_DATE, 'DD Mon YYYY') AS today, d.name AS department
       FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [row.job_id]);
    const info = extra.rows[0] || {};
    const appBase = String(process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
    const logo = appBase ? `${appBase}/images/mainlogo.jpeg` : "";
    const totalQty = parts.reduce((t, p) => t + (Number(p.qty) || 0), 0);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("X-Robots-Tag", "noindex");
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spare parts report ${esc(row.job_no)}</title>
<style>
:root{--brand:#8f0b0b;--brand-d:#5e0404;--gold:#a8864f;--ink:#1c1917;--muted:#78716c;--line:#e7e2dc;--soft:#f6f4f1}
*{box-sizing:border-box}body{font-family:"Segoe UI",Helvetica,Arial,sans-serif;color:var(--ink);margin:0;background:#e9e6e1;font-size:14px;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:760px;margin:18px auto;background:#fff;padding:26px 28px 22px;border-radius:6px;box-shadow:0 8px 30px -12px rgba(0,0,0,.35)}
.top{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px}.brand img{height:54px;width:auto;object-fit:contain}
.brandname{font-weight:800;letter-spacing:.08em;color:var(--brand);font-size:16px}
.doc{text-align:right}.doc .t{font-size:22px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--brand)}.doc .s{color:var(--muted);font-size:12px}
.gold{height:3px;background:linear-gradient(90deg,var(--brand),var(--gold));margin:12px 0 14px;border-radius:2px}
dl.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 6px}
dl.meta div{background:var(--soft);border-radius:8px;padding:8px 10px}dt{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}dd{margin:2px 0 0;font-weight:700}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:var(--brand);margin:18px 0 6px;border-bottom:1px solid var(--line);padding-bottom:4px}
table{width:100%;border-collapse:collapse}th{background:var(--brand);color:#fff;text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;padding:8px 8px}
td{padding:8px;border-bottom:1px solid var(--line)}tr:nth-child(even) td{background:#fcfbf9}.r{text-align:right}.c{text-align:center;width:34px}
.sum{margin-top:10px;display:flex;justify-content:flex-end}.sum div{background:var(--brand);color:#fff;border-radius:8px;padding:8px 16px;font-weight:700}
.note{background:var(--soft);border-left:3px solid var(--gold);padding:8px 12px;border-radius:4px;color:#44403c;margin-top:12px;font-size:13px}
.files a{color:var(--brand);font-weight:600}
.sign{display:flex;gap:30px;margin-top:34px}.sign div{flex:1;border-top:1px solid #a8a29e;padding-top:4px;text-align:center;color:var(--muted);font-size:12px}
.foot{margin-top:18px;text-align:center;color:var(--muted);font-size:11.5px;border-top:1px solid var(--line);padding-top:8px}
.actions{max-width:760px;margin:14px auto 0;text-align:right;padding:0 4px}.actions button{background:var(--brand);color:#fff;border:0;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer}
@media(max-width:560px){.page{margin:0;border-radius:0;padding:18px 14px}.doc{text-align:left}}
@media print{body{background:#fff}.page{margin:0;box-shadow:none;border-radius:0;max-width:none}.actions{display:none}@page{size:A4;margin:12mm}}
</style></head><body>
<div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="page">
  <div class="top">
    <div class="brand">${logo ? `<img src="${esc(logo)}" alt="" onerror="this.style.display='none'">` : ""}<div class="brandname">KARUNARATHNE AUTO ZONE</div></div>
    <div class="doc"><div class="t">Spare parts report</div><div class="s">Parts provided by the customer</div></div>
  </div><div class="gold"></div>
  <dl class="meta">
    <div><dt>Vehicle no</dt><dd>${esc(row.reg_no)}</dd></div>
    <div><dt>Job</dt><dd>${esc(row.job_no)}</dd></div>
    <div><dt>Customer</dt><dd>${esc(info.customer_name || "-")}</dd></div>
    <div><dt>Date</dt><dd>${esc(info.today || "")}</dd></div>
  </dl>
  ${info.department ? `<div class="note">Department: ${esc(info.department)} · Please bring the spare parts listed below to the workshop.</div>` : ""}
  <h2>Spare parts to bring</h2>
  <table><thead><tr><th class="c">#</th><th>Spare part</th><th>Brand</th><th>Quality</th><th class="r">Qty</th></tr></thead><tbody>
  ${parts.map((p, n) => `<tr><td class="c">${n + 1}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.brand || "-")}</td><td>${esc(p.quality || "-")}</td><td class="r"><b>${esc(p.qty)}</b></td></tr>`).join("") || `<tr><td colspan="5" style="color:#78716c">See the attached list below.</td></tr>`}
  </tbody></table>
  ${parts.length ? `<div class="sum"><div>${parts.length} item(s) · Total qty ${totalQty}</div></div>` : ""}
  ${files.length ? `<h2>Attached list</h2><div class="files">${files.map((f) => `<div><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name || "Spare part list")}</a></div>`).join("")}</div>` : ""}
  <div class="sign"><div>Prepared by</div><div>Customer</div></div>
  <div class="foot">KARUNARATHNE AUTO ZONE · Thank you for choosing us</div>
</div></body></html>`);
  } catch (e) { console.error("public client parts:", e.code, e.message); return res.status(500).send("Server error"); }
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
    const logi = await getLogisticsNumber();
    if (logi && base) {
      const what = kind === "REPAIR" ? "Repair request" : "Third-party purchase request";
      sms = await sendSms(logi, `${what} for ${g.job.regNo} (${g.job.jobNo})${note ? `: ${note}` : ""} ${base}/spare-parts/${token}`, { kind: "logistics" });
    }
    return res.json({ sms, saved: await loadSaved(pool, g.jobId) });
  } catch (e) { console.error("approval logistics:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/customer-approval/complete -> the stage is finished, the job moves on
// POST /jobs/:id/customer-approval/send-sms   { includeSpareParts, includeLabour, time?, phone? }
// SMSes the estimate (total, with the price adjustment, warranty claims not charged) to the customer: the WhatsApp / alternative number first, then the main mobile.
// Returns { sms: { sent, to?, error? }, total }. Also records "SMS" in "Estimation sent via".
router.post("/jobs/:id/customer-approval/send-sms", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    const phoneOverride = clean(req.body?.phone);
    if (phoneOverride && !toSriLankaNumber(phoneOverride)) return res.status(400).json({ message: "Enter a valid mobile number (07XXXXXXXX)" });
    const ctx = await context(pool, g.jobId);
    // full = the estimate sent BEFORE the customer confirmation: every repair and spare part, no agreement applied yet
    const full = req.body?.full === true;
    const base = full ? { ...g.saved, decision: null, agreedScope: [], partsBy: null, clientParts: [] } : g.saved;
    const t = totals({ ...base, includeSpareParts: req.body?.includeSpareParts !== false, includeLabour: req.body?.includeLabour !== false, manualItems: [], washItems: [] }, ctx);
    if (!(t.total > 0)) return res.status(400).json({ message: "The estimate total is Rs. 0.00, nothing to send" });
    const c = await pool.query(
      `SELECT COALESCE(NULLIF(c.alt_contact_number, ''), c.contact_number) AS phone, c.contact_number AS main_phone
       FROM job j JOIN customer c ON c.id = j.customer_id WHERE j.id = $1`, [g.jobId]);
    const row = c.rows[0] || {};
    const time = clean(req.body?.time)?.slice(0, 60);
    const amount = t.total.toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const text = await renderSms("estimate", { regNo: g.job.regNo, jobNo: g.job.jobNo, amount, time });
    const trySms = async (to) => { try { return await sendSms(to, text, { kind: "estimate" }); } catch (e) { console.error("approval send sms (sms service):", e.message); return { sent: false, error: "Could not send the SMS" }; } };
    let sms = await trySms(phoneOverride || row.phone);
    if (!sms?.sent && !phoneOverride && row.main_phone && row.main_phone !== row.phone) sms = await trySms(row.main_phone);   // fall back to the main number
    if (sms?.sent) {
      // record "SMS" in "Estimation sent via" (a problem here must not hide that the SMS went out)
      try {
        await pool.query("INSERT INTO job_customer_approval (job_id, saved_by) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING", [g.jobId, currentUserId(req)]);
        await pool.query("UPDATE job_customer_approval SET sent_via = (SELECT ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(sent_via, '{}'::text[]) || ARRAY['SMS']::text[]) AS x)), updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [g.jobId]);
      } catch (e) { console.error("approval send sms (record):", e.code, e.message); }
    }
    return res.json({ sms, total: t.total });
  } catch (e) { console.error("approval send sms:", e.code, e.message, e.stack); return res.status(500).json({ message: "Server error" }); }
});
 
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
    // sending the estimate by SMS is optional: the stage can be completed without it
    if (!s.decision) return bad("Select the customer confirmation");
    if (s.decision === "PARTIAL" && s.agreedScope.length === 0) return bad("Write the agreed scope");
    if (!s.partsBy) return bad("Select who provides the spare parts");
    if (s.partsBy === "CLIENT" && s.clientPartsFiles.length === 0 && (s.clientParts || []).length === 0) return bad("Select the spare parts the customer brings (or upload the list)");
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
    // the invoice is created from the approved statement (a problem here must not undo the completed stage; the invoice is also created when it is opened)
    try {
      let inv;
      for (const n of ["invoice.routes", "invoice"]) { try { inv = require(`./${n}`); break; } catch (e) { if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes(`./${n}`)) throw e; } }
      if (inv) await inv.createInvoice(pool, jobId, currentUserId(req));
    } catch (e) { console.error("create invoice:", e.code, e.message); }
    return res.json({ message: "Customer approval completed", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("complete customer approval:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
module.exports = router;
// used by invoice.routes.js (the invoice lines are the approved statement)
module.exports.helpers = { context, loadSaved, billable, totals };
 