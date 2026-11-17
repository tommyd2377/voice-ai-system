import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { buildLiveSession, executeCodeTool } from './assistantConfig.js';

const LIVE_ENDPOINT = 'wss://api.openai.com/v1/live/sessions';
const PROVIDER_ERROR_CODES = new Set([
  'unknown_parameter', 'missing_required_parameter', 'invalid_type', 'invalid_value',
  'invalid_request_error', 'immutable_field_update', 'responses_validation_failed',
  'rate_limit_exceeded', 'insufficient_quota', 'model_not_found', 'server_error',
]);
const PROVIDER_ERROR_PARAMS = new Set([
  'session', 'session.delegation', 'session.delegation.type', 'session.delegation.responses',
  ...['model', 'instructions', 'tools', 'tool_choice'].map((field) => `session.delegation.responses.${field}`),
]);
const DEFAULT_LIMITS = {
  startTimeoutMs: 15_000,
  closeTimeoutMs: 15_000,
  toolTimeoutMs: 10_000,
  backendTimeoutMs: 30_000,
  maxPendingConnections: 8,
  maxCallMs: 30 * 60_000,
  maxBackendResponses: 24,
  maxCustomCalls: 24,
  maxQueuedAudioMs: 2000,
};

export function connectToLive({ apiKey } = {}) {
  if (!apiKey) throw new Error('OpenAI access is not configured.');
  return new WebSocket(LIVE_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: DEFAULT_LIMITS.startTimeoutMs,
    maxPayload: 2 * 1024 * 1024,
  });
}

