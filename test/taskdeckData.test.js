import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import {
  createTaskDeckCallerIntakeTask,
  createTaskDeckSituation,
  createTaskDeckTask,
  createTaskDeckTasksFromNextMovePlan,
  resetTaskDeckDataClientForTests,
} from '../src/taskdeckData.js';

async function executeMany(db, statements) {
  for (const statement of statements) {
    await db.execute(statement);
  }
}

async function setupFlowpathDb() {
  const dbPath = path.join(tmpdir(), `voice-ai-system-${randomUUID()}.db`);
  const databaseUrl = `file:${dbPath}`;
  process.env.FLOWPATH_DATABASE_URL = databaseUrl;
  process.env.FLOWPATH_OWNER_LOCAL_USER_ID = '1';
  delete process.env.FLOWPATH_DATABASE_AUTH_TOKEN;
  resetTaskDeckDataClientForTests();

  const db = createClient({ url: databaseUrl });
  await executeMany(db, [
    'PRAGMA foreign_keys = ON',
    `CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT
    )`,
    `CREATE TABLE profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      personal_profile TEXT NOT NULL DEFAULT '',
      current_season TEXT NOT NULL DEFAULT '',
      core_priorities TEXT NOT NULL DEFAULT '',
      constraints TEXT NOT NULL DEFAULT '',
      operating_principles TEXT NOT NULL DEFAULT '',
      remember TEXT NOT NULL DEFAULT '',
      challenge_on TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE life_areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority_level TEXT NOT NULL DEFAULT 'medium',
      desired_outcome TEXT NOT NULL DEFAULT '',
      current_bottleneck TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      life_area_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      description TEXT NOT NULL DEFAULT '',
      next_milestone TEXT NOT NULL DEFAULT '',
      current_bottleneck TEXT NOT NULL DEFAULT '',
      why_it_matters TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE situations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'custom',
      status TEXT NOT NULL DEFAULT 'active',
      urgency TEXT NOT NULL DEFAULT 'medium',
      is_qa INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE intake_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      situation_id INTEGER NOT NULL,
      current_stage TEXT NOT NULL,
      is_complete INTEGER NOT NULL DEFAULT 0,
      summary_so_far TEXT NOT NULL DEFAULT '',
      is_qa INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE intake_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      is_qa INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE next_move_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      situation_id INTEGER NOT NULL,
      intake_session_id INTEGER,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      situation_summary TEXT NOT NULL,
      core_bottleneck TEXT NOT NULL,
      highest_leverage_move_json TEXT NOT NULL,
      first_30_minutes_json TEXT NOT NULL,
      next_24_hours_json TEXT NOT NULL,
      next_7_days_json TEXT NOT NULL,
      task_candidates_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      life_area_id INTEGER,
      project_id INTEGER,
      status TEXT NOT NULL,
      importance INTEGER NOT NULL,
      effort INTEGER NOT NULL,
      due_date TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      situation_id INTEGER,
      source_next_move_plan_id INTEGER,
      source_plan_section TEXT,
      friction_type TEXT NOT NULL DEFAULT 'none',
      friction_note TEXT NOT NULL DEFAULT '',
      is_qa INTEGER NOT NULL DEFAULT 0,
      estimated_minutes INTEGER
    )`,
    `CREATE TABLE checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      checkin_date TEXT NOT NULL,
      energy_level INTEGER NOT NULL,
      mood TEXT NOT NULL DEFAULT '',
      sleep TEXT NOT NULL DEFAULT '',
      health_status TEXT NOT NULL DEFAULT '',
      main_thing TEXT NOT NULL DEFAULT '',
      resistance TEXT NOT NULL DEFAULT '',
      brain_dump TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_date TEXT NOT NULL,
      checkin_id INTEGER,
      model TEXT NOT NULL,
      today_theme TEXT NOT NULL,
      honest_read TEXT NOT NULL,
      top_3_actions_json TEXT NOT NULL,
      recommendation_basis_json TEXT NOT NULL DEFAULT '[]',
      restraint_guidance_json TEXT NOT NULL DEFAULT '{}',
      friction_pattern TEXT NOT NULL DEFAULT '',
      operator_insight_json TEXT NOT NULL DEFAULT '{}',
      local_reality_scout_json TEXT NOT NULL DEFAULT '{}',
      human_help_boundary TEXT NOT NULL DEFAULT '',
      avoid_today TEXT NOT NULL,
      optional_if_energy_is_high TEXT NOT NULL,
      minimum_viable_day TEXT NOT NULL,
      evening_review_prompt TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  ]);
  await db.execute("INSERT INTO users (id, email) VALUES (1, 'tom@example.test')");
  return db;
}

test('external caller intake creates only a standalone confirmed task', async (t) => {
  const db = await setupFlowpathDb();
  t.after(() => db.close());

  const result = await createTaskDeckCallerIntakeTask({
    confirmedByCaller: true,
    subject: 'Coffee',
    messageBody: 'Please ask Tom to call me back.',
    callerName: 'Casey',
    priority: 'normal',
    callbackRequested: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.channel, 'taskdeck_task');
  assert.equal(result.task.project_id, null);
  assert.equal(result.task.situation_id, null);
  assert.match(result.task.notes, /Caller intake captured by Victoria/);
});

test('owner can create a task attached to a situation', async (t) => {
  const db = await setupFlowpathDb();
  t.after(() => db.close());

  const situationResult = await createTaskDeckSituation({
    confirmedByTom: true,
    title: 'Untangle the voice system',
    urgency: 'high',
    summary: 'Victoria needs less brittle interruptions.',
  });

  const taskResult = await createTaskDeckTask({
    confirmedByTom: true,
    title: 'Tune barge-in behavior',
    situationId: situationResult.situation.id,
    status: 'in_progress',
    estimatedMinutes: 25,
    frictionType: 'unclear',
  });

  assert.equal(taskResult.ok, true);
  assert.equal(taskResult.task.situation_id, situationResult.situation.id);
  assert.equal(taskResult.task.status, 'in_progress');
  assert.equal(taskResult.task.estimated_minutes, 25);
  assert.equal(taskResult.task.friction_type, 'unclear');
});

test('owner can convert an existing Next Move plan into tasks once', async (t) => {
  const db = await setupFlowpathDb();
  t.after(() => db.close());

  const situationResult = await createTaskDeckSituation({
    confirmedByTom: true,
    title: 'Ship voice upgrades',
    urgency: 'medium',
  });
  const now = new Date().toISOString();
  const planInsert = await db.execute({
    sql: `INSERT INTO next_move_plans (
      user_id, situation_id, model, mode, situation_summary, core_bottleneck,
      highest_leverage_move_json, first_30_minutes_json, next_24_hours_json,
      next_7_days_json, task_candidates_json, created_at
    ) VALUES (?, ?, 'test-model', 'growth', ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      1,
      situationResult.situation.id,
      'Voice upgrade plan',
      'Tool surface is too narrow.',
      JSON.stringify({ title: 'Create attached tasks' }),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([
        {
          title: 'Create situation-linked task',
          details: 'Attach the task to the existing situation.',
          rank_reason: 'Unblocks the workflow.',
          candidate_type: 'task_candidate',
          importance: 5,
          effort: 2,
          friction_type: 'none',
          estimated_minutes: 20,
          due_date: null,
        },
      ]),
      now,
    ],
  });

  const first = await createTaskDeckTasksFromNextMovePlan({
    confirmedByTom: true,
    nextMovePlanId: Number(planInsert.lastInsertRowid),
  });
  const second = await createTaskDeckTasksFromNextMovePlan({
    confirmedByTom: true,
    nextMovePlanId: Number(planInsert.lastInsertRowid),
  });

  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0].situation_id, situationResult.situation.id);
  assert.equal(first.tasks[0].source_next_move_plan_id, Number(planInsert.lastInsertRowid));
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.tasks.length, 1);
});
