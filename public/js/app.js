import {
  accessToken,
  beginAuthorization,
  disconnect,
  finishAuthorization,
  hasSession,
  hasWriteAccess,
  isValidClientId,
  redirectUri,
  savedClientId,
} from './auth.js';
import { buildPlaylistApplyPlan, classifyPlaylistState } from './apply.js';
import { analyzeInventory } from './canonicalizer.js';
import {
  chooseRecommendationCandidate,
  decisionCounts,
  decisionFor,
  flattenReviewItems,
  groupReviewItems,
  proposalId,
  restoreRecommendationChoices,
} from './review.js';
import { playlistItemCount, SpotifyClient } from './spotify.js';
import { PlaylistScanCache } from './scan-cache.js';

const $ = (selector) => document.querySelector(selector);
const welcomeView = $('#welcome-view');
const dashboardView = $('#dashboard-view');
const disconnectButton = $('#disconnect-button');
const connectForm = $('#connect-form');
const clientIdInput = $('#client-id');
const inputStatus = $('#input-status');
const scanButton = $('#scan-button');
const rescanButton = $('#rescan-button');
const exportButton = $('#export-button');
const statusPanel = $('#status-panel');
const resultsView = $('#results-view');
const reviewWorkspace = $('#review-workspace');
const playlistList = $('#playlist-list');
const proposalReviewList = $('#proposal-review-list');
const emptyState = $('#empty-state');
const toast = $('#toast');
const installButton = $('#install-button');
const playlistPickerDialog = $('#playlist-picker-dialog');
const playlistPickerList = $('#playlist-picker-list');
const playlistPickerSummary = $('#playlist-picker-summary');
const playlistPickerError = $('#playlist-picker-error');
const startSelectedScanButton = $('#start-selected-scan-button');

const scanCache = new PlaylistScanCache();
const spotify = new SpotifyClient(accessToken, { scanCache });
const REVIEW_STORAGE_PREFIX = 'canonicalizer.review.decisions';
const CHOICE_STORAGE_PREFIX = 'canonicalizer.review.choices';
const INFLIGHT_STORAGE_PREFIX = 'canonicalizer.apply.inflight';
const RATE_LIMIT_UNTIL_KEY = 'canonicalizer.spotify.rateLimitUntil';
let currentScan = null;
let reviewItems = [];
let reviewDecisions = new Map();
let reviewChoices = new Map();
let reviewMode = 'playlist';
let reviewFilter = 'all';
let reviewGroupIndices = { playlist: 0, album: 0 };
let pendingApplyPlan = null;
let appliedPlaylists = new Set();
let unresolvedOperation = null;
let applyInProgress = false;
let toastTimer = null;
let rateLimitTimer = null;
let playlistPickerOpen = false;
let playlistPickerLoading = false;
let scanInProgress = false;
let pendingScanSource = null;
let installPromptEvent = null;

function storedRateLimitUntil() {
  const value = Number(sessionStorage.getItem(RATE_LIMIT_UNTIL_KEY) || 0);
  return Number.isFinite(value) ? value : 0;
}

function rateLimitActive() {
  return storedRateLimitUntil() > Date.now();
}

function startRateLimitCountdown(waitSeconds) {
  const requestedUntil = Date.now() + Math.max(1, waitSeconds) * 1000;
  const until = Math.max(storedRateLimitUntil(), requestedUntil);
  sessionStorage.setItem(RATE_LIMIT_UNTIL_KEY, String(until));
  clearTimeout(rateLimitTimer);

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (remaining > 0) {
      scanButton.disabled = true;
      rescanButton.disabled = true;
      $('#status-title').textContent = 'Spotify paused the scan';
      $('#status-detail').textContent = `Rate-limit cooldown: ${remaining} second${remaining === 1 ? '' : 's'} remaining. Scan is disabled so the wait window can clear.`;
      statusPanel.classList.remove('hidden');
      rateLimitTimer = setTimeout(tick, 1000);
      return;
    }
    sessionStorage.removeItem(RATE_LIMIT_UNTIL_KEY);
    scanButton.disabled = false;
    rescanButton.disabled = false;
    $('#status-title').textContent = 'Ready to scan again';
    $('#status-detail').textContent = 'Spotify’s cooldown has elapsed. Select Scan again when you are ready.';
  };
  tick();
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4200);
}

function updateInstallButton() {
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  installButton.classList.toggle('hidden', installed);
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPromptEvent = event;
  updateInstallButton();
});

window.addEventListener('appinstalled', () => {
  installPromptEvent = null;
  updateInstallButton();
  showToast('Canonicalizer was added to your device.');
});

installButton.addEventListener('click', async () => {
  if (!installPromptEvent) {
    showToast('Install from your browser menu. On iPhone or iPad, use Share, then Add to Home Screen.');
    return;
  }
  const promptEvent = installPromptEvent;
  installPromptEvent = null;
  await promptEvent.prompt();
  const choice = await promptEvent.userChoice;
  if (choice?.outcome === 'accepted') showToast('Canonicalizer is being installed.');
  updateInstallButton();
});

function setAuthenticated(authenticated) {
  welcomeView.classList.toggle('hidden', authenticated);
  dashboardView.classList.toggle('hidden', !authenticated);
  disconnectButton.classList.toggle('hidden', !authenticated);
}

function setBusy(busy) {
  scanButton.disabled = busy || rateLimitActive() || playlistPickerOpen;
  rescanButton.disabled = busy || rateLimitActive() || playlistPickerOpen;
  disconnectButton.disabled = busy || playlistPickerOpen;
  if (busy) {
    statusPanel.classList.remove('hidden');
    resultsView.classList.add('hidden');
  }
}

