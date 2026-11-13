// routes/drying_check.routes.js   (NEW file)
// Wash "Drying Area" stage: exterior drying checklist, fluid level inspection (price = litres x price per litre),
// filters (cleaned / replace from the stock / not in stock = photo + request), "Go to Inspection" Yes / Not Yet.
// Mount (same prefix as the other stage routes):   app.use("/evidence", require("./routes/drying_check.routes"));      (needs express.json({ limit: "4mb" }) because of the filter photo)
// Run wash_drying_check.sql first.
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticateToken = require("../middleware/authMiddleware");
const { requirePermission } = require("./permissions"); // "dryingcheck.manage" = edit the checklist and the prices
const { syncWashInvoice } = require("./wash_invoice.helper"); // the fluids / filters are added to the invoice of the job

const ADMIN_ROLE_ID = 1;
const QUALITY = ["Good", "Dirty", "Contaminated"];
const LEVEL = ["Full", "Low", "Overfilled"];
const ACTION = ["None", "Top up", "Replace"];
const LITRES = [0, 1.25, 5];                       // drop down values (None = 0)
const DEFAULT_LITRES = { "None": 0, "Top up": 1.25, "Replace": 5 };
const PHOTO_MAX = 1500000;                          // characters of the data URL

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
const toMoney = (v) => {
  const s = clean(v);
  if (s === null) return NaN;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n < 1e10 ? Math.round(n * 100) / 100 : NaN;
};

const JOB_SQL = `
  SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
         j.department_id AS "departmentId", d.name AS "departmentName",
         COALESCE(d.has_drying_check, false) AS "hasDrying", d.drying_check_stage_no AS "dryingStageNo",
         c.customer_name AS "customerName"
  FROM job j
  JOIN customer c ON c.id = j.customer_id
  LEFT JOIN department d ON d.id = j.department_id
  WHERE j.id = $1`;

async function isAdminUser(req) {
  const uid = currentUserId(req);
  if (!uid) return false;
  const r = await pool.query("SELECT role_id FROM admin_user WHERE id = $1", [uid]);
  return r.rowCount > 0 && Number(r.rows[0].role_id) === ADMIN_ROLE_ID;
}

