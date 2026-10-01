// Background controller: the only writer of queue, skips, and
// grants. Network work happens outside transactions; every decision that
// mutates state re-checks inside a serialized transaction.

import { checkLaunch, decidePlayback, findGrant } from '../policy/engine';
import {
  addEntry,
  createAccount,
  discardEntry,
  effectiveCategory,
  findActive,
  importSnapshot,
  queueView,
  reconcile,
  setCategory,
  setSync,
} from '../policy/ledger';
import { dayInZone, isValidTimezone, rollLedger, skipsRemaining, spendSkip } from '../policy/skips';
import { newId, parseRoute, watchUrl } from '../shared/ids';
import { classify } from './classifier';
import { recall, remember, transact, type Tx } from './store';
import { anyYouTubeTab, tabAdapter } from './watchLater';
import { DAILY_SKIPS, type AccountState, type Grant, type PlaybackDecision } from '../shared/types';
import type {
  ClassifyResult,
  ContentState,
  EnqueueResult,
  LaunchResult,
  Message,
  PopupState,
  RowStatus,
  SkipResult,
  TabAccount,
  ToContent,
  WlState,
} from '../shared/messages';

const INTENT_WINDOW_MS = 10_000;

export interface Sender {
  tabId: number | null;
  url: string | null;
}

// ---------------------------------------------------------------------------
// Helpers

function tabAccount(tx: Tx, tabId: number): TabAccount {
  return tx.session.tabAccount[tabId] ?? { loggedIn: false, accountKey: null };
}

function accountOf(tx: Tx, tabId: number): AccountState | null {
  const key = tabAccount(tx, tabId).accountKey;
  return key ? tx.durable.accounts[key] ?? null : null;
}

function putAccount(tx: Tx, a: AccountState): void {
  tx.durable.accounts[a.accountKey] = a;
  tx.dirty();
}

function activeAccountKey(tx: Tx): string | null {
  return tx.session.lastAccountKey;
}

function grantsList(tx: Tx): Grant[] {
  return Object.values(tx.session.grants);
}

function revokeTabGrants(tx: Tx, tabId: number, keepVideoId?: string | null): void {
  for (const [id, g] of Object.entries(tx.session.grants)) {
    if (g.tabId === tabId && g.videoId !== keepVideoId) {
      delete tx.session.grants[id];
      tx.sessionDirty();
    }
  }
}

function intentKey(tabId: number, videoId: string): string {
  return `${tabId}:${videoId}`;
}

function conflictingIntent(tx: Tx, tabId: number, videoId: string, mine: 'enqueue' | 'skip'): boolean {
  const it = tx.session.intents[intentKey(tabId, videoId)];
  return !!it && it.kind !== mine && tx.now - it.at < INTENT_WINDOW_MS;
}

function setIntent(tx: Tx, tabId: number, videoId: string, kind: 'enqueue' | 'skip'): void {
  for (const [k, v] of Object.entries(tx.session.intents)) {
    if (tx.now - v.at > INTENT_WINDOW_MS) delete tx.session.intents[k];
  }
  tx.session.intents[intentKey(tabId, videoId)] = { kind, at: tx.now };
  tx.sessionDirty();
}

function clearIntent(tx: Tx, tabId: number, videoId: string): void {
  delete tx.session.intents[intentKey(tabId, videoId)];
  tx.sessionDirty();
}

export async function broadcast(): Promise<void> {
  const tabs = await browser.tabs.query({ url: '*://www.youtube.com/*' });
  const msg: ToContent = { type: 'stateChanged' };
  await Promise.all(
    tabs.map((t) => (t.id !== undefined ? browser.tabs.sendMessage(t.id, msg).catch(() => undefined) : undefined)),
  );
}

