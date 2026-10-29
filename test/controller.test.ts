// Background controller tests against an in-memory browser and a fake
// Watch Later behind the tab bridge.

import { beforeEach, describe, expect, it } from 'vitest';
import { handle, type Sender } from '../src/background/controller';
import type { BridgeRequest } from '../src/adapters/youtube/bridge-protocol';
import type { ClassifyResult, EnqueueResult, LaunchResult, SkipResult } from '../src/shared/messages';
import type { PlaybackDecision } from '../src/shared/types';

const HOME = 'https://www.youtube.com/';
const WL = 'https://www.youtube.com/playlist?list=WL';
const KEY = 'a'.repeat(32);
const [A, B, C, D, M] = ['AAAAAAAAAA1', 'BBBBBBBBBB2', 'CCCCCCCCCC3', 'DDDDDDDDDD4', 'MMMMMMMMMM5'];

let local: Map<string, unknown>;
let session: Map<string, unknown>;
let watchLater: string[];
let calls: Record<string, number>;
let hasFails: boolean;

function playerHtml(id: string, category: string): string {
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify({
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: id, title: `Title ${id}`, lengthSeconds: '100' },
    microformat: { playerMicroformatRenderer: { category } },
  })};</script>`;
}

function bridge(req: BridgeRequest): unknown {
  calls[req.op] = (calls[req.op] ?? 0) + 1;
  switch (req.op) {
    case 'wl.snapshot':
      return { complete: true, pages: 1, items: watchLater.map((videoId) => ({ videoId, title: videoId, playable: true })) };
    case 'wl.has':
      return { present: hasFails ? null : watchLater.includes(req.videoId) };
    case 'wl.add':
      if (!watchLater.includes(req.videoId)) watchLater.push(req.videoId);
      return { ok: true };
    default:
      return null;
  }
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
const area = (m: () => Map<string, unknown>) => ({
  get: async (k: string) => ({ [k]: clone(m().get(k)) }),
  set: async (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) m().set(k, clone(v));
  },
});

beforeEach(() => {
  local = new Map();
  session = new Map();
  watchLater = [];
  calls = {};
  hasFails = false;
  (globalThis as unknown as { browser: unknown }).browser = {
    storage: { local: area(() => local), session: area(() => session) },
    tabs: {
      sendMessage: async (_tab: number, msg: { type: string; request?: BridgeRequest }) =>
        msg.type === 'bridge' ? bridge(msg.request!) : undefined,
      query: async () => [],
      create: async () => ({}),
    },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };
  globalThis.fetch = (async (url: string) => {
    const id = new URL(url).searchParams.get('v')!;
    return new Response(playerHtml(id, id === M ? 'Music' : 'Education'));
  }) as typeof fetch;
});

const at = (tabId: number, url: string): Sender => ({ tabId, url });
const rid = () => crypto.randomUUID();

async function setup(tabIds = [1, 2]) {
  for (const t of tabIds) await handle({ type: 'hello', account: { loggedIn: true, accountKey: KEY } }, at(t, HOME));
  await handle({ type: 'wlState', refresh: true }, at(tabIds[0]!, WL));
}

const enqueue = (tab: number, videoId: string, requestId = rid()) =>
  handle({ type: 'enqueue', videoId, title: videoId, requestId }, at(tab, HOME)) as Promise<EnqueueResult>;
const skip = (tab: number, videoId: string, requestId = rid(), url = HOME) =>
  handle({ type: 'skip', videoId, requestId }, at(tab, url)) as Promise<SkipResult>;
const evaluate = (tab: number, videoId: string) =>
  handle({ type: 'evaluate', videoId }, at(tab, `https://www.youtube.com/watch?v=${videoId}`)) as Promise<PlaybackDecision>;
const launch = (tab: number, videoId: string) =>
  handle({ type: 'launch', videoId, requestId: rid() }, at(tab, WL)) as Promise<LaunchResult>;

