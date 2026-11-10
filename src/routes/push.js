// Web push notifications.
// 1) npm i web-push        2) npx web-push generate-vapid-keys        3) put the keys in .env (see below)
// 4) Mount once:   app.use("/api", require("./routes/push.routes"));
//
// .env (backend):
//   VAPID_PUBLIC_KEY=...
//   VAPID_PRIVATE_KEY=...
//   VAPID_SUBJECT=mailto:you@yourcompany.com
//   PUSH_CLICK_URL=/crm/jobs        <- the page that opens when the consultant taps the notification
const express = require("express");
const webpush = require("web-push");
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");

const router = express.Router();

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
const CLICK_URL = process.env.PUSH_CLICK_URL || "/";
const pushReady = !!(PUBLIC_KEY && PRIVATE_KEY);
if (pushReady) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
else console.warn("[push] VAPID keys are missing - push notifications are disabled");

const userIdOf = (req) => {
  const n = Number(req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) ? n : null;
};

/* GET /api/push/public-key  -> { enabled, key } */
router.get("/push/public-key", authenticateToken, (req, res) => {
  res.json({ enabled: pushReady, key: PUBLIC_KEY });
});

/* POST /api/push/subscribe   body: { subscription }  (the object from pushManager.subscribe().toJSON()) */
router.post("/push/subscribe", authenticateToken, async (req, res) => {
  const uid = userIdOf(req);
  const sub = req.body?.subscription;
  if (uid === null) return res.status(401).json({ message: "Invalid session" });
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ message: "Invalid subscription" });
  }
  try {
    // same browser = same endpoint: if another user logs in on it, the subscription moves to that user
    await pool.query(
      `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [uid, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(req.headers["user-agent"] || "").slice(0, 300)]
    );
    res.json({ message: "Notifications enabled" });
  } catch (e) {
    console.error("push subscribe error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

/* POST /api/push/unsubscribe   body: { endpoint } */
router.post("/push/unsubscribe", authenticateToken, async (req, res) => {
  const uid = userIdOf(req);
  try {
    await pool.query("DELETE FROM push_subscription WHERE endpoint = $1 AND user_id = $2", [req.body?.endpoint, uid]);
    res.json({ message: "Notifications disabled" });
  } catch (e) {
    console.error("push unsubscribe error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

/* GET /api/my-notifications?limit=30  -> { items: [...], unread } */
router.get("/my-notifications", authenticateToken, async (req, res) => {
  const uid = userIdOf(req);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  try {
    const [items, unread] = await Promise.all([
      pool.query(
        `SELECT id, title, body, url, is_read AS "isRead", created_at AS "createdAt"
           FROM user_notification WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [uid, limit]),
      pool.query("SELECT COUNT(*)::int AS n FROM user_notification WHERE user_id = $1 AND is_read = FALSE", [uid]),
    ]);
    res.json({ items: items.rows, unread: unread.rows[0].n });
  } catch (e) {
    console.error("my-notifications error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

/* POST /api/my-notifications/read   body: { ids: [1,2] }  or  { all: true } */
router.post("/my-notifications/read", authenticateToken, async (req, res) => {
  const uid = userIdOf(req);
  try {
    if (req.body?.all) {
      await pool.query("UPDATE user_notification SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE", [uid]);
    } else {
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
      if (ids.length) await pool.query("UPDATE user_notification SET is_read = TRUE WHERE user_id = $1 AND id = ANY($2::int[])", [uid, ids]);
    }
    res.json({ message: "ok" });
  } catch (e) {
    console.error("my-notifications read error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

/* Send a notification to every device of one user. Never throws (a failed push must not break the caller). */
async function sendPushToUser(userId, payload) {
  if (!Number.isInteger(Number(userId))) return;
  // 1) keep it in the bell list (even if the user never enabled push on a device)
  try {
    await pool.query(
      "INSERT INTO user_notification (user_id, title, body, url) VALUES ($1, $2, $3, $4)",
      [userId, payload.title, payload.body || null, payload.url || CLICK_URL]
    );
  } catch (e) {
    console.error("save notification error:", e.message);
  }
  // 2) push to every device
  if (!pushReady) return;
  try {
    const subs = await pool.query("SELECT endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1", [userId]);
    const body = JSON.stringify({ url: CLICK_URL, ...payload });
    await Promise.all(
      subs.rows.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
        } catch (err) {
          // 404 / 410 = the phone or browser removed the subscription: delete it
          if (err.statusCode === 404 || err.statusCode === 410) {
            await pool.query("DELETE FROM push_subscription WHERE endpoint = $1", [s.endpoint]).catch(() => {});
          } else {
            console.error("push send error:", err.statusCode || err.message);
          }
        }
      })
    );
  } catch (e) {
    console.error("sendPushToUser error:", e.message);
  }
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;