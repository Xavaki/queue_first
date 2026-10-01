// Small shadow-DOM UI toolkit: neutral styling that follows YouTube's light
// and dark themes, rem-based sizing for enlarged text, keyboard focus styles.

import { DARK_ATTR } from '../adapters/youtube/selectors';

export const UI_HOST_ATTR = 'data-queue-first-ui';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((ev: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const BASE_CSS = `
:host { all: initial; }
:host {
  --qf-bg: #ffffff; --qf-fg: #0f0f0f; --qf-muted: #606060; --qf-border: #d9d9d9;
  --qf-accent: #065fd4; --qf-accent-fg: #ffffff; --qf-soft: #f2f2f2; --qf-warn: #b3261e;
  --qf-shadow: 0 4px 24px rgba(0,0,0,.18);
  font-family: Roboto, Arial, sans-serif; font-size: 1.4rem; line-height: 1.4; color: var(--qf-fg);
}
:host([data-theme="dark"]) {
  --qf-bg: #212121; --qf-fg: #f1f1f1; --qf-muted: #aaaaaa; --qf-border: #3f3f3f;
  --qf-accent: #3ea6ff; --qf-accent-fg: #0f0f0f; --qf-soft: #303030; --qf-warn: #f28b82;
}
* { box-sizing: border-box; }
button {
  font: inherit; font-size: 1.3rem; font-weight: 500; cursor: pointer; border-radius: 1.8rem;
  padding: .6rem 1.4rem; border: 1px solid var(--qf-border); background: var(--qf-soft); color: var(--qf-fg);
}
button.primary { background: var(--qf-accent); color: var(--qf-accent-fg); border-color: transparent; }
button.link { background: none; border: none; padding: .2rem .4rem; color: var(--qf-accent); }
button:disabled { opacity: .55; cursor: not-allowed; }
button:focus-visible, a:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--qf-accent); outline-offset: 2px; }
.muted { color: var(--qf-muted); }
.warn { color: var(--qf-warn); }
.row { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

function syncTheme(host: HTMLElement): void {
  const apply = () =>
    host.setAttribute('data-theme', document.documentElement.hasAttribute(DARK_ATTR) ? 'dark' : 'light');
  apply();
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: [DARK_ATTR] });
}

export function createHost(css: string, tag = 'div'): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag);
  host.setAttribute(UI_HOST_ATTR, '');
  const root = host.attachShadow({ mode: 'closed' });
  root.append(h('style', {}, BASE_CSS + css));
  syncTheme(host);
  return { host, root };
}

export function isOwnUi(ev: Event): boolean {
  return ev.composedPath().some((n) => n instanceof HTMLElement && n.hasAttribute(UI_HOST_ATTR));
}