function contentState(tx: Tx, tabId: number): ContentState {
  const ta = tabAccount(tx, tabId);
  const account = accountOf(tx, tabId);
  const view = account?.init === 'ready' ? queueView(account) : null;
  return {
    loggedIn: ta.loggedIn,
    accountKey: ta.accountKey,
    init: account ? account.init : 'no_account',
    skipsRemaining: skipsRemaining(tx.durable.skipLedger, tx.now, tx.durable.settings.timezone),
    queuedVideoIds: account
      ? account.entries.filter((e) => e.status === 'active' || e.status === 'unavailable').map((e) => e.videoId)
      : [],
    head: view?.head ? { videoId: view.head.videoId, title: view.head.title } : null,
    queueSize: view?.eligible.length ?? 0,
  };
}

/**
 * Reads a snapshot through `tabId` and reconciles the tab's account. On first
 * use it imports Watch Later, which requires a complete read.
 */
async function refreshSnapshot(tabId: number): Promise<{ ok: boolean; error?: string }> {
  const hasAccount = await transact((tx) => !!accountOf(tx, tabId));
  if (!hasAccount) return { ok: false, error: 'account_unknown' };
  const snap = await tabAdapter(tabId).snapshot();
  const failedOutright = !snap.complete && snap.items.length === 0;
  return transact((tx) => {
    const a = accountOf(tx, tabId);
    if (!a) return { ok: false, error: 'account_unknown' };
    if (a.init !== 'ready') {
      if (!snap.complete) return { ok: false, error: snap.error ?? 'Could not read the complete Watch Later list' };
      putAccount(tx, importSnapshot(a, snap, tx.now, newId));
      return { ok: true };
    }
    if (failedOutright) {
      putAccount(tx, {
        ...a,
        lastSnapshot: { at: tx.now, complete: false, count: 0, error: snap.error ?? 'Snapshot failed' },
      });
      return { ok: false, error: snap.error ?? 'Snapshot failed' };
    }
    putAccount(tx, reconcile(a, snap, tx.now, newId));
    if (!snap.complete) return { ok: false, error: snap.error ?? 'Incomplete snapshot' };
    return { ok: true };
  });
}

/** Classifies queue entries whose category is unresolved, a few at a time. */
async function classifyPending(tabId: number, limit = 15): Promise<void> {
  const ids = await transact((tx) => {
    const a = accountOf(tx, tabId);
    if (!a) return [];
    return a.entries
      .filter((e) => e.status === 'active' && (e.category === 'PENDING' || e.category === 'UNKNOWN'))
      .sort((x, y) => x.sequence - y.sequence)
      .slice(0, limit)
      .map((e) => e.videoId);
  });
  let changed = false;
  for (const videoId of ids) {
    const c = await classify(videoId);
    if (c.source !== 'player_microformat' && c.availability !== 'unavailable') continue;
    changed =
      (await transact((tx) => {
        const a = accountOf(tx, tabId);
        if (!a) return false;
        const next = setCategory(a, videoId, c.category, c.title);
        if (next.queueRevision === a.queueRevision) return false;
        putAccount(tx, next);
        return true;
      })) || changed;
  }
  if (changed) void broadcast();
}

function nextResetLabel(now: number, tz: string): string {
  // Find the next instant whose local date differs from today (DST-safe).
  const today = dayInZone(now, tz);
  let lo = now;
  let hi = now + 26 * 3600_000;
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayInZone(mid, tz) === today) lo = mid;
    else hi = mid;
  }
  return new Date(hi).toLocaleString(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short' });
}

// ---------------------------------------------------------------------------
// Handlers

