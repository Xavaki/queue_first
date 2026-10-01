// Metadata adapter: classifies one requested video from its own watch-page
// player metadata, fetched without starting a player.

import { PARSER_VERSION, parseWatchHtml } from '../adapters/youtube/parsers';
import { transact } from './store';
import type { Classification } from '../shared/types';

const CACHE_TTL_MS = 24 * 3600_000;
const FETCH_TIMEOUT_MS = 8_000;
const RETRIES = 1;

const inflight = new Map<string, Promise<Classification>>();

export function cacheValid(c: Classification | undefined, now: number): c is Classification {
  return (
    !!c &&
    c.parserVersion === PARSER_VERSION &&
    now - c.at < CACHE_TTL_MS &&
    c.source === 'player_microformat'
  );
}

async function fetchOnce(videoId: string): Promise<Classification> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const now = Date.now();
  try {
    // hl=en asks for a consistent language; parsing still accepts localized names.
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      credentials: 'include',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = parseWatchHtml(await res.text(), videoId);
    if (!meta) {
      return { videoId, category: 'UNKNOWN', rawCategory: null, source: 'error', parserVersion: PARSER_VERSION, at: now, availability: 'unknown' };
    }
    return {
      videoId,
      category: meta.category,
      rawCategory: meta.rawCategory,
      source: meta.rawCategory ? 'player_microformat' : 'error',
      parserVersion: PARSER_VERSION,
      at: now,
      title: meta.title,
      lengthSeconds: meta.lengthSeconds,
      isLive: meta.isLive,
      availability: meta.availability,
      ...(meta.unavailableReason ? { unavailableReason: meta.unavailableReason } : {}),
    };
  } catch (e) {
    const timedOut = (e as Error).name === 'AbortError';
    return {
      videoId,
      category: 'UNKNOWN',
      rawCategory: null,
      source: timedOut ? 'timeout' : 'error',
      parserVersion: PARSER_VERSION,
      at: now,
      availability: 'unknown',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(videoId: string): Promise<Classification> {
  let result = await fetchOnce(videoId);
  for (let i = 0; i < RETRIES && result.source === 'error' && !result.rawCategory; i++) {
    await new Promise((r) => setTimeout(r, 500));
    result = await fetchOnce(videoId);
  }
  return result;
}

/**
 * Returns the classification for `videoId`, from cache when valid. Requests
 * are deduplicated by video ID. Failures are UNKNOWN and are not cached.
 */
export async function classify(videoId: string, opts: { force?: boolean } = {}): Promise<Classification> {
  if (!opts.force) {
    const cached = await transact((tx) => tx.durable.categoryCache[videoId]);
    if (cacheValid(cached, Date.now())) return cached;
  }
  const existing = inflight.get(videoId);
  if (existing) return existing;
  const p = fetchWithRetry(videoId)
    .then(async (c) => {
      if (c.source === 'player_microformat') {
        await transact((tx) => {
          tx.durable.categoryCache[videoId] = c;
          pruneCache(tx.durable.categoryCache, tx.now);
          tx.dirty();
        });
      }
      return c;
    })
    .finally(() => inflight.delete(videoId));
  inflight.set(videoId, p);
  return p;
}

function pruneCache(cache: Record<string, Classification>, now: number): void {
  for (const [id, c] of Object.entries(cache)) {
    if (!cacheValid(c, now)) delete cache[id];
  }
}
