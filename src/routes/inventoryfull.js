// routes/inventory_full.routes.js   (NEW file)
// Item master extras (vehicle fit, alternate part numbers), purchasing (suppliers, PO, GRN, supplier invoice, supplier returns),
// stock control (adjustment approval, stock take, transfers, batch & expiry), job-card invoice parts and the reports.
// Mount AFTER inventory.routes (same prefix):
//     app.use("/evidence", require("./routes/inventory.routes"));
//     app.use("/evidence", require("./routes/inventory_full.routes"));
// Run create_inventory_full.sql first.
const express = require("express");
const router = express.Router();
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");
const base = require("./Inventory");
const { postMovement } = base;
const { addBatch, consumeBatches, clean, toInt, toQty, toMoney, currentUserId, isStockManager, fail } = base.helpers;

 


// true  = the same person may request AND approve an adjustment (fine for a small team / one admin)
// false = a different person must approve (recommended once you have a stock manager)
const ALLOW_SELF_APPROVAL = true;

const toDate = (v) => (clean(v) && /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? String(v).trim() : null);
const userName = async (db, id) => (id ? (await db.query("SELECT trim(concat(first_name, ' ', last_name)) AS n FROM admin_user WHERE id = $1", [id])).rows[0]?.n || "" : "");

// run a handler inside one transaction; the handler returns the JSON body
function tx(label, handler, okStatus = 200) {
  return async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const body = await handler(req, client);
      await client.query("COMMIT");
      return res.status(okStatus).json(body ?? { message: "Done" });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
      if (e.expose) return res.status(e.status).json({ message: e.message });
      if (e.code === "23505") return res.status(409).json({ message: "This value already exists" });
      console.error(`${label}:`, e.code, e.message);
      return res.status(500).json({ message: "Server error" });
    } finally { client.release(); }
  };
}
function get(label, handler) {
  return async (req, res) => {
    try { return res.json(await handler(req)); } catch (e) {
      if (e.expose) return res.status(e.status).json({ message: e.message });
      console.error(`${label}:`, e.code, e.message); return res.status(500).json({ message: "Server error" });
    }
  };
}
const mustManager = async (req) => { if (!(await isStockManager(req))) throw fail(403, "Only a stock manager can do this"); };

/* ===================== ITEM MASTER: vehicle fit + alternate part numbers ===================== */
router.get("/inventory/items/:id/details", authenticateToken, get("item details", async (req) => {
  const id = toInt(req.params.id); if (!Number.isInteger(id)) throw fail(400, "Invalid item");
  const [fit, alt, bat] = await Promise.all([
    pool.query('SELECT id, make, model, year_from AS "yearFrom", year_to AS "yearTo", note FROM part_vehicle_fit WHERE part_id = $1 ORDER BY make, model, year_from', [id]),
    pool.query('SELECT id, alt_part_no AS "altPartNo", brand, kind, note FROM part_alternate WHERE part_id = $1 ORDER BY id', [id]),
    pool.query(`SELECT b.id, b.batch_no AS "batchNo", b.expiry_date AS "expiryDate", b.qty_on_hand::float AS qty, l.name AS location
                FROM stock_batch b JOIN stock_location l ON l.id = b.location_id WHERE b.part_id = $1 AND b.qty_on_hand > 0 ORDER BY b.expiry_date NULLS LAST`, [id]),
  ]);
  return { fitments: fit.rows, alternates: alt.rows, batches: bat.rows };
}));
router.post("/inventory/items/:id/fitments", authenticateToken, tx("add fitment", async (req, c) => {
  const id = toInt(req.params.id), b = req.body || {}, make = clean(b.make), model = clean(b.model);
  const yf = clean(b.yearFrom) === null ? null : toInt(b.yearFrom), yt = clean(b.yearTo) === null ? null : toInt(b.yearTo);
  if (!Number.isInteger(id) || !make || !model) throw fail(400, "Enter the vehicle make and model");
  if ((yf !== null && !(yf >= 1950 && yf <= 2100)) || (yt !== null && !(yt >= 1950 && yt <= 2100)) || (yf !== null && yt !== null && yf > yt)) throw fail(400, "Check the year range");
  await c.query("INSERT INTO part_vehicle_fit (part_id, make, model, year_from, year_to, note) VALUES ($1, $2, $3, $4, $5, $6)", [id, make.slice(0, 60), model.slice(0, 60), yf, yt, clean(b.note)?.slice(0, 200) || null]);
  return { message: "Added" };
}, 201));
router.delete("/inventory/fitments/:fid", authenticateToken, tx("remove fitment", async (req, c) => {
  await c.query("DELETE FROM part_vehicle_fit WHERE id = $1", [toInt(req.params.fid)]); return { message: "Removed" };
}));
router.post("/inventory/items/:id/alternates", authenticateToken, tx("add alternate", async (req, c) => {
  const id = toInt(req.params.id), b = req.body || {}, no = clean(b.altPartNo), kind = b.kind === "SUPERSEDED" ? "SUPERSEDED" : "ALTERNATE";
  if (!Number.isInteger(id) || !no) throw fail(400, "Enter the part number");
  await c.query("INSERT INTO part_alternate (part_id, alt_part_no, brand, kind, note) VALUES ($1, $2, $3, $4, $5)", [id, no.slice(0, 60), clean(b.brand)?.slice(0, 60) || null, kind, clean(b.note)?.slice(0, 200) || null]);
  return { message: "Added" };
}, 201));
router.delete("/inventory/alternates/:aid", authenticateToken, tx("remove alternate", async (req, c) => {
  await c.query("DELETE FROM part_alternate WHERE id = $1", [toInt(req.params.aid)]); return { message: "Removed" };
}));

// GET /inventory/fit-finder?make=&model=&year=   -> parts that fit a vehicle (with stock)
router.get("/inventory/fit-finder", authenticateToken, get("fit finder", async (req) => {
  const make = clean(req.query.make), model = clean(req.query.model), year = clean(req.query.year) === null ? null : toInt(req.query.year);
  const r = await pool.query(
    `SELECT p.id, p.name, p.part_no AS "partNo", p.oem_no AS "oemNo", p.brand, p.quality, p.unit, p.price::float AS price, p.bin_location AS "binLocation", c.name AS "categoryName",
            f.make, f.model, f.year_from AS "yearFrom", f.year_to AS "yearTo",
            COALESCE((SELECT SUM(b.qty_on_hand - b.qty_reserved) FROM stock_balance b WHERE b.part_id = p.id), 0)::float AS available
     FROM part_vehicle_fit f JOIN spare_part p ON p.id = f.part_id AND p.is_active LEFT JOIN inventory_category c ON c.id = p.category_id
     WHERE ($1::text IS NULL OR f.make ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR f.model ILIKE '%' || $2 || '%')
       AND ($3::int IS NULL OR ((f.year_from IS NULL OR f.year_from <= $3) AND (f.year_to IS NULL OR f.year_to >= $3)))
     ORDER BY f.make, f.model, p.name LIMIT 300`, [make, model, Number.isInteger(year) ? year : null]);
  return r.rows;
}));

