// Pure playback policy: decides whether a video may play in a tab given the
// account, queue, classification, and live grants.

import { findActive, effectiveCategory, queueView } from './ledger';
import type {
  AccountState,
  Category,
  Grant,
  PlaybackDecision,
} from '../shared/types';

export interface PlaybackInput {
  videoId: string;
  tabId: number;
  loggedIn: boolean;
  /** Validated account scope for the tab, or null when unknown. */
  accountKey: string | null;
  account: AccountState | null;
  /** Classification result, or 'PENDING' while unresolved. */
  category: Category | 'PENDING';
  grants: Grant[];
}

export function findGrant(
  grants: Grant[],
  tabId: number,
  videoId: string,
  accountKey: string | null,
): Grant | undefined {
  return grants.find(
    (g) =>
      g.tabId === tabId &&
      g.videoId === videoId &&
      // Ordinary grants are bound to the account; skip grants to the profile.
      (g.kind === 'skip' || (accountKey !== null && g.accountKey === accountKey)),
  );
}

export function decidePlayback(input: PlaybackInput): PlaybackDecision {
  const { videoId, account } = input;
  const view = account && account.init === 'ready' ? queueView(account) : null;
  const entry = account ? findActive(account, videoId) : undefined;
  const category: Category | 'PENDING' =
    account?.musicOverrides[videoId] ? 'MUSIC' : entry && account ? mergeCategory(effectiveCategory(account, entry), input.category) : input.category;

  const base: PlaybackDecision = {
    videoId,
    allowed: false,
    kind: null,
    category,
    queueSize: view?.eligible.length ?? 0,
    head: view?.head ? { videoId: view.head.videoId, title: view.head.title } : null,
  };
  if (view && entry) {
    const pos = view.eligible.findIndex((e) => e.entryId === entry.entryId);
    if (pos >= 0) base.position = pos + 1;
  }

  // Music is exempt everywhere, even when Watch Later access fails.
  if (category === 'MUSIC') return { ...base, allowed: true, kind: 'music' };

  const grant = findGrant(input.grants, input.tabId, videoId, input.accountKey);
  if (grant?.kind === 'skip') return { ...base, allowed: true, kind: 'skip' };
  if (grant?.kind === 'ordinary') {
    return { ...base, allowed: true, kind: 'ordinary' };
  }

  if (category === 'PENDING') return { ...base, reason: 'classifying' };
  if (!input.loggedIn) return { ...base, reason: 'signed_out' };
  if (!input.accountKey || !account) return { ...base, reason: 'account_unknown' };
  if (!view) return { ...base, reason: 'not_initialized' };
  if (!entry) return { ...base, reason: 'not_queued' };
  if (entry.status === 'unavailable') return { ...base, reason: 'unavailable' };
  if (view.head?.entryId !== entry.entryId) return { ...base, reason: 'queued_not_head' };
  if (entry.sync !== 'confirmed') return { ...base, reason: 'head_unconfirmed' };
  return { ...base, reason: 'head_needs_launch' };
}

/** Prefer a resolved classification over a ledger placeholder. */
function mergeCategory(ledger: Category | 'PENDING', fresh: Category | 'PENDING'): Category | 'PENDING' {
  if (fresh !== 'PENDING') return fresh;
  return ledger;
}

export type LaunchCheck =
  | { ok: true; entryId: string }
  | { ok: false; reason: 'not_initialized' | 'empty' | 'not_head' | 'head_unconfirmed' | 'head_is_music' };

/** Whether an ordinary launch grant may be minted for `videoId`. */
export function checkLaunch(account: AccountState | null, videoId: string): LaunchCheck {
  if (!account || account.init !== 'ready') return { ok: false, reason: 'not_initialized' };
  const view = queueView(account);
  if (!view.head) return { ok: false, reason: 'empty' };
  if (view.head.videoId !== videoId) return { ok: false, reason: 'not_head' };
  if (view.head.sync !== 'confirmed') return { ok: false, reason: 'head_unconfirmed' };
  return { ok: true, entryId: view.head.entryId };
}

export const BLOCK_MESSAGES: Record<NonNullable<PlaybackDecision['reason']>, string> = {
  classifying: 'Checking whether this is music…',
  signed_out: 'Sign in to YouTube to use your Watch Later queue.',
  account_unknown: 'Queue First could not identify your YouTube account yet.',
  not_initialized: 'Queue First is not set up for this account. Open Watch Later to set it up.',
  not_queued: 'This video is not in your queue. Videos play from Watch Later, oldest first.',
  queued_not_head: 'This video is queued behind older videos. Watch the oldest one first.',
  head_needs_launch: 'This is your oldest video. Start it from Watch Later.',
  head_unconfirmed: 'This video has not been confirmed in Watch Later yet. Retry the save from Watch Later.',
  unavailable: 'YouTube reports this video as unavailable.',
};
