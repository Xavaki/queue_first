# AMO listing and review notes

Copy each section into the matching field on addons.mozilla.org.

## Name

Queue First

## Summary (max 250 characters)

Watch YouTube on purpose. Videos play only from your Watch Later queue, oldest first, so you finish what you saved before starting something new. Music plays freely, and two daily skips cover the exceptions.

## Description

Queue First turns your YouTube Watch Later playlist into a strict queue.

How it works:
- Browse YouTube as usual, but video cards are greyed out and clicking one does not play it. To watch something, save it to Watch Later from the card's ⋮ menu.
- Your queue plays oldest first. The oldest video in Watch Later plays normally; everything saved after it waits its turn.
- When you're done with a video, remove it from Watch Later with YouTube's own controls, and the next one unlocks. Queue First never removes videos for you.
- The Watch Later page shows only the video that's up next, and its sort order is locked to oldest first.
- Music is exempt: music videos, the homepage Music chip and YouTube's Music page work normally.
- Two skips a day: on the homepage, the skips button lets you play one video right away without queueing it.

Privacy: everything stays in your browser. Queue First talks only to youtube.com, using your existing YouTube session, and sends nothing anywhere else. No analytics, no tracking, no accounts.

Limits: works on www.youtube.com in desktop Firefox. YouTube Music, the mobile site, embedded players on other sites and private windows are not covered. It is a voluntary safeguard, not parental control.

## Categories

- Social & Communication (or: Other)
- Tags: youtube, productivity, focus, watch later, queue

## License

MIT (or your choice)

## Privacy policy

Queue First does not collect, transmit or sell any personal data.

- All data (your queue's order, music classifications, skip counts and settings) is stored locally with browser.storage and never leaves your device.
- The extension makes requests only to https://www.youtube.com, using your existing YouTube session, to read your Watch Later playlist, add videos to it when you ask, and check whether a video is music.
- Your YouTube account is identified only by a one-way hash, used to keep separate queues for separate accounts. No account names, emails or cookies are stored.
- There is no analytics, telemetry or third-party service.

## Notes to reviewer

Build from source:
- Node 22.16.0, npm 10.9.2, on Linux.
- `npm ci && npm run build`. Output goes to `dist/`, which matches the uploaded package.
- `npm run package` builds the same output and zips it with web-ext.
- The code is TypeScript bundled with esbuild (`build.mjs`); it is not minified. Inline source maps are included.

What the extension does and why it needs its permissions:
- `host_permissions: https://www.youtube.com/*`: content scripts lock video cards, pause unauthorized players and manage the Watch Later page. Nothing runs on other sites.
- `storage`: the local queue ledger (storage.local) and per-tab playback grants (storage.session).
- A MAIN-world content script (`src/adapters/youtube/bridge.ts`) calls YouTube's own InnerTube API (`/youtubei/v1/...`) with fixed endpoints only (no caller-controlled URLs). It reads the Watch Later playlist, checks whether a video is in it, and adds a video to it when the user chooses to. The content script reaches it through a message bridge.
- The background script fetches `https://www.youtube.com/watch?v=<id>` to read a video's category (music or not). This is the only background network request.
- No remote code, no eval, no third-party requests.

Testing:
- Sign in to YouTube in Firefox. Open https://www.youtube.com/playlist?list=WL once; the extension imports the list.
- On the homepage, video cards are greyed out; save one to Watch Later from its ⋮ menu.
- On Watch Later, only the oldest video is shown; it plays. Any other video opened directly shows a "Locked by Queue First" overlay.
- If YouTube access is turned off in about:addons, the toolbar button shows a red "!" and the popup offers to turn it back on.
