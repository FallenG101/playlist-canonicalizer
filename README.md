# Canonicalizer

A browser-based playlist canonicalizer for Spotify. You choose which playlists you own or collaborate on to inventory; it then groups likely alternate album releases, scores a proposed canonical edition, and applies only the replacements you individually approve.

This is an independent project and is not affiliated with, endorsed by, or sponsored by Spotify. Spotify is a trademark of Spotify AB.

> **Distribution status:** reasonable to publish as source, with residual policy uncertainty. Spotify Dedup provides a long-running, open-source precedent for user-reviewed playlist cleanup based on track ID, title, artist, and duration similarity. Spotify's current Developer Policy still uses broad language about analyzing Spotify Content, so publication is not a certification or a substitute for Spotify's review. See [SPOTIFY_COMPLIANCE.md](SPOTIFY_COMPLIANCE.md).

## Safety boundary

- OAuth requests `playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-private`, and `playlist-modify-public`.
- Writes are available only from the **By playlist** review view and only for individually approved tracks. There is no account-wide apply action.
- Before Apply is enabled, the app verifies the account, playlist identity, snapshot, and exact source-track positions; stores a backup in the browser; and requests a JSON backup download.
- Apply is blocked for playlists containing local or unavailable items because Spotify cannot safely reconstruct those entries through the Web API.
- Apply is blocked for playlists over 100 items. A permitted Apply uses one replace request rather than a partially complete multi-request rewrite.
- Mutation requests are never retried automatically. After any response or network failure, the app rereads the playlist and accepts success only when the exact intended URI sequence is present.
- An in-flight marker survives reloads. If the app cannot prove that an interrupted operation produced either the original or intended playlist, it blocks all further writes and asks for manual inspection.
- Completed playlist scans are cached in browser IndexedDB by account, playlist ID, and Spotify snapshot. Records older than 24 hours are not reused and are removed when next accessed or when you disconnect. A retry skips unchanged playlists and resumes from the first unfinished or changed playlist.
- Backups are recovery records, not an automatic restore feature. The app never overwrites a playlist during error recovery.
- Tokens live in browser `sessionStorage` and are removed by the app when you disconnect. Browser session restore may preserve them after a restart.
- The Spotify Client ID is the only persisted setting; it is public app metadata, not a secret.
- Scan results remain in memory unless you explicitly export them as JSON.
- Disconnect deletes locally stored Spotify account data, review decisions, backups, interrupted-operation records, and scan cache. Files you downloaded remain under your control.

Read [PRIVACY.md](PRIVACY.md) before connecting an account.

## Run it

