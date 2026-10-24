// One small queue on a served page's own device outbox, for work done with the line down (OB-288 LP/workforce package ·
// §31 · P-01 · P-08 · hard rules #6 #10): an SOP acknowledgement on the help page, a manual equipment reading on the
// facilities page, a stock loss on the write-off capture page. Each item is written to this device's durable outbox, handed
// to the store computer (the shared `/lane/outbox` path, `drainToBox`), and carried by it to head office; the page shows
// where each has got to in the five words a person sees (saved here · trying · with the store computer · booked at head
// office · refused — a person must look). A refusal is kept with its reason, never dropped. DOM-free and tested.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { deviceItemState, deviceItemReason, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';
import { drainToBox, boxStatus } from '../../../packages/sync/src/device-drain';

export interface QueuedItem<P> { readonly key: string; readonly payload: P; readonly state: DeviceItemState; readonly reason?: string }

export interface BoxQueue<P> {
  /** Save one piece of work on this device (idempotent on its key: a second save of the same key is the same item). */
  enqueue(key: string, payload: P, at: string): void;
  items(): readonly QueuedItem<P>[];
  handedKeys(): readonly string[];
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void;
}

export function createBoxQueue<P extends Record<string, unknown>>(type: string, source: string, outbox: SyncOutbox, boxWords: Map<string, BoxItemStatus> = new Map()): BoxQueue<P> {
  return {
    enqueue: (key, payload, at) => {
      if (outbox.all().some((i) => i.key === key)) return;
      outbox.enqueue(makeEvent({ id: key, type, occurredAt: at, idempotencyKey: key, source, payload }));
    },
    items: () => outbox.all().filter((i) => i.event.type === type).map((i) => {
      const box = boxWords.get(i.key);
      const reason = deviceItemReason(i, box);
      return { key: i.key, payload: i.event.payload as P, state: deviceItemState(i, box), ...(reason === undefined ? {} : { reason }) };
    }),
    handedKeys: () => outbox.all().filter((i) => i.event.type === type && i.state === 'acknowledged').map((i) => i.key),
    noteBoxStatus: (statuses) => { for (const s of statuses) boxWords.set(s.key, s); },
  };
}

/** The leg from this device to the store computer: hand what is waiting, then ask where the handed ones have got to. */
export function openBoxQueueRelay<P>(laneWriteBase: string | undefined, queue: BoxQueue<P>, outbox: SyncOutbox): { syncNow(): Promise<{ handed: number; refused: number; failed: number; offline: boolean }> } | undefined {
  if (laneWriteBase === undefined) return undefined;
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return undefined;
  return {
    syncNow: async () => {
      const result = await drainToBox({ outbox, boxBase: laneWriteBase, source: 'manager', fetch: fetchFn });
      const statuses = await boxStatus({ boxBase: laneWriteBase, keys: queue.handedKeys(), fetch: fetchFn });
      if (statuses !== undefined) queue.noteBoxStatus(statuses);
      return { handed: result.handed, refused: result.refused, failed: result.failed, offline: result.offline };
    },
  };
}

/** The five words, from a page's own copy keys. */
export const STATE_KEYS: Readonly<Record<DeviceItemState, string>> = Object.freeze({ saved_here: 'stSavedHere', retrying: 'stRetrying', handed_to_box: 'stHanded', posted: 'stPosted', refused: 'stRefused' });
