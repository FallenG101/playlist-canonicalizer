import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyClient } from '../public/js/spotify.js';

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('paginates 0, 1, and multiple pages without dropping items', async () => {
  const originalFetch = globalThis.fetch;
  const pages = [
    { items: [], next: 'https://api.spotify.com/v1/page-2' },
    { items: [{ id: 'one' }], next: 'https://api.spotify.com/v1/page-3' },
    { items: Array.from({ length: 50 }, (_, id) => ({ id })), next: null },
  ];
  let calls = 0;
  globalThis.fetch = async () => jsonResponse(pages[calls++]);
  try {
    const client = new SpotifyClient(async () => 'token');
    const items = await client.allPages('/page-1');
    assert.equal(items.length, 51);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stops safely on repeated pagination links', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ items: [], next: 'https://api.spotify.com/v1/loop' });
  try {
    const client = new SpotifyClient(async () => 'token');
    await assert.rejects(() => client.allPages('https://api.spotify.com/v1/loop'), /repeated pagination link/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('never sends a bearer token to a pagination URL outside the Spotify API', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({});
  };
  try {
    const client = new SpotifyClient(async () => 'sensitive-token');
    await assert.rejects(
      () => client.request('https://attacker.invalid/collect'),
      /unsafe API link/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries rate-limited reads but never automatically retries writes', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: { message: 'slow down' } }, 429, { 'Retry-After': '0' });
    return jsonResponse({ ok: true, method: options.method });
  };
  try {
    const client = new SpotifyClient(async () => 'token');
    assert.deepEqual(await client.request('/read'), { ok: true, method: 'GET' });
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse({ error: { message: 'slow down' } }, 429, { 'Retry-After': '5' });
    };
    await assert.rejects(
      () => client.request('/write', { method: 'PUT', body: { uris: [] } }),
      (error) => error.status === 429 && error.retryAfter === 5,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('persistent read rate limits recommend a cooldown longer than a repeated one-second header', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ error: { message: 'slow down' } }, 429, { 'Retry-After': '0' });
  };
  try {
    const client = new SpotifyClient(async () => 'token');
    await assert.rejects(
      () => client.request('/read'),
      (error) => error.status === 429 && error.retryAfter === 30,
    );
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('distinguishes development quota exhaustion from the rolling rate limit without retrying', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({
      error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' },
    }, 429, { 'Retry-After': '1' });
  };
  try {
    const client = new SpotifyClient(async () => 'token');
    await assert.rejects(
      () => client.request('/read'),
      (error) => error.status === 429 && error.code === 'QUOTA_EXCEEDED' && error.retryAfter === undefined,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('playlist replacement is one PUT and blocks over 100 items', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return jsonResponse({ snapshot_id: 'new-snapshot' });
  };
  try {
    const client = new SpotifyClient(async () => 'token');
    await client.replacePlaylistItems('playlistid', ['spotify:track:one']);
    assert.deepEqual(requests, [{
      url: 'https://api.spotify.com/v1/playlists/playlistid/items',
      method: 'PUT',
      body: { uris: ['spotify:track:one'] },
    }]);
    await client.replacePlaylistItems(
      'playlistid',
      Array.from({ length: 100 }, (_, index) => `spotify:track:track${index}`),
    );
    await assert.rejects(
      () => client.replacePlaylistItems('playlistid', Array.from({ length: 101 }, () => 'spotify:track:x')),
      /Unsafe playlist replacement request was blocked/,
    );
    await assert.rejects(
      () => client.replacePlaylistItems('playlistid', []),
      /Unsafe playlist replacement request was blocked/,
    );
    await assert.rejects(
      () => client.replacePlaylistItems('playlistid', ['spotify:album:not-a-track']),
      /Unsafe playlist replacement request was blocked/,
    );
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('marks a network failure during a mutation as ambiguous and does not retry', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError('network down');
  };
  try {
    const client = new SpotifyClient(async () => 'token');
    await assert.rejects(
      () => client.replacePlaylistItems('playlistid', ['spotify:track:one']),
      (error) => error.code === 'NETWORK_ERROR' && error.isAmbiguousWrite === true,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stops a playlist inventory immediately after a global rate limit', async () => {
  const client = new SpotifyClient(async () => 'token');
  client.profile = async () => ({ id: 'account' });
  client.playlists = async () => [
    { id: 'first', name: 'First', owner: { id: 'account' } },
    { id: 'second', name: 'Second', owner: { id: 'account' } },
  ];
  const calls = [];
  client.playlistItems = async (playlistId) => {
    calls.push(playlistId);
    const error = new Error('rate limited');
    error.status = 429;
    error.retryAfter = 30;
    throw error;
  };

  await assert.rejects(
    () => client.inventoryOwnedPlaylists(),
    (error) => error.status === 429 && error.retryAfter === 30,
  );
  assert.deepEqual(calls, ['first']);
});

test('resumes unchanged playlists from saved progress and refetches changed snapshots', async () => {
  const records = new Map();
  const scanCache = {
    async get(accountId, playlistId, snapshotId) {
      const record = records.get(`${accountId}:${playlistId}`);
      return record?.snapshotId === snapshotId ? record.items : null;
    },
    async put(accountId, playlistId, snapshotId, items) {
      records.set(`${accountId}:${playlistId}`, { snapshotId, items });
    },
  };
  const client = new SpotifyClient(async () => 'token', { scanCache });
  const playlist = {
    id: 'playlist',
    name: 'Playlist',
    snapshot_id: 'snapshot1',
    owner: { id: 'account' },
  };
  client.profile = async () => ({ id: 'account' });
  client.playlists = async () => [playlist];
  let itemReads = 0;
  client.playlistItems = async () => {
    itemReads += 1;
    return [{
      item: {
        id: 'track',
        uri: 'spotify:track:track',
        name: 'Track',
        type: 'track',
        artists: [{ id: 'artist', name: 'Artist' }],
        album: { id: 'album', name: 'Album', artists: [{ id: 'artist', name: 'Artist' }] },
      },
    }];
  };

  const first = await client.inventoryOwnedPlaylists();
  const resumed = await client.inventoryOwnedPlaylists();
  assert.equal(first.resumedPlaylists, 0);
  assert.equal(resumed.resumedPlaylists, 1);
  assert.equal(resumed.placements.length, 1);
  assert.equal(itemReads, 1);

  playlist.snapshot_id = 'snapshot2';
  const changed = await client.inventoryOwnedPlaylists();
  assert.equal(changed.resumedPlaylists, 0);
  assert.equal(itemReads, 2);
});
