const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();

const BAY_STAGE_NO = 6;

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
const BAY_COLS = `id, department_id AS "departmentId", name, sort_order AS "sortOrder", is_active AS "isActive"`;

// GET /bay-department/:name -> { id, name, hasBayAllocation }   (the dashboard knows the department NAME only)
router.get("/bay-department/:name", authenticateToken, async (req, res) => {
  const name = clean(req.params.name);
  if (!name) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(
      `SELECT id, name, COALESCE(has_bay_allocation, false) AS "hasBayAllocation" FROM department WHERE lower(name) = lower($1) AND is_active`,
      [name]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    return res.json(r.rows[0]);
  } catch (error) {
    console.error("Error loading bay department:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /jobs/:id/bay-allocation -> job, the department's bays (inactive ones included, shown as "Inactive"), saved allocation
router.get("/jobs/:id/bay-allocation", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const jobRes = await pool.query(
      `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
              j.department_id AS "departmentId", d.name AS "departmentName", COALESCE(d.has_bay_allocation, false) AS "hasBayAllocation"
       FROM job j LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`,
      [jobId]
    );
    if (jobRes.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const job = jobRes.rows[0];
    if (!job.departmentId) return res.status(409).json({ message: "This job has no department yet" });
    if (!job.hasBayAllocation) return res.status(409).json({ message: `Bay allocation is not used in the ${job.departmentName} department` });

    const [bays, saved] = await Promise.all([
      pool.query(`SELECT ${BAY_COLS} FROM department_bay WHERE department_id = $1 ORDER BY sort_order, id`, [job.departmentId]),
      pool.query(`SELECT bay_id AS "bayId", bay_name AS "bayName", updated_at AS "updatedAt" FROM job_bay_allocation WHERE job_id = $1`, [jobId]),
    ]);
    return res.json({
      job,
      bayStageNo: BAY_STAGE_NO,
      canAllocate: job.status === "IN_PROGRESS" && job.stageNo >= BAY_STAGE_NO,
      bays: bays.rows,
      allocation: saved.rows[0] || null,
    });
  } catch (error) {
    console.error("Error loading bay allocation:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /jobs/:id/bay-allocation   { bayId }
// Saves the bay. At stage 6 the stage is completed and the job moves to stage 7.
router.put("/jobs/:id/bay-allocation", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  const bayId = toInt(req.body?.bayId);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  if (!Number.isInteger(bayId)) return res.status(400).json({ message: "Select the bay" });

  const userId = currentUserId(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobRes = await client.query(
      `SELECT j.id, j.status, j.current_stage_no, j.department_id, COALESCE(d.has_bay_allocation, false) AS has_bay
       FROM job j LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1 FOR UPDATE OF j`,
      [jobId]
    );
    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jobRes.rows[0];
    if (!job.has_bay) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Bay allocation is not used in this department" });
    }
    if (job.status !== "IN_PROGRESS" || !job.department_id || job.current_stage_no < BAY_STAGE_NO) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This job is not ready for bay allocation" });
    }

    const prev = await client.query("SELECT bay_id FROM job_bay_allocation WHERE job_id = $1", [jobId]);
    const prevBay = prev.rows[0]?.bay_id ?? null;
    const bay = await client.query("SELECT id, name, is_active FROM department_bay WHERE id = $1 AND department_id = $2", [bayId, job.department_id]);
    if (bay.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid bay" });
    }
    if (!bay.rows[0].is_active && bayId !== prevBay) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: `${bay.rows[0].name} is inactive and cannot be selected` });
    }

    await client.query(
      `INSERT INTO job_bay_allocation (job_id, bay_id, bay_name, allocated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_id) DO UPDATE SET bay_id = EXCLUDED.bay_id, bay_name = EXCLUDED.bay_name, allocated_by = EXCLUDED.allocated_by, updated_at = CURRENT_TIMESTAMP`,
      [jobId, bayId, bay.rows[0].name, userId]
    );

    let currentStageNo = job.current_stage_no;
    if (job.current_stage_no === BAY_STAGE_NO) {
      const next = BAY_STAGE_NO + 1;
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, BAY_STAGE_NO, userId]);
      await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      currentStageNo = next;
    } else {
      await client.query("UPDATE job SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [jobId]);
    }
    await client.query("COMMIT");
    return res.json({ message: "Bay allocated", currentStageNo });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving bay allocation:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

module.exports = router;