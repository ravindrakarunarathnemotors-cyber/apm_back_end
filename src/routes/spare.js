const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { randomBytes } = require("node:crypto");
const { sendSms } = require("../services/sms.service"); 

dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();


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
const toMoney = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 && n <= 999999999 ? Math.round(n * 100) / 100 : NaN;
};
const currentUserId = (req) => {
  const n = Number(req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) ? n : null;
};
const STOCK = ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN"];
 
async function loadJob(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
            j.department_id AS "departmentId", d.name AS "departmentName",
            COALESCE(d.has_spare_parts, false) AS "hasSpareParts", d.spare_parts_stage_no AS "spareStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasSpareParts && job.stageNo >= job.spareStageNo;
 
const ITEM_SELECT = `SELECT id, part_id AS "partId", name, brand, quality, qty, unit_price::float AS "unitPrice", price_source AS "priceSource",
                            stock_status AS "stockStatus", note FROM job_spare_part`;
const QUOTE_SELECT = `SELECT id, photo_url AS "photoUrl", description, status, quoted_price::float AS "quotedPrice", quoted_note AS "quotedNote", quoted_at AS "quotedAt" FROM job_spare_quote`;
 
async function options(db) {
  const r = await db.query("SELECT kind, name FROM spare_part_option WHERE is_active ORDER BY kind, sort_order, id");
  return { brands: r.rows.filter((x) => x.kind === "BRAND").map((x) => x.name), qualities: r.rows.filter((x) => x.kind === "QUALITY").map((x) => x.name) };
}
async function listState(db, jobId) {
  const [items, quotes, head] = await Promise.all([
    db.query(`${ITEM_SELECT} WHERE job_id = $1 ORDER BY id`, [jobId]),
    db.query(`${QUOTE_SELECT} WHERE job_id = $1 ORDER BY id`, [jobId]),
    db.query(`SELECT no_parts_needed AS "noParts", link_token AS "linkToken", link_sent_at AS "linkSentAt", logistics_updated_at AS "logisticsUpdatedAt", completed_at AS "completedAt" FROM job_spare_parts WHERE job_id = $1`, [jobId]),
  ]);
  const total = items.rows.reduce((s, r) => s + r.qty * r.unitPrice, 0)
    + quotes.rows.filter((q) => q.quotedPrice != null).reduce((s, q) => s + q.quotedPrice, 0);
  return { items: items.rows, quotes: quotes.rows, header: head.rows[0] || { noParts: false, linkToken: null, linkSentAt: null, logisticsUpdatedAt: null, completedAt: null }, totalSparePartsValue: Math.round(total * 100) / 100 };
}
 
// "Root cause / Labour work list" shown from the previous related stage (Job Inspection for Mechanical, else the complaint)
async function previousStage(db, jobId) {
  const [items, repairs, concerns] = await Promise.all([
    db.query("SELECT kind, description FROM job_inspection_item WHERE job_id = $1 ORDER BY kind, sort_order, id", [jobId]).catch(() => ({ rows: [] })),
    db.query("SELECT description, repair_type AS \"repairType\", amount::float AS amount FROM job_repair_item WHERE job_id = $1 AND status = 'ACTIVE' ORDER BY id", [jobId]).catch(() => ({ rows: [] })),
    db.query(`SELECT jc.complaint, o.concern_level AS level, o.option_name AS name FROM job_complaint jc LEFT JOIN job_complaint_option o ON o.job_complaint_id = jc.id WHERE jc.job_id = $1 ORDER BY o.id`, [jobId]),
  ]);
  const of = (k) => items.rows.filter((r) => r.kind === k).map((r) => r.description);
  return {
    rootCauses: of("ROOT_CAUSE"), identifiedFaults: of("IDENTIFIED_FAULT"), labourList: repairs.rows,
    complaint: concerns.rows[0]?.complaint || "", concerns: concerns.rows.filter((r) => r.name).map((r) => ({ level: r.level, name: r.name })),
  };
}
 
// GET /jobs/:id/spare-parts   (any logged-in user can read it: other departments, Logistic & Stock ...)
router.get("/jobs/:id/spare-parts", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasSpareParts) return res.status(409).json({ message: `Spare parts are not used in the ${job.departmentName || "selected"} department` });
    const [state, prev, opts] = await Promise.all([listState(pool, jobId), previousStage(pool, jobId), options(pool)]);
    return res.json({ job, ...state, previous: prev, options: opts, reached: reached(job), canRecord: reached(job) && !state.header.completedAt });
  } catch (e) {
    console.error("load spare parts:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  }
});
 
