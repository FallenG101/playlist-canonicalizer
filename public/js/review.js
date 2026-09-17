export const REVIEW_STATES = Object.freeze(['pending', 'approved', 'skipped']);

export function proposalId(proposal) {
  const snapshot = proposal.playlist.snapshotId || 'unknown-snapshot';
  return `${proposal.playlist.id}::${snapshot}::${proposal.position}::${proposal.sourceTrack.id}::${proposal.replacementTrack.id}`;
}

export function flattenReviewItems(analysis) {
  return analysis.families.flatMap((family) =>
    family.proposals.map((proposal) => ({
      ...proposal,
      id: proposalId(proposal),
      familyKey: family.key,
      familyArtist: family.artist,
      confidence: family.confidence,
      reasons: [...family.reasons],
    })),
  );
}

export function decisionFor(decisions, itemId) {
  const value = decisions instanceof Map ? decisions.get(itemId) : decisions[itemId];
  return REVIEW_STATES.includes(value) ? value : 'pending';
}

export function decisionCounts(items, decisions) {
  const counts = { total: items.length, pending: 0, approved: 0, skipped: 0 };
  for (const item of items) counts[decisionFor(decisions, item.id)] += 1;
  counts.decided = counts.approved + counts.skipped;
  return counts;
}

export function groupReviewItems(items, mode = 'playlist') {
  if (!['playlist', 'album'].includes(mode)) throw new Error(`Unknown review mode: ${mode}`);
  const groups = new Map();
  for (const item of items) {
    const key = mode === 'playlist' ? item.playlist.id : item.familyKey;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: mode === 'playlist' ? item.playlist.name : item.canonicalAlbum.name,
        caption: mode === 'playlist' ? `${item.playlist.collaborative ? 'Collaborative' : 'Owned'} playlist` : item.familyArtist,
        externalUrl: mode === 'playlist' ? item.playlist.externalUrl : item.canonicalAlbum.external_urls?.spotify,
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.items.sort((a, b) =>
      mode === 'playlist'
        ? a.position - b.position || a.sourceTrack.name.localeCompare(b.sourceTrack.name)
        : a.playlist.name.localeCompare(b.playlist.name) || a.position - b.position,
    );
  }
  return result.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}
