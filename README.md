# Queue First

A Firefox extension for intentional YouTube use. Browsing stays open, but outside Watch Later every video card is dimmed and locked. Clicking one plays it only if it's music. To queue anything else, use the card's ⋮ menu (shown in blue) → **Save to Watch Later**. Music sections aren't locked: the homepage **Music** chip and YouTube's Music page work normally, and each video is still checked when it opens. The only way to watch a video is to save it to Watch Later. On the Watch Later page, which lists oldest first, the sort button is disabled and only the oldest video is shown; one card stands in for the rest. The oldest video plays from anywhere, with no extra step. When you're done, remove it from Watch Later yourself with YouTube's own controls. The next video then unlocks. The extension never removes videos and doesn't track how much you watched. Music plays freely. Two daily skips let you play a homepage video directly without queueing it. The floating **skips left** button on the homepage turns on skip mode, which restores the cards' color, and your next click uses a skip.

The original product contract is [`queue-first-spec.md`](queue-first-spec.md). The UX has since moved away from it: there are no separate panels, and Watch Later's own order is the queue.

> **Status: first development build, not yet verified against live YouTube.** The Watch Later adapter (internal website requests), the DOM selectors, and the playback guard are written against YouTube's current website behavior but have not been exercised in a signed-in session yet. Expect fixes in `src/adapters/youtube/` during live debugging. Playback leakage (visible frames or audio before the guard pauses) has not been measured.

## Develop

Requirements: Node 20+, Firefox 128+ (developed against Firefox 156).

```sh
npm install
npm run build        # bundles into dist/
npm test             # policy, ledger, parser, and controller tests
npm run typecheck
npm run lint:ext     # web-ext lint on dist/
npm run start        # launches a temporary Firefox profile with the extension
npm run watch        # rebuild on change
```

### Temporary install in your own Firefox

1. `npm run build`
2. Open `about:debugging#/runtime/this-firefox`
3. Choose **Load Temporary Add-on…** and select `dist/manifest.json`
4. Open https://www.youtube.com/, sign in, then open Watch Later to run setup.

Temporary add-ons are removed when Firefox restarts.

## Scope

Covered: desktop Firefox on `https://www.youtube.com/`, including watch pages, `/shorts/`, `/live/`, client-side navigation, reloads, restored tabs, and back and forward navigation.

Not covered: YouTube Music, the mobile site (`m.youtube.com`), embedded players on other sites, other browsers and devices, and private windows (the extension is set to `incognito: not_allowed`). This is a voluntary safeguard: disabling the extension or switching environments remains possible.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | The queue ledger, skip ledger, and category cache (`storage.local`); live playback grants (`storage.session`, which is cleared on browser restart) |
| `https://www.youtube.com/*` | Content scripts, the main-world bridge, and fetching a video's own watch page to read its category |

There is no access to other sites, no analytics, no remote code, no backend, and no third-party metadata provider. Cookies and authorization tokens are never stored or passed out of the page context.

## How it works

```
src/
  policy/          pure logic: engine (authorization), ledger (ordering), skips
  background/      controller (sole writer; serialized transactions), store, classifier, Watch Later adapter
  content/         guard (media enforcement), intercept (card locking, clicks, homepage skip mode), watchLaterPage (native page: oldest row only), UI
  adapters/youtube/
    parsers.ts     all YouTube response parsing (versioned by PARSER_VERSION)
    selectors.ts   all YouTube DOM selectors
    bridge.ts      main-world bridge: fixed Watch Later operations only
  popup/, options/
```

- **Single writer.** Only the background controller changes state. Each operation loads state, changes it, and persists it inside a serialized transaction before replying. Durable state is one revisioned record in `storage.local`.
- **Bridge.** The main-world script performs only these operations: read the account, take a complete snapshot, check membership, and add. It never removes. Each goes to a fixed InnerTube endpoint (`browse`, `browse/edit_playlist`, `playlist/get_add_to_playlist`) and uses the page's own session. Adds are confirmed by re-checking membership. The page can see and alter this bridge, so it is not a policy boundary: only the background mints grants or spends skips.
- **Guard.** Every `<video>` and `<audio>` element is paused and muted until the background authorizes the video it is playing. Unauthorized players are also hidden with CSS injected at `document_start`. Enforcement is keyed on the video ID taken from the route and from the player itself.

## Music classification

Category comes from the video's own player metadata: `microformat.playerMicroformatRenderer.category` in `ytInitialPlayerResponse`. It is fetched with `hl=en` and never evaluated as code. The parser checks that `videoDetails.videoId` matches the requested video.

- **MUSIC:** only the verified "Music" category, or a per-video user override in Settings.
- **NON_MUSIC:** any other known category.
- **UNKNOWN:** missing metadata, a timeout, a parser error, or an unrecognized, possibly localized, category string. UNKNOWN stays guarded and shows "Could not verify whether this is music."
- Titles, hashtags, channel names, and song credits never exempt a video. There are no channel-wide exemptions.
- Successful results are cached for 24 hours per video, along with the parser version. Failures are not cached.

YouTube's category can be wrong. Use a per-video override for those cases.

## Watch Later order

The queue is your Watch Later playlist in its native order, which is oldest first:

- The first visit to Watch Later imports the list automatically. This needs one complete read, including every continuation page.
- The controls that change the order are disabled on this page. The sort menu and the per-row drag handles are made `inert`, so they can't be clicked, focused or used from the keyboard, and interaction with them is blocked before YouTube sees it.
- Only the oldest video's row is shown (outlined, marked **Up next**, click to play). Every other row is hidden behind a single "Other videos hidden by Queue First" card.
- New saves join the end, just as YouTube appends them.
- The queue advances only when you remove the oldest video from Watch Later yourself. Watching it, even to the end, changes nothing.
- Only a complete read can change the order or confirm that a video was removed. A partial read never moves the head.

## Failure recovery

| Situation | Behavior |
| --- | --- |
| Save failed | "Could not save to Watch Later" with Retry. Nothing is queued. |
| Watch Later can't be read completely | Setup waits and shows a Retry. Once set up, the last complete order is kept. |
| Incomplete or failed snapshot | Cannot confirm a removal or unlock a newer head. The current head stays as it is. |
| Signed out, account unknown, or account switch | Grants are invalidated and ordinary playback is blocked. Music still plays. Queues are kept separate per account. Skips are shared across the profile. |
| Unavailable video | Moved to an Unavailable section only when YouTube positively reports it as unplayable, never on a timeout. |
| Browser restart | Spent skips persist. Active playback grants do not. |

## Known limitations and unsupported paths

- **Other ways to reorder:** YouTube's row ⋯ menu may offer "Move to top" or "Move to bottom", and those items are not blocked. The sort controls are also only disabled on this page. If Watch Later has been re-sorted from another device, the extension follows that order. Locking still goes by the first video in the list.
- **Opening in a new tab from the context menu, pasted links, and restored tabs** can't be intercepted. The destination page blocks playback and offers an explicit **Add to Watch Later** button. It does not queue automatically, because a restore or reload is not a deliberate selection.
- **Hover previews** are disabled for all videos, music included.
- **Channel trailers and other secondary players** are blocked unless their video is already authorized in that tab.
- **Hidden unavailable videos:** YouTube can leave unavailable videos out of the playlist response. A complete snapshot may then treat them as removed.
- **Two tabs on different YouTube accounts at the same time** (for example `authuser=1`) keep invalidating each other's grants.
- **Clock manipulation:** a backwards date change never resets skips, but a forwards change can't be detected without a server.