function updateProgress({ detail, percent }) {
  $('#status-title').textContent = percent >= 98 ? 'Building your review queue…' : 'Reading your playlists…';
  $('#status-detail').textContent = detail;
  $('#progress-bar').style.width = `${Math.max(0, Math.min(percent, 100))}%`;
}

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.href) {
    node.href = options.href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  }
  if (options.alt !== undefined) node.alt = options.alt;
  if (options.title) node.title = options.title;
  if (options.src) node.src = options.src;
  if (options.type) node.type = options.type;
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function spotifyExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'open.spotify.com' ? url.href : null;
  } catch {
    return null;
  }
}

function reviewCover(album) {
  const imageUrl = album.images?.[1]?.url || album.images?.[0]?.url;
  if (!imageUrl) return element('span', { className: 'review-item-cover' });
  const image = element('img', { className: 'review-item-cover', src: imageUrl, alt: `${album.name} cover` });
  const spotifyUrl = spotifyExternalUrl(album.external_urls?.spotify);
  return spotifyUrl
    ? element('a', { className: 'review-cover-link', href: spotifyUrl }, [image])
    : image;
}

function spotifyTrackLink(track) {
  const label = element('strong', { text: track.name, title: track.name });
  const title = element('span', { className: 'track-title-row' }, [
    label,
    track.explicit ? element('span', { className: 'explicit-badge', text: 'E', title: 'Explicit' }) : null,
  ]);
  const spotifyUrl = spotifyExternalUrl(track.external_urls?.spotify);
  return spotifyUrl
    ? element('a', { className: 'track-link', href: spotifyUrl }, [title])
    : title;
}

function spotifyAlbumLink(album) {
  const label = element('small', { text: album.name, title: album.name });
  const spotifyUrl = spotifyExternalUrl(album.external_urls?.spotify);
  return spotifyUrl
    ? element('a', { className: 'album-link', href: spotifyUrl }, [label])
    : label;
}

function stat(label, value, className = '') {
  return element('div', { className: `decision-stat ${className}`.trim() }, [
    element('strong', { text: String(value) }),
    element('span', { text: label }),
  ]);
}

function reviewStorageKey(accountId) {
  return `${REVIEW_STORAGE_PREFIX}.${accountId}`;
}

function choiceStorageKey(accountId) {
  return `${CHOICE_STORAGE_PREFIX}.${accountId}`;
}

