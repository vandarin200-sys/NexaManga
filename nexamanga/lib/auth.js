'use strict';

const crypto = require('node:crypto');

const TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const SESSION_REFRESH_WINDOW_SECONDS = 24 * 60 * 60;
const OAUTH_STATE_LIFETIME_SECONDS = 10 * 60;
const OAUTH_PROVIDERS = Object.freeze(['discord', 'google']);
const TRACKER_PROVIDERS = Object.freeze(['anilist', 'mal']);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

function secret() {
  const value = requiredEnv('TOKEN_SECRET');
  if (value.length < 32) {
    throw new Error('TOKEN_SECRET must contain at least 32 characters.');
  }
  return value;
}

function sign(payload, signingKey = secret()) {
  return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
}

function createSignedToken(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifySignedToken(token, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  let expected;
  try {
    expected = Buffer.from(sign(parts[0]));
  } catch {
    return null;
  }
  const supplied = Buffer.from(parts[1]);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;

  try {
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!Number.isInteger(claims.exp) || claims.exp <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

function createSessionToken(user, now = Math.floor(Date.now() / 1000)) {
  if (!user || typeof user.id !== 'string' || !['admin', 'member'].includes(user.role)) {
    throw new Error('Data akun untuk membuat sesi tidak valid.');
  }
  return createSignedToken({
    sub: user.id,
    role: user.role,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      provider: user.provider
    },
    exp: now + TOKEN_LIFETIME_SECONDS
  });
}

function verifySessionToken(token, now = Math.floor(Date.now() / 1000)) {
  const claims = verifySignedToken(token, now);
  if (!claims || claims.type !== undefined || typeof claims.sub !== 'string' ||
      !['admin', 'member'].includes(claims.role) ||
      !claims.user || claims.user.id !== claims.sub) {
    return null;
  }
  return claims;
}

function createOAuthState(provider, returnOrigin, now = Math.floor(Date.now() / 1000)) {
  if (!OAUTH_PROVIDERS.includes(provider)) throw new Error('Penyedia OAuth tidak didukung.');
  return createSignedToken({
    type: 'oauth-state',
    provider,
    returnOrigin,
    nonce: crypto.randomBytes(32).toString('base64url'),
    exp: now + OAUTH_STATE_LIFETIME_SECONDS
  });
}

function verifyOAuthState(token, now = Math.floor(Date.now() / 1000)) {
  const claims = verifySignedToken(token, now);
  if (!claims || claims.type !== 'oauth-state' || !OAUTH_PROVIDERS.includes(claims.provider) ||
      typeof claims.returnOrigin !== 'string' || typeof claims.nonce !== 'string') {
    return null;
  }
  return claims;
}

function createOAuthLinkState(input, now = Math.floor(Date.now() / 1000)) {
  if (!input || typeof input.sub !== 'string' || !input.sub ||
      !TRACKER_PROVIDERS.includes(input.provider) ||
      typeof input.returnOrigin !== 'string' || !input.returnOrigin ||
      typeof input.nonce !== 'string' || !input.nonce ||
      typeof input.codeVerifier !== 'string' || !input.codeVerifier ||
      typeof input.codeChallenge !== 'string' || !input.codeChallenge) {
    throw new Error('Data koneksi OAuth tidak valid.');
  }
  return createSignedToken({
    type: 'oauth-link-state',
    sub: input.sub,
    provider: input.provider,
    returnOrigin: input.returnOrigin,
    nonce: input.nonce,
    codeVerifier: input.codeVerifier,
    codeChallenge: input.codeChallenge,
    exp: now + OAUTH_STATE_LIFETIME_SECONDS
  });
}

function verifyOAuthLinkState(token, now = Math.floor(Date.now() / 1000)) {
  const claims = verifySignedToken(token, now);
  if (!claims || claims.type !== 'oauth-link-state' ||
      typeof claims.sub !== 'string' || !claims.sub ||
      !TRACKER_PROVIDERS.includes(claims.provider) ||
      typeof claims.returnOrigin !== 'string' || !claims.returnOrigin ||
      typeof claims.nonce !== 'string' || !claims.nonce ||
      typeof claims.codeVerifier !== 'string' || !claims.codeVerifier ||
      typeof claims.codeChallenge !== 'string' || !claims.codeChallenge) {
    return null;
  }
  return claims;
}

function createAdminToken(now = Math.floor(Date.now() / 1000)) {
  return createSessionToken({
    id: 'legacy-test-admin',
    role: 'admin',
    name: 'Admin',
    email: null,
    provider: 'test'
  }, now);
}

function verifyAdminToken(token, now = Math.floor(Date.now() / 1000)) {
  const claims = verifySessionToken(token, now);
  return Boolean(claims && claims.role === 'admin');
}

module.exports = {
  OAUTH_PROVIDERS,
  OAUTH_STATE_LIFETIME_SECONDS,
  SESSION_REFRESH_WINDOW_SECONDS,
  TOKEN_LIFETIME_SECONDS,
  TRACKER_PROVIDERS,
  createAdminToken,
  createOAuthLinkState,
  createOAuthState,
  createSessionToken,
  verifyAdminToken,
  verifyOAuthLinkState,
  verifyOAuthState,
  verifySessionToken
};