/* ===================== ITEM MASTER: categories (manage window) ===================== */
router.get("/inventory/categories", authenticateToken, get("list categories", async () => {
  const r = await pool.query(
    `SELECT c.id, c.name, c.kind, c.is_active AS "isActive", (SELECT COUNT(*) FROM spare_part p WHERE p.category_id = c.id)::int AS "itemCount"
     FROM inventory_category c ORDER BY c.is_active DESC, c.sort_order, c.id`);
  return r.rows;
}));
router.post("/inventory/categories", authenticateToken, tx("add category", async (req, c) => {
  const name = clean(req.body?.name);
  if (!name || name.length > 80) throw fail(400, "Enter the category name");
  await c.query(
    `INSERT INTO inventory_category (name, kind, sort_order) VALUES ($1, 'JOB_ITEM', COALESCE((SELECT MAX(sort_order) FROM inventory_category), 0) + 1)
     ON CONFLICT (name) DO UPDATE SET is_active = true`, [name]);
  return { message: "Added" };
}, 201));
router.put("/inventory/categories/:id", authenticateToken, tx("update category", async (req, c) => {
  const id = toInt(req.params.id); if (!Number.isInteger(id)) throw fail(400, "Invalid category");
  const name = clean(req.body?.name);
  if (!name || name.length > 80) throw fail(400, "Enter the category name");
  const r = await c.query("UPDATE inventory_category SET name = $2, is_active = $3 WHERE id = $1", [id, name, req.body?.isActive !== false]);
  if (r.rowCount === 0) throw fail(404, "Category not found");
  return { message: "Saved" };
}));

