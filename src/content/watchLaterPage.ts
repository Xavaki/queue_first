// Native Watch Later page. No separate UI: Watch Later lists oldest first,
// the sort control is disabled (CSS) so that order stays, and every row except
// the oldest nonmusic video is shaded. Clicking the oldest row plays it.

import { WL_ORDER_CONTROLS, WL_ROW, WL_ROW_LINK, WL_ROW_META } from '../adapters/youtube/selectors';
import { videoIdFromHref, watchUrl } from '../shared/ids';
import type { LaunchResult, RowStatus, WlState } from '../shared/messages';
import { requestId, send } from './api';
import { createHost, h } from './ui';

const PAGE_ATTR = 'data-queue-first-wl';
const ROW_ATTR = 'data-queue-first-row';
const BADGE_ATTR = 'data-queue-first-badge';
const LOCKED_CONTROL_ATTR = 'data-queue-first-locked';
const ORDER_LOCK_TITLE = 'Queue First keeps Watch Later oldest first';

/** Swallows interaction with order controls before YouTube handles it. */
function blockOrderControls(ev: Event): void {
  const hit = ev.composedPath().some((n) => n instanceof Element && n.matches(WL_ORDER_CONTROLS));
  if (!hit) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
}

const BLOCKED_EVENTS = ['click', 'mousedown', 'pointerdown', 'keydown', 'dragstart', 'touchstart'];

const BADGE_CSS = `
:host { display: block; margin-top: .6rem; }
.badge { display: inline-flex; gap: .8rem; align-items: center; flex-wrap: wrap; font-size: 1.2rem; }
.pill { background: var(--qf-accent); color: var(--qf-accent-fg); border-radius: 1rem; padding: .2rem .8rem; font-weight: 500; cursor: pointer; }
button { font-size: 1.2rem; padding: .2rem .8rem; }
`;

export function rowVideoId(row: Element): string | null {
  const a = row.querySelector<HTMLAnchorElement>(WL_ROW_LINK);
  return a ? videoIdFromHref(a.href) : null;
}

export class WatchLaterPage {
  private state: WlState | null = null;
  private observer: MutationObserver | null = null;
  private rowCount = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private launching = false;
  /** Inline status next to the head's "Up next" pill (replaces toasts). */
  private launchNote = '';
  private frame = 0;

  isActive(): boolean {
    return this.observer !== null;
  }

  start(): void {
    if (this.observer) return;
    document.documentElement.setAttribute(PAGE_ATTR, '');
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, blockOrderControls, true);
    this.observer = new MutationObserver(() => this.onMutation());
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    void this.load(true);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    document.documentElement.removeAttribute(PAGE_ATTR);
    for (const type of BLOCKED_EVENTS) window.removeEventListener(type, blockOrderControls, true);
    for (const el of document.querySelectorAll<HTMLElement>(`[${LOCKED_CONTROL_ATTR}]`)) {
      el.inert = false;
      el.removeAttribute('aria-disabled');
      el.removeAttribute(LOCKED_CONTROL_ATTR);
    }
    for (const row of document.querySelectorAll(`[${ROW_ATTR}]`)) row.removeAttribute(ROW_ATTR);
    for (const b of document.querySelectorAll(`[${BADGE_ATTR}]`)) b.remove();
  }

  /** Row status for interception; null while the page state is unknown. */
  statusOf(videoId: string): RowStatus | null {
    if (!this.state || this.state.init !== 'ready') return null;
    return this.state.rows[videoId] ?? 'locked';
  }

  async load(refresh: boolean): Promise<void> {
    try {
      this.state = await send<WlState>({ type: 'wlState', refresh });
    } catch (e) {
      console.warn('Queue First: could not read Watch Later', e);
      return;
    }
    const s = this.state;
    if (s.error && s.error !== 'account_unknown') console.warn('Queue First: Watch Later read failed:', s.error);
    this.apply();
  }

  private onMutation(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.sync();
    });
  }

  private sync(): void {
    const rows = document.querySelectorAll(WL_ROW);
    // A row removed through YouTube's own menu: resync membership.
    if (rows.length < this.rowCount) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.load(true), 1500);
    }
    this.rowCount = rows.length;
    this.apply();
  }

  private apply(): void {
    this.lockOrderControls();
    const s = this.state;
    for (const row of document.querySelectorAll(WL_ROW)) {
      const id = rowVideoId(row);
      const status: RowStatus = id && s?.init === 'ready' ? (s.rows[id] ?? 'locked') : 'locked';
      if (row.getAttribute(ROW_ATTR) !== status) row.setAttribute(ROW_ATTR, status);
      const label =
        status === 'head' ? 'Oldest video: click to play' :
        status === 'music' ? 'Music: plays freely' :
        status === 'unavailable' ? 'Unavailable' :
        'Locked: watch the oldest video first';
      if (row.getAttribute('title') !== label) row.setAttribute('title', label);
      this.renderBadge(row, id, status);
    }
  }

  /** The sort menu and drag handles become inert: no clicks, focus, or keys. */
  private lockOrderControls(): void {
    for (const el of document.querySelectorAll<HTMLElement>(WL_ORDER_CONTROLS)) {
      if (el.hasAttribute(LOCKED_CONTROL_ATTR)) continue;
      el.setAttribute(LOCKED_CONTROL_ATTR, '');
      el.inert = true;
      el.setAttribute('aria-disabled', 'true');
      el.title = ORDER_LOCK_TITLE;
    }
  }

  private renderBadge(row: Element, videoId: string | null, status: RowStatus): void {
    const existing = row.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
    const want = status === 'head';
    if (!want || !videoId) {
      existing?.remove();
      return;
    }
    const key = `${videoId}:${status}:${this.launchNote}`;
    if (existing?.getAttribute(BADGE_ATTR) === key) return;
    existing?.remove();
    const { host, root } = createHost(BADGE_CSS);
    host.setAttribute(BADGE_ATTR, key);
    // The pill is part of the row: clicking it starts the video too, and the
    // click never reaches YouTube's own row navigation.
    host.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.isTrusted) void this.launch(videoId);
    });
    const content = [h('span', { class: 'pill' }, 'Up next'), this.launchNote ? h('span', { class: 'muted' }, this.launchNote) : null];
    root.append(h('div', { class: 'badge' }, ...content));
    (row.querySelector(WL_ROW_META) ?? row).append(host);
  }

  /** Starts the oldest video: the background mints a grant for this tab first. */
  async launch(videoId: string): Promise<void> {
    if (this.launching) return;
    this.launching = true;
    this.note('Starting…');
    try {
      const r = await send<LaunchResult>({ type: 'launch', videoId, requestId: requestId() });
      if (r.status === 'granted') {
        location.assign(watchUrl(r.videoId));
        return;
      }
      console.warn('Queue First: cannot start this video:', r.reason);
      this.note(r.reason);
      await this.load(false);
    } catch (e) {
      console.warn('Queue First: cannot start this video', e);
      this.note(`Could not start: ${(e as Error).message}`);
    } finally {
      this.launching = false;
    }
  }

  private note(text: string): void {
    this.launchNote = text;
    this.apply();
  }
}
