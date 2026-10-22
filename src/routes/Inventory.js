const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');


dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();



// Who may ADJUST / SCRAP stock.  [] = nobody extra;  [1] = role_id 1 (admin)
const STOCK_MANAGER_ROLE_IDS = [1];

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
const toQty = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= 9999999 ? Math.round(n * 100) / 100 : NaN;
};
const toMoney = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 && n <= 999999999 ? Math.round(n * 100) / 100 : NaN;
};
const currentUserId = (req) => {
  const n = Number(req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) ? n : null;
};
async function isStockManager(req) {
  const uid = currentUserId(req);
  if (!uid || STOCK_MANAGER_ROLE_IDS.length === 0) return false;
  const r = await pool.query("SELECT role_id FROM admin_user WHERE id = $1", [uid]);
  return r.rowCount > 0 && STOCK_MANAGER_ROLE_IDS.includes(Number(r.rows[0].role_id));
}
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

/**
 * The ONLY place where stock changes. Call it inside a transaction (client = pool client after BEGIN).
 * qty is signed: + in, - out. Rejects when on-hand would go below zero.
 */
async function consumeBatches(client, partId, locationId, qty) {   // FEFO: earliest expiry first
  let left = qty;
  const rows = (await client.query(
    "SELECT id, qty_on_hand::float AS q FROM stock_batch WHERE part_id = $1 AND location_id = $2 AND qty_on_hand > 0 ORDER BY expiry_date NULLS LAST, id FOR UPDATE", [partId, locationId])).rows;
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(r.q, left);
    await client.query("UPDATE stock_batch SET qty_on_hand = qty_on_hand - $2 WHERE id = $1", [r.id, take]);
    left -= take;
  }
}
async function addBatch(client, partId, locationId, qty, batchNo, expiry, unitCost) {
  const ex = await client.query(
    "SELECT id FROM stock_batch WHERE part_id = $1 AND location_id = $2 AND batch_no = $3 AND COALESCE(expiry_date, DATE '1900-01-01') = COALESCE($4::date, DATE '1900-01-01') FOR UPDATE", [partId, locationId, batchNo, expiry]);
  if (ex.rowCount > 0) await client.query("UPDATE stock_batch SET qty_on_hand = qty_on_hand + $2 WHERE id = $1", [ex.rows[0].id, qty]);
  else await client.query("INSERT INTO stock_batch (part_id, location_id, batch_no, expiry_date, qty_on_hand, unit_cost) VALUES ($1, $2, $3, $4, $5, $6)", [partId, locationId, batchNo, expiry, qty, unitCost]);
}

