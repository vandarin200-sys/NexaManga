'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOKEN_LIFETIME_SECONDS,
  createAdminToken,
  createOAuthState,
  createSessionToken,
  verifyAdminToken,
  verifyOAuthState,
  verifySessionToken
} = require('../lib/auth');

test('admin token is signed and expires after the configured lifetime', () => {
  process.env.TOKEN_SECRET = 'test-secret-with-more-than-32-characters';
  const token = createAdminToken(1000);
  assert.equal(verifyAdminToken(token, 1001), true);
  assert.equal(verifyAdminToken(token, 1000 + TOKEN_LIFETIME_SECONDS - 1), true);
  assert.equal(verifyAdminToken(token, 1000 + TOKEN_LIFETIME_SECONDS), false);
  assert.equal(verifyAdminToken(`${token}x`, 1001), false);
});

test('session tokens preserve member and admin roles', () => {
  process.env.TOKEN_SECRET = 'test-secret-with-more-than-32-characters';
  const memberToken = createSessionToken({ id: 'm1', role: 'member', name: 'Member', provider: 'google' }, 1000);
  assert.equal(verifySessionToken(memberToken, 1001).role, 'member');
  assert.equal(verifyAdminToken(memberToken, 1001), false);
  assert.throws(() => createSessionToken({ id: 'm2', role: 'owner', name: 'Invalid' }, 1000));
});

test('OAuth state is signed, provider-bound, and expires', () => {
  process.env.TOKEN_SECRET = 'test-secret-with-more-than-32-characters';
  const token = createOAuthState('google', 'https://nexa.example', 1000);
  assert.equal(verifyOAuthState(token, 1001).provider, 'google');
  assert.equal(verifyOAuthState(`${token}x`, 1001), null);
  assert.equal(verifyOAuthState(token, 1000 + 10 * 60), null);
});
