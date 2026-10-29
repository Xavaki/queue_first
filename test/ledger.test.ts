import { describe, expect, it } from 'vitest';
import {
  addEntry,
  createAccount,
  discardEntry,
  importSnapshot,
  queueView,
  reconcile,
  setCategory,
  setSync,
} from '../src/policy/ledger';
import { checkLaunch, decidePlayback } from '../src/policy/engine';
import type { AccountState, Grant, Snapshot } from '../src/shared/types';

let n = 0;
const makeId = () => `id-${++n}`;
const A = 'AAAAAAAAAA1';
const B = 'BBBBBBBBBB2';
const C = 'CCCCCCCCCC3';
const D = 'DDDDDDDDDD4';

function ready(): AccountState {
  return importSnapshot(createAccount('k1'), snap([]), 0, makeId);
}

function add(a: AccountState, videoId: string, now = 1): AccountState {
  const r = addEntry(a, { videoId, title: videoId, category: 'NON_MUSIC', now, entryId: makeId() });
  return setSync(r.account, r.entry.entryId, 'confirmed');
}

function snap(ids: string[], complete = true): Snapshot {
  return { complete, pages: 1, items: ids.map((videoId) => ({ videoId, title: videoId, playable: true })) };
}

describe('ledger ordering', () => {
  it('appends new items and keeps the original position for duplicates', () => {
    let a = add(ready(), A, 1);
    a = add(a, B, 2);
    const dup = addEntry(a, { videoId: A, title: 'A', category: 'NON_MUSIC', now: 3, entryId: makeId() });
    expect(dup.duplicate).toBe(true);
    expect(queueView(dup.account).eligible.map((e) => e.videoId)).toEqual([A, B]);
  });

  it('follows the native Watch Later order from complete reads only', () => {
    let a = add(add(add(ready(), A), B), C);
    a = reconcile(a, snap([C, A], false), 5, makeId);
    expect(queueView(a).eligible.map((e) => e.videoId)).toEqual([A, B, C]);
    a = reconcile(a, snap([B, A, C]), 6, makeId);
    expect(queueView(a).eligible.map((e) => e.videoId)).toEqual([B, A, C]);
  });

  it('additions from elsewhere take their native position', () => {
    let a = add(ready(), A);
    a = reconcile(a, snap([D, A, C]), 5, makeId);
    expect(queueView(a).eligible.map((e) => e.videoId)).toEqual([D, A, C]);
    expect(a.entries.find((e) => e.videoId === D)!.origin).toBe('remote');
  });

  it('a save in flight keeps its place after the snapshot order', () => {
    let a = add(ready(), A);
    const r = addEntry(a, { videoId: B, title: 'B', category: 'NON_MUSIC', now: 2, entryId: makeId() });
    a = reconcile(r.account, snap([C, A]), 3, makeId);
    expect(queueView(a).eligible.map((e) => e.videoId)).toEqual([C, A, B]);
  });

  it('an incomplete snapshot cannot prove a deletion', () => {
    let a = add(add(ready(), A), B);
    a = reconcile(a, snap([B], false), 5, makeId);
    expect(queueView(a).head!.videoId).toBe(A);
    a = reconcile(a, snap([B], true), 6, makeId);
    expect(queueView(a).head!.videoId).toBe(B);
  });

  it('a pending save blocks advancement; a failed save leaves nothing queued', () => {
    const r = addEntry(ready(), { videoId: A, title: 'A', category: 'NON_MUSIC', now: 1, entryId: makeId() });
    let a = add(r.account, B);
    expect(checkLaunch(a, A)).toEqual({ ok: false, reason: 'head_unconfirmed' });
    expect(checkLaunch(a, B)).toEqual({ ok: false, reason: 'not_head' });
    a = discardEntry(a, r.entry.entryId);
    expect(queueView(a).head!.videoId).toBe(B);
  });

  it('music is excluded from the restricted queue without being removed', () => {
    let a = add(add(ready(), A), B);
    a = setCategory(a, A, 'MUSIC');
    const v = queueView(a);
    expect(v.head!.videoId).toBe(B);
    expect(v.music.map((e) => e.videoId)).toEqual([A]);
  });

  it('unavailable items do not deadlock; only a positive result excludes them', () => {
    let a = add(add(ready(), A), B);
    a = reconcile(a, { complete: true, pages: 1, items: [{ videoId: A, title: '[Private video]', playable: false }, { videoId: B, title: 'B', playable: true }] }, 2, makeId);
    expect(queueView(a).head!.videoId).toBe(B);
    expect(queueView(a).unavailable.map((e) => e.videoId)).toEqual([A]);
    // Generic failure (empty incomplete snapshot) changes nothing.
    let b = add(add(ready(), A), B);
    b = reconcile(b, { complete: false, pages: 0, items: [], error: 'network' }, 2, makeId);
    expect(queueView(b).head!.videoId).toBe(A);
  });

  it('imports only a complete snapshot, in native order', () => {
    const a = importSnapshot(createAccount('k2'), snap([C, A, B]), 0, makeId);
    expect(a.init).toBe('ready');
    expect(queueView(a).eligible.map((e) => e.videoId)).toEqual([C, A, B]);
    expect(() => importSnapshot(createAccount('k3'), snap([A], false), 0, makeId)).toThrow();
  });
});

