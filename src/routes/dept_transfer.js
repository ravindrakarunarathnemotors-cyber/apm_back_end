// "Transfer to other departments" stage (after "Review Team Inspection Sheet"):
//   "Transfer to other departments" Yes / No (default No). Yes -> ONE department is selected from a dropdown.
//   Yes -> a new linked job (same customer & vehicle) is created in that department; its own process starts at the complaint stage (5).
// Mount (same prefix as the other stage routes):  app.use("/evidence", require("./routes/dept_transfer.routes"));
// Needs create_dept_transfer.sql and express.json().
const express = require("express");
const router = express.Router();
// the file names differ between projects: the first one that exists is used
function tryLoad(paths) {
  for (const q of paths) {
    try { return require(q); } catch (e) { if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes(`'${q}'`)) throw e; }
  }
  return null;
}
const pool = tryLoad(["../config/db", "../db"]);
const authenticateToken = tryLoad(["../middleware/authMiddleware", "../middleware/authenticateToken"]);
if (!pool || !authenticateToken) throw new Error("dept_transfer: the db / auth middleware path is wrong (check the two require lines at the top)");
// Job number: the project's numbering helper when there is one (Settings > Numbering), otherwise the same JOB-00031 format the job creation uses
const numbering = tryLoad(["./numbering.helper", "./numbering", "../helpers/numbering.helper", "../utils/numbering"]);
const formatNo = numbering?.formatNo || (async (_db, kind, id) => `${kind === "job" ? "JOB-" : ""}${String(id).padStart(5, "0")}`);

const FIRST_DEPARTMENT_STAGE = 5;   // the new job starts at the complaint stage of its department

const currentUserId = (req) => {
  const n = Number(req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) ? n : null;
};
const toInt = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) ? n : NaN;
};

async function loadJob(db, jobId) {
  const r = await db.query(
    `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
            j.department_id AS "departmentId", d.name AS "departmentName",
            COALESCE(d.has_dept_transfer, false) AS "hasStage", d.dept_transfer_stage_no AS "thisStageNo",
            c.customer_name AS "customerName"
     FROM job j JOIN customer c ON c.id = j.customer_id LEFT JOIN department d ON d.id = j.department_id WHERE j.id = $1`, [jobId]);
  return r.rows[0] || null;
}
const reached = (job) => job.status === "IN_PROGRESS" && job.hasStage && job.thisStageNo && job.stageNo >= job.thisStageNo;

async function state(db, job) {
  const [deps, done, head] = await Promise.all([
    db.query(`SELECT id, name FROM department WHERE is_active AND show_in_job_stage AND id <> $1 ORDER BY sort_order, id`, [job.departmentId]),
    db.query(`SELECT t.department_id AS "departmentId", d.name AS "departmentName", t.transferred, t.new_job_id AS "newJobId", nj.job_no AS "newJobNo"
              FROM job_dept_transfer t JOIN department d ON d.id = t.department_id LEFT JOIN job nj ON nj.id = t.new_job_id WHERE t.job_id = $1`, [job.id]),
    db.query(`SELECT completed_at AS "completedAt", remark FROM job_dept_transfer_header WHERE job_id = $1`, [job.id]),
  ]);
  return {
    departments: deps.rows,       // the departments the job can be transferred to (one is selected)
    saved: done.rows,             // the transfer already made
    header: head.rows[0] || { completedAt: null, remark: null },
  };
}

// GET /jobs/:id/dept-transfer
router.get("/jobs/:id/dept-transfer", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const job = await loadJob(pool, jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.hasStage) return res.status(409).json({ message: `Department transfer is not used in the ${job.departmentName || "selected"} department` });
    const st = await state(pool, job);
    return res.json({ job, ...st, reached: reached(job), canRecord: reached(job) && !st.header.completedAt });
  } catch (e) { console.error("load dept transfer:", e.code, e.message); return res.status(500).json({ message: "Server error" }); }
});

