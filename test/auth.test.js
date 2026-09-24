import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessToken,
  disconnect,
  hasSession,
  hasWriteAccess,
  isValidClientId,
  normalizeClientId,
  redirectUri,
} from '../public/js/auth.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('normalizes pasted Client ID labels without assuming an alphanumeric format', () => {
  assert.equal(normalizeClientId('  Client ID: spotify-client_123  '), 'spotify-client_123');
  assert.equal(isValidClientId('spotify-client_123'), true);
  assert.equal(isValidClientId('client id with spaces'), false);
  assert.equal(isValidClientId('short'), false);
});

test('uses the exact app base path for hosted PWA OAuth redirects', () => {
  const priorLocation = globalThis.location;
  try {
    globalThis.location = new URL('https://example.test/canonicalizer/index.html');
    assert.equal(redirectUri(), 'https://example.test/canonicalizer/');
    globalThis.location = new URL('http://127.0.0.1:4387/');
    assert.equal(redirectUri(), 'http://127.0.0.1:4387/');
  } finally {
    globalThis.location = priorLocation;
  }
});

test('refresh preserves the originally granted scopes when Spotify omits scope', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
  localStorage.setItem('canonicalizer.spotify.clientId', 'client1234567890abcdef');
  sessionStorage.setItem('canonicalizer.spotify.tokens', JSON.stringify({
    accessToken: 'expired',
    refreshToken: 'refresh',
    expiresAt: 0,
    scope: 'playlist-read-private playlist-read-collaborative',
  }));
  globalThis.fetch = async () => jsonResponse({ access_token: 'fresh', expires_in: 3600 });
  try {
    assert.equal(await accessToken(), 'fresh');
    assert.equal(hasWriteAccess(), false);
  } finally {
    disconnect();
    globalThis.fetch = originalFetch;
  }
});

test('expired or revoked refresh grants are discarded', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
  localStorage.setItem('canonicalizer.spotify.clientId', 'client1234567890abcdef');
  sessionStorage.setItem('canonicalizer.spotify.tokens', JSON.stringify({
    accessToken: 'expired',
    refreshToken: 'revoked',
    expiresAt: 0,
    scope: 'playlist-read-private',
  }));
  globalThis.fetch = async () => jsonResponse({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400);
  try {
    await assert.rejects(() => accessToken(), /revoked/);
    assert.equal(hasSession(), false);
  } finally {
    disconnect();
    globalThis.fetch = originalFetch;
  }
});

test('concurrent callers share one token refresh request', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
  localStorage.setItem('canonicalizer.spotify.clientId', 'client1234567890abcdef');
  sessionStorage.setItem('canonicalizer.spotify.tokens', JSON.stringify({
    accessToken: 'expired',
    refreshToken: 'refresh',
    expiresAt: 0,
    scope: 'playlist-read-private',
  }));
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ access_token: 'fresh', expires_in: 3600 });
  };
  try {
    const values = await Promise.all([accessToken(), accessToken(), accessToken()]);
    assert.deepEqual(values, ['fresh', 'fresh', 'fresh']);
    assert.equal(calls, 1);
  } finally {
    disconnect();
    globalThis.fetch = originalFetch;
  }
});

test('disconnecting during a refresh cannot recreate the session', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
  localStorage.setItem('canonicalizer.spotify.clientId', 'client1234567890abcdef');
  sessionStorage.setItem('canonicalizer.spotify.tokens', JSON.stringify({
    accessToken: 'expired',
    refreshToken: 'refresh',
    expiresAt: 0,
    scope: 'playlist-read-private',
  }));
  let releaseFetch;
  globalThis.fetch = () => new Promise((resolve) => { releaseFetch = resolve; });
  try {
    const pending = accessToken();
    disconnect();
    releaseFetch(jsonResponse({ access_token: 'fresh', expires_in: 3600 }));
    await assert.rejects(() => pending, /disconnected/);
    assert.equal(hasSession(), false);
  } finally {
    disconnect();
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
