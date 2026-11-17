import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachLiveCall } from '../src/realtimeHandler.js';
import { buildLiveSession } from '../src/assistantConfig.js';

const CALL_SID = `CA${'1'.repeat(32)}`;
const FRAME = Buffer.alloc(160, 0xff).toString('base64');
const NON_SILENT_FRAME = Buffer.alloc(160, 0x42).toString('base64');
const FAKE_PRIVATE_TEXT = 'PRIVATE_TEST_PAYLOAD_764928315607';
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
  isOwner = true,
  grantValid = true,
  executeTool,
  now,
  liveReadyState = 0,
  limits = {},
} = {}) {
  const twilio = new FakeSocket();
  const live = new FakeSocket(liveReadyState);
  const connections = [];
  const grants = [];
  const executions = [];
  const logs = [];
  const verifiedStarts = [];
  const finishes = [];
  let grantConsumed = false;
  const controller = attachLiveCall(twilio, {
    security: {
      consumeGrant(input) {
        grants.push(input);
        if (!grantValid || grantConsumed || input.token !== 'fake-grant' || input.callSid !== CALL_SID) return null;
        grantConsumed = true;
        return { isOwner, callSid: CALL_SID };
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
    onVerifiedStart: (...args) => verifiedStarts.push(args),
    onFinish: () => finishes.push(true),
    ...(now ? { now } : {}),
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

  const start = async ({ token = 'fake-grant', callSid = CALL_SID, streamSid = 'MZfake', customParameters = {} } = {}) => {
    twilio.receive({
      event: 'start',
      start: {
        streamSid,
        callSid,
        customParameters: { grantToken: token, ...customParameters },
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
  return { twilio, live, controller, connections, grants, executions, logs, verifiedStarts, finishes, start, ready, backend, created, call, completed, dtmf };
}

test('unverified media streams cannot start a provider session', async (t) => {
  const h = harness(t, { grantValid: false });
  assert.equal(h.connections.length, 1, 'provider transport begins warming before the Twilio start');
  h.live.open();
  assert.equal(h.live.events('session.start').length, 0);
  await h.start();
  assert.equal(h.grants.length, 1);
  assert.equal(h.connections.length, 1);
  assert.equal(h.live.events('session.start').length, 0, 'a warm transport cannot create an unverified paid session');
  assert.equal(h.verifiedStarts.length, 0);
  assert.equal(h.live.readyState, 3);
  assert.equal(h.twilio.readyState, 3);
});

test('phone audio arriving before a verified start closes the warm transport without starting a session', async (t) => {
  const h = harness(t);
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  await h.start();
  assert.equal(h.grants.length, 0);
  assert.equal(h.connections.length, 1);
  assert.equal(h.live.events('session.start').length, 0);
  assert.equal(h.live.readyState, 3);
  assert.equal(h.twilio.readyState, 3);
});

test('verified start configures Live once and discards setup audio until session.started', async (t) => {
  const h = harness(t);
  await h.start();
  assert.equal(h.connections.length, 1);
  assert.deepEqual(h.connections[0], {});
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
  assert.deepEqual(h.live.events('session.start')[0].session, buildLiveSession({ isOwner: true }), 'the session builder owns the greeting input and instructions');
  assert.equal(h.live.events('session.start').length, 1);
});

test('provider transport may open first but a paid session waits for a verified phone start', async (t) => {
  let clock = 100;
  const h = harness(t, { isOwner: false, now: () => clock });
  assert.equal(h.connections.length, 1);
  assert.equal(h.controller.getSummary().timings.providerConnectMs, 0);
  clock = 110;
  h.live.open();
  assert.equal(h.live.events('session.start').length, 0);
  assert.equal(h.verifiedStarts.length, 0);
  clock = 125;
  await h.start();
  assert.equal(h.live.events('session.start').length, 1);
  assert.equal(h.verifiedStarts.length, 1);
  assert.deepEqual(h.controller.getSummary().timings, {
    providerConnectMs: 0,
    phoneStartMs: 25,
    providerOpenMs: 10,
    sessionStartSentMs: 25,
    sessionReadyMs: null,
    firstInputAudioMs: null,
    firstOutputAudioMs: null,
    firstPlaybackAckMs: null,
  });
});

test('a verified phone start may arrive first but session.start waits for the provider socket to open', async (t) => {
  let clock = 500;
  const h = harness(t, { now: () => clock });
  clock = 512;
  await h.start();
  assert.equal(h.verifiedStarts.length, 1);
  assert.equal(h.live.events('session.start').length, 0);
  assert.equal(h.controller.getSummary().timings.phoneStartMs, 12);
  assert.equal(h.controller.getSummary().timings.providerOpenMs, null);
  clock = 530;
  h.live.open();
  assert.equal(h.live.events('session.start').length, 1);
  assert.equal(h.controller.getSummary().timings.providerOpenMs, 30);
  assert.equal(h.controller.getSummary().timings.sessionStartSentMs, 30);
  clock = 535;
  h.live.emit('open');
  assert.equal(h.live.events('session.start').length, 1, 'duplicate open cannot start another session');
  assert.equal(h.controller.getSummary().timings.providerOpenMs, 30);
});

test('an already-open provider transport still waits for the verified grant', async (t) => {
  const h = harness(t, { liveReadyState: 1 });
  assert.equal(h.connections.length, 1);
  assert.equal(h.live.events('session.start').length, 0);
  assert.notEqual(h.controller.getSummary().timings.providerOpenMs, null);
  await h.start();
  assert.equal(h.live.events('session.start').length, 1);
  assert.equal(h.verifiedStarts.length, 1);
});

test('missing, invalid, and rejected replay grants cannot start a session on a warmed transport', async (t) => {
  for (const { name, token, grantValid = true } of [
    { name: 'missing', token: null },
    { name: 'invalid', token: 'unrecognized-grant' },
    { name: 'replay rejected by grant consumer', token: 'fake-grant', grantValid: false },
  ]) {
    await t.test(name, async (t) => {
      const h = harness(t, { grantValid });
      h.live.open();
      await h.start({ token });
      assert.equal(h.connections.length, 1);
      assert.equal(h.live.events('session.start').length, 0);
      assert.equal(h.verifiedStarts.length, 0);
      assert.equal(h.controller.getSummary().reason, 'unauthorized_stream');
      assert.equal(h.live.readyState, 3);
      assert.equal(h.twilio.readyState, 3);
    });
  }
});

test('a duplicate stream start cannot reuse a grant or start another provider session', async (t) => {
  const h = harness(t);
  await h.ready();
  await h.start();
  assert.equal(h.grants.length, 1);
  assert.equal(h.verifiedStarts.length, 1);
  assert.equal(h.live.events('session.start').length, 1);
  assert.equal(h.controller.getSummary().reason, 'duplicate_stream_start');
});

test('unclaimed warm transports time out or shut down without starting a session or reconnecting', async (t) => {
  for (const mode of ['timeout', 'shutdown']) {
    await t.test(mode, async (t) => {
      const h = harness(t, { limits: { startTimeoutMs: 10 } });
      h.live.open();
      if (mode === 'shutdown') h.controller.close('server_shutdown');
      else await pause(25);
      assert.equal(h.connections.length, 1);
      assert.equal(h.live.events('session.start').length, 0);
      assert.equal(h.live.readyState, 3);
      assert.equal(h.twilio.readyState, 3);
      assert.equal(h.finishes.length, 1);
      assert.equal(h.controller.getSummary().reason, mode === 'timeout' ? 'startup_timeout' : 'server_shutdown');
      assert.equal(h.controller.getSummary().timings.phoneStartMs, null);
      assert.equal(h.controller.getSummary().timings.sessionStartSentMs, null);
    });
  }
});

test('startup, first audio, and playback milestones use the injected monotonic clock once', async (t) => {
  let clock = 100;
  const h = harness(t, { now: () => clock });
  clock = 110;
  h.live.open();
  clock = 120;
  await h.start();
  clock = 125;
  h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
  assert.equal(h.controller.getSummary().timings.firstInputAudioMs, null, 'discarded startup audio is not measured as input');
  clock = 130;
  h.live.receive({ type: 'session.started', session: { id: 'sess_timed' } });
  clock = 135;
  h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
  clock = 140;
  h.live.receive({ type: 'session.output_audio.delta', delta: FRAME });
  clock = 145;
  h.twilio.receive({ event: 'mark', streamSid: 'MZfake', mark: { name: 'unrecognized-mark' } });
  assert.equal(h.controller.getSummary().timings.firstPlaybackAckMs, null);
  clock = 150;
  h.twilio.receive({ event: 'mark', streamSid: 'MZfake', mark: h.twilio.events('mark')[0].mark });
  clock = 160;
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  h.live.receive({ type: 'session.output_audio.delta', delta: FRAME });
  h.twilio.receive({ event: 'mark', streamSid: 'MZfake', mark: h.twilio.events('mark')[1].mark });
  assert.deepEqual(h.controller.getSummary().timings, {
    providerConnectMs: 0, phoneStartMs: 20, providerOpenMs: 10,
    sessionStartSentMs: 20, sessionReadyMs: 30, firstInputAudioMs: 35,
    firstOutputAudioMs: 40, firstPlaybackAckMs: 50,
  });
  assert.deepEqual(h.logs.filter((log) => ['[Live] first output audio', '[Live] first playback acknowledged'].includes(log.args[0])), [
    { level: 'info', args: ['[Live] first output audio', { sessionId: 'sess_timed', elapsedMs: 40 }] },
    { level: 'info', args: ['[Live] first playback acknowledged', { sessionId: 'sess_timed', elapsedMs: 50 }] },
  ]);
  assert.equal(h.controller.getSummary().playedAudioBytes, 320);
});

test('Victoria can send the greeting before the caller sends any ready-state audio', async (t) => {
  const h = harness(t);
  await h.ready();
  h.live.receive({ type: 'session.output_audio.delta', delta: FRAME });
  assert.equal(h.twilio.events('media').length, 1);
  assert.equal(h.controller.getSummary().timings.firstInputAudioMs, null);
  assert.notEqual(h.controller.getSummary().timings.firstOutputAudioMs, null);
});

test('the ready greeting cue is sent once for each caller greeting without waiting for speech', async (t) => {
  for (const isOwner of [false, true]) {
    await t.test(isOwner ? 'recognized caller' : 'other caller', async (t) => {
      const h = harness(t, { isOwner });
      await h.start();
      h.live.open();
      const start = h.live.events('session.start')[0];
      assert.equal(h.live.events('session.commentary.append').length, 0, 'wait for readiness');
      h.live.receive({ type: 'session.started', session: { id: 'sess_greeting' } });
      const [cue] = h.live.events('session.commentary.append');
      assert.ok(cue, 'readiness prompts the greeting before any caller audio');
      assert.deepEqual(Object.keys(cue).sort(), ['content', 'delegation_id', 'event_id', 'type']);
      assert.equal(cue.delegation_id, null);
      assert.equal(cue.content, start.session.input[0].content[0].text);
      assert.match(cue.event_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      assert.notEqual(cue.event_id, start.event_id);
      assert.equal(h.controller.getSummary().timings.firstInputAudioMs, null);

      h.live.receive({ type: 'session.commentary.appended', client_event_id: cue.event_id });
      assert.equal(h.twilio.events('media').length, 0, 'acknowledgment does not count as spoken audio');
      h.live.receive({ type: 'session.started', session: { id: 'sess_greeting' } });
      assert.equal(h.live.events('session.commentary.append').length, 1, 'acknowledgment and duplicate readiness do not repeat the cue');
      h.twilio.receive({ event: 'media', media: { payload: FRAME } });
      h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
      assert.deepEqual(h.live.events('session.input_audio.append').map((event) => event.audio), [FRAME, NON_SILENT_FRAME], 'silence and speech keep flowing unchanged');
      h.live.receive({ type: 'session.output_audio.delta', delta: NON_SILENT_FRAME });
      assert.equal(h.twilio.events('media')[0].media.payload, NON_SILENT_FRAME);
      assert.equal(h.live.events('session.commentary.append').length, 1);
    });
  }
});

test('a session that becomes ready during shutdown is closed without a greeting cue', async (t) => {
  const h = harness(t);
  await h.start();
  h.live.open();
  h.controller.close('caller_stopped');
  h.live.receive({ type: 'session.started', session: { id: 'sess_closing' } });
  assert.equal(h.live.events('session.commentary.append').length, 0);
  assert.equal(h.live.events('session.close').length, 1);
});

test('a failed greeting delivery closes cleanly without retrying', async (t) => {
  const h = harness(t);
  const originalSend = h.live.send.bind(h.live);
  let attempts = 0;
  h.live.send = (payload) => {
    if (JSON.parse(payload).type === 'session.commentary.append') {
      attempts += 1;
      throw new Error('fake send failure');
    }
    originalSend(payload);
  };
  await h.ready();
  h.live.receive({ type: 'session.started', session: { id: 'sess_fake' } });
  assert.equal(attempts, 1);
  assert.equal(h.controller.getSummary().reason, 'greeting_delivery_failed');
  assert.equal(h.live.events('session.close').length, 1);
  assert.equal(h.twilio.readyState, 3);
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

test('every verified caller receives web search and can execute each read-only code tool', async (t) => {
  for (const isOwner of [false, true]) {
    await t.test(isOwner ? 'recognized caller' : 'public caller', async (t) => {
      const h = harness(t, { isOwner });
      await h.ready();
      const session = h.live.events('session.start')[0].session;
      assert.deepEqual(session.delegation.responses.tools.map((tool) => tool.name || tool.type), [
        'web_search', 'get_codebase_overview', 'search_codebase', 'read_code_snippet',
      ]);
      assert.equal(session.delegation.responses.tool_choice, 'auto');
      assert.equal(h.controller.getSummary().isOwner, isOwner, 'recognized identity changes the persona only');
      h.created('response_tools');
      h.call('response_tools', 'call_overview', { maxFiles: 2 });
      h.call('response_tools', 'call_search', { query: 'Live', limit: 2 }, 'search_codebase');
      h.call('response_tools', 'call_read', { filePath: 'src/assistantConfig.js', startLine: 1, endLine: 3 }, 'read_code_snippet');
      h.completed('response_tools');
      await tick();
      assert.deepEqual(h.executions.map((execution) => execution.name), [
        'get_codebase_overview', 'search_codebase', 'read_code_snippet',
      ]);
      assert.equal(h.live.events('response.item.create').length, 3);
      assert.ok(h.live.events('response.item.create').every((event) => JSON.parse(event.item.output).ok));
      assert.equal(h.live.events('response.create').length, 1);
    });
  }
});

test('keypad input has no authentication role and post-ready audio is always forwarded unchanged', async (t) => {
  const h = harness(t, { isOwner: false });
  h.dtmf('*');
  await h.ready();
  const session = h.live.events('session.start')[0].session;
  assert.equal(session.audio.output.voice, 'marin');
  assert.doesNotMatch(JSON.stringify(session), /owner PIN|keypad|verification is pending/i);
  for (const digit of ['1', '2', '3', '4', '#', '*']) h.dtmf(digit);
  h.twilio.receive({ event: 'media', media: { payload: NON_SILENT_FRAME } });
  assert.equal(h.live.events('session.input_audio.append')[0].audio, NON_SILENT_FRAME);
  assert.equal(h.live.events('session.update').length, 0);
  assert.equal(h.live.events('session.instructions.append').length, 0);
  assert.equal(h.controller.getSummary().isOwner, false);
  assert.equal(h.twilio.readyState, 1);
});

test('only a strict recognized flag in the verified grant selects the personal greeting', async (t) => {
  for (const isOwner of [true, false, 'true', 1]) {
    await t.test(`${typeof isOwner}:${isOwner}`, async (t) => {
      const h = harness(t, { isOwner });
      await h.ready();
      const recognized = isOwner === true;
      assert.equal(h.controller.getSummary().isOwner, recognized);
      assert.deepEqual(h.live.events('session.start')[0].session, buildLiveSession({ isOwner: recognized }));
      assert.deepEqual(h.connections[0], {}, 'warming transport never takes caller identity from unverified input');
    });
  }
});

test('caller-supplied identity fields cannot override the greeting selected by the verified grant', async (t) => {
  const h = harness(t, { isOwner: false });
  h.live.open();
  await h.start({ customParameters: { isOwner: 'true', role: 'owner', callerPhone: 'FAKE_OWNER_NUMBER' } });
  assert.equal(h.controller.getSummary().isOwner, false);
  assert.deepEqual(h.live.events('session.start')[0].session, buildLiveSession({ isOwner: false }));
  assert.equal(h.live.events('session.start')[0].session.delegation.responses.tools.length, 4, 'tool availability does not depend on caller identity');
});

test('provider diagnostics log safe identifiers and correlated commands without echoing payloads', async (t) => {
  const fakeCredential = 'FAKE_CREDENTIAL_FOR_PRIVACY_TEST_ONLY';
  for (const idLocation of ['nested', 'top', 'unrelated nested takes precedence']) {
    await t.test(idLocation, async (t) => {
      const h = harness(t);
      await h.ready();
      const sent = h.live.events('session.start')[0];
      const nestedId = idLocation === 'nested' ? sent.event_id
        : idLocation === 'unrelated nested takes precedence' ? 'unrelated_command' : undefined;
      h.live.receive({
        type: 'error',
        ...(idLocation !== 'nested' ? { client_event_id: sent.event_id } : {}),
        error: {
          code: 'missing_required_parameter',
          param: 'session.delegation.type',
          ...(nestedId ? { client_event_id: nestedId } : {}),
          message: `Untrusted payload ${FAKE_PRIVATE_TEXT} ${fakeCredential}`,
          details: { private: FAKE_PRIVATE_TEXT, credential: fakeCredential },
        },
      });
      h.live.receive({ type: 'session.closed', usage: { seconds: 1 } });
      const warnings = h.logs.filter((log) => log.level === 'warn');
      assert.deepEqual(warnings, [{
        level: 'warn',
        args: ['[Live] provider rejected a command', {
          code: 'missing_required_parameter',
          parameter: 'session.delegation.type',
          command: idLocation === 'unrelated nested takes precedence' ? 'unknown' : 'session.start',
        }],
      }]);
      assert.equal(h.controller.getSummary().reason, 'provider_error');
      const serializedLogs = JSON.stringify(h.logs);
      assert.equal(serializedLogs.includes(FAKE_PRIVATE_TEXT), false);
      assert.equal(serializedLogs.includes(fakeCredential), false);
      assert.equal(serializedLogs.includes(sent.event_id), false, 'raw correlation IDs remain out of the log');
      assert.equal(serializedLogs.includes('Untrusted payload'), false);
    });
  }
});

test('unknown and malformed provider diagnostics are replaced with fixed safe labels', async (t) => {
  for (const fields of [
    { code: FAKE_PRIVATE_TEXT, param: 'FAKE_PRIVATE_PARAMETER_FOR_TEST_ONLY' },
    { code: { private: FAKE_PRIVATE_TEXT }, param: [FAKE_PRIVATE_TEXT] },
    {},
  ]) {
    await t.test(typeof fields.code, async (t) => {
      const h = harness(t);
      await h.ready();
      h.live.receive({
        type: 'error', client_event_id: 'unrelated_command',
        error: { ...fields, message: `Never log ${FAKE_PRIVATE_TEXT}` },
      });
      const warning = h.logs.find((log) => log.level === 'warn');
      assert.deepEqual(warning.args, ['[Live] provider rejected a command', {
        code: 'unknown', parameter: 'unknown', command: 'unknown',
      }]);
      assert.equal(JSON.stringify(h.logs).includes(FAKE_PRIVATE_TEXT), false);
      assert.equal(h.controller.getSummary().reason, 'provider_error');
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

test('failure to deliver a backend failure notice closes the call', async (t) => {
  const h = harness(t);
  await h.ready();
  h.created('response_failed');
  h.live.bufferedAmount = 256 * 1024 + 1;
  h.backend({ type: 'response.failed', response: { id: 'response_failed', status: 'failed' } });
  assert.equal(h.controller.getSummary().reason, 'backend_failure_notice_delivery_failed');
  assert.equal(h.twilio.readyState, 3);
  assert.equal(h.live.events('session.instructions.append').length, 0);
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
