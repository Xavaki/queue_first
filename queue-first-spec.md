# Queue First Firefox Extension Development Specification

Queue First is a Firefox extension for intentional YouTube use. Browsing stays available. Selecting a nonmusic video normally saves it to YouTube Watch Later instead of playing it. Ordinary playback starts from Watch Later and is limited to the oldest eligible queued video. Music plays freely. Two daily skips let the user explicitly play a homepage video directly without adding it to the queue; skips never authorize a later queued item.

This specification is a proposed MVP contract for a coding agent. Defaults below resolve ambiguities in the initial idea; they are product choices, not additional user requirements. Working name: Queue First. Alternatives: First in View, Later Lane, Queuekeeper. Name availability has not been checked.

## Product rules

1. The homepage, search, subscriptions, channel pages, and recommendations remain browsable.

2. A normal deliberate selection of a nonmusic video outside the extension managed Watch Later view queues it and prevents playback. An explicit homepage Watch now action using a daily skip instead permits direct playback without any queue insertion. Stay on the browsing page when ordinary click interception is possible; otherwise show a blocked watch page.

3. Inside Watch Later, only the oldest eligible nonmusic item has an ordinary Watch button. All other nonmusic items are locked.

4. Music is exempt everywhere and never consumes a skip. Clicking music does not automatically add it to Watch Later.

5. A skip means “play this homepage video now without adding it to Watch Later.” It never skips a turn inside the queue, removes its head, or authorizes playback of a later queued item.

6. A skip authorizes one video in one tab for one viewing session. It is not a timed period of unrestricted browsing.

7. Completion advances the queue. Playback position alone is not evidence of completion.

8. No automatic advancement into another nonmusic video, even when that video becomes the new head. The user returns to Watch Later and deliberately starts it.

A click outside Watch Later still queues and blocks the head video, even when the queue was empty. This preserves the requested separation between browsing and viewing.

## Scope and environment

Target Firefox desktop and the normal signed-in YouTube website at www.youtube.com. Cover ordinary watch pages, Shorts video routes, and live video routes within that site. Disable audible or playing hover previews for nonmusic and unknown cards while keeping browsing usable. Do not enqueue from hover, scrolling, metadata fetches, or autoplay.

Handle mouse, keyboard, middle click, modifier clicks, context-menu new tabs, pasted links, restored tabs, reloads, browser back and forward, and YouTube client-side navigation. Where a click cannot be intercepted, enforce the same policy in the destination document. Resolve the actual video ID independently of playlist, timestamp, or tracking parameters.

YouTube Music, mobile YouTube, embedded players on external sites, other browsers, and other devices are outside this MVP. Say so in onboarding. This is a voluntary safeguard; disabling the extension or using another environment remains possible. Incognito is unsupported in v1 and should not be claimed as protected.

Require sign-in and a successfully initialized Watch Later snapshot for ordinary nonmusic playback. Music may play when positively classified even if Watch Later access fails. Do not change YouTube account settings or intercept unrelated Google pages.

## Music classification

Implement classify(videoId) with three outcomes: MUSIC, NON_MUSIC, UNKNOWN. The primary signal is the category in the video's own player metadata, commonly microformat.playerMicroformatRenderer.category in ytInitialPlayerResponse. Existing open-source parsers read this field, but its location is an undocumented website detail rather than a guaranteed API.

Prefer metadata already present for the current video. For a browsing card without category information, retrieve the corresponding watch-page HTML on demand without starting its player. Parse embedded JSON safely, never with eval. Verify that videoDetails.videoId matches the requested ID; do not accidentally use metadata belonging to a recommended video. Support localized responses through a validated canonical category mapping or request a consistent language. Do not assume every category string is English.

MUSIC requires a verified Music category or a manually configured per-video exemption. Everything positively classified in another category is NON_MUSIC. UNKNOWN stays restricted and displays “Could not verify whether this is music.” Metadata requests have a bounded timeout, deduplicate by video ID, and retry only on user request or a bounded retry policy. Cache classifications for 24 hours with source, video ID, parser version, and timestamp; invalidate after parser changes.

