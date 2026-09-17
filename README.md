# Canonicalizer

A local playlist canonicalizer for Spotify. It inventories tracks across playlists you own or collaborate on, groups likely alternate album releases, scores a proposed canonical edition, and applies only the replacements you individually approve.

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
- Completed playlist scans are cached in browser IndexedDB by account, playlist ID, and Spotify snapshot for no more than 24 hours. A retry skips unchanged playlists and resumes from the first unfinished or changed playlist.
- Backups are recovery records, not an automatic restore feature. The app never overwrites a playlist during error recovery.
- Tokens live in browser `sessionStorage` and disappear when the browser session ends or you disconnect.
- The Spotify Client ID is the only persisted setting; it is public app metadata, not a secret.
- Scan results remain in memory unless you explicitly export them as JSON.
- Disconnect deletes locally stored Spotify account data, review decisions, backups, interrupted-operation records, and scan cache. Files you downloaded remain under your control.

Read [PRIVACY.md](PRIVACY.md) before connecting an account.

## Run it

On this Mac, double-click `start.command`, or run:

```sh
./start.command
```

The launcher uses Node.js 20 or newer from the normal path, falling back to Codex's bundled runtime when available. You can also use:

```sh
npm start
```

Then open [http://127.0.0.1:4387](http://127.0.0.1:4387).

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

1. Create an app.
2. Add `http://127.0.0.1:4387/` to its Redirect URIs (including the trailing slash).
3. Copy the app's Client ID into the Canonicalizer. A client secret is not used.

Spotify Development Mode may require adding the Spotify account being tested to the app's user allowlist.

## Matching behavior in this MVP

The scanner reads every accessible playlist item from playlists where the current account is the owner or a collaborator. It ignores followed playlists, local files, and non-track items for matching. Episodes are preserved unchanged when a playlist is eligible for Apply; unavailable or unsupported items block Apply.

Album families use the primary artist plus a normalized album title. Edition suffixes such as “Taylor's Version,” “Deluxe,” “Expanded,” “Forever,” “Anniversary,” and “Remastered” are removed only for family grouping. The canonical scorer then considers:

- Taylor's Version
- expanded/deluxe/complete/Forever editions
- explicit-track ratio
- track count
- a title-specific preferred release year (the initial rule supports the 2025 *The Great American Bar Scene*)
- manual album-ID overrides (supported by the engine; a settings UI is planned)

A track proposal requires a matching normalized track title and artist on the chosen canonical album. Duration proximity and explicit preference break ties. The MVP can only propose a canonical track that appears somewhere in the scanned playlists; catalog-wide edition discovery is a later enhancement.

The review queue can be switched between two views without losing decisions:

- **By playlist** walks through proposed replacements in playlist order.
- **By album** groups the same proposals by canonical album family across playlists.

Every proposal starts pending and must be individually approved or skipped. There is intentionally no global “replace all” action. Approval decisions are stored locally, shared between both views, and included in the JSON export. Proposal IDs include the playlist snapshot ID, so decisions do not carry over after that playlist changes.

Apply operates one playlist at a time and is limited to 100 total items. It preserves the playlist's item order—including duplicates and episodes—replaces only approved positions, and then asks you to rescan for verification. If the account, playlist identity, or snapshot changes between scan, backup, and final confirmation, the operation stops before writing. Do not edit the same playlist elsewhere while Apply is running: Spotify's replace endpoint does not offer an atomic snapshot precondition, so an external edit in the final check-to-write interval cannot be prevented, only detected afterward.

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

Use a small test playlist first, inspect the downloaded backup, avoid simultaneous edits in Spotify, and rescan immediately after applying.
