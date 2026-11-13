// routes/wash_invoice.helper.js   (NEW file, next to the route files)
// The invoice of a Wash job is created when the job is STARTED (Start Job in the Wash department) and every charge that comes up
// later is added to the same invoice (no second invoice):
//   * the Wash type(s) chosen in the complaint stage            (invoice lines  source "W<jobId>")
//   * the fluids / filters found in the Drying Area stage       (invoice lines  source "D<jobId>")
// syncWashInvoice() is safe to call again and again: it REPLACES only its own lines, so nothing is ever doubled.
// A Wash job that was transferred from another job (source_job_id) adds its lines to the invoice of the main job.
// Needs from invoice.routes.js (add these 4 lines at its very end):
//   module.exports.createInvoice = createInvoice;        // (already there)
//   module.exports.replaceLines = replaceLines;
//   module.exports.recalc = recalc;
//   module.exports.rootJobId = rootJobId;
function tryLoad(paths) {
  for (const q of paths) {
    try { return require(q); } catch (e) { if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes(`'${q}'`)) throw e; }
  }
  return null;
}
const pool = tryLoad(["../config/db", "../db"]);
const inv = () => tryLoad(["./invoice.routes", "./invoice"]);

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const short = (s) => String(s).slice(0, 300);

async function washLines(db, jobId) {
  const r = await db.query(
    `SELECT o.list_title AS "listTitle", o.group_name AS "groupName", o.option_name AS name, o.price::float AS price
       FROM job_complaint_option o JOIN job_complaint jc ON jc.id = o.job_complaint_id WHERE jc.job_id = $1 AND COALESCE(o.price, 0) > 0 ORDER BY o.id`, [jobId]);
  return r.rows.map((o) => ({ kind: "WASH", description: short(`${o.listTitle ? `${o.listTitle}: ` : ""}${o.groupName ? `${o.groupName} › ` : ""}${o.name}`), qty: 1, amount: r2(o.price) }));
}

async function dryingLines(db, jobId) {
  const out = [];
  try {
    const f = await db.query(`SELECT fluid_name AS name, action, litres::float AS litres, amount::float AS amount FROM job_drying_fluid WHERE job_id = $1 AND amount > 0 ORDER BY id`, [jobId]);
    for (const x of f.rows) out.push({ kind: "OTHER", description: short(`${x.name} - ${x.action} (${x.litres} L)`), qty: 1, amount: r2(x.amount) });
    const t = await db.query(
      `SELECT f.kind, f.action, f.part_name AS "partName", f.price::float AS price, COALESCE(t.label, f.kind) AS label
         FROM job_drying_filter f LEFT JOIN drying_filter_type t ON t.kind = f.kind WHERE f.job_id = $1 AND f.action IS NOT NULL AND f.price > 0 ORDER BY f.id`, [jobId]);
    for (const x of t.rows) {
      out.push(x.action === "REPLACE"
        ? { kind: "PART", description: short(`${x.label} - replaced${x.partName ? ` (${x.partName})` : ""}`), qty: 1, amount: r2(x.price) }
        : { kind: "OTHER", description: short(`${x.label} - cleaned`), qty: 1, amount: r2(x.price) });
    }
  } catch (_) { /* the drying area tables are not installed */ }
  return out;
}

// -> { ok: true, invoiceId } | { ok: false, reason }.  Never throws: a problem with the invoice must never break a stage.
async function syncWashInvoice(jobId, userId = null) {
  const m = inv();
  if (!pool || !m?.createInvoice || !m?.replaceLines || !m?.recalc || !m?.rootJobId) {
    console.error("syncWashInvoice: add `module.exports.replaceLines / recalc / rootJobId` at the end of invoice.routes.js");
    return { ok: false, reason: "invoice routes exports missing" };
  }
  const client = await pool.connect();
  try {
    const j = await client.query(
      `SELECT j.id, d.name AS dept, jc.start_confirmed_at AS "startedAt"
         FROM job j LEFT JOIN department d ON d.id = j.department_id LEFT JOIN job_complaint jc ON jc.job_id = j.id WHERE j.id = $1`, [jobId]);
    const job = j.rows[0];
    if (!job || !/^wash/i.test(job.dept || "")) return { ok: false, reason: "not a Wash job" };
    const wl = await washLines(client, jobId);
    const dl = await dryingLines(client, jobId);
    const root = await m.rootJobId(client, jobId);
    if (!root) return { ok: false, reason: "job not found" };

    await client.query("BEGIN");
    let id;
    const existing = await client.query("SELECT id, status FROM invoice WHERE job_id = $1 FOR UPDATE", [root]);
    if (existing.rowCount) {
      id = existing.rows[0].id;
      if (existing.rows[0].status === "CANCELLED") { await client.query("ROLLBACK"); return { ok: false, reason: "invoice cancelled" }; }
    } else {
      // the invoice is created when the job starts; a transferred job never creates one (the main job's invoice is used)
      if (root !== jobId || !job.startedAt) { await client.query("ROLLBACK"); return { ok: false, reason: "not started yet" }; }
      id = await m.createInvoice(client, root, userId, true, { lines: [], completed: true });
    }
    if (!id) { await client.query("ROLLBACK"); return { ok: false, reason: "invoice not created" }; }
    await m.replaceLines(client, id, `W${jobId}`, wl);
    await m.replaceLines(client, id, `D${jobId}`, dl);
    await m.recalc(client, id);
    await client.query("COMMIT");
    return { ok: true, invoiceId: id };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("syncWashInvoice:", e.code, e.message);
    return { ok: false, reason: e.message };
  } finally {
    client.release();
  }
}

module.exports = { syncWashInvoice };