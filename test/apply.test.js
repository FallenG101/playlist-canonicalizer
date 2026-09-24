import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApplyPlanError,
  buildPlaylistApplyPlan,
  classifyPlaylistState,
} from '../public/js/apply.js';

const playlist = { id: 'playlist', name: 'Test Playlist', snapshotId: 'snapshot-a' };

function entry(id, uri = `spotify:track:${id}`) {
  return { item: { id, uri, name: `Track ${id}`, type: 'track', is_local: false } };
}

function approval(position, sourceId, replacementId) {
  return {
    position,
    playlist: { id: playlist.id, snapshotId: playlist.snapshotId },
    sourceTrack: { id: sourceId, uri: `spotify:track:${sourceId}`, name: `Track ${sourceId}` },
    replacementTrack: {
      id: replacementId,
      uri: `spotify:track:${replacementId}`,
      name: `Track ${replacementId}`,
    },
  };
}

test('builds an order-preserving playlist replacement plan', () => {
  const plan = buildPlaylistApplyPlan({
    playlist,
    entries: [entry('one'), entry('two'), entry('three')],
    approvedItems: [approval(1, 'two', 'twodeluxe')],
  });
  assert.deepEqual(plan.originalUris, ['spotify:track:one', 'spotify:track:two', 'spotify:track:three']);
  assert.deepEqual(plan.targetUris, ['spotify:track:one', 'spotify:track:twodeluxe', 'spotify:track:three']);
  assert.equal(plan.changes.length, 1);
});

test('blocks stale positions before any write', () => {
  assert.throws(
    () => buildPlaylistApplyPlan({
      playlist,
      entries: [entry('different')],
      approvedItems: [approval(0, 'expected', 'replacement')],
    }),
    (error) => error instanceof ApplyPlanError && error.code === 'POSITION_CHANGED',
  );
});

test('blocks approvals belonging to a different playlist', () => {
  const mixed = approval(0, 'one', 'replacement');
  mixed.playlist = { id: 'anotherplaylist', snapshotId: playlist.snapshotId };
  assert.throws(
    () => buildPlaylistApplyPlan({ playlist, entries: [entry('one')], approvedItems: [mixed] }),
    (error) => error instanceof ApplyPlanError && error.code === 'MIXED_PLAYLIST',
  );
});

test('blocks an ambiguous remaster before a candidate is manually chosen', () => {
  const ambiguous = { ...approval(0, 'one', 'replacement'), requiresCandidateChoice: true, candidateChosen: false };
  assert.throws(
    () => buildPlaylistApplyPlan({ playlist, entries: [entry('one')], approvedItems: [ambiguous] }),
    (error) => error instanceof ApplyPlanError && error.code === 'CANDIDATE_NOT_CHOSEN',
  );
  assert.equal(buildPlaylistApplyPlan({
    playlist, entries: [entry('one')], approvedItems: [{ ...ambiguous, candidateChosen: true }],
  }).changes.length, 1);
});

test('blocks an approval without its playlist and exact source URI', () => {
  const missingPlaylist = approval(0, 'one', 'replacement');
  delete missingPlaylist.playlist;
  assert.throws(
    () => buildPlaylistApplyPlan({ playlist, entries: [entry('one')], approvedItems: [missingPlaylist] }),
    (error) => error instanceof ApplyPlanError && error.code === 'MIXED_PLAYLIST',
  );

  const mismatchedSource = approval(0, 'one', 'replacement');
  mismatchedSource.sourceTrack.uri = 'spotify:track:another';
  assert.throws(
    () => buildPlaylistApplyPlan({ playlist, entries: [entry('one')], approvedItems: [mismatchedSource] }),
    (error) => error instanceof ApplyPlanError && error.code === 'POSITION_CHANGED',
  );
});

test('blocks playlist entries whose type, ID, and URI disagree', () => {
  const malformed = entry('one', 'spotify:episode:one');
  assert.throws(
    () => buildPlaylistApplyPlan({ playlist, entries: [malformed], approvedItems: [approval(0, 'one', 'replacement')] }),
    (error) => error instanceof ApplyPlanError && error.code === 'UNSUPPORTED_ITEM',
  );
});

test('blocks replacement IDs that do not match their URI', () => {
  const mismatched = approval(0, 'one', 'replacement');
  mismatched.replacementTrack.uri = 'spotify:track:different';
  assert.throws(
    () => buildPlaylistApplyPlan({ playlist, entries: [entry('one')], approvedItems: [mismatched] }),
    (error) => error instanceof ApplyPlanError && error.code === 'MISSING_URI',
  );
});

test('blocks local or unavailable items because they cannot be reconstructed', () => {
  const local = entry('local', 'spotify:local:artist:album:track:120');
  local.item.is_local = true;
  assert.throws(
    () => buildPlaylistApplyPlan({ playlist, entries: [local], approvedItems: [approval(0, 'local', 'new')] }),
    (error) => error instanceof ApplyPlanError && error.code === 'UNSUPPORTED_ITEM',
  );

  const unavailable = entry('unavailable');
  unavailable.item.is_playable = false;
  assert.throws(
    () => buildPlaylistApplyPlan({ playlist, entries: [unavailable], approvedItems: [approval(0, 'unavailable', 'new')] }),
    (error) => error instanceof ApplyPlanError && error.code === 'UNSUPPORTED_ITEM',
  );
});

test('blocks playlists over Spotify’s single-request replacement limit', () => {
  const entries = Array.from({ length: 101 }, (_, index) => entry(`track${index}`));
  assert.throws(
    () => buildPlaylistApplyPlan({ playlist, entries, approvedItems: [approval(0, 'track0', 'new')] }),
    (error) => error instanceof ApplyPlanError && error.code === 'PLAYLIST_TOO_LARGE',
  );
});

test('allows exactly 100 items and preserves duplicate tracks and episodes', () => {
  const entries = Array.from({ length: 100 }, (_, index) => entry(`track${index}`));
  entries[50] = entry('track0');
  entries[99] = { item: { id: 'episode1', uri: 'spotify:episode:episode1', name: 'Episode', type: 'episode', is_local: false } };
  const plan = buildPlaylistApplyPlan({
    playlist,
    entries,
    approvedItems: [approval(1, 'track1', 'replacement')],
  });
  assert.equal(plan.targetUris.length, 100);
  assert.equal(plan.targetUris[0], 'spotify:track:track0');
  assert.equal(plan.targetUris[50], 'spotify:track:track0');
  assert.equal(plan.targetUris[99], 'spotify:episode:episode1');
});

test('classifies authoritative playlist state after an ambiguous write', () => {
  const plan = buildPlaylistApplyPlan({
    playlist,
    entries: [entry('one'), entry('two')],
    approvedItems: [approval(1, 'two', 'new')],
  });
  assert.equal(classifyPlaylistState([entry('one'), entry('new')], plan), 'target');
  assert.equal(classifyPlaylistState([entry('one'), entry('two')], plan), 'original');
  assert.equal(classifyPlaylistState([entry('one'), entry('external-change')], plan), 'other');
});
