import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachLiveCall } from '../src/realtimeHandler.js';

const CALL_SID = `CA${'1'.repeat(32)}`;
const FRAME = Buffer.alloc(160, 0xff).toString('base64');
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

function harness(t, { isOwner = true, grantValid = true, executeTool, limits = {} } = {}) {
  const twilio = new FakeSocket();
  const live = new FakeSocket(0);
  const connections = [];
  const grants = [];
  const executions = [];
  const controller = attachLiveCall(twilio, {
    security: {
      consumeGrant(input) {
        grants.push(input);
        return grantValid && input.token === 'fake-grant' && input.callSid === CALL_SID
          ? { isOwner, callSid: CALL_SID }
          : null;
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
    logger: { log() {}, info() {}, warn() {}, error() {} },
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

  return { twilio, live, controller, connections, grants, executions, start, ready, backend, created, call, completed };
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

test('verified start configures Live once and buffers phone input until session.started', async (t) => {
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
  assert.equal(h.live.events('session.input_audio.append')[0].audio, FRAME);
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

test('pre-readiness phone audio is bounded while the provider starts', async (t) => {
  const h = harness(t, { limits: { maxPendingInputBytes: 160 } });
  await h.start();
  h.live.open();
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  h.twilio.receive({ event: 'media', media: { payload: FRAME } });
  assert.equal(h.twilio.readyState, 3);
  assert.equal(h.live.events('session.input_audio.append').length, 0);
  h.live.receive({ type: 'session.started', session: { id: 'sess_late' } });
  assert.equal(h.live.events('session.close').length, 1);
  assert.equal(h.live.events('session.input_audio.append').length, 0);
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
