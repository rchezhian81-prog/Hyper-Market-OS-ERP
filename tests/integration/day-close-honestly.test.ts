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
import { PosSession, taxRateFromPercent } from '../../apps/pos/src/session';
import {
  suspendBill,
  resumeBill,
  staleBills,
  SerialisedSuspendedBillStore,
} from '../../packages/suspended-sales/src/suspended-bill';
import {
  recoverPendingTender,
  pendingExposure,
  dayCloseCheck,
} from '../../packages/tender/src/pending-recovery';
import {
  requestReversal,
  resolveFromSettlement,
  refundExceptions,
  refundDayTotals,
  type ProviderOutcome,
  type Reversal,
} from '../../packages/reversal/src/reversal';
import {
  importSettlementBatch,
  reviewSettlement,
  openInvestigation,
  resolveInvestigation,
} from '../../packages/settlement/src/settlement';
import { openCase, addEvidence, closeCase, verifyEvidence } from '../../packages/loss-prevention/src/cases';
import { detectCodAnomalies } from '../../packages/loss-prevention/src/fraud-signals';

/**
 * STAGE 9 — POS, returns and cash office.
 *
 * Gate (roadmap §21): **end-of-day and refund controls prove out.**
 *
 * One trading day, walked from the first parked basket to the moment the manager is
 * allowed to close — against a REAL PostgreSQL. The claim under test is narrow and
 * unforgiving: **the day closes on what actually happened, not on what would be
 * convenient.** Money in an unknown state stays unknown and is stated as a number.
 * Money the shop owes a customer stops the close. Money the shop is owed is separated
 * into what it can chase and what it has simply lost.
 *
 * Set DATABASE_URL to run. Without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '44444444-4444-4444-4444-444444444444';
const CURRENCY = 'INR' as const;
const STORE = 'store-1';
const RUN = `d${Date.now().toString(36)}`;

/** A card machine that answers, or does not. */
const answering = (outcome: ProviderOutcome) => ({ requestReversal: (): ProviderOutcome => outcome });

