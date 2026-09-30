// The device → store-computer leg of the shared sync path (P-01, §31, hard rules #6/#10 — SP-2a, F11).
//
// A screen or handheld drains its own `DeviceOutbox` to the box's `/lane/outbox` route in batches and
// settles each item from the box's per-item answer. This is the ONLY code that decides what a box's
// answer means for the device's queue, so every surface behaves the same way:
//
//   accepted / duplicate → acknowledge (the box has it durably; a lost reply and a retry land on
//                           `duplicate`, which is the same fact — one effect, §31.1)
//   refused              → dead-letter with the box's reason (a person must look; never dropped, #6)
//   not_saved            → count the attempt, keep it (the box could not write; try again later)
//   no answer for a key  → count the attempt, keep it (never assumed delivered — RR-F02)
//   the link failed      → count the attempt on every item sent, keep them all, stop (a device offline
//                           for a day loses nothing and dead-letters nothing — a link failure is not a refusal)
//
// Pure over an injected `fetch`, so it is testable without a browser and identical on every surface.

import type { SyncOutbox } from './outbox';
import {
  DEVICE_OUTBOX_PATH, DEVICE_OUTBOX_STATUS_PATH, relayableItems,
  type BoxItemStatus, type DeviceAck, type RelayBatch,
} from './device-relay';

/** The slice of `fetch` this needs, so a test can hand in a stub and a browser its own. */
export type FetchLike = (
  url: string,
  init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

export interface DrainToBoxInput {
  readonly outbox: SyncOutbox;
  /** The box's lane write base, e.g. `http://127.0.0.1:8123` (`window.laneWriteBase` on a served screen). */
  readonly boxBase: string;
  /** Which surface this is (`manager`, `picker`, …) — the box checks the allow-list per source. */
  readonly source: string;
  readonly fetch: FetchLike;
  /** Items per batch. Small on purpose: a handheld on shop wifi should not post a day's work in one body. */
  readonly limit?: number;
}

export interface DrainToBoxResult {
  /** Items in this pass's batch. */
  readonly attempted: number;
  /** Now on the box's disk (accepted or duplicate). */
  readonly handed: number;
  /** Refused by the box — dead-lettered on the device with the reason. */
  readonly refused: number;
  /** Kept for another try (the box could not save them, or answered nothing for them). */
  readonly failed: number;
  /** True when the box could not be reached at all; every attempted item was kept. */
  readonly offline: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function readAcks(body: unknown): readonly DeviceAck[] {
  if (!isObj(body) || !Array.isArray(body['acks'])) return [];
  const out: DeviceAck[] = [];
  for (const a of body['acks'] as unknown[]) {
    if (!isObj(a) || typeof a['key'] !== 'string') continue;
    const status = a['status'];
    if (status !== 'accepted' && status !== 'duplicate' && status !== 'refused' && status !== 'not_saved') continue;
    out.push({ key: a['key'], status, ...(typeof a['reason'] === 'string' ? { reason: a['reason'] } : {}) });
  }
  return out;
}

/** One pass: hand this device's pending, relayable items to the box and settle each from its answer. */
export async function drainToBox(input: DrainToBoxInput): Promise<DrainToBoxResult> {
  const batch = relayableItems(input.outbox.pending(), input.source).slice(0, input.limit ?? 20);
  if (batch.length === 0) return { attempted: 0, handed: 0, refused: 0, failed: 0, offline: false };

  const body: RelayBatch = { source: input.source, items: batch.map((i) => ({ key: i.key, event: i.event })) };
  // Called as a bare function, never as `input.fetch(...)`: a browser's `fetch` refuses to run with any `this` but
  // the window ("Illegal invocation"), and a method call would hand it this options object.
  const { fetch: fetchFn } = input;
  let acks: readonly DeviceAck[];
  try {
    const res = await fetchFn(`${input.boxBase}${DEVICE_OUTBOX_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    // Anything but 200 is the box declining the BATCH (malformed envelope, wrong origin, too large) — not a
    // verdict on any item, so every item is kept and counted as a failed attempt, never dead-lettered.
    acks = res.status === 200 ? readAcks(await res.json().catch(() => undefined)) : [];
  } catch {
    for (const item of batch) input.outbox.recordFailure(item.key);
    return { attempted: batch.length, handed: 0, refused: 0, failed: batch.length, offline: true };
  }

  const byKey = new Map(acks.map((a) => [a.key, a] as const));
  let handed = 0;
  let refused = 0;
  let failed = 0;
  for (const item of batch) {
    const ack = byKey.get(item.key);
    if (ack === undefined || ack.status === 'not_saved') {
      input.outbox.recordFailure(item.key);
      failed += 1;
    } else if (ack.status === 'refused') {
      input.outbox.deadLetter(item.key, `refused by the store computer: ${ack.reason ?? 'no reason given'}`);
      refused += 1;
    } else {
      input.outbox.acknowledge(item.key);
      handed += 1;
    }
  }
  return { attempted: batch.length, handed, refused, failed, offline: false };
}

/**
 * Ask the box where items it accepted have got to (pending on the box · posted to head office · refused).
 * `undefined` when the box could not be asked — the screen then keeps saying "handed to the store
 * computer", which is still true, rather than guessing further.
 */
export async function boxStatus(input: {
  readonly boxBase: string;
  readonly keys: readonly string[];
  readonly fetch: FetchLike;
}): Promise<readonly BoxItemStatus[] | undefined> {
  if (input.keys.length === 0) return [];
  const { fetch: fetchFn } = input;
  try {
    const res = await fetchFn(
      `${input.boxBase}${DEVICE_OUTBOX_STATUS_PATH}?keys=${encodeURIComponent(input.keys.join(','))}`,
      { method: 'GET', headers: { accept: 'application/json' } },
    );
    if (res.status !== 200) return undefined;
    const body = await res.json().catch(() => undefined);
    if (!isObj(body) || !Array.isArray(body['items'])) return undefined;
    const out: BoxItemStatus[] = [];
    for (const s of body['items'] as unknown[]) {
      if (!isObj(s) || typeof s['key'] !== 'string') continue;
      const state = s['state'];
      if (state !== 'pending' && state !== 'posted' && state !== 'refused' && state !== 'unknown') continue;
      out.push({
        key: s['key'], state,
        attempts: typeof s['attempts'] === 'number' ? s['attempts'] : 0,
        ...(typeof s['reason'] === 'string' ? { reason: s['reason'] } : {}),
      });
    }
    return out;
  } catch {
    return undefined;
  }
}