describe('queueing and launching', () => {
  it('queues nonmusic without playing it; the oldest plays directly', async () => {
    await setup();
    expect(await enqueue(1, A)).toMatchObject({ status: 'added', position: 1 });
    expect(watchLater).toEqual([A]);
    expect(await evaluate(1, A)).toMatchObject({ allowed: true, kind: 'ordinary' });
    await enqueue(1, B);
    expect(await enqueue(1, A)).toMatchObject({ status: 'already_queued', position: 1 });
    expect(await launch(1, B)).toMatchObject({ status: 'refused' });
    expect(await launch(1, A)).toMatchObject({ status: 'granted' });
    expect(await evaluate(1, A)).toMatchObject({ allowed: true, kind: 'ordinary' });
    // The oldest plays in any tab; queued-behind videos do not.
    expect(await evaluate(1, A)).toMatchObject({ allowed: true });
    expect(await evaluate(2, A)).toMatchObject({ allowed: true });
    expect(await evaluate(2, B)).toMatchObject({ allowed: false, reason: 'queued_not_head' });
  });

  it('advances only when you remove the oldest from Watch Later yourself', async () => {
    await setup();
    await enqueue(1, A);
    await enqueue(1, B);
    await launch(1, A);
    expect(await evaluate(1, A)).toMatchObject({ allowed: true, kind: 'ordinary' });
    // Watching never removes anything or advances the queue.
    expect(await evaluate(2, B)).toMatchObject({ reason: 'queued_not_head' });
    // Removed with YouTube's own controls; the next Watch Later read advances.
    watchLater = watchLater.filter((v) => v !== A);
    await handle({ type: 'wlState', refresh: true }, at(2, WL));
    expect(await evaluate(2, B)).toMatchObject({ allowed: true, kind: 'ordinary' });
  });

  it('confirmed music plays without queue insertion', async () => {
    await setup();
    expect(await enqueue(1, M)).toEqual({ status: 'music' });
    expect(calls['wl.add']).toBeUndefined();
    expect(await evaluate(1, M)).toMatchObject({ allowed: true, kind: 'music' });
  });
});

describe('locked card clicks', () => {
  it('report music only for confirmed music or a user override, without queueing', async () => {
    await setup();
    const check = (v: string) => handle({ type: 'classify', videoId: v }, at(1, HOME)) as Promise<ClassifyResult>;
    expect(await check(M)).toEqual({ music: true, category: 'MUSIC' });
    expect(await check(A)).toEqual({ music: false, category: 'NON_MUSIC' });
    await handle({ type: 'addMusicOverride', videoId: A }, at(1, HOME));
    expect(await check(A)).toMatchObject({ music: true });
    expect(calls['wl.add']).toBeUndefined();
  });
});

describe('Watch Later page state', () => {
  it('marks the oldest as head and shades the rest', async () => {
    watchLater = [C, A];
    await setup();
    await enqueue(1, M);
    await enqueue(1, B);
    const s = (await handle({ type: 'wlState', refresh: true }, at(1, WL))) as import('../src/shared/messages').WlState;
    expect(s.head?.videoId).toBe(C);
    expect(s.rows).toMatchObject({ [C]: 'head', [A]: 'locked', [B]: 'locked' });
  });

  it('does not set up from an incomplete read', async () => {
    await handle({ type: 'hello', account: { loggedIn: true, accountKey: KEY } }, at(1, HOME));
    (globalThis as unknown as { browser: { tabs: { sendMessage: unknown } } }).browser.tabs.sendMessage = async () => ({
      complete: false, pages: 1, items: [], error: 'network',
    });
    const s = (await handle({ type: 'wlState', refresh: true }, at(1, WL))) as import('../src/shared/messages').WlState;
    expect(s.init).toBe('uninitialized');
    expect(s.error).toBe('network');
  });

  it('a failed save queues nothing', async () => {
    await setup();
    (globalThis as unknown as { browser: { tabs: { sendMessage: unknown } } }).browser.tabs.sendMessage = async (
      _t: number,
      msg: { type: string; request?: BridgeRequest },
    ) => (msg.request?.op === 'wl.add' ? { ok: false } : bridge(msg.request!));
    expect(await enqueue(1, A)).toEqual({ status: 'failed', error: 'Could not save to Watch Later' });
    expect(await evaluate(1, A)).toMatchObject({ reason: 'not_queued' });
  });
});

