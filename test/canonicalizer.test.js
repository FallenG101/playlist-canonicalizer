import test from 'node:test';
import assert from 'node:assert/strict';
import {
  albumFamilyKey,
  analyzeInventory,
  baseAlbumName,
  normalizeText,
  trackIdentity,
} from '../public/js/canonicalizer.js';

const artist = { id: 'artist-taylor', name: 'Taylor Swift' };

function album(id, name, releaseDate = '2012-10-22', totalTracks = 16) {
  return {
    id,
    name,
    release_date: releaseDate,
    total_tracks: totalTracks,
    album_type: 'album',
    artists: [artist],
    external_urls: { spotify: `https://open.spotify.com/album/${id}` },
    images: [],
  };
}

function track(id, name, albumObject, explicit = false, duration = 220_000) {
  return {
    id,
    name,
    type: 'track',
    duration_ms: duration,
    explicit,
    artists: [artist],
    album: albumObject,
  };
}

function placement(trackObject, playlistName = 'Favorites') {
  return {
    playlist: { id: `playlist-${playlistName}`, name: playlistName },
    position: 0,
    track: trackObject,
  };
}

test('normalizes punctuation, accents, and ampersands', () => {
  assert.equal(normalizeText('Héroes & Villains!'), 'heroes and villains');
});

test('groups deluxe and Taylor editions under their base album title', () => {
  assert.equal(baseAlbumName("Red (Taylor's Version)"), 'red');
  assert.equal(baseAlbumName('Stick Season (Forever)'), 'stick season');
  assert.equal(baseAlbumName('Album — Deluxe Edition'), 'album');
  assert.equal(
    albumFamilyKey(album('one', "Red (Taylor's Version)")),
    albumFamilyKey(album('two', 'Red')),
  );
});

test('keeps meaningful performance qualifiers in track identity', () => {
  const base = track('one', 'Song', album('album', 'Record'));
  assert.equal(trackIdentity({ ...base, name: "Song (Taylor's Version)" }), trackIdentity(base));
  assert.notEqual(trackIdentity({ ...base, name: 'Song (Live)' }), trackIdentity(base));
});

