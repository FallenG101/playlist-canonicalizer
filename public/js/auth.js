const CLIENT_ID_KEY = 'canonicalizer.spotify.clientId';
const TOKEN_KEY = 'canonicalizer.spotify.tokens';
const VERIFIER_KEY = 'canonicalizer.spotify.verifier';
const STATE_KEY = 'canonicalizer.spotify.state';
let refreshPromise = null;
let authGeneration = 0;

export const READ_SCOPES = ['playlist-read-private', 'playlist-read-collaborative'];
export const WRITE_SCOPES = ['playlist-modify-private', 'playlist-modify-public'];
export const REQUESTED_SCOPES = [...READ_SCOPES, ...WRITE_SCOPES];

function randomString(length = 64) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(digest);
}

function readTokens() {
  try {
    return JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

function saveTokens(payload, fallbackRefreshToken, fallbackScope = '') {
  if (!payload?.access_token || !Number.isFinite(Number(payload.expires_in))) {
    throw new Error('Spotify returned an invalid token response. Please connect again.');
  }
  const tokens = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || fallbackRefreshToken || null,
    expiresAt: Date.now() + Math.max(0, payload.expires_in - 30) * 1000,
    scope: payload.scope || fallbackScope,
  };
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  return tokens;
}

async function tokenRequest(body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error_description || payload.error || 'Spotify authorization failed.');
      error.oauthCode = payload.error || null;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Spotify authorization timed out. Please connect again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function redirectUri() {
  const appPath = new URL('./', location.href).pathname;
  return `${location.origin}${appPath}`;
}

function appBasePath() {
  return new URL('./', location.href).pathname;
}

export function savedClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || '';
}

export function normalizeClientId(value = '') {
  return String(value)
    .trim()
    .replace(/^client\s*id\s*[:=]\s*/i, '')
    .trim();
}

export function isValidClientId(value) {
  const clientId = normalizeClientId(value);
  return clientId.length >= 8 && clientId.length <= 200 && !/\s/.test(clientId);
}

export async function beginAuthorization(clientId) {
  const cleanClientId = normalizeClientId(clientId);
  if (!isValidClientId(cleanClientId)) {
    throw new Error('Paste only the Spotify Client ID value, without spaces or the Client Secret.');
  }

  localStorage.setItem(CLIENT_ID_KEY, cleanClientId);
  sessionStorage.removeItem(TOKEN_KEY);
  authGeneration += 1;
  const verifier = randomString(96);
  const state = randomString(32);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({
    client_id: cleanClientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: REQUESTED_SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    state,
    show_dialog: 'true',
  });
  location.assign(url);
}

export async function finishAuthorization() {
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  const code = params.get('code');
  if (error) {
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    history.replaceState({}, '', appBasePath());
    throw new Error(error === 'access_denied' ? 'Spotify access was not granted.' : `Spotify authorization failed: ${error}`);
  }
  if (!code) return false;

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const actualState = params.get('state');
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const clientId = savedClientId();
  if (!expectedState || actualState !== expectedState || !verifier || !clientId) {
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    history.replaceState({}, '', appBasePath());
    throw new Error('The Spotify sign-in response could not be verified. Please connect again.');
  }

  history.replaceState({}, '', appBasePath());
  try {
    const payload = await tokenRequest({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    });
    saveTokens(payload, null, '');
    return true;
  } finally {
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
  }
}

export function hasSession() {
  return Boolean(readTokens()?.accessToken);
}

export function hasWriteAccess() {
  const granted = new Set((readTokens()?.scope || '').split(/\s+/).filter(Boolean));
  return WRITE_SCOPES.every((scope) => granted.has(scope));
}

export async function accessToken() {
  const tokens = readTokens();
  if (!tokens?.accessToken) throw new Error('Connect Spotify to continue.');
  if (Date.now() < tokens.expiresAt) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error('Your Spotify session expired. Please connect again.');
  if (!refreshPromise) {
    const generation = authGeneration;
    refreshPromise = (async () => {
      try {
        const payload = await tokenRequest({
          client_id: savedClientId(),
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
        });
        if (generation !== authGeneration) throw new Error('The Spotify session was disconnected.');
        return saveTokens(payload, tokens.refreshToken, tokens.scope).accessToken;
      } catch (error) {
        if (error.oauthCode === 'invalid_grant') disconnect();
        throw error;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

export function disconnect() {
  authGeneration += 1;
  refreshPromise = null;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
}
