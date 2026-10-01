// Daily homepage skip allowance. Pure functions; the background controller
// persists the resulting ledger before acknowledging.

import { DAILY_SKIPS, type SkipLedger } from '../shared/types';

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Calendar date (YYYY-MM-DD) of `now` in the IANA timezone `tz`. DST-safe. */
export function dayInZone(now: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Brings the ledger to the current day. A later day resets the allowance; an
 * earlier day (clock moved backwards) keeps the current ledger unchanged.
 */
export function rollLedger(ledger: SkipLedger, now: number, tz: string): SkipLedger {
  const today = dayInZone(now, tz);
  if (today > ledger.day) return { day: today, used: 0, spends: ledger.spends.slice(-20) };
  return ledger;
}

export function skipsRemaining(ledger: SkipLedger, now: number, tz: string): number {
  const rolled = rollLedger(ledger, now, tz);
  return Math.max(0, DAILY_SKIPS - rolled.used);
}

export type SpendResult =
  | { ok: true; ledger: SkipLedger; remaining: number; duplicate: boolean }
  | { ok: false; ledger: SkipLedger; remaining: 0 };

/** Spends one skip. Idempotent per requestId. */
export function spendSkip(
  ledger: SkipLedger,
  now: number,
  tz: string,
  requestId: string,
  videoId: string,
): SpendResult {
  const rolled = rollLedger(ledger, now, tz);
  if (rolled.spends.some((s) => s.requestId === requestId)) {
    return { ok: true, ledger: rolled, remaining: Math.max(0, DAILY_SKIPS - rolled.used), duplicate: true };
  }
  if (rolled.used >= DAILY_SKIPS) return { ok: false, ledger: rolled, remaining: 0 };
  const next: SkipLedger = {
    day: rolled.day,
    used: rolled.used + 1,
    spends: [...rolled.spends, { requestId, videoId, day: rolled.day, at: now }].slice(-20),
  };
  return { ok: true, ledger: next, remaining: DAILY_SKIPS - next.used, duplicate: false };
}
