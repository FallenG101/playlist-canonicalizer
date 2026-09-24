import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decisionCounts,
  decisionFor,
  flattenReviewItems,
  groupReviewItems,
  proposalId,
} from '../public/js/review.js';

function proposal(playlistId, playlistName, position, sourceId, replacementId) {
  return {
    playlist: { id: playlistId, name: playlistName, snapshotId: 'snapshot-1', collaborative: false },
    position,
    sourceTrack: { id: sourceId, name: `Old ${sourceId}` },
    replacementTrack: { id: replacementId, name: `New ${replacementId}` },
    sourceAlbum: { id: 'old-album', name: 'Album' },
    canonicalAlbum: { id: 'new-album', name: 'Album (Deluxe)', external_urls: {} },
  };
}

const analysis = {
  families: [
    {
      key: 'artist::album',
      artist: 'Artist',
      confidence: 92,
      reasons: ['Expanded tracklist edition'],
      proposals: [
        proposal('p2', 'Second Playlist', 4, 'a', 'aa'),
        proposal('p1', 'First Playlist', 9, 'b', 'bb'),
        proposal('p1', 'First Playlist', 2, 'c', 'cc'),
      ],
    },
  ],
};

test('creates stable proposal identifiers', () => {
  const item = analysis.families[0].proposals[0];
  assert.equal(proposalId(item), 'p2::snapshot-1::4::a::aa');
});

test('groups one shared review set by playlist or album', () => {
  const items = flattenReviewItems(analysis);
  const playlists = groupReviewItems(items, 'playlist');
  const albums = groupReviewItems(items, 'album');

  assert.deepEqual(playlists.map((group) => group.label), ['First Playlist', 'Second Playlist']);
  assert.deepEqual(playlists[0].items.map((item) => item.position), [2, 9]);
  assert.equal(albums.length, 1);
  assert.equal(albums[0].items.length, 3);
});

test('merges album-family and cross-album remaster proposals targeting the same album', () => {
  const sharedTarget = proposal('p3', 'Third Playlist', 1, 'd', 'dd');
  const items = flattenReviewItems({
    families: [
      analysis.families[0],
      { key: 'remaster::new-album', artist: 'Artist', confidence: 65, reasons: ['Remaster'], proposals: [sharedTarget] },
    ],
  });
  const albums = groupReviewItems(items, 'album');
  assert.equal(albums.length, 1);
  assert.equal(albums[0].items.length, 4);
});

test('counts pending, approved, and skipped decisions', () => {
  const items = flattenReviewItems(analysis);
  const decisions = new Map([
    [items[0].id, 'approved'],
    [items[1].id, 'skipped'],
  ]);
  assert.deepEqual(decisionCounts(items, decisions), {
    total: 3,
    pending: 1,
    approved: 1,
    skipped: 1,
    decided: 2,
  });
  assert.equal(decisionFor(decisions, items[2].id), 'pending');
});
