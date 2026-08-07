import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { makeEvent } from '../../packages/contracts/src/event';
import { money } from '../../packages/contracts/src/money';
import { requestApproval, decide } from '../../packages/approvals/src/approvals';
import { reconcileCount, onHandMinor } from '../../packages/counts/src/counts';
import { ApprovalRequiredError } from '../../packages/adjustment/src/adjustment';
import {
  projectStock,
  physicalStock,
  quantityInState,
  explainAvailability,
  type StockMovement,
} from '../../packages/stock/src/position';
import { applyMovement, suggestPutAway, type Bin } from '../../packages/warehouse/src/movements';
import {
  dispatchTransfer,
  receiveTransfer,
  TransferRefusedError,
  type Transfer,
} from '../../packages/warehouse/src/transfers';
import {
  assessColdChain,
  releaseFromQualityHold,
  raiseColdChainIncident,
  type ColdChainRule,
  type QualityHold,
} from '../../packages/quality/src/cold-chain';
import { RecallRegistry, RecalledBatchError } from '../../packages/traceability/src/recall';
import { traceBatch } from '../../packages/traceability/src/traceability';
import { CatalogueCache } from '../../packages/catalogue/src/catalogue';
import { buildCatalogueSnapshot } from '../../packages/catalogue/src/snapshot-builder';

/**
 * STAGE 8 — inventory, warehouse, quality.
 *
 * Gate (roadmap §21): **physical-to-system and recall proof.**
 *
 * Two claims are on trial here, and they are the two a hypermarket owner actually
 * cares about:
 *
 *   1. **PHYSICAL TO SYSTEM.** Every unit that entered the building can be pointed
 *      at — on this shelf, on that van, sold to a customer, missing and owned by a
 *      name. Not "roughly balances": the same integer, on both sides, after a real
 *      blind count and a real approved correction.
 *
 *   2. **RECALL.** When a batch has to come back, the shop can (a) stop selling it
 *      instantly and everywhere, including with the internet off, (b) say exactly
 *      how much went out and to whom, and (c) close the recall only with evidence
 *      that is then kept for ever.
 *
 * Everything below runs the REAL engines against a REAL PostgreSQL. Set DATABASE_URL
 * to run; without it the suite skips rather than passing quietly, because a skipped
 * test that reports green is how a broken guarantee ships.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '33333333-3333-3333-3333-333333333333';
const CURRENCY = 'INR' as const;
const STORE = 'store-1';
const BRANCH = 'branch-2';

/** Run-scoped so the suite is repeatable against a database that refuses DELETE. */
const RUN = `r${Date.now().toString(36)}`;
const CHICKEN = 'p-chicken';
const GOOD_BATCH = `B-4471-${RUN}`;
const BAD_BATCH = `B-4472-${RUN}`;
/** ₹180.00 a unit — the number every valuation below is derived from. */
const UNIT_COST = money(18_000, CURRENCY);

/** A stock event as the ledger carries it: signed delta, product, batch. */
function stockEvent(input: {
  readonly id: string;
  readonly type: string;
  readonly at: string;
  readonly deltaMinor: number;
  readonly batchId: string;
  readonly source: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}) {
  return makeEvent({
    id: `${input.id}`,
    type: input.type,
    occurredAt: input.at,
    idempotencyKey: `${RUN}:${input.id}`,
    source: input.source,
    payload: {
      productId: CHICKEN,
      batchId: input.batchId,
      deltaMinor: input.deltaMinor,
      uom: 'kg',
      ...input.extra,
    },
  });
}