Do not exempt based solely on title keywords, a music hashtag, a channel name, background music, or a detected song credit. These can describe commentary or gaming videos. Category metadata can itself be inaccurate: offer a per-video Music exemption in settings, with a clear label that it is a user override. No automatic channel exemptions in MVP.

Classify before automatic Watch Later insertion so music is not accidentally queued. While classification is pending, hold playback. On timeout, a deliberate attempted video can be queued with UNKNOWN status. Previously queued music stays in native Watch Later but is excluded from the restricted queue; the extension does not remove it automatically.

## Watch Later integration and ordering

Use the user's real YouTube Watch Later playlist, normally /playlist?list=WL. Add an extension controlled panel there with a dependable oldest-first view and explicit Play oldest action. The native list may remain visible, but its links, Play all action, playlist next controls, and autoplay must obey the same policy. Native display order must not determine authorization.

The public YouTube Data API cannot list Watch Later items, and its insert/delete support for Watch Later was deprecated. Do not design this around OAuth plus playlistItems APIs. Preferred implementation: invoke the signed-in page's JavaScript action or the internal authenticated request used by YouTube's own Watch Later control. Inspect and validate the current website action before choosing an implementation; this specification does not assume a stable global function or endpoint. Keep it behind a replaceable adapter. Use the visible Save controls as a fallback if needed. Confirm playlist membership after each mutation. Internal website actions are undocumented and can change. Do not copy session credentials into extension storage.

Before full implementation, prove the adapter can read the entire list including continuation pages, add an item, detect an existing item, and remove an item with observable confirmation. If that fails, report the exact blocker. A local-only queue is a different product and must not silently replace native Watch Later.

The extension owns a persistent ordering ledger; YouTube owns playlist membership. For new items added through the extension, assign an increasing sequence number and UTC timestamp at the first deliberate attempt. Duplicates retain their original position. Removal followed by a later new addition receives a new sequence.

On first setup, import all existing Watch Later items. Use a verified date-added-oldest-first website sort if available. If historical order cannot be reliably recovered, show a one-time choice: adopt the current complete playlist order or start managing new additions only. Explain that adopted order is a baseline, not verified historical age. Do not silently infer age from publication date. Initialization remains incomplete until the user chooses a valid baseline.

Existing imported items precede subsequent additions. Items first observed from other devices after setup append in their observed order; exact remote addition times are not promised. Manual playlist reorder does not reorder the ledger. Reconcile on opening Watch Later, on a mutation, and before starting ordinary playback. An incomplete or failed snapshot cannot prove a deletion or authorize a newer head.

Eligible means active, not completed, not MUSIC, and not confirmed unavailable. UNKNOWN is eligible and may be the head. Pending or failed additions remain visible in the ledger as unconfirmed and prevent ordinary advancement past them until retried or explicitly removed. Label “Saved to Watch Later” only after successful confirmation.

## Viewing and queue advancement

Ordinary playback requires a one-use launch grant created by the extension's Watch Later panel for the current head. Bind it to account scope, video ID, tab ID, and a queue revision; validate it in the background before allowing the destination player. The URL parameter list=WL is not proof of authorization.

After launch, allow pause, resume, seeking, fullscreen, and reload for that same video in that same session. A grant ends when the tab closes, changes to another video, or the browser restarts. A brief detach or reload of the same page must not create a new skip charge. Grant renewal for an ordinary video is available from Watch Later if it remains the head. If external playlist changes remove the authorized video, let the current same-video session finish, then reconcile before any next grant.

Queue completion occurs when the main content emits an ended event after at least 90 percent of its duration has actually been watched. Track the union of watched media intervals; seeking over a section does not count, and replayed intervals count once. Count accelerated playback by media time. Persist progress per account and queued video. A homepage skip session does not update queued progress, complete a queued entry, remove any Watch Later item, or advance the head. Do not count ads or preview players.

Provide Mark finished on the active ordinary head video and on the head in Watch Later. This is an explicit user declaration, appropriate for videos the user elects to abandon or live streams without a finite duration. Do not expose it on locked rows or homepage skip sessions.

On completion, persist a completion tombstone and advance the local head immediately; attempt to remove that video from native Watch Later. If removal fails, show a sync warning and retry safely. The tombstone prevents immediate reimport of the same still-present membership. A later verified absence followed by a fresh addition is a new queue entry.

