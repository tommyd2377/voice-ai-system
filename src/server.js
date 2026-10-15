import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import twilio from 'twilio';
import { attachLiveServer } from './realtimeHandler.js';
import { createCallSecurity, publicWebhookUrl } from './callSecurity.js';
import { buildLiveSession } from './assistantConfig.js';

const normalizeStreamUrl = (value) => {
  try {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return null;
    const url = new URL(text.includes('://') ? text : `wss://${text}`);
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
};

export function createVoiceServer({ env = process.env, logger = console, connectLive, limits } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  const streamUrl = normalizeStreamUrl(env.TWILIO_STREAM_URL);
  const security = createCallSecurity({
    authToken: env.TWILIO_AUTH_TOKEN,
    ownerPhone: env.TWILIO_OWNER_PHONE,
    ownerPin: env.TWILIO_OWNER_PIN,
  });
  const missingConfiguration = [
    ...(!streamUrl ? ['TWILIO_STREAM_URL'] : []),
    ...(!env.TWILIO_AUTH_TOKEN ? ['TWILIO_AUTH_TOKEN'] : []),
    ...(!env.OPENAI_API_KEY ? ['OPENAI_API_KEY'] : []),
  ];
  const missingOwnerConfiguration = [
    ...(!security.isOwnerPhone(env.TWILIO_OWNER_PHONE) ? ['TWILIO_OWNER_PHONE'] : []),
    ...(!/^\d{4,12}$/.test(env.TWILIO_OWNER_PIN || '') ? ['TWILIO_OWNER_PIN'] : []),
  ];
  const reply = (res, voice) => res.type('text/xml').send(voice.toString());
  const unavailable = (res) => {
    const voice = new twilio.twiml.VoiceResponse();
    voice.say('Sorry, we cannot connect your call right now.');
    voice.hangup();
    return reply(res, voice);
  };
  const signedWebhook = (req, res, next) => {
    if (missingConfiguration.length) return res.sendStatus(503);
    if (!req.is('application/x-www-form-urlencoded') || !security.validateWebhook({
      signature: req.get('x-twilio-signature'),
      url: publicWebhookUrl(streamUrl, req.originalUrl),
      params: req.body,
    })) return res.sendStatus(403);
    next();
  };
  const streamCall = (req, res, ownerVerified = false) => {
    const grantToken = security.issueGrant({
      callSid: req.body?.CallSid,
      callerPhone: req.body?.From,
      ownerVerified,
    });
    if (!grantToken) return unavailable(res);
    const voice = new twilio.twiml.VoiceResponse();
    const stream = voice.connect().stream({ url: streamUrl });
    stream.parameter({ name: 'grantToken', value: grantToken });
    // Returning from the stream (including a provider failure) ends the call.
    voice.say('The voice session has ended. Goodbye.');
    voice.hangup();
    return reply(res, voice);
  };

  app.get('/health', (_req, res) => {
    const session = buildLiveSession();
    res.json({
      status: 'ok',
      voiceModel: session.model,
      backendModel: session.delegation.responses.model,
      revision: /^[a-f0-9]{40}$/i.test(env.RAILWAY_GIT_COMMIT_SHA || '') ? env.RAILWAY_GIT_COMMIT_SHA : null,
      configurationReady: missingConfiguration.length === 0,
      ownerToolsConfigured: security.canVerifyOwner,
      missingConfiguration,
      missingOwnerConfiguration,
    });
  });
  app.post('/voice', signedWebhook, (req, res) => {
    if (!security.isOwnerPhone(req.body?.From) || !security.canVerifyOwner) return streamCall(req, res);
    const voice = new twilio.twiml.VoiceResponse();
    voice.gather({ input: 'dtmf', finishOnKey: '#', timeout: 8, action: '/voice/owner', method: 'POST' })
      .say('For private tools, enter your owner PIN followed by the pound key. Or wait to continue without private tools.');
    voice.redirect({ method: 'POST' }, '/voice/public');
    reply(res, voice);
  });
  app.post('/voice/owner', signedWebhook, (req, res) => {
    const verified = security.isOwnerPhone(req.body?.From) && security.verifyOwnerPin(req.body?.Digits);
    if (!verified) logger.warn('[Voice] owner verification failed; continuing without private tools');
    streamCall(req, res, verified);
  });
  app.post('/voice/public', signedWebhook, (req, res) => streamCall(req, res));
  app.use((error, _req, res, _next) => {
    logger.warn('[Voice] rejected malformed request');
    res.sendStatus(error.status === 413 ? 413 : 400);
  });

  const server = http.createServer(app);
  const wss = streamUrl ? attachLiveServer(server, {
    security, streamUrl, apiKey: env.OPENAI_API_KEY, connectLive, logger, limits,
  }) : null;
  return { app, server, wss };
}

// Loading local runtime configuration belongs to the executable entry point,
// not imports used by offline tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  const { server } = createVoiceServer();
  const shutdown = () => server.close();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(process.env.PORT || 8080, () => {
    console.log('Victoria voice server listening');
  });
}
