# Privacy Policy

Last updated: 2026-09-17

Canonicalizer is a local, independent tool for reviewing and changing playlists on Spotify. It has no hosted backend, analytics, advertising, telemetry, or crash-reporting service.

## Information the app accesses

After you authorize it, Canonicalizer accesses the minimum Spotify data needed for its playlist workflow:

- your Spotify user ID and display name;
- playlists that you own or collaborate on, including playlist IDs, names, owners, collaboration status, public/private status, snapshot IDs, and Spotify links;
- playlist items and associated track, artist, album, artwork, availability, and external-link metadata; and
- the authorization scopes granted by Spotify.

The app does not request your email address, date of birth, followers, saved library, playback state, devices, listening history, or payment information.

## How information is used

The data is used only to inventory eligible playlists, identify possible alternate album releases, display proposals for your review, preserve playlist order, create local safety backups, and apply only the playlist changes you explicitly approve and confirm.

## Storage and retention

- OAuth access and refresh tokens are stored in browser `sessionStorage` and are not written to disk by the app. They disappear when the browser session ends or when you disconnect.
- Your public Spotify developer Client ID is stored in browser `localStorage` so it does not need to be re-entered.
- Review decisions, pre-change backups, and interrupted-operation safety records are stored in `localStorage` on your device.
- Resumable scan metadata is stored in IndexedDB on your device for no more than 24 hours and is keyed to the Spotify account, playlist, and playlist snapshot.
- Scan exports and backup downloads are files you intentionally save. Canonicalizer cannot delete those downloaded files.

No Spotify data is sent to the local web server. The browser communicates directly with Spotify's account and Web API services.

## Sharing and sale

Canonicalizer does not sell, rent, share, or transmit your Spotify data to the project developer or to third parties. Spotify receives the OAuth and API requests required to provide its service.

## Cookies and third parties

Canonicalizer does not set cookies and does not permit third parties to set cookies in the app. Spotify's authorization page is operated by Spotify and is governed by Spotify's own privacy practices.

## Your choices and deletion

Select **Disconnect** to remove OAuth tokens and locally stored Spotify account data, review decisions, backups, interrupted-operation records, and the scan cache. You can also clear site data for `127.0.0.1:4387` in your browser. Delete any scan exports or backup files separately using your operating system.

Connecting again may allow you to choose a different Spotify account. Canonicalizer clears data associated with a previous connection before starting a new authorization.

## Security

Canonicalizer uses Spotify's Authorization Code flow with PKCE and does not use or embed a Spotify client secret. Tokens are not logged, exported, displayed, or sent to the local server. No software can guarantee absolute security; use the [project issue tracker](https://github.com/FallenG101/playlist-canonicalizer/issues) to report a suspected privacy or security problem without including tokens or private account data.

## Changes

Material changes to this policy should be reflected by changing the “Last updated” date. Review the policy again after updating the application.

Canonicalizer is not affiliated with, endorsed by, or sponsored by Spotify. Spotify is a trademark of Spotify AB.