A private, deleted, or region-blocked item may be excluded only on a positive unavailable result, not a timeout or generic parser error. Preserve it in an Unavailable section and report the reason; do not remove it from YouTube automatically. Live streams advance through Mark finished. Empty queues display “Browse YouTube to add something for later.”

## Daily skips

Display two skips each calendar day. Use a timezone captured at setup from the browser, shown in settings as an IANA timezone; it remains fixed unless the user explicitly changes it. Reset at midnight in that timezone, including daylight saving changes. Compute lazily on every skip request and popup open; a continuously running timer is unnecessary. Unused skips do not roll over.

Add a separate “Watch now · 1 skip” control to homepage video cards. Activating it is a distinct user intent intercepted before any automatic Watch Later save. Normal thumbnail/title clicks retain immediate queue-and-block behavior. Classify the selected video first: music plays freely without charging; NON_MUSIC or UNKNOWN can use the explicit skip. Issue no Watch Later add request and create no queue entry for this path. Do not first enqueue and then undo the save. Skips are available only for videos deliberately selected from the homepage, not from Watch Later rows, search results, recommendations, direct URLs, or an already queued blocked watch page.

Spending a skip and issuing its session grant is a single serialized, durable state transaction. Double clicks, repeated messages, and simultaneous tabs cannot spend the same remaining skip twice. Use request IDs for idempotency. Record the explicit homepage intent and bind it to video ID, tab, and account; a forged referrer or URL parameter cannot establish that intent. Queue insertion and skip authorization for the same selection must be mutually exclusive. Verify current membership before issuing the skip; if membership is unresolved, hold the request without charging. Charge when the user activates the exception and the launch grant is committed; ordinary buffering or playback failure does not automatically refund it. Label this behavior in the button help text.

Reloading a homepage skip video in the same tab does not spend another skip. Its grant ends when the tab closes, navigates to another video, or the browser restarts. A new skip requires a fresh eligible homepage Watch now action. A video already in the managed queue is ineligible for a skip even if it appears on the homepage: direct the user to Watch Later. This prevents the homepage from becoming a way to bypass queue order. Watching a homepage skip video has no effect on queue membership or advancement. If the user explicitly saves that video later, treat it as a new deliberate addition; the existing same-video skip session may finish, but later playback follows queue rules.

Persist used skips and grants before responding to the content script. Midnight creates a new allowance but does not interrupt an existing viewing session. Detect backwards calendar-date changes and do not reset to an earlier day; local clock manipulation cannot be fully prevented without a server. Keep skips profile-wide so switching YouTube accounts does not create extra allowances.

## User interface

Keep the interface small, neutral, keyboard accessible, and compatible with YouTube light and dark modes.

| Surface | Required behavior |
| --- | --- |
| Homepage cards | Normal click queues nonmusic; separate Watch now control consumes one skip and bypasses insertion; queued videos cannot use that control |
| Browsing confirmation | Show Checking category, then Added to Watch Later or Already queued; offer Open Watch Later |
| Blocked watch page | Pause and mute the player; explain why it is locked; show oldest title, queue position, and Open Watch Later; no queue bypass button |
| Watch Later panel | Oldest eligible item first; ordinary Play button only there; other nonmusic rows locked without skip buttons; music freely playable |
| Active viewing banner | Indicate Watching oldest, Music exempt, or Homepage skip used; Mark finished appears only for ordinary queue viewing |
| Toolbar popup | Show protection status, queue size, oldest item, remaining homepage skips, reset timezone, and Open Watch Later |
| Settings | Show music override list, timezone, import baseline, sync status, and scoped diagnostic controls |

Failed saves say “Could not save to Watch Later” and offer Retry; they never look successful. Signed-out and account-change states require reconnecting or initialization. Parser and playlist failures show a recoverable blocked state while retaining browsing.

Allow deliberate removal from the queue through the native playlist UI or extension management UI. Removal is an intentional escape from the commitment, so label it clearly; do not interpret a skip as removal. An explicit confirmed complete snapshot is necessary to reconcile native removals. Music errors can be corrected with a per-video override.

