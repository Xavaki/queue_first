// Typed wrapper for messages to the background controller.

import type { Message } from '../shared/messages';

export async function send<T>(msg: Message): Promise<T> {
  const res = (await browser.runtime.sendMessage(msg)) as T | { error: string };
  if (res && typeof res === 'object' && 'error' in res && Object.keys(res).length === 1) {
    throw new Error((res as { error: string }).error);
  }
  return res as T;
}

export function requestId(): string {
  return crypto.randomUUID();
}