describe.skipIf(!DATABASE_URL)('Stage 9 — the day closes honestly (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;
  let outbox: SyncOutbox;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(
      sql,
      readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
    );
    store = new SqlEventStore(sql);
    outbox = new SyncOutbox();
  });

  afterAll(async () => {
    await client.end();
  });

  /** A basket rung up on the lane, committed locally with nothing awaiting the network. */
  function ringUp(id: string, lines: readonly { price: number; qty: number }[]) {
    const session = new PosSession(
      {
        laneId: 'lane-3',
        cashierId: 'u-cashier-7',
        tradingDay: '2026-08-04',
        currency: CURRENCY,
        defaultTaxRate: taxRateFromPercent(5),
      },
      new Ledger(new InMemoryLedgerStore()),
      outbox,
    );
    lines.forEach((line, i) => {
      session.scan({
        productId: `p-${i}`,
        description: `Item ${i}`,
        unitPrice: money(line.price, CURRENCY),
        quantityMinor: line.qty,
        uom: 'ea',
        taxRate: taxRateFromPercent(5),
      });
    });
    const payable = session.totals().payable;
    const committed = session.commit(id, `INV-${id}`, '2026-08-04T19:00:00Z', [
      { kind: 'cash', amount: payable, status: 'settled' },
    ]);
    return { committed, payable };
  }

  it('parks a basket, survives the lane crashing, and resumes it once and only once', () => {
    const bills = new SerialisedSuspendedBillStore();
    const parked = suspendBill(
      {
        billId: `B-${RUN}`,
        tenantId: TENANT,
        storeId: STORE,
        laneId: 'lane-3',
        cashierId: 'u-cashier-7',
        tradingDay: '2026-08-04',
        currency: CURRENCY,
        lines: [
          { lineId: 'l-1', productId: 'p-rice', description: 'Rice 5kg', unitPriceMinor: 45_000, quantityMinor: 1, uom: 'ea', taxBps: 500, voided: false },
        ],
        at: '2026-08-04T17:10:00Z',
      },
      bills,
    );
    expect(parked.suspended).toBe(true);

    // The till loses power. Only what was written to disk comes back.
    const afterCrash = SerialisedSuspendedBillStore.hydrate(bills.serialise());
    expect(afterCrash.get(`B-${RUN}`)?.lines).toHaveLength(1);

    const first = resumeBill(
      { billId: `B-${RUN}`, byUserId: 'u-cashier-7', onLaneId: 'lane-3', storeId: STORE, at: '2026-08-04T17:25:00Z' },
      afterCrash,
    );
    expect(first.resumed).toBe(true);

    // The customer wanders to another lane and asks there too.
    const second = resumeBill(
      { billId: `B-${RUN}`, byUserId: 'u-cashier-9', onLaneId: 'lane-3', storeId: STORE, at: '2026-08-04T17:26:00Z' },
      afterCrash,
    );
    expect(second.resumed).toBe(false);
    expect(second.detail).toContain('charge the customer twice');

    // And one basket parked at lunchtime is still on the lane at close. Everything
    // after the crash runs on the RECOVERED store — that is the lane that came back up,
    // and reporting from the pre-crash copy would be reporting from a till that no
    // longer exists.
    suspendBill(
      {
        billId: `B-${RUN}-stale`, tenantId: TENANT, storeId: STORE, laneId: 'lane-5',
        cashierId: 'u-cashier-2', tradingDay: '2026-08-04', currency: CURRENCY,
        lines: [{ lineId: 'l-1', productId: 'p-oil', description: 'Oil', unitPriceMinor: 18_000, quantityMinor: 3, uom: 'ea', taxBps: 500, voided: false }],
        at: '2026-08-04T12:00:00Z',
      },
      afterCrash,
    );
    // The resumed bill is no longer "still on a lane"; only the forgotten one is.
    const report = staleBills(afterCrash, '2026-08-04T21:00:00Z', { abandonAfterMinutes: 480 });
    expect(report).toHaveLength(1);
    expect(report[0]?.billId).toBe(`B-${RUN}-stale`);
    expect(report[0]?.valueMinor).toBe(54_000);
    expect(report[0]?.detail).toContain('nobody is coming back for it');
  });

  it('takes the day\'s sales locally and banks them in PostgreSQL', async () => {
    for (const id of [`S-${RUN}-1`, `S-${RUN}-2`, `S-${RUN}-3`]) {
      const { committed, payable } = ringUp(id, [{ price: 45_000, qty: 1 }, { price: 18_000, qty: 2 }]);
      expect(committed.id).toBe(id);
      expect(payable).toEqual(money(85_050, CURRENCY)); // ₹810.00 + 5% GST
      await store.append(TENANT, `sale/${id}`, makeEvent({
        id: `${id}:ev`,
        type: 'SaleCommitted',
        occurredAt: '2026-08-04T19:00:00Z',
        idempotencyKey: `${RUN}:${id}`,
        source: 'lane-3',
        payload: { saleId: id, totalMinor: payable.minor, tradingDay: '2026-08-04' },
      }));
    }
    const banked = await store.readStream(TENANT, `sale/S-${RUN}-1`);
    expect(banked).toHaveLength(1);
  });

  it('leaves a card machine that never answered in the UNCERTAIN state, and recovers it from evidence', () => {
    const unpaidIdentified = recoverPendingTender({
      tender: { tenderId: `T-${RUN}-a`, saleId: `S-${RUN}-a`, laneId: 'lane-3', kind: 'card', providerRef: 'tok_a', amountMinor: 84_000, currency: CURRENCY, capturedAt: '2026-08-04T19:42:00Z', customerRef: 'c-loyalty-42' },
      authorisations: [],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(unpaidIdentified.outcome).toBe('confirmed_not_paid');
    expect(unpaidIdentified.contactable).toBe(true);

    const unpaidAnonymous = recoverPendingTender({
      tender: { tenderId: `T-${RUN}-b`, saleId: `S-${RUN}-b`, laneId: 'lane-3', kind: 'card', providerRef: 'tok_b', amountMinor: 30_000, currency: CURRENCY, capturedAt: '2026-08-04T19:50:00Z' },
      authorisations: [],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(unpaidAnonymous.contactable).toBe(false);

    const stillUnknown = recoverPendingTender({
      tender: { tenderId: `T-${RUN}-c`, saleId: `S-${RUN}-c`, laneId: 'lane-3', kind: 'upi', providerRef: 'tok_c', amountMinor: 12_000, currency: CURRENCY, capturedAt: '2026-08-04T20:05:00Z' },
      authorisations: [],
      statementComplete: false,
      at: '2026-08-04T21:00:00Z',
    });
    expect(stillUnknown.outcome).toBe('still_unknown');
    expect(stillUnknown.detail).toContain('do not chase the customer');

    const exposure = pendingExposure([unpaidIdentified, unpaidAnonymous, stillUnknown]);
    // Three different problems, three different numbers. Not one "pending" total.
    expect(exposure.recoverableMinor).toBe(84_000);
    expect(exposure.unrecoverableMinor).toBe(30_000);
    expect(exposure.unknownMinor).toBe(12_000);
    expect(exposure.detail).toContain('treat this as a loss, not a debt');

    // Unknown money does not block the close; it is stated.
    expect(dayCloseCheck(exposure).canClose).toBe(true);
  });

  it('BLOCKS the close while the shop is holding a customer\'s money', () => {
    const doubleCharged = recoverPendingTender({
      tender: { tenderId: `T-${RUN}-d`, saleId: `S-${RUN}-d`, laneId: 'lane-3', kind: 'card', providerRef: 'tok_d', amountMinor: 84_000, currency: CURRENCY, capturedAt: '2026-08-04T19:42:00Z' },
      authorisations: [
        { ref: 'tok_d', amountMinor: 84_000, status: 'captured', at: '2026-08-04T19:42:03Z' },
        { ref: 'tok_d', amountMinor: 84_000, status: 'captured', at: '2026-08-04T19:42:31Z' },
      ],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(doubleCharged.outcome).toBe('paid_more_than_once');

    const check = dayCloseCheck(pendingExposure([doubleCharged]));
    expect(check.canClose).toBe(false);
    expect(check.detail).toContain('refund it before closing');
  });

  it('refunds a card sale without ever inventing a success', () => {
    const original = {
      tenderId: `T-${RUN}-r`, saleId: `S-${RUN}-1`, kind: 'card' as const,
      providerRef: 'tok_refund', amountMinor: 85_050, currency: CURRENCY, capturedAt: '2026-08-04T19:00:00Z',
    };

    // The gateway times out on the reversal too.
    const attempt = requestReversal(
      { reversalId: `R-${RUN}`, refundId: `RF-${RUN}`, original, amountMinor: 85_050, requestedBy: 'u-supervisor', at: '2026-08-04T20:15:00Z' },
      answering({ result: 'unknown', reason: 'gateway timeout' }),
    );
    expect(attempt.reversal?.status).toBe('uncertain');
    expect(attempt.tellTheCustomer).toContain('not refund you twice');

    // The cashier tries again. It does NOT create a second reversal.
    const retry = requestReversal(
      { reversalId: `R-${RUN}-2`, refundId: `RF-${RUN}`, original, amountMinor: 85_050, requestedBy: 'u-supervisor', at: '2026-08-04T20:16:00Z', existing: [attempt.reversal!] },
      answering({ result: 'succeeded', providerReversalRef: 'would-have-double-refunded' }),
    );
    expect(retry.accepted).toBe(false);
    expect(retry.outcome).toBe('already_requested');

    // Overnight, the statement arrives with the credit on it.
    const resolved = resolveFromSettlement({
      reversal: attempt.reversal!,
      credits: [{ settlementId: 'ST-1', ref: 'tok_refund', amountMinor: 85_050, settledAt: '2026-08-05T02:00:00Z' }],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(resolved.reversal.status).toBe('succeeded');
    expect(resolved.reversal.reconciled).toBe(true);
    expect(resolved.reversal.resolvedBy).toBe('provider_settlement');
  });

  it('states all three refund figures at close rather than guessing', () => {
    const mk = (id: string, status: Reversal['status'], amountMinor: number): Reversal => ({
      reversalId: id, refundId: id, originalTenderId: 'T-x', providerRef: `tok_${id}`,
      amountMinor, currency: CURRENCY, status, requestedBy: 'u-supervisor',
      requestedAt: '2026-08-04T20:00:00Z', reconciled: status === 'succeeded',
    });
    const reversals = [mk('a', 'succeeded', 85_050), mk('b', 'uncertain', 22_000), mk('c', 'failed', 15_000)];

    const totals = refundDayTotals(reversals);
    expect(totals.confirmedMinor).toBe(85_050);
    expect(totals.uncertainMinor).toBe(22_000);
    expect(totals.failedMinor).toBe(15_000);
    expect(totals.detail).toContain('the unknown figure is stated');

    const list = refundExceptions({ reversals, originals: [], at: '2026-08-08T10:00:00Z', owner: 'u-cash-office' });
    expect(list[0]?.kind).toBe('reversal_failed');
    expect(list[0]?.detail).toContain('the customer is owed this money');
    expect(list[1]?.kind).toBe('reversal_uncertain');
    expect(list.every((e) => e.owner === 'u-cash-office' && e.valueMinor > 0)).toBe(true);
  });

  it('takes the provider file only if it adds up, then tells late apart from lost', () => {
    const bad = importSettlementBatch({
      batchId: `BATCH-${RUN}`, providerId: 'prov-1', currency: CURRENCY, settlementDate: '2026-08-04',
      lines: [{ id: 'c-1', ref: 'tok_1', amountMinor: 85_050 }],
      declaredGrossMinor: 85_050, declaredFeesMinor: 1_531, declaredNetMinor: 85_050,
    });
    expect(bad.accepted).toBe(false);
    expect(bad.detail).toContain("provider's own arithmetic does not hold");

    const good = importSettlementBatch({
      batchId: `BATCH-${RUN}`, providerId: 'prov-1', currency: CURRENCY, settlementDate: '2026-08-04',
      lines: [{ id: 'c-1', ref: 'tok_1', amountMinor: 85_050 }],
      declaredGrossMinor: 85_050, declaredFeesMinor: 1_531, declaredNetMinor: 83_519,
    });
    expect(good.accepted).toBe(true);

    const review = reviewSettlement({
      tenders: [
        { id: 'T-1', ref: 'tok_1', amountMinor: 85_050, capturedOn: '2026-08-04' },
        { id: 'T-2', ref: 'tok_today', amountMinor: 40_000, capturedOn: '2026-08-04' },
        { id: 'T-3', ref: 'tok_ancient', amountMinor: 60_000, capturedOn: '2026-07-10' },
      ],
      credits: [{ id: 'c-1', ref: 'tok_1', amountMinor: 85_050 }],
      settlementCycleDays: 2,
      asOf: '2026-08-05',
    });

    // Yesterday's unsettled tender is not a problem. July's is.
    expect(review.exceptions.map((e) => e.finding)).toEqual(['overdue_settlement', 'awaiting_settlement']);
    expect(review.awaitingValueMinor).toBe(40_000);
    expect(review.atRiskValueMinor).toBe(60_000);

    // The one that matters gets a name and a date against it.
    const opened = openInvestigation({
      investigationId: `INV-${RUN}`,
      exception: review.exceptions[0]!,
      ownerId: 'u-cash-office-priya',
      openedBy: 'u-manager',
      at: '2026-08-05T09:00:00Z',
      dueBy: '2026-08-12',
    });
    expect(opened.opened).toBe(true);

    // And refusing to open one on money that is merely not due yet.
    expect(
      openInvestigation({
        investigationId: `INV-${RUN}-2`, exception: review.exceptions[1]!, ownerId: 'u-priya',
        openedBy: 'u-manager', at: '2026-08-05T09:00:00Z', dueBy: '2026-08-12',
      }).opened,
    ).toBe(false);

    const resolved = resolveInvestigation({
      investigation: opened.investigation!,
      outcome: 'timing_only',
      note: 'this card type settles at T+5 under the contract, not T+2',
      resolvedBy: 'u-priya',
      at: '2026-08-09T10:00:00Z',
    });
    expect(resolved.resolved).toBe(true);
    expect(resolved.feedback).toContain('correct the cycle');
  });

  it('opens a loss-prevention case on sealed evidence that cannot be quietly edited', () => {
    // The driver signal that starts it.
    const signals = detectCodAnomalies(
      [
        { stopId: 's-1', driverRef: 'drv-4', orderId: 'O-1', expectedMinor: 50_000, collectedMinor: 45_000, collectedAt: '2026-08-02T10:00:00Z', bankedAt: '2026-08-02T18:00:00Z' },
        { stopId: 's-2', driverRef: 'drv-4', orderId: 'O-2', expectedMinor: 50_000, collectedMinor: 44_000, collectedAt: '2026-08-03T10:00:00Z', bankedAt: '2026-08-03T18:00:00Z' },
        { stopId: 's-3', driverRef: 'drv-4', orderId: 'O-3', expectedMinor: 50_000, collectedMinor: 41_000, collectedAt: '2026-08-04T10:00:00Z', bankedAt: '2026-08-04T18:00:00Z' },
      ],
      '2026-08-05T09:00:00Z',
    );
    expect(signals[0]?.kind).toBe('cod_short_repeatedly');
    expect(signals[0]?.valueMinor).toBe(20_000);
    // The fraud layer detects. It does not act.
    expect(signals[0]?.actionTaken).toBe(false);

    const c = openCase({
      caseId: `CASE-${RUN}`, tenantId: TENANT, raisedFromRef: signals[0]!.signalId,
      subjectRef: 'drv-4', summary: 'three short COD returns in three days, ₹200.00',
      valueMinor: 20_000, openedBy: 'u-manager', assignedTo: 'u-security', at: '2026-08-05T10:00:00Z',
    });
    expect(c.opened).toBe(true);

    const withEvidence = addEvidence(c.case!, {
      evidenceId: 'ev-1', kind: 'transaction_record', ref: 'cod/O-1..O-3',
      description: 'three stops, each short', collectedBy: 'u-security',
      collectedAt: '2026-08-05T11:00:00Z', collectedFrom: 'delivery app records',
    });
    expect(withEvidence.added).toBe(true);
    expect(verifyEvidence(withEvidence.case).intact).toBe(true);

    // Somebody edits the description behind the code. It shows.
    const tampered = {
      ...withEvidence.case,
      evidence: [{ ...withEvidence.case.evidence[0]!, description: 'nothing unusual' }],
    };
    expect(verifyEvidence(tampered).intact).toBe(false);
    expect(
      closeCase({ case: tampered, outcome: 'unfounded', note: 'nothing here', closedBy: 'u-manager', at: '2026-08-06T09:00:00Z' }).closed,
    ).toBe(false);

    // The genuine record closes properly — and a PROVEN outcome needs a second person.
    expect(
      closeCase({ case: withEvidence.case, outcome: 'proven', note: 'admitted', closedBy: 'u-security', at: '2026-08-06T09:00:00Z' }).closed,
    ).toBe(false);
    const closed = closeCase({
      case: withEvidence.case, outcome: 'proven',
      note: 'driver admitted keeping change; ₹200.00 recovered from wages with consent',
      closedBy: 'u-owner', at: '2026-08-06T09:00:00Z',
    });
    expect(closed.closed).toBe(true);
    expect(closed.case.outcome).toBe('proven');
  });

  it('and none of the day\'s evidence can be deleted afterwards — the database refuses', async () => {
    const refusalFor = async (sql: string): Promise<string> => {
      try {
        await client.query(sql, [TENANT]);
        return 'THE DATABASE ALLOWED IT';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(await refusalFor('DELETE FROM event_ledger WHERE tenant_id = $1')).toMatch(/append-only/i);
    expect(await refusalFor("UPDATE event_ledger SET stream = 'tidied' WHERE tenant_id = $1")).toMatch(/append-only/i);

    const kept = await store.readStream(TENANT, `sale/S-${RUN}-1`);
    expect(kept).toHaveLength(1);
  });
});