const parseMessage = (data) => JSON.parse(typeof data === 'string' ? data : data.toString());
const audioBytes = (payload) => {
  if (typeof payload !== 'string' || !payload.length || payload.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  return Buffer.from(payload, 'base64').length;
};

// Caller recognition comes from a single-use, verified call grant.
// Live owns turn taking: input and output remain independent continuous streams.
export function attachLiveCall(socket, {
  security,
  connectLive,
  executeTool = executeCodeTool,
  logger = console,
  limits: overrides = {},
  onFinish = () => {},
  onVerifiedStart = () => {},
  now = () => performance.now(),
} = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const connectedAt = now();
  const elapsed = () => Math.round(Math.max(0, now() - connectedAt));
  let live = null;
  let streamSid = null;
  let started = false;
  let startSent = false;
  let greetingInstruction = null;
  let closing = false;
  let finished = false;
  let isOwner = false;
  let closeTimer = null;
  let callTimer = null;
  let queuedAudioBytes = 0;
  let markSequence = 0;
  let toolQueue = Promise.resolve();
  let continuationPending = false;
  let continuationTimer = null;
  const marks = new Map();
  const responses = new Map();
  const delegationResponses = new Map();
  const seenCalls = new Set();
  const commands = new Map();
  const abortController = new AbortController();
  const summary = {
    sessionId: null,
    isOwner: false,
    reason: null,
    voiceSeconds: 0,
    usageFinalized: false,
    customCalls: 0,
    playedAudioBytes: 0,
    timings: {
      providerConnectMs: null,
      phoneStartMs: null,
      providerOpenMs: null,
      sessionStartSentMs: null,
      sessionReadyMs: null,
      firstInputAudioMs: null,
      firstOutputAudioMs: null,
      firstPlaybackAckMs: null,
    },
    backend: { responses: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  };

  const send = (target, event) => {
    if (!target || target.readyState !== WebSocket.OPEN) return false;
    try {
      if (target.bufferedAmount > 256 * 1024) return false;
      target.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  };
  const command = (event) => {
    const eventId = randomUUID();
    if (!send(live, { event_id: eventId, ...event })) return false;
    commands.set(eventId, event.type);
    if (commands.size > 128) commands.delete(commands.keys().next().value);
    return true;
  };
  const closeSocket = (target) => {
    if (!target || target.readyState === WebSocket.CLOSED) return;
    try { target.close(); } catch { target.terminate?.(); }
  };
  const clearPlayback = () => {
    if (streamSid) send(socket, { event: 'clear', streamSid });
    marks.clear();
    queuedAudioBytes = 0;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    closing = true;
    abortController.abort();
    clearTimeout(startTimer);
    clearTimeout(closeTimer);
    clearTimeout(callTimer);
    clearTimeout(continuationTimer);
    for (const batch of responses.values()) clearTimeout(batch.timer);
    responses.clear();
    delegationResponses.clear();
    seenCalls.clear();
    commands.clear();
    marks.clear();
    closeSocket(live);
    closeSocket(socket);
    logger.info('[Live] call ended', structuredClone(summary));
    onFinish();
  };
  const close = (reason = 'call_ended') => {
    if (closing || finished) return;
    closing = true;
    summary.reason = reason;
    abortController.abort();
    clearTimeout(startTimer);
    clearTimeout(callTimer);
    clearTimeout(continuationTimer);
    for (const batch of responses.values()) clearTimeout(batch.timer);
    clearPlayback();
    closeSocket(socket);
    closeTimer = setTimeout(() => {
      live?.terminate?.();
      finish();
    }, limits.closeTimeoutMs);
    closeTimer.unref?.();
    if (started && command({ type: 'session.close' })) return;
    // If startup is already in flight, receive session.started and then close it.
    if (startSent && live?.readyState === WebSocket.OPEN) return;
    live?.terminate?.();
    finish();
  };
  const startTimer = setTimeout(() => close('startup_timeout'), limits.startTimeoutMs);
  startTimer.unref?.();

  const maybeStartSession = () => {
    if (closing || startSent || !streamSid || live?.readyState !== WebSocket.OPEN) return;
    const session = buildLiveSession({ isOwner });
    greetingInstruction = session.input[0].content[0].text;
    summary.timings.sessionStartSentMs = elapsed();
    startSent = command({ type: 'session.start', session });
    if (!startSent) close('session_start_failed');
  };

  const updateVoiceUsage = (usage) => {
    if (Number.isFinite(usage?.seconds) && usage.seconds >= 0) summary.voiceSeconds = usage.seconds;
  };
  const addBackendUsage = (usage) => {
    summary.backend.inputTokens += usage?.input_tokens || 0;
    summary.backend.outputTokens += usage?.output_tokens || 0;
    summary.backend.cachedTokens += usage?.input_tokens_details?.cached_tokens || 0;
  };
  const processBatch = async (batch) => {
    if (closing) return;
    for (const item of batch.calls.values()) {
      if (closing) return;
      summary.customCalls += 1;
      if (summary.customCalls > limits.maxCustomCalls) return close('tool_budget_exceeded');
      let result;
      let args;
      try {
        if (typeof item.arguments !== 'string' || item.arguments.length > 8192) throw new Error();
        args = JSON.parse(item.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
      } catch {
        result = { ok: false, reason: 'invalid_arguments' };
      }
      if (!result) {
        const toolAbort = new AbortController();
        const signal = AbortSignal.any([abortController.signal, toolAbort.signal]);
        let timeout;
        const cancellation = new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }), { once: true });
        });
        try {
          result = await Promise.race([
            Promise.resolve().then(() => executeTool(item.name, args, { signal })),
            new Promise((resolve) => {
              timeout = setTimeout(() => {
                resolve({ ok: false, reason: 'tool_timeout' });
                toolAbort.abort();
              }, limits.toolTimeoutMs);
            }),
            cancellation,
          ]);
        } catch {
          result = { ok: false, reason: 'tool_failed' };
        } finally {
          clearTimeout(timeout);
          toolAbort.abort();
        }
      }
      if (closing) return;
      let output;
      try {
        output = JSON.stringify(result ?? { ok: false, reason: 'empty_result' });
        if (output.length > 32_000) {
          output = JSON.stringify({ ok: false, reason: 'result_too_large', message: 'Narrow the source search or requested line range.' });
        }
      } catch {
        output = JSON.stringify({ ok: false, reason: 'invalid_tool_result' });
      }
      if (!command({
        type: 'response.item.create',
        item: { type: 'function_call_output', call_id: item.call_id, output },
      })) return close('tool_result_delivery_failed');
    }
    batch.resultsSent = true;
  };
  const maybeContinue = () => {
    if (closing || continuationPending) return;
    const batches = [...responses.values()];
    // response.create is session-scoped. Results for all known pending calls
    // must be submitted before asking Live to resume its managed backend.
    if (batches.some((batch) => !batch.completed || (batch.calls.size && !batch.resultsSent))) return;
    const ready = batches.filter((batch) => batch.calls.size && batch.resultsSent && !batch.continued);
    if (!ready.length) return;
    for (const batch of ready) batch.continued = true;
    continuationPending = true;
    continuationTimer = setTimeout(() => close('backend_timeout'), limits.backendTimeoutMs);
    continuationTimer.unref?.();
    if (!command({ type: 'response.create' })) close('continuation_failed');
  };
  const handleBackend = (envelope) => {
    if (closing) return;
    const event = envelope.event;
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'response.created') {
      const id = event.response?.id;
      if (!id || responses.has(id)) return;
      continuationPending = false;
      clearTimeout(continuationTimer);
      summary.backend.responses += 1;
      if (summary.backend.responses > limits.maxBackendResponses) return close('backend_budget_exceeded');
      const batch = { id, calls: new Map(), completed: false, resultsSent: false, continued: false, timer: null };
      batch.timer = setTimeout(() => close('backend_timeout'), limits.backendTimeoutMs);
      batch.timer.unref?.();
      responses.set(id, batch);
      if (envelope.delegation_id) delegationResponses.set(envelope.delegation_id, id);
      return;
    }
    const id = event.response_id || event.response?.id || delegationResponses.get(envelope.delegation_id);
    const batch = responses.get(id);
    if (!batch) return;
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const item = event.item;
      if (batch.completed || !item.call_id || seenCalls.has(item.call_id)) return;
      if (seenCalls.size >= limits.maxCustomCalls) return close('tool_budget_exceeded');
      seenCalls.add(item.call_id);
      batch.calls.set(item.call_id, { call_id: item.call_id, name: item.name, arguments: item.arguments });
    } else if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) {
      if (batch.completed) return;
      batch.completed = true;
      clearTimeout(batch.timer);
      addBackendUsage(event.response?.usage);
      if (event.type !== 'response.completed') {
        batch.calls.clear();
        batch.resultsSent = true;
        batch.continued = true;
        logger.warn('[Live] delegated response did not complete');
        if (!command({ type: 'session.instructions.append', delegation_id: null,
          content: 'The backend request failed. Explain that briefly. Do not claim a successful lookup or retry automatically.' })) {
          return close('backend_failure_notice_delivery_failed');
        }
        maybeContinue();
        return;
      }
      toolQueue = toolQueue.then(async () => {
        await processBatch(batch);
        maybeContinue();
      }).catch(() => close('tool_processing_failed'));
    }
  };
  const handleLiveMessage = (data) => {
    try {
      const event = parseMessage(data);
      if (event.type === 'session.closed') {
        updateVoiceUsage(event.usage);
        summary.usageFinalized = true;
        summary.reason ||= event.reason || 'session_closed';
        return finish();
      }
      if (event.type === 'session.started') {
        if (started) return;
        if (!startSent) return close('unexpected_session_start');
        started = true;
        summary.sessionId = event.session?.id || null;
        if (closing) return command({ type: 'session.close' });
        summary.timings.sessionReadyMs = elapsed();
        clearTimeout(startTimer);
        callTimer = setTimeout(() => close('call_duration_limit'), limits.maxCallMs);
        callTimer.unref?.();
        logger.info('[Live] session ready', { sessionId: summary.sessionId, isOwner, timings: structuredClone(summary.timings) });
        // Reinforce the startup greeting once Live is ready, without waiting for speech.
        if (!command({ type: 'session.commentary.append', delegation_id: null, content: greetingInstruction })) {
          close('greeting_delivery_failed');
        }
      } else if (event.type === 'session.usage.updated') {
        updateVoiceUsage(event.usage);
      } else if (!closing && event.type === 'session.output_audio.delta') {
        const bytes = audioBytes(event.delta);
        if (!started || !streamSid || bytes == null) return close('invalid_output_audio');
        if (queuedAudioBytes + bytes > limits.maxQueuedAudioMs * 8) return close('playback_backlog');
        const name = `live-${++markSequence}`;
        if (!send(socket, { event: 'media', streamSid, media: { payload: event.delta } })) return close('output_delivery_failed');
        if (summary.timings.firstOutputAudioMs === null) {
          summary.timings.firstOutputAudioMs = elapsed();
          logger.info('[Live] first output audio', { sessionId: summary.sessionId, elapsedMs: summary.timings.firstOutputAudioMs });
        }
        marks.set(name, bytes);
        queuedAudioBytes += bytes;
        if (!send(socket, { event: 'mark', streamSid, mark: { name } })) close('playback_tracking_failed');
      } else if (!closing && event.type === 'response.event') {
        handleBackend(event);
      } else if (event.type === 'error') {
        // Log only known protocol identifiers. Messages and arbitrary strings
        // can echo caller instructions, credentials, or tool data.
        const clientEventId = event.error?.client_event_id ?? event.client_event_id;
        logger.warn('[Live] provider rejected a command', {
          code: PROVIDER_ERROR_CODES.has(event.error?.code) ? event.error.code : 'unknown',
          parameter: PROVIDER_ERROR_PARAMS.has(event.error?.param) ? event.error.param : 'unknown',
          command: commands.get(clientEventId) || 'unknown',
        });
        close('provider_error');
      }
    } catch {
      close('invalid_provider_event');
    }
  };
  const handleTwilioMessage = (data) => {
    if (closing) return;
    try {
      const event = parseMessage(data);
      if (event.event === 'start') {
        if (streamSid) return close('duplicate_stream_start');
        const format = event.start?.mediaFormat;
        if (format?.encoding !== 'audio/x-mulaw' || format.sampleRate !== 8000 || format.channels !== 1) {
          return close('unsupported_phone_audio');
        }
        const grant = security?.consumeGrant({
          token: event.start?.customParameters?.grantToken,
          callSid: event.start?.callSid,
        });
        if (!grant || !event.start.streamSid) return close('unauthorized_stream');
        streamSid = event.start.streamSid;
        summary.timings.phoneStartMs = elapsed();
        isOwner = grant.isOwner === true;
        summary.isOwner = isOwner;
        onVerifiedStart();
        // Caller-number and role custom parameters cannot alter the greeting.
        maybeStartSession();
      } else if (event.event === 'media') {
        if (!streamSid || !live || (event.streamSid && event.streamSid !== streamSid)) return close('invalid_stream_media');
        const payload = event.media?.payload;
        const bytes = audioBytes(payload);
        if (bytes == null || bytes > 8000) return close('invalid_input_audio');
        if (event.media.track && event.media.track !== 'inbound') return;
        // Listening begins when Live is ready. Never accumulate setup audio or
        // replay it in a burst: Live requires a continuous, realtime input pace.
        if (!started) return;
        if (!send(live, { type: 'session.input_audio.append', audio: payload })) return close('input_delivery_failed');
        summary.timings.firstInputAudioMs ??= elapsed();
      } else if (event.event === 'mark') {
        if (!marks.has(event.mark?.name)) return;
        for (const [name, bytes] of marks) {
          marks.delete(name);
          queuedAudioBytes -= bytes;
          summary.playedAudioBytes += bytes;
          if (name === event.mark.name) break;
        }
        if (summary.timings.firstPlaybackAckMs === null) {
          summary.timings.firstPlaybackAckMs = elapsed();
          logger.info('[Live] first playback acknowledged', { sessionId: summary.sessionId, elapsedMs: summary.timings.firstPlaybackAckMs });
        }
      } else if (event.event === 'stop') {
        close('caller_stopped');
      }
    } catch {
      close('invalid_call_event');
    }
  };

  socket.on('message', handleTwilioMessage);
  socket.on('close', () => close('caller_disconnected'));
  socket.on('error', () => close('call_connection_failed'));
  try {
    // attachLiveServer has already verified the Twilio upgrade. Overlap the
    // provider's transport handshake with receipt of the call's stream grant.
    // This does not start a Live session until maybeStartSession validates it.
    summary.timings.providerConnectMs = elapsed();
    live = connectLive({});
    live.on('message', handleLiveMessage);
    live.on('error', () => close('provider_connection_failed'));
    live.on('close', () => {
      if (!finished) {
        summary.reason ||= 'provider_connection_closed';
        clearPlayback();
        finish();
      }
    });
    const opened = () => {
      if (closing) return closeSocket(live);
      summary.timings.providerOpenMs ??= elapsed();
      maybeStartSession();
    };
    live.on('open', opened);
    if (live.readyState === WebSocket.OPEN) opened();
  } catch {
    close('provider_connection_failed');
  }
  return { close, getSummary: () => structuredClone(summary) };
}

