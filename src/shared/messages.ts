// Runtime messages to the background controller. Every message is validated
// before it is acted on; senders are untrusted.

import { isVideoId } from './ids';
import type { PlaybackDecision, Category } from './types';
import type { BridgeRequest } from '../adapters/youtube/bridge-protocol';

export interface TabAccount {
  loggedIn: boolean;
  accountKey: string | null;
}

export type Message =
  | { type: 'hello'; account: TabAccount }
  | { type: 'getState' }
  | { type: 'evaluate'; videoId: string }
  | { type: 'classify'; videoId: string }
  | { type: 'enqueue'; videoId: string; title: string; requestId: string }
  | { type: 'skip'; videoId: string; requestId: string }
  | { type: 'launch'; videoId: string; requestId: string }
  | { type: 'wlState'; refresh: boolean }
  | { type: 'openVideo'; videoId: string; active: boolean }
  | { type: 'popupState' }
  | { type: 'openWatchLater' }
  | { type: 'settingsState' }
  | { type: 'setTimezone'; timezone: string }
  | { type: 'addMusicOverride'; videoId: string }
  | { type: 'removeMusicOverride'; videoId: string }
  | { type: 'clearCategoryCache' }
  | { type: 'diagnostics' };

export type ToContent =
  | { type: 'bridge'; request: BridgeRequest }
  | { type: 'stateChanged' };

const str = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max;
const reqId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
export function isMessage(m: unknown): m is Message {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'hello': {
      const a = o.account as Record<string, unknown> | undefined;
      return (
        !!a &&
        typeof a.loggedIn === 'boolean' &&
        (a.accountKey === null || (typeof a.accountKey === 'string' && /^[0-9a-f]{16,64}$/.test(a.accountKey)))
      );
    }
    case 'getState':
    case 'popupState':
    case 'openWatchLater':
    case 'settingsState':
    case 'clearCategoryCache':
    case 'diagnostics':
      return true;
    case 'wlState':
      return typeof o.refresh === 'boolean';
    case 'evaluate':
    case 'classify':
      return isVideoId(o.videoId);
    case 'enqueue':
      return isVideoId(o.videoId) && str(o.title) && reqId(o.requestId);
    case 'skip':
    case 'launch':
      return isVideoId(o.videoId) && reqId(o.requestId);
    case 'openVideo':
      return isVideoId(o.videoId) && typeof o.active === 'boolean';
    case 'setTimezone':
      return str(o.timezone, 100);
    case 'addMusicOverride':
    case 'removeMusicOverride':
      return isVideoId(o.videoId);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Replies

export interface ContentState {
  loggedIn: boolean;
  accountKey: string | null;
  init: 'uninitialized' | 'ready' | 'no_account';
  skipsRemaining: number;
  queuedVideoIds: string[];
  head: { videoId: string; title: string } | null;
  queueSize: number;
}

export type EnqueueResult =
  | { status: 'music' }
  | { status: 'added' | 'already_queued'; category: Category; position: number }
  | { status: 'failed'; error: string }
  | { status: 'refused'; reason: 'signed_out' | 'not_initialized' | 'account_unknown' | 'conflict' };

/** Whether a clicked video may play freely as music. */
export interface ClassifyResult {
  music: boolean;
  category: Category;
}

export type SkipResult =
  | { status: 'music' }
  | { status: 'granted'; remaining: number }
  | {
      status: 'refused';
      reason:
        | 'no_skips'
        | 'already_queued'
        | 'membership_unresolved'
        | 'not_homepage'
        | 'signed_out'
        | 'conflict';
    };

export type LaunchResult =
  | { status: 'granted'; videoId: string }
  | { status: 'refused'; reason: string };

/** How a Watch Later row is presented on the native page. */
export type RowStatus = 'head' | 'locked' | 'music' | 'unavailable';

export interface WlState {
  loggedIn: boolean;
  init: ContentState['init'];
  head: { videoId: string; title: string } | null;
  /** Status by video ID. Rows not listed are treated as locked. */
  rows: Record<string, RowStatus>;
  error?: string;
}

export interface PopupState {
  protection: 'active' | 'signed_out' | 'setup_needed' | 'unknown';
  queueSize: number;
  head: { videoId: string; title: string } | null;
  skipsRemaining: number;
  timezone: string;
  nextReset: string;
}

export type { PlaybackDecision };
