import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { laneDurable, laneDurableReturn } from '../../apps/pos/src/browser-entry';
import { createTillSession, RefundUncertainError, type DurableReturnWrite } from '../../apps/pos/src/till-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { money } from '../../packages/contracts/src/money';
import type { CommitOutcome } from '../../edge/store-edge/src/durability';

/**
 * **RR-F02 — a lost reply is not a definite failure.**
 *
 * The edge durably recorded and queued a refund, its reply was lost, and `laneDurableReturn` returned
 * committed:false — a definite failure that invites a second refund for money that already went back.
 * Now a lost reply on the refund route is retried under the SAME id (the edge is idempotent for
 * returns, RR-F03), so it resolves without a double effect; only a store that cannot be reached at all
 * yields an explicit UNCONFIRMED outcome, never a definite failure. The sale route, not yet
 * idempotent, still refuses a lost reply.
 */

const KEY = ['refund', 'lost', 'reply', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
let realFetch: typeof globalThis.fetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const startLane = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rrf02-')); dirs.push(dir);
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};
const refundRecord = (id: string) => JSON.stringify({
  id, returnId: id, originalSaleId: 'S-1', number: `RET-${id}`, processedBy: 'u-meena',
  reasonCode: 'damaged', refundMinor: 5_000, currency: 'INR', refundTender: 'cash',
  processedAt: '2026-09-11T10:00:00Z', lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
});

describe('RR-F02 — the refund lane write resolves a lost reply safely', () => {
  it('the edge recorded but the reply was lost: the retry resolves it to committed, once', async () => {
    const edge = await startLane();
    let calls = 0;
    // Drop the FIRST reply AFTER the edge has processed it, so the refund is recorded but the caller
    // never hears; later attempts get through.
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls += 1;
      const response = await realFetch(url, init); // the edge records it on the first call
      if (calls === 1) throw new Error('connection reset after the write');
      return response;
    }) as unknown as typeof globalThis.fetch;

    const outcome = await laneDurableReturn(edge.lane!.port)('RET-1', refundRecord('RET-1'));
    expect(outcome.committed).toBe(true);            // resolved, not a false failure
    expect(outcome.unconfirmed).toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(2);         // it retried
    // Recorded exactly once despite two deliveries — the edge's idempotency (RR-F03) held.
    expect(await readLog(edge.returnsLog.path)).toHaveLength(1);
  });

  it('the store cannot be reached at all: the outcome is UNCONFIRMED, not a definite failure', async () => {
    globalThis.fetch = (async () => { throw new Error('ENETUNREACH'); }) as unknown as typeof globalThis.fetch;
    const outcome = await laneDurableReturn(9)('RET-2', refundRecord('RET-2')); // nothing on port 9
    expect(outcome.committed).toBe(false);
    expect(outcome.unconfirmed).toBe(true);
    expect(outcome.laneMessage).toMatch(/do not run it again|do not hand back cash/i);
  });

  it('a successful first attempt returns immediately, with no retry', async () => {
    const edge = await startLane();
    let calls = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => { calls += 1; return realFetch(url, init); }) as unknown as typeof globalThis.fetch;
    const outcome = await laneDurableReturn(edge.lane!.port)('RET-3', refundRecord('RET-3'));
    expect(outcome.committed).toBe(true);
    expect(calls).toBe(1);
  });

  it('a SALE lost reply is still a definite refusal (sale route is not idempotent yet)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('reply lost'); }) as unknown as typeof globalThis.fetch;
    const outcome = await laneDurable(9)('S-9', JSON.stringify({ id: 'S-9', total: 1 }));
    expect(outcome.committed).toBe(false);
    expect(outcome.unconfirmed).toBeUndefined();     // NOT unconfirmed — a refusal
    expect(calls).toBe(1);                            // no unsafe retry on the non-idempotent route
  });
});

describe('RR-F02 — the till surfaces uncertainty distinctly', () => {
  it('throws RefundUncertainError (not a plain refusal) on an unconfirmed outcome', async () => {
    const till = createTillSession(
      { tillId: 'till-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-09-11', varianceToleranceMinor: 10_000 },
      new Ledger(new InMemoryLedgerStore()), new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      (async () => ({ committed: false, unconfirmed: true, refusedBecause: 'could_not_write_durably', detail: 'no answer', laneMessage: 'Could not confirm.' } as CommitOutcome)) as DurableReturnWrite,
    );
    await expect(till.refund({
      id: 'R-till', number: 'RET-till', originalSaleId: 'S-1', processedAt: '2026-09-11T10:00:00Z', reasonCode: 'damaged',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' }],
      refund: money(5_000, 'INR'), refundTender: 'cash', maxRefund: money(5_000, 'INR'), approvalThresholdMinor: 100_000,
    })).rejects.toBeInstanceOf(RefundUncertainError);
  });
});
