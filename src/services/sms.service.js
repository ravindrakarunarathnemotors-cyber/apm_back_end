// services/sms.service.js  -  sends SMS through SMSlenz (https://smslenz.lk/api/send-sms)
// Put these in the backend .env (NEVER in the frontend) and restart the server:
//   SMSLENZ_USER_ID=2696
//   SMSLENZ_API_KEY=<your api key>
//   SMSLENZ_SENDER_ID=<your approved Sender ID>        (SMSlenzDEMO works for testing only)
//   PUBLIC_APP_URL=https://your-erp-domain.com         (used to build the customer link, e.g. http://localhost:6002 in dev)
// Needs Node 18+ (global fetch).
//
// Settings > SMS & notifications (app_setting group "sms") controls: the on/off switch, the message templates, the logistics number
// and the spare-parts reminder. Every SMS is written to sms_log. All of it is optional: with no settings saved everything works as before.

let _pool;                       // the pg pool, found lazily ("../db" is the same path from routes/ and services/); setPool() overrides it
function db() { if (_pool === undefined) { try { _pool = require("../db"); } catch (_) { _pool = null; } } return _pool; }
function setPool(p) { _pool = p; }

// Sri Lanka: 07XXXXXXXX / 947XXXXXXXX / +947XXXXXXXX -> +947XXXXXXXX ; anything else -> null
function toSriLankaNumber(raw) {
  let n = String(raw ?? "").replace(/[^\d]/g, "");
  if (n.startsWith("0094")) n = n.slice(2);
  if (n.startsWith("0")) n = `94${n.slice(1)}`;
  if (n.length === 9) n = `94${n}`; // 7XXXXXXXX
  return /^94\d{9}$/.test(n) ? `+${n}` : null;
}

// ---- message templates ----
// {name} = a value, [ ... {name} ... ] = an optional part that is dropped when its value is empty
const TEMPLATES = {
  estimate: {
    label: "Estimate (Customer Approval)", audience: "Customer", vars: ["companyName", "regNo", "jobNo", "amount", "time"], required: ["amount"],
    text: "{companyName}: Estimate for {regNo} ({jobNo}) is Rs. {amount}.[ Estimated repair time: {time}.] Please confirm to proceed.",
  },
  partsList: {
    label: "Spare parts the customer brings", audience: "Customer", vars: ["companyName", "regNo", "jobNo", "link"], required: ["link"],
    text: "{companyName}: Spare parts list for {regNo} ({jobNo}): {link}",
  },
  extraEstimate: {
    label: "Extra job estimate", audience: "Customer", vars: ["companyName", "regNo", "amount", "time"], required: ["amount"],
    text: "{companyName}: Extra work estimate for vehicle {regNo}: Rs. {amount}.[ Estimated time: {time}.] Please confirm with us. Thank you.",
  },
  extraApproved: {
    label: "Extra job approved total", audience: "Customer", vars: ["companyName", "regNo", "amount", "time"], required: ["amount"],
    text: "{companyName}: Approved extra work for vehicle {regNo}: Rs. {amount}.[ Estimated time: {time}.] Thank you for your confirmation.",
  },
  evidence: {
    label: "Vehicle evidence report", audience: "Customer", vars: ["companyName", "regNo", "link"], required: ["link"],
    text: "Vehicle evidence report for {regNo}: {link}",
  },
  spareRequest: {
    label: "Spare parts request", audience: "Logistics", vars: ["companyName", "regNo", "jobNo", "link"], required: ["link"],
    text: "Spare parts request for {regNo} ({jobNo}): {link}",
  },
  spareReminder: {
    label: "Spare parts reminder", audience: "Logistics", vars: ["companyName", "regNo", "jobNo", "link"], required: ["link"],
    text: "Reminder: spare parts for {regNo} ({jobNo}) are needed for the repair. {link}",
  },
};

function fill(text, vars) {
  const has = (k) => String(vars[k] ?? "").trim() !== "";
  let out = String(text).replace(/\[([^\[\]]*)\]/g, (_, inner) => {
    const keys = [...inner.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    return keys.every(has) ? inner : "";
  });
  out = out.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
  return out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,:])/g, "$1").trim();
}

