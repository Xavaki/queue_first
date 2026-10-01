// Durable and session state with serialized read-modify-write transactions.
// Nothing is kept in memory between transactions: the background page may be
// suspended at any time, so each transaction loads, mutates, and persists
// before its result is returned.

import { dayInZone, isValidTimezone } from '../policy/skips';
import {
  SCHEMA_VERSION,
  type DurableState,
  type SessionState,
} from '../shared/types';

const DURABLE_KEY = 'qf:state';
const SESSION_KEY = 'qf:session';
const IDEMPOTENCY_MAX = 200;
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

export function defaultTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && isValidTimezone(tz) ? tz : 'UTC';
}

export function defaultDurable(now = Date.now()): DurableState {
  const timezone = defaultTimezone();
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    settings: { timezone },
    accounts: {},
    categoryCache: {},
    skipLedger: { day: dayInZone(now, timezone), used: 0, spends: [] },
    idempotency: {},
  };
}

export function defaultSession(): SessionState {
  return { grants: {}, tabVideo: {}, tabAccount: {}, intents: {}, lastAccountKey: null };
}

/** Upgrades older records. Unknown future versions are refused rather than guessed. */
export function migrate(raw: unknown): DurableState {
  if (!raw || typeof raw !== 'object') return defaultDurable();
  const s = raw as DurableState;
  if (s.schemaVersion === SCHEMA_VERSION) return s;
  if (typeof s.schemaVersion === 'number' && s.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`State schema ${s.schemaVersion} is newer than this extension supports`);
  }
  return defaultDurable();
}

export interface Tx {
  durable: DurableState;
  session: SessionState;
  now: number;
  /** Mark durable state changed so it is persisted. */
  dirty(): void;
  /** Mark session state changed so it is persisted. */
  sessionDirty(): void;
}

let chain: Promise<unknown> = Promise.resolve();

/** Runs `fn` exclusively. Changes are persisted before the promise resolves. */
export function transact<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const got = await Promise.all([
      browser.storage.local.get(DURABLE_KEY),
      browser.storage.session.get(SESSION_KEY),
    ]);
    const durable = migrate(got[0][DURABLE_KEY]);
    const session = (got[1][SESSION_KEY] as SessionState | undefined) ?? defaultSession();
    let d = false;
    let s = false;
    const tx: Tx = {
      durable,
      session,
      now: Date.now(),
      dirty: () => (d = true),
      sessionDirty: () => (s = true),
    };
    const result = await fn(tx);
    const writes: Promise<void>[] = [];
    if (d) {
      durable.revision++;
      pruneIdempotency(durable, tx.now);
      writes.push(browser.storage.local.set({ [DURABLE_KEY]: durable }));
    }
    if (s) writes.push(browser.storage.session.set({ [SESSION_KEY]: session }));
    await Promise.all(writes);
    return result;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

function pruneIdempotency(state: DurableState, now: number): void {
  const entries = Object.entries(state.idempotency)
    .filter(([, v]) => now - v.at < IDEMPOTENCY_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, IDEMPOTENCY_MAX);
  state.idempotency = Object.fromEntries(entries);
}

export function remember(tx: Tx, requestId: string, result: unknown): void {
  tx.durable.idempotency[requestId] = { at: tx.now, result };
  tx.dirty();
}

export function recall<T>(tx: Tx, requestId: string): T | undefined {
  return tx.durable.idempotency[requestId]?.result as T | undefined;
}
