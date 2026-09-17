# Canonicalizer Production-Readiness Audit

Date: 2026-09-17

## Outcome

The application received a full source review, targeted safety fixes, automated regression tests, static syntax checks, server negative tests, and a browser smoke test. All 34 automated tests pass. Every JavaScript file passes `node --check`. The local server serves the current application successfully with restrictive security headers, and the browser console is clean.

The app has one Spotify mutation capability: replacing the items of one explicitly selected playlist with one `PUT /v1/playlists/{id}/items` request. No code exists for deleting playlists, changing follows, modifying the library, controlling playback, changing profiles, uploading playlist images, or reordering playlists.

The app is fail-safe for known stale-state, retry, duplicate-click, interrupted-operation, and malformed-payload cases. One Spotify API limitation remains: the replace operation has no atomic snapshot precondition. An external edit made after the final snapshot check but before Spotify processes the `PUT` can be overwritten. Users must not edit the same playlist elsewhere while Apply is running.

## Bugs and safety issues found and fixed

- Replaced the earlier multi-request playlist rewrite. Apply is now blocked above 100 total items and uses one replace request, preventing a failed second chunk from leaving a partial playlist.
- Removed automatic restore-after-failure behavior. A timed-out request may already have succeeded; automatically restoring in that state could overwrite correct or external changes.
- Added authoritative post-write verification. Success is shown only when the complete URI sequence exactly equals the intended target.
- Added a persistent in-flight operation marker. After a crash, reload, or ambiguous network failure, the app compares Spotify with both the original and target sequence. Any third state blocks all further writes.
- Prevented mutation retries. Rate-limited reads may retry up to three times while respecting `Retry-After`; writes are never automatically retried.
- A rate limit, authorization failure, server failure, timeout, or network loss now stops the complete inventory scan instead of cascading requests through the remaining playlists.
- Completed playlists are cached without credentials against their Spotify snapshot so interrupted scans resume without rereading unchanged playlists.
- Added 30-second API timeouts and explicit ambiguous-write classification.
- Added account, playlist ID, owner, snapshot, source-position, source-track ID, replacement-track ID, and replacement-URI validation immediately before writing.
- Blocked mixed-playlist and mixed-snapshot approvals.
- Blocked empty replacement payloads at the API boundary, eliminating an accidental playlist-clear path.
- Blocked malformed playlist IDs, non-track/non-episode URIs, and replacement IDs that disagree with their URIs.
- Blocked no-op replacements and duplicate approved positions.
- Added same-origin cross-tab write locking. Apply refuses to run if the browser cannot provide a reliable Web Locks API.
- Disabled scan, rescan, disconnect, review interaction, and dialog dismissal at the relevant operation stages to prevent conflicting requests or double submission.
- Added playlist identity and snapshot rechecks at preparation and again at final confirmation.
- Preserved exact order, duplicate tracks, and episodes; local, unavailable, or unsupported entries block Apply instead of being guessed or dropped.
- Fixed pagination cycle handling and imposed a defensive page ceiling.
- Restricted every bearer-authenticated request—including server-provided pagination links—to `https://api.spotify.com/v1/`. This prevents token leakage through a malformed external `next` link.
- Fixed token refresh concurrency so simultaneous requests share one refresh.
- Fixed logout-during-refresh so an old response cannot recreate a disconnected session.
- Preserved granted scopes when Spotify omits `scope` from a refresh response.
- Revoked/invalid refresh grants now clear the session.
- OAuth verifier/state values are cleared after success, denial, invalid state, or disconnect. Reconnect uses `show_dialog=true` so account switching is explicit.
- Tightened track matching: a same-title/artist candidate is rejected when durations differ by more than nine seconds; when duration is unavailable, an exact ISRC match is required.
- Corrected stale UI/export claims that described the write-enabled app as read-only, and made post-Apply state visible until rescan.
- Made Spotify artwork and track metadata link back to Spotify when URLs are available.

## Authentication and privacy review

- Authorization Code with PKCE is used; no client secret is present or required in the distributed client.
- Requested scopes are limited to `playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-private`, and `playlist-modify-public`.
- Access and refresh tokens are stored only in `sessionStorage`; disconnect removes them. The public Client ID is stored in `localStorage`.
- Tokens and authorization headers are not logged, exported, displayed, or sent to the local server.
- No analytics, third-party scripts, or crash-reporting service is present.
- Content Security Policy restricts scripts/styles to the local app and connections to Spotify API/account hosts. The server also sends `no-store`, `no-referrer`, frame denial, and MIME-sniffing protections.
- Local backups and decisions contain Spotify account/playlist identifiers, names, and track URIs, but no OAuth credentials. Disconnect deletes these records and the temporary scan cache; clearing site data remains a fallback.
- Cached playlist metadata expires after 24 hours. Starting a new authorization and authentication failure also clear data associated with a previous account.

## Edge cases covered

