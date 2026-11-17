import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import twilio from 'twilio';
import WebSocket from 'ws';
import { createVoiceServer } from '../src/server.js';
import { OWNER_GREETING, PUBLIC_GREETING } from '../src/assistantConfig.js';

const publicOrigin = 'https://voice.example.test';
const authToken = 'fake-twilio-token-for-tests';
const ownerPhone = '+12025550123';
const publicPhone = '+12025550124';
const callSid = `CA${'a'.repeat(32)}`;
const streamSid = `MZ${'b'.repeat(32)}`;
const expectedTools = ['web_search', 'get_codebase_overview', 'search_codebase', 'read_code_snippet'];

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

async function harness(t, envOverrides = {}, limitOverrides = {}) {
  const events = new EventEmitter();
  const clients = [];
  const providers = [];
  const logs = [];
  const env = {
    TWILIO_STREAM_URL: `${publicOrigin.replace('https:', 'wss:')}/realtime`,
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_OWNER_PHONE: ownerPhone,
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
    connectLive: () => {
      const provider = new FakeLiveSocket((session) => events.emit('started', { session }));
      providers.push(provider);
      return provider;
    },
    limits: { startTimeoutMs: 1000, closeTimeoutMs: 50, maxCallMs: 2000, ...limitOverrides },
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

  function post(path, params, signed = true, extraHeaders = {}) {
    const body = new URLSearchParams(params).toString();
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body),
      ...extraHeaders,
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

  function sendStart(socket, token, customParameters = {}) {
    socket.send(JSON.stringify({
      event: 'start',
      start: {
        callSid,
        streamSid,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters: { grantToken: token, ...customParameters },
      },
    }));
  }

  async function startStream(token, customParameters = {}) {
    const socket = websocket();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await once(socket, 'open', { signal: AbortSignal.timeout(1000) });
    sendStart(socket, token, customParameters);
    return { socket, closed };
  }

  return { post, websocket, startStream, sendStart, providers, events, logs, server };
}

const grantFrom = (response) => {
  assert.equal(response.status, 200);
  assert.match(response.text, /<Stream url="wss:\/\/voice\.example\.test\/realtime"/);
  const match = response.text.match(/<Parameter name="grantToken" value="([\w-]+)"/);
  assert.ok(match, 'response includes a single-use stream grant');
  return match[1];
};
const started = (events) => once(events, 'started', { signal: AbortSignal.timeout(1000) });
const assertSession = (session, isOwner) => {
  const initialInstruction = session.input[0].content[0].text;
  assert.equal(initialInstruction.includes(isOwner ? OWNER_GREETING : PUBLIC_GREETING), true);
  assert.equal(initialInstruction.includes(isOwner ? PUBLIC_GREETING : OWNER_GREETING), false);
  assert.deepEqual(session.delegation.responses.tools.map((tool) => tool.name || tool.type), expectedTools);
};

test('signed public callers get shared tools while forged stream identity cannot change their greeting', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: publicPhone });
  assert.match(response.headers['content-type'], /text\/xml/);
  assert.equal((response.text.match(/<Parameter /g) || []).length, 1);
  assert.doesNotMatch(response.text, /<Gather|<Say|<Redirect/);
  assert.match(response.text, /<\/Connect><Hangup\/>/);
  const sessionPromise = started(app.events);
  await app.startStream(grantFrom(response), {
    customerPhone: ownerPhone, isOwner: 'true',
  });
  const [{ session }] = await sessionPromise;
  assert.equal(session.model, 'gpt-live-1');
  assertSession(session, false);
});

test('unsigned HTTP requests are forbidden before a provider can start', async (t) => {
  const app = await harness(t);
  for (const path of ['/voice', '/voice/owner', '/voice/public']) {
    const response = await app.post(path, { CallSid: callSid, From: ownerPhone }, false);
    assert.equal(response.status, 403);
    assert.doesNotMatch(response.text, /grantToken|<Gather/);
  }
  assert.equal(app.providers.length, 0);
});

test('compressed form requests are rejected before a provider can start', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: publicPhone }, true, {
    'content-encoding': 'gzip',
  });
  assert.equal(response.status, 415);
  assert.equal(app.providers.length, 0);
});

test('recognized callers get a personal greeting and the same tools without an extra step', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: ownerPhone });
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, /<Gather|<Say|<Redirect/);
  assert.match(response.text, /<\/Connect><Hangup\/>/);
  assert.equal(app.providers.length, 0);
  const sessionPromise = started(app.events);
  await app.startStream(grantFrom(response));
  const [{ session }] = await sessionPromise;
  assertSession(session, true);
});

test('the Live transport can open early but starts its session only after the signed call grant arrives', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: ownerPhone });
  const socket = app.websocket();
  await once(socket, 'open', { signal: AbortSignal.timeout(1000) });
  assert.equal(app.providers.length, 1);
  const provider = app.providers[0];
  if (provider.readyState !== WebSocket.OPEN) {
    await once(provider, 'open', { signal: AbortSignal.timeout(1000) });
  }
  assert.deepEqual(provider.commands, []);
  const sessionPromise = started(app.events);
  app.sendStart(socket, grantFrom(response));
  const [{ session }] = await sessionPromise;
  assertSession(session, true);
  assert.equal(provider.commands.filter((command) => command.type === 'session.start').length, 1);
});

