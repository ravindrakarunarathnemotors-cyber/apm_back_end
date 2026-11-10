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
  `CREATE TABLE IF NOT EXISTS public.app_setting (
     group_key  varchar(40) NOT NULL,
     key        varchar(60) NOT NULL,
     value      jsonb NOT NULL,
     updated_by integer REFERENCES public.admin_user (id),
     updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (group_key, key)
   )`,
  `CREATE TABLE IF NOT EXISTS public.app_setting_log (
     id         serial PRIMARY KEY,
     group_key  varchar(40) NOT NULL,
     key        varchar(60) NOT NULL,
     old_value  jsonb,
     new_value  jsonb,
     changed_by integer REFERENCES public.admin_user (id),
     changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
];
(async () => { for (const q of DDL) { try { await pool.query(q); } catch (e) { console.error("settings setup:", e.code, e.message); } } })();
 
const currentUserId = (req) => {
  const n = Number(req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) ? n : null;
};
 
// Settings can be CHANGED by an administrator only (admin_user.role_id = 1, read from the database by the id in the token).
// Reading the values that the documents and the screens need stays open to every logged-in user.
const ADMIN_ROLE_ID = 1;
async function requireAdmin(req, res, next) {
  try {
    const id = currentUserId(req);
    const r = id ? await pool.query("SELECT role_id, status FROM admin_user WHERE id = $1", [id]) : { rows: [] };
    const u = r.rows[0];
    if (!u || String(u.status).toLowerCase() !== "active") return res.status(401).json({ message: "Your session is not valid. Please log in again." });
    if (Number(u.role_id) !== ADMIN_ROLE_ID) return res.status(403).json({ message: "Only an administrator can change the settings" });
    return next();
  } catch (e) { console.error("settings admin check:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
}
 
// ---- Company profile ----
const COMPANY_DEFAULTS = { name: "KARUNARATHNE AUTO ZONE", logoUrl: "", address: "", phone: "", email: "", website: "" };
 
async function readGroup(db, group) {
  const r = await db.query("SELECT key, value FROM app_setting WHERE group_key = $1", [group]).catch(() => ({ rows: [] }));
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
}
// the company profile; address / phone / email fall back to the old invoice_setting columns until they are set here
async function getCompany(db) {
  const saved = await readGroup(db, "company");
  const out = { ...COMPANY_DEFAULTS, ...saved };
  if (!saved.address || !saved.phone || !saved.email) {
    const old = await db.query("SELECT company_address AS a, company_phone AS p, company_email AS e FROM invoice_setting WHERE id = 1").catch(() => ({ rows: [] }));
    const o = old.rows[0] || {};
    if (!saved.address && o.a) out.address = o.a;
    if (!saved.phone && o.p) out.phone = o.p;
    if (!saved.email && o.e) out.email = o.e;
  }
  return out;
}
 
const str = (v, max) => String(v ?? "").trim().slice(0, max);
function validateCompany(b = {}) {
  const v = {
    name: str(b.name, 120), logoUrl: str(b.logoUrl, 500), address: str(b.address, 300),
    phone: str(b.phone, 60), email: str(b.email, 120), website: str(b.website, 120),
  };
  if (!v.name) return { error: "Enter the company name" };
  if (v.logoUrl && !/^https?:\/\/\S+$/i.test(v.logoUrl) && !v.logoUrl.startsWith("/")) return { error: "Invalid logo" };
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return { error: "Enter a valid email address" };
  if (v.website && !/^(https?:\/\/)?[^\s.]+\.\S+$/i.test(v.website)) return { error: "Enter a valid website" };
  return { value: v };
}
 
// GET /settings/company
router.get("/company", authenticateToken, async (req, res) => {
  try { return res.json({ company: await getCompany(pool) }); }
  catch (e) { console.error("load company profile:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /settings/company   { name, logoUrl, address, phone, email, website }
router.put("/company", authenticateToken, requireAdmin, async (req, res) => {
  const { value, error } = validateCompany(req.body);
  if (error) return res.status(400).json({ message: error });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const old = await readGroup(client, "company");
    const uid = currentUserId(req);
    for (const [key, val] of Object.entries(value)) {
      if (JSON.stringify(old[key] ?? COMPANY_DEFAULTS[key]) === JSON.stringify(val) && key in old) continue;
      if (!(key in old) && val === COMPANY_DEFAULTS[key]) continue;
      await client.query(
        `INSERT INTO app_setting (group_key, key, value, updated_by) VALUES ('company', $1, $2::jsonb, $3)
         ON CONFLICT (group_key, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`, [key, JSON.stringify(val), uid]);
      await client.query("INSERT INTO app_setting_log (group_key, key, old_value, new_value, changed_by) VALUES ('company', $1, $2::jsonb, $3::jsonb, $4)",
        [key, old[key] === undefined ? null : JSON.stringify(old[key]), JSON.stringify(val), uid]);
    }
    await client.query("COMMIT");
    return res.json({ ok: true, company: await getCompany(pool) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("save company profile:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
// ---- Terms & conditions (printed on the estimates) ----
const TERMS_DEFAULTS = {
  estimate: [
    "This estimate is valid for 14 days from the date of issue.",
    "The amounts are estimates. Any additional work found during the repair will be done only after your approval.",
    "Spare parts are charged as quoted. Prices may change if the supplier changes the price before the order is placed.",
    "Parts that were ordered specially for your vehicle cannot be returned or cancelled.",
    "Please collect the vehicle within 3 days of the completion call. Storage charges may apply after that.",
    "Warranty applies only to the work and the parts listed on the invoice, as per the warranty terms.",
  ],
};
const cleanTerms = (arr) => (Array.isArray(arr) ? arr : []).map((t) => str(t, 400)).filter(Boolean).slice(0, 30);
async function getTerms(db) {
  const saved = await readGroup(db, "terms");
  return { estimate: "estimate" in saved ? cleanTerms(saved.estimate) : TERMS_DEFAULTS.estimate };
}
 
// GET /settings/terms
router.get("/terms", authenticateToken, async (req, res) => {
  try { return res.json({ terms: await getTerms(pool) }); }
  catch (e) { console.error("load terms:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /settings/terms   { estimate: ["term 1", "term 2", ...] }   (an empty list = no terms printed)
router.put("/terms", authenticateToken, requireAdmin, async (req, res) => {
  if (!Array.isArray(req.body?.estimate)) return res.status(400).json({ message: "Invalid terms" });
  const estimate = cleanTerms(req.body.estimate);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const old = await readGroup(client, "terms");
    const before = "estimate" in old ? old.estimate : TERMS_DEFAULTS.estimate;
    if (JSON.stringify(before) !== JSON.stringify(estimate)) {
      const uid = currentUserId(req);
      await client.query(
        `INSERT INTO app_setting (group_key, key, value, updated_by) VALUES ('terms', 'estimate', $1::jsonb, $2)
         ON CONFLICT (group_key, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`, [JSON.stringify(estimate), uid]);
      await client.query("INSERT INTO app_setting_log (group_key, key, old_value, new_value, changed_by) VALUES ('terms', 'estimate', $1::jsonb, $2::jsonb, $3)",
        [JSON.stringify(before), JSON.stringify(estimate), uid]);
    }
    await client.query("COMMIT");
    return res.json({ ok: true, terms: await getTerms(pool) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("save terms:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
// ---- Tax & invoice ----
const PAY_METHODS = ["CASH", "CARD", "BANK_TRANSFER", "CHEQUE", "ONLINE", "MOBILE_WALLET", "CREDIT"];
const INVOICE_DEFAULTS = {
  vatDefaultOn: true, vatPercent: 18, vatRegNo: "", prefix: "INV-", digits: 5, methods: PAY_METHODS, maxDiscountPercent: 100,
  showBank: false, bankName: "", bankAccountName: "", bankAccountNo: "", bankBranch: "", footerNote: "", terms: [],
};
async function nextInvoiceNumber(db) {
  const r = await db.query("SELECT last_value::bigint AS l, is_called AS c FROM invoice_no_seq").catch(() => ({ rows: [] }));
  if (!r.rows[0]) return null;
  return Number(r.rows[0].l) + (r.rows[0].c ? 1 : 0);
}
async function getInvoiceSettings(db) {
  const saved = await readGroup(db, "invoice");
  const out = { ...INVOICE_DEFAULTS };
  const old = (await db.query("SELECT vat_percent::float AS p, vat_default_on AS d, vat_reg_no AS r FROM invoice_setting WHERE id = 1").catch(() => ({ rows: [] }))).rows[0];
  if (old) { out.vatPercent = old.p; out.vatDefaultOn = old.d; out.vatRegNo = old.r || ""; }
  for (const k of Object.keys(INVOICE_DEFAULTS)) if (k in saved) out[k] = saved[k];
  return { ...out, nextNumber: await nextInvoiceNumber(db) };
}
function validateInvoice(b = {}) {
  const pct = Number(b.vatPercent), maxD = Number(b.maxDiscountPercent), digits = Number(b.digits);
  if (!(pct >= 0 && pct <= 100)) return { error: "Enter a VAT percentage between 0 and 100" };
  if (!(maxD >= 0 && maxD <= 100)) return { error: "The maximum discount must be between 0 and 100 %" };
  if (!Number.isInteger(digits) || digits < 3 || digits > 10) return { error: "Number length must be between 3 and 10" };
  const prefix = str(b.prefix, 8);
  if (!/^[A-Za-z0-9\-\/_]*$/.test(prefix)) return { error: "The prefix can have letters, numbers, - / _ only" };
  const methods = (Array.isArray(b.methods) ? b.methods : []).filter((m, i, a) => PAY_METHODS.includes(m) && a.indexOf(m) === i);
  if (!methods.length) return { error: "Keep at least one payment method" };
  const showBank = b.showBank === true;
  const v = {
    vatDefaultOn: b.vatDefaultOn === true, vatPercent: Math.round(pct * 100) / 100, vatRegNo: str(b.vatRegNo, 60), prefix, digits, methods,
    maxDiscountPercent: Math.round(maxD * 100) / 100, showBank,
    bankName: str(b.bankName, 80), bankAccountName: str(b.bankAccountName, 80), bankAccountNo: str(b.bankAccountNo, 40), bankBranch: str(b.bankBranch, 80),
    footerNote: str(b.footerNote, 300), terms: cleanTerms(b.terms),
  };
  if (showBank && !v.bankName && !v.bankAccountNo) return { error: "Enter the bank name or the account number, or switch the bank details off" };
  return { value: v };
}
 
// GET /settings/invoice
router.get("/invoice", authenticateToken, async (req, res) => {
  try { return res.json({ invoice: await getInvoiceSettings(pool) }); }
  catch (e) { console.error("load invoice settings:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /settings/invoice   { ...INVOICE_DEFAULTS keys, nextNumber? }   (the next number can only be raised)
router.put("/invoice", authenticateToken, requireAdmin, async (req, res) => {
  const { value, error } = validateInvoice(req.body);
  if (error) return res.status(400).json({ message: error });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await getInvoiceSettings(client);
    const old = await readGroup(client, "invoice");
    const uid = currentUserId(req);
    for (const [key, val] of Object.entries(value)) {
      const before = key in old ? old[key] : cur[key];
      if (JSON.stringify(before) === JSON.stringify(val)) continue;
      await client.query(
        `INSERT INTO app_setting (group_key, key, value, updated_by) VALUES ('invoice', $1, $2::jsonb, $3)
         ON CONFLICT (group_key, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`, [key, JSON.stringify(val), uid]);
      await client.query("INSERT INTO app_setting_log (group_key, key, old_value, new_value, changed_by) VALUES ('invoice', $1, $2::jsonb, $3::jsonb, $4)",
        [key, JSON.stringify(before), JSON.stringify(val), uid]);
    }
    if (req.body?.nextNumber !== undefined && req.body.nextNumber !== null && req.body.nextNumber !== "") {
      const want = Number(req.body.nextNumber);
      if (!Number.isInteger(want) || want < 1 || want > 999999999) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Invalid next invoice number" }); }
      if (cur.nextNumber !== null && want !== cur.nextNumber) {
        if (want < cur.nextNumber) { await client.query("ROLLBACK"); return res.status(400).json({ message: `The next number cannot go back. It must be ${cur.nextNumber} or more` }); }
        await client.query("SELECT setval('invoice_no_seq', $1, false)", [want]);
        await client.query("INSERT INTO app_setting_log (group_key, key, old_value, new_value, changed_by) VALUES ('invoice', 'nextNumber', $1::jsonb, $2::jsonb, $3)", [JSON.stringify(cur.nextNumber), JSON.stringify(want), uid]);
      }
    }
    await client.query("COMMIT");
    return res.json({ ok: true, invoice: await getInvoiceSettings(pool) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("save invoice settings:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
// ---- Numbering (job / customer / employee numbers) ----
// optional: Numbering works only after numbering.helper.js is added next to this file (the server starts without it)
let numberingLib = null;
try { numberingLib = require("./numbering.helper"); } catch (_) { /* not installed */ }
const NO_NUMBERING = { message: "Numbering is not installed on the server (add numbering.helper.js)" };
function validateNumbering(b = {}) {
  const v = {};
  for (const k of Object.keys(numberingLib.KINDS)) {
    const prefix = str(b[`${k}Prefix`], 6), digits = Number(b[`${k}Digits`]);
    if (!prefix) return { error: `Enter the ${k} prefix` };
    if (!/^[A-Za-z0-9\-\/_]+$/.test(prefix)) return { error: "A prefix can have letters, numbers, - / _ only" };
    if (!Number.isInteger(digits) || digits < 3 || digits > 8) return { error: "Number length must be between 3 and 8" };
    v[`${k}Prefix`] = prefix.toUpperCase(); v[`${k}Digits`] = digits;
  }
  return { value: v };
}
 
// GET /settings/numbering
router.get("/numbering", authenticateToken, async (req, res) => {
  if (!numberingLib) return res.status(501).json(NO_NUMBERING);
  try { return res.json({ numbering: await numberingLib.getNumbering(pool) }); }
  catch (e) { console.error("load numbering:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /settings/numbering   { jobPrefix, jobDigits, customerPrefix, customerDigits, employeePrefix, employeeDigits }
// Only the records created after the change use the new format; the existing numbers are not touched.
router.put("/numbering", authenticateToken, requireAdmin, async (req, res) => {
  if (!numberingLib) return res.status(501).json(NO_NUMBERING);
  const { value, error } = validateNumbering(req.body);
  if (error) return res.status(400).json({ message: error });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await numberingLib.getNumbering(client);
    const uid = currentUserId(req);
    for (const [key, val] of Object.entries(value)) {
      if (cur[key] === val) continue;
      await client.query(
        `INSERT INTO app_setting (group_key, key, value, updated_by) VALUES ('numbering', $1, $2::jsonb, $3)
         ON CONFLICT (group_key, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`, [key, JSON.stringify(val), uid]);
      await client.query("INSERT INTO app_setting_log (group_key, key, old_value, new_value, changed_by) VALUES ('numbering', $1, $2::jsonb, $3::jsonb, $4)",
        [key, JSON.stringify(cur[key]), JSON.stringify(val), uid]);
    }
    await client.query("COMMIT");
    return res.json({ ok: true, numbering: await numberingLib.getNumbering(pool) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("save numbering:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
// ---- SMS & notifications ----
// optional: the SMS settings work only when the sms service (the one the route files already use) can be found
let sms = null;
try { sms = require("../services/sms.service"); /* <-- adjust the path if needed */ } catch (_) { /* not found */ }
const NO_SMS = { message: "The SMS service was not found (check the require path in settings.routes.js)" };
const templateMeta = () => !sms || !sms.TEMPLATES ? {} : Object.fromEntries(Object.entries(sms.TEMPLATES).map(([k, t]) => [k, { label: t.label, audience: t.audience, vars: t.vars, required: t.required, text: t.text }]));
async function getSmsView(db) {
  const saved = await readGroup(db, "sms");
  const templates = {};
  for (const k of Object.keys(sms.TEMPLATES)) templates[k] = typeof saved.templates?.[k] === "string" && saved.templates[k].trim() ? saved.templates[k] : sms.TEMPLATES[k].text;
  return {
    settings: {
      enabled: saved.enabled !== false, logisticsNumber: saved.logisticsNumber || "", spareReminderOn: saved.spareReminderOn !== false, templates,
    },
    meta: templateMeta(),
    gateway: { configured: !!(process.env.SMSLENZ_USER_ID && process.env.SMSLENZ_API_KEY && process.env.SMSLENZ_SENDER_ID), senderId: process.env.SMSLENZ_SENDER_ID || "", envLogisticsNumber: process.env.LOGISTICS_SMS_NUMBER ? true : false },
  };
}
function validateSms(b = {}) {
  const logisticsNumber = str(b.logisticsNumber, 30);
  if (logisticsNumber && !sms.toSriLankaNumber(logisticsNumber)) return { error: "Enter a valid logistics mobile number (07XXXXXXXX)" };
  const templates = {};
  for (const [k, def] of Object.entries(sms.TEMPLATES)) {
    const t = String(b.templates?.[k] ?? def.text).trim();
    if (!t || t === def.text) continue;                        // empty or unchanged -> the default is used
    if (t.length > 480) return { error: `${def.label}: the message is too long (max 480 characters)` };
    const used = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const bad = used.find((u) => !def.vars.includes(u));
    if (bad) return { error: `${def.label}: {${bad}} is not available here` };
    const missing = def.required.find((r) => !used.includes(r));
    if (missing) return { error: `${def.label}: the message must contain {${missing}}` };
    templates[k] = t;
  }
  return { value: { enabled: b.enabled !== false, logisticsNumber, spareReminderOn: b.spareReminderOn !== false, templates } };
}
 
// GET /settings/sms
router.get("/sms", authenticateToken, requireAdmin, async (req, res) => {
  if (!sms || !sms.TEMPLATES) return res.status(501).json(NO_SMS);
  try { return res.json(await getSmsView(pool)); }
  catch (e) { console.error("load sms settings:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /settings/sms   { enabled, logisticsNumber, spareReminderOn, templates: { key: "text" } }
router.put("/sms", authenticateToken, requireAdmin, async (req, res) => {
  if (!sms || !sms.TEMPLATES) return res.status(501).json(NO_SMS);
  const { value, error } = validateSms(req.body);
  if (error) return res.status(400).json({ message: error });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const old = await readGroup(client, "sms");
    const uid = currentUserId(req);
    for (const [key, val] of Object.entries(value)) {
      const before = key in old ? old[key] : (key === "templates" ? {} : key === "logisticsNumber" ? "" : true);
      if (JSON.stringify(before) === JSON.stringify(val)) continue;
      await client.query(
        `INSERT INTO app_setting (group_key, key, value, updated_by) VALUES ('sms', $1, $2::jsonb, $3)
         ON CONFLICT (group_key, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`, [key, JSON.stringify(val), uid]);
      await client.query("INSERT INTO app_setting_log (group_key, key, old_value, new_value, changed_by) VALUES ('sms', $1, $2::jsonb, $3::jsonb, $4)",
        [key, JSON.stringify(before), JSON.stringify(val), uid]);
    }
    await client.query("COMMIT");
    sms.clearSmsCache();
    return res.json({ ok: true, ...(await getSmsView(pool)) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("save sms settings:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
// POST /settings/sms/test   { phone, message? }   (sends even when the SMS switch is off)
router.post("/sms/test", authenticateToken, requireAdmin, async (req, res) => {
  if (!sms || !sms.sendSms) return res.status(501).json(NO_SMS);
  const phone = str(req.body?.phone, 30);
  if (!sms.toSriLankaNumber(phone)) return res.status(400).json({ message: "Enter a valid mobile number (07XXXXXXXX)" });
  const cfg = await sms.getSmsSettings(true);
  const text = str(req.body?.message, 300) || `${cfg.companyName}: This is a test SMS from the ERP.`;
  const out = await sms.sendSms(phone, text, { kind: "test", force: true });
  return res.json({ sms: out });
});
 
// GET /settings/sms/log?limit=50
router.get("/sms/log", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const r = await pool.query(`SELECT id, to_number AS "to", message, kind, sent, error, created_at AS "createdAt" FROM sms_log ORDER BY id DESC LIMIT $1`, [limit]).catch(() => ({ rows: [] }));
    return res.json({ log: r.rows });
  } catch (e) { console.error("sms log:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// ---- Pricing ----
const MARKUP_DEFAULTS = [2, 5, 8, 10, 12];   // 0 = "None" is always there
function cleanMarkups(arr) {
  const l = (Array.isArray(arr) ? arr : []).map((x) => Math.round(Number(x) * 100) / 100);
  return [...new Set(l.filter((x) => Number.isFinite(x) && x > 0 && x <= 50))].sort((a, b) => a - b);
}
async function getPricing(db) {
  const saved = await readGroup(db, "pricing");
  return { adjustmentOptions: Array.isArray(saved.adjustmentOptions) ? cleanMarkups(saved.adjustmentOptions) : MARKUP_DEFAULTS };
}
 
// GET /settings/pricing
router.get("/pricing", authenticateToken, async (req, res) => {
  try { return res.json({ pricing: await getPricing(pool), defaults: { adjustmentOptions: MARKUP_DEFAULTS } }); }
  catch (e) { console.error("load pricing:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /settings/pricing   { adjustmentOptions: [2, 5, 8, 10, 12] }   (0 = none is always allowed; jobs that already use another % keep it)
router.put("/pricing", authenticateToken, requireAdmin, async (req, res) => {
  if (!Array.isArray(req.body?.adjustmentOptions)) return res.status(400).json({ message: "Invalid options" });
  const bad = req.body.adjustmentOptions.find((x) => !(Number(x) > 0 && Number(x) <= 50));
  if (bad !== undefined) return res.status(400).json({ message: "Each percentage must be more than 0 and not more than 50" });
  const list = cleanMarkups(req.body.adjustmentOptions);
  if (list.length > 10) return res.status(400).json({ message: "Use at most 10 percentages" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = (await getPricing(client)).adjustmentOptions;
    if (JSON.stringify(before) !== JSON.stringify(list)) {
      const uid = currentUserId(req);
      await client.query(
        `INSERT INTO app_setting (group_key, key, value, updated_by) VALUES ('pricing', 'adjustmentOptions', $1::jsonb, $2)
         ON CONFLICT (group_key, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`, [JSON.stringify(list), uid]);
      await client.query("INSERT INTO app_setting_log (group_key, key, old_value, new_value, changed_by) VALUES ('pricing', 'adjustmentOptions', $1::jsonb, $2::jsonb, $3)", [JSON.stringify(before), JSON.stringify(list), uid]);
    }
    await client.query("COMMIT");
    return res.json({ ok: true, pricing: await getPricing(pool), defaults: { adjustmentOptions: MARKUP_DEFAULTS } });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("save pricing:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
// GET /settings/log?group=company   (who changed what)
router.get("/log", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const g = String(req.query.group || "company").slice(0, 40);
    const r = await pool.query(
      `SELECT l.id, l.key, l.old_value AS "oldValue", l.new_value AS "newValue", l.changed_at AS "changedAt", trim(concat(u.first_name, ' ', u.last_name)) AS "changedByName"
       FROM app_setting_log l LEFT JOIN admin_user u ON u.id = l.changed_by WHERE l.group_key = $1 ORDER BY l.id DESC LIMIT 50`, [g]);
    return res.json({ log: r.rows });
  } catch (e) { console.error("settings log:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
module.exports = router;
module.exports.getCompany = getCompany;
module.exports.getTerms = getTerms;
module.exports.getInvoiceSettings = getInvoiceSettings;
 