async function postMovement(client, { partId, locationId, type, qty, unitCost = 0, jobId = null, refNo = null, note = null, userId = null, technician = null, batchNo = null, expiry = null, skipBatch = false }) {
  await client.query("INSERT INTO stock_balance (part_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [partId, locationId]);
  const b = await client.query("SELECT qty_on_hand::float AS q FROM stock_balance WHERE part_id = $1 AND location_id = $2 FOR UPDATE", [partId, locationId]);
  const part = await client.query("SELECT id, stock_qty::float AS total, avg_cost::float AS avg, track_batch FROM spare_part WHERE id = $1 FOR UPDATE", [partId]);
  if (part.rowCount === 0) throw fail(404, "Item not found");
  const onHand = b.rows[0].q;
  if (onHand + qty < 0) throw fail(400, `Not enough stock in this location (on hand ${onHand})`);

  const total = part.rows[0].total;
  let avg = part.rows[0].avg;
  if (qty > 0 && unitCost > 0 && ["GRN", "OPENING"].includes(type)) {   // only real purchases change the average cost
    avg = total <= 0 ? unitCost : Math.round(((total * avg + qty * unitCost) / (total + qty)) * 100) / 100;   // weighted average cost
  }
  const moveCost = qty < 0 ? avg : unitCost || avg;

  await client.query(
    `INSERT INTO stock_movement (part_id, location_id, move_type, qty, unit_cost, job_id, ref_no, note, created_by, technician)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [partId, locationId, type, qty, moveCost, jobId, refNo, note, userId, technician]);
  if (part.rows[0].track_batch && !skipBatch) {      // oil / coolant / brake fluid ... : keep batch + expiry
    if (qty < 0) await consumeBatches(client, partId, locationId, -qty);
    else await addBatch(client, partId, locationId, qty, batchNo || (type === "GRN" ? "NO-BATCH" : type === "RETURN" ? "RETURNED" : "OTHER"), expiry, moveCost);
  }
  await client.query("UPDATE stock_balance SET qty_on_hand = qty_on_hand + $3 WHERE part_id = $1 AND location_id = $2", [partId, locationId, qty]);
  await client.query("UPDATE spare_part SET stock_qty = GREATEST(0, ROUND(stock_qty + $2)::int), avg_cost = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [partId, qty, avg]);
}
router.postMovement = postMovement;
router.helpers = { addBatch, consumeBatches, clean, toInt, toQty, toMoney, currentUserId, isStockManager, fail, STOCK_MANAGER_ROLE_IDS };   // reusable: require("./inventory.routes").postMovement (e.g. issue parts to a job)

/* ===================== lookups ===================== */
router.get("/inventory/lookups", authenticateToken, async (req, res) => {
  try {
    const [cats, locs, units, opts, sups] = await Promise.all([
      pool.query('SELECT id, name, kind FROM inventory_category WHERE is_active ORDER BY sort_order, id'),
      pool.query('SELECT id, name FROM stock_location WHERE is_active ORDER BY id'),
      pool.query("SELECT DISTINCT unit FROM spare_part ORDER BY unit"),
      pool.query("SELECT kind, name FROM spare_part_option WHERE is_active ORDER BY kind, sort_order, id"),
      pool.query("SELECT id, name FROM supplier WHERE is_active ORDER BY name"),
    ]);
    return res.json({
      categories: cats.rows, locations: locs.rows, units: Array.from(new Set([...opts.rows.filter((x) => x.kind === "UNIT").map((x) => x.name), ...(opts.rows.some((x) => x.kind === "UNIT") ? [] : ["Nos", "Litre", "Set", "Kg", "Pair", "Box", ...units.rows.map((x) => x.unit)])])),
      brands: opts.rows.filter((x) => x.kind === "BRAND").map((x) => x.name),
      qualities: opts.rows.filter((x) => x.kind === "QUALITY").map((x) => x.name),
      bins: opts.rows.filter((x) => x.kind === "BIN").map((x) => x.name),
      suppliers: sups.rows,
      canAdjust: await isStockManager(req),
    });
  } catch (e) { console.error("inventory lookups:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /inventory/categories { name, kind }   -> "add more option"
router.post("/inventory/categories", authenticateToken, async (req, res) => {
  const name = clean(req.body?.name), kind = req.body?.kind === "INTERNAL" ? "INTERNAL" : "JOB_ITEM";
  if (!name || name.length > 80) return res.status(400).json({ message: "Enter the category name" });
  try {
    await pool.query(
      `INSERT INTO inventory_category (name, kind, sort_order) VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) FROM inventory_category), 0) + 1)
       ON CONFLICT (name) DO UPDATE SET is_active = true`, [name, kind]);
    return res.status(201).json({ message: "Added" });
  } catch (e) { console.error("add category:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /inventory/locations { name }
router.post("/inventory/locations", authenticateToken, async (req, res) => {
  const name = clean(req.body?.name);
  if (!name || name.length > 80) return res.status(400).json({ message: "Enter the location name" });
  try {
    await pool.query("INSERT INTO stock_location (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET is_active = true", [name]);
    return res.status(201).json({ message: "Added" });
  } catch (e) { console.error("add location:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

/* ===================== items + stock list ===================== */
// GET /inventory/items?q=&categoryId=&low=1&all=1
router.get("/inventory/items", authenticateToken, async (req, res) => {
  try {
    const q = clean(req.query.q), cat = toInt(req.query.categoryId), low = req.query.low === "1", all = req.query.all === "1";
    const r = await pool.query(
      `SELECT p.id, p.part_no AS "partNo", p.name, p.brand, p.quality, p.unit, p.category_id AS "categoryId", c.name AS "categoryName",
              p.price::float AS price, p.avg_cost::float AS "avgCost", p.reorder_level AS "reorderLevel", p.is_active AS "isActive",
              p.oem_no AS "oemNo", p.sku, p.barcode, p.reorder_qty AS "reorderQty", p.bin_location AS "binLocation", p.cost_price::float AS "costPrice", p.track_batch AS "trackBatch", p.description, p.image_url AS "imageUrl", p.supplier_id AS "supplierId", sp.name AS "supplierName",
              COALESCE(SUM(b.qty_on_hand), 0)::float AS "onHand", COALESCE(SUM(b.qty_reserved), 0)::float AS "reserved"
       FROM spare_part p
       LEFT JOIN inventory_category c ON c.id = p.category_id
       LEFT JOIN supplier sp ON sp.id = p.supplier_id
       LEFT JOIN stock_balance b ON b.part_id = p.id
       WHERE ($1::text IS NULL OR p.name ILIKE '%' || $1 || '%' OR p.brand ILIKE '%' || $1 || '%' OR p.part_no ILIKE '%' || $1 || '%'
                OR p.oem_no ILIKE '%' || $1 || '%' OR p.sku ILIKE '%' || $1 || '%' OR p.barcode = $1
                OR EXISTS (SELECT 1 FROM part_alternate a WHERE a.part_id = p.id AND a.alt_part_no ILIKE '%' || $1 || '%'))
         AND ($2::int IS NULL OR p.category_id = $2) AND ($3::boolean OR p.is_active)
       GROUP BY p.id, c.name, sp.name
       HAVING NOT $4::boolean OR COALESCE(SUM(b.qty_on_hand), 0) - COALESCE(SUM(b.qty_reserved), 0) <= p.reorder_level
       ORDER BY p.name, p.id LIMIT 300`, [q, Number.isInteger(cat) ? cat : null, all, low]);
    const rows = r.rows.map((x) => ({ ...x, available: Math.round((x.onHand - x.reserved) * 100) / 100, isLow: x.onHand - x.reserved <= x.reorderLevel }));
    const value = rows.reduce((s, x) => s + x.onHand * x.avgCost, 0);
    return res.json({ items: rows, stockValue: Math.round(value * 100) / 100 });
  } catch (e) { console.error("inventory items:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

const readItem = (b) => {
  const name = clean(b?.name), quality = clean(b?.quality), unit = clean(b?.unit) || "Nos", price = toMoney(b?.price), reorder = toInt(b?.reorderLevel ?? 0), cat = toInt(b?.categoryId);
  if (!name || name.length > 200) return { error: "Enter the item name" };
  if (!Number.isInteger(cat)) return { error: "Select the category" };
  if (Number.isNaN(price)) return { error: "Enter a valid selling price" };
  if (!Number.isInteger(reorder) || reorder < 0) return { error: "Enter a valid reorder level" };
  const reorderQty = toInt(b?.reorderQty ?? 0), cost = toMoney(b?.costPrice ?? 0);
  if (!Number.isInteger(reorderQty) || reorderQty < 0) return { error: "Enter a valid reorder quantity" };
  if (Number.isNaN(cost)) return { error: "Enter a valid cost price" };
  return {
    name, cat, price, reorder, reorderQty, cost, unit: unit.slice(0, 20), quality: (quality || "Standard").slice(0, 60), brand: clean(b?.brand)?.slice(0, 60) || null,
    partNo: clean(b?.partNo)?.slice(0, 60) || null, oemNo: clean(b?.oemNo)?.slice(0, 60) || null, sku: clean(b?.sku)?.slice(0, 60) || null, barcode: clean(b?.barcode)?.slice(0, 60) || null,
    bin: clean(b?.binLocation)?.slice(0, 40) || null, supplierId: Number.isInteger(toInt(b?.supplierId)) ? toInt(b.supplierId) : null, description: clean(b?.description)?.slice(0, 2000) || null, imageUrl: clean(b?.imageUrl)?.slice(0, 500) || null, trackBatch: b?.trackBatch === true || b?.trackBatch === "true", isActive: b?.isActive !== false,
  };
};
// POST /inventory/items   (new items start with 0 stock: receive stock with a GRN)
router.post("/inventory/items", authenticateToken, async (req, res) => {
  const v = readItem(req.body); if (v.error) return res.status(400).json({ message: v.error });
  const b = req.body || {};
  const openQty = clean(b.openingQty) === null ? 0 : toQty(b.openingQty);
  if (Number.isNaN(openQty) || openQty < 0) return res.status(400).json({ message: "Opening quantity is not valid" });
  const openLoc = toInt(b.locationId);
  const expiry = clean(b.expiryDate);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `INSERT INTO spare_part (part_no, name, brand, quality, price, stock_qty, category_id, unit, reorder_level, oem_no, sku, barcode, reorder_qty, bin_location, cost_price, track_batch, description, image_url, supplier_id)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [v.partNo, v.name, v.brand, v.quality, v.price, v.cat, v.unit, v.reorder, v.oemNo, v.sku, v.barcode, v.reorderQty, v.bin, v.cost, v.trackBatch, v.description, v.imageUrl, v.supplierId]);
    const id = r.rows[0].id;
    if (openQty > 0) {
      const loc = Number.isInteger(openLoc) ? openLoc : (await client.query("SELECT id FROM stock_location WHERE is_active ORDER BY id LIMIT 1")).rows[0]?.id;
      if (!loc) throw fail(400, "No stock location found");
      await postMovement(client, { partId: id, locationId: loc, type: "OPENING", qty: openQty, unitCost: v.cost || 0, note: "Opening stock", userId: currentUserId(req), batchNo: clean(b.batchNo)?.slice(0, 60) || "OPENING", expiry });
    }
    await client.query("COMMIT");
    return res.status(201).json({ message: "Added", id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e.expose) return res.status(e.status).json({ message: e.message });
    if (e.code === "23505") return res.status(409).json({ message: "SKU or barcode is already used by another item" });
    console.error("add item:", e.code, e.message); return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});
