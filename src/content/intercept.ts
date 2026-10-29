// Selection interception. Outside the Watch Later page every video card is
// shaded and locked: a click plays the video only if it is music, and does
// nothing otherwise; the card's ⋮ menu (Save to Watch Later), shown in blue,
// is the only action.
// On the homepage, a floating skips button turns on skip mode, which restores
// card color and lets the next click play a video directly for one skip.
// Music sections (the homepage Music chip, the Music destination page) are
// left alone; the watch-page guard still verifies each video.

import { isMusicName } from '../adapters/youtube/parsers';
import {
  CARD_MENU,
  CHANNEL_FEATURED_PLAYER,
  CHANNEL_LINK,
  DARK_ATTR,
  MUSIC_DESTINATION_PATHS,
  SELECTED_CHIP,
  VIDEO_CARD,
  WL_ROW,
} from '../adapters/youtube/selectors';
import { videoIdFromHref, type Route } from '../shared/ids';
import type { ClassifyResult, ContentState, RowStatus, SkipResult } from '../shared/messages';
import { requestId, send } from './api';
import { createHost, h, isOwnUi } from './ui';
import { PAGE_ATTR, rowVideoId } from './watchLaterPage';

const LOCK_ATTR = 'data-queue-first-browse';
const SKIP_MODE_ATTR = 'data-queue-first-skip-mode';

export interface InterceptDeps {
  route(): Route;
  state(): ContentState | null;
  /** Video the page is actively and legitimately showing (clicks on it pass). */
  activeAllowedId(): string | null;
  /** Status of a row on the Watch Later page; null while unknown. */
  wlStatus(videoId: string): RowStatus | null;
  /** Start the oldest video from the Watch Later page. */
  launch(videoId: string): void;
  onPolicyChange(): void;
}

/** One-shot passes for our own re-dispatched navigation clicks. */
const passes = new Set<string>();

function linkFromEvent(ev: Event): HTMLAnchorElement | null {
  for (const n of ev.composedPath()) {
    if (n instanceof HTMLAnchorElement && n.href) return n;
    if (n === document.body) break;
  }
  return null;
}

function inCardMenu(ev: Event): boolean {
  return ev.composedPath().some((n) => n instanceof Element && n.matches(CARD_MENU));
}

function onChannelLink(ev: Event): boolean {
  return ev.composedPath().some((n) => n instanceof Element && n.matches(CHANNEL_LINK));
}

function navigate(a: HTMLAnchorElement, videoId: string): void {
  passes.add(videoId);
  a.click();
  setTimeout(() => passes.delete(videoId), 2000);
}

// ---------------------------------------------------------------------------
// Card shading. Built from the centralized selectors so layout repairs stay in
// selectors.ts. Nested cards (a lockup inside a rich item) are shaded once.
// The ⋮ menu and channel links must escape the shading, and a child cannot
// undo its parent's opacity or filter, so the shading goes on every top-most
// part of the card that contains neither, rather than on the card itself.

export function lockCss(): string {
  // Watch Later rows have their own shading (content.css) once that page is
  // set up; until then the lock covers them like any other card.
  const cards = `:is(${VIDEO_CARD}):not(html[${PAGE_ATTR}] ${WL_ROW})`;
  const outer = `${cards}:not(${cards} *)`;
  const menu = `:is(${CARD_MENU})`;
  const channel = `:is(${CHANNEL_LINK})`;
  const usable = `:is(${CARD_MENU}, ${CHANNEL_LINK})`;
  const lock = `html[${LOCK_ATTR}]`;
  const shaded = `${lock}:not([${SKIP_MODE_ATTR}])`;
  // Only the button and its icon are recolored; the button's hover/press
  // feedback layers keep YouTube's own styles.
  const icon = ':is(button, yt-icon-button, yt-icon, .yt-icon-shape)';
  const parts = `:is(${outer}, ${outer} :has(${usable})) > :not(:has(${usable}), ${usable})`;
  return `
${shaded} ${parts} { opacity: .32; filter: grayscale(1); }
${shaded} :is(${outer}, ${cards} :not(${usable}, ${usable} *)) { cursor: not-allowed !important; }
${lock} ${CHANNEL_FEATURED_PLAYER} { pointer-events: none !important; }
${lock} ${cards} ${menu} { opacity: 1 !important; }
${lock} ${cards} :is(${menu}, ${menu} *) { cursor: pointer !important; }
${lock} ${cards} :is(${menu}, ${menu} ${icon}) { color: #065fd4 !important; }
html[${DARK_ATTR}]${lock} ${cards} :is(${menu}, ${menu} ${icon}) { color: #3ea6ff !important; }
${lock} ${cards} :is(${channel}, ${channel} *) { color: #065fd4 !important; cursor: pointer !important; }
html[${DARK_ATTR}]${lock} ${cards} :is(${channel}, ${channel} *) { color: #3ea6ff !important; }
${lock} ${cards} ${channel}:hover, ${lock} ${cards} ${channel}:hover * { text-decoration: underline !important; }
`;
}

