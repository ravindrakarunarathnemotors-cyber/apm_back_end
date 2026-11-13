// routes/internal_check.routes.js   (NEW file)
// Wash "Internal Inspection 2" stage: vacuum cleaning and inspection checklist (editable), restrictions,
// "Is everything good?" Yes / No and the signature of the Head (select + drawn).
// Mount (same prefix as the other stage routes):   app.use("/evidence", require("./routes/internal_check.routes"));      (needs express.json())
// Run wash_internal_check.sql first.
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticateToken = require("../middleware/authMiddleware");
const { requirePermission } = require("./permissions"); // "internalcheck.manage" = add / rename / remove checklist items

const ADMIN_ROLE_ID = 1; // the administrator may always change a signed inspection

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

const JOB_SQL = `
  SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
         j.department_id AS "departmentId", d.name AS "departmentName",
         COALESCE(d.has_internal_check, false) AS "hasInternal", d.internal_check_stage_no AS "internalStageNo",
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

/* GET /internal-check-department/:name */
router.get("/internal-check-department/:name", authenticateToken, async (req, res) => {
  const name = clean(req.params.name);
  if (!name) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(
      `SELECT id, name, COALESCE(has_internal_check, false) AS "hasInternalCheck", internal_check_stage_no AS "internalCheckStageNo"
         FROM department WHERE lower(name) = lower($1) AND is_active`, [name]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    return res.json(r.rows[0]);
  } catch (error) {
    console.error("internal-check-department:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* GET /jobs/:id/internal-check */
router.get("/jobs/:id/internal-check", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const jr = await pool.query(JOB_SQL, [jobId]);
    if (jr.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const job = jr.rows[0];
    if (!job.hasInternal) return res.status(409).json({ message: `The internal inspection is not used in the ${job.departmentName || "selected"} department` });

    const [items, saved, results] = await Promise.all([
      pool.query(`SELECT id, group_name AS "groupName", name FROM job_internal_check_item WHERE department_id = $1 AND is_active ORDER BY sort_order, id`, [job.departmentId]),
      pool.query(
        `SELECT all_good AS "allGood", restrictions, signed_by_name AS "signedByName", signed_at AS "signedAt", signature_image AS "signatureImage"
           FROM job_internal_check WHERE job_id = $1`, [jobId]),
      pool.query("SELECT item_id FROM job_internal_check_result WHERE job_id = $1 AND checked AND item_id IS NOT NULL", [jobId]),
    ]);
    const checked = new Set(results.rows.map((r) => r.item_id));
    const s = saved.rows[0] || null;
    const admin = await isAdminUser(req);
    const reached = job.status === "IN_PROGRESS" && job.stageNo >= job.internalStageNo;
    const locked = Boolean(s?.signedAt) && !admin; // after the Head signed, only the administrator can change it
    return res.json({
      job: { id: job.id, jobNo: job.jobNo, regNo: job.regNo, customerName: job.customerName, departmentId: job.departmentId, departmentName: job.departmentName, stageNo: job.stageNo, internalStageNo: job.internalStageNo },
      items: items.rows.map((i) => ({ ...i, checked: checked.has(i.id) })),
      saved: s,
      canRecord: reached && !locked,
      locked,
    });
  } catch (error) {
    console.error("Error loading the internal check:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* PUT /jobs/:id/internal-check
   { checkedItemIds: [], restrictions, allGood: true|false|null, signedByName, signatureImage?, complete: bool }
   complete = every item ticked + everything good (Yes) + the Head signed. The first time, the stage is finished. */
router.put("/jobs/:id/internal-check", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.checkedItemIds) ? b.checkedItemIds : []).map(toInt))].filter((n) => Number.isInteger(n));
  const complete = b.complete === true;
  const allGood = b.allGood === true ? true : b.allGood === false ? false : null;
  const restrictions = clean(b.restrictions);
  if (restrictions && restrictions.length > 2000) return res.status(400).json({ message: "The restrictions text is too long" });
  const signedByName = clean(b.signedByName);
  if (signedByName && signedByName.length > 120) return res.status(400).json({ message: "The name is too long" });
  const signatureImage = clean(b.signatureImage);
  if (signatureImage && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureImage) || signatureImage.length > 400000)) {
    return res.status(400).json({ message: "The signature image is not valid" });
  }

  const userId = currentUserId(req);
  const admin = await isAdminUser(req);
  const client = await pool.connect();
  const bad = async (code, message) => { await client.query("ROLLBACK"); return res.status(code).json({ message }); };
  try {
    await client.query("BEGIN");
    const jr = await client.query(JOB_SQL.replace("WHERE j.id = $1", "WHERE j.id = $1 FOR UPDATE OF j"), [jobId]);
    if (jr.rowCount === 0) return bad(404, "Job not found");
    const job = jr.rows[0];
    if (!job.hasInternal) return bad(409, "The internal inspection is not used in this department");
    if (job.status !== "IN_PROGRESS" || job.stageNo < job.internalStageNo) return bad(409, "This job is not ready for the internal inspection");

    const cur = await client.query("SELECT signed_at, signature_image FROM job_internal_check WHERE job_id = $1", [jobId]);
    if (cur.rows[0]?.signed_at && !admin) return bad(403, "The inspection is signed. Only the administrator can change it.");

    const items = await client.query("SELECT id, group_name, name FROM job_internal_check_item WHERE department_id = $1 AND is_active ORDER BY sort_order, id", [job.departmentId]);
    const valid = new Set(items.rows.map((i) => i.id));
    const checked = new Set(ids.filter((id) => valid.has(id)));

    if (complete) {
      if (checked.size !== items.rowCount) return bad(400, "Tick every item of the checklist");
      if (allGood !== true) return bad(400, "Select Yes for “Is everything good?”. If something is not good, fix it first.");
      if (!signedByName) return bad(400, "Select the Head");
      if (!signatureImage && !cur.rows[0]?.signature_image) return bad(400, "The Head must draw the signature");
    }

    await client.query(
      `INSERT INTO job_internal_check (job_id, all_good, restrictions, signed_by_name, signed_by_user, signed_at, signature_image, saved_by)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN $6::int END, CASE WHEN $5::boolean THEN CURRENT_TIMESTAMP END, CASE WHEN $5::boolean THEN $7 END, $6::int)
       ON CONFLICT (job_id) DO UPDATE SET
         all_good = EXCLUDED.all_good, restrictions = EXCLUDED.restrictions, signed_by_name = EXCLUDED.signed_by_name,
         signed_by_user = EXCLUDED.signed_by_user, signed_at = EXCLUDED.signed_at,
         signature_image = CASE WHEN $5::boolean THEN COALESCE($7, job_internal_check.signature_image) ELSE NULL END,
         saved_by = EXCLUDED.saved_by, updated_at = CURRENT_TIMESTAMP`,
      [jobId, allGood, restrictions, signedByName, complete, userId, signatureImage]
    );
    await client.query("DELETE FROM job_internal_check_result WHERE job_id = $1", [jobId]);
    for (const i of items.rows) {
      await client.query("INSERT INTO job_internal_check_result (job_id, item_id, group_name, item_name, checked) VALUES ($1, $2, $3, $4, $5)", [jobId, i.id, i.group_name, i.name, checked.has(i.id)]);
    }

    let stageNo = job.stageNo;
    if (complete && job.stageNo === job.internalStageNo) {
      const next = job.internalStageNo + 1;
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.internalStageNo, userId]);
      await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      stageNo = next;
    } else {
      await client.query("UPDATE job SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [jobId]);
    }
    await client.query("COMMIT");
    return res.json({ message: complete ? "Internal inspection completed" : "Saved", currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving the internal check:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

/* ================= edit the checklist (security: permission "internalcheck.manage") ================= */

// GET /departments/:id/internal-check-items -> every item, removed ones too
router.get("/departments/:id/internal-check-items", authenticateToken, requirePermission("internalcheck.manage"), async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(
      `SELECT id, group_name AS "groupName", name, is_active AS "isActive", sort_order AS "sortOrder"
         FROM job_internal_check_item WHERE department_id = $1 ORDER BY is_active DESC, sort_order, id`, [id]);
    return res.json({ items: r.rows });
  } catch (error) {
    console.error("internal-check-items:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /departments/:id/internal-check-items   { name, groupName? }   (a removed item with the same name is brought back)
router.post("/departments/:id/internal-check-items", authenticateToken, requirePermission("internalcheck.manage"), async (req, res) => {
  const id = toInt(req.params.id);
  const name = clean(req.body?.name);
  const groupName = clean(req.body?.groupName);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid department" });
  if (!name) return res.status(400).json({ message: "Enter the item" });
  if (name.length > 300 || (groupName && groupName.length > 100)) return res.status(400).json({ message: "The text is too long" });
  try {
    const dup = await pool.query("SELECT id, is_active FROM job_internal_check_item WHERE department_id = $1 AND lower(name) = lower($2)", [id, name]);
    if (dup.rowCount > 0) {
      if (dup.rows[0].is_active) return res.status(409).json({ message: "This item is already in the list" });
      await pool.query("UPDATE job_internal_check_item SET is_active = true, group_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [dup.rows[0].id, groupName]);
      return res.status(201).json({ message: "Item added back", id: dup.rows[0].id });
    }
    const r = await pool.query(
      `INSERT INTO job_internal_check_item (department_id, group_name, name, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) FROM job_internal_check_item WHERE department_id = $1), 0) + 1) RETURNING id`,
      [id, groupName, name]
    );
    return res.status(201).json({ message: "Item added", id: r.rows[0].id });
  } catch (error) {
    console.error("add internal-check-item:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /internal-check-items/:id   any of { name, groupName, isActive }   (isActive false = remove)
router.patch("/internal-check-items/:id", authenticateToken, requirePermission("internalcheck.manage"), async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid item" });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  try {
    const cur = await pool.query("SELECT department_id FROM job_internal_check_item WHERE id = $1", [id]);
    if (cur.rowCount === 0) return res.status(404).json({ message: "Item not found" });
    if ("name" in b) {
      const name = clean(b.name);
      if (!name) return res.status(400).json({ message: "Enter the item" });
      if (name.length > 300) return res.status(400).json({ message: "The text is too long" });
      const dup = await pool.query("SELECT 1 FROM job_internal_check_item WHERE department_id = $1 AND lower(name) = lower($2) AND id <> $3", [cur.rows[0].department_id, name, id]);
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
    await pool.query(`UPDATE job_internal_check_item SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${vals.length}`, vals);
    return res.json({ message: "Saved" });
  } catch (error) {
    console.error("update internal-check-item:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;