test("prefers Taylor's Version and creates read-only replacement proposals", () => {
  const originalAlbum = album('original', 'Red', '2012-10-22', 16);
  const taylorsAlbum = album('taylors', "Red (Taylor's Version)", '2021-11-12', 30);
  const placements = [
    placement(track('old', 'All Too Well', originalAlbum), 'Old mix'),
    placement(track('new', "All Too Well (Taylor's Version)", taylorsAlbum), 'New mix'),
  ];
  const result = analyzeInventory(placements);

  assert.equal(result.families.length, 1);
  assert.equal(result.families[0].canonical.album.id, 'taylors');
  assert.equal(result.families[0].proposals.length, 1);
  assert.equal(result.families[0].proposals[0].replacementTrack.id, 'new');
  assert.match(result.families[0].reasons.join(' '), /Taylor's Version/);
});

test('prefers the explicit copy when album names are otherwise identical', () => {
  const cleanAlbum = album('clean', 'Midnights');
  const explicitAlbum = album('explicit', 'Midnights');
  const result = analyzeInventory([
    placement(track('clean-track', 'Lavender Haze', cleanAlbum, false)),
    placement(track('explicit-track', 'Lavender Haze', explicitAlbum, true)),
  ]);

  assert.equal(result.families[0].canonical.album.id, 'explicit');
  assert.equal(result.proposalCount, 1);
});

test('supports a title-specific preferred release year', () => {
  const oldAlbum = album('2024', 'The Great American Bar Scene', '2024-07-04', 19);
  const updatedAlbum = album('2025', 'The Great American Bar Scene', '2025-07-04', 19);
  const zach = { id: 'zach', name: 'Zach Bryan' };
  oldAlbum.artists = [zach];
  updatedAlbum.artists = [zach];
  const oldTrack = track('old', 'Track One', oldAlbum);
  const newTrack = track('new', 'Track One', updatedAlbum);
  oldTrack.artists = [zach];
  newTrack.artists = [zach];

  const result = analyzeInventory([placement(oldTrack), placement(newTrack)]);
  assert.equal(result.families[0].canonical.album.id, '2025');
  assert.match(result.families[0].reasons.join(' '), /2025/);
});

test('manual overrides take precedence over automatic scoring', () => {
  const originalAlbum = album('original', 'Red');
  const taylorsAlbum = album('taylors', "Red (Taylor's Version)", '2021-11-12', 30);
  const key = albumFamilyKey(originalAlbum);
  const result = analyzeInventory(
    [
      placement(track('old', 'All Too Well', originalAlbum)),
      placement(track('new', "All Too Well (Taylor's Version)", taylorsAlbum)),
    ],
    { manualAlbumOverrides: { [key]: 'original' } },
  );
  assert.equal(result.families[0].canonical.album.id, 'original');
});

test('does not propose a same-title track when durations differ substantially', () => {
  const originalAlbum = album('original', 'Record');
  const deluxeAlbum = album('deluxe', 'Record (Deluxe)', '2024-01-01', 20);
  const result = analyzeInventory([
    placement(track('short', 'Same Name', originalAlbum, false, 120_000)),
    placement(track('long', 'Same Name', deluxeAlbum, false, 240_000)),
  ]);
  assert.equal(result.proposalCount, 0);
});

test('missing artist or title metadata cannot create a cross-album replacement', () => {
  const firstAlbum = { ...album('first', 'Record'), artists: [] };
  const secondAlbum = { ...album('second', 'Record (Deluxe)'), artists: [] };
  const firstTrack = { ...track('one', 'Song', firstAlbum), artists: [] };
  const secondTrack = { ...track('two', 'Song', secondAlbum), artists: [] };
  const result = analyzeInventory([placement(firstTrack), placement(secondTrack)]);
  assert.equal(result.proposalCount, 0);
  assert.equal(result.families.length, 0);
  assert.equal(trackIdentity({ name: null, artists: null }), '');
  assert.equal(baseAlbumName(null), '');
});

test('does not propose a replacement Spotify marks unplayable', () => {
  const originalAlbum = album('original', 'Record');
  const deluxeAlbum = album('deluxe', 'Record (Deluxe)');
  const unavailable = { ...track('new', 'Song', deluxeAlbum), is_playable: false };
  const result = analyzeInventory([
    placement(track('old', 'Song', originalAlbum)),
    placement(unavailable),
  ]);
  assert.equal(result.proposalCount, 0);
});

test('finds a Sinatra remaster on an unrelated album in a selected playlist', () => {
  const sinatra = { id: 'sinatra', name: 'Frank Sinatra' };
  const originalAlbum = { ...album('original', 'Songs for Swingin Lovers'), artists: [sinatra] };
  const remasterAlbum = { ...album('compilation', 'The Best of Frank Sinatra'), artists: [sinatra] };
  const original = { ...track('original-track', 'Ive Got You Under My Skin', originalAlbum), artists: [sinatra] };
  const remaster = {
    ...track('remastered-track', 'Ive Got You Under My Skin (2018 Remaster)', remasterAlbum, false, 221_000),
    artists: [sinatra],
  };
  const result = analyzeInventory([placement(original, 'Old songs'), placement(remaster, 'Remasters')]);
  assert.equal(result.proposalCount, 1);
  assert.equal(result.families[0].proposals[0].replacementTrack.id, 'remastered-track');
  assert.equal(result.families[0].proposals[0].crossAlbumRemaster, true);
  assert.match(result.families[0].reasons.join(' '), /listen/i);
});

test('detects an album-labeled remaster but never reverses a remaster into an original', () => {
  const originalAlbum = album('original', 'First Release');
  const remasterAlbum = album('remaster', 'Greatest Hits (Remastered)');
  const result = analyzeInventory([
    placement(track('old', 'Song', originalAlbum), 'Old'),
    placement(track('new', 'Song', remasterAlbum, false, 221_000), 'New'),
  ]);
  assert.equal(result.proposalCount, 1);
  assert.equal(result.families[0].proposals[0].sourceTrack.id, 'old');
});

test('does not confuse live versions, other artists, large duration gaps, or unavailable remasters', () => {
  const sourceAlbum = album('source', 'Original');
  const remasterAlbum = album('remaster', 'Unrelated Remastered');
  const otherArtist = { id: 'other', name: artist.name };
  const cases = [
    track('live', 'Song (Live)', remasterAlbum),
    { ...track('different-artist', 'Song', remasterAlbum), artists: [otherArtist] },
    track('long', 'Song', remasterAlbum, false, 230_000),
    { ...track('unavailable', 'Song', remasterAlbum), is_playable: false },
  ];
  for (const candidate of cases) {
    const result = analyzeInventory([
      placement(track('old', 'Song', sourceAlbum), 'Old'),
      placement(candidate, 'New'),
    ]);
    assert.equal(result.proposalCount, 0, candidate.id);
  }
});

test('cross-album remaster replaces an ordinary edition proposal without duplicating a playlist position', () => {
  const originalAlbum = album('original', 'Record');
  const deluxeAlbum = album('deluxe', 'Record (Deluxe)', '2024-01-01', 20);
  const remasterAlbum = album('remaster', 'Other Collection (Remastered)', '2025-01-01');
  const result = analyzeInventory([
    placement(track('original-track', 'Song', originalAlbum), 'Old'),
    placement(track('deluxe-track', 'Song', deluxeAlbum), 'Deluxe'),
    placement(track('remaster-track', 'Song', remasterAlbum), 'Remaster'),
  ]);
  const proposals = result.families.flatMap((family) => family.proposals);
  assert.equal(proposals.filter((item) => item.sourceTrack.id === 'original-track').length, 1);
  assert.equal(proposals.find((item) => item.sourceTrack.id === 'original-track').replacementTrack.id, 'remaster-track');
});

test('cross-album remasters do not override a Taylor Version or manual album choice', () => {
  const originalAlbum = album('original', 'Red');
  const taylorsAlbum = album('taylors', "Red (Taylor's Version)", '2021-01-01', 30);
  const remasterAlbum = album('remaster', 'Old Hits (Remastered)', '2025-01-01');
  const placements = [
    placement(track('old', 'Song', originalAlbum), 'Old'),
    placement(track('tv', "Song (Taylor's Version)", taylorsAlbum), 'TV'),
    placement(track('remaster', 'Song', remasterAlbum), 'Remaster'),
  ];
  const result = analyzeInventory(placements);
  assert.equal(result.families.flatMap((family) => family.proposals)
    .find((item) => item.sourceTrack.id === 'old').replacementTrack.id, 'tv');
  const overridden = analyzeInventory(placements, {
    manualAlbumOverrides: { [albumFamilyKey(originalAlbum)]: 'original' },
  });
  assert.equal(overridden.families.flatMap((family) => family.proposals)
    .some((item) => item.sourceTrack.id === 'old'), false);
});

test('remaster preference does not downgrade an explicit track to clean', () => {
  const originalAlbum = album('original', 'First Release');
  const remasterAlbum = album('remaster', 'Other Album (Remastered)');
  const result = analyzeInventory([
    placement(track('explicit', 'Song', originalAlbum, true), 'Original'),
    placement(track('clean', 'Song', remasterAlbum, false), 'Remaster'),
  ]);
  assert.equal(result.proposalCount, 0);
});
