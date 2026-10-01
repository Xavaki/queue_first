// Main-world bridge. Runs in YouTube's page context so authenticated website
// requests use the page's own session; credentials never leave this context.
// It is observable by the page and is NOT a trusted policy boundary: it only
// performs fixed playlist operations and metadata reads.

import {
  FROM_BRIDGE,
  TO_BRIDGE,
  isBridgeRequest,
  type BridgeEnvelope,
  type BridgeReply,
  type BridgeRequest,
} from './bridge-protocol';
import {
  parseAddToPlaylist,
  parseEditPlaylist,
  parsePlayerResponse,
  parsePlaylistPage,
} from './parsers';
import type { Snapshot, SnapshotItem } from '../../shared/types';

const MAX_PAGES = 300;
const REQUEST_TIMEOUT_MS = 15_000;

interface YtCfg {
  get?: (key: string) => unknown;
  data_?: Record<string, unknown>;
}

function cfg(key: string): unknown {
  const yc = (window as unknown as { ytcfg?: YtCfg }).ytcfg;
  if (!yc) return undefined;
  return yc.get ? yc.get(key) : yc.data_?.[key];
}

async function waitForCfg(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cfg('INNERTUBE_CONTEXT')) {
    if (Date.now() - start > timeoutMs) throw new Error('YouTube page configuration not available');
    await new Promise((r) => setTimeout(r, 200));
  }
}

function cookie(name: string): string | null {
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Builds the SAPISIDHASH-style Authorization header the website itself sends. */
async function authHeader(): Promise<string | null> {
  const origin = location.origin;
  const ts = Math.floor(Date.now() / 1000);
  const schemes: Array<[string, string | null]> = [
    ['SAPISIDHASH', cookie('SAPISID') ?? cookie('__Secure-3PAPISID')],
    ['SAPISID1PHASH', cookie('__Secure-1PAPISID')],
    ['SAPISID3PHASH', cookie('__Secure-3PAPISID')],
  ];
  const parts: string[] = [];
  for (const [scheme, value] of schemes) {
    if (!value) continue;
    parts.push(`${scheme} ${ts}_${await sha1Hex(`${ts} ${value} ${origin}`)}`);
  }
  return parts.length ? parts.join(' ') : null;
}

type Endpoint = 'browse' | 'browse/edit_playlist' | 'playlist/get_add_to_playlist';

/** Fixed-endpoint InnerTube request. No caller-controlled URLs. */
async function innertube(endpoint: Endpoint, body: Record<string, unknown>): Promise<unknown> {
  await waitForCfg();
  const context = cfg('INNERTUBE_CONTEXT') as Record<string, unknown>;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Origin': location.origin,
    'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? '0'),
    'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? '1'),
    'X-Youtube-Client-Version': String(cfg('INNERTUBE_CLIENT_VERSION') ?? ''),
  };
  const pageId = cfg('DELEGATED_SESSION_ID');
  if (typeof pageId === 'string') headers['X-Goog-PageId'] = pageId;
  const visitor = (context?.client as Record<string, unknown> | undefined)?.visitorData;
  if (typeof visitor === 'string') headers['X-Goog-Visitor-Id'] = visitor;
  const auth = await authHeader();
  if (auth) headers.Authorization = auth;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, ...body }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the whole Watch Later list in its native order (oldest first). */
async function snapshot(): Promise<Snapshot> {
  const items: SnapshotItem[] = [];
  let pages = 0;
  try {
    let page = parsePlaylistPage(await innertube('browse', { browseId: 'VLWL' }));
    for (;;) {
      pages++;
      items.push(...page.items);
      const token = page.continuation;
      if (!token) break;
      if (pages >= MAX_PAGES) return { complete: false, items, pages, error: 'Too many pages' };
      page = parsePlaylistPage(await innertube('browse', { continuation: token }));
    }
    return { complete: true, items, pages };
  } catch (e) {
    return { complete: false, items, pages, error: String((e as Error).message ?? e) };
  }
}

async function has(videoId: string): Promise<boolean | null> {
  const res = await innertube('playlist/get_add_to_playlist', {
    videoIds: [videoId],
    excludeWatchLater: false,
  });
  return parseAddToPlaylist(res);
}

/** Adds a video to Watch Later. The extension never removes videos. */
async function addToWatchLater(videoId: string): Promise<boolean> {
  const action = { action: 'ACTION_ADD_VIDEO', addedVideoId: videoId };
  const res = await innertube('browse/edit_playlist', { playlistId: 'WL', actions: [action] });
  return parseEditPlaylist(res);
}

function playerMeta(videoId: string) {
  const player = document.getElementById('movie_player') as
    | (HTMLElement & { getPlayerResponse?: () => unknown })
    | null;
  const pr = player?.getPlayerResponse?.();
  return pr ? parsePlayerResponse(pr, videoId) : null;
}

async function handle(req: BridgeRequest): Promise<unknown> {
  switch (req.op) {
    case 'account': {
      await waitForCfg().catch(() => undefined);
      const loggedIn = cfg('LOGGED_IN') === true;
      const ds = cfg('DATASYNC_ID');
      return { loggedIn, datasyncId: loggedIn && typeof ds === 'string' && ds ? ds : null };
    }
    case 'wl.snapshot':
      return snapshot();
    case 'wl.has':
      return { present: await has(req.videoId) };
    case 'wl.add': {
      // Never toggle blindly: skip the add when already present.
      if ((await has(req.videoId)) === true) return { ok: true };
      await addToWatchLater(req.videoId);
      return { ok: (await has(req.videoId)) === true };
    }
    case 'player.meta':
      return playerMeta(req.videoId);
  }
}

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const data = ev.data as BridgeEnvelope | undefined;
  if (!data || data.channel !== TO_BRIDGE || typeof data.opId !== 'string') return;
  if (!isBridgeRequest(data.request)) return;
  const reply = (r: Omit<BridgeReply, 'channel' | 'opId'>) =>
    window.postMessage({ channel: FROM_BRIDGE, opId: data.opId, ...r } satisfies BridgeReply, location.origin);
  handle(data.request).then(
    (result) => reply({ ok: true, result }),
    (e: unknown) => reply({ ok: false, error: String((e as Error)?.message ?? e) }),
  );
});
