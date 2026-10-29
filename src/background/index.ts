// Background entry point: validates every message and routes it to the controller.

import { hasYouTubeAccess } from '../shared/access';
import { isMessage } from '../shared/messages';
import { handle, onTabRemoved } from './controller';

const YT_ORIGIN = 'https://www.youtube.com';
const EXTENSION_ORIGIN = new URL(browser.runtime.getURL('/')).origin;

browser.runtime.onMessage.addListener((message: unknown, sender: browser.runtime.MessageSender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  if (!isMessage(message)) return Promise.resolve({ error: 'invalid_message' });

  // Content messages must come from a YouTube top frame; UI messages from
  // extension pages.
  const url = sender.url ?? null;
  const fromYouTube = !!url && url.startsWith(`${YT_ORIGIN}/`) && sender.tab?.id !== undefined && sender.frameId === 0;
  const fromExtension = !!url && url.startsWith(EXTENSION_ORIGIN);
  if (!fromYouTube && !fromExtension) return Promise.resolve({ error: 'invalid_sender' });

  const tabId = fromYouTube ? sender.tab!.id! : null;
  return currentUrl(tabId, url)
    .then((pageUrl) => handle(message, { tabId, url: pageUrl }))
    .catch((e: unknown) => {
      console.error('Queue First:', message.type, e);
      return { error: String((e as Error)?.message ?? e) };
    });
});

/**
 * The page a YouTube tab is on now. Firefox's sender.url keeps the URL the
 * document was loaded at, so after YouTube's in-page navigation it can name
 * the previous page; the tab's own URL follows pushState. Falls back to the
 * sender URL when the tab is gone or is no longer on YouTube.
 */
async function currentUrl(tabId: number | null, senderUrl: string | null): Promise<string | null> {
  if (tabId === null) return senderUrl;
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.url?.startsWith(`${YT_ORIGIN}/`)) return tab.url;
  } catch {
    // Tab closed while the message was in flight.
  }
  return senderUrl;
}

// Missing YouTube access stops everything silently: flag it on the toolbar
// button, and open settings (which offers the fix) right after install.
async function showAccessState(): Promise<boolean> {
  const ok = await hasYouTubeAccess();
  await browser.action.setBadgeText({ text: ok ? '' : '!' });
  await browser.action.setBadgeBackgroundColor({ color: '#b3261e' });
  await browser.action.setTitle({ title: ok ? 'Queue First' : 'Queue First: YouTube access is off. Click to fix.' });
  return ok;
}
browser.permissions.onAdded.addListener(() => void showAccessState());
browser.permissions.onRemoved.addListener(() => void showAccessState());
browser.runtime.onInstalled.addListener(async ({ reason }) => {
  const ok = await showAccessState();
  if (!ok && reason === 'install') await browser.runtime.openOptionsPage();
});
void showAccessState();

browser.tabs.onRemoved.addListener((tabId) => {
  void onTabRemoved(tabId);
});
