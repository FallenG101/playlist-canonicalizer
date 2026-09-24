const EDITION_PATTERN = /\b(deluxe|expanded|complete|anniversary|remaster(?:ed)?|special|collector'?s|bonus|legacy|super deluxe|forever|platinum|tour|taylor'?s version|tv)\b/i;
const SAFE_TRACK_QUALIFIERS = /\b(remaster(?:ed)?|taylor'?s version|tv|explicit|clean|bonus track)\b/i;

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
  return (typeof value === 'string' ? value : '')
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
  let base = removeQualifiedBrackets(typeof name === 'string' ? name : '', EDITION_PATTERN);
  base = base.replace(/\s*[-–—:]\s*([^\n]+)$/g, (whole, suffix) => (EDITION_PATTERN.test(suffix) ? ' ' : whole));
  return normalizeText(base);
}

export function trackIdentity(track) {
  let title = removeQualifiedBrackets(typeof track?.name === 'string' ? track.name : '', SAFE_TRACK_QUALIFIERS);
  title = title.replace(/\s*[-–—:]\s*([^\n]+)$/g, (whole, suffix) =>
    SAFE_TRACK_QUALIFIERS.test(suffix) ? ' ' : whole,
  );
  const artists = Array.isArray(track?.artists)
    ? track.artists.map((artist) => normalizeText(artist?.name)).filter(Boolean).join('|')
    : '';
  const normalizedTitle = normalizeText(title);
  return normalizedTitle && artists ? `${normalizedTitle}::${artists}` : '';
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

function bestTrackMatch(sourceTrack, canonicalTracksByIdentity, preferences) {
  const identity = trackIdentity(sourceTrack);
  if (!identity) return null;
  const candidates = (canonicalTracksByIdentity.get(identity) || []).filter(
    (track) => track.is_playable !== false && !track.restrictions?.reason,
  );
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

const REMASTER_PATTERN = /\bremaster(?:ed)?\b/i;
const REMASTER_YEAR_BEFORE = /\b((?:19|20)\d{2})\s+(?:(?:digital|newly)\s+)?remaster(?:ed)?\b/i;
const REMASTER_YEAR_AFTER = /\bremaster(?:ed)?(?:\s+(?:version|edition|in))?\s+((?:19|20)\d{2})\b/i;

function labeledRemasterYear(name) {
  if (typeof name !== 'string') return null;
  const match = name.match(REMASTER_YEAR_BEFORE) || name.match(REMASTER_YEAR_AFTER);
  const year = match ? Number(match[1]) : null;
  return year && year <= new Date().getUTCFullYear() + 1 ? year : null;
}

export function remasterDetails(track) {
  const trackName = track?.name || '';
  const albumName = track?.album?.name || '';
  const trackLabeled = REMASTER_PATTERN.test(trackName);
  const albumLabeled = REMASTER_PATTERN.test(albumName);
  return {
    labeled: trackLabeled || albumLabeled,
    year: (trackLabeled && labeledRemasterYear(trackName)) ||
      (albumLabeled && labeledRemasterYear(albumName)) || null,
    source: trackLabeled ? 'track title' : albumLabeled ? 'album title' : null,
  };
}

function remasterEvidence(track) {
  const details = remasterDetails(track);
  return details.source === 'track title' ? 2 : details.labeled ? 1 : 0;
}

function remasterIdentity(track) {
  if (!Array.isArray(track?.artists) || !track.artists.length ||
      track.artists.some((artist) => !artist?.id)) return '';
  const stripRemasterLabel = (label) => label
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\bremaster(?:ed)?\b/gi, ' ')
    .replace(/\b(?:digital|newly|version|edition)\b/gi, ' ')
    .trim();
  let title = typeof track.name === 'string' ? track.name : '';
  title = title.replace(/\s*[([]([^\])]+)[\])]\s*/g, (whole, inside) =>
    REMASTER_PATTERN.test(inside) ? ` ${stripRemasterLabel(inside)} ` : whole,
  );
  title = title.replace(/\s*[-–—:]\s*([^\n]+)$/g, (whole, suffix) =>
    REMASTER_PATTERN.test(suffix) ? ` ${stripRemasterLabel(suffix)} ` : whole,
  );
  const normalized = normalizeText(title);
  return normalized ? `${normalized}::${track.artists.map((artist) => artist.id).join('|')}` : '';
}

function placementKey(placement) {
  return `${placement.playlist?.id}::${placement.position}`;
}

