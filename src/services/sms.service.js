// services/sms.service.js   (NEW file)  -  sends SMS through SMSlenz (https://smslenz.lk/api/send-sms)
// Put these in the backend .env (NEVER in the frontend) and restart the server:
//   SMSLENZ_USER_ID=2696
//   SMSLENZ_API_KEY=<your api key>
//   SMSLENZ_SENDER_ID=<your approved Sender ID>        (SMSlenzDEMO works for testing only)
//   PUBLIC_APP_URL=https://your-erp-domain.com         (used to build the customer link, e.g. http://localhost:6002 in dev)
// Needs Node 18+ (global fetch).

// Sri Lanka: 07XXXXXXXX / 947XXXXXXXX / +947XXXXXXXX -> +947XXXXXXXX ; anything else -> null
function toSriLankaNumber(raw) {
  let n = String(raw ?? "").replace(/[^\d]/g, "");
  if (n.startsWith("0094")) n = n.slice(2);
  if (n.startsWith("0")) n = `94${n.slice(1)}`;
  if (n.length === 9) n = `94${n}`; // 7XXXXXXXX
  return /^94\d{9}$/.test(n) ? `+${n}` : null;
}

// -> { sent: boolean, to?: string, error?: string }   (never throws)
async function sendSms(to, message) {
  const { SMSLENZ_USER_ID, SMSLENZ_API_KEY, SMSLENZ_SENDER_ID } = process.env;
  if (!SMSLENZ_USER_ID || !SMSLENZ_API_KEY || !SMSLENZ_SENDER_ID) return { sent: false, error: "SMS is not configured on the server" };
  const contact = toSriLankaNumber(to);
  if (!contact) return { sent: false, error: "The customer has no valid mobile number" };
  try {
    const r = await fetch("https://smslenz.lk/api/send-sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: SMSLENZ_USER_ID, api_key: SMSLENZ_API_KEY, sender_id: SMSLENZ_SENDER_ID, contact, message: String(message).slice(0, 1500) }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) return { sent: false, to: contact, error: body.message || `SMS gateway error (${r.status})` };
    return { sent: true, to: contact };
  } catch (e) {
    console.error("SMS send failed:", e.message);
    return { sent: false, to: contact, error: "Could not reach the SMS gateway" };
  }
}

module.exports = { sendSms, toSriLankaNumber };