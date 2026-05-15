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

let client = null;

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

  if (!client) {
    client = createClient({
      url: databaseUrl,
      authToken: getTaskDeckAuthToken(),
    });
  }

  return client;
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
  const rows = await all(
    `SELECT 'open_tasks' AS name, COUNT(*) AS count FROM tasks WHERE status = 'open'
    UNION ALL SELECT 'active_projects', COUNT(*) FROM projects WHERE status = 'active'
    UNION ALL SELECT 'active_situations', COUNT(*) FROM situations WHERE status = 'active'
    UNION ALL SELECT 'life_areas', COUNT(*) FROM life_areas
    UNION ALL SELECT 'recent_checkins', COUNT(*) FROM checkins
    UNION ALL SELECT 'next_move_plans', COUNT(*) FROM next_move_plans`
  );

  return Object.fromEntries(rows.map((row) => [row.name, row.count]));
}

async function resolveLifeAreaId({ lifeAreaId, lifeAreaName } = {}) {
  if (lifeAreaId != null && lifeAreaId !== '') {
    const id = positiveInteger(lifeAreaId, 'lifeAreaId');
    const lifeArea = await first('SELECT id FROM life_areas WHERE id = ?', [id]);
    if (!lifeArea) throw new Error(`No Flowpath life area exists with id ${id}.`);
    return id;
  }

  const name = nullableText(lifeAreaName, 120);
  if (!name) return null;

  const lifeArea = await first(
    'SELECT id FROM life_areas WHERE name = ? COLLATE NOCASE LIMIT 1',
    [name]
  );
  if (!lifeArea) throw new Error(`No Flowpath life area exists named "${name}".`);
  return lifeArea.id;
}

async function resolveProject({ projectId, projectName } = {}) {
  if (projectId != null && projectId !== '') {
    const id = positiveInteger(projectId, 'projectId');
    const project = await first('SELECT id, life_area_id FROM projects WHERE id = ?', [id]);
    if (!project) throw new Error(`No Flowpath project exists with id ${id}.`);
    return project;
  }

  const name = nullableText(projectName, 160);
  if (!name) return null;

  const project = await first(
    'SELECT id, life_area_id FROM projects WHERE name = ? COLLATE NOCASE LIMIT 1',
    [name]
  );
  if (!project) throw new Error(`No Flowpath project exists named "${name}".`);
  return project;
}

async function getTask(taskId) {
  return first(
    `SELECT
      tasks.*,
      life_areas.name AS life_area_name,
      projects.name AS project_name,
      situations.title AS situation_title
    FROM tasks
    LEFT JOIN life_areas ON life_areas.id = tasks.life_area_id
    LEFT JOIN projects ON projects.id = tasks.project_id
    LEFT JOIN situations ON situations.id = tasks.situation_id
    WHERE tasks.id = ?`,
    [taskId]
  );
}