The hosted PWA is available at [https://falleng101.github.io/playlist-canonicalizer/](https://falleng101.github.io/playlist-canonicalizer/). No local command or server is needed. Add that **exact** URL, including the trailing slash, to your app's Redirect URIs in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) before connecting. Keep the existing loopback redirect URI if you also want to run the local version. The hosted origin has separate browser storage, so you will need to enter your Client ID again; do not enter a Client Secret.

The GitHub Pages site is publicly accessible, but only Spotify accounts permitted by your Spotify app's current quota mode can successfully use its API access. GitHub Pages serves the static app and can see the short-lived OAuth callback URL; Spotify tokens and playlist data stay in your browser and are sent directly to Spotify. Hosting does not increase Spotify API quotas or constitute Spotify policy approval. See [PRIVACY.md](PRIVACY.md) and [SPOTIFY_COMPLIANCE.md](SPOTIFY_COMPLIANCE.md).

To run the local version instead:

On macOS, double-click `start.command`, or run:

```sh
./start.command
```

The launcher uses Node.js 20 or newer from the normal path, falling back to Codex's bundled runtime when available. You can also use:

```sh
npm start
```

Then open [http://127.0.0.1:4387](http://127.0.0.1:4387).

## Install as an app

Canonicalizer is an installable Progressive Web App. On desktop, open it in a supported browser and select **Install app** (or use the browser's install menu). On iPhone or iPad, open the hosted HTTPS version in Safari, tap **Share**, then **Add to Home Screen**. On Android, use the browser menu's **Install app** or **Add to Home screen** action.

The local `127.0.0.1` version can only be installed on the computer running it. To use the app on phones or other computers, deploy the `public/` folder to an HTTPS static host. The Spotify redirect URI is derived from the app's full base address (including a hosting subpath), so register that exact HTTPS URL in the Spotify Developer Dashboard. The host receives the short-lived OAuth authorization code in the callback URL, so use a trusted host with appropriate access-log handling. Spotify API calls remain online-only; the service worker caches only the generic app shell and never caches Spotify responses, login callbacks, tokens, or scan data.

The service worker checks the network before using its cached app shell. Bump `CACHE_NAME` in `public/sw.js` when changing the cache format or file list.

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

1. Create an app.
2. Add `http://127.0.0.1:4387/` to its Redirect URIs (including the trailing slash).
3. Copy the app's Client ID into the Canonicalizer. A client secret is not used.

Spotify Development Mode may require adding the Spotify account being tested to the app's user allowlist.

## Matching behavior in this MVP

The scanner first lists accessible playlists where the current account is the owner or a collaborator. It reads items only after you select one or more of those playlists. It ignores followed playlists, local files, and non-track items for matching. Episodes are preserved unchanged when a playlist is eligible for Apply; unavailable or unsupported items block Apply.

Album families use the primary artist plus a normalized album title. Edition suffixes such as “Taylor's Version,” “Deluxe,” “Expanded,” “Forever,” “Anniversary,” and “Remastered” are removed only for family grouping. The canonical scorer then considers:

- Taylor's Version
- expanded/deluxe/complete/Forever editions
- explicit-track ratio
- track count
- a title-specific preferred release year (the initial rule supports the 2025 *The Great American Bar Scene*)
- manual album-ID overrides (supported by the engine; a settings UI is planned)

A track proposal requires a matching normalized track title and artist on the chosen canonical album. Duration proximity and explicit preference break ties. A separate cross-album recommender compares explicitly labeled remasters by any artist among the selected playlists, even when album titles differ. It requires the same Spotify artist IDs, a song title that differs only by a remaster label, and durations within three seconds. Distinct live, mono, and other labeled variants remain separate. Among candidates with labeled remaster years, it suggests the newest; an older remaster can be upgraded to a newer one. A compilation's album release date is **not** treated as a mastering date. If equally dated candidates cannot be distinguished, you must choose one manually before approval is enabled. Choices are remembered locally for the same source track and Spotify account when the candidate remains in a later scan, but they never count as approval. Disconnect clears these choices.

These are recommendations, not proof that two recordings use the same master. Remaster labels can be missing or misleading, and Spotify metadata does not provide a definitive mastering date. Listen before approving. Manual album overrides and Taylor's Version proposals take precedence, and an explicit track is not replaced by a clean remaster. The app does not search Spotify's catalog, so it cannot find a remaster absent from the selected playlists.

The review queue can be switched between two views without losing decisions:

- **By playlist** walks through proposed replacements in playlist order.
- **By album** groups the same proposals by canonical album family across playlists.

Every proposal starts pending and must be individually approved or skipped. There is intentionally no global “replace all” action. Approval decisions are stored locally, shared between both views, and included in the JSON export. A manual candidate choice does not approve a proposal; changing a choice resets existing approval for that position. Proposal IDs include the playlist snapshot ID, so decisions do not carry over after that playlist changes.

Apply operates one playlist at a time and is limited to 100 total items. Spotify's endpoint replaces the playlist's entire item list in one request. The app sends the original URI sequence with only approved positions changed, preserving order and duplicates, but Spotify may update per-item added dates or attribution even for untouched entries. The app then asks you to rescan for verification. If the account, playlist identity, or snapshot changes between scan, backup, and final confirmation, the operation stops before writing. Do not edit the same playlist elsewhere while Apply is running: Spotify's replace endpoint does not offer an atomic snapshot precondition, so an external edit in the final check-to-write interval cannot be prevented, only detected afterward.

Confidence scores are review aids, not guarantees.

## Verify

```sh
npm test
npm run check
```

## Architecture

- `public/js/auth.js`: PKCE authorization and session-only token refresh.
- `public/js/spotify.js`: Spotify ingestion, pagination, and playlist replacement requests.
- `public/js/canonicalizer.js`: pure family detection, preference scoring, confidence, and proposal generation.
- `public/js/review.js`: shared approval state grouped by playlist or album.
- `public/js/scan-cache.js`: snapshot-keyed, credential-free IndexedDB storage for resumable scans.
- `public/js/apply.js`: pure, validated, order-preserving apply-plan construction.
- `public/js/app.js`: UI state, rendering, backups, confirmation, JSON export, Apply orchestration, and interrupted-operation reconciliation.
- `public/manifest.webmanifest`, `public/sw.js`: install metadata and a narrowly scoped offline shell cache.

Use a small test playlist first, inspect the downloaded backup, avoid simultaneous edits in Spotify, and rescan immediately after applying.