export async function handle(msg: Message, sender: Sender): Promise<unknown> {
  const tabId = sender.tabId;
  switch (msg.type) {
    // ----- Content: session & state
    case 'hello': {
      if (tabId === null) return null;
      const switched = await transact((tx) => {
        tx.session.tabAccount[tabId] = msg.account;
        tx.sessionDirty();
        const key = msg.account.accountKey;
        if (key && !tx.durable.accounts[key]) putAccount(tx, createAccount(key));
        let changed = false;
        if (key && tx.session.lastAccountKey && tx.session.lastAccountKey !== key) {
          // Account switch: invalidate playback grants pending reconciliation.
          tx.session.grants = {};
          changed = true;
        }
        if (key) tx.session.lastAccountKey = key;
        return changed;
      });
      if (switched) void broadcast();
      return transact((tx) => contentState(tx, tabId));
    }
    case 'getState':
      if (tabId === null) return null;
      return transact((tx) => contentState(tx, tabId));

    // ----- Content: playback policy
    case 'evaluate': {
      if (tabId === null) return null;
      await transact((tx) => {
        tx.session.tabVideo[tabId] = msg.videoId;
        revokeTabGrants(tx, tabId, msg.videoId);
      });
      const c = await classify(msg.videoId);
      return transact((tx): PlaybackDecision => {
        const ta = tabAccount(tx, tabId);
        let account = accountOf(tx, tabId);
        if (account && findActive(account, msg.videoId) && c.category !== 'UNKNOWN') {
          const next = setCategory(account, msg.videoId, c.category, c.title);
          if (next.queueRevision !== account.queueRevision) {
            putAccount(tx, next);
            account = next;
          }
        }
        return decidePlayback({
          videoId: msg.videoId,
          tabId,
          loggedIn: ta.loggedIn,
          accountKey: ta.accountKey,
          account,
          category: c.category,
          grants: grantsList(tx),
        });
      });
    }

    // ----- Content: a click on a locked card plays only if it is music
    case 'classify': {
      const c = await classify(msg.videoId);
      const override = tabId !== null && (await transact((tx) => !!accountOf(tx, tabId)?.musicOverrides[msg.videoId]));
      return { music: override || c.category === 'MUSIC', category: c.category } satisfies ClassifyResult;
    }

    // ----- Content: queue a deliberate selection
    case 'enqueue': {
      if (tabId === null) return null;
      const prior = await transact((tx) => recall<EnqueueResult>(tx, msg.requestId));
      if (prior) return prior;
      const c = await classify(msg.videoId);
      if (c.category === 'MUSIC') return { status: 'music' } satisfies EnqueueResult;

      const step = await transact((tx): EnqueueResult | { entryId: string; accountKey: string } => {
        const ta = tabAccount(tx, tabId);
        if (!ta.loggedIn) return { status: 'refused', reason: 'signed_out' };
        const account = accountOf(tx, tabId);
        if (!account || !ta.accountKey) return { status: 'refused', reason: 'account_unknown' };
        if (account.init !== 'ready') return { status: 'refused', reason: 'not_initialized' };
        if (account.musicOverrides[msg.videoId]) return { status: 'music' };
        if (conflictingIntent(tx, tabId, msg.videoId, 'enqueue')) return { status: 'refused', reason: 'conflict' };
        setIntent(tx, tabId, msg.videoId, 'enqueue');
        const title = msg.title || c.title || '';
        const { account: next, entry, duplicate } = addEntry(account, {
          videoId: msg.videoId,
          title,
          category: c.category,
          now: tx.now,
          entryId: newId(),
        });
        if (duplicate && entry.sync === 'confirmed') {
          const pos = queueView(next).eligible.findIndex((e) => e.entryId === entry.entryId) + 1;
          const r: EnqueueResult = { status: 'already_queued', category: c.category, position: pos };
          remember(tx, msg.requestId, r);
          return r;
        }
        putAccount(tx, next);
        return { entryId: entry.entryId, accountKey: account.accountKey };
      });
      if ('status' in step) return step;
      const r = await confirmAdd(tabId, step.accountKey, step.entryId, msg.videoId, msg.requestId);
      void broadcast();
      return r;
    }
    // ----- Content: homepage skip
    case 'skip': {
      if (tabId === null) return null;
      const prior = await transact((tx) => recall<SkipResult>(tx, msg.requestId));
      if (prior) return prior;
      // The explicit homepage intent is established by the sender frame URL,
      // which the page cannot forge.
      if (!sender.url || parseRoute(sender.url).kind !== 'home') {
        return { status: 'refused', reason: 'not_homepage' } satisfies SkipResult;
      }
      const c = await classify(msg.videoId);
      if (c.category === 'MUSIC') return { status: 'music' } satisfies SkipResult;

      const pre = await transact((tx): SkipResult | null => {
        const ta = tabAccount(tx, tabId);
        if (!ta.loggedIn || !ta.accountKey) return { status: 'refused', reason: 'signed_out' };
        const account = accountOf(tx, tabId);
        if (account?.musicOverrides[msg.videoId]) return { status: 'music' };
        if (account && findActive(account, msg.videoId)) return { status: 'refused', reason: 'already_queued' };
        if (conflictingIntent(tx, tabId, msg.videoId, 'skip')) return { status: 'refused', reason: 'conflict' };
        if (skipsRemaining(tx.durable.skipLedger, tx.now, tx.durable.settings.timezone) <= 0) {
          return { status: 'refused', reason: 'no_skips' };
        }
        setIntent(tx, tabId, msg.videoId, 'skip');
        return null;
      });
      if (pre) return pre;

      // Verify current membership before charging; unresolved holds without charge.
      const present = await tabAdapter(tabId).has(msg.videoId);
      const result = await transact((tx): SkipResult => {
        if (present === null) {
          clearIntent(tx, tabId, msg.videoId);
          return { status: 'refused', reason: 'membership_unresolved' };
        }
        const account = accountOf(tx, tabId);
        if (present || (account && findActive(account, msg.videoId))) {
          clearIntent(tx, tabId, msg.videoId);
          return { status: 'refused', reason: 'already_queued' };
        }
        const spent = spendSkip(tx.durable.skipLedger, tx.now, tx.durable.settings.timezone, msg.requestId, msg.videoId);
        if (!spent.ok) {
          tx.durable.skipLedger = spent.ledger;
          tx.dirty();
          return { status: 'refused', reason: 'no_skips' };
        }
        tx.durable.skipLedger = spent.ledger;
        revokeTabGrants(tx, tabId);
        const grant: Grant = {
          grantId: newId(),
          kind: 'skip',
          tabId,
          videoId: msg.videoId,
          accountKey: tabAccount(tx, tabId).accountKey,
          queueRevision: account?.queueRevision ?? 0,
          issuedAt: tx.now,
        };
        tx.session.grants[grant.grantId] = grant;
        tx.sessionDirty();
        const r: SkipResult = { status: 'granted', remaining: spent.remaining };
        remember(tx, msg.requestId, r);
        return r;
      });
      void broadcast();
      return result;
    }

    // ----- Content: ordinary launch from the Watch Later page (click on the oldest row)
    case 'launch': {
      if (tabId === null) return null;
      if (!sender.url || parseRoute(sender.url).kind !== 'watch_later') {
        return { status: 'refused', reason: 'Start videos from your Watch Later page.' } satisfies LaunchResult;
      }
      // Reconcile before starting ordinary playback. A failed snapshot cannot
      // authorize a newer head, but the current ledger head stays valid.
      await refreshSnapshot(tabId);
      const c = await classify(msg.videoId);
      if (c.source === 'player_microformat') {
        await transact((tx) => {
          const a = accountOf(tx, tabId);
          if (a) putAccount(tx, setCategory(a, msg.videoId, c.category, c.title));
        });
      }
      const r = await transact((tx): LaunchResult => {
        const account = accountOf(tx, tabId);
        const check = checkLaunch(account, msg.videoId);
        if (!check.ok || !account) {
          const reasons: Record<string, string> = {
            not_initialized: 'Queue First is not set up for this account.',
            empty: 'Your queue is empty.',
            not_head: 'Only the oldest video can be started.',
            head_unconfirmed: 'The oldest video is not confirmed in Watch Later yet. Retry its save first.',
            head_is_music: 'This video is music and plays freely.',
          };
          return { status: 'refused', reason: reasons[check.ok ? 'not_initialized' : check.reason] ?? 'Refused' };
        }
        revokeTabGrants(tx, tabId);
        const grant: Grant = {
          grantId: newId(),
          kind: 'ordinary',
          tabId,
          videoId: msg.videoId,
          accountKey: account.accountKey,
          queueRevision: account.queueRevision,
          entryId: check.entryId,
          issuedAt: tx.now,
        };
        tx.session.grants[grant.grantId] = grant;
        tx.sessionDirty();
        return { status: 'granted', videoId: msg.videoId };
      });
      void broadcast();
      return r;
    }

    // ----- Content: native Watch Later page
    case 'wlState': {
      if (tabId === null) return null;
      let error: string | undefined;
      if (msg.refresh) {
        const r = await refreshSnapshot(tabId);
        if (!r.ok) error = r.error;
        void classifyPending(tabId);
      }
      const state = await transact((tx) => wlState(tx, tabId, error));
      if (msg.refresh) void broadcast();
      return state;
    }
    case 'openVideo': {
      await browser.tabs.create({ url: watchUrl(msg.videoId), active: msg.active });
      return true;
    }

    // ----- Popup & settings
    case 'popupState':
      return transact((tx): PopupState => {
        const key = activeAccountKey(tx);
        const a = key ? tx.durable.accounts[key] : undefined;
        const view = a?.init === 'ready' ? queueView(a) : null;
        const tz = tx.durable.settings.timezone;
        let protection: PopupState['protection'] = 'unknown';
        const anyTab = Object.values(tx.session.tabAccount).at(-1);
        if (anyTab && !anyTab.loggedIn) protection = 'signed_out';
        else if (a && a.init !== 'ready') protection = 'setup_needed';
        else if (view) protection = 'active';
        return {
          protection,
          queueSize: view?.eligible.length ?? 0,
          head: view?.head ? { videoId: view.head.videoId, title: view.head.title } : null,
          skipsRemaining: skipsRemaining(tx.durable.skipLedger, tx.now, tz),
          timezone: tz,
          nextReset: nextResetLabel(tx.now, tz),
        };
      });
    case 'openWatchLater': {
      const url = 'https://www.youtube.com/playlist?list=WL';
      const [existing] = await browser.tabs.query({ url: '*://www.youtube.com/playlist?list=WL*' });
      if (existing?.id !== undefined) {
        await browser.tabs.update(existing.id, { active: true });
        if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true });
      } else {
        await browser.tabs.create({ url });
      }
      return true;
    }
    case 'settingsState':
      return transact((tx) => {
        const key = activeAccountKey(tx);
        const a = key ? tx.durable.accounts[key] : undefined;
        return {
          timezone: tx.durable.settings.timezone,
          timezones: typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [],
          account: a
            ? {
                init: a.init,
                queueSize: queueView(a).eligible.length,
                lastSnapshot: a.lastSnapshot,
                unconfirmed: a.entries.filter((e) => e.status === 'active' && e.sync !== 'confirmed').length,
                overrides: Object.entries(a.musicOverrides).map(([videoId, v]) => ({ videoId, ...v })),
              }
            : null,
          skipsRemaining: skipsRemaining(tx.durable.skipLedger, tx.now, tx.durable.settings.timezone),
          dailySkips: DAILY_SKIPS,
          cacheSize: Object.keys(tx.durable.categoryCache).length,
        };
      });
    case 'setTimezone': {
      if (!isValidTimezone(msg.timezone)) return { ok: false, error: 'Unknown timezone' };
      await transact((tx) => {
        tx.durable.settings.timezone = msg.timezone;
        // Changing zones never moves the allowance day backwards.
        tx.durable.skipLedger = rollLedger(tx.durable.skipLedger, tx.now, msg.timezone);
        tx.dirty();
      });
      void broadcast();
      return { ok: true };
    }
    case 'addMusicOverride':
    case 'removeMusicOverride': {
      const ok = await transact((tx) => {
        const key = activeAccountKey(tx);
        const a = key ? tx.durable.accounts[key] : undefined;
        if (!a) return false;
        const next = structuredClone(a);
        if (msg.type === 'addMusicOverride') {
          next.musicOverrides[msg.videoId] = { at: tx.now, title: findActive(a, msg.videoId)?.title };
        } else {
          delete next.musicOverrides[msg.videoId];
        }
        next.queueRevision++;
        putAccount(tx, next);
        return true;
      });
      void broadcast();
      return { ok };
    }
    case 'clearCategoryCache':
      await transact((tx) => {
        tx.durable.categoryCache = {};
        tx.dirty();
      });
      return { ok: true };
    case 'diagnostics':
      return transact((tx) => diagnostics(tx));
  }
}