describe('playback policy', () => {
  const grant = (over: Partial<Grant>): Grant => ({
    grantId: 'g', kind: 'ordinary', tabId: 1, videoId: A, accountKey: 'k1', queueRevision: 0, issuedAt: 0, ...over,
  });
  const base = (a: AccountState | null, videoId: string, grants: Grant[] = [], category: 'MUSIC' | 'NON_MUSIC' | 'UNKNOWN' | 'PENDING' = 'NON_MUSIC') =>
    decidePlayback({ videoId, tabId: 1, loggedIn: true, accountKey: a?.accountKey ?? 'k1', account: a, category, grants });

  it('plays the head directly; later videos stay blocked', () => {
    const a = add(add(ready(), A), B);
    expect(base(a, A)).toMatchObject({ allowed: true, kind: 'ordinary', position: 1 });
    expect(base(a, A, [], 'PENDING')).toMatchObject({ allowed: true, kind: 'ordinary' });
    expect(base(a, B)).toMatchObject({ allowed: false, reason: 'queued_not_head', position: 2 });
    expect(base(a, A, [grant({})])).toMatchObject({ allowed: true, kind: 'ordinary' });
  });

  it('grants are bound to tab, video and account', () => {
    // C is the head, so A needs a grant.
    const a = add(add(ready(), C), A);
    expect(base(a, A, [grant({ tabId: 2 })]).allowed).toBe(false);
    expect(base(a, B, [grant({})]).allowed).toBe(false);
    expect(base(a, A, [grant({ accountKey: 'other' })]).allowed).toBe(false);
  });

  it('music plays freely even when signed out; UNKNOWN stays guarded', () => {
    expect(decidePlayback({ videoId: C, tabId: 1, loggedIn: false, accountKey: null, account: null, category: 'MUSIC', grants: [] }).allowed).toBe(true);
    const a = add(ready(), A);
    expect(base(a, C, [], 'UNKNOWN')).toMatchObject({ allowed: false, reason: 'not_queued' });
    expect(base(a, C, [], 'PENDING')).toMatchObject({ allowed: false, reason: 'classifying' });
  });

  it('a user music override exempts a video', () => {
    const a = add(ready(), A);
    a.musicOverrides[A] = { at: 0 };
    expect(base(a, A)).toMatchObject({ allowed: true, kind: 'music' });
  });

  it('skip grants allow only that video in that tab', () => {
    const a = add(add(ready(), B), A);
    const g = grant({ kind: 'skip', videoId: C, accountKey: null });
    expect(base(a, C, [g])).toMatchObject({ allowed: true, kind: 'skip' });
    expect(base(a, A, [g]).allowed).toBe(false);
  });

  it('signed out and uninitialized states block nonmusic', () => {
    expect(decidePlayback({ videoId: A, tabId: 1, loggedIn: false, accountKey: null, account: null, category: 'NON_MUSIC', grants: [] }).reason).toBe('signed_out');
    expect(base(createAccount('k1'), A).reason).toBe('not_initialized');
  });
});
