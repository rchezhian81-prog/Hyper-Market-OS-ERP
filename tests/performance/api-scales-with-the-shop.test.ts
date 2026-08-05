import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { posAdapter, inventoryAdapter, STREAM } from '../../services/api/src/adapters';

/**
 * **The cost of banking a sale must not grow with how long the shop has been open.**
 *
 * This is the test that should have been written the moment the adapters were. Every one of them
 * folds a stream, and a fold reads everything — so the first version answered *"has this sale
 * already been banked?"* by loading **every sale the shop has ever made** and building a Set of
 * them. Correct, and it gets slower every day the shop trades.
 *
 * The arithmetic is what makes it serious rather than untidy. SRE takes roughly 2,000 sales a day.
 * That is 60,000 in a month and 700,000 in a year, and the cost was paid **per sale** — so by month
 * three each till was waiting on a scan of a quarter of a million rows to be told a two-word
 * answer. It would not have shown up in any test written against a hundred fixtures, it would not
 * have shown up in the first week of the pilot, and it would have arrived as "the tills have got
 * slow" with nothing obviously changed.
 *
 * The fault was in a **type**, which is why reading the code did not reveal it: the port said
 * `bankedSaleIds: (tenantId) => Set<string>`. A port that hands back the whole history obliges
 * every implementation to read the whole history, and no adapter written against it could have
 * been fast. The fix was to ask the question instead of asking for the material to answer it.
 *
 * These tests are ratios rather than absolute times, so they mean the same thing on a laptop, in
 * CI and on the shop's back-office PC.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-08-05T12:00:00Z';

/** A store holding `n` sales and `n` movements, as if the shop had been trading a while. */
async function shopWithHistory(n: number): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  for (let i = 0; i < n; i += 1) {
    await store.append(TENANT, STREAM.sales, makeEvent({
      id: `sale-${i}`, type: 'SaleCommitted', occurredAt: NOW,
      idempotencyKey: `sale-${TENANT}-S-${i}`, source: 'test',
      payload: {
        saleId: `S-${i}`, receiptNumber: `R-${i}`, laneId: 'lane-1', cashierId: 'u-1',
        tradingDay: '2026-08-05', committedAt: NOW, totalMinor: 10_000, currency: 'INR',
        packVersion: 1, lines: [], tenders: [],
      },
    }));
    await store.append(TENANT, STREAM.inventory, makeEvent({
      id: `mv-${i}`, type: 'InventoryMoved', occurredAt: NOW,
      idempotencyKey: `mv-${TENANT}-M-${i}`, source: 'test',
      payload: {
        movementId: `M-${i}`, productId: `P-${i % 100}`, locationId: 'L1', kind: 'received',
        quantityMinor: 1, uom: 'each', occurredAt: NOW, enteredBy: 'u-1',
      },
    }));
  }
  return store;
}

/** Milliseconds for `runs` iterations, after a warm-up that is thrown away. */
async function timed(runs: number, fn: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 20; i += 1) await fn();
  const started = performance.now();
  for (let i = 0; i < runs; i += 1) await fn();
  return performance.now() - started;
}

describe('the API does not get slower as the shop trades', () => {
  it('answers "was this sale already banked?" in the same time after 200 sales and after 20,000', async () => {
    const small = posAdapter({ store: await shopWithHistory(200), now: () => NOW });
    const large = posAdapter({ store: await shopWithHistory(20_000), now: () => NOW });

    const t200 = await timed(200, () => Promise.resolve(small.isBanked(TENANT, 'S-7')));
    const t20k = await timed(200, () => Promise.resolve(large.isBanked(TENANT, 'S-7')));

    // A hundred times the history. Anything close to a hundred times the work is a full scan.
    expect(t20k).toBeLessThan(Math.max(t200, 0.5) * 10);
  });

  it('answers "who holds this receipt number?" without reading every receipt ever issued', async () => {
    const small = posAdapter({ store: await shopWithHistory(200), now: () => NOW });
    const large = posAdapter({ store: await shopWithHistory(20_000), now: () => NOW });

    const t200 = await timed(200, () => Promise.resolve(small.saleHoldingReceipt(TENANT, 'R-7')));
    const t20k = await timed(200, () => Promise.resolve(large.saleHoldingReceipt(TENANT, 'R-7')));

    expect(t20k).toBeLessThan(Math.max(t200, 0.5) * 10);
  });

  it('finds a MISSING sale as quickly as a present one', async () => {
    // The absent case is the one that tempts an implementation into "well, I looked everywhere".
    // It is also the common case: almost every sale arriving is one we have not seen.
    const large = posAdapter({ store: await shopWithHistory(20_000), now: () => NOW });

    const present = await timed(200, () => Promise.resolve(large.isBanked(TENANT, 'S-19999')));
    const absent = await timed(200, () => Promise.resolve(large.isBanked(TENANT, 'S-NEW')));

    expect(absent).toBeLessThan(Math.max(present, 0.5) * 10);
  });

  it('checks a movement it has never seen without loading the whole stock ledger', async () => {
    const small = inventoryAdapter({ store: await shopWithHistory(200), now: () => NOW });
    const large = inventoryAdapter({ store: await shopWithHistory(20_000), now: () => NOW });

    const t200 = await timed(200, () => Promise.resolve(small.isKnown(TENANT, 'M-NEW')));
    const t20k = await timed(200, () => Promise.resolve(large.isKnown(TENANT, 'M-NEW')));

    expect(t20k).toBeLessThan(Math.max(t200, 0.5) * 10);
  });

  it('keeps the whole sale-intake read path constant, not just one call in it', async () => {
    // The property that actually matters at the lane: everything the POS route asks the store
    // before it can bank a sale. One constant-time lookup next to a scan is still a scan.
    const ask = async (a: ReturnType<typeof posAdapter>) => {
      await a.currentPackVersion(TENANT);
      await a.isBanked(TENANT, 'S-NEW');
      await a.saleHoldingReceipt(TENANT, 'R-NEW');
    };
    const small = posAdapter({ store: await shopWithHistory(200), now: () => NOW });
    const large = posAdapter({ store: await shopWithHistory(20_000), now: () => NOW });

    const t200 = await timed(100, () => ask(small));
    const t20k = await timed(100, () => ask(large));

    expect(t20k).toBeLessThan(Math.max(t200, 0.5) * 10);
  });
});