async function confirmAdd(
  tabId: number,
  accountKey: string,
  entryId: string,
  videoId: string,
  requestId: string,
): Promise<EnqueueResult> {
  const ok = await tabAdapter(tabId).add(videoId);
  return transact((tx): EnqueueResult => {
    const a = tx.durable.accounts[accountKey];
    if (!a) return { status: 'failed', error: 'Account missing' };
    // A save that did not land leaves nothing queued: the queue is Watch Later.
    const next = ok ? setSync(a, entryId, 'confirmed') : discardEntry(a, entryId);
    putAccount(tx, next);
    const entry = next.entries.find((e) => e.entryId === entryId);
    const r: EnqueueResult = ok
      ? {
          status: 'added',
          category: entry && entry.category !== 'PENDING' ? entry.category : 'UNKNOWN',
          position: queueView(next).eligible.findIndex((e) => e.entryId === entryId) + 1,
        }
      : { status: 'failed', error: 'Could not save to Watch Later' };
    remember(tx, requestId, r);
    return r;
  });
}

function wlState(tx: Tx, tabId: number, error?: string): WlState {
  const ta = tabAccount(tx, tabId);
  const a = accountOf(tx, tabId);
  if (!a) {
    return { loggedIn: ta.loggedIn, init: 'no_account', head: null, rows: {}, error };
  }
  const view = queueView(a);
  const rows: Record<string, RowStatus> = {};
  for (const e of view.eligible) rows[e.videoId] = e.status === 'unavailable' ? 'unavailable' : 'locked';
  for (const e of view.music) rows[e.videoId] = 'music';
  if (view.head && view.head.sync === 'confirmed') rows[view.head.videoId] = 'head';
  return {
    loggedIn: ta.loggedIn,
    init: a.init,
    head: view.head ? { videoId: view.head.videoId, title: view.head.title } : null,
    rows,
    error,
  };
}

