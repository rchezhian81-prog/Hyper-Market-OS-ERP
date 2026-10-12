import { expect } from 'vitest';
import { makeEvent } from '../../packages/contracts/src/event';
import type { EventStore } from '../../packages/persistence/src/event-store';
import { STREAM, streamName, billNumberFindingsOf, issuedPrefixStores } from '../../services/api/src/adapters';
import type { BoxHealthRecord } from '../../services/platform/src/box-health';

// Verifier r20 (cost): the two "never received" cost scenarios, shared by the performance suite (memory, counted) and the
// integration suite (PostgreSQL, counted and timed). See tests/performance/the-never-received-check-reads-by-range.test.ts.

const pad = (n: number): string => String(n).padStart(6, '0');
const LANES = Array.from({ length: 8 }, (_, i) => `S1L${i + 1}-`);

function counting(inner: EventStore): { store: EventStore; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const store = new Proxy(inner, {
    get: (target, prop, receiver) => {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => { calls[String(prop)] = (calls[String(prop)] ?? 0) + 1; return (v as (...x: unknown[]) => unknown).apply(target, a); };
    },
  }) as EventStore;
  return { store, calls };
}

async function seed(store: EventStore, T: string, bankedPerLane: number, skip: (lane: string, n: number) => boolean): Promise<void> {
  for (const p of LANES) {
    const entries = [];
    for (let n = 1; n <= bankedPerLane; n += 1) {
      if (skip(p, n)) continue;
      entries.push({ stream: STREAM.sales, event: makeEvent({ id: `receipt-${p}${pad(n)}`, type: 'ReceiptNumberIssued', occurredAt: new Date().toISOString(), idempotencyKey: `receipt-${T}-${p}${pad(n)}`, source: 'perf', payload: { receiptNumber: `${p}${pad(n)}`, saleId: `S-${p}${pad(n)}` } }) });
    }
    for (let i = 0; i < entries.length; i += 200) await store.appendBatch(T, entries.slice(i, i + 200));
  }
  // The prefixes are issued to store S1's tills (as the owner's prefix route records them).
  await store.appendBatch(T, LANES.map((p, i) => ({ stream: streamName(STREAM.org, 'till-receipt-prefixes'), event: makeEvent({
    id: `pfx-${p}`, type: 'TillReceiptPrefixIssued', occurredAt: new Date().toISOString(), idempotencyKey: `pfx-${T}-${p}`, source: 'perf',
    payload: { storeId: 'S1', tillId: `lane-${i + 1}`, prefix: p, version: 1, setAt: new Date().toISOString(), setBy: 'u-owner' },
  }) })));
}

const record = (at: string, issued: BoxHealthRecord['receiptNumbersIssued']): BoxHealthRecord => ({
  storeId: 'S1', observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
  disk: { freeBytes: 5e10, totalBytes: 1e11, salesLogUsedBytes: 1e6, salesLogCapacityBytes: 1e10, reserveBytes: 1e8 },
  queue: { unsent: 0, deadLettered: 0 }, ...(issued === undefined ? {} : { receiptNumbersIssued: issued }),
});

export async function unbankedAboveBanked(inner: EventStore, T: string, timed: boolean): Promise<void> {
  await seed(inner, T, 100, () => false);
  expect((await issuedPrefixStores(inner, T)).get('S1L1-')?.has('S1')).toBe(true);
  const t0 = Date.now() - 3_600_000;
  // Each lane's box reported 600 sold, 500 above banked, holding none unsent — over half an hour ago.
  const records = [record(new Date(t0).toISOString(), LANES.map((p) => ({ prefix: p, through: 600, soldThrough: 600, unsent: { count: 0 } })))];
  const { store, calls } = counting(inner);
  await billNumberFindingsOf(store, T, records, new Date().toISOString()); // warm the high-water snapshot
  for (const k of Object.keys(calls)) delete calls[k];
  const s = Date.now();
  const f = await billNumberFindingsOf(store, T, records, new Date().toISOString());
  const ms = Date.now() - s;
  expect((f.get('S1') ?? []).filter((x) => x.kind === 'issued_never_received').map((x) => [x.prefix, x.ranges])).toEqual(LANES.map((p) => [p, [[101, 600]]]));
  expect(calls['findByIdempotencyKey'] ?? 0).toBe(0); // never one at a time
  expect(calls['existingIdempotencyKeys'] ?? 0).toBe(0); // above banked: nothing to read
  if (timed) {
    console.log(`[never-received cost] 8 lanes x 500 unbanked, one health read: ${ms} ms`);
    expect(ms).toBeLessThan(200);
  }
}

export async function atRiskBelowBanked(inner: EventStore, T: string, timed: boolean): Promise<void> {
  // A restored box cannot vouch for 101–600 on each lane; head office banked all but 20 of them (every 25th).
  await seed(inner, T, 700, (_p, n) => n > 100 && n <= 600 && n % 25 === 0);
  const t0 = Date.now() - 3_600_000;
  const records = [record(new Date(t0).toISOString(), LANES.map((p) => ({ prefix: p, through: 700, soldThrough: 700, atRisk: [[101, 600]] as [number, number][], unsent: { count: 0 } })))];
  const { store, calls } = counting(inner);
  await billNumberFindingsOf(store, T, records, new Date().toISOString());
  for (const k of Object.keys(calls)) delete calls[k];
  const s = Date.now();
  const f = await billNumberFindingsOf(store, T, records, new Date().toISOString());
  const ms = Date.now() - s;
  const missing = Array.from({ length: 20 }, (_, i) => 125 + i * 25);
  for (const p of LANES) {
    const named = (f.get('S1') ?? []).find((x) => x.kind === 'issued_never_received' && x.prefix === p);
    expect(named?.ranges).toEqual(missing.map((n) => [n, n]));
  }
  expect(calls['findByIdempotencyKey'] ?? 0).toBe(0);
  expect(calls['existingIdempotencyKeys']).toBe(LANES.length); // ONE indexed read per prefix
  if (timed) {
    console.log(`[never-received cost] 8 lanes x 500 at-risk below banked, one health read: ${ms} ms`);
    expect(ms).toBeLessThan(200);
  }
}