describe.skipIf(!DATABASE_URL)('Stage 8 — physical-to-system and recall (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;
  /** The store's stock ledger: append-only, and the only source of the system figure. */
  let ledger: Ledger;
  let outbox: SyncOutbox;
  /** Where each unit physically stands — projected, never stored. */
  const movements: StockMovement[] = [];

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
    await runMigrations(sql, files);
    store = new SqlEventStore(sql);
    ledger = new Ledger(new InMemoryLedgerStore());
    outbox = new SyncOutbox();
  });

  afterAll(async () => {
    await client.end();
  });

  /** Append to the store ledger AND to the durable cloud log, as the edge really does. */
  async function record(event: ReturnType<typeof stockEvent>, stream: string): Promise<void> {
    ledger.append(event);
    outbox.enqueue(event);
    await store.append(TENANT, stream, event);
  }

  // --- ACT ONE: physical to system -----------------------------------------------

  it('receives 240kg with a clean cold chain, and releases it by a named person', async () => {
    const rule: ColdChainRule = {
      productId: CHICKEN,
      minTenthsC: -20,
      maxTenthsC: 40, // 4.0°C — fresh chicken
      graceMinutes: 30,
    };
    const assessment = assessColdChain({
      batchId: GOOD_BATCH,
      productId: CHICKEN,
      rule,
      readings: [
        { readingId: 'tr-1', batchId: GOOD_BATCH, productId: CHICKEN, tenthsC: 22, at: '2026-08-04T05:00:00Z', source: 'vehicle probe', recordedBy: 'u-goods-in' },
        { readingId: 'tr-2', batchId: GOOD_BATCH, productId: CHICKEN, tenthsC: 31, at: '2026-08-04T05:20:00Z', source: 'dock probe', recordedBy: 'u-goods-in' },
        { readingId: 'tr-3', batchId: GOOD_BATCH, productId: CHICKEN, tenthsC: 26, at: '2026-08-04T05:40:00Z', source: 'chiller probe', recordedBy: 'u-goods-in' },
      ],
    });
    expect(assessment.severity).toBe('within_range');
    expect(assessment.quarantine).toBe(false);
    // The readings are kept, not just the verdict — that is what an inspector asks for.
    expect(assessment.evidence).toHaveLength(3);

    const hold: QualityHold = {
      batchId: GOOD_BATCH,
      productId: CHICKEN,
      status: 'pending',
      reason: 'awaiting goods-in check',
      heldAt: '2026-08-04T05:45:00Z',
      heldBy: 'u-goods-in',
    };
    const release = releaseFromQualityHold({
      hold,
      samples: [
        { sampleId: 's-1', batchId: GOOD_BATCH, takenBy: 'u-qc', takenAt: '2026-08-04T05:50:00Z', test: 'visual and temperature', result: 'pass' },
      ],
      coldChain: assessment,
      expiresOn: '2026-08-09',
      releasedBy: 'u-qc',
      at: '2026-08-04T06:00:00Z',
    });
    expect(release.released).toBe(true);
    expect(release.hold.releasedBy).toBe('u-qc');

    await record(
      stockEvent({
        id: `grn-${RUN}-1`,
        type: 'GoodsReceived',
        at: '2026-08-04T06:00:00Z',
        deltaMinor: 240,
        batchId: GOOD_BATCH,
        source: STORE,
        extra: { grnId: `GRN-${RUN}-1`, locationId: STORE, unitCostMinor: UNIT_COST.minor },
      }),
      `stock/${CHICKEN}`,
    );
    movements.push({
      movementId: `grn-${RUN}-1`,
      productId: CHICKEN,
      locationId: STORE,
      batchId: GOOD_BATCH,
      from: null,
      to: 'on_hand',
      quantityMinor: 240,
      uom: 'kg',
      at: '2026-08-04T06:00:00Z',
      reason: 'goods received',
    });

    expect(onHandMinor(ledger, CHICKEN)).toBe(240);
  });

  it('puts it away by scan — once, into a real bin, and never into a pickable bin when held', () => {
    const bins: Bin[] = [
      { binId: 'CH-01', storeId: STORE, capacityMinor: 300, pickable: true, zone: 'chilled' },
      { binId: 'CH-02', storeId: STORE, capacityMinor: 300, pickable: true, zone: 'chilled' },
      { binId: 'QU-01', storeId: STORE, capacityMinor: 200, pickable: false, zone: 'quarantine' },
    ];
    const contents = {};

    const suggestion = suggestPutAway({
      productId: CHICKEN,
      batchId: GOOD_BATCH,
      quantityMinor: 240,
      bins,
      contents,
    });
    expect(suggestion).toMatchObject({ binId: 'CH-01' });

    const command = {
      commandId: `mv-${RUN}-1`,
      kind: 'put_away' as const,
      storeId: STORE,
      productId: CHICKEN,
      batchId: GOOD_BATCH,
      quantityMinor: 240,
      uom: 'kg',
      fromBinId: null,
      toBinId: 'CH-01',
      movedBy: 'u-warehouse',
      at: '2026-08-04T06:10:00Z',
      stockState: 'on_hand' as const,
    };
    const first = applyMovement({ command, appliedCommandIds: [], bins, contents });
    expect(first.outcome).toBe('moved');
    expect(first.movements).toHaveLength(1);

    // The handheld is in a dead spot at the back of the racking and the operator
    // scans again. One scan, one movement.
    const second = applyMovement({
      command,
      appliedCommandIds: [command.commandId],
      bins,
      contents,
    });
    expect(second.outcome).toBe('duplicate_ignored');
    expect(second.accepted).toBe(false);
    expect(second.movements).toEqual([]);

    // A typo'd bin is queued for a human, never invented.
    const typo = applyMovement({
      command: { ...command, commandId: `mv-${RUN}-typo`, toBinId: 'CH-99' },
      appliedCommandIds: [],
      bins,
      contents,
    });
    expect(typo.outcome).toBe('unknown_bin');
    expect(typo.resolutionRequired).toBe(true);
    expect(typo.movements).toEqual([]);

    // And quarantined stock cannot be put where someone picks from — the commonest
    // route by which bad stock reaches a customer.
    const badPutAway = applyMovement({
      command: { ...command, commandId: `mv-${RUN}-q`, stockState: 'quarantine' },
      appliedCommandIds: [],
      bins,
      contents,
    });
    expect(badPutAway.outcome).toBe('not_pickable_state');
    expect(badPutAway.movements).toEqual([]);
    // The same stock IS accepted into the quarantine bin.
    const heldAway = applyMovement({
      command: { ...command, commandId: `mv-${RUN}-q2`, quantityMinor: 20, toBinId: 'QU-01', stockState: 'quarantine' },
      appliedCommandIds: [],
      bins,
      contents,
    });
    expect(heldAway.outcome).toBe('moved');
  });

  it('sends 60kg to the branch: 55 arrive, 5 do not, and the 5 get an owner', async () => {
    const transfer: Transfer = {
      transferId: `TR-${RUN}-1`,
      fromLocationId: STORE,
      toLocationId: BRANCH,
      lines: [{ productId: CHICKEN, batchId: GOOD_BATCH, quantityMinor: 60, uom: 'kg', unitCost: UNIT_COST }],
      state: 'proposed',
      requestedBy: 'u-warehouse',
    };
    const available = [
      { productId: CHICKEN, batchId: GOOD_BATCH, quantityMinor: 240, state: 'on_hand' as const },
    ];

    // Nobody moves stock between branches on their own signature (§28).
    expect(() => dispatchTransfer({ transfer, available, at: '2026-08-04T07:00:00Z' })).toThrow(
      TransferRefusedError,
    );
    expect(() =>
      dispatchTransfer({
        transfer,
        approval: { subjectRef: transfer.transferId, status: 'approved', decidedBy: 'u-warehouse' },
        available,
        at: '2026-08-04T07:00:00Z',
      }),
    ).toThrow(/other than the person who requested it/);

    const dispatched = dispatchTransfer({
      transfer,
      approval: { subjectRef: transfer.transferId, status: 'approved', decidedBy: 'u-ops-manager' },
      available,
      at: '2026-08-04T07:00:00Z',
    });
    expect(dispatched.transfer.state).toBe('in_transit');
    // Out of the store, into IN-TRANSIT AT THE BRANCH — the van is a place.
    expect(dispatched.movements.map((m) => [m.locationId, m.from, m.to])).toEqual([
      [STORE, 'on_hand', null],
      [BRANCH, null, 'in_transit'],
    ]);
    movements.push(...dispatched.movements);

    await record(
      stockEvent({
        id: `tr-${RUN}-1-out`,
        type: 'StockTransferred',
        at: '2026-08-04T07:00:00Z',
        deltaMinor: -60,
        batchId: GOOD_BATCH,
        source: STORE,
        extra: { transferId: transfer.transferId, locationId: STORE, toLocationId: BRANCH },
      }),
      `stock/${CHICKEN}`,
    );

    const received = receiveTransfer({
      transfer: dispatched.transfer,
      counted: [{ productId: CHICKEN, batchId: GOOD_BATCH, quantityMinor: 55 }],
      receivedBy: 'u-branch-manager',
      at: '2026-08-04T11:00:00Z',
      currency: CURRENCY,
    });
    expect(received.transfer.state).toBe('received');
    expect(received.discrepancies).toHaveLength(1);
    // 5kg × ₹180.00 = ₹900.00, priced and named, not absorbed.
    expect(received.discrepancies[0]?.differenceMinor).toBe(-5);
    expect(received.discrepancies[0]?.value).toEqual(money(90_000, CURRENCY));
    expect(received.discrepancies[0]?.detail).toContain('needs an owner');
    // Nothing is left sitting in a van for ever: the shortfall is written out of transit.
    expect(received.movements.map((m) => m.movementId.split('-').slice(-2).join('-'))).toEqual([
      'recv-1',
      'shortfall-1',
    ]);
    movements.push(...received.movements);
  });

  it('sells 120kg at the lane, then a BLIND count finds 3kg missing', async () => {
    for (let i = 1; i <= 4; i += 1) {
      await record(
        stockEvent({
          id: `sale-${RUN}-${i}`,
          type: 'StockIssued',
          at: `2026-08-04T1${i}:00:00Z`,
          deltaMinor: -30,
          batchId: GOOD_BATCH,
          source: STORE,
          extra: { saleId: `S-${RUN}-${i}`, locationId: STORE },
        }),
        `stock/${CHICKEN}`,
      );
      movements.push({
        movementId: `sale-${RUN}-${i}`,
        productId: CHICKEN,
        locationId: STORE,
        batchId: GOOD_BATCH,
        from: 'on_hand',
        to: null,
        quantityMinor: 30,
        uom: 'kg',
        at: `2026-08-04T1${i}:00:00Z`,
        reason: 'sold',
      });
    }

    // 240 in, 60 to the branch, 120 sold. The system says 60.
    expect(onHandMinor(ledger, CHICKEN)).toBe(60);

    // The counter never sees that number — `reconcileCount` derives it from the
    // ledger, so blind-count integrity is structural rather than a UI promise.
    const countInput = {
      id: `CNT-${RUN}-1`,
      productId: CHICKEN,
      locationId: STORE,
      uom: 'kg',
      countedMinor: 57,
      counterId: 'u-counter',
      at: '2026-08-04T18:00:00Z',
      reasonCode: 'cycle_count_variance',
      valuePerUnit: UNIT_COST,
      thresholdMinor: 20_000, // ₹200.00 — per-tenant
    };

    // ₹540.00 of shrinkage is material, and the counter cannot wave their own
    // variance through (§28).
    expect(() => reconcileCount(countInput, ledger, outbox)).toThrow(ApprovalRequiredError);

    const request = requestApproval({
      id: countInput.id,
      subjectType: 'stock_adjustment',
      subjectRef: countInput.id,
      requestedBy: 'u-counter',
      branchId: STORE,
      value: money(54_000, CURRENCY),
    });
    const selfApproval = decide(
      request,
      { userId: 'u-counter', branchScope: [STORE], authorityLimit: null },
      'approved',
      'it was only a few kilos',
      '2026-08-04T18:05:00Z',
    );
    expect(selfApproval).toEqual({ ok: false, refusal: 'self_approval_forbidden' });

    const outcome = decide(
      request,
      { userId: 'u-store-manager', branchScope: [STORE], authorityLimit: money(100_000, CURRENCY) },
      'approved',
      'recount confirmed 57kg; trim loss under investigation',
      '2026-08-04T18:05:00Z',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');

    const reconciliation = reconcileCount({ ...countInput, approval: outcome.request }, ledger, outbox);
    expect(reconciliation.expectedMinor).toBe(60);
    expect(reconciliation.countedMinor).toBe(57);
    expect(reconciliation.varianceMinor).toBe(-3);
    expect(reconciliation.varianceValue).toEqual(money(54_000, CURRENCY));
    expect(reconciliation.reconciled).toBe(false);
    expect(reconciliation.adjusted).toBe(true);
    expect(reconciliation.requiredApproval).toBe(true);

    movements.push({
      movementId: `${countInput.id}:adj`,
      productId: CHICKEN,
      locationId: STORE,
      batchId: GOOD_BATCH,
      from: 'on_hand',
      to: null,
      quantityMinor: 3,
      uom: 'kg',
      at: countInput.at,
      reason: 'cycle_count_variance',
    });

    // THE GATE, HALF ONE: after the approved correction, the system figure IS the
    // counted figure. Not close — equal.
    expect(onHandMinor(ledger, CHICKEN)).toBe(57);
  });

  it('accounts for every one of the 240kg — the physical-to-system proof', () => {
    const projection = projectStock(movements);
    expect(projection.exceptions).toEqual([]);

    const onShelf = physicalStock(projection, CHICKEN, STORE);
    const atBranch = physicalStock(projection, CHICKEN, BRANCH);
    const stillOnTheVan = quantityInState(projection, 'in_transit', CHICKEN);

    expect(onShelf).toBe(57); // and the count agrees, above
    expect(atBranch).toBe(55);
    expect(stillOnTheVan).toBe(0); // dispatched 60, received 55, shortfall 5 written out

    const sold = 120;
    const missing = 5; // never arrived at the branch — a valued, owned exception
    const shrinkage = 3; // found by the count, approved, and corrected

    // 240 = 57 + 55 + 120 + 5 + 3. Every kilo is somewhere, or someone's problem.
    expect(onShelf + atBranch + stillOnTheVan + sold + missing + shrinkage).toBe(240);

    // And the ledger — the independent, append-only side of the same story — agrees
    // with what the shelf projection says is on the shelf.
    expect(onHandMinor(ledger, CHICKEN)).toBe(onShelf);
  });

  it('survives the round trip through PostgreSQL: re-projected from the database, the same answer', async () => {
    const persisted = await store.readStream(TENANT, `stock/${CHICKEN}`);
    const mine = persisted.filter((p) => p.event.idempotencyKey.startsWith(`${RUN}:`));
    // 1 receipt + 1 transfer out + 4 sales. (The adjustment lives in the store ledger
    // and its outbox, and syncs on the next drain — it is deliberately not counted here.)
    expect(mine).toHaveLength(6);

    const fromDatabase = mine
      .filter((p) => (p.event.payload as { batchId?: string }).batchId === GOOD_BATCH)
      .reduce((sum, p) => sum + ((p.event.payload as { deltaMinor?: number }).deltaMinor ?? 0), 0);
    expect(fromDatabase).toBe(60); // before the count adjustment, which has not synced yet
    expect(outbox.unsentCount()).toBeGreaterThan(0); // and its absence is VISIBLE (P-08)
  });

  // --- ACT TWO: the recall ---------------------------------------------------------

  it('quarantines a second batch automatically when a cold-chain reading is MISSING', async () => {
    await record(
      stockEvent({
        id: `grn-${RUN}-2`,
        type: 'GoodsReceived',
        at: '2026-08-05T05:00:00Z',
        deltaMinor: 48,
        batchId: BAD_BATCH,
        source: STORE,
        extra: { grnId: `GRN-${RUN}-2`, locationId: STORE, unitCostMinor: UNIT_COST.minor },
      }),
      `stock/${CHICKEN}`,
    );

    const rule: ColdChainRule = { productId: CHICKEN, minTenthsC: -20, maxTenthsC: 40, graceMinutes: 30 };

    // Nobody took a reading. That is not "probably fine".
    const unmeasured = assessColdChain({ batchId: BAD_BATCH, productId: CHICKEN, rule, readings: [] });
    expect(unmeasured.severity).toBe('breach');
    expect(unmeasured.quarantine).toBe(true);
    expect(unmeasured.detail).toContain('unmeasured cold chain is an unproven one');

    // And when readings do exist, duration decides, not just the peak.
    const breached = assessColdChain({
      batchId: BAD_BATCH,
      productId: CHICKEN,
      rule,
      readings: [
        { readingId: 'br-1', batchId: BAD_BATCH, productId: CHICKEN, tenthsC: 92, at: '2026-08-05T06:00:00Z', source: 'chiller probe', recordedBy: 'u-nights' },
        { readingId: 'br-2', batchId: BAD_BATCH, productId: CHICKEN, tenthsC: 104, at: '2026-08-05T08:00:00Z', source: 'chiller probe', recordedBy: 'u-nights' },
        { readingId: 'br-3', batchId: BAD_BATCH, productId: CHICKEN, tenthsC: 31, at: '2026-08-05T09:00:00Z', source: 'chiller probe', recordedBy: 'u-nights' },
      ],
    });
    expect(breached.severity).toBe('breach');
    expect(breached.peakTenthsC).toBe(104); // 10.4°C
    expect(breached.minutesOutOfRange).toBe(180);
    expect(breached.quarantine).toBe(true);

    // The breach becomes an incident linked to the control it defeated, with its
    // evidence attached — not a conversation by the chiller (M34-FR-04).
    const incident = raiseColdChainIncident(breached, '2026-08-05T09:05:00Z');
    expect(incident?.controlId).toBe('c-cold-chain');
    expect(incident?.evidence).toHaveLength(2);

    // A held batch cannot be talked out of the hold.
    const refusal = releaseFromQualityHold({
      hold: {
        batchId: BAD_BATCH,
        productId: CHICKEN,
        status: 'held',
        reason: 'cold-chain breach',
        heldAt: '2026-08-05T09:05:00Z',
        heldBy: 'u-qc',
      },
      samples: [],
      coldChain: breached,
      releasedBy: 'u-qc',
      at: '2026-08-05T09:30:00Z',
    });
    expect(refusal.released).toBe(false);
    expect(refusal.outcome).toBe('cold_chain_breach');
  });

  it('blocks a recalled batch at the lane, on a transfer and in a put-away — with the internet OUT', async () => {
    // 12kg went out to customers before anyone knew.
    for (let i = 1; i <= 3; i += 1) {
      await record(
        stockEvent({
          id: `sale-bad-${RUN}-${i}`,
          type: 'StockIssued',
          at: `2026-08-05T1${i}:00:00Z`,
          deltaMinor: -4,
          batchId: BAD_BATCH,
          source: STORE,
          extra: {
            saleId: `S-BAD-${RUN}-${i}`,
            locationId: STORE,
            ...(i === 2 ? { customerId: 'c-loyalty-8891' } : {}),
          },
        }),
        `stock/${CHICKEN}`,
      );
    }

    const recalls = new RecallRegistry();
    recalls.initiate({
      batchId: BAD_BATCH,
      reason: 'cold-chain breach on 5 August — 10.4°C for 3 hours',
      initiatedBy: 'u-qc',
      at: '2026-08-05T14:00:00Z',
    });
    // Initiating twice is one recall, not two.
    recalls.initiate({ batchId: BAD_BATCH, reason: 'duplicate raise', initiatedBy: 'u-ops', at: '2026-08-05T14:01:00Z' });
    expect(recalls.openRecalls()).toHaveLength(1);

    // (a) The lane. The recall set is cached, so the block holds with the cable out.
    expect(() => recalls.assertSellable(BAD_BATCH)).toThrow(RecalledBatchError);
    expect(recalls.isRecalled(GOOD_BATCH)).toBe(false);

    // The same block at the product level, through the real offline catalogue the
    // lane actually scans against — no network is consulted anywhere in this path.
    const snapshot = buildCatalogueSnapshot({
      scope: { tenantId: TENANT, storeId: STORE },
      version: 2,
      asOf: '2026-08-05T14:05:00Z',
      products: [
        { productId: CHICKEN, sku: 'CHK1', name: 'Fresh chicken 1kg', baseUom: 'kg', taxClassId: 'GST0', status: 'active', recallBlock: true },
      ],
      barcodes: [{ code: '8901000000032', productId: CHICKEN, kind: 'standard' }],
      priceEntries: [
        { id: 'pr-c', productId: CHICKEN, scope: 'store', scopeRef: STORE, price: money(24_000, CURRENCY), effectiveFrom: '2026-01-01T00:00:00Z', status: 'active', version: 1 },
      ],
      taxClasses: { GST0: 0 },
    });
    expect(() => new CatalogueCache(snapshot.snapshot).scan('8901000000032')).toThrow(
      /under recall and cannot be sold/,
    );

    // (b) The transfer. Sending it to another branch would launder the problem.
    expect(() =>
      dispatchTransfer({
        transfer: {
          transferId: `TR-${RUN}-2`,
          fromLocationId: STORE,
          toLocationId: BRANCH,
          lines: [{ productId: CHICKEN, batchId: BAD_BATCH, quantityMinor: 10, uom: 'kg', unitCost: UNIT_COST }],
          state: 'proposed',
          requestedBy: 'u-warehouse',
        },
        approval: { subjectRef: `TR-${RUN}-2`, status: 'approved', decidedBy: 'u-ops-manager' },
        available: [
          { productId: CHICKEN, batchId: BAD_BATCH, quantityMinor: 36, state: 'on_hand', recalled: true },
        ],
        at: '2026-08-05T14:10:00Z',
      }),
    ).toThrow(/recalled — sending it to another branch moves the problem/);

    // (c) The put-away. Quarantined stock never reaches a bin someone picks from.
    const bins: Bin[] = [
      { binId: 'CH-01', storeId: STORE, capacityMinor: 300, pickable: true, zone: 'chilled' },
      { binId: 'QU-01', storeId: STORE, capacityMinor: 200, pickable: false, zone: 'quarantine' },
    ];
    expect(
      applyMovement({
        command: {
          commandId: `mv-${RUN}-recall`,
          kind: 'put_away',
          storeId: STORE,
          productId: CHICKEN,
          batchId: BAD_BATCH,
          quantityMinor: 36,
          uom: 'kg',
          fromBinId: null,
          toBinId: 'CH-01',
          movedBy: 'u-warehouse',
          at: '2026-08-05T14:15:00Z',
          stockState: 'quarantine',
        },
        appliedCommandIds: [],
        bins,
        contents: {},
      }).outcome,
    ).toBe('not_pickable_state');
  });

  it('traces the recalled batch: how much went out, to whom, and how much to pull off the shelf', () => {
    const trace = traceBatch(ledger, BAD_BATCH);

    expect(trace.receivedQty).toBe(48);
    expect(trace.issuedQty).toBe(12); // 3 sales × 4kg
    expect(trace.inbound[0]?.ref).toBe(`GRN-${RUN}-2`);
    expect(trace.outbound.map((o) => o.ref)).toEqual([
      `S-BAD-${RUN}-1`,
      `S-BAD-${RUN}-2`,
      `S-BAD-${RUN}-3`,
    ]);

    // One customer is identifiable and can be contacted; two were walk-ins and
    // cannot. The system says which is which instead of implying it reached everyone.
    expect(trace.outbound.map((o) => o.customerRef)).toEqual([null, 'c-loyalty-8891', null]);

    // 36kg is still in the building and must come off the shelf.
    expect(trace.receivedQty - trace.issuedQty).toBe(36);

    // And the shop can say plainly why none of it is sellable.
    const held = projectStock([
      { movementId: `q-${RUN}`, productId: CHICKEN, locationId: STORE, batchId: BAD_BATCH, from: null, to: 'quarantine', quantityMinor: 36, uom: 'kg', at: '2026-08-05T14:20:00Z' },
    ]);
    expect(explainAvailability(held, CHICKEN, STORE)).toBe('0 available — 36 quarantine not sellable');
  });

  it('closes the recall only with evidence, and keeps the record and the events for ever', async () => {
    const recalls = new RecallRegistry();
    recalls.initiate({ batchId: BAD_BATCH, reason: 'cold-chain breach', initiatedBy: 'u-qc', at: '2026-08-05T14:00:00Z' });

    expect(() =>
      recalls.close({ batchId: BAD_BATCH, closedBy: 'u-qc', evidenceRef: '   ', at: '2026-08-06T09:00:00Z' }),
    ).toThrow(/can only be closed with evidence/);

    const closed = recalls.close({
      batchId: BAD_BATCH,
      closedBy: 'u-store-manager',
      evidenceRef: `disposal-note-${RUN}.pdf`,
      at: '2026-08-06T09:00:00Z',
    });
    expect(closed.status).toBe('closed');
    expect(recalls.isRecalled(BAD_BATCH)).toBe(false);
    // Closed, but not gone — the evidence is retained (hard rule #6).
    expect(recalls.find(BAD_BATCH)?.evidenceRef).toBe(`disposal-note-${RUN}.pdf`);
    expect(recalls.find(BAD_BATCH)?.initiatedBy).toBe('u-qc');

    // And the underlying evidence cannot be quietly tidied away either: the DATABASE
    // itself refuses, not just the code above it (migration 0004). Run one at a time —
    // a client with two queries in flight is a different test than the one intended.
    const refusalFor = async (sql: string): Promise<string> => {
      try {
        await client.query(sql, [TENANT]);
        return 'THE DATABASE ALLOWED IT';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(
      await refusalFor(`DELETE FROM event_ledger WHERE tenant_id = $1`),
    ).toMatch(/append-only/i);
    expect(
      await refusalFor(`UPDATE event_ledger SET stream = 'tidied' WHERE tenant_id = $1`),
    ).toMatch(/append-only/i);

    // Everything is still there after the attempt.
    const persisted = await store.readStream(TENANT, `stock/${CHICKEN}`);
    expect(persisted.filter((p) => p.event.idempotencyKey.startsWith(`${RUN}:`))).toHaveLength(10);
  });
});