function remasterCandidates(placements) {
  const byIdentity = new Map();
  for (const placement of placements) {
    const track = placement?.track;
    const identity = remasterIdentity(track);
    if (!identity || !track?.id || !track.album?.id || !remasterEvidence(track) ||
        track.is_playable === false || track.restrictions?.reason) continue;
    if (!byIdentity.has(identity)) byIdentity.set(identity, new Map());
    byIdentity.get(identity).set(track.id, track);
  }
  return byIdentity;
}

function bestCrossAlbumRemaster(source, candidates, preferences) {
  const sourceTrack = source?.track;
  if (!sourceTrack?.id || !sourceTrack.album?.id ||
      !Number.isFinite(sourceTrack.duration_ms) || sourceTrack.duration_ms <= 0) return null;
  if (preferences.manualAlbumOverrides[albumFamilyKey(sourceTrack.album)] === sourceTrack.album.id) return null;
  // A re-recording preference must not be overturned by an older recording's remaster.
  if (preferences.preferTaylorsVersion &&
      /\btaylor'?s version\b/i.test(`${sourceTrack.name} ${sourceTrack.album.name}`)) return null;
  const sourceRemaster = remasterDetails(sourceTrack);
  const eligible = [...(candidates.get(remasterIdentity(sourceTrack))?.values() || [])].filter((candidate) => {
    const candidateYear = remasterDetails(candidate).year;
    return candidate.id !== sourceTrack.id && candidate.album.id !== sourceTrack.album.id &&
    !(preferences.preferExplicit && sourceTrack.explicit && !candidate.explicit) &&
    Number.isFinite(candidate.duration_ms) && candidate.duration_ms > 0 &&
    Math.abs(candidate.duration_ms - sourceTrack.duration_ms) <= 3000 &&
    (!sourceRemaster.year || (candidateYear !== null && candidateYear > sourceRemaster.year)) &&
    (!sourceRemaster.labeled || sourceRemaster.year || candidateYear !== null);
  });
  if (!eligible.length) return null;
  const sourceIsrc = sourceTrack.external_ids?.isrc;
  const isrcMatch = (candidate) => Number(Boolean(sourceIsrc && candidate.external_ids?.isrc === sourceIsrc));
  eligible.sort((a, b) =>
    (remasterDetails(b).year || 0) - (remasterDetails(a).year || 0) ||
    remasterEvidence(b) - remasterEvidence(a) ||
    isrcMatch(b) - isrcMatch(a) ||
    (preferences.preferExplicit ? Number(b.explicit) - Number(a.explicit) : 0) ||
    Math.abs(a.duration_ms - sourceTrack.duration_ms) - Math.abs(b.duration_ms - sourceTrack.duration_ms) ||
    Number(a.album.album_type === 'compilation') - Number(b.album.album_type === 'compilation') ||
    a.id.localeCompare(b.id),
  );
  const replacement = eligible[0];
  const selectedYear = remasterDetails(replacement).year;
  const sameYear = eligible.filter((track) => remasterDetails(track).year === selectedYear);
  // Different ISRCs for equally dated editions leave the recording/master uncertain.
  const knownIsrcs = new Set(sameYear.map((track) => track.external_ids?.isrc).filter(Boolean));
  const requiresChoice = sameYear.length > 1 &&
    (knownIsrcs.size !== 1 || sameYear.some((track) => !track.external_ids?.isrc));
  const description = selectedYear
    ? `${selectedYear} remaster labeled in the ${remasterDetails(replacement).source}`
    : `Remaster labeled in the ${remasterDetails(replacement).source}; mastering year unknown`;
  const sourceDescription = sourceRemaster.year
    ? `Current version is labeled ${sourceRemaster.year} remaster.`
    : sourceRemaster.labeled ? 'Current remaster year is unknown.' : 'Current version has no remaster label.';
  return {
    replacement,
    explanation: `${description}. ${sourceDescription} Album release dates were not used as remaster dates.${requiresChoice ? ' Multiple equally dated candidates cannot be distinguished; choose one manually.' : ''}`,
    candidateCount: eligible.length,
    dated: selectedYear !== null,
    options: eligible,
    requiresChoice,
  };
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
    const album = placement?.track?.album;
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
    if (key.startsWith('::') || key.endsWith('::')) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(candidate);
  }

  const families = [];
  const existingProposals = new Map();
  for (const [familyKey, candidates] of grouped) {
    if (candidates.length < 2) continue;
    const ranked = [...candidates]
      .map((candidate) => ({ ...candidate, score: scoreAlbum(candidate, familyKey, preferences) }))
      .sort((a, b) => b.score - a.score || b.placements.length - a.placements.length || a.album.id.localeCompare(b.album.id));
    const canonical = ranked[0];
    const alternatives = ranked.slice(1);
    const canonicalTracksByIdentity = new Map();
    for (const track of canonical.tracks) {
      const identity = trackIdentity(track);
      if (!identity) continue;
      if (!canonicalTracksByIdentity.has(identity)) canonicalTracksByIdentity.set(identity, []);
      canonicalTracksByIdentity.get(identity).push(track);
    }
    const proposals = [];

    for (const source of alternatives) {
      for (const placement of source.placements) {
        const replacement = bestTrackMatch(placement.track, canonicalTracksByIdentity, preferences);
        if (!replacement || replacement.id === placement.track.id) continue;
        const sourceRemaster = remasterDetails(placement.track);
        const replacementRemaster = remasterDetails(replacement);
        const manualOverride = preferences.manualAlbumOverrides[familyKey] === canonical.album.id;
        const taylorsVersion = preferences.preferTaylorsVersion &&
          /\btaylor'?s version\b/i.test(`${replacement.name} ${canonical.album.name}`);
        if (!manualOverride && !taylorsVersion && sourceRemaster.labeled &&
            (!replacementRemaster.labeled ||
              (sourceRemaster.year && (!replacementRemaster.year || replacementRemaster.year < sourceRemaster.year)))) continue;
        if (!manualOverride && !taylorsVersion && sourceRemaster.labeled && replacementRemaster.labeled &&
            (!sourceRemaster.year || !replacementRemaster.year || sourceRemaster.year === replacementRemaster.year) &&
            (!placement.track.external_ids?.isrc ||
              placement.track.external_ids.isrc !== replacement.external_ids?.isrc)) continue;
        proposals.push({
          playlist: placement.playlist,
          position: placement.position,
          sourceTrack: placement.track,
          replacementTrack: replacement,
          sourceAlbum: source.album,
          canonicalAlbum: canonical.album,
        });
        existingProposals.set(placementKey(placement), { familyKey, proposal: proposals.at(-1) });
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

  const remasters = remasterCandidates(placements);
  const remasterGroups = new Map();
  for (const placement of placements) {
    const recommendation = bestCrossAlbumRemaster(placement, remasters, preferences);
    if (!recommendation) continue;
    const { replacement } = recommendation;
    const key = placementKey(placement);
    const existing = existingProposals.get(key);
    if (existing) {
      const currentFamily = families.find((family) => family.key === existing.familyKey);
      if (!currentFamily?.proposals.includes(existing.proposal)) continue;
      if (preferences.manualAlbumOverrides[existing.familyKey] ||
          (preferences.preferTaylorsVersion &&
            /\btaylor'?s version\b/i.test(`${existing.proposal.replacementTrack.name} ${existing.proposal.canonicalAlbum.name}`))) continue;
      currentFamily.proposals.splice(currentFamily.proposals.indexOf(existing.proposal), 1);
    }
    const groupKey = `remaster::${replacement.album.id}`;
    if (!remasterGroups.has(groupKey)) remasterGroups.set(groupKey, []);
    remasterGroups.get(groupKey).push({
      playlist: placement.playlist,
      position: placement.position,
      sourceTrack: placement.track,
      replacementTrack: replacement,
      sourceAlbum: placement.track.album,
      canonicalAlbum: replacement.album,
      crossAlbumRemaster: true,
      explanation: recommendation.explanation,
      candidateCount: recommendation.candidateCount,
      datedRemaster: recommendation.dated,
      candidateOptions: recommendation.options,
      requiresCandidateChoice: recommendation.requiresChoice,
      candidateChosen: false,
    });
  }
  for (const family of families) {
    family.confidence = confidenceFor(family.albums, family.canonical, family.proposals);
  }
  for (const [key, proposals] of remasterGroups) {
    const canonical = albumMap.get(proposals[0].canonicalAlbum.id);
    if (!canonical) continue;
    const alternatives = uniqueById(proposals.map((proposal) => proposal.sourceAlbum))
      .map((album) => albumMap.get(album.id)).filter(Boolean);
    families.push({
      key,
      artist: canonical.album.artists?.[0]?.name || 'Unknown artist',
      baseTitle: baseAlbumName(canonical.album.name),
      albums: [canonical, ...alternatives],
      canonical,
      alternatives,
      proposals,
      reasons: ['Cross-album remaster candidate; listen before approving'],
      confidence: 65,
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
