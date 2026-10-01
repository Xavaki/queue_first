// Ordering ledger. The extension owns order; YouTube owns membership.
// All functions are pure: they take an AccountState and return a new one.

import type {
  AccountState,
  Category,
  QueueEntry,
  Snapshot,
  SyncStatus,
} from '../shared/types';

const MAX_HISTORY = 200;

export function createAccount(accountKey: string): AccountState {
  return {
    accountKey,
    init: 'uninitialized',
    nextSequence: 1,
    entries: [],
    musicOverrides: {},
    lastSnapshot: null,
    queueRevision: 0,
  };
}

function clone(a: AccountState): AccountState {
  return structuredClone(a);
}

export function effectiveCategory(a: AccountState, e: QueueEntry): Category | 'PENDING' {
  return a.musicOverrides[e.videoId] ? 'MUSIC' : e.category;
}

export function isEligible(a: AccountState, e: QueueEntry): boolean {
  return e.status === 'active' && effectiveCategory(a, e) !== 'MUSIC';
}

export interface QueueView {
  /** Eligible entries, oldest first. The first one is the head. */
  eligible: QueueEntry[];
  head: QueueEntry | null;
  music: QueueEntry[];
  unavailable: QueueEntry[];
}

export function queueView(a: AccountState): QueueView {
  const active = a.entries
    .filter((e) => e.status === 'active' || e.status === 'unavailable')
    .sort((x, y) => x.sequence - y.sequence);
  const eligible = active.filter((e) => isEligible(a, e));
  return {
    eligible,
    head: eligible[0] ?? null,
    music: active.filter((e) => e.status === 'active' && effectiveCategory(a, e) === 'MUSIC'),
    unavailable: active.filter((e) => e.status === 'unavailable'),
  };
}

export function findActive(a: AccountState, videoId: string): QueueEntry | undefined {
  return a.entries.find(
    (e) => e.videoId === videoId && (e.status === 'active' || e.status === 'unavailable'),
  );
}

function prune(a: AccountState): void {
  const finished = a.entries.filter((e) => e.status === 'removed');
  if (finished.length <= MAX_HISTORY) return;
  const drop = new Set(
    finished
      .sort((x, y) => x.sequence - y.sequence)
      .slice(0, finished.length - MAX_HISTORY)
      .map((e) => e.entryId),
  );
  a.entries = a.entries.filter((e) => !drop.has(e.entryId));
}

function append(
  a: AccountState,
  fields: Pick<QueueEntry, 'videoId' | 'title' | 'category' | 'sync' | 'origin'> & {
    entryId: string;
    now: number;
    setVideoId?: string;
  },
): QueueEntry {
  const entry: QueueEntry = {
    entryId: fields.entryId,
    videoId: fields.videoId,
    setVideoId: fields.setVideoId,
    sequence: a.nextSequence++,
    firstAttemptAt: fields.now,
    title: fields.title,
    category: fields.category,
    sync: fields.sync,
    status: 'active',
    origin: fields.origin,
  };
  a.entries.push(entry);
  a.queueRevision++;
  return entry;
}

/**
 * Records a deliberate attempt to queue a video. Duplicates keep their
 * original position. A video with a tombstone gets a new entry: an explicit
 * re-addition is a new commitment.
 */
export function addEntry(
  account: AccountState,
  input: { videoId: string; title: string; category: Category; now: number; entryId: string },
): { account: AccountState; entry: QueueEntry; duplicate: boolean } {
  const existing = findActive(account, input.videoId);
  if (existing) return { account, entry: existing, duplicate: true };
  const a = clone(account);
  const entry = append(a, { ...input, sync: 'pending', origin: 'extension' });
  return { account: a, entry, duplicate: false };
}

export function setSync(account: AccountState, entryId: string, sync: SyncStatus): AccountState {
  const a = clone(account);
  const e = a.entries.find((x) => x.entryId === entryId);
  if (e && e.sync !== sync) {
    e.sync = sync;
    a.queueRevision++;
  }
  return a;
}

export function setCategory(account: AccountState, videoId: string, category: Category, title?: string): AccountState {
  const a = clone(account);
  let changed = false;
  for (const e of a.entries) {
    if (e.videoId !== videoId || (e.status !== 'active' && e.status !== 'unavailable')) continue;
    if (e.category !== category) {
      e.category = category;
      changed = true;
    }
    if (title && !e.title) e.title = title;
  }
  if (changed) a.queueRevision++;
  return a;
}

