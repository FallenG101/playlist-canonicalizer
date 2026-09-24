export class ApplyPlanError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ApplyPlanError';
    this.code = code;
  }
}

function playlistItem(entry) {
  return entry?.item || entry?.track || null;
}

function validPlaylistUri(uri) {
  return /^spotify:(track|episode):[A-Za-z0-9]+$/.test(uri || '');
}

export function extractPlaylistUris(entries) {
  if (!Array.isArray(entries)) {
    throw new ApplyPlanError('Spotify returned an invalid playlist response. Apply was stopped.', 'INVALID_ITEMS');
  }
  const items = entries.map(playlistItem);
  const unsupported = items.find((item) =>
    !item?.id || !['track', 'episode'].includes(item.type) || item.is_local ||
    item.is_playable === false || item.restrictions?.reason ||
    !validPlaylistUri(item.uri) || item.uri !== `spotify:${item.type}:${item.id}`,
  );
  if (unsupported !== undefined) {
    throw new ApplyPlanError(
      'This playlist contains a local, unavailable, or unsupported item that Spotify cannot safely reconstruct. Apply is disabled for this playlist.',
      'UNSUPPORTED_ITEM',
    );
  }
  return items.map((item) => item.uri);
}

export function classifyPlaylistState(entries, plan) {
  let uris;
  try {
    uris = extractPlaylistUris(entries);
  } catch {
    return 'other';
  }
  if (arraysEqual(uris, plan.targetUris)) return 'target';
  if (arraysEqual(uris, plan.originalUris)) return 'original';
  return 'other';
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function buildPlaylistApplyPlan({ playlist, entries, approvedItems }) {
  if (!Array.isArray(approvedItems) || !approvedItems.length) {
    throw new ApplyPlanError('Approve at least one replacement first.', 'NO_APPROVALS');
  }
  if (!/^[A-Za-z0-9]+$/.test(playlist?.id || '') || !playlist?.snapshotId) {
    throw new ApplyPlanError('The playlist identity or snapshot is missing. Scan again before applying.', 'INVALID_PLAYLIST');
  }
  if (!Array.isArray(entries)) {
    throw new ApplyPlanError('Spotify returned an invalid playlist response. Apply was stopped.', 'INVALID_ITEMS');
  }
  if (entries.length > 100) {
    throw new ApplyPlanError(
      'Apply is limited to playlists with 100 items or fewer. Larger playlists require a multi-request rewrite that is not safe enough for regular use.',
      'PLAYLIST_TOO_LARGE',
    );
  }

  const currentItems = entries.map(playlistItem);
  const originalUris = extractPlaylistUris(entries);
  const targetUris = [...originalUris];
  const changes = [];
  const changedPositions = new Set();

  for (const approved of approvedItems) {
    if (!approved || typeof approved !== 'object') {
      throw new ApplyPlanError('An approved change is invalid. Apply was stopped.', 'INVALID_APPROVAL');
    }
    if (approved.requiresCandidateChoice === true && approved.candidateChosen !== true) {
      throw new ApplyPlanError('Choose a remaster for every ambiguous recommendation before applying.', 'CANDIDATE_NOT_CHOSEN');
    }
    if (approved.playlist?.id !== playlist.id) {
      throw new ApplyPlanError('An approved change belongs to a different playlist. Apply was stopped.', 'MIXED_PLAYLIST');
    }
    if (approved.playlist.snapshotId !== playlist.snapshotId) {
      throw new ApplyPlanError('An approved change belongs to an older playlist snapshot. Scan again.', 'MIXED_SNAPSHOT');
    }
    if (!Number.isSafeInteger(approved.position) || approved.position < 0 || changedPositions.has(approved.position)) {
      throw new ApplyPlanError('The approved changes contain an invalid or duplicate playlist position.', 'INVALID_POSITION');
    }
    const current = currentItems[approved.position];
    if (!current || current.type !== 'track' || current.id !== approved.sourceTrack?.id ||
        current.uri !== approved.sourceTrack?.uri) {
      throw new ApplyPlanError(
        `Track ${approved.position + 1} no longer matches the scan. Scan the playlist again before applying.`,
        'POSITION_CHANGED',
      );
    }
    const expectedReplacementUri = approved.replacementTrack?.id
      ? `spotify:track:${approved.replacementTrack.id}`
      : '';
    if (!approved.replacementTrack?.id || approved.replacementTrack.uri !== expectedReplacementUri) {
      throw new ApplyPlanError(`“${approved.replacementTrack.name}” has no writable Spotify URI.`, 'MISSING_URI');
    }
    if (approved.replacementTrack.uri === current.uri) {
      throw new ApplyPlanError('An approved replacement is identical to the current track. Apply was stopped.', 'NOOP_REPLACEMENT');
    }
    changedPositions.add(approved.position);
    targetUris[approved.position] = approved.replacementTrack.uri;
    changes.push({
      position: approved.position,
      source: { id: current.id, uri: current.uri, name: current.name },
      replacement: {
        id: approved.replacementTrack.id,
        uri: approved.replacementTrack.uri,
        name: approved.replacementTrack.name,
      },
    });
  }

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    playlist: {
      id: playlist.id,
      name: playlist.name,
      snapshotId: playlist.snapshotId,
      ownerId: playlist.ownerId || null,
      collaborative: Boolean(playlist.collaborative),
    },
    originalUris,
    targetUris,
    changes,
  };
}
