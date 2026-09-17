const EDITION_PATTERN = /\b(deluxe|expanded|complete|anniversary|remaster(?:ed)?|special|collector'?s|bonus|legacy|super deluxe|forever|platinum|tour|taylor'?s version|tv)\b/i;
const SAFE_TRACK_QUALIFIERS = /\b(remaster(?:ed)?|taylor'?s version|tv|explicit|clean|album version|single version|radio edit|bonus track)\b/i;

export const DEFAULT_PREFERENCES = Object.freeze({
  preferTaylorsVersion: true,
  preferExpandedEditions: true,
  preferExplicit: true,
  preferLargerTracklists: true,
  manualAlbumOverrides: {},
  // Extension point for title-specific reissues, without hard-coding an album ID.
  preferredReleaseYears: {
    'the great american bar scene': 2025,
  },
});

export function normalizeText(value = '') {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function removeQualifiedBrackets(value, qualifierPattern) {
  return value.replace(/\s*[([]([^\])]+)[\])]\s*/g, (whole, inside) =>
    qualifierPattern.test(inside) ? ' ' : whole,
  );
}

export function baseAlbumName(name = '') {
  let base = removeQualifiedBrackets(name, EDITION_PATTERN);
  base = base.replace(/\s*[-–—:]\s*([^\n]+)$/g, (whole, suffix) => (EDITION_PATTERN.test(suffix) ? ' ' : whole));
  return normalizeText(base);
}

export function trackIdentity(track) {
  let title = removeQualifiedBrackets(track?.name || '', SAFE_TRACK_QUALIFIERS);
  title = title.replace(/\s*[-–—:]\s*([^\n]+)$/g, (whole, suffix) =>
    SAFE_TRACK_QUALIFIERS.test(suffix) ? ' ' : whole,
  );
  const artists = (track?.artists || []).map((artist) => normalizeText(artist.name)).join('|');
  return `${normalizeText(title)}::${artists}`;
}

export function albumFamilyKey(album) {
  const primaryArtist = album?.artists?.[0];
  return `${primaryArtist?.id || normalizeText(primaryArtist?.name)}::${baseAlbumName(album?.name)}`;
}

function editionSignals(album) {
  const name = normalizeText(album.name);
  return {
    taylorsVersion: /\btaylors version\b|\btv\b/.test(name),
    forever: /\bforever\b/.test(name),
    expanded: /\bexpanded\b/.test(name),
    deluxe: /\bdeluxe\b|\bsuper deluxe\b/.test(name),
    complete: /\bcomplete\b/.test(name),
    anniversary: /\banniversary\b/.test(name),
    remaster: /\bremaster|\bremastered/.test(name),
  };
}

function releaseYear(album) {
  return Number.parseInt(album.release_date, 10) || 0;
}

function scoreAlbum(candidate, familyKey, preferences) {
  const signals = editionSignals(candidate.album);
  const normalizedBase = baseAlbumName(candidate.album.name);
  let score = 0;
  if (preferences.manualAlbumOverrides[familyKey] === candidate.album.id) score += 10_000;
  if (preferences.preferTaylorsVersion && signals.taylorsVersion) score += 90;
  if (preferences.preferExpandedEditions) {
    if (signals.forever) score += 38;
    if (signals.expanded) score += 32;
    if (signals.deluxe) score += 28;
    if (signals.complete) score += 24;
    if (signals.anniversary) score += 15;
    if (signals.remaster) score += 8;
  }
  if (preferences.preferExplicit) score += candidate.explicitRatio * 14;
  if (preferences.preferLargerTracklists) score += Math.min(candidate.album.total_tracks || 0, 50) * 0.32;
  if (preferences.preferredReleaseYears[normalizedBase] === releaseYear(candidate.album)) score += 65;
  score += releaseYear(candidate.album) * 0.001;
  if (candidate.album.album_type === 'compilation') score -= 25;
  return score;
}

function canonicalReasons(canonical, alternatives, familyKey, preferences) {
  const signals = editionSignals(canonical.album);
  const reasons = [];
  if (preferences.manualAlbumOverrides[familyKey] === canonical.album.id) reasons.push('Manual canonical override');
  if (signals.taylorsVersion) reasons.push("Taylor's Version preference");
  if (signals.forever) reasons.push('Forever / expanded edition');
  else if (signals.expanded || signals.deluxe || signals.complete) reasons.push('Expanded tracklist edition');
  if (canonical.explicitRatio > Math.max(...alternatives.map((item) => item.explicitRatio), 0)) reasons.push('Explicit tracks preferred');
  if ((canonical.album.total_tracks || 0) > Math.max(...alternatives.map((item) => item.album.total_tracks || 0), 0)) reasons.push('More complete tracklist');
  const preferredYear = preferences.preferredReleaseYears[baseAlbumName(canonical.album.name)];
  if (preferredYear && releaseYear(canonical.album) === preferredYear) reasons.push(`Preferred ${preferredYear} release`);
  if (!reasons.length) reasons.push('Best edition score');
  return reasons;
}

