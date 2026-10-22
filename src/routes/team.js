const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");
const { formatPhoneNumber, getBrandingSetting, insertAdminlogs } = require("../models/userModels")
const bcrypt = require("bcrypt");
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { customhookInvoice, sendProvisioningEmailPostmark, customhookQuotation } = require("../models/smstempmodels");
const { Client } = require('ssh2');
const CryptoJS = require('crypto-js');
const axios = require('axios');
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const S3Service = require('./s3Service');

dayjs.extend(utc);
dayjs.extend(timezone);


const router = express.Router();

const TEAM_STAGE_NO = 6;

// Who can add / edit / activate / deactivate teams and bays:  []  = every logged-in user,  [1] = only role_id 1
const MANAGE_ROLE_IDS = [];

/* ----------------------------- helpers ----------------------------- */
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
const toBool = (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);

async function canManage(req) {
  if (MANAGE_ROLE_IDS.length === 0) return true;
  const n = currentUserId(req);
  if (!n) return false;
  const r = await pool.query("SELECT role_id FROM admin_user WHERE id = $1", [n]);
  return r.rowCount > 0 && MANAGE_ROLE_IDS.includes(Number(r.rows[0].role_id));
}
const manageOnly = async (req, res, next) => {
  try {
    if (await canManage(req)) return next();
    return res.status(403).json({ message: "You do not have permission to manage teams and bays" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---- teams with their people (leader / sub leader / members from the HR employee table) ----
const shapeTeam = (t) => {
  const members = t.members || [];
  const leader = members.find((m) => m.role === "LEADER");
  const sub = members.find((m) => m.role === "SUB_LEADER");
  const { oldLeaderName, ...rest } = t;
  return {
    ...rest,
    members,
    leaderId: leader?.employeeId ?? null,
    leaderName: leader?.name ?? oldLeaderName ?? "", // old teams only have the typed leader name
    subLeaderId: sub?.employeeId ?? null,
    subLeaderName: sub?.name ?? "",
    memberIds: members.filter((m) => m.role === "MEMBER").map((m) => m.employeeId),
  };
};

// all teams of a department (or just one team when teamId is given)
async function loadTeams(db, departmentId, teamId = null) {
  const r = await db.query(
    `SELECT t.id, t.department_id AS "departmentId", t.name, t.is_active AS "isActive", t.leader_name AS "oldLeaderName",
            t.bay_id AS "bayId", (SELECT bb.name FROM department_bay bb WHERE bb.id = t.bay_id) AS "bayName",
            COALESCE((
              SELECT json_agg(json_build_object('employeeId', m.employee_id, 'name', e.full_name,
                                                'employeeNo', e.employee_no, 'role', m.role)
                              ORDER BY CASE m.role WHEN 'LEADER' THEN 1 WHEN 'SUB_LEADER' THEN 2 ELSE 3 END, e.full_name)
              FROM department_team_member m JOIN employee e ON e.id = m.employee_id
              WHERE m.team_id = t.id
            ), '[]'::json) AS members
     FROM department_team t
     WHERE t.department_id = $1 AND ($2::int IS NULL OR t.id = $2)
     ORDER BY t.is_active DESC, t.name`,
    [departmentId, teamId]
  );
  return r.rows.map(shapeTeam);
}
const BAY_COLS = `id, department_id AS "departmentId", name, sort_order AS "sortOrder", is_active AS "isActive"`;

/* ================= Teams and Bays of a department (Manage window) ================= */
// GET /api/team-department/:name  -> { id, name, hasTeamAllocation }
// The dashboard only knows the department NAME ("Mechanical"). It uses this to get the id and to decide
// whether to show the "Teams & Bays" button (only departments with has_team_allocation = true).
router.get("/team-department/:name", authenticateToken, async (req, res) => {
  const name = clean(req.params.name);
  if (!name) return res.status(400).json({ message: "Invalid department" });
  try {
    const r = await pool.query(
      `SELECT id, name, COALESCE(has_team_allocation, false) AS "hasTeamAllocation"
       FROM department WHERE lower(name) = lower($1) AND is_active`,
      [name]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    return res.json({ ...r.rows[0], canManage: await canManage(req) });
  } catch (error) {
    console.error("Error loading department:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/departments/:id/teams-bays  -> every team and bay (active + inactive)
router.get("/departments/:id/teams-bays", authenticateToken, async (req, res) => {
  const departmentId = toInt(req.params.id);
  if (!Number.isInteger(departmentId)) return res.status(400).json({ message: "Invalid department" });
  try {
    const [teams, bays] = await Promise.all([
      loadTeams(pool, departmentId),
      pool.query(`SELECT ${BAY_COLS} FROM department_bay WHERE department_id = $1 ORDER BY sort_order, id`, [departmentId]),
    ]);
    return res.json({ canManage: await canManage(req), teams, bays: bays.rows });
  } catch (error) {
    console.error("Error loading teams and bays:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

const idList = (v) => (Array.isArray(v) ? v : []).map((x) => toInt(x));

const readTeam = (b) => {
  const name = clean(b.name);
  const leaderId = toInt(b.leaderId);
  const subLeaderId = toInt(b.subLeaderId);
  const memberIds = [...new Set(idList(b.memberIds))];
  if (!name) return { error: "Team name is required" };
  if (name.length > 100) return { error: "Team name is too long (max 100 characters)" };
  if (!Number.isInteger(leaderId)) return { error: "Select the team leader" };
  if (Number.isNaN(subLeaderId)) return { error: "Invalid sub leader" };
  if (memberIds.some((x) => !Number.isInteger(x))) return { error: "Invalid team member" };
  if (subLeaderId !== null && subLeaderId === leaderId) return { error: "The sub leader must be a different person than the team leader" };
  if (memberIds.includes(leaderId) || (subLeaderId !== null && memberIds.includes(subLeaderId))) {
    return { error: "The leader and the sub leader cannot also be listed as team members" };
  }
  // default bay of the team: an existing bay (bayId), or a NEW bay created together with the team (newBayName)
  const hasBay = Object.prototype.hasOwnProperty.call(b, "bayId") || Object.prototype.hasOwnProperty.call(b, "newBayName");
  const newBayName = clean(b.newBayName);
  const bayId = b.bayId === null || b.bayId === undefined || b.bayId === "" ? null : toInt(b.bayId);
  if (Number.isNaN(bayId)) return { error: "Invalid bay" };
  if (newBayName && newBayName.length > 50) return { error: "Bay name is too long (max 50 characters)" };
  return { v: { name, leaderId, subLeaderId, memberIds, isActive: toBool(b.isActive) ?? true, hasBay, bayId, newBayName } };
};

// every selected person must be an existing, not resigned employee. Returns the leader's name.
async function checkPeople(client, v) {
  const ids = [v.leaderId, ...(v.subLeaderId !== null ? [v.subLeaderId] : []), ...v.memberIds];
  const r = await client.query("SELECT id, full_name FROM employee WHERE id = ANY($1::int[]) AND status <> 'Resigned'", [ids]);
  if (r.rowCount !== ids.length) return { error: "Every selected person must be an existing employee who has not resigned" };
  return { leaderName: r.rows.find((x) => x.id === v.leaderId).full_name };
}

// the default bay of a team. Returns { bayId } (null = none) or { error, status }.
// - newBayName: creates the bay (active, at the end of the list) in the same transaction
// - bayId: must be a bay of this department; an inactive bay is only accepted if the team already has it
async function resolveBay(client, departmentId, v, currentBayId) {
  if (!v.hasBay) return { bayId: currentBayId ?? null }; // not sent: keep as it is
  if (v.newBayName) {
    const dup = await client.query("SELECT 1 FROM department_bay WHERE department_id = $1 AND lower(name) = lower($2)", [departmentId, v.newBayName]);
    if (dup.rowCount > 0) return { error: `A bay named "${v.newBayName}" already exists`, status: 409 };
    const ins = await client.query(
      `INSERT INTO department_bay (department_id, name, sort_order, is_active)
       VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) FROM department_bay WHERE department_id = $1), 0) + 1, true) RETURNING id`,
      [departmentId, v.newBayName]
    );
    return { bayId: ins.rows[0].id };
  }
  if (v.bayId === null) return { bayId: null };
  const bay = await client.query("SELECT id, is_active FROM department_bay WHERE id = $1 AND department_id = $2", [v.bayId, departmentId]);
  if (bay.rowCount === 0 || (!bay.rows[0].is_active && v.bayId !== currentBayId)) return { error: "Invalid bay", status: 400 };
  return { bayId: v.bayId };
}

// replaces the people of a team (leader, sub leader, members)
async function saveMembers(client, teamId, v) {
  await client.query("DELETE FROM department_team_member WHERE team_id = $1", [teamId]);
  const rows = [[v.leaderId, "LEADER"], ...(v.subLeaderId !== null ? [[v.subLeaderId, "SUB_LEADER"]] : []), ...v.memberIds.map((id) => [id, "MEMBER"])];
  for (const [employeeId, role] of rows) {
    await client.query("INSERT INTO department_team_member (team_id, employee_id, role) VALUES ($1, $2, $3)", [teamId, employeeId, role]);
  }
}

// POST /api/departments/:id/teams   { name, leaderId, subLeaderId?, memberIds?: [], bayId? | newBayName?, isActive? }
router.post("/departments/:id/teams", authenticateToken, manageOnly, async (req, res) => {
  const departmentId = toInt(req.params.id);
  if (!Number.isInteger(departmentId)) return res.status(400).json({ message: "Invalid department" });
  const { error, v } = readTeam(req.body || {});
  if (error) return res.status(400).json({ message: error });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dep = await client.query("SELECT 1 FROM department WHERE id = $1", [departmentId]);
    if (dep.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Department not found" });
    }
    const same = await client.query("SELECT 1 FROM department_team WHERE department_id = $1 AND lower(name) = lower($2)", [departmentId, v.name]);
    if (same.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "A team with this name already exists in this department" });
    }
    const people = await checkPeople(client, v);
    if (people.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: people.error });
    }

    const bayRes = await resolveBay(client, departmentId, v, null);
    if (bayRes.error) {
      await client.query("ROLLBACK");
      return res.status(bayRes.status).json({ message: bayRes.error });
    }

    const ins = await client.query(
      "INSERT INTO department_team (department_id, name, leader_name, is_active, bay_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [departmentId, v.name, people.leaderName, v.isActive, bayRes.bayId]
    );
    await saveMembers(client, ins.rows[0].id, v);
    await client.query("COMMIT");

    const [team] = await loadTeams(pool, departmentId, ins.rows[0].id);
    return res.status(201).json({ message: "Team added successfully", team });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    if (error.code === "23505") return res.status(409).json({ message: "A team with this name already exists in this department" });
    console.error("Error adding team:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

// PUT /api/teams/:id   { name, leaderId, subLeaderId?, memberIds?: [], isActive }
router.put("/teams/:id", authenticateToken, manageOnly, async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid team" });
  const { error, v } = readTeam(req.body || {});
  if (error) return res.status(400).json({ message: error });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT department_id, bay_id FROM department_team WHERE id = $1 FOR UPDATE", [id]);
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Team not found" });
    }
    const departmentId = cur.rows[0].department_id;
    const same = await client.query(
      "SELECT 1 FROM department_team WHERE department_id = $1 AND lower(name) = lower($2) AND id <> $3",
      [departmentId, v.name, id]
    );
    if (same.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "A team with this name already exists in this department" });
    }
    const people = await checkPeople(client, v);
    if (people.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: people.error });
    }

    const bayRes = await resolveBay(client, departmentId, v, cur.rows[0].bay_id);
    if (bayRes.error) {
      await client.query("ROLLBACK");
      return res.status(bayRes.status).json({ message: bayRes.error });
    }

    await client.query(
      "UPDATE department_team SET name = $1, leader_name = $2, is_active = $3, bay_id = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5",
      [v.name, people.leaderName, v.isActive, bayRes.bayId, id]
    );
    await saveMembers(client, id, v);
    await client.query("COMMIT");

    const [team] = await loadTeams(pool, departmentId, id);
    return res.json({ message: "Team updated successfully", team });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    if (error.code === "23505") return res.status(409).json({ message: "A team with this name already exists in this department" });
    console.error("Error updating team:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

const readBay = (b) => {
  const name = clean(b.name);
  const sortRaw = clean(b.sortOrder);
  const sortOrder = sortRaw === null ? null : Number(sortRaw);
  if (!name) return { error: "Bay name is required" };
  if (name.length > 50) return { error: "Bay name is too long (max 50 characters)" };
  if (sortOrder !== null && !Number.isInteger(sortOrder)) return { error: "Sort order must be a whole number" };
  return { v: { name, sortOrder, isActive: toBool(b.isActive) ?? true } };
};

// POST /api/departments/:id/bays   { name, sortOrder?, isActive? }
router.post("/departments/:id/bays", authenticateToken, manageOnly, async (req, res) => {
  const departmentId = toInt(req.params.id);
  if (!Number.isInteger(departmentId)) return res.status(400).json({ message: "Invalid department" });
  const { error, v } = readBay(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const dep = await pool.query("SELECT 1 FROM department WHERE id = $1", [departmentId]);
    if (dep.rowCount === 0) return res.status(404).json({ message: "Department not found" });
    const same = await pool.query("SELECT 1 FROM department_bay WHERE department_id = $1 AND lower(name) = lower($2)", [departmentId, v.name]);
    if (same.rowCount > 0) return res.status(409).json({ message: "A bay with this name already exists in this department" });

    // no sort order given -> put it at the end
    const r = await pool.query(
      `INSERT INTO department_bay (department_id, name, sort_order, is_active)
       VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM department_bay WHERE department_id = $1)), $4)
       RETURNING ${BAY_COLS}`,
      [departmentId, v.name, v.sortOrder, v.isActive]
    );
    return res.status(201).json({ message: "Bay added successfully", bay: r.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ message: "A bay with this name already exists in this department" });
    console.error("Error adding bay:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/bays/:id   { name, sortOrder?, isActive }
router.put("/bays/:id", authenticateToken, manageOnly, async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid bay" });
  const { error, v } = readBay(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const cur = await pool.query("SELECT department_id FROM department_bay WHERE id = $1", [id]);
    if (cur.rowCount === 0) return res.status(404).json({ message: "Bay not found" });
    const same = await pool.query(
      "SELECT 1 FROM department_bay WHERE department_id = $1 AND lower(name) = lower($2) AND id <> $3",
      [cur.rows[0].department_id, v.name, id]
    );
    if (same.rowCount > 0) return res.status(409).json({ message: "A bay with this name already exists in this department" });

    const r = await pool.query(
      `UPDATE department_bay SET name = $1, sort_order = COALESCE($2, sort_order), is_active = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING ${BAY_COLS}`,
      [v.name, v.sortOrder, v.isActive, id]
    );
    return res.json({ message: "Bay updated successfully", bay: r.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ message: "A bay with this name already exists in this department" });
    console.error("Error updating bay:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* ================= Stage 6: Team Allocation of a job ================= */
// GET /api/jobs/:id/team-allocation
//   -> job, the department's teams and bays (inactive bays are included so they can be shown as "Inactive"),
//      and the saved allocation (null if none yet)
router.get("/jobs/:id/team-allocation", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });
  try {
    const jobRes = await pool.query(
      `SELECT j.id, j.job_no AS "jobNo", j.reg_no AS "regNo", j.status, j.current_stage_no AS "stageNo",
              j.department_id AS "departmentId", d.name AS "departmentName",
              COALESCE(d.has_team_allocation, false) AS "hasTeamAllocation"
       FROM job j LEFT JOIN department d ON d.id = j.department_id
       WHERE j.id = $1`,
      [jobId]
    );
    if (jobRes.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const job = jobRes.rows[0];
    if (!job.departmentId) return res.status(409).json({ message: "This job has no department yet" });
    if (!job.hasTeamAllocation) return res.status(409).json({ message: `Team allocation is not used in the ${job.departmentName} department` });

    const [teams, bays, saved] = await Promise.all([
      loadTeams(pool, job.departmentId),
      pool.query(`SELECT ${BAY_COLS} FROM department_bay WHERE department_id = $1 ORDER BY sort_order, id`, [job.departmentId]),
      pool.query(
        `SELECT team_id AS "teamId", team_name AS "teamName", bay_id AS "bayId", bay_name AS "bayName",
                team_leader_name AS "teamLeaderName", team_leader_id AS "teamLeaderId",
                sub_leader_id AS "subLeaderId", sub_leader_name AS "subLeaderName", ppe_used AS "ppeUsed",
                vehicle_protection_applied AS "vehicleProtectionApplied", updated_at AS "updatedAt"
         FROM job_team_allocation WHERE job_id = $1`,
        [jobId]
      ),
    ]);

    return res.json({
      job,
      teamStageNo: TEAM_STAGE_NO,
      canAllocate: job.status === "IN_PROGRESS" && job.stageNo >= TEAM_STAGE_NO,
      canManage: await canManage(req),
      teams,
      bays: bays.rows,
      allocation: saved.rows[0] || null,
    });
  } catch (error) {
    console.error("Error loading team allocation:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/jobs/:id/team-allocation
//   { teamId, bayId, teamLeaderId, subLeaderId?, ppeUsed (true/false), vehicleProtectionApplied (true/false) }
// Saves the allocation. When the job is at stage 6 the stage is completed and the job moves to stage 7.
router.put("/jobs/:id/team-allocation", authenticateToken, async (req, res) => {
  const jobId = toInt(req.params.id);
  if (!Number.isInteger(jobId)) return res.status(400).json({ message: "Invalid job" });

  const b = req.body || {};
  const teamId = toInt(b.teamId);
  const bayId = toInt(b.bayId);
  const leaderId = toInt(b.teamLeaderId);
  const subLeaderId = b.subLeaderId === null || b.subLeaderId === undefined || b.subLeaderId === "" ? null : toInt(b.subLeaderId);
  const ppe = toBool(b.ppeUsed);
  const protection = toBool(b.vehicleProtectionApplied);

  if (!Number.isInteger(teamId)) return res.status(400).json({ message: "Select the team" });
  if (!Number.isInteger(bayId)) return res.status(400).json({ message: "Select the bay" });
  if (!Number.isInteger(leaderId)) return res.status(400).json({ message: "Select the team leader" });
  if (subLeaderId !== null && !Number.isInteger(subLeaderId)) return res.status(400).json({ message: "Invalid sub leader" });
  if (subLeaderId !== null && subLeaderId === leaderId) return res.status(400).json({ message: "Sub leader must be a different person than the team leader" });
  if (ppe === null) return res.status(400).json({ message: "Answer: Personal Protective Equipment (Yes / No)" });
  if (protection === null) return res.status(400).json({ message: "Answer: Customer Vehicle Protection applied (Yes / No)" });

  const userId = currentUserId(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jobRes = await client.query(
      `SELECT j.id, j.status, j.current_stage_no, j.department_id, COALESCE(d.has_team_allocation, false) AS has_team
       FROM job j LEFT JOIN department d ON d.id = j.department_id
       WHERE j.id = $1 FOR UPDATE OF j`,
      [jobId]
    );
    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jobRes.rows[0];
    if (!job.has_team) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Team allocation is not used in this department" });
    }
    if (job.status !== "IN_PROGRESS" || !job.department_id || job.current_stage_no < TEAM_STAGE_NO) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This job is not ready for team allocation" });
    }

    // what was saved before (an inactive team / bay that is already saved may stay)
    const prev = await client.query("SELECT team_id, bay_id FROM job_team_allocation WHERE job_id = $1", [jobId]);
    const prevTeam = prev.rows[0]?.team_id ?? null;
    const prevBay = prev.rows[0]?.bay_id ?? null;

    const team = await client.query("SELECT id, name, is_active FROM department_team WHERE id = $1 AND department_id = $2", [teamId, job.department_id]);
    if (team.rowCount === 0 || (!team.rows[0].is_active && teamId !== prevTeam)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid team" });
    }
    const bay = await client.query("SELECT id, name, is_active FROM department_bay WHERE id = $1 AND department_id = $2", [bayId, job.department_id]);
    if (bay.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid bay" });
    }
    if (!bay.rows[0].is_active && bayId !== prevBay) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: `${bay.rows[0].name} is inactive and cannot be selected` });
    }

    // leader / sub leader of THIS job (any employee who has not resigned; may differ from the team's defaults)
    const peopleIds = subLeaderId !== null ? [leaderId, subLeaderId] : [leaderId];
    const people = await client.query("SELECT id, full_name FROM employee WHERE id = ANY($1::int[]) AND status <> 'Resigned'", [peopleIds]);
    if (people.rowCount !== peopleIds.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Team leader and sub leader must be existing employees who have not resigned" });
    }
    const leader = people.rows.find((x) => x.id === leaderId).full_name;
    const subLeader = subLeaderId !== null ? people.rows.find((x) => x.id === subLeaderId).full_name : null;

    await client.query(
      `INSERT INTO job_team_allocation
         (job_id, team_id, team_name, bay_id, bay_name, team_leader_name, team_leader_id, sub_leader_id, sub_leader_name,
          ppe_used, vehicle_protection_applied, allocated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (job_id) DO UPDATE SET
         team_id = EXCLUDED.team_id, team_name = EXCLUDED.team_name,
         bay_id = EXCLUDED.bay_id, bay_name = EXCLUDED.bay_name,
         team_leader_name = EXCLUDED.team_leader_name, team_leader_id = EXCLUDED.team_leader_id,
         sub_leader_id = EXCLUDED.sub_leader_id, sub_leader_name = EXCLUDED.sub_leader_name, ppe_used = EXCLUDED.ppe_used,
         vehicle_protection_applied = EXCLUDED.vehicle_protection_applied,
         allocated_by = EXCLUDED.allocated_by, updated_at = CURRENT_TIMESTAMP`,
      [jobId, teamId, team.rows[0].name, bayId, bay.rows[0].name, leader, leaderId, subLeaderId, subLeader, ppe, protection, userId]
    );

    // Complete stage 6 and move to stage 7 (only the first time; later edits keep the stage)
    let currentStageNo = job.current_stage_no;
    if (job.current_stage_no === TEAM_STAGE_NO) {
      const next = TEAM_STAGE_NO + 1;
      await client.query(
        `UPDATE job_stage SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $3
         WHERE job_id = $1 AND stage_no = $2`,
        [jobId, TEAM_STAGE_NO, userId]
      );
      await client.query(
        `UPDATE job_stage SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP
         WHERE job_id = $1 AND stage_no = $2`,
        [jobId, next]
      );
      await client.query("UPDATE job SET current_stage_no = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [next, jobId]);
      currentStageNo = next;
    } else {
      await client.query("UPDATE job SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [jobId]);
    }

    await client.query("COMMIT");
    return res.json({ message: "Team allocated", currentStageNo });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.error("Error saving team allocation:", error.code, error.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

module.exports = router;