/** Whether the page is a music section, where cards are not locked. */
function inMusicSection(route: Route): boolean {
  if (MUSIC_DESTINATION_PATHS.includes(location.pathname)) return true;
  if (route.kind !== 'home') return false;
  // YouTube keeps pages you navigated away from in the DOM, hidden, with
  // their own selected chips; only chips on the visible page count.
  return [...document.querySelectorAll(SELECTED_CHIP)].some(
    (chip) => chip.checkVisibility() && isMusicName(chip.textContent ?? ''),
  );
}

function injectLockCss(): void {
  const style = document.createElement('style');
  style.textContent = lockCss();
  document.documentElement.append(style);
}

// ---------------------------------------------------------------------------
// Skip mode (homepage only; the background refuses skips from anywhere else)

const SKIP_CSS = `
:host { position: fixed; right: 2.4rem; bottom: 2.4rem; z-index: 2147483000; }
button { font-size: 1.4rem; padding: .8rem 1.6rem; box-shadow: var(--qf-shadow); }
`;

export class BrowseLock {
  private ui: { host: HTMLElement; root: ShadowRoot } | null = null;
  private route: Route | null = null;
  private home = false;
  private music = false;
  /** Between navigation start and the new route: stay locked. */
  private pending = false;
  private skipMode = false;
  busy = false;

  constructor(private deps: InterceptDeps) {
    injectLockCss();
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.skipMode) this.setSkipMode(false);
    });
  }

  setRoute(route: Route): void {
    this.route = route;
    this.pending = false;
    this.home = route.kind === 'home';
    if (!this.home) this.setSkipMode(false);
    this.sync();
    this.refresh();
  }

  /** Re-checks for a music section; chip changes do not change the URL. */
  sync(): void {
    if (!this.route) return;
    const music = !this.pending && inMusicSection(this.route);
    // Stays on for Watch Later too: YouTube keeps showing the page being left
    // for a moment after the URL changes, and its cards must stay shaded.
    document.documentElement.toggleAttribute(LOCK_ATTR, !music);
    if (music === this.music) return;
    this.music = music;
    if (music) this.setSkipMode(false);
    else this.refresh();
  }

  /**
   * YouTube started navigating somewhere. Lock until the new route is known,
   * so a destination page never renders unlocked while the music section or
   * skip mode of the page being left is still in effect.
   */
  navigating(): void {
    this.pending = true;
    this.music = false;
    this.setSkipMode(false);
    document.documentElement.setAttribute(LOCK_ATTR, '');
  }

  /** YouTube finished navigating; the page now matches the URL. */
  navigated(): void {
    this.pending = false;
    this.sync();
  }

  /** Clicks in a music section pass through to YouTube. */
  isMusicSection(): boolean {
    return this.music;
  }

  isSkipMode(): boolean {
    return this.skipMode;
  }

  setSkipMode(on: boolean): void {
    this.skipMode = on;
    document.documentElement.toggleAttribute(SKIP_MODE_ATTR, on);
    this.refresh();
  }

  refresh(): void {
    if (!this.home || this.music) {
      this.ui?.host.remove();
      return;
    }
    if (!this.ui) this.ui = createHost(SKIP_CSS);
    const { host, root } = this.ui;
    if (!host.isConnected) document.body?.append(host);
    const remaining = this.deps.state()?.skipsRemaining ?? 0;
    if (remaining <= 0 && this.skipMode) this.setSkipMode(false);
    const label = this.skipMode
      ? 'Skip mode · click a video'
      : remaining <= 0
        ? 'No skips left today'
        : `${remaining} skip${remaining === 1 ? '' : 's'} left`;
    const help = this.skipMode
      ? 'Clicking a video plays it now without adding it to Watch Later, using 1 skip. Click here or press Esc to cancel.'
      : `Turn on skip mode to play one homepage video now without adding it to Watch Later. ${remaining} left today. Music never uses a skip.`;
    const btn = h(
      'button',
      {
        type: 'button',
        class: this.skipMode ? 'primary' : '',
        title: help,
        'aria-label': `${label}. ${help}`,
        'aria-pressed': String(this.skipMode),
        onclick: () => this.setSkipMode(!this.skipMode),
      },
      label,
    );
    if ((remaining <= 0 && !this.skipMode) || this.busy) btn.disabled = true;
    root.querySelector('button')?.remove();
    root.append(btn);
  }
}