/** Redacted diagnostics: no account identifiers, titles, cookies, or tokens. */
function diagnostics(tx: Tx): unknown {
  const accounts = Object.values(tx.durable.accounts).map((a, i) => ({
    account: `account-${i + 1}`,
    init: a.init,
    nextSequence: a.nextSequence,
    queueRevision: a.queueRevision,
    lastSnapshot: a.lastSnapshot,
    entries: a.entries.map((e) => ({
      sequence: e.sequence,
      category: e.category,
      sync: e.sync,
      status: e.status,
      origin: e.origin,
    })),
    musicOverrides: Object.keys(a.musicOverrides).length,
  }));
  return {
    extensionVersion: browser.runtime.getManifest().version,
    schemaVersion: tx.durable.schemaVersion,
    revision: tx.durable.revision,
    timezone: tx.durable.settings.timezone,
    skipLedger: { day: tx.durable.skipLedger.day, used: tx.durable.skipLedger.used },
    categoryCacheSize: Object.keys(tx.durable.categoryCache).length,
    activeGrants: Object.values(tx.session.grants).map((g) => ({ kind: g.kind })),
    accounts,
  };
}

/** Drops tab-bound session state when a tab closes. */
export async function onTabRemoved(tabId: number): Promise<void> {
  await transact((tx) => {
    revokeTabGrants(tx, tabId, undefined);
    delete tx.session.tabVideo[tabId];
    delete tx.session.tabAccount[tabId];
    tx.sessionDirty();
  });
}