- Zero, one, multiple, repeated, and maximum-size pagination pages
- Empty and malformed mutation payloads
- Exactly 100 items and more than 100 items
- Duplicate tracks and duplicate approvals
- Episodes, local tracks, unavailable entries, and unsupported URIs
- Stale positions, snapshots, playlist identity, owner, and account
- Empty/missing metadata, album art fallback, Unicode normalization, and long-name layout behavior
- Same-title tracks with materially different durations
- 401/403/404/429/5xx response handling paths, network loss, timeouts, and ambiguous writes
- Concurrent refresh, revoked refresh token, disconnect during refresh, repeated clicks, concurrent tabs, reload, and interrupted Apply reconciliation
- External playlist changes before final confirmation and post-write states that match target, original, or neither

## Tests performed

- 34 automated unit/regression tests: all passed.
- Static syntax analysis with `node --check` on the server and every JavaScript module: passed.
- Local server startup/availability: passed; `/` and `/js/app.js` returned 200.
- Security-header inspection: passed.
- Negative server requests: unsupported POST, traversal attempt, and missing file all returned 404.
- Browser reload/smoke test at `http://127.0.0.1:4387/`: passed with the expected current UI and zero console warnings/errors.
- Mutation-surface source audit: only the OAuth token POST and guarded playlist-items PUT exist.
- No build step is required for this static application. The served application is the deliverable.
- No separate linter or type checker is configured; the available static syntax checks pass.

## Not confidently verified / remaining limitations

- No live Spotify mutation was executed during this audit because the browser was not authenticated and exercising a real write without a specifically selected disposable playlist would itself be unsafe. The request/response and recovery paths are covered with mocks, but one end-to-end Apply should still be performed on a disposable playlist containing recognizable tracks.
- Spotify's replace endpoint does not accept a snapshot ID as an atomic precondition. A concurrent external edit in the final check-to-write interval can be overwritten. The UI warns against simultaneous editing, but code cannot eliminate this race with the current single-request endpoint.
- Playlists over 100 total items are intentionally read/review-only.
- Clearing browser site data removes local backups, review decisions, and interrupted-operation markers. Downloaded backup files remain if the browser completed the download.
- Track-family detection remains heuristic. Review is mandatory; a high confidence score is not proof of musical equivalence.
- The app can propose only a replacement track already present somewhere in the scanned playlists; it does not search Spotify's full catalog.
- Spotify can relink tracks by market. If the authoritative URI sequence differs from the requested sequence, the app fails closed as ambiguous even if Spotify made a semantically equivalent change.

## Changes deserving manual review

- Apply is deliberately limited to 100 items.
- Automatic restore was removed; recovery is manual from the saved backup.
- Apply requires a browser with Web Locks support.
- Reconnect always shows Spotify's account/authorization dialog.

## Spotify Safety Assessment

### Change Spotify data without explicit user understanding and permission

No normal application path was found. A write requires an individually approved proposal, the By playlist view, an Apply button for that playlist, a freshly prepared backup, and a second explicit confirmation naming the playlist and showing its ID suffix. There is no global Apply action.

### Modify the wrong playlist

No known deterministic path remains. The app binds approvals to playlist ID, snapshot, and position; rechecks the authenticated account, playlist ID, owner, and snapshot; validates that every approved source track still occupies the expected position; and sends the mutation to that exact encoded playlist ID.

The external-edit race described below is the remaining exception: it can overwrite a new edit to the intended playlist, but it does not redirect the request to another playlist.

### Add or remove the wrong tracks

Malformed IDs, mixed-playlist approvals, stale positions, unsupported items, duplicate positions, no-op changes, and URI/ID mismatches are blocked. Exact order, duplicates, and episodes are preserved. Heuristic matching can still suggest the wrong musical version, which is why every replacement requires manual review and Spotify links are exposed for inspection.

### Perform duplicate mutations

No known path remains in supported browsers. Buttons lock synchronously, Web Locks prevent concurrent tabs, a persistent in-flight marker prevents a second unresolved Apply, each Apply is one request, and writes are never retried automatically.

### Trigger actions without clear user intent

No hidden or background mutation path was found. Scanning, authentication, refresh, reload recovery, export, and disconnect do not modify Spotify data. Recovery never performs a Spotify write.

### Leak authentication credentials

No known application path remains. No client secret exists; tokens are session-only and never logged/exported. The identified external-pagination-link token leak was fixed and regression-tested.

### Become unsafe because of retries, stale state, or network failures

Retries do not make writes unsafe because mutations are never retried. Stale account/playlist/snapshot/position state is rejected. Network ambiguity triggers authoritative rereading and blocks future writes if the result cannot be proven.

One realistic residual risk remains: Spotify provides no atomic compare-and-set for full replacement. If another client edits the same playlist after this app's final snapshot read but before its `PUT` is processed, this app can overwrite that external edit. Post-write verification cannot detect the lost edit when the final playlist exactly matches this app's intended target. Do not edit the playlist elsewhere during Apply, and use a disposable test playlist for the first live test.

## API references reviewed

- [Update Playlist Items](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items)
- [Get Playlist Items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items)
- [Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)
- [Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)
- [Refreshing tokens](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)
- [Playlist snapshots](https://developer.spotify.com/documentation/web-api/concepts/playlists)
