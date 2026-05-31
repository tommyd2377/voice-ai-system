import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_LOCAL_FLOWPATH_DB = path.resolve(__dirname, '../../flowpath/data/flowpath.db');
const LEGACY_LOCAL_TASKDECK_DB = path.resolve(__dirname, '../../taskdeck/data/taskdeck.db');
const LEGACY_LOCAL_NEEDLE_DB = path.resolve(__dirname, '../../needle.ai/data/needle.db');
const DEFAULT_TIMEZONE = 'America/New_York';
const MAX_LIMIT = 25;
const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'ignored'];
const PROJECT_STATUSES = ['active', 'paused', 'someday', 'done'];
const SITUATION_STATUSES = ['active', 'resolved', 'archived'];
const SITUATION_URGENCIES = ['low', 'medium', 'high', 'crisis'];
const PRIORITY_LEVELS = ['low', 'medium', 'high'];
const TASK_FRICTION_TYPES = [
  'none',
  'unclear',
  'too_large',
  'scary',
  'blocked',
  'low_energy',
  'needs_person',
  'not_important',
  'admin_drag',
];

let client = null;
let clientConfig = null;

const getOwnerUserId = () => {
  const parsed = Number.parseInt(process.env.FLOWPATH_OWNER_LOCAL_USER_ID || '1', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

const normalizeValue = (value) => {
  if (typeof value === 'bigint') return Number(value);
  return value;
};

const rowToObject = (row, columns) => {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return Object.fromEntries(
      columns.map((column) => [column, normalizeValue(row[column])])
    );
  }

  return Object.fromEntries(
    columns.map((column, index) => [column, normalizeValue(row[index])])
  );
};

const clampLimit = (value, fallback = 10) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
};

const nowIso = () => new Date().toISOString();

const todayIsoDate = () => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIMEZONE || DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
};

const textOrDefault = (value, fallback = '', maxLength = 4000) => {
  if (value == null) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  return text.slice(0, maxLength);
};

const nullableText = (value, maxLength = 4000) => {
  const text = textOrDefault(value, '', maxLength);
  return text || null;
};

const optionalDate = (value) => {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error('dueDate must use YYYY-MM-DD.');
  }
  return text;
};

const positiveInteger = (value, name) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
};

const integerInRange = (value, name, min, max, fallback) => {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return parsed;
};

const enumValue = (value, allowed, fallback, name) => {
  if (value == null || value === '') return fallback;
  if (allowed.includes(value)) return value;
  throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
};

const booleanValue = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === 'yes') return true;
    if (lower === 'false' || lower === 'no') return false;
  }
  return fallback;
};

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

const nullablePositiveInteger = (value, name) => {
  if (value == null || value === '') return null;
  return positiveInteger(value, name);
};

const jsonText = (value, fallback) => {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(fallback);
    }
  }
  return JSON.stringify(value ?? fallback);
};