export function attachLiveServer(server, { security, streamUrl, apiKey, connectLive, logger = console, limits } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const calls = new Set();
  const pendingLimit = limits?.maxPendingConnections ?? DEFAULT_LIMITS.maxPendingConnections;
  let pendingConnections = 0;
  const path = new URL(streamUrl).pathname;
  server.on('upgrade', (request, socket, head) => {
    // Twilio signs the wss:// URL from the TwiML, not its HTTPS equivalent.
    // Its documented handshake normalization can append a trailing slash.
    const validSignature = security.validateWebhook({
      signature: request.headers['x-twilio-signature'],
      url: streamUrl,
    }) || (!streamUrl.endsWith('/') && security.validateWebhook({
      signature: request.headers['x-twilio-signature'],
      url: `${streamUrl}/`,
    }));
    if (request.url !== path || !validSignature) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    if (pendingConnections >= pendingLimit) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    pendingConnections += 1;
    let pending = true;
    const releasePending = () => {
      if (!pending) return;
      pending = false;
      pendingConnections -= 1;
      socket.off('close', releasePending);
    };
    socket.once('close', releasePending);
    try {
      wss.handleUpgrade(request, socket, head, (connection) => {
        wss.emit('connection', connection, releasePending);
      });
    } catch {
      releasePending();
      socket.destroy();
    }
  });
  wss.on('connection', (socket, releasePending) => {
    let call = null;
    let finished = false;
    call = attachLiveCall(socket, {
      security,
      connectLive: connectLive || (() => connectToLive({ apiKey })),
      logger,
      limits,
      onVerifiedStart: releasePending,
      onFinish: () => {
        finished = true;
        releasePending();
        calls.delete(call);
      },
    });
    if (!finished) calls.add(call);
  });
  // Start draining before HTTP waits for upgraded connections to close.
  const closeHttpServer = server.close.bind(server);
  server.close = (...args) => {
    for (const call of calls) call.close('server_shutdown');
    return closeHttpServer(...args);
  };
  server.on('close', () => {
    wss.close();
  });
  return wss;
}
