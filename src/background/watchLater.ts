// Watch Later adapter. The background cannot reach YouTube's authenticated
// website actions directly, so it relays fixed operations through a YouTube
// tab's content script to the main-world bridge. Replaceable behind this
// interface.

import type { BridgeRequest, BridgeResults } from '../adapters/youtube/bridge-protocol';
import type { Snapshot } from '../shared/types';
import type { ToContent } from '../shared/messages';

export interface WatchLaterAdapter {
  snapshot(): Promise<Snapshot>;
  /** true/false when membership is known, null when it could not be determined. */
  has(videoId: string): Promise<boolean | null>;
  /** Resolves true only after membership is confirmed. */
  add(videoId: string): Promise<boolean>;
}

const TIMEOUTS: Record<BridgeRequest['op'], number> = {
  account: 15_000,
  'wl.snapshot': 120_000,
  'wl.has': 20_000,
  'wl.add': 45_000,
  'player.meta': 5_000,
};

export async function bridgeCall<K extends BridgeRequest['op']>(
  tabId: number,
  request: Extract<BridgeRequest, { op: K }>,
): Promise<BridgeResults[K]> {
  const msg: ToContent = { type: 'bridge', request };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${request.op} timed out`)), TIMEOUTS[request.op]);
  });
  try {
    return (await Promise.race([browser.tabs.sendMessage(tabId, msg), timeout])) as BridgeResults[K];
  } finally {
    clearTimeout(timer);
  }
}

export function tabAdapter(tabId: number): WatchLaterAdapter {
  return {
    async snapshot() {
      try {
        return await bridgeCall(tabId, { op: 'wl.snapshot' });
      } catch (e) {
        return { complete: false, items: [], pages: 0, error: String((e as Error).message) };
      }
    },
    async has(videoId) {
      try {
        return (await bridgeCall(tabId, { op: 'wl.has', videoId })).present;
      } catch {
        return null;
      }
    },
    async add(videoId) {
      try {
        return (await bridgeCall(tabId, { op: 'wl.add', videoId })).ok;
      } catch {
        return false;
      }
    },
  };
}

/** Any open YouTube tab usable for background retries, preferring `preferred`. */
export async function anyYouTubeTab(preferred?: number): Promise<number | null> {
  if (preferred !== undefined) return preferred;
  const tabs = await browser.tabs.query({ url: '*://www.youtube.com/*', discarded: false });
  return tabs.find((t) => t.id !== undefined && t.status === 'complete')?.id ?? tabs[0]?.id ?? null;
}
