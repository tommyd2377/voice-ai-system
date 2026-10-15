import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';

const GRANT_TTL_MS = 60_000;
const MAX_GRANTS = 1024;
const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/i;
const PIN_PATTERN = /^\d{4,12}$/;

function normalizePhone(value) {
  if (typeof value !== 'string' || !/^\+?[\d(). -]+$/.test(value)) return null;
  const compact = value.replace(/[(). -]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(compact)) return `+1${compact}`;
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(compact)) return `+${compact}`;
  return null;
}

// Use the configured public origin, never a caller-controlled Host header.
export function publicWebhookUrl(streamUrl, originalUrl) {
  if (typeof streamUrl !== 'string' || typeof originalUrl !== 'string') return null;
  if (!originalUrl.startsWith('/') || originalUrl.startsWith('//') || /[\\\r\n#]/.test(originalUrl)) {
    return null;
  }
  try {
    const base = new URL(streamUrl);
    if (base.username || base.password) return null;
    if (base.protocol === 'wss:') base.protocol = 'https:';
    else if (base.protocol === 'ws:') base.protocol = 'http:';
    else if (!['https:', 'http:'].includes(base.protocol)) return null;
    return `${base.origin}${originalUrl}`;
  } catch {
    return null;
  }
}

export function createCallSecurity({ authToken, ownerPhone, ownerPin, now = Date.now } = {}) {
  const configured = typeof authToken === 'string' && authToken.length > 0;
  const normalizedOwner = normalizePhone(ownerPhone);
  const ownerPinHash = typeof ownerPin === 'string' && PIN_PATTERN.test(ownerPin)
    ? createHash('sha256').update(ownerPin).digest()
    : null;
  const canVerifyOwner = Boolean(configured && normalizedOwner && ownerPinHash);
  const grants = new Map();

  function isOwnerPhone(callerPhone) {
    return Boolean(normalizedOwner && normalizePhone(callerPhone) === normalizedOwner);
  }

  function pruneGrants() {
    const currentTime = now();
    for (const [token, grant] of grants) {
      if (grant.expiresAt <= currentTime) grants.delete(token);
    }
  }

  function validateWebhook({ signature, url, params = {} } = {}) {
    if (!configured || typeof signature !== 'string' || !signature || typeof url !== 'string' || !url) {
      return false;
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
    if (!Object.values(params).every((value) => typeof value === 'string'
      || (Array.isArray(value) && value.every((item) => typeof item === 'string')))) return false;
    try {
      return twilio.validateRequest(authToken, signature, url, params);
    } catch {
      return false;
    }
  }

  // Call only after validating the Twilio webhook. The stream's custom caller
  // parameters are deliberately ignored when this grant is consumed.
  function issueGrant({ callSid, callerPhone, ownerVerified = false, requestOwnerVerification = false } = {}) {
    if (!configured || typeof callSid !== 'string' || !CALL_SID_PATTERN.test(callSid)) return null;
    pruneGrants();
    while (grants.size >= MAX_GRANTS) grants.delete(grants.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    const normalizedCaller = normalizePhone(callerPhone);
    const isOwnerCandidate = isOwnerPhone(callerPhone);
    const isOwner = ownerVerified === true && canVerifyOwner && isOwnerCandidate;
    grants.set(token, {
      callSid,
      callerPhone: normalizedCaller,
      isOwnerCandidate,
      isOwner,
      ownerVerificationPending: requestOwnerVerification === true && canVerifyOwner && isOwnerCandidate && !isOwner,
      expiresAt: now() + GRANT_TTL_MS,
    });
    return token;
  }

  function consumeGrant({ token, callSid } = {}) {
    pruneGrants();
    if (typeof token !== 'string' || typeof callSid !== 'string') return null;
    const grant = grants.get(token);
    if (!grant || grant.callSid !== callSid) return null;
    grants.delete(token);
    return {
      callerPhone: grant.callerPhone,
      isOwnerCandidate: grant.isOwnerCandidate,
      isOwner: grant.isOwner,
      ownerVerificationPending: grant.ownerVerificationPending,
    };
  }

  function verifyOwnerPin(pin) {
    if (!configured || !ownerPinHash || typeof pin !== 'string' || !PIN_PATTERN.test(pin)) return false;
    return timingSafeEqual(ownerPinHash, createHash('sha256').update(pin).digest());
  }

  return { validateWebhook, issueGrant, consumeGrant, isOwnerPhone, canVerifyOwner, verifyOwnerPin };
}
