import assert from 'node:assert/strict';
import test from 'node:test';
import twilio from 'twilio';
import { createCallSecurity, publicWebhookUrl } from '../src/callSecurity.js';

const authToken = 'fake-twilio-test-token';
const callSid = `CA${'1'.repeat(32)}`;
const otherCallSid = `CA${'2'.repeat(32)}`;
const ownerPhone = '+12025550123';

test('validates Twilio signatures against the full public URL and posted fields', () => {
  const security = createCallSecurity({ authToken });
  const url = 'https://voice.example.test/voice?source=test';
  const params = { CallSid: callSid, From: ownerPhone, To: '+12025550124' };
  const signature = twilio.getExpectedTwilioSignature(authToken, url, params);

  assert.equal(security.validateWebhook({ signature, url, params }), true);
  assert.equal(security.validateWebhook({ signature, url: `${url}&extra=1`, params }), false);
  assert.equal(security.validateWebhook({ signature, url, params: { ...params, From: '+12025550125' } }), false);
  assert.equal(security.validateWebhook({ signature: 'invalid', url, params }), false);
  assert.equal(security.validateWebhook({ url, params }), false);
  assert.equal(security.validateWebhook({ signature, url, params: null }), false);
  assert.equal(security.validateWebhook({ signature, url, params: { CallSid: {} } }), false);
});

test('validates an empty-body WebSocket handshake and fails closed without authentication configuration', () => {
  const url = 'wss://voice.example.test/stream';
  const signature = twilio.getExpectedTwilioSignature(authToken, url, {});
  assert.equal(createCallSecurity({ authToken }).validateWebhook({ signature, url }), true);
  const unconfigured = createCallSecurity();
  assert.equal(unconfigured.validateWebhook({ signature, url }), false);
  assert.equal(unconfigured.issueGrant({ callSid, callerPhone: ownerPhone }), null);
});

test('public webhook URL uses the configured origin and preserves the request path and query', () => {
  assert.equal(publicWebhookUrl('wss://voice.example.test/stream', '/voice?source=a%2Fb'),
    'https://voice.example.test/voice?source=a%2Fb');
  assert.equal(publicWebhookUrl('ws://localhost:8080/stream', '/stream'), 'http://localhost:8080/stream');
  for (const path of ['//other.example/voice', 'https://other.example/voice', '/\\other.example', '/voice\n', '/voice#fragment']) {
    assert.equal(publicWebhookUrl('wss://voice.example.test/stream', path), null);
  }
  assert.equal(publicWebhookUrl('wss://user:pass@voice.example.test/stream', '/voice'), null);
  assert.equal(publicWebhookUrl('not a URL', '/voice'), null);
});

test('stream grants preserve verified caller identity, bind CallSid, and cannot be replayed', () => {
  const security = createCallSecurity({ authToken, ownerPhone });
  const token = security.issueGrant({ callSid, callerPhone: '(202) 555-0123' });
  assert.match(token, /^[\w-]{43}$/);
  assert.equal(security.consumeGrant({ token, callSid: otherCallSid }), null);
  assert.deepEqual(security.consumeGrant({ token, callSid, callerPhone: '+12025550125' }), {
    callerPhone: ownerPhone,
    isOwnerCandidate: true,
    isOwner: false,
    ownerVerificationPending: false,
  });
  assert.equal(security.consumeGrant({ token, callSid }), null);
  assert.equal(security.consumeGrant({ token: 'forged', callSid }), null);
  assert.equal(security.issueGrant({ callSid: 'invalid', callerPhone: ownerPhone }), null);
});

test('stream grants expire after 60 seconds and unused grants have bounded storage', () => {
  let clock = 1_000;
  const security = createCallSecurity({ authToken, now: () => clock });
  const token = security.issueGrant({ callSid });
  clock += 60_000;
  assert.equal(security.consumeGrant({ token, callSid }), null);

  const oldest = security.issueGrant({ callSid });
  let newest;
  for (let index = 0; index < 1024; index += 1) newest = security.issueGrant({ callSid });
  assert.equal(security.consumeGrant({ token: oldest, callSid }), null);
  assert.deepEqual(security.consumeGrant({ token: newest, callSid }), {
    callerPhone: null,
    isOwnerCandidate: false,
    isOwner: false,
    ownerVerificationPending: false,
  });
});

