const API_ROOT = 'https://api.spotify.com/v1';

function spotifyApiUrl(pathOrUrl) {
  const url = /^https?:/i.test(pathOrUrl)
    ? new URL(pathOrUrl)
    : new URL(`${API_ROOT}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`);
  if (url.origin !== 'https://api.spotify.com' || !url.pathname.startsWith('/v1/')) {
    throw new Error('Spotify returned an unsafe API link; the request was blocked before credentials were sent.');
  }
  return url.href;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeRequestDiagnostic(url, method, status, reason) {
  let path = new URL(url).pathname.replace(/^\/v1/, '') || '/';
  path = path
    .replace(/^\/playlists\/[^/]+\/items$/, '/playlists/{playlist}/items')
    .replace(/^\/playlists\/[^/]+$/, '/playlists/{playlist}');
  return Object.freeze({
    request: `${String(method).toUpperCase()} ${path}`,
    status,
    reason,
    receivedAt: new Date().toISOString(),
  });
}

export class SpotifyClient {
  constructor(getAccessToken, { scanCache = null } = {}) {
    this.getAccessToken = getAccessToken;
    this.scanCache = scanCache;
  }

  async request(pathOrUrl, options = {}, retryCount = 0) {
    const url = spotifyApiUrl(pathOrUrl);
    const method = options.method || 'GET';
    const headers = { Authorization: `Bearer ${await this.getAccessToken()}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (cause) {
      const error = new Error(
        cause?.name === 'AbortError'
          ? `Spotify did not respond within ${Math.round((options.timeoutMs || 30_000) / 1000)} seconds.`
          : 'Spotify could not be reached. Check your connection and try again.',
      );
      error.code = cause?.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
      error.isAmbiguousWrite = method !== 'GET' && method !== 'HEAD';
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      const payload = await response.json().catch(() => ({}));
      const reason = payload?.error?.reason || payload?.reason || null;
      if (reason === 'QUOTA_EXCEEDED') {
        const error = new Error(
          'Spotify’s Development Mode API quota is exhausted. This is not the short rolling rate limit, and Spotify does not publish the reset time.',
        );
        error.status = 429;
        error.code = 'QUOTA_EXCEEDED';
        error.diagnostic = safeRequestDiagnostic(url, method, response.status, reason);
        throw error;
      }
      const parsed = Number(response.headers.get('Retry-After') || 1);
      const waitSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
      if (method === 'GET' && retryCount < 3 && waitSeconds <= 60) {
        const backoffSeconds = Math.max(waitSeconds, 2 ** retryCount);
        await sleep(backoffSeconds * 1000);
        return this.request(pathOrUrl, options, retryCount + 1);
      }
      const suggestedWait = method === 'GET' ? Math.max(waitSeconds, 30) : waitSeconds;
      const error = new Error(`Spotify rate-limited this request. Wait ${Math.ceil(suggestedWait)} seconds, then try again.`);
      error.status = 429;
      error.retryAfter = suggestedWait;
      error.diagnostic = safeRequestDiagnostic(url, method, response.status, reason || 'RATE_LIMITED');
      throw error;
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload?.error?.message || payload?.error_description ||
        (typeof payload?.error === 'string' ? payload.error : null) || `Spotify returned ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  async allPages(initialPath) {
    const items = [];
    const seen = new Set();
    let next = initialPath;
    while (next) {
      if (seen.has(next)) throw new Error('Spotify returned a repeated pagination link; loading stopped safely.');
      if (seen.size >= 10_000) throw new Error('Spotify returned too many pages; loading stopped safely.');
      seen.add(next);
      const page = await this.request(next);
      if (!page || !Array.isArray(page.items)) throw new Error('Spotify returned an invalid paginated response.');
      items.push(...page.items);
      next = typeof page.next === 'string' && page.next ? page.next : null;
    }
    return items;
  }

  profile() {
    return this.request('/me');
  }

  playlists() {
    return this.allPages('/me/playlists?limit=50');
  }

  playlistItems(playlistId) {
    return this.allPages(`/playlists/${encodeURIComponent(playlistId)}/items?limit=50&additional_types=track%2Cepisode`);
  }

  playlist(playlistId) {
    return this.request(`/playlists/${encodeURIComponent(playlistId)}`);
  }

  async replacePlaylistItems(playlistId, uris) {
    if (!/^[A-Za-z0-9]+$/.test(playlistId || '') ||
        !Array.isArray(uris) || uris.length === 0 || uris.length > 100 ||
        uris.some((uri) => !/^spotify:(track|episode):[A-Za-z0-9]+$/.test(uri))) {
      throw new Error('Unsafe playlist replacement request was blocked.');
    }
    return this.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
      method: 'PUT',
      body: { uris },
      timeoutMs: 30_000,
    });
  }

  async scanCandidates(onProgress = () => {}) {
    const profile = await this.profile();
    onProgress({ phase: 'playlists', detail: 'Finding playlists you own or collaborate on…', percent: 6 });
    const visiblePlaylists = await this.playlists();
    const playlists = visiblePlaylists.filter(
      (playlist) => playlist?.owner?.id === profile.id || playlist?.collaborative === true,
    );
    return { profile, playlists };
  }

  async inventoryOwnedPlaylists(onProgress = () => {}, source = null, selectedPlaylistIds = null) {
    const candidateSource = source || await this.scanCandidates(onProgress);
    const profile = candidateSource?.profile;
    const candidates = Array.isArray(candidateSource?.playlists) ? candidateSource.playlists : [];
    if (!profile?.id) throw new Error('Spotify returned an invalid account profile.');

    const candidateIds = new Set(candidates.map((playlist) => playlist?.id).filter(Boolean));
    const selectedIds = selectedPlaylistIds === null
      ? candidateIds
      : new Set(Array.isArray(selectedPlaylistIds) ? selectedPlaylistIds : []);
    if (!selectedIds.size) throw new Error('Select at least one playlist to scan.');
    if ([...selectedIds].some((playlistId) => !candidateIds.has(playlistId))) {
      throw new Error('The playlist selection changed or is invalid. Choose playlists again before scanning.');
    }
    const playlists = candidates.filter((playlist) => selectedIds.has(playlist.id));

    const placements = [];
    const failures = [];
    let resumedPlaylists = 0;
    for (let index = 0; index < playlists.length; index += 1) {
      const playlist = playlists[index];
      const playlistDescriptor = {
        id: playlist.id,
        name: playlist.name,
        snapshotId: playlist.snapshot_id,
        collaborative: Boolean(playlist.collaborative),
        ownerId: playlist.owner?.id || null,
        isPublic: playlist.public === true,
        externalUrl: playlist.external_urls?.spotify || null,
      };
      onProgress({
        phase: 'tracks',
        detail: `Reading “${playlist.name}” (${index + 1} of ${playlists.length})…`,
        percent: 10 + Math.round(((index + 1) / Math.max(playlists.length, 1)) * 84),
      });
      try {
        const cachedItems = await this.scanCache?.get(profile.id, playlist.id, playlist.snapshot_id).catch(() => null);
        if (cachedItems) {
          resumedPlaylists += 1;
          cachedItems.forEach((item) => placements.push({ ...item, playlist: playlistDescriptor }));
          onProgress({
            phase: 'tracks',
            detail: `Resumed “${playlist.name}” from saved progress (${index + 1} of ${playlists.length})…`,
            percent: 10 + Math.round(((index + 1) / Math.max(playlists.length, 1)) * 84),
          });
          continue;
        }
        const items = await this.playlistItems(playlist.id);
        const cacheItems = [];
        items.forEach((entry, position) => {
          // Spotify's current response uses `item`; `track` keeps compatibility with older responses.
          const track = entry.item || entry.track;
          if (!track || track.type !== 'track' || track.is_local || !track.album?.id) return;
          const cachedPlacement = {
            position,
            addedAt: entry.added_at || null,
            track,
          };
          cacheItems.push(cachedPlacement);
          placements.push({ ...cachedPlacement, playlist: playlistDescriptor });
        });
        await this.scanCache?.put(profile.id, playlist.id, playlist.snapshot_id, cacheItems).catch(() => {});
      } catch (error) {
        if (error.status === 401 || error.status === 429 || error.status >= 500 ||
            ['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(error.code)) {
          throw error;
        }
        failures.push({ playlistId: playlist.id, playlistName: playlist.name, message: error.message });
      }
    }

    onProgress({ phase: 'matching', detail: 'Comparing album IDs and edition signals…', percent: 98 });
    return { profile, playlists, placements, failures, resumedPlaylists };
  }
}
