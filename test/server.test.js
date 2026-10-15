import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import twilio from 'twilio';
import WebSocket from 'ws';
import { createVoiceServer } from '../src/server.js';

const publicOrigin = 'https://voice.example.test';
const authToken = 'fake-twilio-token-for-tests';
const ownerPhone = '+12025550123';
const publicPhone = '+12025550124';
const callSid = `CA${'a'.repeat(32)}`;
const streamSid = `MZ${'b'.repeat(32)}`;

class FakeLiveSocket extends EventEmitter {
  constructor(onStart) {
    super();
    this.readyState = WebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.commands = [];
    this.onStart = onStart;
    setImmediate(() => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }

  send(value) {
    const command = JSON.parse(value);
    this.commands.push(command);
    if (command.type === 'session.start') {
      queueMicrotask(() => {
        if (this.readyState === WebSocket.OPEN) {
          this.emit('message', JSON.stringify({ type: 'session.started', session: { id: 'fake-session' } }));
          this.onStart(command.session);
        }
      });
    } else if (command.type === 'session.close') {
      queueMicrotask(() => {
        if (this.readyState === WebSocket.OPEN) {
          this.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 0 } }));
        }
      });
    } else if (command.type === 'session.update') {
      if (command.session?.delegation?.type !== 'responses') {
        queueMicrotask(() => this.emit('message', JSON.stringify({
          type: 'error',
          error: { code: 'invalid_request_error', param: 'session.delegation.type' },
        })));
        return;
      }
      this.emit('updateRequested', command);
      queueMicrotask(() => {
        if (this.readyState === WebSocket.OPEN) {
          const acknowledgment = { type: 'session.updated', client_event_id: command.event_id };
          this.emit('message', JSON.stringify(acknowledgment));
          this.emit('updated', acknowledgment);
        }
      });
    } else if (command.type === 'session.input_audio.append') {
      this.emit('inputAudio', command);
    }
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate() { this.close(); }
}