/** First setup: imports a complete Watch Later snapshot in its native order. */
export function importSnapshot(
  account: AccountState,
  snapshot: Snapshot,
  now: number,
  makeId: () => string,
): AccountState {
  if (!snapshot.complete) throw new Error('Import needs a complete Watch Later snapshot');
  const a = clone(account);
  a.init = 'ready';
  return reconcile(a, snapshot, now, makeId, 'import');
}

/** Reassigns sequences of active entries to follow the playlist's native order. */
function resequence(a: AccountState, snapshot: Snapshot): boolean {
  const index = new Map<string, number>();
  snapshot.items.forEach((item, i) => {
    if (!index.has(item.videoId)) index.set(item.videoId, i);
  });
  const active = a.entries.filter((e) => e.status === 'active' || e.status === 'unavailable');
  const slots = active.map((e) => e.sequence).sort((x, y) => x - y);
  // Entries missing from the snapshot (saves in flight) keep their place after it.
  const ordered = [...active].sort((x, y) => {
    const ix = index.get(x.videoId) ?? Infinity;
    const iy = index.get(y.videoId) ?? Infinity;
    return ix === iy ? x.sequence - y.sequence : ix - iy;
  });
  let changed = false;
  ordered.forEach((e, i) => {
    if (e.sequence !== slots[i]) {
      e.sequence = slots[i]!;
      changed = true;
    }
  });
  return changed;
}

/**
 * Reconciles the ledger with a Watch Later snapshot. Only a complete snapshot
 * can prove an absence; an incomplete one only confirms or adds.
 */
export function reconcile(
  account: AccountState,
  snapshot: Snapshot,
  now: number,
  makeId: () => string,
  origin: 'import' | 'remote' = 'remote',
): AccountState {
  const a = clone(account);
  const before = a.queueRevision;
  const present = new Map<string, Snapshot['items'][number]>();
  for (const item of snapshot.items) if (!present.has(item.videoId)) present.set(item.videoId, item);

  const bump = () => {
    a.queueRevision = before + 1;
  };

  // Existing active entries.
  const matched = new Set<string>();
  for (const e of a.entries) {
    if (e.status !== 'active' && e.status !== 'unavailable') continue;
    const item = present.get(e.videoId);
    if (item) {
      matched.add(e.videoId);
      if (e.sync !== 'confirmed') {
        e.sync = 'confirmed';
        bump();
      }
      if (item.setVideoId) e.setVideoId = item.setVideoId;
      if (!e.title && item.title) e.title = item.title;
      if (!item.playable && e.status === 'active') {
        e.status = 'unavailable';
        e.unavailableReason = item.unavailableReason ?? 'Unavailable';
        bump();
      } else if (item.playable && e.status === 'unavailable') {
        e.status = 'active';
        delete e.unavailableReason;
        bump();
      }
    } else if (snapshot.complete && e.sync === 'confirmed') {
      // Verified native removal: the user escaped this commitment.
      e.status = 'removed';
      bump();
    }
  }

  // Additions from elsewhere append in observed order.
  for (const item of snapshot.items) {
    if (matched.has(item.videoId)) continue;
    matched.add(item.videoId);
    const e = append(a, {
      entryId: makeId(),
      videoId: item.videoId,
      setVideoId: item.setVideoId,
      title: item.title,
      category: 'PENDING',
      sync: 'confirmed',
      origin,
      now,
    });
    if (!item.playable) {
      e.status = 'unavailable';
      e.unavailableReason = item.unavailableReason ?? 'Unavailable';
    }
  }
  // Watch Later's own order (oldest first) is the queue order. Only a
  // complete read proves where every item sits.
  if (snapshot.complete && resequence(a, snapshot)) bump();
  if (a.queueRevision !== before) a.queueRevision = before + 1;

  a.lastSnapshot = {
    at: now,
    complete: snapshot.complete,
    count: snapshot.items.length,
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
  prune(a);
  return a;
}

/** Drops an entry whose save never landed: the queue is what is in Watch Later. */
export function discardEntry(account: AccountState, entryId: string): AccountState {
  const a = clone(account);
  const e = a.entries.find((x) => x.entryId === entryId);
  if (!e || e.status !== 'active' || e.sync === 'confirmed') return account;
  e.status = 'removed';
  a.queueRevision++;
  return a;
}