## Architecture and persistent state

Use TypeScript and a Firefox-compatible WebExtension manifest. Pin and document the minimum supported Firefox version. Use an early isolated content script and CSS at document_start for policy and UI. For the Watch Later adapter, use a small page-context JavaScript bridge, through a supported Firefox execution mechanism, to invoke YouTube's verified internal action or authenticated website request. The bridge exposes only the necessary playlist operations and metadata reads; it never receives arbitrary code, arbitrary request URLs, or extension privileges. Validate message shape, operation ID, video ID, tab/account scope, and the resulting playlist state. Keep session credentials inside the website context, and do not return them through bridge messages. Treat page-originated data as untrusted; only the extension controller can mint grants or spend skips. A main-world bridge is observable and alterable by the webpage, so it is not a trusted policy boundary.

Separate modules:

- Pure policy engine: classify authorization from account, queue, route, and grant state.

- Background controller: sole writer for queue, skips, progress, and grants; serialize mutations and persist before acknowledging.

- Content controller: intercept selections, observe routes and dynamically mounted players, enforce pauses and render UI.

- Metadata adapter: retrieve and parse only the requested video's category.

- Watch Later adapter: complete snapshots and idempotent confirmed additions/removals.

- Popup and settings: send validated intents through the background controller.

Persistent state includes schemaVersion; settings; per-account queue entries with videoId, playlist membership identifier if available, sequence, firstAttemptAt, title, category status, sync status and completion status; category cache; watched intervals; completion tombstones; daily skip ledger; and recent idempotency request IDs. Live tab grants are session state and must not survive browser restarts as unrestricted authorization.

Store durable state with browser.storage.local. Do not rely on in-memory background state surviving suspension. A single controller must serialize read-modify-write operations; storage API calls alone are not a multi-field transaction. Store a revisioned state record or a journal with recovery semantics, and reconcile after restart. Broadcast policy changes to all managed tabs.

Identify the active YouTube account or channel scope through validated adapter data. Never merge two accounts' Watch Later membership. On ambiguous identity or account switching, invalidate playback grants and block ordinary playback pending reconciliation. Preserve each account's ledger and music override choices separately; the daily skip allowance remains shared.

Request only necessary YouTube host access and storage permissions. Add navigation or scripting permissions only if the chosen implementation requires them. No all-sites access, analytics, remote code, backend, or third-party metadata provider in MVP. Retain no cookie values or authorization tokens. Diagnostics must redact sensitive account and session data.

## Enforcement and failure handling

The content controller must evaluate policy on initial load, route changes, player replacement, play and playing events, and restored tabs. Intercept controllable clicks before navigation; the destination guard covers navigation paths that cannot be intercepted. Mute and pause unauthorized players immediately and keep them gated until a valid decision arrives. Hiding the player alone is insufficient.

A Firefox content script cannot be assumed to guarantee zero decoded frames or zero audio on every website race. The agent must test early injection and measure leakage. If it cannot meet the acceptance tests, investigate a Firefox-supported blocking or redirect mechanism with only the necessary permissions, or document the limitation before declaring the safeguard complete.

Enforce by video ID, not by page label. Playlist autoplay, Shorts scrolling, end screens, recommendation links, media keys, and miniplayer must not authorize a new nonmusic video. Music-to-music navigation is free; music-to-nonmusic is guarded. An autoplay attempt is blocked but does not enqueue the video or spend a skip. Opening Watch Later must not start a native player automatically.

While metadata or playlist state is unresolved, browse normally but keep unverified video playback blocked. Do not broadly block the whole website. Never use a failed fetch as evidence that a head video disappeared. Retry operations with bounded backoff, unique operation IDs, and observable outcomes; do not toggle Save blindly if it is already enabled.

## Acceptance tests

Use deterministic policy tests, adapter fixtures, and real Firefox integration testing with a disposable YouTube account. No production account credentials or personal Watch Later fixtures in the repository.

1. Clicking nonmusic A from the homepage adds A once and does not play it, including when A is the only item.

2. Clicking nonmusic B appends B; clicking A again preserves its earlier sequence. A plays only after Play oldest in Watch Later.

