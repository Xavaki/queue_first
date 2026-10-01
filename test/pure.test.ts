import { describe, expect, it } from 'vitest';
import { parseRoute, videoIdFromHref } from '../src/shared/ids';
import { dayInZone, rollLedger, skipsRemaining, spendSkip } from '../src/policy/skips';
import { isMessage } from '../src/shared/messages';
import type { SkipLedger } from '../src/shared/types';

describe('video IDs and routes', () => {
  it('resolves the video independently of list, index, timestamp and tracking params', () => {
    const id = 'dQw4w9WgXcQ';
    for (const href of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://www.youtube.com/watch?v=${id}&list=WL&index=3&t=120s&si=abc`,
      `https://www.youtube.com/watch?list=WL&v=${id}&pp=xyz`,
      `/watch?v=${id}&start_radio=1`,
      `https://www.youtube.com/shorts/${id}?feature=share`,
      `https://www.youtube.com/live/${id}`,
      `https://youtu.be/${id}?t=5`,
    ]) {
      expect(videoIdFromHref(href)).toBe(id);
    }
  });

  it('classifies routes', () => {
    expect(parseRoute('https://www.youtube.com/').kind).toBe('home');
    expect(parseRoute('https://www.youtube.com/playlist?list=WL').kind).toBe('watch_later');
    expect(parseRoute('https://www.youtube.com/playlist?list=PL123').kind).toBe('other');
    expect(parseRoute('https://www.youtube.com/results?search_query=x').kind).toBe('other');
    expect(parseRoute('https://www.youtube.com/watch?v=short').kind).toBe('other');
    expect(parseRoute('https://music.youtube.com/watch?v=dQw4w9WgXcQ').kind).toBe('other');
    expect(parseRoute('https://evil.example/watch?v=dQw4w9WgXcQ').kind).toBe('other');
  });
});

describe('daily skips', () => {
  const tz = 'America/New_York';
  const at = (iso: string) => Date.parse(iso);
  const fresh = (day: string): SkipLedger => ({ day, used: 0, spends: [] });

  it('allows two per day and refuses the third', () => {
    let l = fresh('2026-09-30');
    const now = at('2026-09-30T15:00:00Z');
    const a = spendSkip(l, now, tz, 'req-00000001', 'AAAAAAAAAA1');
    expect(a.ok).toBe(true);
    l = a.ledger;
    const b = spendSkip(l, now, tz, 'req-00000002', 'BBBBBBBBBB2');
    expect(b.ok).toBe(true);
    l = b.ledger;
    expect(spendSkip(l, now, tz, 'req-00000003', 'CCCCCCCCCC3').ok).toBe(false);
  });

  it('is idempotent per request ID', () => {
    const now = at('2026-09-30T15:00:00Z');
    const a = spendSkip(fresh('2026-09-30'), now, tz, 'req-00000001', 'AAAAAAAAAA1');
    const again = spendSkip(a.ledger, now, tz, 'req-00000001', 'AAAAAAAAAA1');
    expect(again.ok && again.duplicate).toBe(true);
    expect(again.ledger.used).toBe(1);
  });

  it('resets at local midnight, not UTC midnight', () => {
    const used: SkipLedger = { day: '2026-09-30', used: 2, spends: [] };
    // 23:30 local (03:30Z next day) is still Sept 30 in New York.
    expect(skipsRemaining(used, at('2026-10-01T03:30:00Z'), tz)).toBe(0);
    // 00:10 local Oct 1.
    expect(skipsRemaining(used, at('2026-10-01T04:10:00Z'), tz)).toBe(2);
  });

  it('handles daylight saving boundaries', () => {
    // DST ends 2026-11-01 in New York: 23:59 EST Nov 1 = 04:59Z Nov 2.
    expect(dayInZone(at('2026-11-02T04:59:00Z'), tz)).toBe('2026-11-01');
    expect(dayInZone(at('2026-11-02T05:00:00Z'), tz)).toBe('2026-11-02');
    // DST starts 2026-03-08: 00:30 EST Mar 8 = 05:30Z.
    expect(dayInZone(at('2026-03-08T05:30:00Z'), tz)).toBe('2026-03-08');
  });

  it('survives browser closure over midnight (lazy reset) and ignores backward clocks', () => {
    const used: SkipLedger = { day: '2026-09-30', used: 2, spends: [] };
    // Days later: new allowance, no rollover.
    expect(rollLedger(used, at('2026-10-03T12:00:00Z'), tz)).toMatchObject({ day: '2026-10-03', used: 0 });
    // Clock moved back a day: keep the current ledger, no reset.
    expect(rollLedger(used, at('2026-09-29T12:00:00Z'), tz)).toBe(used);
    expect(skipsRemaining(used, at('2026-09-29T12:00:00Z'), tz)).toBe(0);
  });
});

describe('message validation', () => {
  it('rejects malformed messages', () => {
    expect(isMessage({ type: 'skip', videoId: 'bad', requestId: 'abcdefgh-1' })).toBe(false);
    expect(isMessage({ type: 'skip', videoId: 'dQw4w9WgXcQ', requestId: 'x' })).toBe(false);
    expect(isMessage({ type: 'eval', code: '1' })).toBe(false);
    expect(isMessage({ type: 'ended', videoId: 'dQw4w9WgXcQ', duration: 10 })).toBe(false);
    expect(isMessage({ type: 'skip', videoId: 'dQw4w9WgXcQ', requestId: crypto.randomUUID() })).toBe(true);
  });
});
