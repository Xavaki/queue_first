// YouTube website parsers. Everything here depends on undocumented website
// structures; keep it centralized so YouTube changes are repaired in one place.

import { isVideoId } from '../../shared/ids';
import type { Category, SnapshotItem } from '../../shared/types';

/** Bump when parsing changes; cached classifications from older parsers are discarded. */
export const PARSER_VERSION = 1;

// ---------------------------------------------------------------------------
// Player metadata (watch page HTML)

/**
 * Extracts the JSON object literal assigned to `varName` in a script, using a
 * string-aware brace matcher. Never evaluates code.
 */
export function extractJsonAssignment(html: string, varName: string): unknown | null {
  const markers = [`var ${varName} = `, `${varName} = `, `window["${varName}"] = `];
  for (const marker of markers) {
    let from = 0;
    for (;;) {
      const idx = html.indexOf(marker, from);
      if (idx < 0) break;
      from = idx + marker.length;
      const start = html.indexOf('{', from);
      if (start < 0 || start - from > 4) continue;
      const end = matchBrace(html, start);
      if (end < 0) continue;
      try {
        return JSON.parse(html.slice(start, end + 1));
      } catch {
        // Try the next occurrence.
      }
    }
  }
  return null;
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Canonical English category names YouTube uses in player microformat. */
const KNOWN_CATEGORIES = new Set([
  'Film & Animation',
  'Autos & Vehicles',
  'Music',
  'Pets & Animals',
  'Sports',
  'Travel & Events',
  'Gaming',
  'People & Blogs',
  'Comedy',
  'Entertainment',
  'News & Politics',
  'Howto & Style',
  'Education',
  'Science & Technology',
  'Nonprofits & Activism',
  'Short Movies',
  'Shows',
  'Trailers',
  'Movies',
]);

/** Localized names of the Music category, in case a response is not English. */
const MUSIC_NAMES = new Set([
  'Music',
  'Música',
  'Musique',
  'Musik',
  'Musica',
  'Muziek',
  'Muzyka',
  'Музыка',
  'Музика',
  'Müzik',
  'Musiikki',
  'Hudba',
  'Zene',
  'Μουσική',
  '音楽',
  '음악',
  '音乐',
  '音樂',
  'संगीत',
  'موسيقى',
  'מוזיקה',
  'ดนตรี',
  'Âm nhạc',
  'Muzik',
]);

/** Whether a label (category or chip text) names Music in a known language. */
export function isMusicName(s: string): boolean {
  return MUSIC_NAMES.has(s.trim());
}

/**
 * Maps a raw category string to MUSIC / NON_MUSIC / UNKNOWN. A string that is
 * neither a known English category nor a known Music name stays UNKNOWN:
 * it might be an unmapped localized "Music".
 */
export function canonicalCategory(raw: string | null | undefined): Category {
  if (!raw) return 'UNKNOWN';
  const s = raw.trim();
  if (MUSIC_NAMES.has(s)) return 'MUSIC';
  if (KNOWN_CATEGORIES.has(s)) return 'NON_MUSIC';
  return 'UNKNOWN';
}

export interface PlayerMeta {
  videoId: string;
  rawCategory: string | null;
  category: Category;
  title?: string;
  lengthSeconds?: number;
  isLive?: boolean;
  availability: 'available' | 'unavailable' | 'unknown';
  unavailableReason?: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Reads category and availability from a player response for `videoId` only. */
export function parsePlayerResponse(pr: unknown, videoId: string): PlayerMeta | null {
  const root = obj(pr);
  const details = obj(root?.videoDetails);
  const playability = obj(root?.playabilityStatus);
  const status = str(playability?.status);

  // Unavailable videos may have no videoDetails; accept only a positive error.
  if (!details) {
    if (status === 'ERROR' || status === 'UNPLAYABLE') {
      return {
        videoId,
        rawCategory: null,
        category: 'UNKNOWN',
        availability: 'unavailable',
        unavailableReason: str(playability?.reason) ?? status,
      };
    }
    return null;
  }
  if (details.videoId !== videoId) return null; // Guard against a recommended video's data.

  const micro = obj(obj(root?.microformat)?.playerMicroformatRenderer);
  const rawCategory = str(micro?.category) ?? null;
  const length = Number(str(details.lengthSeconds));
  let availability: PlayerMeta['availability'] = 'unknown';
  if (status === 'OK') availability = 'available';
  else if (status === 'ERROR' || status === 'UNPLAYABLE') availability = 'unavailable';

  return {
    videoId,
    rawCategory,
    category: canonicalCategory(rawCategory),
    title: str(details.title),
    lengthSeconds: Number.isFinite(length) ? length : undefined,
    isLive: details.isLiveContent === true || details.isLive === true,
    availability,
    ...(availability === 'unavailable'
      ? { unavailableReason: str(playability?.reason) ?? status }
      : {}),
  };
}

export function parseWatchHtml(html: string, videoId: string): PlayerMeta | null {
  const pr = extractJsonAssignment(html, 'ytInitialPlayerResponse');
  return pr ? parsePlayerResponse(pr, videoId) : null;
}

// ---------------------------------------------------------------------------
// Watch Later playlist (InnerTube browse responses)

function textOf(v: unknown): string {
  const o = obj(v);
  if (!o) return '';
  if (typeof o.simpleText === 'string') return o.simpleText;
  if (Array.isArray(o.runs)) return o.runs.map((r) => str(obj(r)?.text) ?? '').join('');
  if (typeof o.content === 'string') return o.content;
  return '';
}

export interface PlaylistPage {
  items: SnapshotItem[];
  continuation: string | null;
}

/**
 * Collects playlist video rows and the trailing continuation token from a
 * browse or continuation response, in document order.
 */
export function parsePlaylistPage(response: unknown): PlaylistPage {
  const items: SnapshotItem[] = [];
  let continuation: string | null = null;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const o = obj(node);
    if (!o) return;
    const pvr = obj(o.playlistVideoRenderer);
    if (pvr) {
      const videoId = str(pvr.videoId);
      if (isVideoId(videoId)) {
        const playable = pvr.isPlayable !== false;
        items.push({
          videoId,
          title: textOf(pvr.title),
          setVideoId: str(pvr.setVideoId),
          playable,
          ...(playable ? {} : { unavailableReason: textOf(pvr.title) || 'Unavailable' }),
        });
      }
      return;
    }
    const cir = obj(o.continuationItemRenderer);
    if (cir) {
      const token = str(
        obj(obj(cir.continuationEndpoint)?.continuationCommand)?.token,
      );
      if (token) continuation = token;
      return;
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };

  walk(response);
  return { items, continuation };
}

/** Watch Later membership from a playlist/get_add_to_playlist response. */
export function parseAddToPlaylist(response: unknown): boolean | null {
  let result: boolean | null = null;
  const walk = (node: unknown): void => {
    if (result !== null) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const o = obj(node);
    if (!o) return;
    const opt = obj(o.playlistAddToOptionRenderer);
    if (opt && opt.playlistId === 'WL') {
      const c = str(opt.containsSelectedVideos);
      if (c === 'ALL') result = true;
      else if (c === 'NONE') result = false;
      return;
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(response);
  return result;
}

/** Whether an edit_playlist response reports success. */
export function parseEditPlaylist(response: unknown): boolean {
  return str(obj(response)?.status) === 'STATUS_SUCCEEDED';
}