// PUT /inventory/items/:id  (details only - stock changes go through movements)
router.put("/inventory/items/:id", authenticateToken, async (req, res) => {
  const id = toInt(req.params.id); if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid item" });
  const v = readItem(req.body); if (v.error) return res.status(400).json({ message: v.error });
  try {
    const r = await pool.query(
      `UPDATE spare_part SET part_no = $2, name = $3, brand = $4, quality = $5, price = $6, category_id = $7, unit = $8, reorder_level = $9, is_active = $10,
              oem_no = $11, sku = $12, barcode = $13, reorder_qty = $14, bin_location = $15, cost_price = $16, track_batch = $17, description = $18, image_url = $19, supplier_id = $20, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`, [id, v.partNo, v.name, v.brand, v.quality, v.price, v.cat, v.unit, v.reorder, v.isActive, v.oemNo, v.sku, v.barcode, v.reorderQty, v.bin, v.cost, v.trackBatch, v.description, v.imageUrl, v.supplierId]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Item not found" });
    return res.json({ message: "Saved" });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ message: "SKU or barcode is already used by another item" });
    console.error("update item:", e.code, e.message); return res.status(500).json({ message: "Server error" });
  }
});

/* ===================== stock movements ===================== */
// GET /inventory/items/:id/movements
router.get("/inventory/items/:id/movements", authenticateToken, async (req, res) => {
  const id = toInt(req.params.id); if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid item" });
  try {
    const [m, b] = await Promise.all([
      pool.query(
        `SELECT m.id, m.move_type AS type, m.qty::float AS qty, m.unit_cost::float AS "unitCost", m.ref_no AS "refNo", m.note, m.created_at AS "createdAt",
                l.name AS location, j.job_no AS "jobNo", trim(concat(u.first_name, ' ', u.last_name)) AS "by"
         FROM stock_movement m JOIN stock_location l ON l.id = m.location_id LEFT JOIN job j ON j.id = m.job_id LEFT JOIN admin_user u ON u.id = m.created_by
         WHERE m.part_id = $1 ORDER BY m.id DESC LIMIT 200`, [id]),
      pool.query(`SELECT l.name AS location, b.qty_on_hand::float AS "onHand", b.qty_reserved::float AS reserved
                  FROM stock_balance b JOIN stock_location l ON l.id = b.location_id WHERE b.part_id = $1 ORDER BY l.id`, [id]),
    ]);
    return res.json({ movements: m.rows, balances: b.rows });
  } catch (e) { console.error("movements:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /inventory/movements { partId, locationId, type: GRN|ISSUE|RETURN|ADJUST|SCRAP, qty, unitCost?, refNo?, note?, jobId? }
// GRN/RETURN = qty is a positive amount IN.  ISSUE/SCRAP = positive amount OUT.  ADJUST = signed (+/-), manager only.
router.post("/inventory/movements", authenticateToken, async (req, res) => {
  const b = req.body || {};
  const type = String(b.type || "").toUpperCase();
  const partId = toInt(b.partId), locationId = toInt(b.locationId), amount = toQty(b.qty), cost = toMoney(b.unitCost ?? 0);
  if (["ADJUST", "SCRAP"].includes(type)) return res.status(400).json({ message: "Adjustments need approval: use Stock Control > Adjustments" });
  if (!["GRN", "ISSUE", "RETURN"].includes(type)) return res.status(400).json({ message: "Invalid movement type" });
  if (!Number.isInteger(partId) || !Number.isInteger(locationId)) return res.status(400).json({ message: "Select the item and the location" });
  if (Number.isNaN(amount) || amount === 0 || (type !== "ADJUST" && amount < 0)) return res.status(400).json({ message: "Enter a valid quantity" });
  if (Number.isNaN(cost)) return res.status(400).json({ message: "Enter a valid cost" });
  const note = clean(b.note)?.slice(0, 300) || null;
  if (["ADJUST", "SCRAP"].includes(type)) {
    if (!(await isStockManager(req))) return res.status(403).json({ message: "Only a stock manager can adjust or scrap stock" });
    if (!note) return res.status(400).json({ message: "Enter the reason" });
  }
  if (type === "GRN" && cost <= 0) return res.status(400).json({ message: "Enter the unit cost" });
  const signed = ["ISSUE", "SCRAP"].includes(type) ? -amount : amount;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await postMovement(client, {
      partId, locationId, type, qty: signed, unitCost: cost, jobId: toInt(b.jobId) || null, refNo: clean(b.refNo)?.slice(0, 60) || null, note, userId: currentUserId(req),
      technician: clean(b.technician)?.slice(0, 80) || null, batchNo: clean(b.batchNo)?.slice(0, 60) || null, expiry: clean(b.expiryDate) || null,
    });
    await client.query("COMMIT");
    return res.status(201).json({ message: "Stock updated" });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    if (e.expose) return res.status(e.status).json({ message: e.message });
    console.error("post movement:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

/* ===================== dashboard (Inventory & Spare Parts) ===================== */
// GET /inventory/dashboard  -> KPI numbers + low stock + stock value by category + recent movements
router.get("/inventory/dashboard", authenticateToken, async (req, res) => {
  try {
    const [kpi, low, cats, moves] = await Promise.all([
      pool.query(`
        WITH s AS (
          SELECT p.id, p.avg_cost, p.reorder_level,
                 COALESCE(SUM(b.qty_on_hand), 0) AS oh, COALESCE(SUM(b.qty_reserved), 0) AS rs
          FROM spare_part p LEFT JOIN stock_balance b ON b.part_id = p.id WHERE p.is_active GROUP BY p.id)
        SELECT COUNT(*)::int AS items,
               COALESCE(SUM(oh * avg_cost), 0)::float AS "stockValue",
               COUNT(*) FILTER (WHERE oh - rs <= 0)::int AS "outOfStock",
               COUNT(*) FILTER (WHERE oh - rs > 0 AND oh - rs <= reorder_level)::int AS "lowStock"
        FROM s`),
      pool.query(`
        SELECT p.id, p.name, p.part_no AS "partNo", p.unit, p.reorder_level AS "reorderLevel", c.name AS "categoryName",
               (COALESCE(SUM(b.qty_on_hand), 0) - COALESCE(SUM(b.qty_reserved), 0))::float AS available
        FROM spare_part p LEFT JOIN inventory_category c ON c.id = p.category_id LEFT JOIN stock_balance b ON b.part_id = p.id
        WHERE p.is_active GROUP BY p.id, c.name
        HAVING COALESCE(SUM(b.qty_on_hand), 0) - COALESCE(SUM(b.qty_reserved), 0) <= p.reorder_level
        ORDER BY 7 ASC, p.name LIMIT 10`),
      pool.query(`
        SELECT COALESCE(c.name, 'Uncategorised') AS name, COUNT(DISTINCT p.id)::int AS items,
               COALESCE(SUM(b.qty_on_hand * p.avg_cost), 0)::float AS value
        FROM spare_part p LEFT JOIN inventory_category c ON c.id = p.category_id LEFT JOIN stock_balance b ON b.part_id = p.id
        WHERE p.is_active GROUP BY c.name ORDER BY value DESC`),
      pool.query(`
        SELECT m.id, m.move_type AS type, m.qty::float AS qty, m.created_at AS "createdAt", p.name AS item, j.job_no AS "jobNo"
        FROM stock_movement m JOIN spare_part p ON p.id = m.part_id LEFT JOIN job j ON j.id = m.job_id
        ORDER BY m.id DESC LIMIT 8`),
    ]);
    const orders = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE completed_at IS NULL AND NOT no_parts_needed)::int AS "openOrders",
             COUNT(*) FILTER (WHERE completed_at IS NULL AND link_sent_at IS NOT NULL AND logistics_updated_at IS NULL)::int AS "waitingLogistics"
      FROM job_spare_parts`);
    const quotes = await pool.query("SELECT COUNT(*) FILTER (WHERE status <> 'QUOTED')::int AS \"pendingQuotes\" FROM job_spare_quote");
    const adj = await pool.query("SELECT COUNT(*)::int AS \"pendingAdjustments\" FROM stock_adjustment WHERE status = 'PENDING'");
    const exp = await pool.query("SELECT COUNT(DISTINCT part_id)::int AS \"expiringBatches\" FROM stock_batch WHERE qty_on_hand > 0 AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + 30");
    return res.json({ ...kpi.rows[0], ...orders.rows[0], ...quotes.rows[0], ...adj.rows[0], ...exp.rows[0], lowItems: low.rows, categories: cats.rows, recent: moves.rows });
  } catch (e) { console.error("inventory dashboard:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// GET /inventory/spare-orders?status=open|waiting|done|all   -> spare part requirement lists of all jobs
router.get("/inventory/spare-orders", authenticateToken, async (req, res) => {
  const status = ["open", "waiting", "done", "all"].includes(req.query.status) ? req.query.status : "open";
  try {
    const r = await pool.query(
      `SELECT j.id AS "jobId", j.job_no AS "jobNo", j.reg_no AS "regNo", d.name AS department, c.customer_name AS "customerName",
              sp.no_parts_needed AS "noParts", sp.link_sent_at AS "linkSentAt", sp.logistics_updated_at AS "logisticsUpdatedAt", sp.completed_at AS "completedAt",
              COALESCE(it.lines, '[]'::json) AS lines,
              COALESCE(it.total, 0)::float AS total, COALESCE(it.issued_value, 0)::float AS "issuedValue",
              (SELECT COUNT(*) FROM job_spare_quote q WHERE q.job_id = j.id AND q.status <> 'QUOTED')::int AS "pendingQuotes"
       FROM job_spare_parts sp
       JOIN job j ON j.id = sp.job_id JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('id', id, 'partId', part_id, 'name', name, 'brand', brand, 'quality', quality, 'qty', qty, 'unitPrice', unit_price::float,
                                          'stockStatus', stock_status, 'reserved', reserved_qty::float, 'issued', issued_qty::float, 'returned', returned_qty::float,
                                          'available', COALESCE((SELECT SUM(b.qty_on_hand - b.qty_reserved) FROM stock_balance b WHERE b.part_id = job_spare_part.part_id), 0)::float) ORDER BY id) AS lines,
                SUM(qty * unit_price) AS total,
                SUM((issued_qty - returned_qty) * unit_price) AS issued_value
         FROM job_spare_part WHERE job_id = j.id) it ON true
       WHERE ($1 = 'all')
          OR ($1 = 'open' AND sp.completed_at IS NULL)
          OR ($1 = 'waiting' AND sp.completed_at IS NULL AND sp.link_sent_at IS NOT NULL AND sp.logistics_updated_at IS NULL)
          OR ($1 = 'done' AND sp.completed_at IS NOT NULL)
       ORDER BY sp.updated_at DESC LIMIT 200`, [status]);
    return res.json(r.rows);
  } catch (e) { console.error("spare orders:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// GET /inventory/quotes?status=pending|all   -> third-party quotation requests of all jobs
router.get("/inventory/quotes", authenticateToken, async (req, res) => {
  const pending = req.query.status !== "all";
  try {
    const r = await pool.query(
      `SELECT q.id, q.job_id AS "jobId", j.job_no AS "jobNo", j.reg_no AS "regNo", q.photo_url AS "photoUrl", q.description, q.status,
              q.quoted_price::float AS "quotedPrice", q.quoted_note AS "quotedNote", q.quoted_at AS "quotedAt", q.created_at AS "createdAt"
       FROM job_spare_quote q JOIN job j ON j.id = q.job_id
       WHERE ($1::boolean = false OR q.status <> 'QUOTED') ORDER BY q.id DESC LIMIT 200`, [pending]);
    return res.json(r.rows);
  } catch (e) { console.error("quotes list:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});
// PUT /inventory/quotes/:id { price, note }
router.put("/inventory/quotes/:id", authenticateToken, async (req, res) => {
  const id = toInt(req.params.id), price = toMoney(req.body?.price);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid quotation" });
  if (Number.isNaN(price) || price <= 0) return res.status(400).json({ message: "Enter a valid price" });
  try {
    const r = await pool.query("UPDATE job_spare_quote SET quoted_price = $2, quoted_note = $3, quoted_at = CURRENT_TIMESTAMP, status = 'QUOTED' WHERE id = $1", [id, price, clean(req.body?.note)?.slice(0, 300) || null]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Quotation not found" });
    await pool.query("UPDATE job_spare_parts SET logistics_updated_at = CURRENT_TIMESTAMP WHERE job_id = (SELECT job_id FROM job_spare_quote WHERE id = $1)", [id]);
    return res.json({ message: "Saved" });
  } catch (e) { console.error("quote price:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// GET /inventory/movements?type=&q=   -> the whole stock ledger
router.get("/inventory/movements", authenticateToken, async (req, res) => {
  const type = ["OPENING", "GRN", "ISSUE", "RETURN", "ADJUST", "SCRAP", "TRANSFER_OUT", "TRANSFER_IN", "SUPPLIER_RETURN"].includes(req.query.type) ? req.query.type : null, q = clean(req.query.q);
  try {
    const r = await pool.query(
      `SELECT m.id, m.move_type AS type, m.qty::float AS qty, m.unit_cost::float AS "unitCost", m.ref_no AS "refNo", m.note, m.created_at AS "createdAt",
              p.name AS item, p.unit, l.name AS location, j.job_no AS "jobNo", m.technician, trim(concat(u.first_name, ' ', u.last_name)) AS "by"
       FROM stock_movement m JOIN spare_part p ON p.id = m.part_id JOIN stock_location l ON l.id = m.location_id
       LEFT JOIN job j ON j.id = m.job_id LEFT JOIN admin_user u ON u.id = m.created_by
       WHERE ($1::text IS NULL OR m.move_type = $1) AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR m.ref_no ILIKE '%' || $2 || '%' OR j.job_no ILIKE '%' || $2 || '%')
       ORDER BY m.id DESC LIMIT 300`, [type, q]);
    return res.json(r.rows);
  } catch (e) { console.error("ledger:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

/* ===================== job card <-> stock : reserve / release / issue / return ===================== */
// POST /inventory/jobs/:jobId/parts/:lineId/:action     action = reserve | release | issue | return
// body { qty?, locationId?, note? }
//   reserve : hold stock for the job (nobody else can take it)           qty default = still needed
//   release : give a reservation back                                    qty default = all reserved
//   issue   : technician takes the part (uses the reservation first)     qty default = reserved, else still needed
//   return  : unused part comes back to stock                            qty default = issued - returned
router.post("/inventory/jobs/:jobId/parts/:lineId/:action", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.jobId), lineId = toInt(req.params.lineId), action = req.params.action;
  if (!Number.isInteger(jobId) || !Number.isInteger(lineId) || !["reserve", "release", "issue", "return"].includes(action)) return res.status(400).json({ message: "Invalid request" });
  const b = req.body || {};
  const wantQty = clean(b.qty) === null ? null : toQty(b.qty);
  if (wantQty !== null && (Number.isNaN(wantQty) || wantQty <= 0)) return res.status(400).json({ message: "Enter a valid quantity" });
  const note = clean(b.note)?.slice(0, 300) || null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const l = await client.query(
      `SELECT l.id, l.part_id AS "partId", l.qty::float AS qty, l.reserved_qty::float AS reserved, l.issued_qty::float AS issued, l.returned_qty::float AS returned,
              l.reserve_location_id AS "reserveLoc", l.issue_location_id AS "issueLoc", j.job_no AS "jobNo"
       FROM job_spare_part l JOIN job j ON j.id = l.job_id WHERE l.id = $1 AND l.job_id = $2 FOR UPDATE OF l`, [lineId, jobId]);
    if (l.rowCount === 0) throw fail(404, "Spare part line not found");
    const line = l.rows[0];
    if (!line.partId) throw fail(400, "This line is not linked to an inventory item (manual price). Stock cannot be moved.");
    const netIssued = line.issued - line.returned;
    const needed = Math.max(0, line.qty - netIssued - line.reserved);   // still to reserve / issue
    const defaultLoc = (await client.query("SELECT id FROM stock_location WHERE is_active ORDER BY id LIMIT 1")).rows[0]?.id;
    const bal = async (loc) => {
      await client.query("INSERT INTO stock_balance (part_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [line.partId, loc]);
      return (await client.query("SELECT qty_on_hand::float AS oh, qty_reserved::float AS rs FROM stock_balance WHERE part_id = $1 AND location_id = $2 FOR UPDATE", [line.partId, loc])).rows[0];
    };
    const userId = currentUserId(req);

    if (action === "reserve") {
      const loc = line.reserved > 0 ? line.reserveLoc : toInt(b.locationId) || defaultLoc;
      if (line.reserved > 0 && toInt(b.locationId) && toInt(b.locationId) !== line.reserveLoc) throw fail(400, "Release the current reservation before using another location");
      const qty = wantQty ?? needed;
      if (qty <= 0 || qty > needed) throw fail(400, `You can reserve up to ${needed} more`);
      const x = await bal(loc);
      if (x.oh - x.rs < qty) throw fail(400, `Only ${Math.max(0, x.oh - x.rs)} available in this location`);
      await client.query("UPDATE stock_balance SET qty_reserved = qty_reserved + $3 WHERE part_id = $1 AND location_id = $2", [line.partId, loc, qty]);
      await client.query("UPDATE job_spare_part SET reserved_qty = reserved_qty + $2, reserve_location_id = $3, stock_status = 'IN_STOCK', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [lineId, qty, loc]);
    } else if (action === "release") {
      if (line.reserved <= 0) throw fail(400, "Nothing is reserved");
      const qty = wantQty ?? line.reserved;
      if (qty > line.reserved) throw fail(400, `Only ${line.reserved} is reserved`);
      await bal(line.reserveLoc);
      await client.query("UPDATE stock_balance SET qty_reserved = GREATEST(0, qty_reserved - $3) WHERE part_id = $1 AND location_id = $2", [line.partId, line.reserveLoc, qty]);
      await client.query("UPDATE job_spare_part SET reserved_qty = reserved_qty - $2, reserve_location_id = CASE WHEN reserved_qty - $2 <= 0 THEN NULL ELSE reserve_location_id END, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [lineId, qty]);
    } else if (action === "issue") {
      const remaining = Math.max(0, line.qty - netIssued);
      const qty = wantQty ?? (line.reserved > 0 ? line.reserved : remaining);
      if (qty <= 0 || qty > remaining) throw fail(400, `You can issue up to ${remaining} more`);
      const loc = line.reserved > 0 ? line.reserveLoc : toInt(b.locationId) || defaultLoc;
      const x = await bal(loc);
      const fromReserved = line.reserved > 0 ? Math.min(line.reserved, qty) : 0;
      const extra = qty - fromReserved;
      if (extra > 0 && x.oh - x.rs < extra) throw fail(400, `Only ${Math.max(0, x.oh - x.rs)} more available in this location`);
      if (fromReserved > 0) {
        await client.query("UPDATE stock_balance SET qty_reserved = GREATEST(0, qty_reserved - $3) WHERE part_id = $1 AND location_id = $2", [line.partId, loc, fromReserved]);
      }
      await postMovement(client, { partId: line.partId, locationId: loc, type: "ISSUE", qty: -qty, jobId, refNo: line.jobNo, note, userId, technician: clean(b.technician)?.slice(0, 80) || null });
      await client.query(
        `UPDATE job_spare_part SET issued_qty = issued_qty + $2, reserved_qty = reserved_qty - $3, issue_location_id = $4,
                reserve_location_id = CASE WHEN reserved_qty - $3 <= 0 THEN NULL ELSE reserve_location_id END, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [lineId, qty, fromReserved, loc]);
    } else {
      if (netIssued <= 0) throw fail(400, "Nothing to return");
      const qty = wantQty ?? netIssued;
      if (qty > netIssued) throw fail(400, `Only ${netIssued} can be returned`);
      const loc = toInt(b.locationId) || line.issueLoc || defaultLoc;
      await postMovement(client, { partId: line.partId, locationId: loc, type: "RETURN", qty, jobId, refNo: line.jobNo, note, userId });
      await client.query("UPDATE job_spare_part SET returned_qty = returned_qty + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [lineId, qty]);
    }
    await client.query("COMMIT");
    return res.json({ message: "Done" });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    if (e.expose) return res.status(e.status).json({ message: e.message });
    console.error("job part action:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

module.exports = router;