/* GET /drying-check-department/:name */
router.get("/drying-check-department/:name", authenticateToken, async (req, res) => {
  const name = clean(req.params.name);
  if (!name) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(
      `SELECT id, name, COALESCE(has_drying_check, false) AS "hasDryingCheck", drying_check_stage_no AS "dryingCheckStageNo"
         FROM department WHERE lower(name) = lower($1) AND is_active`, [name]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    return res.json(r.rows[0]);
  } catch (error) {
    console.error("drying-check-department:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* GET /jobs/:id/drying-check -> everything the window needs */
router.get("/jobs/:id/drying-check", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const jr = await pool.query(JOB_SQL, [jobId]);
    if (jr.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const job = jr.rows[0];
    if (!job.hasDrying) return res.status(409).json({ message: `The drying area stage is not used in the ${job.departmentName || "selected"} department` });

    const [items, results, saved, fluidMaster, fluidRows, ftypes, filterRows] = await Promise.all([
      pool.query(`SELECT id, group_name AS "groupName", name FROM job_drying_item WHERE department_id = $1 AND is_active ORDER BY sort_order, id`, [job.departmentId]),
      pool.query("SELECT item_id FROM job_drying_result WHERE job_id = $1 AND checked AND item_id IS NOT NULL", [jobId]),
      pool.query(`SELECT go_inspection AS "goInspection", total_charge::float AS "totalCharge", completed_at AS "completedAt" FROM job_drying_check WHERE job_id = $1`, [jobId]),
      pool.query(`SELECT id, name, price_per_litre::float AS "pricePerLitre" FROM drying_fluid WHERE is_active ORDER BY sort_order, id`),
      pool.query(`SELECT fluid_id AS "fluidId", fluid_name AS "fluidName", quality, fluid_level AS "level", action, litres::float AS litres, amount::float AS amount FROM job_drying_fluid WHERE job_id = $1`, [jobId]),
      pool.query(`SELECT kind, label, clean_price::float AS "cleanPrice" FROM drying_filter_type ORDER BY sort_order, kind`),
      pool.query(`SELECT kind, action, part_id AS "partId", part_name AS "partName", price::float AS price, price_source AS "priceSource", description, photo, requested_at AS "requestedAt" FROM job_drying_filter WHERE job_id = $1`, [jobId]),
    ]);
    const checked = new Set(results.rows.map((r) => r.item_id));
    const savedFluid = new Map(fluidRows.rows.map((r) => [r.fluidId, r]));
    const savedFilter = new Map(filterRows.rows.map((r) => [r.kind, r]));
    const admin = await isAdminUser(req);
    const s = saved.rows[0] || null;
    const reached = job.status === "IN_PROGRESS" && job.stageNo >= job.dryingStageNo;
    const locked = Boolean(s?.completedAt) && !admin; // after the stage is completed only the administrator can change it
    return res.json({
      job: { id: job.id, jobNo: job.jobNo, regNo: job.regNo, customerName: job.customerName, departmentId: job.departmentId, departmentName: job.departmentName, stageNo: job.stageNo, dryingStageNo: job.dryingStageNo },
      items: items.rows.map((i) => ({ ...i, checked: checked.has(i.id) })),
      fluids: fluidMaster.rows.map((f) => {
        const v = savedFluid.get(f.id);
        return { id: f.id, name: f.name, pricePerLitre: f.pricePerLitre, quality: v?.quality || "", level: v?.level || "", action: v?.action || "", litres: v ? v.litres : 0 };
      }),
      filters: ftypes.rows.map((t) => ({ kind: t.kind, label: t.label, cleanPrice: t.cleanPrice, saved: savedFilter.get(t.kind) || null })),
      options: { quality: QUALITY, level: LEVEL, action: ACTION, litres: LITRES, defaultLitres: DEFAULT_LITRES },
      saved: s,
      canRecord: reached && !locked,
      locked,
    });
  } catch (error) {
    console.error("Error loading the drying check:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* GET /drying-filter-parts?kind=AIR|AC&q=  -> stock search for the filters (spare part catalog, names that contain "filter") */
router.get("/drying-filter-parts", authenticateToken, async (req, res) => {
  const kind = req.query.kind === "AC" ? "AC" : "AIR";
  const q = clean(req.query.q);
  // A/C filters are usually named "A/C", "AC" or "cabin"; the air filter search shows the rest first
  const acLike = "(name ILIKE '%a/c%' OR name ILIKE '% ac %' OR name ILIKE 'ac %' OR name ILIKE '%cabin%' OR name ILIKE '%pollen%')";
  try {
    const r = await pool.query(
      `SELECT id, part_no AS "partNo", name, brand, quality, price::float AS price, stock_qty AS "stockQty"
         FROM spare_part
        WHERE is_active AND name ILIKE '%filter%'
          AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR brand ILIKE '%' || $1 || '%' OR part_no ILIKE '%' || $1 || '%')
        ORDER BY (${acLike}) = ($2::text = 'AC') DESC, (stock_qty > 0) DESC, name, id LIMIT 20`,
      [q, kind]
    );
    return res.json(r.rows);
  } catch (error) {
    console.error("drying-filter-parts:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* PUT /jobs/:id/drying-check
   { checkedItemIds: [], fluids: [{ fluidId, quality, level, action, litres }],
     filters: [{ kind, action: "CLEANED"|"REPLACE", partId?, partName?, price?, priceSource?, description?, photo?, requested? }],
     goInspection: true|false, complete: bool }
   complete = everything is filled in and Go to Inspection = Yes. The first time, the stage is finished. */
router.put("/jobs/:id/drying-check", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const b = req.body || {};
  const complete = b.complete === true;
  const goInspection = b.goInspection === true;
  const ids = [...new Set((Array.isArray(b.checkedItemIds) ? b.checkedItemIds : []).map(toInt))].filter((n) => Number.isInteger(n));
  const fluidIn = Array.isArray(b.fluids) ? b.fluids : [];
  const filterIn = Array.isArray(b.filters) ? b.filters : [];

  const userId = currentUserId(req);
  const admin = await isAdminUser(req);
  const client = await pool.connect();
  const bad = async (code, message) => { await client.query("ROLLBACK"); return res.status(code).json({ message }); };
  try {
    await client.query("BEGIN");
    const jr = await client.query(JOB_SQL.replace("WHERE j.id = $1", "WHERE j.id = $1 FOR UPDATE OF j"), [jobId]);
    if (jr.rowCount === 0) return bad(404, "Job not found");
    const job = jr.rows[0];
    if (!job.hasDrying) return bad(409, "The drying area stage is not used in this department");
    if (job.status !== "IN_PROGRESS" || job.stageNo < job.dryingStageNo) return bad(409, "This job is not ready for the drying area stage");
    const cur = await client.query("SELECT completed_at FROM job_drying_check WHERE job_id = $1", [jobId]);
    if (cur.rows[0]?.completed_at && !admin) return bad(403, "This stage is completed. Only the administrator can change it.");

    /* exterior checklist */
    const items = await client.query("SELECT id, group_name, name FROM job_drying_item WHERE department_id = $1 AND is_active ORDER BY sort_order, id", [job.departmentId]);
    const valid = new Set(items.rows.map((i) => i.id));
    const checked = new Set(ids.filter((id) => valid.has(id)));

    /* fluids: the price comes from the server (litres x price per litre), never from the browser */
    const master = await client.query("SELECT id, name, price_per_litre::float AS ppl FROM drying_fluid WHERE is_active ORDER BY sort_order, id");
    const fluidRowsOut = [];
    for (const f of master.rows) {
      const v = fluidIn.find((x) => toInt(x?.fluidId) === f.id) || {};
      const quality = QUALITY.includes(v.quality) ? v.quality : null;
      const level = LEVEL.includes(v.level) ? v.level : null;
      const action = ACTION.includes(v.action) ? v.action : null;
      let litres = Number(v.litres);
      if (!LITRES.includes(litres)) litres = action ? DEFAULT_LITRES[action] : 0;
      if (action === "None") litres = 0;
      if (action && action !== "None" && litres === 0) litres = DEFAULT_LITRES[action];
      const amount = Math.round(litres * f.ppl * 100) / 100;
      if (complete && (!quality || !level || !action)) return bad(400, `Select the quality, fluid level and action of ${f.name}`);
      fluidRowsOut.push({ id: f.id, name: f.name, quality, level, action, litres, ppl: f.ppl, amount });
    }

    /* filters */
    const types = await client.query("SELECT kind, label, clean_price::float AS cp FROM drying_filter_type ORDER BY sort_order, kind");
    const filterRowsOut = [];
    for (const t of types.rows) {
      const v = filterIn.find((x) => x?.kind === t.kind) || {};
      const action = v.action === "CLEANED" || v.action === "REPLACE" ? v.action : null;
      if (complete && !action) return bad(400, `Select Cleaned or Replace for ${t.label}`);
      let partId = null, partName = clean(v.partName), price = 0, source = null;
      const description = clean(v.description);
      let photo = clean(v.photo);
      if (description && description.length > 1000) return bad(400, "The description is too long");
      if (photo && (!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > PHOTO_MAX)) return bad(400, "The photo is not valid or too large");
      if (action === "CLEANED") {
        price = t.cp; source = "SERVICE"; partName = null; photo = null;
      } else if (action === "REPLACE") {
        const pid = toInt(v.partId);
        if (Number.isInteger(pid)) {
          const p = await client.query("SELECT id, name, price::float AS price FROM spare_part WHERE id = $1", [pid]);
          if (p.rowCount === 0) return bad(400, `The selected ${t.label} was not found in the stock list`);
          partId = p.rows[0].id; partName = p.rows[0].name; price = p.rows[0].price; source = "CATALOG"; photo = null;
        } else if (v.priceSource === "MANUAL" || v.price !== undefined) {
          const m = toMoney(v.price);
          price = Number.isNaN(m) ? 0 : m; source = "MANUAL";
          if (complete && !(price > 0)) return bad(400, `Enter the price of the ${t.label} (or select it from the stock)`);
          if (complete && !partName) return bad(400, `Enter the name of the ${t.label}`);
        } else if (complete) {
          return bad(400, `Select the ${t.label} from the stock, or add a manual price`);
        }
      }
      const requested = action === "REPLACE" && v.requested === true;
      filterRowsOut.push({ kind: t.kind, action, partId, partName, price, source, description: action === "REPLACE" ? description : null, photo: action === "REPLACE" ? photo : null, requested });
    }

    if (complete) {
      if (checked.size !== items.rowCount) return bad(400, "Tick every item of the exterior drying inspection");
      if (!goInspection) return bad(400, "Select Yes for “Go to Inspection”");
    }

    const total = Math.round((fluidRowsOut.reduce((s, f) => s + f.amount, 0) + filterRowsOut.reduce((s, f) => s + (f.action ? f.price : 0), 0)) * 100) / 100;

    await client.query(
      `INSERT INTO job_drying_check (job_id, go_inspection, total_charge, completed_at, saved_by)
       VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP END, $5)
       ON CONFLICT (job_id) DO UPDATE SET go_inspection = EXCLUDED.go_inspection, total_charge = EXCLUDED.total_charge,
         completed_at = CASE WHEN $4::boolean THEN COALESCE(job_drying_check.completed_at, CURRENT_TIMESTAMP) ELSE job_drying_check.completed_at END,
         saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
      [jobId, goInspection, total, complete, userId]
    );
    await client.query("DELETE FROM job_drying_result WHERE job_id = $1", [jobId]);
    for (const i of items.rows) {
      await client.query("INSERT INTO job_drying_result (job_id, item_id, group_name, item_name, checked) VALUES ($1, $2, $3, $4, $5)", [jobId, i.id, i.group_name, i.name, checked.has(i.id)]);
    }
    await client.query("DELETE FROM job_drying_fluid WHERE job_id = $1", [jobId]);
    for (const f of fluidRowsOut) {
      if (!f.quality && !f.level && !f.action) continue;
      await client.query(
        `INSERT INTO job_drying_fluid (job_id, fluid_id, fluid_name, quality, fluid_level, action, litres, price_per_litre, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [jobId, f.id, f.name, f.quality, f.level, f.action, f.litres, f.ppl, f.amount]
      );
    }
    for (const f of filterRowsOut) {
      await client.query("DELETE FROM job_drying_filter WHERE job_id = $1 AND kind = $2", [jobId, f.kind]);
      if (!f.action) continue;
      await client.query(
        `INSERT INTO job_drying_filter (job_id, kind, action, part_id, part_name, price, price_source, description, photo, requested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10::boolean THEN CURRENT_TIMESTAMP END)`,
        [jobId, f.kind, f.action, f.partId, f.partName, f.price, f.source, f.description, f.photo, f.requested]
      );
    }

    let stageNo = job.stageNo;
    if (complete && job.stageNo === job.dryingStageNo) {
      const next = job.dryingStageNo + 1;
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.dryingStageNo, userId]);
      await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      stageNo = next;
    } else {
      await client.query("UPDATE job SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [jobId]);
    }
    await client.query("COMMIT");
    await syncWashInvoice(jobId, userId).catch((e) => console.error("wash invoice sync:", e.message));
    return res.json({ message: complete ? "Drying area stage completed" : "Saved", totalCharge: total, currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving the drying check:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

/* ================= prices (security: permission "dryingcheck.manage") ================= */
// GET /drying-prices -> { fluids (removed ones too), filters }
router.get("/drying-prices", authenticateToken, requirePermission("dryingcheck.manage"), async (req, res) => {
  try {
    const [f, t] = await Promise.all([
      pool.query(`SELECT id, name, price_per_litre::float AS "pricePerLitre", is_active AS "isActive" FROM drying_fluid ORDER BY is_active DESC, sort_order, id`),
      pool.query(`SELECT kind, label, clean_price::float AS "cleanPrice" FROM drying_filter_type ORDER BY sort_order, kind`),
    ]);
    return res.json({ fluids: f.rows, filters: t.rows });
  } catch (error) {
    console.error("drying-prices:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
// POST /drying-fluids { name, pricePerLitre }   (need to add more fluids)
router.post("/drying-fluids", authenticateToken, requirePermission("dryingcheck.manage"), async (req, res) => {
  const name = clean(req.body?.name);
  const price = toMoney(req.body?.pricePerLitre ?? 0);
  if (!name || name.length > 100) return res.status(400).json({ message: "Enter the fluid name" });
  if (Number.isNaN(price)) return res.status(400).json({ message: "Enter a valid price" });
  try {
    await pool.query(
      `INSERT INTO drying_fluid (name, price_per_litre, sort_order) VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) FROM drying_fluid), 0) + 1)
       ON CONFLICT (name) DO UPDATE SET is_active = true, price_per_litre = EXCLUDED.price_per_litre`, [name, price]);
    return res.status(201).json({ message: "Added" });
  } catch (error) {
    console.error("add drying-fluid:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
// PATCH /drying-fluids/:id any of { name, pricePerLitre, isActive }
router.patch("/drying-fluids/:id", authenticateToken, requirePermission("dryingcheck.manage"), async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid fluid" });
  const b = req.body || {};
  const sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if ("name" in b) { const n = clean(b.name); if (!n || n.length > 100) return res.status(400).json({ message: "Enter the fluid name" }); add("name", n); }
  if ("pricePerLitre" in b) { const p = toMoney(b.pricePerLitre); if (Number.isNaN(p)) return res.status(400).json({ message: "Enter a valid price" }); add("price_per_litre", p); }
  if ("isActive" in b) add("is_active", b.isActive === true);
  if (sets.length === 0) return res.status(400).json({ message: "Nothing to change" });
  vals.push(id);
  try {
    const r = await pool.query(`UPDATE drying_fluid SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    if (r.rowCount === 0) return res.status(404).json({ message: "Fluid not found" });
    return res.json({ message: "Saved" });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ message: "A fluid with this name already exists" });
    console.error("update drying-fluid:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});
// PATCH /drying-filter-types/:kind { cleanPrice }
router.patch("/drying-filter-types/:kind", authenticateToken, requirePermission("dryingcheck.manage"), async (req, res) => {
  const kind = req.params.kind === "AC" ? "AC" : req.params.kind === "AIR" ? "AIR" : null;
  const p = toMoney(req.body?.cleanPrice);
  if (!kind) return res.status(400).json({ message: "Invalid filter" });
  if (Number.isNaN(p)) return res.status(400).json({ message: "Enter a valid price" });
  try {
    await pool.query("UPDATE drying_filter_type SET clean_price = $2 WHERE kind = $1", [kind, p]);
    return res.json({ message: "Saved" });
  } catch (error) {
    console.error("update drying-filter-type:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* ================= edit the checklist (security: permission "dryingcheck.manage") ================= */

// GET /departments/:id/drying-items -> every item, removed ones too
router.get("/departments/:id/drying-items", authenticateToken, requirePermission("dryingcheck.manage"), async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(
      `SELECT id, group_name AS "groupName", name, is_active AS "isActive", sort_order AS "sortOrder"
         FROM job_drying_item WHERE department_id = $1 ORDER BY is_active DESC, sort_order, id`, [id]);
    return res.json({ items: r.rows });
  } catch (error) {
    console.error("drying-items:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /departments/:id/drying-items   { name, groupName? }   (a removed item with the same name is brought back)
router.post("/departments/:id/drying-items", authenticateToken, requirePermission("dryingcheck.manage"), async (req, res) => {
  const id = toInt(req.params.id);
  const name = clean(req.body?.name);
  const groupName = clean(req.body?.groupName);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid department" });
  if (!name) return res.status(400).json({ message: "Enter the item" });
  if (name.length > 300 || (groupName && groupName.length > 100)) return res.status(400).json({ message: "The text is too long" });
  try {
    const dup = await pool.query("SELECT id, is_active FROM job_drying_item WHERE department_id = $1 AND lower(name) = lower($2)", [id, name]);
    if (dup.rowCount > 0) {
      if (dup.rows[0].is_active) return res.status(409).json({ message: "This item is already in the list" });
      await pool.query("UPDATE job_drying_item SET is_active = true, group_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [dup.rows[0].id, groupName]);
      return res.status(201).json({ message: "Item added back", id: dup.rows[0].id });
    }
    const r = await pool.query(
      `INSERT INTO job_drying_item (department_id, group_name, name, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) FROM job_drying_item WHERE department_id = $1), 0) + 1) RETURNING id`,
      [id, groupName, name]
    );
    return res.status(201).json({ message: "Item added", id: r.rows[0].id });
  } catch (error) {
    console.error("add drying-item:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /drying-items/:id   any of { name, groupName, isActive }   (isActive false = remove)
router.patch("/drying-items/:id", authenticateToken, requirePermission("dryingcheck.manage"), async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid item" });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  try {
    const cur = await pool.query("SELECT department_id FROM job_drying_item WHERE id = $1", [id]);
    if (cur.rowCount === 0) return res.status(404).json({ message: "Item not found" });
    if ("name" in b) {
      const name = clean(b.name);
      if (!name) return res.status(400).json({ message: "Enter the item" });
      if (name.length > 300) return res.status(400).json({ message: "The text is too long" });
      const dup = await pool.query("SELECT 1 FROM job_drying_item WHERE department_id = $1 AND lower(name) = lower($2) AND id <> $3", [cur.rows[0].department_id, name, id]);
      if (dup.rowCount > 0) return res.status(409).json({ message: "This item is already in the list" });
      add("name", name);
    }
    if ("groupName" in b) {
      const g = clean(b.groupName);
      if (g && g.length > 100) return res.status(400).json({ message: "The group name is too long" });
      add("group_name", g);
    }
    if ("isActive" in b) add("is_active", b.isActive === true);
    if (sets.length === 0) return res.status(400).json({ message: "Nothing to change" });
    vals.push(id);
    await pool.query(`UPDATE job_drying_item SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${vals.length}`, vals);
    return res.json({ message: "Saved" });
  } catch (error) {
    console.error("update drying-item:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;