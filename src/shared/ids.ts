// Video ID and route parsing. Resolves the actual video independently of
// playlist, index, timestamp, or tracking parameters.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID_RE.test(value);
}

export type RouteKind = 'home' | 'watch' | 'shorts' | 'live' | 'watch_later' | 'other';

export interface Route {
  kind: RouteKind;
  videoId: string | null;
}

const YT_HOSTS = new Set(['www.youtube.com', 'youtube.com']);

export function parseRoute(href: string, base = 'https://www.youtube.com/'): Route {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return { kind: 'other', videoId: null };
  }
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0] ?? '';
    return isVideoId(id) ? { kind: 'watch', videoId: id } : { kind: 'other', videoId: null };
  }
  if (!YT_HOSTS.has(url.hostname)) return { kind: 'other', videoId: null };

  const path = url.pathname;
  if (path === '/' || path === '') return { kind: 'home', videoId: null };
  if (path === '/watch') {
    const id = url.searchParams.get('v');
    return isVideoId(id) ? { kind: 'watch', videoId: id } : { kind: 'other', videoId: null };
  }
  const seg = path.split('/').filter(Boolean);
  if ((seg[0] === 'shorts' || seg[0] === 'live') && isVideoId(seg[1])) {
    return { kind: seg[0], videoId: seg[1] };
  }
  if (path === '/playlist' && url.searchParams.get('list') === 'WL') {
    return { kind: 'watch_later', videoId: null };
  }
  return { kind: 'other', videoId: null };
}

/** Video ID for a link target, or null when the link is not a video. */
export function videoIdFromHref(href: string, base?: string): string | null {
  const route = parseRoute(href, base);
  return route.kind === 'watch' || route.kind === 'shorts' || route.kind === 'live'
    ? route.videoId
    : null;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function newId(): string {
  return crypto.randomUUID();
}
