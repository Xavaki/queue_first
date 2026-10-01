// Playback guard. Enforces by video ID: every media element is paused and
// muted until the background authorizes the video it is playing. Covers
// initial load, client-side navigation, player replacement, miniplayer,
// hover previews, autoplay, end screens, and media keys (all surface as
// media events on some element).

import {
  ANY_PLAYER,
  MAIN_PLAYER,
  PREVIEW_CONTAINER,
  SHORTS_OVERLAY_MOUNT,
  WATCH_OVERLAY_MOUNT,
} from '../adapters/youtube/selectors';
import { BLOCK_MESSAGES } from '../policy/engine';
import { isVideoId, type Route } from '../shared/ids';
import type { EnqueueResult } from '../shared/messages';
import type { PlaybackDecision } from '../shared/types';
import { requestId, send } from './api';
import { createHost, h } from './ui';

const GATE_ATTR = 'data-queue-first-gate';
const WATCH_LATER_URL = '/playlist?list=WL';
const MEDIA_EVENTS = ['play', 'playing', 'loadeddata', 'timeupdate', 'volumechange'];

interface MediaContext {
  kind: 'preview' | 'main' | 'other';
  /** Video IDs that must all be authorized for this element to play. */
  required: string[];
  /** ID the background should evaluate (the page's active video), if any. */
  evalId: string | null;
  player: Element | null;
}

function playerVideoId(player: Element | null): string | null {
  if (!player) return null;
  try {
    // Firefox X-ray waiver: synchronous read of the player's current video.
    const raw = (player as unknown as { wrappedJSObject?: { getVideoData?: () => { video_id?: unknown } } })
      .wrappedJSObject;
    const id = raw?.getVideoData?.()?.video_id;
    return isVideoId(id) ? id : null;
  } catch {
    return null;
  }
}

function isVideoRoute(r: Route): boolean {
  return r.kind === 'watch' || r.kind === 'shorts' || r.kind === 'live';
}

export class Guard {
  private decisions = new Map<string, PlaybackDecision>();
  private evaluating = new Map<string, Promise<void>>();
  private mutedByUs = new WeakSet<HTMLMediaElement>();
  private resumeWanted = new WeakSet<HTMLMediaElement>();
  private overlay = createHost(OVERLAY_CSS);
  private banner = createHost(BANNER_CSS);

  constructor(
    private route: Route,
    private ready: Promise<void>,
  ) {}

  start(): void {
    for (const type of MEDIA_EVENTS) {
      document.addEventListener(type, (ev) => this.onMedia(ev), true);
    }
    this.applyGateAttr();
    setInterval(() => this.sweep(), 400);
  }

  setRoute(route: Route): void {
    this.route = route;
    this.applyGateAttr();
    const id = this.activeId();
    if (id) void this.ensureEval(id);
    this.render();
  }

  /** Policy changed elsewhere: re-evaluate the active video and drop the rest. */
  refresh(): void {
    const id = this.activeId();
    for (const k of [...this.decisions.keys()]) if (k !== id) this.decisions.delete(k);
    if (id) void this.ensureEval(id, true);
    else this.render();
  }

  decisionFor(videoId: string): PlaybackDecision | undefined {
    return this.decisions.get(videoId);
  }

  /** The video the page is about: route video, else the miniplayer's video. */
  activeId(): string | null {
    if (isVideoRoute(this.route)) return this.route.videoId;
    return playerVideoId(document.querySelector(MAIN_PLAYER));
  }

  private applyGateAttr(): void {
    const id = this.activeId();
    const allowed = id ? this.decisions.get(id)?.allowed === true : !isVideoRoute(this.route);
    if (allowed) document.documentElement.removeAttribute(GATE_ATTR);
    else document.documentElement.setAttribute(GATE_ATTR, '');
  }

