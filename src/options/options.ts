import { wireAccessPrompt } from '../shared/access';
import { videoIdFromHref, isVideoId } from '../shared/ids';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface SettingsState {
  timezone: string;
  timezones: string[];
  account: null | {
    init: string;
    queueSize: number;
    lastSnapshot: { at: number; complete: boolean; count: number; error?: string } | null;
    unconfirmed: number;
    overrides: Array<{ videoId: string; at: number; title?: string }>;
  };
  skipsRemaining: number;
  dailySkips: number;
  cacheSize: number;
}

const send = <T>(msg: object) => browser.runtime.sendMessage(msg) as Promise<T>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

async function load(): Promise<void> {
  const s = await send<SettingsState>({ type: 'settingsState' });

  const acc = $('account');
  acc.replaceChildren();
  if (!s.account) {
    acc.append(el('p', 'No YouTube account connected yet. Open youtube.com while signed in.'));
  } else {
    const a = s.account;
    const snap = a.lastSnapshot
      ? `${new Date(a.lastSnapshot.at).toLocaleString()} · ${a.lastSnapshot.count} items${a.lastSnapshot.complete ? '' : ' · incomplete'}${a.lastSnapshot.error ? ` · ${a.lastSnapshot.error}` : ''}`
      : 'Never';
    const dl = el('dl');
    for (const [k, v] of [
      ['Setup', a.init === 'ready' ? 'Ready' : 'Not set up: open Watch Later'],
      ['Queue size', String(a.queueSize)],
      ['Last Watch Later sync', snap],
    ] as const) {
      dl.append(el('dt', k), el('dd', v));
    }
    acc.append(dl);
  }

  $('skips').textContent = `${s.skipsRemaining} of ${s.dailySkips} skips left today. Skips reset at midnight in the timezone below and do not roll over.`;
  $<HTMLInputElement>('tz').value = s.timezone;
  const list = $('tz-list');
  if (!list.childElementCount) for (const tz of s.timezones) list.append(Object.assign(el('option'), { value: tz }));

  const ul = $('overrides');
  ul.replaceChildren();
  const overrides = s.account?.overrides ?? [];
  if (!overrides.length) ul.append(el('li', 'No overrides.'));
  for (const o of overrides) {
    const li = el('li', `${o.title || o.videoId} (${o.videoId}) `);
    const btn = el('button', 'Remove');
    btn.className = 'link';
    btn.setAttribute('aria-label', `Remove music override for ${o.title || o.videoId}`);
    btn.addEventListener('click', async () => {
      await send({ type: 'removeMusicOverride', videoId: o.videoId });
      await load();
    });
    li.append(btn);
    ul.append(li);
  }
}

$('tz-save').addEventListener('click', async () => {
  const timezone = $<HTMLInputElement>('tz').value.trim();
  const r = await send<{ ok: boolean; error?: string }>({ type: 'setTimezone', timezone });
  $('tz-msg').textContent = r.ok ? `Saved. Skips now reset at midnight in ${timezone}.` : r.error ?? 'Could not save.';
  await load();
});

$('ov-add').addEventListener('click', async () => {
  const raw = $<HTMLInputElement>('ov').value.trim();
  const videoId = isVideoId(raw) ? raw : videoIdFromHref(raw);
  if (!videoId) {
    $('ov-msg').textContent = 'Enter a YouTube video URL or 11-character video ID.';
    return;
  }
  const r = await send<{ ok: boolean }>({ type: 'addMusicOverride', videoId });
  $('ov-msg').textContent = r.ok ? `Added ${videoId} as a user music override.` : 'Open YouTube while signed in first.';
  $<HTMLInputElement>('ov').value = '';
  await load();
});

$('diag').addEventListener('click', async () => {
  const out = $('diag-out');
  out.textContent = JSON.stringify(await send({ type: 'diagnostics' }), null, 2);
  out.hidden = false;
});

$('cache').addEventListener('click', async () => {
  await send({ type: 'clearCategoryCache' });
  $('diag').click();
});

void load();

void wireAccessPrompt($('access'), $<HTMLButtonElement>('access-grant'), () => void load());
