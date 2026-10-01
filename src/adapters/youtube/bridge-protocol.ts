// Message protocol between the isolated content script and the main-world
// bridge. The bridge exposes only these fixed operations.

import { isVideoId } from '../../shared/ids';
import type { Snapshot } from '../../shared/types';
import type { PlayerMeta } from './parsers';

export const TO_BRIDGE = 'queue-first:to-bridge';
export const FROM_BRIDGE = 'queue-first:from-bridge';

export type BridgeRequest =
  | { op: 'account' }
  | { op: 'wl.snapshot' }
  | { op: 'wl.has'; videoId: string }
  | { op: 'wl.add'; videoId: string }
  | { op: 'player.meta'; videoId: string };

export interface BridgeResults {
  account: { loggedIn: boolean; datasyncId: string | null };
  'wl.snapshot': Snapshot;
  'wl.has': { present: boolean | null };
  'wl.add': { ok: boolean };
  'player.meta': PlayerMeta | null;
}

export interface BridgeEnvelope {
  channel: typeof TO_BRIDGE;
  opId: string;
  request: BridgeRequest;
}

export interface BridgeReply {
  channel: typeof FROM_BRIDGE;
  opId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function isBridgeRequest(r: unknown): r is BridgeRequest {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  switch (o.op) {
    case 'account':
    case 'wl.snapshot':
      return true;
    case 'wl.has':
    case 'wl.add':
    case 'player.meta':
      return isVideoId(o.videoId);
    default:
      return false;
  }
}

/** Shape checks for replies; page-originated data is untrusted. */
export function validateResult(op: BridgeRequest['op'], v: unknown): boolean {
  const o = v as Record<string, unknown> | null;
  switch (op) {
    case 'account':
      return !!o && typeof o.loggedIn === 'boolean' && (o.datasyncId === null || typeof o.datasyncId === 'string');
    case 'wl.snapshot':
      return (
        !!o &&
        typeof o.complete === 'boolean' &&
        typeof o.pages === 'number' &&
        Array.isArray(o.items) &&
        o.items.every(
          (i: Record<string, unknown>) =>
            i && isVideoId(i.videoId) && typeof i.title === 'string' && typeof i.playable === 'boolean',
        )
      );
    case 'wl.has':
      return !!o && (o.present === null || typeof o.present === 'boolean');
    case 'wl.add':
      return !!o && typeof o.ok === 'boolean';
    case 'player.meta':
      return o === null || (!!o && isVideoId(o.videoId) && typeof o.category === 'string');
  }
}
