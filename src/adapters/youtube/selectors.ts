// YouTube DOM selectors, centralized so layout changes are repaired here
// without touching policy.

/** Homepage video cards. */
export const HOME_CARD = 'ytd-rich-item-renderer';

/** The featured video (trailer) above a channel's video list, with its own inline player. */
export const CHANNEL_FEATURED_VIDEO = 'ytd-channel-video-player-renderer';

/** The inline player inside the featured video; made unclickable on locked pages. */
export const CHANNEL_FEATURED_PLAYER = `${CHANNEL_FEATURED_VIDEO} #player-container`;

/**
 * Video cards and rows on browsing surfaces (homepage, search, channels,
 * watch-page sidebar, playlists). Shaded and locked outside Watch Later.
 */
export const VIDEO_CARD = [
  HOME_CARD,
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
  'ytd-playlist-panel-video-renderer',
  'ytd-reel-item-renderer',
  'yt-lockup-view-model',
  'ytm-shorts-lockup-view-model',
  CHANNEL_FEATURED_VIDEO,
].join(', ');

/** A card's ⋮ menu, which stays usable on locked cards (Save to Watch Later). */
export const CARD_MENU = [
  '#menu',
  'ytd-menu-renderer',
  // Lockup cards (homepage, watch sidebar). YouTube moved these classes
  // from BEM to camelCase; keep both spellings.
  '.ytLockupMetadataViewModelMenuButton',
  '.yt-lockup-metadata-view-model__menu-button',
  '.shortsLockupViewModelHostOutsideMetadataMenu',
  '.shortsLockupViewModelHostMetadataMenu',
].join(', ');

/** Links to a video inside a card. */
export const VIDEO_LINK = 'a[href*="/watch?v="], a[href^="/shorts/"], a[href*="/live/"]';

/** Title text inside a card or row. */
export const CARD_TITLE = '#video-title, h3 a[title], .yt-lockup-metadata-view-model__title, a#video-title-link';

/** The selected filter chip in a feed's chip bar (e.g. the homepage "Music" chip). */
export const SELECTED_CHIP = [
  'yt-chip-cloud-chip-renderer[selected]',
  'yt-chip-cloud-chip-renderer.iron-selected',
  'yt-chip-cloud-chip-renderer[aria-selected="true"]',
  'chip-view-model button[aria-selected="true"]',
  'chip-shape button[aria-selected="true"]',
].join(', ');

/** Channel links inside a card (name and avatar), which stay usable on locked cards. */
export const CHANNEL_LINK = ['a[href^="/@"]', 'a[href^="/channel/"]', 'a[href^="/c/"]', 'a[href^="/user/"]'].join(', ');

/** YouTube's Music destination page (Explore → Music). */
export const MUSIC_DESTINATION_PATHS = ['/channel/UC-9-kyTW8ZkZNDHQJ6FgpwQ'];

/** The main watch-page player (also hosts the miniplayer). */
export const MAIN_PLAYER = '#movie_player';

/** Shorts players. */
export const SHORTS_PLAYER = '#shorts-player, ytd-reel-video-renderer';

/** Hover/inline preview players and containers. */
export const PREVIEW_CONTAINER = 'ytd-video-preview, #video-preview, #inline-preview-player, #inline-player';

/** Any YouTube HTML5 player root (main, Shorts, previews, channel trailers). */
export const ANY_PLAYER = '.html5-video-player';

/** Where to mount the blocked-video overlay on watch/live and Shorts pages. */
export const WATCH_OVERLAY_MOUNT = '#movie_player';
export const SHORTS_OVERLAY_MOUNT = 'ytd-reel-video-renderer[is-active] #player-container, #shorts-player';

/** YouTube sets this attribute on <html> in dark mode. */
export const DARK_ATTR = 'dark';

/** Client-side navigation started event (fires on click, before the URL changes). */
export const NAVIGATE_START_EVENT = 'yt-navigate-start';

/** Client-side navigation finished event. */
export const NAVIGATE_FINISH_EVENT = 'yt-navigate-finish';

// ---------------------------------------------------------------------------
// Watch Later page (/playlist?list=WL)

/** One video row in the native playlist. */
export const WL_ROW = 'ytd-playlist-video-renderer';

/** Link inside a row that identifies its video. */
export const WL_ROW_LINK = 'a#video-title, a#thumbnail, a[href*="/watch?v="]';

/** Metadata column inside a row, where the head badge is mounted. */
export const WL_ROW_META = '#meta';

/**
 * Controls that change Watch Later order: the sort menu and the drag handles
 * on each row. Made inert on the Watch Later page; content.css dims the same
 * elements (keep both in sync).
 */
export const WL_ORDER_CONTROLS = [
  // Current layout: a chip in the chip bar whose button is a combobox
  // labelled with the active sort, e.g. "Date added (oldest)".
  'chip-view-model button[role="combobox"]',
  // Older layouts.
  'yt-sort-filter-sub-menu-renderer',
  'yt-sort-filter-header-renderer',
  'ytd-playlist-video-list-renderer yt-dropdown-menu',
  'ytd-playlist-video-renderer #reorder',
].join(', ');
