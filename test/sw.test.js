import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function worker(fetchImpl, cachedResponse = null, cacheWriteFails = false) {
  const listeners = new Map();
  const writes = [];
  const cache = {
    match: async () => cachedResponse,
    put: async (_request, response) => {
      if (cacheWriteFails) throw new Error('cache full');
      writes.push(await response.text());
    },
  };
  const self = {
    registration: { scope: 'https://example.test/app/' },
    location: { origin: 'https://example.test' },
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  runInNewContext(source, {
    self,
    caches: { open: async () => cache },
    fetch: fetchImpl,
    URL,
  });
  return { listeners, writes };
}

function dispatchFetch(workerState, url) {
  let response;
  workerState.listeners.get('fetch')({
    request: { method: 'GET', url },
    respondWith: (promise) => { response = promise; },
  });
  return response;
}

function basicResponse(body) {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

test('service worker leaves OAuth callbacks and Spotify API requests untouched', () => {
  const state = worker(async () => new Response('unexpected'));
  assert.equal(dispatchFetch(state, 'https://example.test/app/?code=secret&state=nonce'), undefined);
  assert.equal(dispatchFetch(state, 'https://api.spotify.com/v1/me'), undefined);
});

test('service worker fetches fresh app code before using the offline shell', async () => {
  const appUrl = 'https://example.test/app/js/app.js';
  const online = worker(async (_request, options) => {
    assert.equal(options.cache, 'no-store');
    return basicResponse('new');
  }, basicResponse('old'));
  assert.equal(await (await dispatchFetch(online, appUrl)).text(), 'new');
  assert.deepEqual(online.writes, ['new']);

  const offline = worker(async () => { throw new Error('offline'); }, basicResponse('old'));
  assert.equal(await (await dispatchFetch(offline, appUrl)).text(), 'old');

  const fullCache = worker(async () => basicResponse('new'), basicResponse('old'), true);
  assert.equal(await (await dispatchFetch(fullCache, appUrl)).text(), 'new');
});