/* ===================== ITEM MASTER: option lists (Unit of measure / Quality / Brand) ===================== */
const OPTION_COLUMN = { UNIT: "unit", QUALITY: "quality", BRAND: "brand", BIN: "bin_location" };
const optionKind = (v) => { const k = String(v || "").toUpperCase(); if (!OPTION_COLUMN[k]) throw fail(400, "Unknown list"); return k; };
router.get("/inventory/options", authenticateToken, get("list options", async (req) => {
  const kind = optionKind(req.query.kind), col = OPTION_COLUMN[kind];
  const r = await pool.query(
    `SELECT o.id, o.name, o.is_active AS "isActive", (SELECT COUNT(*) FROM spare_part p WHERE p.${col} = o.name)::int AS "itemCount"
     FROM spare_part_option o WHERE o.kind = $1 ORDER BY o.is_active DESC, o.sort_order, o.name`, [kind]);
  return r.rows;
}));
router.post("/inventory/options", authenticateToken, tx("add option", async (req, c) => {
  const kind = optionKind(req.body?.kind), name = clean(req.body?.name);
  if (!name || name.length > 60) throw fail(400, "Enter a name");
  const ok = await c.query("SELECT 1 FROM pg_constraint WHERE conname = 'chk_spare_part_option_kind' AND pg_get_constraintdef(oid) LIKE '%BIN%'");
  if (ok.rowCount === 0) throw fail(500, "Run add_bin_list.sql in the database first (Bin / rack list is not enabled yet)");
  await c.query(
    `INSERT INTO spare_part_option (kind, name, sort_order) VALUES ($1::varchar, $2::varchar, COALESCE((SELECT MAX(sort_order) FROM spare_part_option WHERE kind = $1::varchar), 0) + 1)
     ON CONFLICT (kind, name) DO UPDATE SET is_active = true`, [kind, name]);
  return { message: "Added" };
}, 201));
router.put("/inventory/options/:id", authenticateToken, tx("update option", async (req, c) => {
  const id = toInt(req.params.id); if (!Number.isInteger(id)) throw fail(400, "Invalid option");
  const name = clean(req.body?.name);
  if (!name || name.length > 60) throw fail(400, "Enter a name");
  const cur = (await c.query("SELECT kind, name FROM spare_part_option WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!cur) throw fail(404, "Not found");
  const dup = await c.query("SELECT 1 FROM spare_part_option WHERE kind = $1 AND name = $2 AND id <> $3", [cur.kind, name, id]);
  if (dup.rowCount > 0) throw fail(409, "This name already exists");
  await c.query("UPDATE spare_part_option SET name = $2, is_active = $3 WHERE id = $1", [id, name, req.body?.isActive !== false]);
  if (name !== cur.name) await c.query(`UPDATE spare_part SET ${OPTION_COLUMN[cur.kind]} = $2 WHERE ${OPTION_COLUMN[cur.kind]} = $1`, [cur.name, name]);   // renaming also renames it on existing items
  return { message: "Saved" };
}));

/* ===================== PURCHASING: suppliers ===================== */
router.get("/inventory/suppliers", authenticateToken, get("suppliers", async (req) => {
  const r = await pool.query(
    `SELECT s.id, s.name, s.contact_person AS "contactPerson", s.phone, s.whatsapp, s.email, s.address, s.payment_terms AS "paymentTerms", s.is_active AS "isActive",
            (SELECT COUNT(*) FROM purchase_order po WHERE po.supplier_id = s.id AND po.status IN ('ORDERED', 'PARTIAL'))::int AS "openPo"
     FROM supplier s WHERE ($1::boolean OR s.is_active) ORDER BY s.name`, [req.query.all === "1"]);
  return r.rows;
}));
const readSupplier = (b) => {
  const name = clean(b?.name);
  if (!name || name.length > 120) throw fail(400, "Enter the supplier name");
  return [name, clean(b.contactPerson)?.slice(0, 80) || null, clean(b.phone)?.slice(0, 30) || null, clean(b.email)?.slice(0, 120) || null, clean(b.address), clean(b.paymentTerms)?.slice(0, 60) || null, clean(b.whatsapp)?.slice(0, 30) || null];
};
router.post("/inventory/suppliers", authenticateToken, tx("add supplier", async (req, c) => {
  await c.query("INSERT INTO supplier (name, contact_person, phone, email, address, payment_terms, whatsapp) VALUES ($1, $2, $3, $4, $5, $6, $7)", readSupplier(req.body));
  return { message: "Added" };
}, 201));
router.put("/inventory/suppliers/:id", authenticateToken, tx("update supplier", async (req, c) => {
  const id = toInt(req.params.id); if (!Number.isInteger(id)) throw fail(400, "Invalid supplier");
  const r = await c.query("UPDATE supplier SET name = $2, contact_person = $3, phone = $4, email = $5, address = $6, payment_terms = $7, whatsapp = $8, is_active = $9 WHERE id = $1", [id, ...readSupplier(req.body), req.body?.isActive !== false]);
  if (r.rowCount === 0) throw fail(404, "Supplier not found");
  return { message: "Saved" };
}));

/* ===================== PURCHASING: purchase orders ===================== */
router.get("/inventory/purchase-orders", authenticateToken, get("po list", async (req) => {
  const st = ["DRAFT", "ORDERED", "PARTIAL", "RECEIVED", "CANCELLED"].includes(req.query.status) ? req.query.status : req.query.status === "open" ? "open" : null;
  const r = await pool.query(
    `SELECT po.id, po.po_no AS "poNo", po.status, po.order_date AS "orderDate", po.expected_date AS "expectedDate", po.note, po.created_at AS "createdAt",
            s.id AS "supplierId", s.name AS supplier, po.created_by AS "createdById",
            (SELECT trim(concat(u.first_name, ' ', u.last_name)) FROM admin_user u WHERE u.id = po.created_by) AS "createdBy",
            COALESCE((SELECT SUM(qty_ordered * unit_cost) FROM purchase_order_line WHERE po_id = po.id), 0)::float AS total,
            COALESCE((SELECT SUM(qty_ordered) FROM purchase_order_line WHERE po_id = po.id), 0)::float AS ordered,
            COALESCE((SELECT SUM(qty_received) FROM purchase_order_line WHERE po_id = po.id), 0)::float AS received
     FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id
     WHERE ($1::text IS NULL OR ($1 = 'open' AND po.status IN ('DRAFT', 'ORDERED', 'PARTIAL')) OR po.status = $1)
     ORDER BY po.id DESC LIMIT 200`, [st]);
  return r.rows;
}));
router.get("/inventory/purchase-orders/:id", authenticateToken, get("po detail", async (req) => {
  const id = toInt(req.params.id); if (!Number.isInteger(id)) throw fail(400, "Invalid purchase order");
  const h = await pool.query(`SELECT po.id, po.po_no AS "poNo", po.status, po.order_date AS "orderDate", po.expected_date AS "expectedDate", po.note, po.created_at AS "createdAt", s.id AS "supplierId", s.name AS supplier,
                                     s.contact_person AS "supplierContact", s.phone AS "supplierPhone", s.whatsapp AS "supplierWhatsapp", s.email AS "supplierEmail", s.address AS "supplierAddress", s.payment_terms AS "paymentTerms",
                                     (SELECT trim(concat(u.first_name, ' ', u.last_name)) FROM admin_user u WHERE u.id = po.created_by) AS "createdBy"
                              FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id WHERE po.id = $1`, [id]);
  if (h.rowCount === 0) throw fail(404, "Purchase order not found");
  const [lines, grns] = await Promise.all([
    pool.query(`SELECT l.id, l.part_id AS "partId", p.name, p.part_no AS "partNo", p.brand, p.unit, p.track_batch AS "trackBatch", l.qty_ordered::float AS "qtyOrdered", l.qty_received::float AS "qtyReceived", l.unit_cost::float AS "unitCost"
                FROM purchase_order_line l JOIN spare_part p ON p.id = l.part_id WHERE l.po_id = $1 ORDER BY l.id`, [id]),
    pool.query('SELECT id, grn_no AS "grnNo", supplier_invoice_no AS "invoiceNo", created_at AS "createdAt" FROM goods_receipt WHERE po_id = $1 ORDER BY id', [id]),
  ]);
  return { ...h.rows[0], lines: lines.rows, grns: grns.rows };
}));
router.post("/inventory/purchase-orders", authenticateToken, tx("create po", async (req, c) => {
  const b = req.body || {}, supplierId = toInt(b.supplierId);
  if (!Number.isInteger(supplierId)) throw fail(400, "Select the supplier");
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (lines.length === 0) throw fail(400, "Add at least one item");
  const status = b.status === "ORDERED" ? "ORDERED" : "DRAFT";
  const po = await c.query(
    "INSERT INTO purchase_order (supplier_id, status, order_date, expected_date, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, po_no AS \"poNo\"",
    [supplierId, status, status === "ORDERED" ? new Date().toISOString().slice(0, 10) : null, toDate(b.expectedDate), clean(b.note)?.slice(0, 300) || null, currentUserId(req)]);
  for (const l of lines) {
    const partId = toInt(l.partId), qty = toQty(l.qty), cost = toMoney(l.unitCost);
    if (!Number.isInteger(partId) || !(qty > 0) || Number.isNaN(cost)) throw fail(400, "Check the item quantities and costs");
    await c.query("INSERT INTO purchase_order_line (po_id, part_id, qty_ordered, unit_cost) VALUES ($1, $2, $3, $4)", [po.rows[0].id, partId, qty, cost]);
  }
  return { message: "Purchase order created", id: po.rows[0].id, poNo: po.rows[0].poNo };
}, 201));
router.put("/inventory/purchase-orders/:id/status", authenticateToken, tx("po status", async (req, c) => {
  const id = toInt(req.params.id), to = req.body?.status;
  const cur = await c.query("SELECT status, (SELECT COALESCE(SUM(qty_received), 0) FROM purchase_order_line WHERE po_id = $1)::float AS rec FROM purchase_order WHERE id = $1 FOR UPDATE", [id]);
  if (cur.rowCount === 0) throw fail(404, "Purchase order not found");
  const { status, rec } = cur.rows[0];
  if (to === "ORDERED") { if (status !== "DRAFT") throw fail(400, "Only a draft can be sent to the supplier"); await c.query("UPDATE purchase_order SET status = 'ORDERED', order_date = CURRENT_DATE WHERE id = $1", [id]); }
  else if (to === "CANCELLED") {
    if (!["DRAFT", "ORDERED"].includes(status) || rec > 0) throw fail(400, "A purchase order with received goods cannot be cancelled");
    await c.query("UPDATE purchase_order SET status = 'CANCELLED' WHERE id = $1", [id]);
  } else throw fail(400, "Invalid status");
  return { message: "Updated" };
}));

// create a GRN (goods received note): with a PO (poLineId on each line) or direct (partId on each line)
async function createGrn(c, { poId, supplierId, locationId, invoiceNo, invoiceDate, invoiceAmount, note, userId, lines }) {
  if (!Number.isInteger(locationId)) throw fail(400, "Select the receiving location");
  const clean_lines = lines.filter((l) => toQty(l.qty) > 0);
  if (clean_lines.length === 0) throw fail(400, "Enter the received quantity for at least one item");
  const g = await c.query(
    `INSERT INTO goods_receipt (po_id, supplier_id, location_id, supplier_invoice_no, supplier_invoice_date, invoice_amount, note, received_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, grn_no AS "grnNo"`, [poId, supplierId, locationId, invoiceNo, invoiceDate, invoiceAmount, note, userId]);
  for (const l of clean_lines) {
    const qty = toQty(l.qty); let partId = toInt(l.partId); let cost = toMoney(l.unitCost); const poLineId = toInt(l.poLineId);
    if (Number.isInteger(poLineId)) {
      const pl = (await c.query("SELECT part_id, qty_ordered::float AS o, qty_received::float AS r, unit_cost::float AS cost FROM purchase_order_line WHERE id = $1 AND po_id = $2 FOR UPDATE", [poLineId, poId])).rows[0];
      if (!pl) throw fail(400, "Invalid purchase order line");
      if (qty > pl.o - pl.r + 1e-9) throw fail(400, `Only ${pl.o - pl.r} more can be received for this line`);
      partId = pl.part_id; if (!(cost > 0)) cost = pl.cost;
      await c.query("UPDATE purchase_order_line SET qty_received = qty_received + $2 WHERE id = $1", [poLineId, qty]);
    }
    if (!Number.isInteger(partId) || Number.isNaN(cost) || !(cost > 0)) throw fail(400, "Enter the unit cost for every received item");
    const batchNo = clean(l.batchNo)?.slice(0, 60) || null, expiry = toDate(l.expiryDate);
    await c.query("INSERT INTO goods_receipt_line (grn_id, po_line_id, part_id, qty, unit_cost, batch_no, expiry_date) VALUES ($1, $2, $3, $4, $5, $6, $7)", [g.rows[0].id, Number.isInteger(poLineId) ? poLineId : null, partId, qty, cost, batchNo, expiry]);
    await postMovement(c, { partId, locationId, type: "GRN", qty, unitCost: cost, refNo: g.rows[0].grnNo, note: invoiceNo ? `Invoice ${invoiceNo}` : null, userId, batchNo, expiry });
  }
  if (poId) {
    const t = (await c.query("SELECT BOOL_AND(qty_received >= qty_ordered) AS done FROM purchase_order_line WHERE po_id = $1", [poId])).rows[0];
    await c.query("UPDATE purchase_order SET status = $2 WHERE id = $1", [poId, t.done ? "RECEIVED" : "PARTIAL"]);
  }
  return g.rows[0];
}
const invoiceFields = (b) => {
  const amount = clean(b.invoiceAmount) === null ? null : toMoney(b.invoiceAmount);
  if (Number.isNaN(amount)) throw fail(400, "Enter a valid invoice amount");
  return { invoiceNo: clean(b.invoiceNo)?.slice(0, 60) || null, invoiceDate: toDate(b.invoiceDate), invoiceAmount: amount, note: clean(b.note)?.slice(0, 300) || null };
};
router.post("/inventory/purchase-orders/:id/receive", authenticateToken, tx("receive po", async (req, c) => {
  const id = toInt(req.params.id), b = req.body || {};
  const po = (await c.query("SELECT supplier_id, status FROM purchase_order WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!po) throw fail(404, "Purchase order not found");
  if (!["ORDERED", "PARTIAL"].includes(po.status)) throw fail(400, "Send the purchase order to the supplier before receiving goods");
  const g = await createGrn(c, { poId: id, supplierId: po.supplier_id, locationId: toInt(b.locationId), ...invoiceFields(b), userId: currentUserId(req), lines: Array.isArray(b.lines) ? b.lines : [] });
  return { message: `Goods received (${g.grnNo})`, ...g };
}, 201));
router.post("/inventory/grn", authenticateToken, tx("direct grn", async (req, c) => {
  const b = req.body || {}, supplierId = toInt(b.supplierId);
  if (!Number.isInteger(supplierId)) throw fail(400, "Select the supplier");
  const g = await createGrn(c, { poId: null, supplierId, locationId: toInt(b.locationId), ...invoiceFields(b), userId: currentUserId(req), lines: Array.isArray(b.lines) ? b.lines : [] });
  return { message: `Goods received (${g.grnNo})`, ...g };
}, 201));

/* ===================== PURCHASING: GRN list + supplier invoice ===================== */
router.get("/inventory/grns", authenticateToken, get("grn list", async () => {
  const r = await pool.query(
    `SELECT g.id, g.grn_no AS "grnNo", g.created_at AS "createdAt", g.supplier_id AS "supplierId", s.name AS supplier, s.address AS "supplierAddress", s.phone AS "supplierPhone",
            g.po_id AS "poId", po.po_no AS "poNo", l.name AS location, g.note,
            g.supplier_invoice_no AS "invoiceNo", g.supplier_invoice_date AS "invoiceDate", g.invoice_amount::float AS "invoiceAmount",
            trim(concat(u.first_name, ' ', u.last_name)) AS "receivedBy",
            COALESCE((SELECT SUM(qty * unit_cost) FROM goods_receipt_line WHERE grn_id = g.id), 0)::float AS value,
            COALESCE((SELECT SUM(qty) FROM goods_receipt_line WHERE grn_id = g.id), 0)::float AS "totalQty",
            (SELECT COUNT(*) FROM goods_receipt_line WHERE grn_id = g.id)::int AS lines,
            -- Partial = the PO still had something outstanding right after this receipt; no PO = Received
            CASE WHEN g.po_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM purchase_order_line pl WHERE pl.po_id = g.po_id AND pl.qty_ordered >
                     COALESCE((SELECT SUM(x.qty) FROM goods_receipt_line x JOIN goods_receipt gg ON gg.id = x.grn_id
                               WHERE gg.po_id = g.po_id AND gg.id <= g.id AND x.part_id = pl.part_id), 0))
                 THEN 'PARTIAL' ELSE 'RECEIVED' END AS status,
            COALESCE((SELECT json_agg(json_build_object('name', p.name, 'partNo', p.part_no, 'unit', p.unit, 'qty', x.qty::float, 'unitCost', x.unit_cost::float, 'batchNo', x.batch_no, 'expiryDate', x.expiry_date) ORDER BY x.id)
                      FROM goods_receipt_line x JOIN spare_part p ON p.id = x.part_id WHERE x.grn_id = g.id), '[]'::json) AS items
     FROM goods_receipt g JOIN supplier s ON s.id = g.supplier_id LEFT JOIN purchase_order po ON po.id = g.po_id JOIN stock_location l ON l.id = g.location_id
          LEFT JOIN admin_user u ON u.id = g.received_by
     ORDER BY g.id DESC LIMIT 300`);
  return r.rows;
}));
router.put("/inventory/grns/:id/invoice", authenticateToken, tx("grn invoice", async (req, c) => {
  const id = toInt(req.params.id), f = invoiceFields(req.body || {});
  if (!f.invoiceNo) throw fail(400, "Enter the supplier invoice number");
  const r = await c.query("UPDATE goods_receipt SET supplier_invoice_no = $2, supplier_invoice_date = $3, invoice_amount = $4 WHERE id = $1", [id, f.invoiceNo, f.invoiceDate, f.invoiceAmount]);
  if (r.rowCount === 0) throw fail(404, "GRN not found");
  return { message: "Invoice saved" };
}));

/* ===================== PURCHASING: supplier returns ===================== */
router.get("/inventory/supplier-returns", authenticateToken, get("supplier returns", async () => {
  const r = await pool.query(
    `SELECT sr.id, sr.return_no AS "returnNo", sr.status, sr.reason, sr.credit_note_no AS "creditNoteNo", sr.credit_amount::float AS "creditAmount", sr.created_at AS "createdAt",
            sr.supplier_id AS "supplierId", s.name AS supplier, s.address AS "supplierAddress", s.phone AS "supplierPhone",
            sr.grn_id AS "grnId", g.grn_no AS "grnNo", po.po_no AS "poNo", l.name AS location,
            trim(concat(u.first_name, ' ', u.last_name)) AS "returnedBy",
            COALESCE((SELECT SUM(qty * unit_cost) FROM supplier_return_line WHERE return_id = sr.id), 0)::float AS value,
            COALESCE((SELECT SUM(qty) FROM supplier_return_line WHERE return_id = sr.id), 0)::float AS "totalQty",
            COALESCE((SELECT json_agg(json_build_object('name', p.name, 'partNo', p.part_no, 'unit', p.unit, 'qty', x.qty::float, 'unitCost', x.unit_cost::float) ORDER BY x.id) FROM supplier_return_line x JOIN spare_part p ON p.id = x.part_id WHERE x.return_id = sr.id), '[]'::json) AS items
     FROM supplier_return sr JOIN supplier s ON s.id = sr.supplier_id LEFT JOIN goods_receipt g ON g.id = sr.grn_id LEFT JOIN purchase_order po ON po.id = g.po_id
          JOIN stock_location l ON l.id = sr.location_id LEFT JOIN admin_user u ON u.id = sr.created_by
     ORDER BY sr.id DESC LIMIT 300`);
  return r.rows;
}));
router.post("/inventory/supplier-returns", authenticateToken, tx("supplier return", async (req, c) => {
  const b = req.body || {}, supplierId = toInt(b.supplierId), locationId = toInt(b.locationId), reason = clean(b.reason);
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l) => toQty(l.qty) > 0);
  if (!Number.isInteger(supplierId) || !Number.isInteger(locationId)) throw fail(400, "Select the supplier and the location");
  if (!reason) throw fail(400, "Enter the reason (damaged / wrong part ...)");
  if (lines.length === 0) throw fail(400, "Add at least one item");
  const sr = await c.query("INSERT INTO supplier_return (supplier_id, grn_id, location_id, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, return_no AS \"returnNo\"",
    [supplierId, toInt(b.grnId) || null, locationId, reason.slice(0, 300), currentUserId(req)]);
  for (const l of lines) {
    const partId = toInt(l.partId), qty = toQty(l.qty);
    if (!Number.isInteger(partId)) throw fail(400, "Invalid item");
    const avg = (await c.query("SELECT avg_cost::float AS a FROM spare_part WHERE id = $1", [partId])).rows[0]?.a || 0;
    const cost = clean(l.unitCost) === null ? avg : toMoney(l.unitCost);
    await c.query("INSERT INTO supplier_return_line (return_id, part_id, qty, unit_cost) VALUES ($1, $2, $3, $4)", [sr.rows[0].id, partId, qty, cost]);
    await postMovement(c, { partId, locationId, type: "SUPPLIER_RETURN", qty: -qty, refNo: sr.rows[0].returnNo, note: reason.slice(0, 300), userId: currentUserId(req) });
  }
  return { message: `Return recorded (${sr.rows[0].returnNo})` };
}, 201));
router.put("/inventory/supplier-returns/:id/credit", authenticateToken, tx("return credit", async (req, c) => {
  const id = toInt(req.params.id), no = clean(req.body?.creditNoteNo), amt = clean(req.body?.creditAmount) === null ? null : toMoney(req.body.creditAmount);
  if (!no) throw fail(400, "Enter the credit note number");
  if (Number.isNaN(amt)) throw fail(400, "Enter a valid amount");
  const r = await c.query("UPDATE supplier_return SET status = 'CREDITED', credit_note_no = $2, credit_amount = $3 WHERE id = $1", [id, no.slice(0, 60), amt]);
  if (r.rowCount === 0) throw fail(404, "Return not found");
  return { message: "Credit note saved" };
}));

/* ===================== STOCK CONTROL: adjustments with approval ===================== */
router.get("/inventory/adjustments", authenticateToken, get("adjustments", async (req) => {
  const all = req.query.status === "all";
  const r = await pool.query(
    `SELECT a.id, a.adj_no AS "adjNo", a.kind, a.qty::float AS qty, a.reason, a.status, a.requested_at AS "requestedAt", a.decided_at AS "decidedAt", a.decision_note AS "decisionNote",
            p.name AS item, p.unit, l.name AS location,
            trim(concat(ru.first_name, ' ', ru.last_name)) AS "requestedBy", trim(concat(du.first_name, ' ', du.last_name)) AS "decidedBy"
     FROM stock_adjustment a JOIN spare_part p ON p.id = a.part_id JOIN stock_location l ON l.id = a.location_id
     LEFT JOIN admin_user ru ON ru.id = a.requested_by LEFT JOIN admin_user du ON du.id = a.decided_by
     WHERE ($1::boolean OR a.status = 'PENDING') ORDER BY a.id DESC LIMIT 300`, [all]);
  return r.rows;
}));
router.post("/inventory/adjustments", authenticateToken, tx("request adjustment", async (req, c) => {
  const b = req.body || {}, kind = ["DAMAGE", "LOSS", "FOUND", "OTHER"].includes(b.kind) ? b.kind : null;
  const partId = toInt(b.partId), locationId = toInt(b.locationId), amount = toQty(b.qty), reason = clean(b.reason);
  if (!kind || !Number.isInteger(partId) || !Number.isInteger(locationId)) throw fail(400, "Select the item, location and type");
  if (Number.isNaN(amount) || amount === 0) throw fail(400, "Enter a valid quantity");
  if (!reason) throw fail(400, "Enter the reason");
  const qty = kind === "FOUND" ? Math.abs(amount) : kind === "OTHER" ? amount : -Math.abs(amount);   // DAMAGE / LOSS always remove stock
  const r = await c.query("INSERT INTO stock_adjustment (part_id, location_id, kind, qty, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING adj_no AS \"adjNo\"", [partId, locationId, kind, qty, reason.slice(0, 300), currentUserId(req)]);
  return { message: `Adjustment ${r.rows[0].adjNo} sent for approval` };
}, 201));
router.post("/inventory/adjustments/:id/approve", authenticateToken, tx("approve adjustment", async (req, c) => {
  await mustManager(req);
  const id = toInt(req.params.id), uid = currentUserId(req);
  const a = (await c.query("SELECT * FROM stock_adjustment WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!a) throw fail(404, "Adjustment not found");
  if (a.status !== "PENDING") throw fail(400, "This adjustment was already decided");
  if (!ALLOW_SELF_APPROVAL && a.requested_by === uid) throw fail(403, "Another person must approve your request");
  const who = await userName(c, uid);
  await postMovement(c, {
    partId: a.part_id, locationId: a.location_id, type: ["DAMAGE", "LOSS"].includes(a.kind) ? "SCRAP" : "ADJUST", qty: Number(a.qty), refNo: a.adj_no,
    note: `${a.kind}: ${a.reason} · approved by ${who}`.slice(0, 300), userId: uid,
  });
  await c.query("UPDATE stock_adjustment SET status = 'APPROVED', decided_by = $2, decided_at = CURRENT_TIMESTAMP, decision_note = $3 WHERE id = $1", [id, uid, clean(req.body?.note)?.slice(0, 300) || null]);
  return { message: "Approved and posted" };
}));
router.post("/inventory/adjustments/:id/reject", authenticateToken, tx("reject adjustment", async (req, c) => {
  await mustManager(req);
  const r = await c.query("UPDATE stock_adjustment SET status = 'REJECTED', decided_by = $2, decided_at = CURRENT_TIMESTAMP, decision_note = $3 WHERE id = $1 AND status = 'PENDING'", [toInt(req.params.id), currentUserId(req), clean(req.body?.note)?.slice(0, 300) || null]);
  if (r.rowCount === 0) throw fail(400, "This adjustment was already decided");
  return { message: "Rejected" };
}));

/* ===================== STOCK CONTROL: stock take ===================== */
router.get("/inventory/stock-takes", authenticateToken, get("stock takes", async () => {
  const r = await pool.query(
    `SELECT t.id, t.take_no AS "takeNo", t.status, t.note, t.created_at AS "createdAt", t.completed_at AS "completedAt", l.name AS location,
            (SELECT COUNT(*) FROM stock_take_line x WHERE x.take_id = t.id)::int AS lines,
            (SELECT COUNT(*) FROM stock_take_line x WHERE x.take_id = t.id AND x.counted_qty IS NOT NULL)::int AS counted,
            (SELECT COUNT(*) FROM stock_take_line x WHERE x.take_id = t.id AND x.counted_qty IS NOT NULL AND x.counted_qty <> x.system_qty)::int AS variances
     FROM stock_take t JOIN stock_location l ON l.id = t.location_id ORDER BY t.id DESC LIMIT 100`);
  return r.rows;
}));
router.post("/inventory/stock-takes", authenticateToken, tx("create stock take", async (req, c) => {
  const b = req.body || {}, locationId = toInt(b.locationId), cat = clean(b.categoryId) === null ? null : toInt(b.categoryId);
  if (!Number.isInteger(locationId)) throw fail(400, "Select the location");
  const t = await c.query("INSERT INTO stock_take (location_id, note, created_by) VALUES ($1, $2, $3) RETURNING id, take_no AS \"takeNo\"", [locationId, clean(b.note)?.slice(0, 300) || null, currentUserId(req)]);
  const n = await c.query(
    `INSERT INTO stock_take_line (take_id, part_id, system_qty)
     SELECT $1, p.id, sb.qty_on_hand FROM spare_part p JOIN stock_balance sb ON sb.part_id = p.id AND sb.location_id = $2
     WHERE p.is_active AND ($3::int IS NULL OR p.category_id = $3)`, [t.rows[0].id, locationId, Number.isInteger(cat) ? cat : null]);
  if (n.rowCount === 0) throw fail(400, "No items with stock records were found for this location / category");
  return { message: `Stock take ${t.rows[0].takeNo} started`, id: t.rows[0].id };
}, 201));
router.get("/inventory/stock-takes/:id", authenticateToken, get("stock take detail", async (req) => {
  const id = toInt(req.params.id);
  const h = await pool.query('SELECT t.id, t.take_no AS "takeNo", t.status, t.note, l.name AS location, t.location_id AS "locationId" FROM stock_take t JOIN stock_location l ON l.id = t.location_id WHERE t.id = $1', [id]);
  if (h.rowCount === 0) throw fail(404, "Stock take not found");
  const lines = await pool.query(
    `SELECT x.id, p.name, p.part_no AS "partNo", p.unit, p.bin_location AS "binLocation", x.system_qty::float AS "systemQty", x.counted_qty::float AS "countedQty", x.reason
     FROM stock_take_line x JOIN spare_part p ON p.id = x.part_id WHERE x.take_id = $1 ORDER BY p.bin_location NULLS LAST, p.name`, [id]);
  return { ...h.rows[0], lines: lines.rows };
}));
router.put("/inventory/stock-takes/:id/lines", authenticateToken, tx("save counts", async (req, c) => {
  const id = toInt(req.params.id);
  const t = (await c.query("SELECT status FROM stock_take WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!t) throw fail(404, "Stock take not found");
  if (t.status !== "OPEN") throw fail(400, "This stock take is closed");
  for (const l of Array.isArray(req.body?.lines) ? req.body.lines : []) {
    const lid = toInt(l.id), counted = clean(l.countedQty) === null ? null : toQty(l.countedQty);
    if (!Number.isInteger(lid) || Number.isNaN(counted) || (counted !== null && counted < 0)) throw fail(400, "Check the counted quantities");
    await c.query("UPDATE stock_take_line SET counted_qty = $3, reason = $4 WHERE id = $1 AND take_id = $2", [lid, id, counted, clean(l.reason)?.slice(0, 200) || null]);
  }
  return { message: "Counts saved" };
}));
router.post("/inventory/stock-takes/:id/complete", authenticateToken, tx("complete stock take", async (req, c) => {
  await mustManager(req);
  const id = toInt(req.params.id), uid = currentUserId(req);
  const t = (await c.query("SELECT take_no, status, location_id FROM stock_take WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!t) throw fail(404, "Stock take not found");
  if (t.status !== "OPEN") throw fail(400, "This stock take is already closed");
  const who = await userName(c, uid);
  const lines = (await c.query("SELECT part_id, counted_qty::float AS counted, reason FROM stock_take_line WHERE take_id = $1 AND counted_qty IS NOT NULL", [id])).rows;
  let posted = 0;
  for (const l of lines) {
    const now = (await c.query("SELECT qty_on_hand::float AS q FROM stock_balance WHERE part_id = $1 AND location_id = $2 FOR UPDATE", [l.part_id, t.location_id])).rows[0]?.q || 0;
    const diff = Math.round((l.counted - now) * 100) / 100;     // variance against the CURRENT balance
    if (diff === 0) continue;
    await postMovement(c, { partId: l.part_id, locationId: t.location_id, type: "ADJUST", qty: diff, refNo: t.take_no, note: `Stock take${l.reason ? `: ${l.reason}` : ""} · approved by ${who}`.slice(0, 300), userId: uid });
    posted += 1;
  }
  await c.query("UPDATE stock_take SET status = 'COMPLETED', completed_by = $2, completed_at = CURRENT_TIMESTAMP WHERE id = $1", [id, uid]);
  return { message: `Stock take completed. ${posted} difference${posted === 1 ? "" : "s"} posted.` };
}));
router.post("/inventory/stock-takes/:id/cancel", authenticateToken, tx("cancel stock take", async (req, c) => {
  const r = await c.query("UPDATE stock_take SET status = 'CANCELLED' WHERE id = $1 AND status = 'OPEN'", [toInt(req.params.id)]);
  if (r.rowCount === 0) throw fail(400, "This stock take is already closed");
  return { message: "Cancelled" };
}));

/* ===================== STOCK CONTROL: transfers between locations ===================== */
router.get("/inventory/transfers", authenticateToken, get("transfers", async () => {
  const r = await pool.query(
    `SELECT t.id, t.transfer_no AS "transferNo", t.note, t.created_at AS "createdAt", f.name AS "fromLocation", d.name AS "toLocation", trim(concat(u.first_name, ' ', u.last_name)) AS "by",
            COALESCE((SELECT json_agg(json_build_object('name', p.name, 'qty', x.qty::float, 'unit', p.unit) ORDER BY x.id) FROM stock_transfer_line x JOIN spare_part p ON p.id = x.part_id WHERE x.transfer_id = t.id), '[]'::json) AS items
     FROM stock_transfer t JOIN stock_location f ON f.id = t.from_location_id JOIN stock_location d ON d.id = t.to_location_id LEFT JOIN admin_user u ON u.id = t.created_by
     ORDER BY t.id DESC LIMIT 200`);
  return r.rows;
}));
router.post("/inventory/transfers", authenticateToken, tx("transfer", async (req, c) => {
  const b = req.body || {}, from = toInt(b.fromLocationId), to = toInt(b.toLocationId), uid = currentUserId(req);
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l) => toQty(l.qty) > 0);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) throw fail(400, "Select two different locations");
  if (lines.length === 0) throw fail(400, "Add at least one item");
  const t = await c.query("INSERT INTO stock_transfer (from_location_id, to_location_id, note, created_by) VALUES ($1, $2, $3, $4) RETURNING id, transfer_no AS \"transferNo\"", [from, to, clean(b.note)?.slice(0, 300) || null, uid]);
  for (const l of lines) {
    const partId = toInt(l.partId), qty = toQty(l.qty);
    if (!Number.isInteger(partId)) throw fail(400, "Invalid item");
    await c.query("INSERT INTO stock_balance (part_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [partId, to]);
    const bal = (await c.query("SELECT qty_on_hand::float AS oh, qty_reserved::float AS rs FROM stock_balance WHERE part_id = $1 AND location_id = $2", [partId, from])).rows[0];
    if (!bal || bal.oh - bal.rs < qty) throw fail(400, `Not enough free stock to transfer (free ${Math.max(0, (bal?.oh || 0) - (bal?.rs || 0))})`);
    const part = (await c.query("SELECT track_batch, avg_cost::float AS avg FROM spare_part WHERE id = $1", [partId])).rows[0];
    await c.query("INSERT INTO stock_transfer_line (transfer_id, part_id, qty) VALUES ($1, $2, $3)", [t.rows[0].id, partId, qty]);
    const common = { partId, qty: 0, unitCost: part.avg, refNo: t.rows[0].transferNo, note: clean(b.note)?.slice(0, 300) || null, userId: uid, skipBatch: true };
    await postMovement(c, { ...common, locationId: from, type: "TRANSFER_OUT", qty: -qty });
    await postMovement(c, { ...common, locationId: to, type: "TRANSFER_IN", qty });
    if (part.track_batch) {          // move the batches too (first expiry first), keep batch no + expiry
      let left = qty;
      const bs = (await c.query("SELECT id, batch_no, expiry_date, qty_on_hand::float AS q, unit_cost::float AS cost FROM stock_batch WHERE part_id = $1 AND location_id = $2 AND qty_on_hand > 0 ORDER BY expiry_date NULLS LAST, id FOR UPDATE", [partId, from])).rows;
      for (const x of bs) {
        if (left <= 0) break;
        const take = Math.min(x.q, left);
        await c.query("UPDATE stock_batch SET qty_on_hand = qty_on_hand - $2 WHERE id = $1", [x.id, take]);
        await addBatch(c, partId, to, take, x.batch_no, x.expiry_date, x.cost);
        left -= take;
      }
      if (left > 0) await addBatch(c, partId, to, left, "OTHER", null, part.avg);
    }
  }
  return { message: `Transfer ${t.rows[0].transferNo} completed` };
}, 201));

/* ===================== STOCK CONTROL: batches & expiry ===================== */
router.get("/inventory/batches", authenticateToken, get("batches", async (req) => {
  const f = ["expiring", "expired"].includes(req.query.filter) ? req.query.filter : "all";
  const r = await pool.query(
    `SELECT b.id, p.name AS item, p.unit, l.name AS location, b.batch_no AS "batchNo", b.expiry_date AS "expiryDate", b.qty_on_hand::float AS qty, b.unit_cost::float AS "unitCost",
            (b.expiry_date - CURRENT_DATE) AS "daysLeft"
     FROM stock_batch b JOIN spare_part p ON p.id = b.part_id JOIN stock_location l ON l.id = b.location_id
     WHERE b.qty_on_hand > 0 AND ($1 = 'all' OR ($1 = 'expired' AND b.expiry_date < CURRENT_DATE) OR ($1 = 'expiring' AND b.expiry_date >= CURRENT_DATE AND b.expiry_date <= CURRENT_DATE + 60))
     ORDER BY b.expiry_date NULLS LAST, p.name LIMIT 500`, [f]);
  return r.rows;
}));

/* ===================== JOB CARD: parts for the invoice ===================== */
// jobs that have issued parts (an invoice module can call the second route to pull the parts lines)
router.get("/inventory/invoice-parts", authenticateToken, get("invoice parts", async () => {
  const r = await pool.query(
    `SELECT j.id AS "jobId", j.job_no AS "jobNo", j.reg_no AS "regNo", c.customer_name AS "customerName", d.name AS department, j.status,
            COUNT(*)::int AS lines, SUM((l.issued_qty - l.returned_qty) * l.unit_price)::float AS amount, MAX(l.updated_at) AS "lastIssue"
     FROM job_spare_part l JOIN job j ON j.id = l.job_id JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id
     WHERE l.issued_qty - l.returned_qty > 0 GROUP BY j.id, c.customer_name, d.name ORDER BY MAX(l.updated_at) DESC LIMIT 200`);
  return r.rows;
}));
router.get("/inventory/jobs/:jobId/invoice-parts", authenticateToken, get("job invoice parts", async (req) => {
  const id = toInt(req.params.jobId); if (!Number.isInteger(id)) throw fail(400, "Invalid job");
  const j = await pool.query('SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", c.customer_name AS "customerName" FROM job j JOIN customer c ON c.id = j.customer_id WHERE j.id = $1', [id]);
  if (j.rowCount === 0) throw fail(404, "Job not found");
  const l = await pool.query(
    `SELECT l.id, l.name, p.part_no AS "partNo", l.brand, l.quality, (l.issued_qty - l.returned_qty)::float AS qty, l.unit_price::float AS "unitPrice",
            ((l.issued_qty - l.returned_qty) * l.unit_price)::float AS amount
     FROM job_spare_part l LEFT JOIN spare_part p ON p.id = l.part_id WHERE l.job_id = $1 AND l.issued_qty - l.returned_qty > 0 ORDER BY l.id`, [id]);
  return { job: j.rows[0], lines: l.rows, total: l.rows.reduce((s, x) => s + x.amount, 0) };
}));

/* ===================== REPORTS ===================== */
router.get("/inventory/reports/reorder", authenticateToken, get("report reorder", async () => {
  const r = await pool.query(
    `SELECT * FROM (
       SELECT p.id, p.name, p.part_no AS "partNo", p.unit, p.reorder_level AS "reorderLevel", p.reorder_qty AS "reorderQty", p.bin_location AS "binLocation", c.name AS "categoryName",
              COALESCE((SELECT SUM(b.qty_on_hand - b.qty_reserved) FROM stock_balance b WHERE b.part_id = p.id), 0)::float AS available,
              COALESCE((SELECT SUM(l.qty_ordered - l.qty_received) FROM purchase_order_line l JOIN purchase_order o ON o.id = l.po_id WHERE l.part_id = p.id AND o.status IN ('ORDERED', 'PARTIAL')), 0)::float AS "onOrder",
              (SELECT s.name FROM goods_receipt_line x JOIN goods_receipt g ON g.id = x.grn_id JOIN supplier s ON s.id = g.supplier_id WHERE x.part_id = p.id ORDER BY x.id DESC LIMIT 1) AS "lastSupplier",
              (SELECT x.unit_cost::float FROM goods_receipt_line x WHERE x.part_id = p.id ORDER BY x.id DESC LIMIT 1) AS "lastCost"
       FROM spare_part p LEFT JOIN inventory_category c ON c.id = p.category_id WHERE p.is_active) t
     WHERE t.available <= t."reorderLevel" ORDER BY t.available, t.name LIMIT 500`);
  return r.rows.map((x) => ({ ...x, suggested: Math.max(1, x.reorderQty > 0 ? x.reorderQty : x.reorderLevel * 2 - x.available - x.onOrder) }));
}));
router.get("/inventory/reports/valuation", authenticateToken, get("report valuation", async () => {
  const [items, locs] = await Promise.all([
    pool.query(`SELECT p.id, p.name, p.part_no AS "partNo", p.unit, COALESCE(c.name, 'Uncategorised') AS "categoryName", p.avg_cost::float AS "avgCost",
                       COALESCE(SUM(b.qty_on_hand), 0)::float AS qty, (COALESCE(SUM(b.qty_on_hand), 0) * p.avg_cost)::float AS value
                FROM spare_part p LEFT JOIN inventory_category c ON c.id = p.category_id LEFT JOIN stock_balance b ON b.part_id = p.id
                WHERE p.is_active GROUP BY p.id, c.name HAVING COALESCE(SUM(b.qty_on_hand), 0) > 0 ORDER BY value DESC`),
    pool.query(`SELECT l.name, COALESCE(SUM(b.qty_on_hand * p.avg_cost), 0)::float AS value FROM stock_location l
                LEFT JOIN stock_balance b ON b.location_id = l.id LEFT JOIN spare_part p ON p.id = b.part_id GROUP BY l.id ORDER BY l.id`),
  ]);
  const cats = {};
  for (const x of items.rows) { const k = x.categoryName; cats[k] = cats[k] || { name: k, items: 0, qty: 0, value: 0 }; cats[k].items += 1; cats[k].qty += x.qty; cats[k].value += x.value; }
  return { total: items.rows.reduce((s, x) => s + x.value, 0), items: items.rows, byCategory: Object.values(cats).sort((a, b) => b.value - a.value), byLocation: locs.rows };
}));
router.get("/inventory/reports/movers", authenticateToken, get("report movers", async (req) => {
  const days = Math.min(730, Math.max(7, toInt(req.query.days) || 90));
  const r = await pool.query(
    `SELECT p.id, p.name, p.part_no AS "partNo", p.unit, COALESCE(c.name, 'Uncategorised') AS "categoryName", p.avg_cost::float AS "avgCost",
            COALESCE((SELECT SUM(b.qty_on_hand) FROM stock_balance b WHERE b.part_id = p.id), 0)::float AS "onHand",
            COALESCE((SELECT -SUM(m.qty) FROM stock_movement m WHERE m.part_id = p.id AND m.move_type IN ('ISSUE', 'RETURN') AND m.created_at >= now() - ($1 || ' days')::interval), 0)::float AS used,
            (SELECT MAX(m.created_at) FROM stock_movement m WHERE m.part_id = p.id AND m.move_type = 'ISSUE') AS "lastIssue"
     FROM spare_part p LEFT JOIN inventory_category c ON c.id = p.category_id WHERE p.is_active`, [String(days)]);
  const used = r.rows.filter((x) => x.used > 0).map((x) => x.used).sort((a, b) => b - a);
  const cut = used.length ? used[Math.max(0, Math.ceil(used.length / 4) - 1)] : Infinity;      // top 25% = fast
  const rows = r.rows.map((x) => ({ ...x, value: x.onHand * x.avgCost, status: x.used > 0 ? (x.used >= cut ? "FAST" : "SLOW") : x.onHand > 0 ? "DEAD" : "NO STOCK" }));
  return { days, rows: rows.sort((a, b) => b.used - a.used || b.value - a.value) };
}));
router.get("/inventory/reports/usage", authenticateToken, get("report usage", async (req) => {
  const by = ["job", "technician", "vehicle", "item"].includes(req.query.by) ? req.query.by : "job";
  const from = toDate(req.query.from), to = toDate(req.query.to);
  const label = { job: "j.job_no", technician: "COALESCE(m.technician, '(not recorded)')", vehicle: "COALESCE(j.vehicle_type, '(not set)')", item: "p.name" }[by];
  const sub = { job: "MAX(j.reg_no)", technician: "NULL", vehicle: "NULL", item: "MAX(p.part_no)" }[by];
  const r = await pool.query(
    `SELECT ${label} AS label, ${sub} AS sub, COUNT(DISTINCT m.job_id)::int AS jobs, COUNT(DISTINCT m.part_id)::int AS items,
            (-SUM(m.qty))::float AS qty, (-SUM(m.qty * m.unit_cost))::float AS cost
     FROM stock_movement m JOIN spare_part p ON p.id = m.part_id LEFT JOIN job j ON j.id = m.job_id
     WHERE m.move_type IN ('ISSUE', 'RETURN') AND ($1::date IS NULL OR m.created_at >= $1::date) AND ($2::date IS NULL OR m.created_at < $2::date + 1)
       ${by === "job" ? "AND m.job_id IS NOT NULL" : ""}
     GROUP BY ${label} HAVING -SUM(m.qty) <> 0 ORDER BY cost DESC LIMIT 300`, [from, to]);
  return { by, rows: r.rows };
}));
router.get("/inventory/reports/margin", authenticateToken, get("report margin", async (req) => {
  const from = toDate(req.query.from), to = toDate(req.query.to);
  const r = await pool.query(
    `WITH mv AS (
       SELECT part_id, job_id, -SUM(qty) AS qty, -SUM(qty * unit_cost) AS cost FROM stock_movement
       WHERE job_id IS NOT NULL AND move_type IN ('ISSUE', 'RETURN') AND ($1::date IS NULL OR created_at >= $1::date) AND ($2::date IS NULL OR created_at < $2::date + 1)
       GROUP BY part_id, job_id HAVING -SUM(qty) > 0)
     SELECT p.id, p.name, p.part_no AS "partNo", COALESCE(c.name, 'Uncategorised') AS "categoryName", SUM(mv.qty)::float AS qty, SUM(mv.cost)::float AS cost,
            SUM(mv.qty * COALESCE((SELECT AVG(jp.unit_price) FROM job_spare_part jp WHERE jp.job_id = mv.job_id AND jp.part_id = mv.part_id), p.price))::float AS revenue
     FROM mv JOIN spare_part p ON p.id = mv.part_id LEFT JOIN inventory_category c ON c.id = p.category_id GROUP BY p.id, c.name ORDER BY revenue DESC LIMIT 300`, [from, to]);
  const rows = r.rows.map((x) => ({ ...x, margin: x.revenue - x.cost, pct: x.revenue > 0 ? ((x.revenue - x.cost) / x.revenue) * 100 : 0 }));
  return { rows, revenue: rows.reduce((s, x) => s + x.revenue, 0), cost: rows.reduce((s, x) => s + x.cost, 0) };
}));

module.exports = router;