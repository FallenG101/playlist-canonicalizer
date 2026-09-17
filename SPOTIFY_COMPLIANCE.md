# Spotify Platform Compliance Review

Reviewed: 2026-09-17

## Status

**Reasonable basis for public source distribution, with residual uncertainty.** This document is an engineering review, not legal advice or a certification from Spotify.

The app's defining feature groups and scores Spotify album and track metadata to suggest alternate releases. Section II.13 of Spotify's current Developer Policy says not to analyze Spotify Content or the Spotify Service “for any purpose.” Spotify's Developer Terms also expressly contemplate tools that help users access, discover, manage, and share content, which makes the boundary ambiguous for local, user-directed playlist management.

Spotify Dedup is meaningful precedent for this product category:

- its current site says duplicate matching uses track ID, title, artist, and duration similarity, including songs with different Spotify identifiers;
- users review matches before any removal;
- it has been public and open source since 2014 and reports more than 20 million removals;
- Spotify community answers have repeatedly referred users to it; and
- an archived Spotify Developer Community Showcase URL for the project is referenced in Spotify's community forum.

That precedent materially reduces concern that user-reviewed metadata comparison for playlist cleanup is categorically forbidden. It is not proof of current Spotify approval: community contributors explicitly disclaim affiliation, the historical Showcase listing predates the May 2025 policy, and another application's continued availability does not legally authorize this one.

On balance, publishing this repository's source is reasonable if the remaining requirements below are completed. Operating it for users beyond the developer's approved access, seeking extended quota, or commercializing it should be treated as a separate Spotify review point. Written clarification from Spotify remains the strongest option.

## Objective compliance work completed

- Renamed the product from “Spotify Canonicalizer” to “Canonicalizer.” The app should also be renamed to **Canonicalizer** in the Spotify Developer Dashboard before further use.
- Replaced the custom circle-and-waves mark with an independent square “C” mark.
- Added the official full Spotify logo for attribution at its required minimum size and linked it to Spotify.
- Linked displayed Spotify artwork, track metadata, album metadata, and the selected playlist/album context back to Spotify when Spotify supplies a link.
- Preserved supplied artwork without cropping or overlays and uses at least a 4-pixel corner radius.
- Added a truthful privacy policy before public distribution.
- Limited requested scopes to the four playlist read/write scopes used by the product.
- Uses OAuth Authorization Code with PKCE and contains no client secret.
- Keeps tokens in session storage and does not log, export, or transmit them to the local server.
- Limited temporary playlist metadata caching to 24 hours and added local-data deletion on Disconnect, reconnect, and authentication failure.
- Added an independent-project disclaimer and removed product-name wording that could imply Spotify endorsement.

## Remaining release requirements

- Rename the registered app in the Spotify Developer Dashboard to **Canonicalizer** and verify its icon is not Spotify-like.
- Recheck the current Developer Terms, Developer Policy, Design & Branding Guidelines, and Web API documentation immediately before release; Spotify may change them.
- Perform the documented live test using only a disposable playlist and the intended developer account.
- Before offering access to other users, confirm that the app's Spotify dashboard mode, user allowlist, quota status, and distribution comply with Spotify's then-current requirements.

## Official sources reviewed

- [Spotify Developer Policy](https://developer.spotify.com/policy)
- [Spotify Developer Terms](https://developer.spotify.com/terms)
- [Spotify Design & Branding Guidelines](https://developer.spotify.com/documentation/design)
- [Spotify Web API documentation](https://developer.spotify.com/documentation/web-api)
- [Spotify Dedup](https://spotify-dedup.com/)
- [Spotify Dedup source](https://github.com/JMPerez/spotify-dedup)
- [Historical Spotify Community reference to the Developer Showcase listing](https://community.spotify.com/t5/Accounts/More-music/td-p/4593272)