// POST /jobs/:id/dept-transfer   { transfer: true|false, departmentId?, remark? }   (remark = optional note, max 1000 characters)
//   No  -> the stage completes without a transfer.
//   Yes -> exactly one department is selected; a linked job is created there and the stage completes.
router.post("/jobs/:id/dept-transfer", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  if (typeof req.body?.transfer !== "boolean") return res.status(400).json({ message: "Select Yes or No" });
  const transfer = req.body.transfer;
  const departmentId = toInt(req.body?.departmentId);
  const remark = String(req.body?.remark ?? "").trim() || null;
  if (remark && remark.length > 1000) return res.status(400).json({ message: "The remark is too long (max 1000 characters)" });
  if (transfer && !Number.isInteger(departmentId)) return res.status(400).json({ message: "Select the department" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await loadJob(client, jobId);
    if (!job) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Job not found" }); }
    if (!reached(job)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This job is not ready for the transfer stage" }); }
    const uid = currentUserId(req);
    await client.query("INSERT INTO job_dept_transfer_header (job_id) VALUES ($1) ON CONFLICT (job_id) DO NOTHING", [jobId]);
    const h = await client.query("SELECT completed_at FROM job_dept_transfer_header WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (h.rows[0].completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ message: "This stage is already completed" }); }

    const created = [];
    if (transfer) {
      const st = await state(client, job);
      if (!st.departments.some((d) => d.id === departmentId)) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Invalid department" }); }
      // the related department's process: a new linked job for the same customer & vehicle, department selected, starting at the complaint stage
      const seq = await client.query("SELECT nextval(pg_get_serial_sequence('job', 'id')) AS id");
      const newJobId = Number(seq.rows[0].id);
      const newJobNo = await formatNo(pool, "job", newJobId);
      await client.query(
        `INSERT INTO job
           (id, job_no, customer_id, vehicle_id, consultant_id, reg_no, year_of_manufacture, mileage_km,
            colour, chassis_no, engine_no, tyre_size, appointment_date, appointment_time, customer_matter, appointment_department_id, sales_officer, vehicle_type,
            department_id, current_stage_no, status, created_by, source_job_id)
         SELECT $1::int, $2, customer_id, vehicle_id, consultant_id, reg_no, year_of_manufacture, mileage_km,
                colour, chassis_no, engine_no, tyre_size, appointment_date, appointment_time, customer_matter, appointment_department_id, sales_officer, vehicle_type,
                $3::int, $4::int, 'IN_PROGRESS', $5::int, id
         FROM job WHERE id = $6::int`,
        [newJobId, newJobNo, departmentId, FIRST_DEPARTMENT_STAGE, uid, jobId]);
      await client.query(
        `INSERT INTO job_stage (job_id, stage_no, status, started_at, completed_at, completed_by)
         SELECT $1::int, stage_no,
                CASE WHEN stage_no < $2::int THEN 'COMPLETED' WHEN stage_no = $2::int THEN 'IN_PROGRESS' ELSE 'PENDING' END,
                CASE WHEN stage_no <= $2::int THEN CURRENT_TIMESTAMP END,
                CASE WHEN stage_no < $2::int THEN CURRENT_TIMESTAMP END,
                CASE WHEN stage_no < $2::int THEN $3::int END
         FROM job_stage_master`,
        [newJobId, FIRST_DEPARTMENT_STAGE, uid]);
      await client.query("INSERT INTO job_dept_transfer (job_id, department_id, transferred, new_job_id, decided_by) VALUES ($1, $2, true, $3, $4) ON CONFLICT (job_id, department_id) DO UPDATE SET transferred = true, new_job_id = EXCLUDED.new_job_id, decided_by = EXCLUDED.decided_by, decided_at = CURRENT_TIMESTAMP", [jobId, departmentId, newJobId, uid]);
      created.push({ departmentId, jobId: newJobId, jobNo: newJobNo });
    }

    await client.query("UPDATE job_dept_transfer_header SET completed_at = CURRENT_TIMESTAMP, completed_by = $2, remark = $3 WHERE job_id = $1", [jobId, uid, remark]);
    let stageNo = job.stageNo;
    if (job.stageNo === job.thisStageNo) {
      const next = job.thisStageNo + 1;
      await client.query(`UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3 WHERE job_id = $1 AND stage_no = $2`, [jobId, job.thisStageNo, uid]);
      const has = await client.query("SELECT 1 FROM job_stage_master WHERE stage_no = $1", [next]);   // the last stage has no next one
      if (has.rowCount > 0) {
        await client.query(`UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP WHERE job_id = $1 AND stage_no = $2`, [jobId, next]);
        await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
        stageNo = next;
      }
    }
    await client.query("COMMIT");
    return res.json({ message: created.length ? "Transferred" : "Completed", created, currentStageNo: stageNo, stageCompleted: stageNo !== job.stageNo });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("dept transfer:", e.code, e.message);
    return res.status(500).json({ message: "Server error" });
  } finally { client.release(); }
});

module.exports = router;