let _cache = null, _cacheAt = 0;
async function getSmsSettings(force = false) {
  if (!force && _cache && Date.now() - _cacheAt < 5000) return _cache;
  const out = { enabled: true, logisticsNumber: "", spareReminderOn: true, templates: {}, companyName: "KARUNARATHNE AUTO ZONE" };
  const pool = db();
  if (pool) {
    try {
      const r = await pool.query("SELECT group_key, key, value FROM app_setting WHERE group_key IN ('sms', 'company')");
      for (const x of r.rows) {
        if (x.group_key === "company" && x.key === "name" && x.value) out.companyName = x.value;
        if (x.group_key === "sms" && x.key in out && x.key !== "companyName") out[x.key] = x.value;
      }
    } catch (_) { /* the settings table does not exist yet: defaults */ }
  }
  _cache = out; _cacheAt = Date.now();
  return out;
}
const clearSmsCache = () => { _cache = null; };

// the text of a template (the saved one, or the default) with the values filled in
async function renderSms(key, vars = {}) {
  const cfg = await getSmsSettings();
  const t = typeof cfg.templates?.[key] === "string" && cfg.templates[key].trim() ? cfg.templates[key] : TEMPLATES[key].text;
  return fill(t, { companyName: cfg.companyName, ...vars });
}

// the number the logistics SMS goes to: Settings first, then LOGISTICS_SMS_NUMBER of the .env
async function getLogisticsNumber() {
  const cfg = await getSmsSettings();
  return cfg.logisticsNumber || process.env.LOGISTICS_SMS_NUMBER || "";
}

// ---- log ----
let _logReady = false;
async function writeLog(row) {
  const pool = db(); if (!pool) return;
  try {
    if (!_logReady) {
      await pool.query(`CREATE TABLE IF NOT EXISTS public.sms_log (
        id serial PRIMARY KEY, to_number varchar(30), message text, kind varchar(30), sent boolean NOT NULL DEFAULT false, error varchar(300),
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      _logReady = true;
    }
    await pool.query("INSERT INTO sms_log (to_number, message, kind, sent, error) VALUES ($1, $2, $3, $4, $5)", [row.to, String(row.message).slice(0, 1500), row.kind || null, !!row.sent, row.error ? String(row.error).slice(0, 300) : null]);
  } catch (e) { console.error("sms log:", e.message); }
}

// -> { sent: boolean, to?: string, error?: string }   (never throws).  opts: { kind, force }  (force = ignore the on/off switch, used by the test SMS)
async function sendSms(to, message, opts = {}) {
  const log = async (out) => { await writeLog({ to: out.to || String(to ?? ""), message, kind: opts.kind, sent: out.sent, error: out.error }); return out; };
  const cfg = await getSmsSettings();
  if (cfg.enabled === false && !opts.force) return log({ sent: false, error: "SMS is switched off in Settings" });
  const { SMSLENZ_USER_ID, SMSLENZ_API_KEY, SMSLENZ_SENDER_ID } = process.env;
  if (!SMSLENZ_USER_ID || !SMSLENZ_API_KEY || !SMSLENZ_SENDER_ID) return log({ sent: false, error: "SMS is not configured on the server" });
  const contact = toSriLankaNumber(to);
  if (!contact) return log({ sent: false, error: "The customer has no valid mobile number" });
  try {
    const r = await fetch("https://smslenz.lk/api/send-sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: SMSLENZ_USER_ID, api_key: SMSLENZ_API_KEY, sender_id: SMSLENZ_SENDER_ID, contact, message: String(message).slice(0, 1500) }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) return log({ sent: false, to: contact, error: body.message || `SMS gateway error (${r.status})` });
    return log({ sent: true, to: contact });
  } catch (e) {
    console.error("SMS send failed:", e.message);
    return log({ sent: false, to: contact, error: "Could not reach the SMS gateway" });
  }
}

module.exports = { sendSms, toSriLankaNumber, renderSms, fill, TEMPLATES, getSmsSettings, clearSmsCache, getLogisticsNumber, setPool };