// ---- guard for the writing routes ----
async function guard(req, res) {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) { res.status(400).json({ message: "Invalid job" }); return null; }
  const job = await loadJob(pool, jobId);
  if (!job) { res.status(404).json({ message: "Job not found" }); return null; }
  if (!reached(job)) { res.status(409).json({ message: "This job is not ready for the spare parts stage" }); return null; }
  const h = await pool.query("SELECT completed_at FROM job_spare_parts WHERE job_id = $1", [jobId]);
  if (h.rows[0]?.completed_at) { res.status(409).json({ message: "The spare parts stage is already completed" }); return null; }
  await pool.query("INSERT INTO job_spare_parts (job_id, saved_by) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING", [jobId, currentUserId(req)]);
  return { job, jobId };
}
const reply = async (res, jobId, status = 200) => res.status(status).json(await listState(pool, jobId));
 
// POST /jobs/:id/spare-parts/items   { partId }  or  { name, brand, quality, qty, unitPrice }
router.post("/jobs/:id/spare-parts/items", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    const b = req.body || {};
    const qty = toInt(b.qty ?? 1) || 1;
    if (!(qty >= 1 && qty <= 9999)) return res.status(400).json({ message: "Enter a valid quantity" });
    const uid = currentUserId(req);
    const partId = toInt(b.partId);
    if (b.partId !== undefined && b.partId !== null && b.partId !== "") {
      const p = await pool.query("SELECT id, name, brand, quality, price::float AS price, stock_qty FROM spare_part WHERE id = $1 AND is_active", [partId]);
      if (p.rowCount === 0) return res.status(404).json({ message: "Spare part not found" });
      const x = p.rows[0];
      await pool.query(
        `INSERT INTO job_spare_part (job_id, part_id, name, brand, quality, qty, unit_price, price_source, stock_status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CATALOG', $8, $9)`,
        [g.jobId, x.id, x.name, x.brand, x.quality, qty, x.price, x.stock_qty > 0 ? "IN_STOCK" : "OUT_OF_STOCK", uid]);
    } else {
      const name = clean(b.name), price = toMoney(b.unitPrice);
      if (!name || name.length > 200) return res.status(400).json({ message: "Enter the spare part name" });
      if (Number.isNaN(price)) return res.status(400).json({ message: "Enter a valid price" });
      await pool.query(
        `INSERT INTO job_spare_part (job_id, name, brand, quality, qty, unit_price, price_source, stock_status, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', 'UNKNOWN', $7)`,
        [g.jobId, name, clean(b.brand)?.slice(0, 60) || null, clean(b.quality)?.slice(0, 60) || null, qty, price, uid]);
    }
    return reply(res, g.jobId, 201);
  } catch (e) { console.error("add spare part:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /jobs/:id/spare-parts/items/:itemId   { qty?, unitPrice?, brand?, name? }   -> "Update spare parts price manually"
router.put("/jobs/:id/spare-parts/items/:itemId", authenticateToken, async (req, res) => {
  const itemId = toInt(req.params.itemId);
  if (!Number.isInteger(itemId)) return res.status(400).json({ message: "Invalid item" });
  try {
    const g = await guard(req, res); if (!g) return;
    const b = req.body || {};
    const cur = await pool.query("SELECT qty, unit_price::float AS price, brand, name FROM job_spare_part WHERE id = $1 AND job_id = $2", [itemId, g.jobId]);
    if (cur.rowCount === 0) return res.status(404).json({ message: "Spare part not found" });
    const qty = b.qty === undefined ? cur.rows[0].qty : toInt(b.qty);
    const price = b.unitPrice === undefined ? cur.rows[0].price : toMoney(b.unitPrice);
    if (!(qty >= 1 && qty <= 9999)) return res.status(400).json({ message: "Enter a valid quantity" });
    if (Number.isNaN(price)) return res.status(400).json({ message: "Enter a valid price" });
    const name = b.name === undefined ? cur.rows[0].name : clean(b.name);
    if (!name || name.length > 200) return res.status(400).json({ message: "Enter the spare part name" });
    const brand = b.brand === undefined ? cur.rows[0].brand : clean(b.brand)?.slice(0, 60) || null;
    const manual = price !== cur.rows[0].price;
    await pool.query(
      `UPDATE job_spare_part SET qty = $3, unit_price = $4, brand = $5, name = $6, price_source = CASE WHEN $7 THEN 'MANUAL' ELSE price_source END, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND job_id = $2`,
      [itemId, g.jobId, qty, price, brand, name, manual]);
    return reply(res, g.jobId);
  } catch (e) { console.error("update spare part:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
router.delete("/jobs/:id/spare-parts/items/:itemId", authenticateToken, async (req, res) => {
  const itemId = toInt(req.params.itemId);
  if (!Number.isInteger(itemId)) return res.status(400).json({ message: "Invalid item" });
  try {
    const g = await guard(req, res); if (!g) return;
    await pool.query("DELETE FROM job_spare_part WHERE id = $1 AND job_id = $2", [itemId, g.jobId]);
    return reply(res, g.jobId);
  } catch (e) { console.error("remove spare part:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// Third-party quotation requests: { photoUrl?, description }
router.post("/jobs/:id/spare-parts/quotes", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    const description = clean(req.body?.description);
    if (!description || description.length > 1000) return res.status(400).json({ message: "Add a description of the item" });
    await pool.query("INSERT INTO job_spare_quote (job_id, photo_url, description, created_by) VALUES ($1, $2, $3, $4)", [g.jobId, clean(req.body?.photoUrl), description, currentUserId(req)]);
    return reply(res, g.jobId, 201);
  } catch (e) { console.error("add quote:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
router.delete("/jobs/:id/spare-parts/quotes/:qid", authenticateToken, async (req, res) => {
  const qid = toInt(req.params.qid);
  if (!Number.isInteger(qid)) return res.status(400).json({ message: "Invalid item" });
  try {
    const g = await guard(req, res); if (!g) return;
    await pool.query("DELETE FROM job_spare_quote WHERE id = $1 AND job_id = $2 AND status = 'REQUESTED'", [qid, g.jobId]);
    return reply(res, g.jobId);
  } catch (e) { console.error("remove quote:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/spare-parts/link -> uploads the requirement + quotation requests to the ERP (status SENT) and creates the link for the Logistic & Stock department
router.post("/jobs/:id/spare-parts/link", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    const cur = await pool.query("SELECT link_token FROM job_spare_parts WHERE job_id = $1", [g.jobId]);
    const token = cur.rows[0]?.link_token || randomBytes(24).toString("hex");
    await pool.query("UPDATE job_spare_parts SET link_token = $1, link_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $2", [token, g.jobId]);
    await pool.query("UPDATE job_spare_quote SET status = 'SENT' WHERE job_id = $1 AND status = 'REQUESTED'", [g.jobId]);
    let sms = null;
    const base = String(process.env.PUBLIC_APP_URL || req.headers.origin || "").replace(/\/+$/, "");
    if (process.env.LOGISTICS_SMS_NUMBER && base) {
      sms = await sendSms(process.env.LOGISTICS_SMS_NUMBER, `Spare parts request for ${g.job.regNo} (${g.job.jobNo}): ${base}/spare-parts/${token}`);
    }
    return res.json({ token, path: `/spare-parts/${token}`, sms, ...(await listState(pool, g.jobId)) });
  } catch (e) { console.error("spare parts link:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// PUT /jobs/:id/spare-parts   { noParts }
router.put("/jobs/:id/spare-parts", authenticateToken, async (req, res) => {
  try {
    const g = await guard(req, res); if (!g) return;
    await pool.query("UPDATE job_spare_parts SET no_parts_needed = $1, updated_at = CURRENT_TIMESTAMP WHERE job_id = $2", [req.body?.noParts === true, g.jobId]);
    return reply(res, g.jobId);
  } catch (e) { console.error("spare parts header:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
// POST /jobs/:id/spare-parts/complete -> the stage is finished, the job moves on
router.post("/jobs/:id/spare-parts/complete", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for the spare parts stage" }); }
    await client.query("INSERT INTO job_spare_parts (job_id, saved_by) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING", [jobId, currentUserId(req)]);
    const h = await client.query("SELECT no_parts_needed, completed_at FROM job_spare_parts WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Already completed" }); }
    const n = await client.query("SELECT COUNT(*)::int AS n FROM job_spare_part WHERE job_id = $1", [jobId]);
    if (n.rows[0].n === 0 && !h.rows[0].no_parts_needed) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Add the spare parts, or tick 'No spare parts needed'" }); }
    await client.query("UPDATE job_spare_parts SET completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId]);
    let stageNo = job.stageNo;
    if (job.stageNo === job.spareStageNo) {
      const next = job.spareStageNo + 1;
      const uid = currentUserId(req);
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.spareStageNo, uid]);
      await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      stageNo = next;
    }
    await client.query("COMMIT");
    return res.json({ message: "Spare part review completed", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("complete spare parts:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
/* ===================== spare parts master (catalog) ===================== */
// GET /spare-parts/catalog?q=&quality=&all=1
router.get("/spare-parts/catalog", authenticateToken, async (req, res) => {
  try {
    const q = clean(req.query.q), quality = clean(req.query.quality), all = req.query.all === "1";
    const r = await pool.query(
      `SELECT id, part_no AS "partNo", name, brand, quality, price::float AS price, stock_qty AS "stockQty", is_active AS "isActive"
       FROM spare_part
       WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR brand ILIKE '%' || $1 || '%' OR part_no ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR quality = $2) AND ($3::boolean OR is_active)
       ORDER BY name, id LIMIT ${all ? 200 : 15}`, [q, quality, all]);
    return res.json(r.rows);
  } catch (e) { console.error("catalog search:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
const readPart = (b) => {
  const name = clean(b?.name), quality = clean(b?.quality), price = toMoney(b?.price), stock = toInt(b?.stockQty ?? 0);
  if (!name || name.length > 200) return { error: "Enter the spare part name" };
  if (!quality) return { error: "Select the quality" };
  if (Number.isNaN(price)) return { error: "Enter a valid price" };
  if (!Number.isInteger(stock) || stock < 0) return { error: "Enter a valid stock quantity" };
  return { name, quality: quality.slice(0, 60), price, stock, brand: clean(b?.brand)?.slice(0, 60) || null, partNo: clean(b?.partNo)?.slice(0, 60) || null, isActive: b?.isActive !== false };
};
router.post("/spare-parts/catalog", authenticateToken, async (req, res) => {
  const v = readPart(req.body); if (v.error) return res.status(400).json({ message: v.error });
  try {
    // stock is managed in the Inventory module (stock ledger): new parts always start at 0, receive stock with a GRN
    await pool.query("INSERT INTO spare_part (part_no, name, brand, quality, price, stock_qty) VALUES ($1, $2, $3, $4, $5, 0)", [v.partNo, v.name, v.brand, v.quality, v.price]);
    return res.status(201).json({ message: "Added" });
  } catch (e) { console.error("add catalog:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
router.put("/spare-parts/catalog/:id", authenticateToken, async (req, res) => {
  const id = toInt(req.params.id); if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid part" });
  const v = readPart(req.body); if (v.error) return res.status(400).json({ message: v.error });
  try {
    const r = await pool.query("UPDATE spare_part SET part_no = $2, name = $3, brand = $4, quality = $5, price = $6, is_active = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id, v.partNo, v.name, v.brand, v.quality, v.price, v.isActive]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Spare part not found" });
    return res.json({ message: "Saved" });
  } catch (e) { console.error("update catalog:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
// POST /spare-parts/options { kind: BRAND|QUALITY, name }   -> "Need to add more option"
router.post("/spare-parts/options", authenticateToken, async (req, res) => {
  const kind = ["BRAND", "QUALITY"].includes(req.body?.kind) ? req.body.kind : null, name = clean(req.body?.name);
  if (!kind || !name || name.length > 60) return res.status(400).json({ message: "Enter the option name" });
  try {
    await pool.query("INSERT INTO spare_part_option (kind, name, sort_order) VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) FROM spare_part_option WHERE kind = $1), 0) + 1) ON CONFLICT (kind, name) DO UPDATE SET is_active = true", [kind, name]);
    return res.status(201).json(await options(pool));
  } catch (e) { console.error("add option:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
 
/* ===================== public page of the Logistic & Stock department ===================== */
// GET /public/spare-parts/:token   (NO login - the long random token is the key; no customer data)
router.get("/public/spare-parts/:token", async (req, res) => {
  const token = clean(req.params.token);
  if (!token) return res.status(400).json({ message: "Invalid link" });
  try {
    const h = await pool.query(
      `SELECT s.job_id, s.logistics_updated_at AS "updatedAt", j.job_no AS "jobNo", j.reg_no AS "regNo", d.name AS "departmentName"
       FROM job_spare_parts s JOIN job j ON j.id = s.job_id LEFT JOIN department d ON d.id = j.department_id WHERE s.link_token = $1`, [token]);
    if (h.rowCount === 0) return res.status(404).json({ message: "Request not found" });
    const st = await listState(pool, h.rows[0].job_id);
    return res.json({ ...h.rows[0], job_id: undefined, items: st.items, quotes: st.quotes.filter((q) => q.status !== "REQUESTED"), totalSparePartsValue: st.totalSparePartsValue });
  } catch (e) { console.error("public spare parts:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
// PUT /public/spare-parts/:token   { items: [{ id, unitPrice, stockStatus, note }], quotes: [{ id, price, note }] }
router.put("/public/spare-parts/:token", async (req, res) => {
  const token = clean(req.params.token);
  if (!token) return res.status(400).json({ message: "Invalid link" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const h = await client.query("SELECT job_id FROM job_spare_parts WHERE link_token = $1 FOR UPDATE", [token]);
    if (h.rowCount === 0) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Request not found" }); }
    const jobId = h.rows[0].job_id;
    for (const i of Array.isArray(req.body?.items) ? req.body.items : []) {
      const id = toInt(i.id), price = toMoney(i.unitPrice), stock = STOCK.includes(i.stockStatus) ? i.stockStatus : null;
      if (!Number.isInteger(id) || Number.isNaN(price)) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Check the prices" }); }
      await client.query("UPDATE job_spare_part SET unit_price = $3, stock_status = COALESCE($4, stock_status), note = $5, price_source = 'LOGISTICS', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND job_id = $2", [id, jobId, price, stock, clean(i.note)?.slice(0, 300) || null]);
    }
    for (const q of Array.isArray(req.body?.quotes) ? req.body.quotes : []) {
      const id = toInt(q.id);
      if (!Number.isInteger(id)) continue;
      if (q.price === "" || q.price === null || q.price === undefined) continue;
      const price = toMoney(q.price);
      if (Number.isNaN(price)) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Check the quoted prices" }); }
      await client.query("UPDATE job_spare_quote SET quoted_price = $3, quoted_note = $4, quoted_at = CURRENT_TIMESTAMP, status = 'QUOTED' WHERE id = $1 AND job_id = $2", [id, jobId, price, clean(q.note)?.slice(0, 300) || null]);
    }
    await client.query("UPDATE job_spare_parts SET logistics_updated_at = CURRENT_TIMESTAMP WHERE job_id = $1", [jobId]);
    await client.query("COMMIT");
    return res.json({ message: "Updated. Thank you." });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("public spare parts update:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
 
module.exports = router;
 