export async function getTaskDeckBriefing(input = {}) {
  const topic = enumValue(
    input.topic,
    ['everything', 'tasks', 'projects', 'situations', 'today', 'memory'],
    'everything',
    'topic'
  );
  const limit = clampLimit(input.limit, 10);
  const includeCompletedTasks = Boolean(input.includeCompletedTasks);

  const counts = await getCounts();
  const profile = await first('SELECT * FROM profile WHERE id = 1');
  const lifeAreas =
    topic === 'everything' || topic === 'projects' || topic === 'memory'
      ? await all(
          `SELECT * FROM life_areas
          ORDER BY
            CASE priority_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
            name COLLATE NOCASE
          LIMIT ?`,
          [limit]
        )
      : [];

  const activeProjects =
    topic === 'everything' || topic === 'projects' || topic === 'today'
      ? await all(
          `SELECT projects.*, life_areas.name AS life_area_name
          FROM projects
          LEFT JOIN life_areas ON life_areas.id = projects.life_area_id
          WHERE projects.status = 'active'
          ORDER BY projects.updated_at DESC, projects.name COLLATE NOCASE
          LIMIT ?`,
          [limit]
        )
      : [];

  const taskWhere = includeCompletedTasks ? '' : "WHERE tasks.status = 'open'";
  const tasks =
    topic === 'everything' || topic === 'tasks' || topic === 'today'
      ? await all(
          `SELECT
            tasks.*,
            life_areas.name AS life_area_name,
            projects.name AS project_name,
            situations.title AS situation_title
          FROM tasks
          LEFT JOIN life_areas ON life_areas.id = tasks.life_area_id
          LEFT JOIN projects ON projects.id = tasks.project_id
          LEFT JOIN situations ON situations.id = tasks.situation_id
          ${taskWhere}
          ORDER BY
            CASE tasks.status WHEN 'open' THEN 1 WHEN 'ignored' THEN 2 ELSE 3 END,
            tasks.importance DESC,
            tasks.effort ASC,
            tasks.created_at DESC
          LIMIT ?`,
          [limit]
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
            WHERE situation_id = situations.id
            ORDER BY created_at DESC
            LIMIT 1
          )
          WHERE situations.status = 'active'
          ORDER BY
            CASE situations.urgency WHEN 'crisis' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
            situations.updated_at DESC
          LIMIT ?`,
          [limit]
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
          LEFT JOIN situations ON situations.id = next_move_plans.situation_id
          ORDER BY next_move_plans.created_at DESC
          LIMIT ?`,
          [limit]
        )
      : [];

  const recentCheckIns =
    topic === 'everything' || topic === 'today'
      ? await all(
          `SELECT * FROM checkins
          ORDER BY checkin_date DESC, created_at DESC
          LIMIT ?`,
          [Math.min(limit, 5)]
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
          ORDER BY plan_date DESC, created_at DESC
          LIMIT ?`,
          [Math.min(limit, 5)]
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

  const title = textOrDefault(input.title, '', 220);
  if (!title) throw new Error('title is required.');

  const project = await resolveProject(input);
  const explicitLifeAreaId = await resolveLifeAreaId(input);
  const lifeAreaId = explicitLifeAreaId ?? project?.life_area_id ?? null;
  const status = enumValue(input.status, ['open', 'done', 'ignored'], 'open', 'status');
  const importance = integerInRange(input.importance, 'importance', 1, 5, 3);
  const effort = integerInRange(input.effort, 'effort', 1, 5, 3);
  const dueDate = optionalDate(input.dueDate);
  const notes = textOrDefault(input.notes, '', 5000);
  const now = nowIso();

  const taskId = await insert(
    `INSERT INTO tasks (
      title, life_area_id, project_id, status, importance, effort, due_date, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title,
      lifeAreaId,
      project?.id ?? null,
      status,
      importance,
      effort,
      dueDate,
      notes,
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
      title, life_area_id, project_id, status, importance, effort, due_date, notes, created_at, updated_at
    ) VALUES (?, NULL, NULL, 'open', ?, 2, NULL, ?, ?, ?)`,
    [title, importanceByPriority[priority], notes, now, now]
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
    args.push(enumValue(input.status, ['open', 'done', 'ignored'], existing.status, 'status'));
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

  if (updates.length === 0) {
    return { ok: true, task: existing, changed: false };
  }

  updates.push('updated_at = ?');
  args.push(nowIso(), taskId);

  await run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, args);

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

  if (input.energyLevel == null || input.energyLevel === '') {
    throw new Error('energyLevel is required.');
  }
  const energyLevel = integerInRange(input.energyLevel, 'energyLevel', 1, 10, null);
  const id = await insert(
    `INSERT INTO checkins (
      checkin_date, energy_level, mood, sleep, health_status,
      main_thing, resistance, brain_dump, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    checkIn: await first('SELECT * FROM checkins WHERE id = ?', [id]),
  };
}

export async function createTaskDeckSituation(input = {}) {
  if (input.confirmedByTom !== true) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const title = textOrDefault(input.title, '', 180);
  if (!title) throw new Error('title is required.');

  const category = textOrDefault(input.category, 'custom', 120);
  const urgency = enumValue(input.urgency, ['low', 'medium', 'high', 'crisis'], 'medium', 'urgency');
  const now = nowIso();
  const situationId = await insert(
    `INSERT INTO situations (title, category, status, urgency, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?, ?)`,
    [title, category, urgency, now, now]
  );

  const sessionId = await insert(
    `INSERT INTO intake_sessions (
      situation_id, current_stage, is_complete, summary_so_far, created_at, updated_at
    ) VALUES (?, 'understanding_goals', 0, ?, ?, ?)`,
    [situationId, textOrDefault(input.summary, '', 5000), now, now]
  );

  await insert(
    `INSERT INTO intake_messages (session_id, role, content, created_at)
    VALUES (?, 'assistant', ?, ?)`,
    [
      sessionId,
      'What do you most want to change about this situation, and what would feel meaningfully different if Flowpath helped you make progress?',
      now,
    ]
  );

  return {
    ok: true,
    situation: await first('SELECT * FROM situations WHERE id = ?', [situationId]),
    session: await first('SELECT * FROM intake_sessions WHERE id = ?', [sessionId]),
  };
}
