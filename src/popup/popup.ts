import { wireAccessPrompt } from '../shared/access';
import type { PopupState } from '../shared/messages';

const $ = (id: string) => document.getElementById(id)!;

const STATUS: Record<PopupState['protection'], string> = {
  active: 'Protection on',
  signed_out: 'Signed out of YouTube: ordinary playback is locked',
  setup_needed: 'Setup needed: open Watch Later',
  unknown: 'Open YouTube to connect',
};

async function load(): Promise<void> {
  const s = (await browser.runtime.sendMessage({ type: 'popupState' })) as PopupState;
  $('status').textContent = STATUS[s.protection];
  $('queue').textContent = String(s.queueSize);
  $('head').textContent = s.head ? s.head.title || s.head.videoId : 'Nothing queued';
  $('skips').textContent = `${s.skipsRemaining} of 2`;
  $('reset').textContent = `${s.nextReset} (${s.timezone})`;
}

$('open').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'openWatchLater' });
  window.close();
});
$('settings').addEventListener('click', async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});

void wireAccessPrompt($('access'), $('access-grant') as HTMLButtonElement, () => void load());

load().catch((e) => {
  $('status').textContent = `Error: ${(e as Error).message}`;
});