describe('homepage skips', () => {
  it('two succeed, the third is refused, with zero Watch Later adds', async () => {
    await setup();
    await enqueue(1, A);
    const addsBefore = calls['wl.add'];
    expect(await skip(1, B)).toMatchObject({ status: 'granted', remaining: 1 });
    expect(await evaluate(1, B)).toMatchObject({ allowed: true, kind: 'skip' });
    expect(await skip(1, C)).toMatchObject({ status: 'granted', remaining: 0 });
    expect(await skip(1, D)).toEqual({ status: 'refused', reason: 'no_skips' });
    expect(calls['wl.add']).toBe(addsBefore);
    expect(watchLater).toEqual([A]);
    expect(await evaluate(2, A)).toMatchObject({ allowed: true, head: { videoId: A } });
  });

  it('queued videos and non-homepage senders cannot use a skip', async () => {
    await setup();
    await enqueue(1, A);
    expect(await skip(1, A)).toEqual({ status: 'refused', reason: 'already_queued' });
    expect(await skip(1, B, rid(), 'https://www.youtube.com/results?search_query=x')).toEqual({ status: 'refused', reason: 'not_homepage' });
  });

  it('unresolved membership holds without charging', async () => {
    await setup();
    hasFails = true;
    expect(await skip(1, B)).toEqual({ status: 'refused', reason: 'membership_unresolved' });
    hasFails = false;
    expect(await skip(1, B)).toMatchObject({ status: 'granted', remaining: 1 });
  });

  it('concurrent requests from two tabs with one skip left produce one grant', async () => {
    await setup();
    await skip(1, B);
    const results = await Promise.all([skip(1, C), skip(2, D)]);
    expect(results.filter((r) => r.status === 'granted')).toHaveLength(1);
  });

  it('duplicate request IDs do not spend twice', async () => {
    await setup();
    const id = rid();
    const [x, y] = await Promise.all([skip(1, B, id), skip(1, B, id)]);
    expect(x).toMatchObject({ status: 'granted', remaining: 1 });
    expect(y).toMatchObject({ status: 'granted', remaining: 1 });
    expect(await skip(1, C)).toMatchObject({ status: 'granted', remaining: 0 });
  });

  it('racing enqueue and skip for the same selection cannot both succeed', async () => {
    await setup();
    const [q, s] = await Promise.all([enqueue(1, B), skip(1, B)]);
    const succeeded = [q.status === 'added', s.status === 'granted'].filter(Boolean);
    expect(succeeded).toHaveLength(1);
  });

  it('a skip grant ends when the tab moves to another video and after restart', async () => {
    await setup();
    await skip(1, B);
    expect((await evaluate(1, B)).allowed).toBe(true);
    await evaluate(1, C);
    expect((await evaluate(1, B)).allowed).toBe(false);

    await skip(1, D);
    session.clear(); // Browser restart: session storage is gone.
    await handle({ type: 'hello', account: { loggedIn: true, accountKey: KEY } }, at(1, HOME));
    expect((await evaluate(1, D)).allowed).toBe(false);
    // Spending persisted.
    expect(await skip(1, C)).toEqual({ status: 'refused', reason: 'no_skips' });
  });
});

describe('accounts', () => {
  it('switching accounts invalidates grants and never mixes queues or refreshes skips', async () => {
    await setup([1]);
    await enqueue(1, A);
    await skip(1, B);
    const other = 'b'.repeat(32);
    await handle({ type: 'hello', account: { loggedIn: true, accountKey: other } }, at(1, HOME));
    expect((await evaluate(1, B)).allowed).toBe(false);
    expect(await evaluate(1, A)).toMatchObject({ reason: 'not_initialized' });
    expect(await skip(1, C)).toMatchObject({ status: 'granted', remaining: 0 });
  });
});