  private context(el: HTMLMediaElement): MediaContext {
    if (el.closest(PREVIEW_CONTAINER)) return { kind: 'preview', required: [], evalId: null, player: null };
    const player = el.closest(ANY_PLAYER);
    const pid = playerVideoId(player);
    const isMain = !!player && (player.matches(MAIN_PLAYER) || player.id === 'shorts-player' || !!player.closest('ytd-reel-video-renderer'));
    if (isMain && isVideoRoute(this.route) && this.route.videoId) {
      const required = [this.route.videoId];
      if (pid && pid !== this.route.videoId) required.push(pid);
      return { kind: 'main', required, evalId: this.route.videoId, player };
    }
    if (isMain && player?.matches(MAIN_PLAYER)) {
      // Miniplayer on a browsing page.
      return { kind: 'main', required: pid ? [pid] : [], evalId: pid, player };
    }
    // Channel trailers and other embedded players: only already-authorized videos.
    return { kind: 'other', required: pid ? [pid] : [], evalId: null, player };
  }

  private allowed(ctx: MediaContext): boolean {
    return ctx.required.length > 0 && ctx.required.every((id) => this.decisions.get(id)?.allowed === true);
  }

  private block(el: HTMLMediaElement): void {
    if (!el.paused) el.pause();
    if (!el.muted) {
      el.muted = true;
      this.mutedByUs.add(el);
    }
  }

  private release(el: HTMLMediaElement): void {
    if (this.mutedByUs.has(el)) {
      this.mutedByUs.delete(el);
      el.muted = false;
    }
  }

  private onMedia(ev: Event): void {
    const el = ev.target;
    if (!(el instanceof HTMLMediaElement)) return;
    const ctx = this.context(el);
    if (ctx.kind === 'preview') {
      this.block(el);
      return;
    }
    if (!this.allowed(ctx)) {
      if (ev.type === 'play' || ev.type === 'playing') {
        if (ctx.kind === 'main') this.resumeWanted.add(el);
      }
      // YouTube re-applying volume must not unmute a blocked player.
      this.block(el);
      if (ctx.evalId) void this.ensureEval(ctx.evalId);
      return;
    }
    if (ev.type !== 'volumechange') this.release(el);
  }

  private sweep(): void {
    for (const el of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
      if (el.paused && el.muted) continue;
      const ctx = this.context(el);
      if (ctx.kind === 'preview' || !this.allowed(ctx)) {
        if (!el.paused) {
          this.block(el);
          if (ctx.evalId) void this.ensureEval(ctx.evalId);
        }
      }
    }
    // YouTube re-renders player containers; keep the overlay attached.
    const id = this.activeId();
    const d = id ? this.decisions.get(id) : undefined;
    if (isVideoRoute(this.route) && (!d || !d.allowed) && !this.overlayMounted()) this.render();
  }

  private ensureEval(videoId: string, force = false): Promise<void> {
    const existing = this.evaluating.get(videoId);
    if (existing) return existing;
    if (!force && this.decisions.has(videoId)) return Promise.resolve();
    const p = (async () => {
      this.render();
      try {
        await this.ready;
        const d = await send<PlaybackDecision>({ type: 'evaluate', videoId });
        this.decisions.set(videoId, d);
      } catch (e) {
        console.warn('Queue First: evaluate failed', e);
      } finally {
        this.evaluating.delete(videoId);
      }
      this.onDecision(videoId);
    })();
    this.evaluating.set(videoId, p);
    return p;
  }

  private onDecision(videoId: string): void {
    this.applyGateAttr();
    const d = this.decisions.get(videoId);
    for (const el of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
      const ctx = this.context(el);
      if (!ctx.required.includes(videoId)) continue;
      if (this.allowed(ctx)) {
        this.release(el);
        if (this.resumeWanted.has(el)) {
          this.resumeWanted.delete(el);
          void el.play().catch(() => undefined);
        }
      } else if (d && !d.allowed) {
        this.block(el);
      }
    }
    this.render();
  }

  // ---------------------------------------------------------------------------
  // Overlay (blocked) and banner (allowed)

  private overlayMounted(): boolean {
    return this.overlay.host.isConnected;
  }

  private render(): void {
    const id = this.activeId();
    const onVideo = isVideoRoute(this.route) && !!id;
    const d = id ? this.decisions.get(id) : undefined;
    if (!onVideo) {
      this.overlay.host.remove();
      this.banner.host.remove();
      return;
    }
    if (!d || !d.allowed) {
      this.banner.host.remove();
      this.renderOverlay(id!, d);
    } else {
      this.overlay.host.remove();
      this.renderBanner(id!, d);
    }
  }