test('pending signed transports are bounded and release capacity after claim, disconnect, or invalid grant', async (t) => {
  for (const outcome of ['valid grant', 'disconnect', 'invalid grant']) {
    await t.test(outcome, async (subtest) => {
      const app = await harness(subtest, {}, { maxPendingConnections: 1 });
      const response = await app.post('/voice', { CallSid: callSid, From: publicPhone });
      const first = app.websocket();
      await once(first, 'open', { signal: AbortSignal.timeout(1000) });
      assert.equal(app.providers.length, 1);
      assert.deepEqual(app.providers[0].commands, []);
      const denied = app.websocket();
      await assert.rejects(once(denied, 'open', { signal: AbortSignal.timeout(1000) }), /503/);
      assert.equal(app.providers.length, 1);

      if (outcome === 'valid grant') {
        const sessionPromise = started(app.events);
        app.sendStart(first, grantFrom(response));
        await sessionPromise;
      } else {
        const closed = once(first, 'close', { signal: AbortSignal.timeout(1000) });
        const providerClosed = once(app.providers[0], 'close', { signal: AbortSignal.timeout(1000) });
        if (outcome === 'disconnect') first.close();
        else app.sendStart(first, 'invalid-grant');
        await Promise.all([closed, providerClosed]);
      }

      const replacement = app.websocket();
      await once(replacement, 'open', { signal: AbortSignal.timeout(1000) });
      assert.equal(app.providers.length, 2);
      assert.deepEqual(app.providers[1].commands, []);
      assert.equal(app.providers.flatMap((provider) => provider.commands)
        .filter((command) => command.type === 'session.start').length, outcome === 'valid grant' ? 1 : 0);
    });
  }
});

test('an unclaimed signed transport times out and releases its pending slot without starting Live', async (t) => {
  const app = await harness(t, {}, { maxPendingConnections: 1, startTimeoutMs: 50 });
  const first = app.websocket();
  await once(first, 'open', { signal: AbortSignal.timeout(1000) });
  const providerClosed = once(app.providers[0], 'close', { signal: AbortSignal.timeout(1000) });
  await Promise.all([once(first, 'close', { signal: AbortSignal.timeout(1000) }), providerClosed]);
  assert.deepEqual(app.providers[0].commands, []);
  assert.equal(app.logs.find(([message]) => message === '[Live] call ended')[1].reason, 'startup_timeout');
  const replacement = app.websocket();
  await once(replacement, 'open', { signal: AbortSignal.timeout(1000) });
  assert.equal(app.providers.length, 2);
  assert.deepEqual(app.providers[1].commands, []);
});

test('all signed voice routes use actual caller identity and ignore legacy callback fields', async (t) => {
  for (const route of ['/voice', '/voice/public', '/voice/owner']) {
    for (const from of [publicPhone, ownerPhone]) {
      await t.test(`${route}: ${from === ownerPhone ? 'recognized caller' : 'other caller'}`, async (subtest) => {
        const app = await harness(subtest);
        const response = await app.post(route, { CallSid: callSid, From: from, Digits: '1234' });
        assert.doesNotMatch(response.text, /<Gather|<Say|<Redirect/);
        const sessionPromise = started(app.events);
        await app.startStream(grantFrom(response));
        const [{ session }] = await sessionPromise;
        assertSession(session, from === ownerPhone);
        assert.equal(app.logs.some(([message]) => /verification/i.test(message)), false);
      });
    }
  }
});

test('phone audio reaches Live unchanged for recognized and other callers', async (t) => {
  for (const from of [publicPhone, ownerPhone]) {
    await t.test(from === ownerPhone ? 'recognized caller' : 'other caller', async (subtest) => {
      const app = await harness(subtest);
      const response = await app.post('/voice', { CallSid: callSid, From: from });
      const sessionPromise = started(app.events);
      const client = await app.startStream(grantFrom(response));
      await sessionPromise;
      const provider = app.providers[0];
      const payload = Buffer.from(Array.from({ length: 160 }, (_, index) => index % 128)).toString('base64');
      const audioForwarded = once(provider, 'inputAudio', { signal: AbortSignal.timeout(1000) });
      client.socket.send(JSON.stringify({ event: 'media', streamSid, media: { track: 'inbound', payload } }));
      const [forwarded] = await audioForwarded;
      assert.equal(forwarded.audio, payload);
      assert.equal(provider.commands.some((command) => command.type === 'session.update'), false);
      assert.equal(provider.commands.some((command) => command.type === 'session.close'), false);
      assert.equal(provider.readyState, WebSocket.OPEN);
      assert.equal(client.socket.readyState, WebSocket.OPEN);
      assert.equal(app.providers.length, 1);
    });
  }
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
  assert.equal(app.providers.length, 1);
  assert.deepEqual(app.providers[0].commands, []);
});

test('a consumed stream grant cannot start a second provider session', async (t) => {
  const app = await harness(t);
  const response = await app.post('/voice', { CallSid: callSid, From: publicPhone });
  const token = grantFrom(response);
  const sessionPromise = started(app.events);
  await app.startStream(token);
  await sessionPromise;
  const replay = await app.startStream(token);
  await replay.closed;
  assert.equal(app.providers.length, 2);
  assert.equal(app.providers.flatMap((provider) => provider.commands)
    .filter((command) => command.type === 'session.start').length, 1);
  assert.deepEqual(app.providers[1].commands, []);
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
      const socket = app.websocket();
      await assert.rejects(once(socket, 'open', { signal: AbortSignal.timeout(1000) }), /503/);
      assert.equal(app.providers.length, 0);
    });
  }
});