function bestTrackMatch(sourceTrack, canonicalTracks, preferences) {
  const identity = trackIdentity(sourceTrack);
  const candidates = canonicalTracks.filter((track) => trackIdentity(track) === identity);
  if (!candidates.length) return null;
  const sourceDuration = Number(sourceTrack.duration_ms) || 0;
  const pool = candidates.filter((track) => {
    const candidateDuration = Number(track.duration_ms) || 0;
    if (sourceDuration && candidateDuration) return Math.abs(candidateDuration - sourceDuration) <= 9000;
    const sourceIsrc = sourceTrack.external_ids?.isrc;
    return Boolean(sourceIsrc && sourceIsrc === track.external_ids?.isrc);
  });
  if (!pool.length) return null;
  return [...pool].sort((a, b) => {
    if (preferences.preferExplicit && a.explicit !== b.explicit) return Number(b.explicit) - Number(a.explicit);
    return Math.abs((a.duration_ms || 0) - (sourceTrack.duration_ms || 0)) - Math.abs((b.duration_ms || 0) - (sourceTrack.duration_ms || 0));
  })[0];
}

function uniqueById(items) {
  return [...new Map(items.filter(Boolean).map((item) => [item.id, item])).values()];
}

function confidenceFor(family, canonical, proposals) {
  const alternativeTracks = family
    .filter((candidate) => candidate.album.id !== canonical.album.id)
    .flatMap((candidate) => candidate.tracks);
  const uniqueAlternatives = new Set(alternativeTracks.map(trackIdentity));
  const uniqueCanonical = new Set(canonical.tracks.map(trackIdentity));
  const overlap = [...uniqueAlternatives].filter((identity) => uniqueCanonical.has(identity)).length;
  const denominator = Math.max(1, Math.min(uniqueAlternatives.size, uniqueCanonical.size));
  const overlapRatio = overlap / denominator;
  const editionEvidence = family.some((candidate) => EDITION_PATTERN.test(candidate.album.name));
  const proposalEvidence = proposals.length ? 6 : 0;
  return Math.min(98, Math.round(58 + overlapRatio * 28 + (editionEvidence ? 6 : 0) + proposalEvidence));
}

export function analyzeInventory(placements, suppliedPreferences = {}) {
  const preferences = {
    ...DEFAULT_PREFERENCES,
    ...suppliedPreferences,
    manualAlbumOverrides: { ...DEFAULT_PREFERENCES.manualAlbumOverrides, ...(suppliedPreferences.manualAlbumOverrides || {}) },
    preferredReleaseYears: { ...DEFAULT_PREFERENCES.preferredReleaseYears, ...(suppliedPreferences.preferredReleaseYears || {}) },
  };
  const albumMap = new Map();

  for (const placement of placements) {
    const album = placement.track.album;
    if (!album?.id) continue;
    if (!albumMap.has(album.id)) {
      albumMap.set(album.id, { album, placements: [], tracks: [], explicitCount: 0, explicitRatio: 0 });
    }
    const candidate = albumMap.get(album.id);
    candidate.placements.push(placement);
    candidate.tracks.push(placement.track);
    if (placement.track.explicit) candidate.explicitCount += 1;
  }

  for (const candidate of albumMap.values()) {
    candidate.tracks = uniqueById(candidate.tracks);
    candidate.explicitRatio = candidate.placements.length ? candidate.explicitCount / candidate.placements.length : 0;
  }

  const grouped = new Map();
  for (const candidate of albumMap.values()) {
    const key = albumFamilyKey(candidate.album);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(candidate);
  }

  const families = [];
  for (const [familyKey, candidates] of grouped) {
    if (candidates.length < 2 || familyKey.endsWith('::')) continue;
    const ranked = [...candidates]
      .map((candidate) => ({ ...candidate, score: scoreAlbum(candidate, familyKey, preferences) }))
      .sort((a, b) => b.score - a.score || b.placements.length - a.placements.length || a.album.id.localeCompare(b.album.id));
    const canonical = ranked[0];
    const alternatives = ranked.slice(1);
    const canonicalTracks = canonical.tracks;
    const proposals = [];

    for (const source of alternatives) {
      for (const placement of source.placements) {
        const replacement = bestTrackMatch(placement.track, canonicalTracks, preferences);
        if (!replacement || replacement.id === placement.track.id) continue;
        proposals.push({
          playlist: placement.playlist,
          position: placement.position,
          sourceTrack: placement.track,
          replacementTrack: replacement,
          sourceAlbum: source.album,
          canonicalAlbum: canonical.album,
        });
      }
    }

    families.push({
      key: familyKey,
      artist: canonical.album.artists?.[0]?.name || 'Unknown artist',
      baseTitle: baseAlbumName(canonical.album.name),
      albums: ranked,
      canonical,
      alternatives,
      proposals,
      reasons: canonicalReasons(canonical, alternatives, familyKey, preferences),
      confidence: confidenceFor(ranked, canonical, proposals),
    });
  }

  families.sort((a, b) => b.proposals.length - a.proposals.length || b.confidence - a.confidence || a.artist.localeCompare(b.artist));
  return {
    families,
    albumCount: albumMap.size,
    proposalCount: families.reduce((sum, family) => sum + family.proposals.length, 0),
    preferences,
  };
}