async function harness(t, envOverrides = {}) {
  const events = new EventEmitter();
  const clients = [];
  const providers = [];
  const logs = [];
  const env = {
    TWILIO_STREAM_URL: `${publicOrigin.replace('https:', 'wss:')}/realtime`,
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_OWNER_PHONE: ownerPhone,
    TWILIO_OWNER_PIN: '04231',
    OPENAI_API_KEY: 'fake-openai-key-never-sent',
    ...envOverrides,
  };
  const { server, wss } = createVoiceServer({
    env,
    logger: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
    connectLive: ({ isOwner }) => {
      const provider = new FakeLiveSocket((session) => events.emit('started', { isOwner, session }));
      providers.push(provider);
      return provider;
    },
    limits: { startTimeoutMs: 1000, closeTimeoutMs: 50, maxCallMs: 2000 },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const provider of providers) provider.terminate();
    for (const client of wss?.clients || []) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(server.listening, false);
    assert.equal(server.address(), null);
  });

  function post(path, params, signed = true) {
    const body = new URLSearchParams(params).toString();
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body),
    };
    if (signed) headers['X-Twilio-Signature'] = twilio.getExpectedTwilioSignature(authToken, `${publicOrigin}${path}`, params);
    return new Promise((resolve, reject) => {
      const request = http.request(`${origin}${path}`, { method: 'POST', headers, agent: false }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
      });
      request.on('error', reject);
      request.end(body);
    });
  }

  function websocket(signed = true, signatureUrl = env.TWILIO_STREAM_URL) {
    const headers = signed ? {
      'X-Twilio-Signature': twilio.getExpectedTwilioSignature(authToken, signatureUrl, {}),
    } : {};
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/realtime`, { headers });
    clients.push(socket);
    return socket;
  }

  async function startStream(token, customParameters = {}) {
    const socket = websocket();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await once(socket, 'open', { signal: AbortSignal.timeout(1000) });
    socket.send(JSON.stringify({
      event: 'start',
      start: {
        callSid,
        streamSid,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters: { grantToken: token, ...customParameters },
      },
    }));
    return { socket, closed };
  }

  return { post, websocket, startStream, providers, events, logs, server };
}

const grantFrom = (response) => {
  assert.equal(response.status, 200);
  assert.match(response.text, /<Stream url="wss:\/\/voice\.example\.test\/realtime"/);
  const match = response.text.match(/<Parameter name="grantToken" value="([\w-]+)"/);
  assert.ok(match, 'response includes a single-use stream grant');
  return match[1];
};
const started = (events) => once(events, 'started', { signal: AbortSignal.timeout(1000) });

test('signed public webhook issues a grant and spoofed stream parameters cannot enable private tools', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: publicPhone });
  assert.match(response.headers['content-type'], /text\/xml/);
  assert.equal((response.text.match(/<Parameter /g) || []).length, 1);
  assert.doesNotMatch(response.text, /<Gather|<Say|<Redirect/);
  assert.match(response.text, /<\/Connect><Hangup\/>/);
  const sessionPromise = started(app.events);
  await app.startStream(grantFrom(response), {
    customerPhone: ownerPhone, isOwner: 'true', ownerVerified: 'true', ownerVerificationPending: 'true',
  });
  const [{ isOwner, session }] = await sessionPromise;
  assert.equal(isOwner, false);
  assert.equal(session.model, 'gpt-live-1');
  assert.deepEqual(session.delegation.responses.tools, []);
});

test('unsigned HTTP requests are forbidden before a provider can start', async (t) => {
  const app = await harness(t);
  for (const path of ['/voice', '/voice/owner', '/voice/public']) {
    const response = await app.post(path, { CallSid: callSid, From: ownerPhone, Digits: '04231' }, false);
    assert.equal(response.status, 403);
    assert.doesNotMatch(response.text, /grantToken|<Gather/);
  }
  assert.equal(app.providers.length, 0);
});

test('signed owner caller connects directly to Victoria without gaining private tools before verification', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: ownerPhone });
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, /<Gather|<Say|<Redirect/);
  assert.match(response.text, /<\/Connect><Hangup\/>/);
  assert.equal(app.providers.length, 0);
  const sessionPromise = started(app.events);
  await app.startStream(grantFrom(response));
  const [{ isOwner, session }] = await sessionPromise;
  assert.equal(isOwner, false);
  assert.deepEqual(session.delegation.responses.tools, []);
});

test('signed owner call enables private tools after keypad verification and the matching Live update acknowledgment', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: ownerPhone });
  const sessionPromise = started(app.events);
  const client = await app.startStream(grantFrom(response));
  const [{ isOwner, session }] = await sessionPromise;
  assert.equal(isOwner, false);
  assert.deepEqual(session.delegation.responses.tools, []);
  assert.equal(app.logs.find(([message]) => message === '[Live] session ready')[1].ownerVerificationPending, true);
  const provider = app.providers[0];
  let ownerEnabledBeforeAcknowledgment;
  provider.once('updateRequested', () => {
    ownerEnabledBeforeAcknowledgment = app.logs.some(([message]) => message === '[Live] owner access enabled');
  });
  const updateRequested = once(provider, 'updateRequested', { signal: AbortSignal.timeout(1000) });
  const updated = once(provider, 'updated', { signal: AbortSignal.timeout(1000) });
  for (const digit of '04231#') {
    client.socket.send(JSON.stringify({ event: 'dtmf', streamSid, dtmf: { track: 'inbound', digit } }));
  }
  const [update] = await updateRequested;
  assert.equal(ownerEnabledBeforeAcknowledgment, false);
  assert.deepEqual(update.session.delegation.responses.tools.map((tool) => tool.name || tool.type), [
    'web_search', 'get_codebase_overview', 'search_codebase', 'read_code_snippet',
  ]);
  const [acknowledgment] = await updated;
  assert.equal(acknowledgment.client_event_id, update.event_id);
  assert.equal(app.logs.filter(([message]) => message === '[Live] owner access enabled').length, 1);
  assert.equal(app.providers.length, 1);
  assert.equal(provider.commands.filter((command) => command.type === 'session.start').length, 1);
  assert.equal(provider.commands.filter((command) => command.type === 'session.update').length, 1);
  assert.equal(JSON.stringify({ commands: provider.commands, logs: app.logs }).includes('04231'), false);
});

test('star skips owner verification and resumes public conversation with unchanged phone audio', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: ownerPhone });
  const sessionPromise = started(app.events);
  const client = await app.startStream(grantFrom(response));
  await sessionPromise;
  const provider = app.providers[0];
  const updateRequested = once(provider, 'updateRequested', { signal: AbortSignal.timeout(1000) });
  const updated = once(provider, 'updated', { signal: AbortSignal.timeout(1000) });
  client.socket.send(JSON.stringify({ event: 'dtmf', streamSid, dtmf: { track: 'inbound', digit: '*' } }));
  const [update] = await updateRequested;
  assert.equal(update.session.delegation.type, 'responses');
  assert.deepEqual(update.session.delegation.responses.tools, []);
  assert.equal(update.session.delegation.responses.tool_choice, 'none');
  const [acknowledgment] = await updated;
  assert.equal(acknowledgment.client_event_id, update.event_id);
  const continuation = provider.commands.find((command) => command.type === 'session.instructions.append');
  assert.match(continuation.content, /Continue with public caller permissions/);

  const payload = Buffer.from(Array.from({ length: 160 }, (_, index) => index % 128)).toString('base64');
  assert.notEqual(payload, Buffer.alloc(160, 0xff).toString('base64'));
  const audioForwarded = once(provider, 'inputAudio', { signal: AbortSignal.timeout(1000) });
  client.socket.send(JSON.stringify({ event: 'media', streamSid, media: { track: 'inbound', payload } }));
  const [forwarded] = await audioForwarded;
  assert.equal(forwarded.audio, payload);
  assert.equal(app.logs.some(([message]) => message === '[Live] owner access enabled'), false);
  assert.equal(provider.commands.some((command) => command.type === 'session.close'), false);
  assert.equal(provider.readyState, WebSocket.OPEN);
  assert.equal(client.socket.readyState, WebSocket.OPEN);
  assert.equal(app.providers.length, 1);
  assert.equal(provider.commands.filter((command) => command.type === 'session.start').length, 1);
  assert.equal(provider.commands.filter((command) => command.type === 'session.update').length, 1);
});

test('only a correct PIN and signed owner caller grant private tools', async (t) => {
  for (const [name, from, digits, expectedOwner] of [
    ['correct owner PIN', ownerPhone, '04231', true],
    ['incorrect owner PIN', ownerPhone, '00000', false],
    ['missing owner PIN', ownerPhone, null, false],
    ['public caller with known PIN', publicPhone, '04231', false],
  ]) {
    await t.test(name, async (subtest) => {
      const app = await harness(subtest);
      const params = { CallSid: callSid, From: from };
      if (digits !== null) params.Digits = digits;
      const response = await app.post('/voice/owner', params);
      const sessionPromise = started(app.events);
      await app.startStream(grantFrom(response));
      const [{ isOwner, session }] = await sessionPromise;
      assert.equal(isOwner, expectedOwner);
      const toolNames = session.delegation.responses.tools.map((tool) => tool.name || tool.type);
      assert.deepEqual(toolNames, expectedOwner
        ? ['web_search', 'get_codebase_overview', 'search_codebase', 'read_code_snippet']
        : []);
      assert.equal(JSON.stringify(app.logs).includes('04231'), false);
    });
  }
});

test('signed public fallback cannot elevate an owner caller without a PIN', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice/public', { CallSid: callSid, From: ownerPhone });
  const sessionPromise = started(app.events);
  await app.startStream(grantFrom(response));
  const [{ isOwner }] = await sessionPromise;
  assert.equal(isOwner, false);
});

test('unsigned WebSocket upgrade is rejected before provider connection', async (t) => {
  const app = await harness(t);
  const socket = app.websocket(false);
  await assert.rejects(once(socket, 'open', { signal: AbortSignal.timeout(1000) }), /403/);
  assert.equal(app.providers.length, 0);
});

test('HTTPS-signed WebSocket upgrade is rejected before provider connection', async (t) => {
  const app = await harness(t);
  const socket = app.websocket(true, `${publicOrigin}/realtime`);
  await assert.rejects(once(socket, 'open', { signal: AbortSignal.timeout(1000) }), /403/);
  assert.equal(app.providers.length, 0);
});

test('WebSocket upgrade accepts Twilio trailing-slash signature normalization', async (t) => {
  const app = await harness(t);
  const socket = app.websocket(true, `${publicOrigin.replace('https:', 'wss:')}/realtime/`);
  await once(socket, 'open', { signal: AbortSignal.timeout(1000) });
  assert.equal(app.providers.length, 0);
});

test('a consumed stream grant cannot start a second provider connection', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: publicPhone });
  const token = grantFrom(response);
  const sessionPromise = started(app.events);
  await app.startStream(token);
  await sessionPromise;
  const replay = await app.startStream(token);
  await replay.closed;
  assert.equal(app.providers.length, 1);
});

test('server shutdown closes and finalizes an active Live call before releasing its listener', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: publicPhone });
  const sessionPromise = started(app.events);
  const client = await app.startStream(grantFrom(response));
  await sessionPromise;
  const provider = app.providers[0];
  assert.equal(provider.readyState, WebSocket.OPEN);
  await new Promise((resolve) => app.server.close(resolve));
  await client.closed;

  assert.equal(provider.commands.filter((command) => command.type === 'session.close').length, 1);
  assert.equal(provider.readyState, WebSocket.CLOSED);
  assert.equal(client.socket.readyState, WebSocket.CLOSED);
  assert.equal(app.providers.length, 1);
  const ended = app.logs.filter(([message]) => message === '[Live] call ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0][1].reason, 'server_shutdown');
  assert.equal(ended[0][1].usageFinalized, true);
  assert.equal(app.server.listening, false);
  assert.equal(app.server.address(), null);
});

test('missing required runtime configuration fails closed without a provider connection', async (t) => {
  for (const name of ['TWILIO_AUTH_TOKEN', 'OPENAI_API_KEY', 'TWILIO_STREAM_URL']) {
    await t.test(name, async (subtest) => {
      const app = await harness(subtest, { [name]: '' });
      const response = await app.post('/voice', { CallSid: callSid, From: publicPhone });
      assert.equal(response.status, 503);
      assert.equal(app.providers.length, 0);
    });
  }
});
