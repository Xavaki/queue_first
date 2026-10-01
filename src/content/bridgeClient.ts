// Isolated-world client for the main-world bridge. Replies are page-originated
// and untrusted, so every result is shape-checked.

import {
  FROM_BRIDGE,
  TO_BRIDGE,
  validateResult,
  type BridgeReply,
  type BridgeRequest,
  type BridgeResults,
} from '../adapters/youtube/bridge-protocol';

const pending = new Map<string, { op: BridgeRequest['op']; resolve: (v: unknown) => void; reject: (e: Error) => void }>();

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const data = ev.data as BridgeReply | undefined;
  if (!data || data.channel !== FROM_BRIDGE || typeof data.opId !== 'string') return;
  const p = pending.get(data.opId);
  if (!p) return;
  pending.delete(data.opId);
  if (!data.ok) {
    p.reject(new Error(typeof data.error === 'string' ? data.error.slice(0, 300) : 'Bridge error'));
    return;
  }
  // Copy out of the page compartment before validating.
  const result: unknown = data.result === undefined ? undefined : JSON.parse(JSON.stringify(data.result));
  if (!validateResult(p.op, result)) {
    p.reject(new Error(`Invalid ${p.op} reply`));
    return;
  }
  p.resolve(result);
});

export function callBridge<K extends BridgeRequest['op']>(
  request: Extract<BridgeRequest, { op: K }>,
  timeoutMs = 60_000,
): Promise<BridgeResults[K]> {
  const opId = crypto.randomUUID();
  return new Promise<BridgeResults[K]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(opId);
      reject(new Error(`${request.op} timed out`));
    }, timeoutMs);
    pending.set(opId, {
      op: request.op,
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v as BridgeResults[K]);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    window.postMessage({ channel: TO_BRIDGE, opId, request }, location.origin);
  });
}

/** Stable, non-reversible account scope from the page's datasync identifier. */
export async function accountKeyFor(datasyncId: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`queue-first:${datasyncId}`));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}