function loadReviewChoices(accountId) {
  try {
    const stored = JSON.parse(localStorage.getItem(choiceStorageKey(accountId)) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return new Map();
    return new Map(Object.entries(stored).filter(([sourceId, candidateId]) =>
      /^[A-Za-z0-9]+$/.test(sourceId) && /^[A-Za-z0-9]+$/.test(candidateId),
    ));
  } catch {
    return new Map();
  }
}

function loadReviewDecisions(accountId, items) {
  const validItems = new Map(items.map((item) => [item.id, item]));
  try {
    const stored = JSON.parse(localStorage.getItem(reviewStorageKey(accountId)) || '{}');
    return new Map(
      Object.entries(stored).filter(
        ([id, state]) => validItems.has(id) && ['approved', 'skipped'].includes(state) &&
          (state !== 'approved' || !validItems.get(id).requiresCandidateChoice || validItems.get(id).candidateChosen),
      ),
    );
  } catch {
    return new Map();
  }
}

function persistReviewDecisions() {
  const accountId = currentScan?.inventory?.profile?.id;
  if (!accountId) return;
  localStorage.setItem(reviewStorageKey(accountId), JSON.stringify(Object.fromEntries(reviewDecisions)));
}

function safeFilename(value) {
  return String(value || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'playlist';
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setApplyError(message) {
  const error = $('#apply-dialog-error');
  error.textContent = message;
  error.classList.remove('hidden');
}

function setOperationControls(busy) {
  applyInProgress = busy;
  scanButton.disabled = busy;
  rescanButton.disabled = busy;
  disconnectButton.disabled = busy;
  reviewWorkspace.classList.toggle('operation-locked', busy);
}

function setDialogBusy(busy) {
  $('#dialog-close').disabled = busy;
  $('#dialog-cancel').disabled = busy;
  $('#confirm-apply-button').disabled = busy;
}

function updateApplyProgress(percent, label) {
  const bounded = Math.max(0, Math.min(100, percent));
  const track = $('#apply-progress-bar').parentElement;
  $('#apply-progress-bar').style.width = `${bounded}%`;
  track.setAttribute('aria-valuenow', String(bounded));
  $('#apply-progress-label').textContent = label;
}

function inflightKey(accountId, playlistId) {
  return `${INFLIGHT_STORAGE_PREFIX}.${accountId}.${playlistId}`;
}

function setRecoveryBanner(message = '') {
  const banner = $('#recovery-banner');
  banner.classList.toggle('hidden', !message);
  if (message) $('#recovery-message').textContent = message;
}

async function playlistStateFor(plan) {
  const entries = await spotify.playlistItems(plan.playlist.id);
  return classifyPlaylistState(entries, plan);
}

async function withPlaylistLock(playlistId, task) {
  if (!navigator.locks?.request) {
    throw new Error('This browser does not support the Web Locks safety check needed for Apply. Use a current browser with Web Locks support.');
  }
  return navigator.locks.request(
    `spotify-canonicalizer:${playlistId}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw new Error('Another Canonicalizer tab is already applying changes to this playlist.');
      return task();
    },
  );
}

function claimInflight(plan) {
  const key = inflightKey(plan.accountId, plan.playlist.id);
  if (localStorage.getItem(key)) {
    throw new Error('An earlier Apply for this playlist is still unresolved. Reload the app before writing again.');
  }
  const marker = { ...plan, operationId: crypto.randomUUID(), startedAt: new Date().toISOString() };
  localStorage.setItem(key, JSON.stringify(marker));
  const claimed = JSON.parse(localStorage.getItem(key) || 'null');
  if (claimed?.operationId !== marker.operationId) {
    throw new Error('Another tab claimed this playlist first. Apply was stopped.');
  }
  return { key, marker };
}

async function reconcileInterruptedOperations(accountId) {
  unresolvedOperation = null;
  setRecoveryBanner();
  const prefix = `${INFLIGHT_STORAGE_PREFIX}.${accountId}.`;
  const keys = Object.keys(localStorage).filter((key) => key.startsWith(prefix));
  for (const key of keys) {
    let marker;
    try {
      marker = JSON.parse(localStorage.getItem(key) || 'null');
      if (!marker?.playlist?.id || !Array.isArray(marker.originalUris) || !Array.isArray(marker.targetUris)) {
        unresolvedOperation = { playlist: { name: 'Unknown playlist' } };
        continue;
      }
      const state = await playlistStateFor(marker);
      if (state === 'target') {
        localStorage.removeItem(key);
        showToast(`A previously interrupted Apply to “${marker.playlist.name}” completed successfully.`);
      } else if (state === 'original') {
        localStorage.removeItem(key);
        showToast(`A previously interrupted Apply to “${marker.playlist.name}” made no changes.`);
      } else {
        unresolvedOperation = marker;
      }
    } catch {
      unresolvedOperation = marker || { playlist: { name: 'Unknown playlist' } };
    }
  }
  if (unresolvedOperation) {
    setRecoveryBanner(
      `Inspect “${unresolvedOperation.playlist.name}” in Spotify. Its state does not match either the backup or the intended result. All further writes are blocked; reload after resolving it manually.`,
    );
  }
}

async function preparePlaylistApply(group) {
  const applyButton = $('#apply-playlist');
  const approvedItems = group.items.filter((item) => decisionFor(reviewDecisions, item.id) === 'approved');
  const scannedPlaylist = group.items[0]?.playlist;
  if (!scannedPlaylist || !approvedItems.length) return;

  applyButton.disabled = true;
  applyButton.textContent = 'Checking playlist…';
  setOperationControls(true);
  try {
    if (unresolvedOperation) throw new Error('Resolve the interrupted Apply shown above before making another change.');
    const profile = await spotify.profile();
    if (profile.id !== currentScan.inventory.profile.id) {
      throw new Error('The connected Spotify account changed after the scan. Disconnect, reconnect, and scan again.');
    }
    const freshPlaylist = await spotify.playlist(scannedPlaylist.id);
    if (freshPlaylist.id !== scannedPlaylist.id ||
        (scannedPlaylist.ownerId && freshPlaylist.owner?.id !== scannedPlaylist.ownerId)) {
      throw new Error('Spotify returned a different playlist identity. Apply was stopped.');
    }
    if (freshPlaylist.snapshot_id !== scannedPlaylist.snapshotId) {
      throw new Error('This playlist changed after the scan. Scan again before applying anything.');
    }
    const entries = await spotify.playlistItems(scannedPlaylist.id);
    const plan = buildPlaylistApplyPlan({
      playlist: { ...scannedPlaylist, snapshotId: freshPlaylist.snapshot_id },
      entries,
      approvedItems,
    });
    const backupKey = `canonicalizer.backup.${scannedPlaylist.id}.${freshPlaylist.snapshot_id}`;
    const backup = {
      ...plan,
      kind: 'spotify-canonicalizer-playlist-backup',
    };
    try {
      localStorage.setItem(backupKey, JSON.stringify(backup));
    } catch {
      throw new Error('A local backup could not be stored, so Apply was stopped before making changes.');
    }

    const backupName = `spotify-backup-${safeFilename(scannedPlaylist.name)}-${plan.createdAt.slice(0, 10)}.json`;
    downloadJson(backup, backupName);
    pendingApplyPlan = {
      ...plan,
      accountId: currentScan.inventory.profile.id,
      backupKey,
      backupName,
    };
    const ownership = scannedPlaylist.collaborative ? ' This is a collaborative playlist, so other collaborators will see the change.' : '';
    $('#apply-dialog-summary').textContent = `${plan.changes.length} approved replacement${plan.changes.length === 1 ? '' : 's'} will be applied to “${scannedPlaylist.name}” (ID …${scannedPlaylist.id.slice(-6)}).${ownership}`;
    $('#apply-backup-name').textContent = `${backupName} is stored in this browser; a file download was requested.`;
    $('#apply-dialog-error').classList.add('hidden');
    setDialogBusy(false);
    updateApplyProgress(50, 'Backup ready. Waiting for confirmation — Spotify has not been changed.');
    $('#confirm-apply-button').textContent = 'Confirm and apply to this playlist';
    $('#apply-dialog').showModal();
  } catch (error) {
    showToast(error.message);
  } finally {
    setOperationControls(false);
    applyButton.disabled = false;
    renderReview();
  }
}

async function confirmPlaylistApply() {
  if (!pendingApplyPlan || applyInProgress || unresolvedOperation) return;
  const button = $('#confirm-apply-button');
  setOperationControls(true);
  setDialogBusy(true);
  button.textContent = 'Applying…';
  updateApplyProgress(60, 'Rechecking the Spotify account and this playlist…');
  try {
    await withPlaylistLock(pendingApplyPlan.playlist.id, async () => {
      const profile = await spotify.profile();
      if (profile.id !== pendingApplyPlan.accountId) {
        throw new Error('The connected Spotify account no longer matches this review. Apply was stopped.');
      }
      const freshPlaylist = await spotify.playlist(pendingApplyPlan.playlist.id);
      if (freshPlaylist.id !== pendingApplyPlan.playlist.id ||
          (pendingApplyPlan.playlist.ownerId && freshPlaylist.owner?.id !== pendingApplyPlan.playlist.ownerId) ||
          freshPlaylist.snapshot_id !== pendingApplyPlan.playlist.snapshotId) {
        throw new Error('The playlist identity or contents changed after the backup was prepared. Apply was stopped; scan again.');
      }

      const claim = claimInflight(pendingApplyPlan);
      let writeError = null;
      try {
        updateApplyProgress(75, 'Safety checks passed. Sending one playlist update to Spotify…');
        await spotify.replacePlaylistItems(pendingApplyPlan.playlist.id, pendingApplyPlan.targetUris);
      } catch (error) {
        writeError = error;
      }

      let state = 'other';
      try {
        updateApplyProgress(90, 'Reading the playlist back from Spotify to verify the exact result…');
        state = await playlistStateFor(pendingApplyPlan);
      } catch {
        // An unreadable result is intentionally treated as ambiguous.
      }

      if (state === 'target') {
        localStorage.removeItem(claim.key);
        updateApplyProgress(100, 'Verified complete — the playlist exactly matches the approved result.');
        return;
      }
      if (state === 'original') {
        localStorage.removeItem(claim.key);
        throw new Error(writeError ? `${writeError.message} Spotify confirms the playlist was not changed.` : 'Spotify did not apply the requested changes.');
      }

      unresolvedOperation = claim.marker;
      updateApplyProgress(100, 'Verification required — inspect this playlist in Spotify. Further writes are blocked.');
      setRecoveryBanner(
        `The outcome for “${pendingApplyPlan.playlist.name}” could not be verified. Do not retry. Inspect it in Spotify; the downloaded backup contains the original order.`,
      );
      throw new Error('The write outcome is ambiguous. Further writes are blocked to prevent accidental overwrites.');
    });

    appliedPlaylists.add(pendingApplyPlan.playlist.id);
    $('#apply-dialog').close();
    showToast(`${pendingApplyPlan.changes.length} approved change${pendingApplyPlan.changes.length === 1 ? '' : 's'} applied. Rescan to verify.`);
    pendingApplyPlan = null;
    renderReview();
  } catch (error) {
    setApplyError(error.message);
    if (!unresolvedOperation) updateApplyProgress(0, 'Apply stopped. Review the error below; no automatic retry will occur.');
    button.textContent = unresolvedOperation ? 'Writes blocked — inspect Spotify' : 'Try apply again';
  } finally {
    setOperationControls(false);
    setDialogBusy(false);
    if (unresolvedOperation) $('#confirm-apply-button').disabled = true;
  }
}

function setDecision(itemId, nextState) {
  if (decisionFor(reviewDecisions, itemId) === nextState) reviewDecisions.delete(itemId);
  else reviewDecisions.set(itemId, nextState);
  persistReviewDecisions();
  renderReview();
}

function chooseCandidate(item, candidateId) {
  if (!currentScan || applyInProgress || scanInProgress || pendingApplyPlan) return;
  const matching = reviewItems.filter((other) =>
    other.crossAlbumRemaster && other.sourceTrack.id === item.sourceTrack.id &&
    other.candidateOptions?.some((candidate) => candidate.id === candidateId),
  );
  if (!matching.length) return;
  try {
    const updates = matching.map((other) => ({
      other,
      chosen: chooseRecommendationCandidate(other.proposalRef, candidateId),
    }));
    const nextChoices = new Map(reviewChoices);
    nextChoices.set(item.sourceTrack.id, candidateId);
    localStorage.setItem(choiceStorageKey(currentScan.inventory.profile.id), JSON.stringify(Object.fromEntries(nextChoices)));
    for (const { other, chosen } of updates) {
      reviewDecisions.delete(other.id);
      for (const candidate of other.candidateOptions) {
        reviewDecisions.delete(proposalId({ ...other, replacementTrack: candidate }));
      }
      Object.assign(other.proposalRef, chosen);
    }
    reviewChoices = nextChoices;
    persistReviewDecisions();
    reviewItems = flattenReviewItems(currentScan.analysis);
    renderReview();
  } catch (error) {
    showToast(error.message);
    reviewItems = flattenReviewItems(currentScan.analysis);
    renderReview();
  }
}

function decisionButton(label, kind, item) {
  const state = decisionFor(reviewDecisions, item.id);
  const selected = state === kind;
  const button = element('button', {
    type: 'button',
    className: `decision-button ${kind === 'approved' ? 'approve' : 'skip'}${selected ? ' selected' : ''}`,
    text: label,
  });
  button.setAttribute('aria-pressed', String(selected));
  if (kind === 'approved' && item.requiresCandidateChoice && !item.candidateChosen) {
    button.disabled = true;
    button.title = 'Choose a remaster above before approving.';
  }
  button.addEventListener('click', () => setDecision(item.id, kind));
  return button;
}

function reviewItemCard(item) {
  const state = decisionFor(reviewDecisions, item.id);
  const context = reviewMode === 'playlist'
    ? `Track ${item.position + 1} · ${item.familyArtist}`
    : `${item.playlist.name} · Track ${item.position + 1}`;
  const card = element('article', { className: `review-item ${state}` });
  const copy = element('div', { className: 'review-item-copy' }, [
    element('div', { className: 'review-context' }, [
      element('span', { text: context }),
      element('span', { className: 'confidence-dot', text: item.crossAlbumRemaster
        ? (item.requiresCandidateChoice && !item.candidateChosen ? 'Choice needed' : 'Remaster suggestion')
        : `${item.confidence}% match` }),
    ]),
    element('div', { className: 'track-change' }, [
      element('div', { className: 'track-version' }, [
        element('span', { text: 'CURRENT' }),
        spotifyTrackLink(item.sourceTrack),
        spotifyAlbumLink(item.sourceAlbum),
      ]),
      element('span', { className: 'change-arrow', text: '→' }),
      element('div', { className: 'track-version' }, [
        element('span', { text: item.requiresCandidateChoice && !item.candidateChosen ? 'CANDIDATE — CHOOSE BELOW' : 'PROPOSED' }),
        spotifyTrackLink(item.replacementTrack),
        spotifyAlbumLink(item.canonicalAlbum),
      ]),
    ]),
    ...(item.crossAlbumRemaster ? [element('small', { className: 'recommendation-evidence',
      text: `${item.explanation} Listen to both recordings before approving.`,
    })] : []),
  ]);
  if (item.crossAlbumRemaster && item.candidateOptions?.length > 1) {
    const picker = element('select', { className: 'candidate-select' });
    picker.setAttribute('aria-label', `Choose remaster for ${item.sourceTrack.name}`);
    if (item.requiresCandidateChoice && !item.candidateChosen) {
      const placeholder = element('option', { text: 'Choose a remaster to review…' });
      placeholder.value = '';
      picker.append(placeholder);
    }
    for (const candidate of item.candidateOptions) {
      const option = element('option', { text: `${candidate.name} — ${candidate.album.name}` });
      option.value = candidate.id;
      picker.append(option);
    }
    picker.value = item.requiresCandidateChoice && !item.candidateChosen ? '' : item.replacementTrack.id;
    picker.addEventListener('change', () => chooseCandidate(item, picker.value));
    copy.append(element('label', { className: 'candidate-label', text: 'Scanned remaster candidates' }), picker);
  }
  const actions = element('div', { className: 'decision-actions' }, [
    decisionButton('✓ Approve', 'approved', item),
    decisionButton('Skip', 'skipped', item),
  ]);
  card.append(reviewCover(item.sourceAlbum), copy, actions);
  return card;
}

function currentGroups() {
  return groupReviewItems(reviewItems, reviewMode);
}

function nextPendingGroupIndex(groups, currentIndex) {
  for (let offset = 1; offset < groups.length; offset += 1) {
    const index = (currentIndex + offset) % groups.length;
    if (decisionCounts(groups[index].items, reviewDecisions).pending > 0) return index;
  }
  return -1;
}

function renderQueue(groups, activeIndex) {
  const nodes = groups.map((group, index) => {
    const counts = decisionCounts(group.items, reviewDecisions);
    const button = element('button', {
      type: 'button',
      className: `queue-item${index === activeIndex ? ' active' : ''}${counts.pending === 0 ? ' complete' : ''}`,
    }, [
      element('span', { className: 'queue-copy' }, [
        element('strong', { text: group.label, title: group.label }),
        element('small', { text: `${group.caption} · ${group.items.length} proposal${group.items.length === 1 ? '' : 's'}` }),
      ]),
      element('span', { className: 'queue-count', text: counts.pending === 0 ? '✓' : String(counts.pending) }),
    ]);
    button.addEventListener('click', () => {
      reviewGroupIndices[reviewMode] = index;
      renderReview();
    });
    return button;
  });
  playlistList.replaceChildren(...nodes);
  playlistList.querySelector('.queue-item.active')?.scrollIntoView({ block: 'nearest' });
}

function renderReview() {
  const groups = currentGroups();
  if (!groups.length) return;
  const index = Math.min(reviewGroupIndices[reviewMode], groups.length - 1);
  reviewGroupIndices[reviewMode] = index;
  const group = groups[index];
  const globalCounts = decisionCounts(reviewItems, reviewDecisions);
  const groupCounts = decisionCounts(group.items, reviewDecisions);
  const groupName = reviewMode === 'playlist' ? 'playlist' : 'album';

  document.querySelectorAll('#view-mode-toggle button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === reviewMode);
  });
  document.querySelectorAll('#status-filters button').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === reviewFilter);
  });

  $('#playlist-progress-label').textContent = `${globalCounts.decided} of ${globalCounts.total} decided`;
  $('#review-progress-bar').style.width = `${globalCounts.total ? (globalCounts.decided / globalCounts.total) * 100 : 0}%`;
  const appliedSummary = appliedPlaylists.size
    ? `${appliedPlaylists.size} playlist${appliedPlaylists.size === 1 ? '' : 's'} changed; rescan to verify those results.`
    : 'Nothing has been changed on Spotify.';
  $('#result-summary').textContent = `${globalCounts.pending} pending · ${globalCounts.approved} approved · ${globalCounts.skipped} skipped. ${appliedSummary}`;
  $('#review-kicker').textContent = reviewMode === 'playlist' ? 'CURRENT PLAYLIST' : 'CURRENT ALBUM FAMILY';
  $('#current-playlist-name').textContent = group.label;
  $('#current-playlist-name').title = group.label;
  const spotifyLink = $('#current-group-spotify-link');
  const groupUrl = spotifyExternalUrl(group.externalUrl);
  spotifyLink.classList.toggle('hidden', !groupUrl);
  if (groupUrl) spotifyLink.href = groupUrl;
  else spotifyLink.removeAttribute('href');
  $('#current-playlist-summary').textContent = `${group.items.length} proposed replacement${group.items.length === 1 ? '' : 's'} · ${group.caption}`;
  const groupReviewPercent = groupCounts.total ? Math.round((groupCounts.decided / groupCounts.total) * 100) : 0;
  const groupProgress = $('#current-playlist-progress-bar').parentElement;
  $('#current-playlist-progress-bar').style.width = `${groupReviewPercent}%`;
  groupProgress.setAttribute('aria-valuenow', String(groupReviewPercent));
  groupProgress.setAttribute('aria-label', `Current ${groupName} review progress`);
  $('#current-playlist-progress-label').textContent = `${groupCounts.decided} of ${groupCounts.total} reviewed · ${groupCounts.approved} approved and staged only`;
  $('#decision-counts').replaceChildren(
    stat('PENDING', groupCounts.pending),
    stat('APPROVED', groupCounts.approved, 'approved'),
    stat('SKIPPED', groupCounts.skipped),
  );

  renderQueue(groups, index);
  const visibleItems = group.items.filter((item) =>
    reviewFilter === 'all' || decisionFor(reviewDecisions, item.id) === reviewFilter,
  );
  proposalReviewList.replaceChildren(...visibleItems.map(reviewItemCard));
  $('#filter-empty').classList.toggle('hidden', visibleItems.length !== 0);

  const previousButton = $('#previous-playlist');
  previousButton.textContent = `← Previous ${groupName}`;
  previousButton.disabled = index === 0;
  previousButton.onclick = () => {
    reviewGroupIndices[reviewMode] = Math.max(0, index - 1);
    renderReview();
  };

  const nextIndex = nextPendingGroupIndex(groups, index);
  const nextButton = $('#next-playlist');
  nextButton.replaceChildren(document.createTextNode(`Next pending ${groupName} `), element('span', { text: '→' }));
  nextButton.disabled = nextIndex < 0;
  nextButton.onclick = () => {
    if (nextIndex < 0) return;
    reviewGroupIndices[reviewMode] = nextIndex;
    renderReview();
  };

  const applyButton = $('#apply-playlist');
  applyButton.classList.toggle('hidden', reviewMode !== 'playlist');
  if (reviewMode === 'playlist') {
    const alreadyApplied = appliedPlaylists.has(group.key);
    if (alreadyApplied) {
      applyButton.textContent = 'Applied ✓ — rescan to verify';
      applyButton.disabled = true;
      applyButton.onclick = null;
    } else if (unresolvedOperation) {
      applyButton.textContent = 'Writes blocked — inspect Spotify';
      applyButton.disabled = true;
      applyButton.onclick = null;
    } else if (!hasWriteAccess()) {
      applyButton.textContent = 'Reconnect to enable writes';
      applyButton.disabled = false;
      applyButton.onclick = () => beginAuthorization(savedClientId()).catch((error) => showToast(error.message));
    } else {
      applyButton.textContent = groupCounts.approved
        ? `Review & confirm ${groupCounts.approved} approved change${groupCounts.approved === 1 ? '' : 's'}`
        : 'Approve tracks to continue';
      applyButton.disabled = groupCounts.approved === 0;
      applyButton.onclick = () => preparePlaylistApply(group);
    }
  }
}

function renderResults(inventory, analysis) {
  $('#metric-playlists').textContent = formatNumber(inventory.playlists.length);
  $('#metric-tracks').textContent = formatNumber(inventory.placements.length);
  $('#metric-albums').textContent = formatNumber(analysis.albumCount);
  $('#metric-proposals').textContent = formatNumber(analysis.proposalCount);

  reviewChoices = loadReviewChoices(inventory.profile.id);
  restoreRecommendationChoices(analysis, reviewChoices);
  reviewItems = flattenReviewItems(analysis);
  reviewDecisions = loadReviewDecisions(inventory.profile.id, reviewItems);
  reviewMode = 'playlist';
  reviewFilter = 'all';
  reviewGroupIndices = { playlist: 0, album: 0 };
  pendingApplyPlan = null;
  appliedPlaylists = new Set();

  emptyState.classList.toggle('hidden', reviewItems.length !== 0);
  reviewWorkspace.classList.toggle('hidden', reviewItems.length === 0);
  if (reviewItems.length) renderReview();
  else $('#result-summary').textContent = 'No matching replacement tracks were found in the selected playlists.';
  statusPanel.classList.add('hidden');
  resultsView.classList.remove('hidden');
}

function exportableScan(scan) {
  const counts = decisionCounts(reviewItems, reviewDecisions);
  return {
    schemaVersion: 2,
    createdAt: scan.createdAt,
    writeCapability: 'review-gated-single-playlist-replacement',
    appliedPlaylistIds: [...appliedPlaylists],
    account: { id: scan.inventory.profile.id, displayName: scan.inventory.profile.display_name },
    playlists: scan.inventory.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      ownerId: playlist.owner?.id,
      collaborative: Boolean(playlist.collaborative),
      snapshotId: playlist.snapshot_id,
    })),
    failures: scan.inventory.failures,
    summary: {
      playlistCount: scan.inventory.playlists.length,
      trackPlacementCount: scan.inventory.placements.length,
      albumCount: scan.analysis.albumCount,
      familyCount: scan.analysis.families.length,
      proposalCount: scan.analysis.proposalCount,
      review: counts,
    },
    albumFamilies: scan.analysis.families.map((family) => ({
      key: family.key,
      artist: family.artist,
      confidence: family.confidence,
      canonicalAlbum: { id: family.canonical.album.id, name: family.canonical.album.name },
      alternatives: family.alternatives.map((candidate) => ({ id: candidate.album.id, name: candidate.album.name })),
      reasons: family.reasons,
      proposals: family.proposals.map((proposal) => ({
        id: proposalId(proposal),
        crossAlbumRemaster: proposal.crossAlbumRemaster === true,
        explanation: proposal.explanation || null,
        candidateChosen: proposal.candidateChosen === true,
        candidateCount: proposal.candidateCount || 0,
        candidateOptions: proposal.candidateOptions?.map((track) => ({
          id: track.id, name: track.name, albumId: track.album?.id, albumName: track.album?.name,
        })) || [],
        decision: decisionFor(reviewDecisions, proposalId(proposal)),
        playlistId: proposal.playlist.id,
        playlistName: proposal.playlist.name,
        position: proposal.position,
        sourceTrack: { id: proposal.sourceTrack.id, name: proposal.sourceTrack.name, albumId: proposal.sourceAlbum.id },
        replacementTrack: { id: proposal.replacementTrack.id, name: proposal.replacementTrack.name, albumId: proposal.canonicalAlbum.id },
      })),
    })),
  };
}

function playlistPickerLabel(playlist) {
  const owner = playlist.owner?.display_name || playlist.owner?.id || 'Unknown owner';
  const itemCount = playlistItemCount(playlist);
  const itemLabel = itemCount !== null
    ? `${formatNumber(itemCount)} items`
    : 'item count unavailable';
  return `${playlist.name || 'Untitled playlist'} · ${playlist.collaborative ? 'Collaborative' : `Owned by ${owner}`} · ${itemLabel}`;
}

function selectedPlaylistIds() {
  return [...playlistPickerList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function updatePlaylistPickerControls() {
  const count = selectedPlaylistIds().length;
  startSelectedScanButton.disabled = count === 0;
  startSelectedScanButton.textContent = count === 1 ? 'Scan 1 selected playlist' : `Scan ${count} selected playlists`;
  playlistPickerSummary.textContent = count
    ? `${count} playlist${count === 1 ? '' : 's'} selected. Only these playlists’ items will be read.`
    : 'Choose at least one playlist. Playlist items are not read until you continue.';
}

function renderPlaylistPicker(source) {
  const previouslyScannedIds = new Set(currentScan?.inventory?.playlists?.map((playlist) => playlist.id) || []);
  const playlists = [...source.playlists].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
  );
  const nodes = playlists.map((playlist) => {
    const input = element('input', { type: 'checkbox' });
    input.value = playlist.id;
    input.checked = previouslyScannedIds.has(playlist.id);
    input.addEventListener('change', updatePlaylistPickerControls);
    return element('label', { className: 'playlist-picker-option' }, [
      input,
      element('span', { text: playlistPickerLabel(playlist), title: playlistPickerLabel(playlist) }),
    ]);
  });
  playlistPickerList.replaceChildren(...nodes);
  playlistPickerError.classList.add('hidden');
  updatePlaylistPickerControls();
}

function liveResponseDiagnostic(error) {
  const diagnostic = error?.diagnostic;
  if (!diagnostic?.request || diagnostic.status !== 429 || !diagnostic.reason || !diagnostic.receivedAt) return '';
  return `Live Spotify response: ${diagnostic.request} → HTTP ${diagnostic.status} → ${diagnostic.reason} · ${diagnostic.receivedAt}. No token or response payload was stored.`;
}

async function handleScanFailure(error) {
  if (error.code === 'QUOTA_EXCEEDED') {
    sessionStorage.removeItem(RATE_LIMIT_UNTIL_KEY);
    $('#status-title').textContent = 'Spotify development quota exhausted';
    $('#status-detail').textContent = liveResponseDiagnostic(error) ||
      'Spotify’s Development Mode quota is unavailable. Spotify does not publish the reset time, so repeated retries will not help. Try again later.';
    $('#progress-bar').style.width = '100%';
    statusPanel.classList.remove('hidden');
    showToast('Spotify Development Mode quota exhausted. Repeated retries will not help.');
    return 0;
  }
  if (error.status === 429) {
    const waitSeconds = Math.max(1, Math.ceil(error.retryAfter || 1));
    $('#status-title').textContent = 'Spotify paused the scan';
    $('#status-detail').textContent = liveResponseDiagnostic(error) ||
      `Spotify asked the app to wait ${waitSeconds} second${waitSeconds === 1 ? '' : 's'}. No more requests were sent. Wait, then select playlists again.`;
    $('#progress-bar').style.width = '100%';
    statusPanel.classList.remove('hidden');
    showToast(`Spotify rate limit reached. Wait ${waitSeconds} seconds before scanning again.`);
    return waitSeconds;
  }
  if (error.status === 401) {
    disconnect();
    await clearStoredSpotifyData().catch(() => {});
    currentScan = null;
    reviewItems = [];
    reviewDecisions = new Map();
    resultsView.classList.add('hidden');
    setAuthenticated(false);
    statusPanel.classList.add('hidden');
    showToast('Your Spotify authorization is no longer valid. Local account data was cleared; reconnect to continue.');
    return 0;
  }
  statusPanel.classList.add('hidden');
  showToast(error.message);
  return 0;
}

async function openPlaylistPicker() {
  if (applyInProgress || scanInProgress || playlistPickerLoading || rateLimitActive() || playlistPickerOpen) {
    if (rateLimitActive()) startRateLimitCountdown(Math.ceil((storedRateLimitUntil() - Date.now()) / 1000));
    return;
  }
  playlistPickerLoading = true;
  setBusy(true);
  updateProgress({ detail: 'Loading playlist names only…', percent: 2 });
  try {
    const source = await spotify.scanCandidates(updateProgress);
    if (!source.playlists.length) throw new Error('No playlists you own or collaborate on are available to scan.');
    pendingScanSource = source;
    renderPlaylistPicker(source);
    playlistPickerOpen = true;
    setBusy(false);
    statusPanel.classList.add('hidden');
    playlistPickerDialog.showModal();
  } catch (error) {
    const cooldownSeconds = await handleScanFailure(error);
    if (cooldownSeconds) startRateLimitCountdown(cooldownSeconds);
  } finally {
    playlistPickerLoading = false;
    if (!playlistPickerOpen) setBusy(false);
  }
}

async function scanSelectedPlaylists() {
  if (!pendingScanSource || applyInProgress || scanInProgress) return;
  const source = pendingScanSource;
  const playlistIds = selectedPlaylistIds();
  if (!playlistIds.length) {
    playlistPickerError.textContent = 'Choose at least one playlist before scanning.';
    playlistPickerError.classList.remove('hidden');
    return;
  }
  scanInProgress = true;
  playlistPickerDialog.close();
  let cooldownSeconds = 0;
  setBusy(true);
  updateProgress({ detail: `Starting a read-only scan of ${playlistIds.length} selected playlist${playlistIds.length === 1 ? '' : 's'}…`, percent: 8 });
  try {
    const inventory = await spotify.inventoryOwnedPlaylists(updateProgress, source, playlistIds);
    const analysis = analyzeInventory(inventory.placements);
    currentScan = { inventory, analysis, createdAt: new Date().toISOString() };
    $('#display-name').textContent = inventory.profile.display_name || inventory.profile.id || 'listener';
    renderResults(inventory, analysis);
    if (inventory.failures.length) {
      showToast(`${inventory.failures.length} playlist${inventory.failures.length === 1 ? '' : 's'} could not be read; see the export for details.`);
    } else if (inventory.resumedPlaylists) {
      showToast(`Scan complete. ${inventory.resumedPlaylists} unchanged playlist${inventory.resumedPlaylists === 1 ? '' : 's'} resumed from saved progress.`);
    } else {
      showToast('Read-only scan complete. Nothing was changed.');
    }
  } catch (error) {
    cooldownSeconds = await handleScanFailure(error);
  } finally {
    pendingScanSource = null;
    scanInProgress = false;
    setBusy(false);
    if (cooldownSeconds) startRateLimitCountdown(cooldownSeconds);
  }
}

connectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = connectForm.querySelector('button');
  button.disabled = true;
  try {
    // A new authorization may select a different Spotify account. Remove data
    // associated with any previous account before leaving for Spotify.
    disconnect();
    await clearStoredSpotifyData();
    await beginAuthorization(clientIdInput.value);
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

clientIdInput.addEventListener('input', () => {
  const valid = isValidClientId(clientIdInput.value);
  inputStatus.textContent = valid ? '✓' : '○';
  inputStatus.classList.toggle('valid', valid);
  $('#client-id-help').textContent = valid
    ? 'Client ID recognized. It will be sent only to Spotify when you connect.'
    : 'Paste only the Client ID value—not the Client Secret.';
});

async function clearStoredSpotifyData() {
  const prefixes = [REVIEW_STORAGE_PREFIX, CHOICE_STORAGE_PREFIX, INFLIGHT_STORAGE_PREFIX, 'canonicalizer.backup.'];
  for (const key of Object.keys(localStorage)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key);
  }
  sessionStorage.removeItem(RATE_LIMIT_UNTIL_KEY);
  await scanCache.clearAll();
}

disconnectButton.addEventListener('click', async () => {
  disconnectButton.disabled = true;
  disconnect();
  let cleared = true;
  try {
    await clearStoredSpotifyData();
  } catch {
    cleared = false;
  }
  currentScan = null;
  reviewItems = [];
  reviewDecisions = new Map();
  reviewChoices = new Map();
  pendingApplyPlan = null;
  appliedPlaylists = new Set();
  resultsView.classList.add('hidden');
  setAuthenticated(false);
  disconnectButton.disabled = false;
  showToast(cleared
    ? 'Account disconnected and locally stored Spotify data deleted.'
    : 'Account disconnected, but some local data could not be deleted. Clear this site’s browser data.');
});

document.querySelectorAll('#view-mode-toggle button').forEach((button) => {
  button.addEventListener('click', () => {
    reviewMode = button.dataset.mode;
    reviewFilter = 'all';
    renderReview();
  });
});

document.querySelectorAll('#status-filters button').forEach((button) => {
  button.addEventListener('click', () => {
    reviewFilter = button.dataset.filter;
    renderReview();
  });
});

scanButton.addEventListener('click', openPlaylistPicker);
rescanButton.addEventListener('click', openPlaylistPicker);
startSelectedScanButton.addEventListener('click', scanSelectedPlaylists);
playlistPickerDialog.addEventListener('close', () => {
  playlistPickerOpen = false;
  pendingScanSource = null;
  if (!scanInProgress) setBusy(false);
});
$('#confirm-apply-button').addEventListener('click', confirmPlaylistApply);
$('#apply-dialog').addEventListener('close', () => {
  if (!applyInProgress) pendingApplyPlan = null;
});
exportButton.addEventListener('click', () => {
  if (!currentScan) return;
  downloadJson(exportableScan(currentScan), `canonicalizer-scan-${currentScan.createdAt.slice(0, 10)}.json`);
  showToast('Scan and approval decisions exported as JSON.');
});

async function initialize() {
  if (window.top !== window.self) {
    document.body.replaceChildren(document.createTextNode('Open Canonicalizer directly in a browser tab to use it.'));
    return;
  }

  updateInstallButton();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }

  if (location.protocol === 'file:') {
    $('#file-warning').classList.remove('hidden');
    document.title = 'Open Canonicalizer';
    return;
  }

  $('#redirect-uri').textContent = redirectUri();
  clientIdInput.value = savedClientId();
  clientIdInput.dispatchEvent(new Event('input'));

  try {
    await finishAuthorization();
  } catch (error) {
    showToast(error.message);
  }
  setAuthenticated(hasSession());

  if (hasSession()) {
    try {
      const profile = await spotify.profile();
      $('#display-name').textContent = profile.display_name || profile.id || 'listener';
      await reconcileInterruptedOperations(profile.id);
      if (rateLimitActive()) startRateLimitCountdown(Math.ceil((storedRateLimitUntil() - Date.now()) / 1000));
    } catch (error) {
      const cooldownSeconds = await handleScanFailure(error);
      if (cooldownSeconds) startRateLimitCountdown(cooldownSeconds);
    }
  }
}

window.addEventListener('beforeunload', (event) => {
  if (!applyInProgress) return;
  event.preventDefault();
  event.returnValue = '';
});

initialize();