const safeJsonParse = (value, fallback) => {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export function getTaskDeckDatabaseUrl() {
  const configured =
    process.env.FLOWPATH_DATABASE_URL ||
    process.env.TASKDECK_DATABASE_URL ||
    process.env.NEEDLE_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (configured) return configured;

  if (existsSync(DEFAULT_LOCAL_FLOWPATH_DB)) {
    return `file:${DEFAULT_LOCAL_FLOWPATH_DB}`;
  }

  if (existsSync(LEGACY_LOCAL_TASKDECK_DB)) {
    return `file:${LEGACY_LOCAL_TASKDECK_DB}`;
  }

  if (existsSync(LEGACY_LOCAL_NEEDLE_DB)) {
    return `file:${LEGACY_LOCAL_NEEDLE_DB}`;
  }

  return null;
}

function getTaskDeckAuthToken() {
  return (
    process.env.FLOWPATH_DATABASE_AUTH_TOKEN ||
    process.env.FLOWPATH_TURSO_AUTH_TOKEN ||
    process.env.TASKDECK_DATABASE_AUTH_TOKEN ||
    process.env.TASKDECK_TURSO_AUTH_TOKEN ||
    process.env.NEEDLE_DATABASE_AUTH_TOKEN ||
    process.env.NEEDLE_TURSO_AUTH_TOKEN ||
    process.env.TURSO_AUTH_TOKEN ||
    process.env.LIBSQL_AUTH_TOKEN ||
    undefined
  );
}

function getClient() {
  const databaseUrl = getTaskDeckDatabaseUrl();
  if (!databaseUrl) {
    throw new Error('FLOWPATH_DATABASE_URL is not configured and the local Flowpath database was not found.');
  }

  const authToken = getTaskDeckAuthToken();
  if (!client || clientConfig?.databaseUrl !== databaseUrl || clientConfig?.authToken !== authToken) {
    client = createClient({
      url: databaseUrl,
      authToken,
    });
    clientConfig = { databaseUrl, authToken };
  }

  return client;
}

export function resetTaskDeckDataClientForTests() {
  client = null;
  clientConfig = null;
}

async function all(sql, args) {
  const result = await getClient().execute({ sql, args });
  return result.rows.map((row) => rowToObject(row, result.columns));
}

async function first(sql, args) {
  const rows = await all(sql, args);
  return rows[0] || null;
}

async function run(sql, args) {
  return getClient().execute({ sql, args });
}

async function insert(sql, args) {
  const result = await run(sql, args);
  return Number(result.lastInsertRowid);
}

async function getCounts() {
  const ownerUserId = getOwnerUserId();
  const rows = await all(
    `SELECT 'open_tasks' AS name, COUNT(*) AS count FROM tasks WHERE user_id = ? AND status = 'open'
    UNION ALL SELECT 'active_projects', COUNT(*) FROM projects WHERE user_id = ? AND status = 'active'
    UNION ALL SELECT 'active_situations', COUNT(*) FROM situations WHERE user_id = ? AND status = 'active'
    UNION ALL SELECT 'life_areas', COUNT(*) FROM life_areas WHERE user_id = ?
    UNION ALL SELECT 'recent_checkins', COUNT(*) FROM checkins WHERE user_id = ?
    UNION ALL SELECT 'next_move_plans', COUNT(*) FROM next_move_plans WHERE user_id = ?`,
    [ownerUserId, ownerUserId, ownerUserId, ownerUserId, ownerUserId, ownerUserId]
  );

  return Object.fromEntries(rows.map((row) => [row.name, row.count]));
}

async function resolveLifeAreaId({ lifeAreaId, lifeAreaName } = {}) {
  const ownerUserId = getOwnerUserId();
  if (lifeAreaId != null && lifeAreaId !== '') {
    const id = positiveInteger(lifeAreaId, 'lifeAreaId');
    const lifeArea = await first('SELECT id FROM life_areas WHERE id = ? AND user_id = ?', [id, ownerUserId]);
    if (!lifeArea) throw new Error(`No Flowpath life area exists with id ${id}.`);
    return id;
  }

  const name = nullableText(lifeAreaName, 120);
  if (!name) return null;

  const lifeArea = await first(
    'SELECT id FROM life_areas WHERE user_id = ? AND name = ? COLLATE NOCASE LIMIT 1',
    [ownerUserId, name]
  );
  if (!lifeArea) throw new Error(`No Flowpath life area exists named "${name}".`);
  return lifeArea.id;
}

async function resolveProject({ projectId, projectName } = {}) {
  const ownerUserId = getOwnerUserId();
  if (projectId != null && projectId !== '') {
    const id = positiveInteger(projectId, 'projectId');
    const project = await first('SELECT id, life_area_id FROM projects WHERE id = ? AND user_id = ?', [id, ownerUserId]);
    if (!project) throw new Error(`No Flowpath project exists with id ${id}.`);
    return project;
  }

  const name = nullableText(projectName, 160);
  if (!name) return null;

  const project = await first(
    'SELECT id, life_area_id FROM projects WHERE user_id = ? AND name = ? COLLATE NOCASE LIMIT 1',
    [ownerUserId, name]
  );
  if (!project) throw new Error(`No Flowpath project exists named "${name}".`);
  return project;
}

async function resolveSituation({ situationId } = {}) {
  const ownerUserId = getOwnerUserId();
  const id = nullablePositiveInteger(situationId, 'situationId');
  if (!id) return null;

  const situation = await first('SELECT id, title FROM situations WHERE id = ? AND user_id = ?', [
    id,
    ownerUserId,
  ]);
  if (!situation) throw new Error(`No Flowpath situation exists with id ${id}.`);
  return situation;
}

async function resolveNextMovePlan({ nextMovePlanId, situationId } = {}) {
  const ownerUserId = getOwnerUserId();
  const id = nullablePositiveInteger(nextMovePlanId, 'nextMovePlanId');
  if (!id) return null;

  const plan = await first('SELECT * FROM next_move_plans WHERE id = ? AND user_id = ?', [id, ownerUserId]);
  if (!plan) throw new Error(`No Flowpath Next Move plan exists with id ${id}.`);

  const expectedSituationId = nullablePositiveInteger(situationId, 'situationId');
  if (expectedSituationId && plan.situation_id !== expectedSituationId) {
    throw new Error(`Next Move plan ${id} belongs to situation ${plan.situation_id}, not situation ${expectedSituationId}.`);
  }

  return plan;
}

async function ensureOwnedCheckIn(checkInId) {
  const ownerUserId = getOwnerUserId();
  const id = nullablePositiveInteger(checkInId, 'checkInId');
  if (!id) return null;

  const checkIn = await first('SELECT id FROM checkins WHERE id = ? AND user_id = ?', [id, ownerUserId]);
  if (!checkIn) throw new Error(`No Flowpath check-in exists with id ${id}.`);
  return id;
}

async function getTask(taskId) {
  const ownerUserId = getOwnerUserId();
  return first(
    `SELECT
      tasks.*,
      life_areas.name AS life_area_name,
      projects.name AS project_name,
      situations.title AS situation_title
    FROM tasks
    LEFT JOIN life_areas ON life_areas.id = tasks.life_area_id AND life_areas.user_id = tasks.user_id
    LEFT JOIN projects ON projects.id = tasks.project_id AND projects.user_id = tasks.user_id
    LEFT JOIN situations ON situations.id = tasks.situation_id AND situations.user_id = tasks.user_id
    WHERE tasks.id = ? AND tasks.user_id = ?`,
    [taskId, ownerUserId]
  );
}

async function getPlan(planId) {
  const ownerUserId = getOwnerUserId();
  return first('SELECT * FROM plans WHERE id = ? AND user_id = ?', [planId, ownerUserId]);
}

async function getNextMovePlan(planId) {
  const ownerUserId = getOwnerUserId();
  return first(
    `SELECT
      next_move_plans.*,
      situations.title AS situation_title
    FROM next_move_plans
    LEFT JOIN situations ON situations.id = next_move_plans.situation_id AND situations.user_id = next_move_plans.user_id
    WHERE next_move_plans.id = ? AND next_move_plans.user_id = ?`,
    [planId, ownerUserId]
  );
}

export async function getTaskDeckBriefing(input = {}) {
  const ownerUserId = getOwnerUserId();
  const topic = enumValue(
    input.topic,
    ['everything', 'tasks', 'projects', 'situations', 'today', 'memory'],
    'everything',
    'topic'
  );
  const limit = clampLimit(input.limit, 10);
  const includeCompletedTasks = Boolean(input.includeCompletedTasks);

  const counts = await getCounts();
  const profile = await first('SELECT * FROM profile WHERE user_id = ? LIMIT 1', [ownerUserId]);
  const lifeAreas =
    topic === 'everything' || topic === 'projects' || topic === 'memory'
      ? await all(
          `SELECT * FROM life_areas
          WHERE user_id = ?
          ORDER BY
            CASE priority_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
            name COLLATE NOCASE
          LIMIT ?`,
          [ownerUserId, limit]
        )
      : [];

  const activeProjects =
    topic === 'everything' || topic === 'projects' || topic === 'today'
      ? await all(
          `SELECT projects.*, life_areas.name AS life_area_name
          FROM projects
          LEFT JOIN life_areas ON life_areas.id = projects.life_area_id AND life_areas.user_id = projects.user_id
          WHERE projects.user_id = ? AND projects.status = 'active'
          ORDER BY projects.updated_at DESC, projects.name COLLATE NOCASE
          LIMIT ?`,
          [ownerUserId, limit]
        )
      : [];

  const taskWhere = includeCompletedTasks
    ? 'WHERE tasks.user_id = ?'
    : "WHERE tasks.user_id = ? AND tasks.status = 'open'";
  const tasks =
    topic === 'everything' || topic === 'tasks' || topic === 'today'
      ? await all(
          `SELECT
            tasks.*,
            life_areas.name AS life_area_name,
            projects.name AS project_name,
            situations.title AS situation_title
          FROM tasks
          LEFT JOIN life_areas ON life_areas.id = tasks.life_area_id AND life_areas.user_id = tasks.user_id
          LEFT JOIN projects ON projects.id = tasks.project_id AND projects.user_id = tasks.user_id
          LEFT JOIN situations ON situations.id = tasks.situation_id AND situations.user_id = tasks.user_id
          ${taskWhere}
          ORDER BY
            CASE tasks.status WHEN 'open' THEN 1 WHEN 'ignored' THEN 2 ELSE 3 END,
            tasks.importance DESC,
            tasks.effort ASC,
            tasks.created_at DESC
          LIMIT ?`,
          [ownerUserId, limit]
        )
      : [];

  const situations =
    topic === 'everything' || topic === 'situations' || topic === 'today'
      ? await all(
          `SELECT
            situations.*,
            latest_plan.id AS latest_plan_id,
            latest_plan.mode AS latest_plan_mode,
            json_extract(latest_plan.highest_leverage_move_json, '$.title') AS latest_plan_move
          FROM situations
          LEFT JOIN next_move_plans latest_plan ON latest_plan.id = (
            SELECT id FROM next_move_plans
            WHERE user_id = situations.user_id AND situation_id = situations.id
            ORDER BY created_at DESC
            LIMIT 1
          )
          WHERE situations.user_id = ? AND situations.status = 'active'
          ORDER BY
            CASE situations.urgency WHEN 'crisis' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
            situations.updated_at DESC
          LIMIT ?`,
          [ownerUserId, limit]
        )
      : [];

  const recentNextMovePlans =
    topic === 'everything' || topic === 'situations' || topic === 'today'
      ? await all(
          `SELECT
            next_move_plans.id,
            next_move_plans.situation_id,
            situations.title AS situation_title,
            next_move_plans.mode,
            next_move_plans.situation_summary,
            next_move_plans.core_bottleneck,
            json_extract(next_move_plans.highest_leverage_move_json, '$.title') AS highest_leverage_move,
            next_move_plans.created_at
          FROM next_move_plans
          LEFT JOIN situations ON situations.id = next_move_plans.situation_id AND situations.user_id = next_move_plans.user_id
          WHERE next_move_plans.user_id = ?
          ORDER BY next_move_plans.created_at DESC
          LIMIT ?`,
          [ownerUserId, limit]
        )
      : [];

  const recentCheckIns =
    topic === 'everything' || topic === 'today'
      ? await all(
          `SELECT * FROM checkins
          WHERE user_id = ?
          ORDER BY checkin_date DESC, created_at DESC
          LIMIT ?`,
          [ownerUserId, Math.min(limit, 5)]
        )
      : [];

  const recentDailyPlans =
    topic === 'everything' || topic === 'today'
      ? await all(
          `SELECT
            id,
            plan_date,
            today_theme,
            honest_read,
            top_3_actions_json,
            avoid_today,
            minimum_viable_day,
            created_at
          FROM plans
          WHERE user_id = ?
          ORDER BY plan_date DESC, created_at DESC
          LIMIT ?`,
          [ownerUserId, Math.min(limit, 5)]
        )
      : [];

  return {
    ok: true,
    topic,
    today: todayIsoDate(),
    counts,
    profile,
    lifeAreas,
    activeProjects,
    tasks,
    activeSituations: situations,
    recentNextMovePlans,
    recentCheckIns,
    recentDailyPlans,
  };
}

export async function createTaskDeckTask(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const title = textOrDefault(input.title, '', 220);
  if (!title) throw new Error('title is required.');

  const project = await resolveProject(input);
  const explicitLifeAreaId = await resolveLifeAreaId(input);
  const nextMovePlan = await resolveNextMovePlan(input);
  const situation = await resolveSituation({
    situationId: input.situationId ?? nextMovePlan?.situation_id ?? null,
  });
  const lifeAreaId = explicitLifeAreaId ?? project?.life_area_id ?? null;
  const status = enumValue(input.status, TASK_STATUSES, 'open', 'status');
  const importance = integerInRange(input.importance, 'importance', 1, 5, 3);
  const effort = integerInRange(input.effort, 'effort', 1, 5, 3);
  const estimatedMinutes = integerInRange(input.estimatedMinutes, 'estimatedMinutes', 1, 480, null);
  const dueDate = optionalDate(input.dueDate);
  const notes = textOrDefault(input.notes, '', 5000);
  const sourcePlanSection = nullableText(input.sourcePlanSection, 120);
  const frictionType = enumValue(input.frictionType, TASK_FRICTION_TYPES, 'none', 'frictionType');
  const frictionNote = textOrDefault(input.frictionNote, '', 1200);
  const now = nowIso();

  const taskId = await insert(
    `INSERT INTO tasks (
      user_id, title, life_area_id, project_id, status, importance, effort, due_date, notes,
      situation_id, source_next_move_plan_id, source_plan_section, friction_type, friction_note,
      estimated_minutes, is_qa, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      ownerUserId,
      title,
      lifeAreaId,
      project?.id ?? null,
      status,
      importance,
      effort,
      dueDate,
      notes,
      situation?.id ?? null,
      nextMovePlan?.id ?? null,
      sourcePlanSection,
      frictionType,
      frictionNote,
      estimatedMinutes,
      now,
      now,
    ]
  );

  return {
    ok: true,
    task: await getTask(taskId),
  };
}

export async function createTaskDeckCallerIntakeTask(input = {}) {
  if (input.confirmedByCaller !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const subject = textOrDefault(input.subject, 'Voice message', 160);
  const messageBody = textOrDefault(input.messageBody, '', 5000);
  if (!messageBody) throw new Error('messageBody is required.');

  const callerName = nullableText(input.callerName, 80);
  const contactPhone = nullableText(input.contactPhone, 80);
  const contactEmail = nullableText(input.contactEmail, 160);
  const callerId = nullableText(input.callerId, 80);
  const callSid = nullableText(input.callSid, 120);
  const capturedAt = nullableText(input.capturedAt, 80) || nowIso();
  const callbackRequested = booleanValue(input.callbackRequested, false);
  const priority = enumValue(input.priority, ['low', 'normal', 'high'], 'normal', 'priority');
  const importanceByPriority = { low: 2, normal: 3, high: 4 };
  const now = nowIso();

  const titlePrefix = callerName ? `Follow up with ${callerName}` : 'Caller message';
  const title = textOrDefault(`${titlePrefix}: ${subject}`, 'Caller message', 220);
  const notes = [
    'Caller intake captured by Victoria.',
    `Subject: ${subject}`,
    `Priority: ${priority}`,
    `Callback requested: ${callbackRequested ? 'yes' : 'no'}`,
    callerName ? `Caller name: ${callerName}` : null,
    contactPhone ? `Contact phone: ${contactPhone}` : null,
    contactEmail ? `Contact email: ${contactEmail}` : null,
    callerId ? `Caller ID: ${callerId}` : null,
    callSid ? `CallSid: ${callSid}` : null,
    `Captured at: ${capturedAt}`,
    '',
    'Message:',
    messageBody,
  ]
    .filter((line) => line != null)
    .join('\n');

  const taskId = await insert(
    `INSERT INTO tasks (
      user_id, title, life_area_id, project_id, status, importance, effort, due_date, notes, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, 'open', ?, 2, NULL, ?, ?, ?)`,
    [ownerUserId, title, importanceByPriority[priority], notes, now, now]
  );

  return {
    ok: true,
    channel: 'taskdeck_task',
    task: await getTask(taskId),
  };
}

export async function updateTaskDeckTask(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const taskId = positiveInteger(input.taskId, 'taskId');
  const existing = await getTask(taskId);
  if (!existing) throw new Error(`No Flowpath task exists with id ${taskId}.`);

  const updates = [];
  const args = [];

  if (hasOwn(input, 'title')) {
    const title = textOrDefault(input.title, '', 220);
    if (!title) throw new Error('title cannot be blank.');
    updates.push('title = ?');
    args.push(title);
  }

  if (hasOwn(input, 'status')) {
    updates.push('status = ?');
    args.push(enumValue(input.status, TASK_STATUSES, existing.status, 'status'));
  }

  if (hasOwn(input, 'importance')) {
    updates.push('importance = ?');
    args.push(integerInRange(input.importance, 'importance', 1, 5, existing.importance));
  }

  if (hasOwn(input, 'effort')) {
    updates.push('effort = ?');
    args.push(integerInRange(input.effort, 'effort', 1, 5, existing.effort));
  }

  if (hasOwn(input, 'dueDate')) {
    updates.push('due_date = ?');
    args.push(optionalDate(input.dueDate));
  }

  if (hasOwn(input, 'notes')) {
    updates.push('notes = ?');
    args.push(textOrDefault(input.notes, '', 5000));
  }

  if (hasOwn(input, 'frictionType')) {
    updates.push('friction_type = ?');
    args.push(enumValue(input.frictionType, TASK_FRICTION_TYPES, existing.friction_type || 'none', 'frictionType'));
  }

  if (hasOwn(input, 'frictionNote')) {
    updates.push('friction_note = ?');
    args.push(textOrDefault(input.frictionNote, '', 1200));
  }

  if (hasOwn(input, 'estimatedMinutes')) {
    updates.push('estimated_minutes = ?');
    args.push(integerInRange(input.estimatedMinutes, 'estimatedMinutes', 1, 480, null));
  }

  if (hasOwn(input, 'sourcePlanSection')) {
    updates.push('source_plan_section = ?');
    args.push(nullableText(input.sourcePlanSection, 120));
  }

  if (hasOwn(input, 'projectId') || hasOwn(input, 'projectName')) {
    const project = await resolveProject(input);
    updates.push('project_id = ?');
    args.push(project?.id ?? null);

    if (!hasOwn(input, 'lifeAreaId') && !hasOwn(input, 'lifeAreaName') && project?.life_area_id) {
      updates.push('life_area_id = ?');
      args.push(project.life_area_id);
    }
  }

  if (hasOwn(input, 'lifeAreaId') || hasOwn(input, 'lifeAreaName')) {
    updates.push('life_area_id = ?');
    args.push(await resolveLifeAreaId(input));
  }

  if (hasOwn(input, 'nextMovePlanId')) {
    const nextMovePlan = await resolveNextMovePlan(input);
    updates.push('source_next_move_plan_id = ?');
    args.push(nextMovePlan?.id ?? null);

    if (nextMovePlan && !hasOwn(input, 'situationId')) {
      updates.push('situation_id = ?');
      args.push(nextMovePlan.situation_id);
    }
  }

  if (hasOwn(input, 'situationId')) {
    const situation = await resolveSituation(input);
    const nextMovePlan = hasOwn(input, 'nextMovePlanId')
      ? await resolveNextMovePlan(input)
      : existing.source_next_move_plan_id
        ? await resolveNextMovePlan({ nextMovePlanId: existing.source_next_move_plan_id })
        : null;

    if (!situation && nextMovePlan) {
      throw new Error(`Task linked to Next Move plan ${nextMovePlan.id} must stay attached to situation ${nextMovePlan.situation_id}.`);
    }

    if (situation && nextMovePlan && nextMovePlan.situation_id !== situation.id) {
      throw new Error(`Task cannot attach to situation ${situation.id} while linked to Next Move plan ${nextMovePlan.id}.`);
    }

    updates.push('situation_id = ?');
    args.push(situation?.id ?? null);
  }

  if (updates.length === 0) {
    return { ok: true, task: existing, changed: false };
  }

  updates.push('updated_at = ?');
  args.push(nowIso(), taskId, ownerUserId);

  await run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, args);

  return {
    ok: true,
    task: await getTask(taskId),
    changed: true,
  };
}

export async function createTaskDeckCheckIn(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  if (input.energyLevel == null || input.energyLevel === '') {
    throw new Error('energyLevel is required.');
  }
  const energyLevel = integerInRange(input.energyLevel, 'energyLevel', 1, 10, null);
  const id = await insert(
    `INSERT INTO checkins (
      user_id, checkin_date, energy_level, mood, sleep, health_status,
      main_thing, resistance, brain_dump, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerUserId,
      todayIsoDate(),
      energyLevel,
      textOrDefault(input.mood, '', 1000),
      textOrDefault(input.sleep, '', 1000),
      textOrDefault(input.healthStatus, '', 1500),
      textOrDefault(input.mainThing, '', 4000),
      textOrDefault(input.resistance, '', 4000),
      textOrDefault(input.brainDump, '', 8000),
      nowIso(),
    ]
  );

  return {
    ok: true,
    checkIn: await first('SELECT * FROM checkins WHERE id = ? AND user_id = ?', [id, ownerUserId]),
  };
}

export async function createTaskDeckSituation(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const title = textOrDefault(input.title, '', 180);
  if (!title) throw new Error('title is required.');

  const category = textOrDefault(input.category, 'custom', 120);
  const urgency = enumValue(input.urgency, ['low', 'medium', 'high', 'crisis'], 'medium', 'urgency');
  const now = nowIso();
  const situationId = await insert(
    `INSERT INTO situations (user_id, title, category, status, urgency, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    [ownerUserId, title, category, urgency, now, now]
  );

  const sessionId = await insert(
    `INSERT INTO intake_sessions (
      user_id, situation_id, current_stage, is_complete, summary_so_far, created_at, updated_at
    ) VALUES (?, ?, 'understanding_goals', 0, ?, ?, ?)`,
    [ownerUserId, situationId, textOrDefault(input.summary, '', 5000), now, now]
  );

  await insert(
    `INSERT INTO intake_messages (user_id, session_id, role, content, created_at)
    VALUES (?, ?, 'assistant', ?, ?)`,
    [
      ownerUserId,
      sessionId,
      'What do you most want to change about this situation, and what would feel meaningfully different if Flowpath helped you make progress?',
      now,
    ]
  );

  return {
    ok: true,
    situation: await first('SELECT * FROM situations WHERE id = ? AND user_id = ?', [situationId, ownerUserId]),
    session: await first('SELECT * FROM intake_sessions WHERE id = ? AND user_id = ?', [sessionId, ownerUserId]),
  };
}

export async function getTaskDeckRecord(input = {}) {
  const ownerUserId = getOwnerUserId();
  if (!input.recordType) throw new Error('recordType is required.');
  const recordType = enumValue(
    input.recordType,
    ['task', 'project', 'life_area', 'situation', 'checkin', 'daily_plan', 'next_move_plan'],
    null,
    'recordType'
  );
  const id = positiveInteger(input.id, 'id');

  const tableByType = {
    project: 'projects',
    life_area: 'life_areas',
    situation: 'situations',
    checkin: 'checkins',
  };

  let record;
  switch (recordType) {
    case 'task':
      record = await getTask(id);
      break;
    case 'daily_plan':
      record = await getPlan(id);
      break;
    case 'next_move_plan':
      record = await getNextMovePlan(id);
      break;
    default:
      record = await first(`SELECT * FROM ${tableByType[recordType]} WHERE id = ? AND user_id = ?`, [
        id,
        ownerUserId,
      ]);
  }

  return {
    ok: Boolean(record),
    recordType,
    record,
    reason: record ? null : 'not_found',
  };
}

export async function createTaskDeckProject(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const name = textOrDefault(input.name, '', 160);
  if (!name) throw new Error('name is required.');

  const lifeAreaId = await resolveLifeAreaId(input);
  const status = enumValue(input.status, PROJECT_STATUSES, 'active', 'status');
  const now = nowIso();
  const projectId = await insert(
    `INSERT INTO projects (
      user_id, name, life_area_id, status, description, next_milestone, current_bottleneck,
      why_it_matters, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerUserId,
      name,
      lifeAreaId,
      status,
      textOrDefault(input.description, '', 5000),
      textOrDefault(input.nextMilestone, '', 3000),
      textOrDefault(input.currentBottleneck, '', 3000),
      textOrDefault(input.whyItMatters, '', 3000),
      now,
      now,
    ]
  );

  return {
    ok: true,
    project: await first(
      `SELECT projects.*, life_areas.name AS life_area_name
      FROM projects
      LEFT JOIN life_areas ON life_areas.id = projects.life_area_id AND life_areas.user_id = projects.user_id
      WHERE projects.id = ? AND projects.user_id = ?`,
      [projectId, ownerUserId]
    ),
  };
}

export async function updateTaskDeckProject(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const projectId = positiveInteger(input.projectId, 'projectId');
  const existing = await first('SELECT * FROM projects WHERE id = ? AND user_id = ?', [projectId, ownerUserId]);
  if (!existing) throw new Error(`No Flowpath project exists with id ${projectId}.`);

  const updates = [];
  const args = [];
  if (hasOwn(input, 'name')) {
    const name = textOrDefault(input.name, '', 160);
    if (!name) throw new Error('name cannot be blank.');
    updates.push('name = ?');
    args.push(name);
  }
  if (hasOwn(input, 'lifeAreaId') || hasOwn(input, 'lifeAreaName')) {
    updates.push('life_area_id = ?');
    args.push(await resolveLifeAreaId(input));
  }
  if (hasOwn(input, 'status')) {
    updates.push('status = ?');
    args.push(enumValue(input.status, PROJECT_STATUSES, existing.status, 'status'));
  }
  if (hasOwn(input, 'description')) {
    updates.push('description = ?');
    args.push(textOrDefault(input.description, '', 5000));
  }
  if (hasOwn(input, 'nextMilestone')) {
    updates.push('next_milestone = ?');
    args.push(textOrDefault(input.nextMilestone, '', 3000));
  }
  if (hasOwn(input, 'currentBottleneck')) {
    updates.push('current_bottleneck = ?');
    args.push(textOrDefault(input.currentBottleneck, '', 3000));
  }
  if (hasOwn(input, 'whyItMatters')) {
    updates.push('why_it_matters = ?');
    args.push(textOrDefault(input.whyItMatters, '', 3000));
  }

  if (updates.length === 0) return { ok: true, project: existing, changed: false };

  updates.push('updated_at = ?');
  args.push(nowIso(), projectId, ownerUserId);
  await run(`UPDATE projects SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, args);

  return {
    ok: true,
    project: await first('SELECT * FROM projects WHERE id = ? AND user_id = ?', [projectId, ownerUserId]),
    changed: true,
  };
}

export async function createTaskDeckLifeArea(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const name = textOrDefault(input.name, '', 120);
  if (!name) throw new Error('name is required.');

  const now = nowIso();
  const lifeAreaId = await insert(
    `INSERT INTO life_areas (
      user_id, name, description, priority_level, desired_outcome, current_bottleneck, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerUserId,
      name,
      textOrDefault(input.description, '', 4000),
      enumValue(input.priorityLevel, PRIORITY_LEVELS, 'medium', 'priorityLevel'),
      textOrDefault(input.desiredOutcome, '', 4000),
      textOrDefault(input.currentBottleneck, '', 4000),
      now,
      now,
    ]
  );

  return {
    ok: true,
    lifeArea: await first('SELECT * FROM life_areas WHERE id = ? AND user_id = ?', [lifeAreaId, ownerUserId]),
  };
}

export async function updateTaskDeckLifeArea(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const lifeAreaId = positiveInteger(input.lifeAreaId, 'lifeAreaId');
  const existing = await first('SELECT * FROM life_areas WHERE id = ? AND user_id = ?', [lifeAreaId, ownerUserId]);
  if (!existing) throw new Error(`No Flowpath life area exists with id ${lifeAreaId}.`);

  const updates = [];
  const args = [];
  if (hasOwn(input, 'name')) {
    const name = textOrDefault(input.name, '', 120);
    if (!name) throw new Error('name cannot be blank.');
    updates.push('name = ?');
    args.push(name);
  }
  if (hasOwn(input, 'description')) {
    updates.push('description = ?');
    args.push(textOrDefault(input.description, '', 4000));
  }
  if (hasOwn(input, 'priorityLevel')) {
    updates.push('priority_level = ?');
    args.push(enumValue(input.priorityLevel, PRIORITY_LEVELS, existing.priority_level, 'priorityLevel'));
  }
  if (hasOwn(input, 'desiredOutcome')) {
    updates.push('desired_outcome = ?');
    args.push(textOrDefault(input.desiredOutcome, '', 4000));
  }
  if (hasOwn(input, 'currentBottleneck')) {
    updates.push('current_bottleneck = ?');
    args.push(textOrDefault(input.currentBottleneck, '', 4000));
  }

  if (updates.length === 0) return { ok: true, lifeArea: existing, changed: false };

  updates.push('updated_at = ?');
  args.push(nowIso(), lifeAreaId, ownerUserId);
  await run(`UPDATE life_areas SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, args);

  return {
    ok: true,
    lifeArea: await first('SELECT * FROM life_areas WHERE id = ? AND user_id = ?', [lifeAreaId, ownerUserId]),
    changed: true,
  };
}

export async function updateTaskDeckSituation(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const situationId = positiveInteger(input.situationId, 'situationId');
  const existing = await first('SELECT * FROM situations WHERE id = ? AND user_id = ?', [
    situationId,
    ownerUserId,
  ]);
  if (!existing) throw new Error(`No Flowpath situation exists with id ${situationId}.`);

  const updates = [];
  const args = [];
  if (hasOwn(input, 'title')) {
    const title = textOrDefault(input.title, '', 180);
    if (!title) throw new Error('title cannot be blank.');
    updates.push('title = ?');
    args.push(title);
  }
  if (hasOwn(input, 'description')) {
    updates.push('description = ?');
    args.push(textOrDefault(input.description, '', 8000));
  }
  if (hasOwn(input, 'category')) {
    updates.push('category = ?');
    args.push(textOrDefault(input.category, 'custom', 120));
  }
  if (hasOwn(input, 'urgency')) {
    updates.push('urgency = ?');
    args.push(enumValue(input.urgency, SITUATION_URGENCIES, existing.urgency, 'urgency'));
  }
  if (hasOwn(input, 'status')) {
    updates.push('status = ?');
    args.push(enumValue(input.status, SITUATION_STATUSES, existing.status, 'status'));
  }

  if (updates.length === 0) return { ok: true, situation: existing, changed: false };

  updates.push('updated_at = ?');
  args.push(nowIso(), situationId, ownerUserId);
  await run(`UPDATE situations SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, args);

  return {
    ok: true,
    situation: await first('SELECT * FROM situations WHERE id = ? AND user_id = ?', [situationId, ownerUserId]),
    changed: true,
  };
}

export async function createTaskDeckDailyPlan(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const todayTheme = textOrDefault(input.todayTheme, '', 220);
  if (!todayTheme) throw new Error('todayTheme is required.');

  const top3Actions = Array.isArray(input.top3Actions)
    ? input.top3Actions.slice(0, 3)
    : [{ title: textOrDefault(input.top3Actions, 'Voice-captured action', 160) }];
  const checkInId = await ensureOwnedCheckIn(input.checkInId);
  const planDate = optionalDate(input.planDate) || todayIsoDate();
  const raw = {
    today_theme: todayTheme,
    honest_read: textOrDefault(input.honestRead, '', 1800),
    top_3_actions: top3Actions,
    avoid_today: textOrDefault(input.avoidToday, '', 1200),
    optional_if_energy_is_high: textOrDefault(input.optionalIfEnergyIsHigh, '', 1200),
    minimum_viable_day: textOrDefault(input.minimumViableDay, '', 1200),
    evening_review_prompt: textOrDefault(input.eveningReviewPrompt, '', 1200),
  };

  const planId = await insert(
    `INSERT INTO plans (
      user_id, plan_date, checkin_id, model, today_theme, honest_read, top_3_actions_json,
      recommendation_basis_json, restraint_guidance_json, friction_pattern,
      operator_insight_json, local_reality_scout_json, human_help_boundary, avoid_today,
      optional_if_energy_is_high, minimum_viable_day, evening_review_prompt, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerUserId,
      planDate,
      checkInId,
      'voice-manual',
      raw.today_theme,
      raw.honest_read,
      JSON.stringify(top3Actions),
      jsonText(input.recommendationBasis, []),
      jsonText(input.restraintGuidance, {
        should_push: true,
        reason: 'Manually captured by Victoria.',
        minimum_viable_move: raw.minimum_viable_day || 'Do the smallest useful action.',
        recovery_move: 'Protect recovery if energy drops.',
        scope_boundary: 'Keep this plan bounded to today.',
      }),
      textOrDefault(input.frictionPattern, 'Manually captured by Victoria.', 1400),
      jsonText(input.operatorInsight, {
        naive_path: 'Keep everything in your head.',
        operator_path: 'Use the confirmed plan as the working surface for today.',
        wasted_motion_to_avoid: 'Do not expand the plan before acting.',
      }),
      jsonText(input.localRealityScout, {
        used_web_search: false,
        location_basis: '',
        findings: [],
        missing_location_question: '',
      }),
      textOrDefault(input.humanHelpBoundary, 'Use appropriate human help if this exceeds planning support.', 1600),
      raw.avoid_today,
      raw.optional_if_energy_is_high,
      raw.minimum_viable_day,
      raw.evening_review_prompt,
      JSON.stringify(raw),
      nowIso(),
    ]
  );

  return {
    ok: true,
    dailyPlan: await getPlan(planId),
  };
}

function normalizePlanTaskRows(plan) {
  const taskCandidates = safeJsonParse(plan.task_candidates_json, []);
  if (Array.isArray(taskCandidates) && taskCandidates.length > 0) {
    return taskCandidates.slice(0, 3).map((candidate) => ({
      title: textOrDefault(candidate?.title, 'Next Move task', 220),
      details: [
        textOrDefault(candidate?.details, '', 4000),
        candidate?.rank_reason ? `Why ranked: ${textOrDefault(candidate.rank_reason, '', 1000)}` : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      section: textOrDefault(candidate?.candidate_type, 'task_candidate', 120),
      importance: integerInRange(candidate?.importance, 'importance', 1, 5, 3),
      effort: integerInRange(candidate?.effort, 'effort', 1, 5, 3),
      frictionType: enumValue(candidate?.friction_type, TASK_FRICTION_TYPES, 'none', 'frictionType'),
      estimatedMinutes: integerInRange(candidate?.estimated_minutes, 'estimatedMinutes', 1, 480, null),
      dueDate: optionalDate(candidate?.due_date),
    }));
  }

  const fallbackSections = [
    ['first_30_minutes', safeJsonParse(plan.first_30_minutes_json, [])],
    ['next_24_hours', safeJsonParse(plan.next_24_hours_json, [])],
    ['next_7_days', safeJsonParse(plan.next_7_days_json, [])],
  ];

  return fallbackSections.flatMap(([section, steps], index) => {
    if (!Array.isArray(steps) || !steps[0]) return [];
    const step = steps[0];
    return {
      title: textOrDefault(step.title, 'Next Move task', 220),
      details: textOrDefault(step.details, '', 4000),
      section,
      importance: Math.max(3, 5 - index),
      effort: Math.min(3, 1 + index),
      frictionType: 'none',
      estimatedMinutes: index === 0 ? 30 : null,
      dueDate: null,
    };
  });
}

export async function createTaskDeckTasksFromNextMovePlan(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const ownerUserId = getOwnerUserId();
  const nextMovePlanId = positiveInteger(input.nextMovePlanId, 'nextMovePlanId');
  const plan = await getNextMovePlan(nextMovePlanId);
  if (!plan) throw new Error(`No Flowpath Next Move plan exists with id ${nextMovePlanId}.`);

  const existingTasks = await all(
    `SELECT
      tasks.*,
      situations.title AS situation_title
    FROM tasks
    LEFT JOIN situations ON situations.id = tasks.situation_id AND situations.user_id = tasks.user_id
    WHERE tasks.user_id = ? AND tasks.source_next_move_plan_id = ?
    ORDER BY tasks.created_at ASC`,
    [ownerUserId, nextMovePlanId]
  );

  if (existingTasks.length > 0) {
    return {
      ok: true,
      created: false,
      alreadyExisted: true,
      tasks: existingTasks,
    };
  }

  const taskRows = normalizePlanTaskRows(plan);
  if (taskRows.length === 0) {
    return {
      ok: false,
      reason: 'no_task_candidates',
      message: 'This Next Move plan does not contain task candidates or usable fallback steps.',
    };
  }

  const now = nowIso();
  for (const task of taskRows) {
    await run(
      `INSERT INTO tasks (
        user_id, title, life_area_id, project_id, situation_id, source_next_move_plan_id,
        source_plan_section, status, importance, effort, friction_type, friction_note,
        estimated_minutes, due_date, notes, is_qa, created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?, 'open', ?, ?, ?, '', ?, ?, ?, 0, ?, ?)`,
      [
        ownerUserId,
        task.title,
        plan.situation_id,
        plan.id,
        task.section,
        task.importance,
        task.effort,
        task.frictionType,
        task.estimatedMinutes,
        task.dueDate,
        task.details,
        now,
        now,
      ]
    );
  }

  const tasks = await all(
    `SELECT
      tasks.*,
      situations.title AS situation_title
    FROM tasks
    LEFT JOIN situations ON situations.id = tasks.situation_id AND situations.user_id = tasks.user_id
    WHERE tasks.user_id = ? AND tasks.source_next_move_plan_id = ?
    ORDER BY tasks.created_at ASC`,
    [ownerUserId, nextMovePlanId]
  );

  return {
    ok: true,
    created: true,
    alreadyExisted: false,
    tasks,
  };
}