  private renderOverlay(videoId: string, d: PlaybackDecision | undefined): void {
    const mountSel = this.route.kind === 'shorts' ? SHORTS_OVERLAY_MOUNT : WATCH_OVERLAY_MOUNT;
    const mount = document.querySelector(mountSel);
    const { host, root } = this.overlay;
    host.classList.toggle('fixed', !mount);
    const body: Array<Node | null> = [];
    if (!d) {
      body.push(h('p', { class: 'title' }, 'Checking this video…'));
    } else {
      const reason = d.reason ?? 'not_queued';
      body.push(h('p', { class: 'title' }, 'Locked by Queue First'));
      body.push(h('p', {}, BLOCK_MESSAGES[reason]));
      if (d.category === 'UNKNOWN') body.push(h('p', { class: 'muted' }, 'Could not verify whether this is music.'));
      if (d.position) body.push(h('p', { class: 'muted' }, `Queue position: ${d.position} of ${d.queueSize}.`));
      if (d.head && d.head.videoId !== videoId) {
        body.push(h('p', { class: 'muted' }, `Oldest in your queue: ${d.head.title || d.head.videoId}`));
      }
      const actions = h(
        'div',
        { class: 'row' },
        h('button', { class: 'primary', onclick: () => location.assign(WATCH_LATER_URL) }, 'Open Watch Later'),
      );
      if (reason === 'not_queued') {
        actions.append(
          h('button', { onclick: () => void this.addCurrent(videoId) }, 'Add to Watch Later'),
        );
      }
      if (d.category === 'UNKNOWN') {
        actions.append(h('button', { onclick: () => void this.ensureEval(videoId, true) }, 'Check again'));
      }
      body.push(actions);
    }
    const card = h('div', { class: 'card', role: 'alert' }, ...body);
    root.querySelector('.card')?.remove();
    root.append(card);
    if (mount && host.parentElement !== mount) mount.append(host);
    else if (!mount && !host.isConnected) document.body?.append(host);
  }

  /** Queues the blocked video; the overlay then shows its queue position. */
  private async addCurrent(videoId: string): Promise<void> {
    try {
      const title = document.title.replace(/ - YouTube$/, '');
      const r = await send<EnqueueResult>({ type: 'enqueue', videoId, title, requestId: requestId() });
      if (r.status === 'failed' || r.status === 'refused') console.warn('Queue First: not queued', r);
    } catch (e) {
      console.warn('Queue First: could not save to Watch Later', e);
    }
    this.refresh();
  }

  private renderBanner(videoId: string, d: PlaybackDecision): void {
    const { host, root } = this.banner;
    let content: Array<Node | null>;
    if (d.kind === 'music') {
      content = [h('span', {}, 'Music · exempt')];
    } else if (d.kind === 'skip') {
      content = [h('span', {}, 'Homepage skip used')];
    } else {
      content = [h('span', {}, 'Watching oldest')];
    }
    root.querySelector('.bar')?.remove();
    root.append(h('div', { class: 'bar', role: 'status', 'aria-label': 'Queue First' }, ...content));
    if (!host.isConnected) document.body?.append(host);
  }
}

const OVERLAY_CSS = `
:host { position: absolute; inset: 0; z-index: 2000; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.88); }
:host(.fixed) { position: fixed; top: 5.6rem; left: 0; right: 0; bottom: auto; background: none; padding: 1.6rem; }
.card { background: var(--qf-bg); color: var(--qf-fg); border-radius: 1.2rem; padding: 1.6rem 2rem; max-width: 48rem;
  margin: 1.6rem; box-shadow: var(--qf-shadow); display: flex; flex-direction: column; gap: .4rem; }
.card p { margin: 0; }
.title { font-size: 1.6rem; font-weight: 500; }
.row { margin-top: .8rem; }
`;

const BANNER_CSS = `
:host { position: fixed; top: 6.4rem; right: 2.4rem; z-index: 2147482000; }
.bar { background: var(--qf-bg); color: var(--qf-fg); border: 1px solid var(--qf-border); border-radius: 2rem;
  padding: .6rem 1.4rem; box-shadow: var(--qf-shadow); display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; max-width: 48rem; }
`;
