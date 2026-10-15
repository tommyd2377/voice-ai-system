import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachLiveCall } from '../src/realtimeHandler.js';

const CALL_SID = `CA${'1'.repeat(32)}`;
const FRAME = Buffer.alloc(160, 0xff).toString('base64');
const NON_SILENT_FRAME = Buffer.alloc(160, 0x42).toString('base64');
const FAKE_OWNER_PIN = '764928315607';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSocket extends EventEmitter {
  constructor(readyState = 1) {
    super();
    this.readyState = readyState;
    this.sent = [];
    this.closeCalls = [];
    this.pendingCalls = new Set();
    this.observedCalls = new Set();
    this.protocolErrors = [];
  }

  send(payload) {
    assert.equal(this.readyState, 1, 'only send on an open socket');
    const event = JSON.parse(String(payload));
    // SessionUpdateConfig.delegation is a discriminated union, even when only
    // responses settings change: https://developers.openai.com/api/reference/typescript/__sdk_schema?declaration=%28resource%29+live+%3E+%28model%29+session_update_config+%3E+%28schema%29&selected=%28resource%29+live
    if (event.type === 'session.update' && event.session?.delegation
      && event.session.delegation.type !== 'responses') {
      this.protocolErrors.push('invalid_delegation_type');
      throw new Error('session.update delegation requires type responses');
    }
    if (event.type === 'response.create' && this.pendingCalls.size) {
      this.protocolErrors.push('continuation_before_all_results');
      throw new Error('response.create requires results for every pending call');
    }
    if (event.type === 'response.item.create' && event.item?.type === 'function_call_output') {
      if (!this.pendingCalls.delete(event.item.call_id)) {
        this.protocolErrors.push('unknown_or_duplicate_result');
        throw new Error('function result must match a pending call');
      }
    }
    this.sent.push(event);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  terminate() {
    this.close();
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  receive(event) {
    const item = event.type === 'response.event' && event.event?.type === 'response.output_item.done'
      ? event.event.item : null;
    if (item?.type === 'function_call' && !this.observedCalls.has(item.call_id)) {
      this.observedCalls.add(item.call_id);
      this.pendingCalls.add(item.call_id);
    }
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  events(type) {
    return this.sent.filter((event) => event.type === type || event.event === type);
  }
}

function harness(t, {
  ownerVerificationPending = false,
  isOwner = ownerVerificationPending === true ? false : true,
  grantValid = true,
  executeTool,
  limits = {},
} = {}) {
  const twilio = new FakeSocket();
  const live = new FakeSocket(0);
  const connections = [];
  const grants = [];
  const executions = [];
  const pinAttempts = [];
  const logs = [];
  const controller = attachLiveCall(twilio, {
    security: {
      consumeGrant(input) {
        grants.push(input);
        return grantValid && input.token === 'fake-grant' && input.callSid === CALL_SID
          ? { isOwner, ownerVerificationPending, callSid: CALL_SID }
          : null;
      },
      verifyOwnerPin(pin) {
        pinAttempts.push(pin);
        return pin === FAKE_OWNER_PIN;
      },
    },
    connectLive(options) {
      connections.push(options);
      return live;
    },
    executeTool: async (name, args, context) => {
      executions.push({ name, args, context });
      return executeTool ? executeTool(name, args, context) : { ok: true, source: name };
    },
    logger: Object.fromEntries(['log', 'info', 'warn', 'error'].map((level) => [
      level, (...args) => logs.push({ level, args: structuredClone(args) }),
    ])),
    limits: { closeTimeoutMs: 20, startTimeoutMs: 500, maxCallMs: 5000, ...limits },
  });

  t.after(() => {
    controller.close('test_cleanup');
    if (live.readyState === 1) {
      live.receive({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 0 } });
    }
    live.close();
    twilio.close();
    assert.deepEqual(live.protocolErrors, [], 'provider accepted all continuation and result commands');
  });

  const start = async () => {
    twilio.receive({
      event: 'start',
      start: {
        streamSid: 'MZfake',
        callSid: CALL_SID,
        customParameters: { grantToken: 'fake-grant' },
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    });
    await tick();
  };

  const ready = async () => {
    await start();
    live.open();
    live.receive({ type: 'session.started', session: { id: 'sess_fake' } });
    await tick();
  };

  const backend = (event, delegationId = 'delegation_1') => live.receive({
    type: 'response.event', delegation_id: delegationId, event,
  });
  const created = (responseId, delegationId) => backend({
    type: 'response.created', response: { id: responseId, status: 'in_progress' },
  }, delegationId);
  const call = (responseId, callId, args = {}, name = 'get_codebase_overview', delegationId) => backend({
    type: 'response.output_item.done',
    response_id: responseId,
    item: {
      type: 'function_call', call_id: callId, name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  }, delegationId);
  const completed = (responseId, usage, delegationId) => backend({
    type: 'response.completed',
    response: { id: responseId, status: 'completed', output: [], ...(usage ? { usage } : {}) },
  }, delegationId);
  const dtmf = (digit, { streamSid = 'MZfake', track = 'inbound' } = {}) => twilio.receive({
    event: 'dtmf', streamSid, dtmf: { track, digit },
  });
  const enterPin = (pin = FAKE_OWNER_PIN) => {
    for (const digit of pin) dtmf(digit);
    dtmf('#');
  };

  return { twilio, live, controller, connections, grants, executions, pinAttempts, logs, start, ready, backend, created, call, completed, dtmf, enterPin };
}

test('unverified media streams cannot start a provider session', async (t) => {
  const h = harness(t, { grantValid: false });
  assert.equal(h.connections.length, 0);
  await h.start();
  assert.equal(h.grants.length, 1);
  assert.equal(h.connections.length, 0);
  assert.equal(h.twilio.readyState, 3);
});

test('phone audio arriving before a verified start closes the stream without a provider call', async (t) => {
  const h = harness(t);
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  await h.start();
  assert.equal(h.grants.length, 0);
  assert.equal(h.connections.length, 0);
  assert.equal(h.twilio.readyState, 3);
});

test('verified start configures Live once and discards setup audio until session.started', async (t) => {
  const h = harness(t);
  await h.start();
  assert.equal(h.connections.length, 1);
  assert.equal(h.connections[0].isOwner, true);
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  assert.equal(h.live.sent.length, 0);
  h.live.open();
  assert.equal(h.live.events('session.start').length, 1);
  assert.equal(h.live.events('session.start')[0].session.model, 'gpt-live-1');
  assert.equal(h.live.events('session.start')[0].session.delegation.type, 'responses');
  assert.equal(h.live.events('session.input_audio.append').length, 0);
  h.live.receive({ type: 'session.started', session: { id: 'sess_fake' } });
  await tick();
  assert.equal(h.live.events('session.input_audio.append').length, 0, 'setup audio is never replayed');
  h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
  assert.equal(h.live.events('session.input_audio.append').length, 1);
  assert.equal(h.live.events('session.input_audio.append')[0].audio, NON_SILENT_FRAME);
  const input = h.live.events('session.start')[0].session.input;
  assert.equal(input[0].role, 'developer');
  assert.match(input[0].content[0].text, /Greet the caller first/);
  assert.equal(h.live.events('session.start').length, 1);
});

test('Live keeps phone audio full duplex and sends playback marks without a Realtime speech gate', async (t) => {
  const h = harness(t);
  await h.ready();
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  h.live.receive({ type: 'input_audio_buffer.speech_started' });
  h.live.receive({ type: 'session.output_audio.delta', delta: FRAME });
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  assert.equal(h.live.events('session.input_audio.append').length, 2);
  const media = h.twilio.events('media');
  assert.equal(media.length, 1);
  assert.equal(media[0].media.payload, FRAME);
  assert.equal(media[0].streamSid, 'MZfake');
  const marks = h.twilio.events('mark');
  assert.equal(marks.length, 1);
  h.twilio.receive({ event: 'mark', streamSid: 'MZfake', mark: marks[0].mark });
  assert.equal(h.controller.getSummary().playedAudioBytes, 160);
  assert.equal(h.twilio.events('clear').length, 0);
  assert.equal(h.live.events('response.cancel').length, 0);
  assert.equal(h.live.events('conversation.item.truncate').length, 0);
});

test('interleaved backend batches use matching call IDs and resume once after every pending result', async (t) => {
  const releases = new Map();
  const h = harness(t, {
    executeTool: async (_name, args) => new Promise((resolve) => releases.set(args.marker, resolve)),
  });
  await h.ready();
  h.created('response_a', 'delegation_a');
  h.created('response_b', 'delegation_b');
  h.call('response_a', 'call_a', { marker: 'a' }, 'get_codebase_overview', 'delegation_a');
  h.call('response_b', 'call_b', { marker: 'b' }, 'get_codebase_overview', 'delegation_b');
  await tick();
  assert.equal(h.executions.length, 0, 'only completed responses execute their collected calls');
  h.completed('response_a', undefined, 'delegation_a');
  h.completed('response_b', undefined, 'delegation_b');
  await tick();
  assert.equal(h.executions.length, 1, 'tool batches execute sequentially');
  releases.get('a')({ ok: true, value: 'result_a' });
  await tick();
  assert.equal(h.executions.length, 2);
  assert.equal(h.live.events('response.item.create').length, 1);
  assert.equal(h.live.events('response.create').length, 0, 'the other response still needs a tool result');
  assert.deepEqual([...h.live.pendingCalls], ['call_b']);
  releases.get('b')({ ok: true, value: 'result_b' });
  await tick();
  const results = h.live.events('response.item.create');
  assert.deepEqual(new Set(results.map((event) => event.item.call_id)), new Set(['call_a', 'call_b']));
  for (const result of results) {
    assert.equal(result.item.type, 'function_call_output');
    assert.equal(JSON.parse(result.item.output).value, result.item.call_id === 'call_a' ? 'result_a' : 'result_b');
  }
  assert.equal(h.live.events('response.create').length, 1);
  assert.equal(h.live.pendingCalls.size, 0);
  h.call('response_a', 'call_a', { marker: 'a' }, 'get_codebase_overview', 'delegation_a');
  h.completed('response_a', undefined, 'delegation_a');
  h.completed('response_b', undefined, 'delegation_b');
  await tick();
  assert.equal(h.executions.length, 2);
  assert.equal(h.live.events('response.item.create').length, 2);
  assert.equal(h.live.events('response.create').length, 1);
});

test('the provider fake rejects continuation until all pending function outputs arrive', () => {
  const live = new FakeSocket();
  for (const callId of ['call_first', 'call_second']) {
    live.receive({
      type: 'response.event',
      event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: callId } },
    });
  }
  live.send(JSON.stringify({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_first', output: '{}' } }));
  assert.throws(() => live.send(JSON.stringify({ type: 'response.create' })), /every pending call/);
  live.send(JSON.stringify({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_second', output: '{}' } }));
  live.send(JSON.stringify({ type: 'response.create' }));
  assert.equal(live.events('response.create').length, 1);
});

test('the provider contract rejects missing or incorrect delegation discriminators on session updates', () => {
  for (const type of [undefined, 'realtime', null, true]) {
    const live = new FakeSocket();
    assert.throws(() => live.send(JSON.stringify({
      type: 'session.update',
      session: { delegation: { ...(type === undefined ? {} : { type }), responses: { tools: [] } } },
    })), /session.update delegation requires type responses/);
    assert.deepEqual(live.protocolErrors, ['invalid_delegation_type']);
    assert.equal(live.events('session.update').length, 0);
  }
  const live = new FakeSocket();
  live.send(JSON.stringify({
    type: 'session.update',
    session: { delegation: { type: 'responses', responses: { tools: [], tool_choice: 'none' } } },
  }));
  assert.deepEqual(live.protocolErrors, []);
  assert.equal(live.events('session.update').length, 1);
});

test('all custom results in one response precede its single continuation', async (t) => {
  const h = harness(t);
  await h.ready();
  h.created('response_batch');
  h.call('response_batch', 'call_one', { maxFiles: 2 });
  h.call('response_batch', 'call_two', { query: 'voice', limit: 1 }, 'search_codebase');
  h.completed('response_batch');
  await tick();
  assert.equal(h.executions.length, 2);
  assert.equal(h.live.events('response.create').length, 1);
  const results = h.live.sent.map((event, index) => ({ event, index })).filter(({ event }) => event.type === 'response.item.create');
  const continuationIndex = h.live.sent.findIndex((event) => event.type === 'response.create');
  assert.equal(results.length, 2);
  assert.ok(results.every(({ index }) => index < continuationIndex));
});

test('malformed function arguments return a bounded failure without executing or crashing', async (t) => {
  const h = harness(t);
  await h.ready();
  h.created('response_bad');
  h.call('response_bad', 'call_bad', '{');
  h.completed('response_bad');
  await tick();
  assert.equal(h.executions.length, 0);
  const output = h.live.events('response.item.create')[0];
  assert.equal(output.item.call_id, 'call_bad');
  assert.equal(JSON.parse(output.item.output).ok, false);
  assert.equal(h.live.events('response.create').length, 1);
  assert.equal(h.live.readyState, 1);
});

test('oversized custom tool output becomes a small failure instead of being forwarded', async (t) => {
  const largeText = 'source line '.repeat(4000);
  const h = harness(t, { executeTool: async () => ({ ok: true, text: largeText }) });
  await h.ready();
  h.created('response_large');
  h.call('response_large', 'call_large');
  h.completed('response_large');
  await tick();
  assert.equal(h.executions.length, 1);
  const event = h.live.events('response.item.create')[0];
  const result = JSON.parse(event.item.output);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'result_too_large');
  assert.ok(event.item.output.length < 1000);
  assert.equal(event.item.output.includes(largeText), false);
  assert.equal(h.live.events('response.create').length, 1);
});

test('public callers cannot execute private functions even if the provider requests them', async (t) => {
  const h = harness(t, { isOwner: false });
  await h.ready();
  assert.deepEqual(h.live.events('session.start')[0].session.delegation.responses.tools, []);
  h.created('response_public');
  h.call('response_public', 'call_private', { filePath: 'package.json' }, 'read_code_snippet');
  h.completed('response_public');
  await tick();
  assert.equal(h.executions.length, 0);
  const output = h.live.events('response.item.create')[0];
  assert.equal(JSON.parse(output.item.output).ok, false);
});

test('pending owner verification uses Marin to request keypad entry with no private tools', async (t) => {
  const h = harness(t, { ownerVerificationPending: true });
  await h.ready();
  const { session } = h.live.events('session.start')[0];
  assert.equal(session.audio.output.voice, 'marin');
  assert.match(session.input[0].content[0].text, /owner PIN on the keypad/);
  assert.match(session.instructions, /never request, repeat, guess, or accept a spoken PIN/);
  assert.deepEqual(session.delegation.responses.tools, []);
  assert.equal(session.delegation.responses.tool_choice, 'none');
  assert.equal(h.connections[0].isOwner, false);
  assert.equal(h.controller.getSummary().isOwner, false);

  h.twilio.receive({ event: 'media', streamSid: 'MZfake', media: { track: 'inbound', payload: NON_SILENT_FRAME } });
  const masked = h.live.events('session.input_audio.append')[0].audio;
  assert.equal(Buffer.from(masked, 'base64').length, Buffer.from(NON_SILENT_FRAME, 'base64').length);
  assert.deepEqual(Buffer.from(masked, 'base64'), Buffer.alloc(160, 0xff));
});

test('only matching inbound keypad events verify and owner tools wait for the matching update acknowledgment', async (t) => {
  const h = harness(t, { ownerVerificationPending: true });
  await h.ready();
  h.dtmf('9', { streamSid: 'MZother' });
  h.dtmf('#', { streamSid: 'MZother' });
  h.dtmf('9', { track: 'outbound' });
  h.dtmf('#', { track: 'outbound' });
  for (const invalid of ['12', 'x', '', 7, null]) h.dtmf(invalid);
  assert.deepEqual(h.pinAttempts, []);
  h.enterPin();
  assert.deepEqual(h.pinAttempts, [FAKE_OWNER_PIN]);
  const update = h.live.events('session.update')[0];
  assert.equal(h.live.events('session.update').length, 1);
  assert.ok(update.event_id);
  assert.equal(update.session.delegation.type, 'responses');
  assert.deepEqual(update.session.delegation.responses.tools.map((tool) => tool.name || tool.type), [
    'web_search', 'get_codebase_overview', 'search_codebase', 'read_code_snippet',
  ]);
  assert.equal(update.session.delegation.responses.tool_choice, 'auto');
  assert.equal(h.controller.getSummary().isOwner, false, 'server permissions remain public while the update is in flight');
  h.enterPin();
  assert.equal(h.pinAttempts.length, 1, 'entry cannot restart while acknowledgment is pending');
  assert.equal(h.live.events('session.update').length, 1);

  h.created('response_before_owner_ack');
  h.call('response_before_owner_ack', 'call_before_owner_ack');
  h.completed('response_before_owner_ack');
  await tick();
  assert.equal(h.executions.length, 0);
  assert.equal(JSON.parse(h.live.events('response.item.create')[0].item.output).reason, 'unauthorized');
  h.created('response_after_denial');
  h.completed('response_after_denial');

  h.live.receive({ type: 'session.updated', client_event_id: 'unrelated_update' });
  h.live.receive({ type: 'session.updated' });
  assert.equal(h.controller.getSummary().isOwner, false);
  assert.equal(h.live.events('session.instructions.append').length, 0);
  h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
  assert.equal(h.live.events('session.input_audio.append').at(-1).audio, FRAME);

  h.live.receive({ type: 'session.updated', client_event_id: update.event_id });
  assert.equal(h.controller.getSummary().isOwner, true);
  const instruction = h.live.events('session.instructions.append')[0];
  assert.match(instruction.content, /server has verified the owner PIN/);
  assert.match(instruction.content, /web search and read-only inspection/);
  h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
  assert.equal(h.live.events('session.input_audio.append').at(-1).audio, NON_SILENT_FRAME);
  h.created('response_verified');
  h.call('response_verified', 'call_verified', { maxFiles: 2 });
  h.completed('response_verified');
  await tick();
  assert.equal(h.executions.length, 1);
  assert.equal(h.executions[0].context.isOwner, true);
  assert.equal(JSON.parse(h.live.events('response.item.create').at(-1).item.output).ok, true);
  h.live.receive({ type: 'session.updated', client_event_id: update.event_id });
  assert.equal(h.live.events('session.instructions.append').length, 1, 'duplicate acknowledgment cannot repeat promotion');

  h.controller.close('test_done');
  h.live.receive({ type: 'session.closed', usage: { seconds: 1 } });
  assert.equal(JSON.stringify(h.live.sent).includes(FAKE_OWNER_PIN), false, 'PIN digits never reach OpenAI commands');
  assert.equal(JSON.stringify(h.logs).includes(FAKE_OWNER_PIN), false, 'PIN digits never reach application logs');
  assert.equal(h.live.sent.some((event) => event.type === 'dtmf' || event.event === 'dtmf'), false);
});

test('failed, oversized, and skipped PIN entry stays public for the rest of the call', async (t) => {
  for (const [name, digits, expectedAttempts] of [
    ['wrong', '0000#', ['0000']],
    ['oversized', `${'9'.repeat(13)}#`, []],
    ['skipped', '*', []],
  ]) {
    await t.test(name, async (t) => {
      const h = harness(t, { ownerVerificationPending: true });
      await h.ready();
      for (const digit of digits) h.dtmf(digit);
      assert.deepEqual(h.pinAttempts, expectedAttempts);
      assert.equal(h.controller.getSummary().isOwner, false);
      assert.equal(h.live.events('session.update').length, 1);
      const update = h.live.events('session.update')[0];
      assert.equal(update.session.delegation.type, 'responses');
      assert.deepEqual(update.session.delegation.responses.tools, []);
      assert.equal(update.session.delegation.responses.tool_choice, 'none');
      assert.match(update.session.delegation.responses.instructions, /public permissions/);
      assert.equal(h.live.events('session.instructions.append').length, 0);
      h.enterPin();
      assert.deepEqual(h.pinAttempts, expectedAttempts, 'a failed or skipped attempt cannot be retried in this call');
      h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
      assert.equal(h.live.events('session.input_audio.append').at(-1).audio, FRAME, 'audio remains masked until the public configuration is acknowledged');
      h.live.receive({ type: 'session.updated', client_event_id: 'unrelated_public_update' });
      assert.equal(h.live.events('session.instructions.append').length, 0);
      h.live.receive({ type: 'session.updated', client_event_id: update.event_id });
      assert.match(h.live.events('session.instructions.append')[0].content, /without owner access/);
      h.enterPin();
      assert.deepEqual(h.pinAttempts, expectedAttempts);
      assert.equal(h.live.events('session.instructions.append').length, 1);
      assert.equal(h.live.events('session.update').length, 1);
      h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
      assert.equal(h.live.events('session.input_audio.append').at(-1).audio, NON_SILENT_FRAME, 'public conversation resumes without masking');
      h.created('response_after_failed_pin');
      h.call('response_after_failed_pin', 'call_after_failed_pin');
      h.completed('response_after_failed_pin');
      await tick();
      assert.equal(h.executions.length, 0);
      assert.equal(JSON.parse(h.live.events('response.item.create')[0].item.output).reason, 'unauthorized');
      assert.equal(h.twilio.readyState, 1);
    });
  }
});

test('PIN entry timeout resumes public conversation and cannot be retried', async (t) => {
  const h = harness(t, { ownerVerificationPending: true, limits: { ownerPinTimeoutMs: 10 } });
  await h.ready();
  h.dtmf(FAKE_OWNER_PIN[0]);
  await pause(25);
  assert.equal(h.controller.getSummary().isOwner, false);
  assert.deepEqual(h.pinAttempts, []);
  assert.equal(h.live.events('session.update').length, 1);
  const update = h.live.events('session.update')[0];
  assert.equal(update.session.delegation.type, 'responses');
  assert.deepEqual(update.session.delegation.responses.tools, []);
  assert.equal(update.session.delegation.responses.tool_choice, 'none');
  assert.equal(h.live.events('session.instructions.append').length, 0);
  h.enterPin();
  assert.deepEqual(h.pinAttempts, []);
  h.live.receive({ type: 'session.updated', client_event_id: update.event_id });
  assert.match(h.live.events('session.instructions.append')[0].content, /without owner access/);
  h.enterPin();
  assert.deepEqual(h.pinAttempts, []);
  assert.equal(h.live.events('session.instructions.append').length, 1);
  assert.equal(h.twilio.readyState, 1);
});

test('public grants and truthy non-boolean pending flags cannot promote callers by keypad', async (t) => {
  for (const pending of [false, 'true', 1]) {
    await t.test(String(pending), async (t) => {
      const h = harness(t, { isOwner: false, ownerVerificationPending: pending });
      await h.ready();
      h.enterPin();
      assert.deepEqual(h.pinAttempts, []);
      assert.equal(h.live.events('session.update').length, 0);
      assert.equal(h.controller.getSummary().isOwner, false);
      assert.match(h.live.events('session.start')[0].session.input[0].content[0].text, /How can I help you today/);
      h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
      assert.equal(h.live.events('session.input_audio.append')[0].audio, NON_SILENT_FRAME);
    });
  }
});

test('keypad input before session.started is ignored rather than buffered as a PIN', async (t) => {
  const h = harness(t, { ownerVerificationPending: true });
  h.enterPin();
  await h.start();
  h.enterPin();
  h.live.open();
  h.enterPin();
  assert.deepEqual(h.pinAttempts, []);
  assert.equal(h.live.events('session.update').length, 0);
  h.live.receive({ type: 'session.started', session: { id: 'sess_pending' } });
  h.enterPin();
  assert.deepEqual(h.pinAttempts, [FAKE_OWNER_PIN]);
  assert.equal(h.live.events('session.update').length, 1);
});

test('rejected or unacknowledged owner updates close without enabling tools or retrying', async (t) => {
  for (const [failure, verified] of [['rejected', true], ['timeout', true], ['rejected', false], ['timeout', false]]) {
    await t.test(`${failure}, ${verified ? 'verified' : 'public'} outcome`, async (t) => {
      const h = harness(t, { ownerVerificationPending: true, limits: { ownerUpdateTimeoutMs: 10 } });
      await h.ready();
      if (verified) h.enterPin();
      else h.dtmf('*');
      const update = h.live.events('session.update')[0];
      if (failure === 'rejected') {
        h.live.receive({ type: 'error', client_event_id: update.event_id, error: { code: 'invalid_update' } });
      } else {
        h.live.receive({ type: 'session.updated', client_event_id: 'unrelated_update' });
        await pause(25);
      }
      assert.equal(h.controller.getSummary().reason, failure === 'rejected' ? 'provider_error' : 'owner_update_timeout');
      assert.equal(h.controller.getSummary().isOwner, false);
      assert.equal(h.twilio.readyState, 3);
      assert.equal(h.live.events('session.close').length, 1);
      assert.equal(h.live.events('session.update').length, 1);
      h.live.receive({ type: 'session.updated', client_event_id: update.event_id });
      assert.equal(h.controller.getSummary().isOwner, false, 'a late acknowledgment cannot reopen a closing call');
      assert.equal(h.live.events('session.instructions.append').length, 0);
    });
  }
});

test('provider diagnostics identify allowed error fields and correlated updates without logging payloads or PINs', async (t) => {
  const fakeCredential = 'FAKE_CREDENTIAL_FOR_PRIVACY_TEST_ONLY';
  for (const idLocation of ['nested', 'top', 'unrelated nested takes precedence']) {
    await t.test(idLocation, async (t) => {
      const h = harness(t, { ownerVerificationPending: true });
      await h.ready();
      h.enterPin();
      const update = h.live.events('session.update')[0];
      const nestedId = idLocation === 'nested' ? update.event_id
        : idLocation === 'unrelated nested takes precedence' ? 'unrelated_update' : undefined;
      h.live.receive({
        type: 'error',
        ...(idLocation !== 'nested' ? { client_event_id: update.event_id } : {}),
        error: {
          code: 'missing_required_parameter',
          param: 'session.delegation.type',
          ...(nestedId ? { client_event_id: nestedId } : {}),
          message: `Untrusted payload ${FAKE_OWNER_PIN} ${fakeCredential}`,
          details: { pin: FAKE_OWNER_PIN, credential: fakeCredential },
        },
      });
      h.live.receive({ type: 'session.closed', usage: { seconds: 1 } });
      const warnings = h.logs.filter((log) => log.level === 'warn');
      assert.deepEqual(warnings, [{
        level: 'warn',
        args: ['[Live] provider rejected a command', {
          code: 'missing_required_parameter',
          parameter: 'session.delegation.type',
          command: idLocation === 'unrelated nested takes precedence' ? 'unknown' : 'session.update',
        }],
      }]);
      assert.equal(h.controller.getSummary().isOwner, false);
      assert.equal(h.controller.getSummary().reason, 'provider_error');
      const serializedLogs = JSON.stringify(h.logs);
      assert.equal(serializedLogs.includes(FAKE_OWNER_PIN), false);
      assert.equal(serializedLogs.includes(fakeCredential), false);
      assert.equal(serializedLogs.includes(update.event_id), false, 'correlation IDs remain out of the log');
      assert.equal(serializedLogs.includes('Untrusted payload'), false);
    });
  }
});

test('unknown and malformed provider diagnostics are replaced with fixed safe labels', async (t) => {
  for (const fields of [
    { code: FAKE_OWNER_PIN, param: 'FAKE_PRIVATE_PARAMETER_FOR_TEST_ONLY' },
    { code: { private: FAKE_OWNER_PIN }, param: [FAKE_OWNER_PIN] },
    {},
  ]) {
    await t.test(typeof fields.code, async (t) => {
      const h = harness(t);
      await h.ready();
      h.live.receive({
        type: 'error', client_event_id: 'unrelated_update',
        error: { ...fields, message: `Never log ${FAKE_OWNER_PIN}` },
      });
      const warning = h.logs.find((log) => log.level === 'warn');
      assert.deepEqual(warning.args, ['[Live] provider rejected a command', {
        code: 'unknown', parameter: 'unknown', command: 'unknown',
      }]);
      assert.equal(JSON.stringify(h.logs).includes(FAKE_OWNER_PIN), false);
      assert.equal(h.controller.getSummary().reason, 'provider_error');
    });
  }
});

test('shutdown cancels pending verification and owner update activity', async (t) => {
  for (const awaitingUpdate of [false, true]) {
    await t.test(awaitingUpdate ? 'awaiting update' : 'awaiting PIN', async (t) => {
      const h = harness(t, {
        ownerVerificationPending: true,
        limits: { ownerPinTimeoutMs: 10, ownerUpdateTimeoutMs: 10, closeTimeoutMs: 100 },
      });
      await h.ready();
      if (awaitingUpdate) h.enterPin();
      const update = h.live.events('session.update')[0];
      h.controller.close('server_shutdown');
      await pause(25);
      if (update) h.live.receive({ type: 'session.updated', client_event_id: update.event_id });
      h.enterPin();
      assert.equal(h.controller.getSummary().reason, 'server_shutdown');
      assert.equal(h.controller.getSummary().isOwner, false);
      assert.equal(h.live.events('session.instructions.append').length, 0, 'verification timeout cannot speak after shutdown');
      assert.equal(h.live.events('session.close').length, 1);
      assert.equal(h.live.events('session.update').length, awaitingUpdate ? 1 : 0);
      assert.equal(h.pinAttempts.length, awaitingUpdate ? 1 : 0);
      h.live.receive({ type: 'session.closed', usage: { seconds: 0 } });
    });
  }
});

test('usage uses cumulative voice snapshots and counts each backend response only once', async (t) => {
  const h = harness(t);
  await h.ready();
  h.live.receive({ type: 'session.usage.updated', usage: { seconds: 5 } });
  h.live.receive({ type: 'session.usage.updated', usage: { seconds: 9 } });
  h.created('response_usage_a');
  h.completed('response_usage_a', { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } });
  h.completed('response_usage_a', { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } });
  h.created('response_usage_b');
  h.completed('response_usage_b', { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } });
  await tick();
  let summary = h.controller.getSummary();
  assert.equal(summary.voiceSeconds, 9);
  assert.equal(summary.usageFinalized, false);
  assert.equal(summary.backend.responses, 2);
  assert.equal(summary.backend.inputTokens, 20);
  assert.equal(summary.backend.outputTokens, 5);
  assert.equal(summary.backend.cachedTokens, 5);
  h.controller.close('test_done');
  assert.equal(h.live.events('session.close').length, 1);
  h.live.receive({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 10 } });
  summary = h.controller.getSummary();
  assert.equal(summary.voiceSeconds, 10);
  assert.equal(summary.usageFinalized, true);
  assert.equal(h.live.readyState, 3);
});

test('phone stop aborts tool work, ignores late results, and requests final usage', async (t) => {
  let finish;
  let toolSignal;
  const h = harness(t, {
    executeTool: async (_name, _args, { signal }) => {
      toolSignal = signal;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  await h.ready();
  h.created('response_pending');
  h.call('response_pending', 'call_pending');
  h.completed('response_pending');
  await tick();
  assert.equal(toolSignal.aborted, false);
  h.twilio.receive({ event: 'stop', stop: { callSid: CALL_SID } });
  assert.equal(toolSignal.aborted, true);
  assert.equal(h.live.events('session.close').length, 1);
  finish({ ok: true, secret: 'must not return after stop' });
  h.created('response_after_stop');
  h.call('response_after_stop', 'call_after_stop');
  h.completed('response_after_stop');
  await tick();
  assert.equal(h.executions.length, 1);
  assert.equal(h.live.events('response.item.create').length, 0);
  assert.equal(h.live.events('response.create').length, 0);
  h.live.receive({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 1 } });
  assert.equal(h.controller.getSummary().usageFinalized, true);
});

test('stalled startup and finalization time out without reconnecting', async (t) => {
  const h = harness(t, { limits: { startTimeoutMs: 10, closeTimeoutMs: 10 } });
  await h.start();
  h.live.open();
  await pause(35);
  assert.equal(h.connections.length, 1);
  assert.equal(h.live.readyState, 3);
  assert.equal(h.twilio.readyState, 3);
  assert.equal(h.controller.getSummary().usageFinalized, false);
});

test('tool timeout aborts the invocation and returns failure without retrying', async (t) => {
  let signal;
  const h = harness(t, {
    limits: { toolTimeoutMs: 10 },
    executeTool: async (_name, _args, context) => {
      signal = context.signal;
      return new Promise(() => {});
    },
  });
  await h.ready();
  h.created('response_timeout');
  h.call('response_timeout', 'call_timeout');
  h.completed('response_timeout');
  await pause(25);
  assert.equal(h.executions.length, 1);
  assert.equal(signal.aborted, true);
  const result = h.live.events('response.item.create')[0];
  assert.equal(JSON.parse(result.item.output).ok, false);
  assert.equal(h.live.events('response.create').length, 1);
});

test('a provider that never resumes after tool results reaches the backend watchdog without retries', async (t) => {
  const h = harness(t, { limits: { backendTimeoutMs: 15 } });
  await h.ready();
  h.created('response_before_stall');
  h.call('response_before_stall', 'call_before_stall');
  h.completed('response_before_stall');
  await tick();
  assert.equal(h.live.events('response.item.create').length, 1);
  assert.equal(h.live.events('response.create').length, 1);
  await pause(30);
  assert.equal(h.controller.getSummary().reason, 'backend_timeout');
  assert.equal(h.twilio.readyState, 3);
  assert.equal(h.live.events('session.close').length, 1);
  assert.equal(h.live.events('response.create').length, 1);
  assert.equal(h.executions.length, 1);
  assert.equal(h.connections.length, 1);
});

test('a resumed and completed response clears the previous continuation watchdog', async (t) => {
  const h = harness(t, { limits: { backendTimeoutMs: 15 } });
  await h.ready();
  h.created('response_before_resume');
  h.call('response_before_resume', 'call_before_resume');
  h.completed('response_before_resume');
  await tick();
  assert.equal(h.live.events('response.create').length, 1);
  h.created('response_resumed');
  h.completed('response_resumed');
  await pause(30);
  assert.equal(h.controller.getSummary().reason, null);
  assert.equal(h.live.readyState, 1);
  assert.equal(h.twilio.readyState, 1);
  assert.equal(h.live.events('session.close').length, 0);
  assert.equal(h.live.events('response.create').length, 1);
  assert.equal(h.controller.getSummary().backend.responses, 2);
});

test('provider errors stop the call without retrying or accepting more media', async (t) => {
  const h = harness(t);
  await h.ready();
  h.live.receive({ type: 'error', error: { code: 'responses_validation_failed', message: 'invalid configuration' } });
  const sentBefore = h.live.events('session.input_audio.append').length;
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  await pause(30);
  assert.equal(h.connections.length, 1);
  assert.equal(h.twilio.readyState, 3);
  assert.equal(h.live.events('session.input_audio.append').length, sentBefore);
});

test('unacknowledged phone playback remains bounded and closes instead of growing latency', async (t) => {
  const h = harness(t, { limits: { maxQueuedAudioMs: 20 } });
  await h.ready();
  h.live.receive({ type: 'session.output_audio.delta', delta: FRAME });
  h.live.receive({ type: 'session.output_audio.delta', delta: FRAME });
  assert.equal(h.twilio.events('media').length, 1);
  assert.equal(h.twilio.events('clear').length, 1);
  assert.equal(h.twilio.readyState, 3);
  assert.equal(h.live.events('session.close').length, 1);
});

test('more than two seconds of setup audio is discarded without closing or replaying a burst', async (t) => {
  const h = harness(t);
  await h.start();
  h.live.open();
  for (let frame = 0; frame < 150; frame += 1) {
    h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
  }
  assert.equal(h.twilio.readyState, 1);
  assert.equal(h.live.events('session.input_audio.append').length, 0);
  h.live.receive({ type: 'session.started', session: { id: 'sess_late' } });
  assert.equal(h.live.events('session.close').length, 0);
  assert.equal(h.live.events('session.input_audio.append').length, 0);
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  assert.deepEqual(h.live.events('session.input_audio.append').map((event) => event.audio), [FRAME]);
});

test('backend work cannot exceed the session response budget', async (t) => {
  const h = harness(t, { limits: { maxBackendResponses: 1 } });
  await h.ready();
  h.created('response_allowed');
  h.completed('response_allowed');
  h.created('response_over_budget');
  h.call('response_over_budget', 'call_over_budget');
  h.completed('response_over_budget');
  await tick();
  assert.equal(h.executions.length, 0);
  assert.equal(h.twilio.readyState, 3);
  assert.equal(h.live.events('session.close').length, 1);
});

test('missing session.closed never reports finalized usage after phone hangup', async (t) => {
  const h = harness(t, { limits: { closeTimeoutMs: 10 } });
  await h.ready();
  h.live.receive({ type: 'session.usage.updated', usage: { seconds: 2 } });
  h.twilio.receive({ event: 'stop' });
  await pause(25);
  assert.equal(h.live.readyState, 3);
  assert.equal(h.controller.getSummary().voiceSeconds, 2);
  assert.equal(h.controller.getSummary().usageFinalized, false);
  assert.equal(h.live.events('session.close').length, 1);
});
