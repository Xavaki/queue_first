// Content controller (isolated world, document_start): observes routes and
// players, intercepts selections, enforces playback, renders UI.

import { NAVIGATE_FINISH_EVENT, NAVIGATE_START_EVENT } from '../adapters/youtube/selectors';
import { parseRoute, type Route } from '../shared/ids';
import type { ContentState, ToContent } from '../shared/messages';
import { send } from './api';
import { accountKeyFor, callBridge } from './bridgeClient';
import { Guard } from './guard';
import { BrowseLock, installInterception } from './intercept';
import { WatchLaterPage } from './watchLaterPage';

let route: Route = parseRoute(location.href);
let lastHref = location.href;
let state: ContentState | null = null;

async function hello(): Promise<void> {
  let loggedIn = false;
  let accountKey: string | null = null;
  try {
    const acc = await callBridge({ op: 'account' }, 20_000);
    loggedIn = acc.loggedIn;
    accountKey = acc.datasyncId ? await accountKeyFor(acc.datasyncId) : null;
  } catch (e) {
    console.warn('Queue First: account lookup failed', e);
  }
  state = await send<ContentState>({ type: 'hello', account: { loggedIn, accountKey } });
}

const ready = hello().catch((e) => console.warn('Queue First: hello failed', e));
const guard = new Guard(route, ready);
const wlPage = new WatchLaterPage();

const deps = {
  route: () => route,
  state: () => state,
  activeAllowedId: () => {
    const id = guard.activeId();
    return id && guard.decisionFor(id)?.allowed ? id : null;
  },
  wlStatus: (videoId: string) => wlPage.statusOf(videoId),
  launch: (videoId: string) => void wlPage.launch(videoId),
  onPolicyChange: () => void refreshState(),
};
const lock = new BrowseLock(deps);

async function refreshState(): Promise<void> {
  try {
    state = await send<ContentState>({ type: 'getState' });
  } catch {
    return;
  }
  lock.refresh();
}

function onRoute(): void {
  if (location.href === lastHref) return;
  lastHref = location.href;
  route = parseRoute(location.href);
  applyRoute();
}

function applyRoute(): void {
  guard.setRoute(route);
  lock.setRoute(route);
  if (route.kind === 'watch_later') {
    if (!wlPage.isActive()) void ready.then(() => route.kind === 'watch_later' && wlPage.start());
  } else {
    wlPage.stop();
  }
}

guard.start();
installInterception(deps, lock);

document.addEventListener(NAVIGATE_START_EVENT, () => lock.navigating());
document.addEventListener(NAVIGATE_FINISH_EVENT, () => {
  onRoute();
  lock.navigated();
});
window.addEventListener('popstate', onRoute);
setInterval(() => {
  onRoute();
  lock.sync();
}, 400);

const whenBody = () => {
  applyRoute();
  void ready.then(() => lock.refresh());
};
if (document.body) whenBody();
else document.addEventListener('DOMContentLoaded', whenBody, { once: true });

browser.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as ToContent;
  if (m?.type === 'bridge') {
    return callBridge(m.request as never).catch((e: Error) => {
      throw new Error(e.message);
    });
  }
  if (m?.type === 'stateChanged') {
    void refreshState();
    guard.refresh();
    if (wlPage.isActive()) void wlPage.load(false);
  }
  return undefined;
});