// ---------------------------------------------------------------------------
// Click handling

export function installInterception(deps: InterceptDeps, lock: BrowseLock): void {
  const inflight = new Set<string>();

  const onClick = (ev: MouseEvent) => {
    if (ev.type === 'auxclick' && ev.button !== 1) return;
    if (ev.type === 'click' && ev.button !== 0) return;
    if (isOwnUi(ev)) return;
    const route = deps.route();

    // The ⋮ menu always works natively (e.g. Remove from Watch Later).
    if (inCardMenu(ev)) return;

    // Watch Later: rows may navigate from anywhere inside them, not only links.
    if (route.kind === 'watch_later') {
      const a = linkFromEvent(ev);
      const row = ev.composedPath().find((n): n is Element => n instanceof Element && n.matches(WL_ROW));
      const videoId = row ? rowVideoId(row) : a ? videoIdFromHref(a.href) : null;
      if (!videoId || (!ev.isTrusted && passes.has(videoId))) return;
      const status = deps.wlStatus(videoId);
      if (status === 'music') return;
      // The oldest row otherwise behaves natively; only playing it is ours.
      if (status === 'head' && onChannelLink(ev)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      // Locked rows ignore clicks silently; the not-allowed cursor says why.
      if (status === 'head' && ev.isTrusted) deps.launch(videoId);
      return;
    }

    lock.sync();
    if (lock.isMusicSection()) return;
    const a = linkFromEvent(ev);
    if (!a) return;
    const videoId = videoIdFromHref(a.href);
    if (!videoId) return;

    if (!ev.isTrusted) {
      // Our own navigation after authorization. Other synthetic clicks are
      // left to the destination guard, which blocks without enqueueing.
      if (passes.has(videoId)) passes.delete(videoId);
      return;
    }
    if (videoId === deps.activeAllowedId()) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (inflight.has(videoId)) return;
    inflight.add(videoId);
    const run = lock.isSkipMode() && route.kind === 'home' ? useSkip(videoId, a) : playIfMusic(videoId, a, ev);
    void run.finally(() => inflight.delete(videoId));
  };

  const playIfMusic = async (videoId: string, a: HTMLAnchorElement, ev: MouseEvent): Promise<void> => {
    const modified = ev.button === 1 || ev.ctrlKey || ev.metaKey || ev.shiftKey;
    try {
      const r = await send<ClassifyResult>({ type: 'classify', videoId });
      if (!r.music) return;
      if (modified) await send({ type: 'openVideo', videoId, active: false });
      else navigate(a, videoId);
    } catch (e) {
      console.warn('Queue First: could not check', videoId, e);
    }
  };

  const useSkip = async (videoId: string, a: HTMLAnchorElement): Promise<void> => {
    if (lock.busy) return;
    lock.busy = true;
    lock.refresh();
    try {
      const r = await send<SkipResult>({ type: 'skip', videoId, requestId: requestId() });
      if (r.status === 'music' || r.status === 'granted') {
        lock.setSkipMode(false);
        navigate(a, videoId);
      } else {
        console.warn('Queue First: skip not used:', r.reason);
      }
    } catch (e) {
      console.warn('Queue First: skip not used', e);
    } finally {
      lock.busy = false;
      deps.onPolicyChange();
    }
  };

  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);
}