3. Completing A advances to B; B does not autoplay. Reloading A during its authorized session is allowed without a skip.

4. Confirmed Music plays from homepage, search, playlists, direct links, and recommendations without queue insertion or skip spending.

5. UNKNOWN stays guarded, can be queued and watched as head, and never gains exemption from a misleading title.

6. Two homepage Watch now activations for unqueued nonmusic videos succeed; the third is refused. Each permitted video plays directly with zero automatic Watch Later add calls and zero queue entries. The current queue head and order remain unchanged. A normal homepage click still queues immediately. A queued video shown on the homepage cannot use a skip, and locked Watch Later rows have no skip action.

7. Concurrent eligible homepage skip requests from two tabs with one skip left produce exactly one grant. Duplicate request IDs do not spend twice. A racing normal enqueue and skip request for the same selection cannot both succeed; resolve them in the background before any playlist mutation.

8. Same-tab reload retains a homepage skip grant without queue insertion; a second tab and a new video do not inherit it. Browser restart retains spending but invalidates active grants. Finishing the skip video never advances or removes the existing queue head.

9. Local midnight, daylight saving boundaries, browser closure over midnight, and a backward clock change follow the stated reset policy.

10. Direct URLs, Shorts, modified clicks, restored tabs, and client-side navigation all receive enforcement. Changing list, index, or timestamp parameters cannot grant access.

11. Nonmusic hover previews, autoplay, end screens, media keys, and miniplayer cannot bypass the restriction. No automatic enqueue from those events.

12. Save failure, signed-out state, incomplete pagination, stale metadata, and parser errors display truthful recoverable states and never silently allow locked content. A skip issues no save request and does not depend on save success, but unresolved membership must not authorize a queued-video bypass.

13. A shuffled native playlist preserves ledger order. Existing videos import under the chosen baseline; remote additions append deterministically.

14. Account switching never mixes queues or issues fresh daily skips.

15. Seek-to-end and ads do not complete a queued item; watching distinct intervals, manual Mark finished, and live streams follow the completion rules. Homepage skip sessions never participate in queue completion.

16. Confirmed unavailable head items do not deadlock the queue; generic network failure does not skip them.

17. Completion removal failure preserves a tombstone and does not resurrect the item. Explicit later readdition gets a new position.

18. Keyboard-only operation, focus restoration, screen-reader labels, light/dark themes, and enlarged text remain usable.

Report the observed Firefox version, YouTube interface language, adapter paths tested, and any visible or audible unauthorized playback leakage. Do not call the integration complete based only on mocked tests.

## Development sequence and handoff

First build and validate the page-context JavaScript Watch Later adapter and metadata adapter, including confirmed mutations, complete imports, and a realistic navigation guard. This is the feasibility checkpoint. Then implement the pure policy engine and state persistence, followed by music exemption, queue UI, session grants, homepage skip controls, progress tracking, and recovery behavior.

Deliver the extension source, a development build, temporary-install instructions for Firefox, automated tests, adapter fixture samples with sensitive fields removed, and a README documenting permissions, scope, music classification limits, existing-queue import, and failure recovery. List any unsupported navigation path explicitly. Keep website-specific selectors and parsers centralized so YouTube changes can be repaired without changing policy.

The agent may make routine implementation choices within this contract. It must not silently substitute a local queue, broaden music exemptions, turn homepage skips into queue-order exceptions or a free-play time window, enqueue a skip video automatically, or claim historical ordering it cannot verify.

## Technical references

Verified 30 September 2026. Product behaviors elsewhere in this document are proposed requirements.

- [YouTube Data API revision history](https://developers.google.com/youtube/v3/revision_history), 9 September 2020: Watch Later insert/delete support was fully deprecated.

- [PlaylistItems list documentation](https://developers.google.com/youtube/v3/docs/playlistItems/list): Watch Later items cannot be retrieved through the public API.

- [Invidious video parser](https://github.com/iv-org/invidious/blob/master/src/invidious/videos/parser.cr): an implementation example extracting category from player microformat data; it does not guarantee YouTube website stability.

- [Mozilla content scripts manifest documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts): early injection and isolated versus main execution worlds.