test('owner matching normalizes US phones without matching an unrelated country by suffix', () => {
  const security = createCallSecurity({ authToken, ownerPhone: '1 (202) 555-0123' });
  for (const phone of [ownerPhone, '2025550123', '1-202-555-0123']) {
    const token = security.issueGrant({ callSid, callerPhone: phone });
    assert.equal(security.consumeGrant({ token, callSid }).isOwnerCandidate, true);
  }
  for (const phone of ['+442025550123', '+992025550123', 'anonymous', '2025550123 ext 1']) {
    const token = security.issueGrant({ callSid, callerPhone: phone });
    assert.equal(security.consumeGrant({ token, callSid }).isOwnerCandidate, false);
  }
  const international = createCallSecurity({ authToken, ownerPhone: '+44 20 7946 0123' });
  const token = international.issueGrant({ callSid, callerPhone: '+442079460123' });
  assert.equal(international.consumeGrant({ token, callSid }).isOwnerCandidate, true);
});

test('owner PIN requires configured 4–12 digits and rejects missing, malformed, and wrong inputs', () => {
  const security = createCallSecurity({ authToken, ownerPin: '04231' });
  assert.equal(security.verifyOwnerPin('04231'), true);
  for (const pin of ['04232', '0423', ' 04231', 4231, undefined, '04231#', '1'.repeat(13)]) {
    assert.equal(security.verifyOwnerPin(pin), false);
  }
  for (const ownerPin of [undefined, '', '123', '1'.repeat(13), '123a', 1234]) {
    assert.equal(createCallSecurity({ authToken, ownerPin }).verifyOwnerPin('1234'), false);
  }
});

test('owner access requires both the matching signed caller and server-verified PIN state', () => {
  const security = createCallSecurity({ authToken, ownerPhone, ownerPin: '04231' });
  assert.equal(security.canVerifyOwner, true);
  assert.equal(security.isOwnerPhone('2025550123'), true);
  assert.equal(security.isOwnerPhone('+442025550123'), false);
  const ownerToken = security.issueGrant({ callSid, callerPhone: ownerPhone, ownerVerified: true });
  assert.equal(security.consumeGrant({ token: ownerToken, callSid }).isOwner, true);
  const publicToken = security.issueGrant({ callSid, callerPhone: '+12025550125', ownerVerified: true });
  assert.equal(security.consumeGrant({ token: publicToken, callSid }).isOwner, false);
  const unverifiedToken = security.issueGrant({ callSid, callerPhone: ownerPhone });
  assert.equal(security.consumeGrant({ token: unverifiedToken, callSid }).isOwner, false);
  for (const configuration of [{ authToken, ownerPhone }, { authToken, ownerPin: '04231' }, {}]) {
    const disabled = createCallSecurity(configuration);
    assert.equal(disabled.canVerifyOwner, false);
    if (configuration.authToken) {
      const token = disabled.issueGrant({ callSid, callerPhone: ownerPhone, ownerVerified: true });
      assert.equal(disabled.consumeGrant({ token, callSid }).isOwner, false);
    }
  }
});

test('owner verification is pending only for an explicitly requested eligible unverified caller', () => {
  const security = createCallSecurity({ authToken, ownerPhone, ownerPin: '04231' });
  for (const [options, expectedPending, expectedOwner] of [
    [{ callerPhone: ownerPhone }, false, false],
    [{ callerPhone: ownerPhone, requestOwnerVerification: true }, true, false],
    [{ callerPhone: ownerPhone, requestOwnerVerification: 'true' }, false, false],
    [{ callerPhone: '+12025550125', requestOwnerVerification: true }, false, false],
    [{ callerPhone: ownerPhone, requestOwnerVerification: true, ownerVerified: true }, false, true],
  ]) {
    const token = security.issueGrant({ callSid, ...options });
    const grant = security.consumeGrant({ token, callSid });
    assert.equal(grant.ownerVerificationPending, expectedPending);
    assert.equal(grant.isOwner, expectedOwner);
  }
  const unconfigured = createCallSecurity({ authToken, ownerPhone });
  const token = unconfigured.issueGrant({ callSid, callerPhone: ownerPhone, requestOwnerVerification: true });
  assert.equal(unconfigured.consumeGrant({ token, callSid }).ownerVerificationPending, false);
});
