import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { createVoiceServer } from '../src/server.js';

async function health(t, env) {
  const { server } = createVoiceServer({ env, logger: { info() {}, warn() {} } });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/health`, { agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

test('health identifies deployed models, revision and configuration without exposing values', async (t) => {
  const env = {
    OPENAI_API_KEY: 'fake-provider-credential',
    TWILIO_AUTH_TOKEN: 'fake-twilio-credential',
    TWILIO_STREAM_URL: 'wss://voice.example.test/realtime',
    TWILIO_OWNER_PHONE: '+12025550123',
    RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
  };
  const result = await health(t, env);
  assert.equal(result.status, 200);
  assert.equal(result.body.voiceModel, 'gpt-live-1');
  assert.equal(result.body.backendModel, 'gpt-6-luna');
  assert.equal(result.body.revision, env.RAILWAY_GIT_COMMIT_SHA);
  assert.equal(result.body.configurationReady, true);
  assert.equal(result.body.toolsAvailable, true);
  assert.equal(result.body.ownerRecognitionConfigured, true);
  assert.deepEqual(result.body.missingConfiguration, []);
  const output = JSON.stringify(result.body);
  for (const name of ['OPENAI_API_KEY', 'TWILIO_AUTH_TOKEN', 'TWILIO_OWNER_PHONE', 'TWILIO_STREAM_URL']) {
    assert.equal(output.includes(env[name]), false);
  }
});

test('health reports exact missing variable names without starting a voice session', async (t) => {
  const result = await health(t, {});
  assert.equal(result.body.configurationReady, false);
  assert.deepEqual(result.body.missingConfiguration, ['TWILIO_STREAM_URL', 'TWILIO_AUTH_TOKEN', 'OPENAI_API_KEY']);
  assert.equal(result.body.ownerRecognitionConfigured, false);
  assert.equal(result.body.toolsAvailable, true);
  assert.equal(result.body.revision, null);
});
