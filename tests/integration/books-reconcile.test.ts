import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  drainToTally,
  deadLetters,
  requeueCorrected,
  type QueuedPosting,
  type TallyConnector,
  type TallyOutcome,
} from '../../packages/period-close/src/tally-connector';
import {
  closePeriod,
  reopenPeriod,
  routeCorrection,
  buildEvidencePack,
  type ControlTotal,
} from '../../packages/period-close/src/period';
import { drillThrough, compareBy, type SourceTransaction } from '../../packages/owner-control/src/drill-through';
import { raiseOwnerAlerts, buildInbox } from '../../packages/owner-control/src/alerts-inbox';
import {
  buildScheduledBrief,
  briefsDue,
  markSent,
  type ScheduleState,
} from '../../packages/owner-control/src/scheduled-brief';

/**
 * STAGE 10 — finance, Tally and owner control.
 *
 * Gate (roadmap §21): **the books reconcile and the owner can see why.**
 *
 * One month closed, end to end, against a REAL PostgreSQL. Two claims:
 *
 *   1. **The books reconcile, or they do not close.** Control totals are computed from
 *      two independent sides and compared exactly. A posting the accounts never received
 *      blocks the close. Nothing is written off by the calendar.
 *   2. **The owner can see why, down to the transaction.** Every headline drills to the
 *      immutable events behind it, and if the two disagree the system says so instead of
 *      showing a plausible list.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '55555555-5555-5555-5555-555555555555';
const RUN = `f${Date.now().toString(36)}`;
const PERIOD = '2026-07';

/** Four sales, banked in PostgreSQL — the month, in miniature. */
const SALES = [
  { id: 'A', branchId: 'store-1', categoryId: 'fresh', staffId: 'u-a', netMinor: 1_200_000, taxMinor: 60_000 },
  { id: 'B', branchId: 'store-1', categoryId: 'grocery', staffId: 'u-b', netMinor: 800_000, taxMinor: 40_000 },
  { id: 'C', branchId: 'branch-2', categoryId: 'fresh', staffId: 'u-c', netMinor: 2_000_000, taxMinor: 100_000 },
  { id: 'D', branchId: 'branch-2', categoryId: 'grocery', staffId: 'u-c', netMinor: 820_000, taxMinor: 41_000 },
];
const NET_SALES = SALES.reduce((s, x) => s + x.netMinor, 0); // ₹48,200.00
const GST = SALES.reduce((s, x) => s + x.taxMinor, 0); // ₹2,410.00

function connectorReturning(script: readonly TallyOutcome[]): TallyConnector & { calls: number } {
  const c = {
    version: '1.0.0',
    calls: 0,
    post(): TallyOutcome {
      const outcome = script[Math.min(c.calls, script.length - 1)]!;
      c.calls += 1;
      return outcome;
    },
  };
  return c;
}

describe.skipIf(!DATABASE_URL)('Stage 10 — the books reconcile (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;

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

    for (const sale of SALES) {
      await store.append(
        TENANT,
        `sale/${RUN}-${sale.id}`,
        makeEvent({
          id: `${RUN}-${sale.id}`,
          type: 'SaleCommitted',
          occurredAt: `2026-07-1${SALES.indexOf(sale)}T12:00:00Z`,
          idempotencyKey: `${RUN}:${sale.id}`,
          source: sale.branchId,
          payload: {
            saleId: `${RUN}-${sale.id}`,
            branchId: sale.branchId,
            categoryId: sale.categoryId,
            staffId: sale.staffId,
            netMinor: sale.netMinor,
            taxMinor: sale.taxMinor,
            tradingDay: '2026-07-10',
          },
        }),
      );
    }
  });

  afterAll(async () => {
    await client.end();
  });

  /** The ledger side of every control total, projected from what is really in the database. */
  async function ledgerTotals(): Promise<{ net: number; tax: number; transactions: SourceTransaction[] }> {
    let net = 0;
    let tax = 0;
    const transactions: SourceTransaction[] = [];
    for (const sale of SALES) {
      const rows = await store.readStream(TENANT, `sale/${RUN}-${sale.id}`);
      for (const row of rows) {
        const p = row.event.payload as {
          netMinor: number; taxMinor: number; branchId: string; categoryId: string; staffId: string; saleId: string;
        };
        net += p.netMinor;
        tax += p.taxMinor;
        transactions.push({
          transactionId: p.saleId,
          at: row.event.occurredAt,
          branchId: p.branchId,
          categoryId: p.categoryId,
          staffId: p.staffId,
          amountMinor: p.netMinor,
          description: `Sale ${p.saleId}`,
        });
      }
    }
    return { net, tax, transactions };
  }

  it('projects the control totals from the database, not from a stored figure', async () => {
    const { net, tax } = await ledgerTotals();
    expect(net).toBe(NET_SALES);
    expect(tax).toBe(GST);
  });

  it('posts the month to Tally, dead-letters what Tally refuses, and loses nothing', () => {
    const postings: QueuedPosting[] = [
      { postingId: `${RUN}-sales`, idempotencyKey: `jv:${PERIOD}:sales:${RUN}`, period: PERIOD, journalRef: 'JV-SALES', debitMinor: NET_SALES, creditMinor: NET_SALES, state: 'queued', attempts: 0, queuedAt: '2026-08-01T02:00:00Z' },
      { postingId: `${RUN}-gst`, idempotencyKey: `jv:${PERIOD}:gst:${RUN}`, period: PERIOD, journalRef: 'JV-GST', debitMinor: GST, creditMinor: GST, state: 'queued', attempts: 0, queuedAt: '2026-08-01T02:00:00Z' },
    ];

    // Tally accepts the sales journal and refuses the GST one — a ledger name is wrong.
    const connector = connectorReturning([
      { result: 'accepted', voucherRef: 'V-1001' },
      { result: 'rejected', reason: 'ledger "Output CGST 2.5%" does not exist' },
    ]);
    const first = drainToTally(postings, connector, '2026-08-01T03:00:00Z');
    expect(first.posted).toBe(1);
    expect(first.deadLettered).toBe(1);
    expect(first.detail).toContain('nothing was dropped');

    const failed = deadLetters(first.postings);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.lastFailure).toContain('does not exist');
  });

  it('REFUSES TO CLOSE THE PERIOD while a posting the accounts never received is outstanding', async () => {
    const { net, tax } = await ledgerTotals();
    const totals: ControlTotal[] = [
      { name: 'Net sales', ledgerMinor: net, postedMinor: NET_SALES, method: 'sum of SaleCommitted netMinor vs sales-account credits' },
      // The GST journal was rejected, so the accounts received nothing.
      { name: 'GST output', ledgerMinor: tax, postedMinor: 0, method: 'sum of SaleCommitted taxMinor vs tax-account credits' },
    ];

    const result = closePeriod({
      period: PERIOD, tenantId: TENANT, totals,
      deadLetteredCount: 1, unsentSyncCount: 0, openExceptionCount: 0,
      tradingDayCutoff: '23:00 IST', closedBy: 'u-finance', at: '2026-08-05T10:00:00Z',
    });

    expect(result.closed).toBe(false);
    // Both problems at once, not one per attempt.
    expect(result.blockers.map((b) => b.kind)).toEqual([
      'control_totals_do_not_reconcile',
      'dead_lettered_postings',
    ]);
    expect(result.blockers[0]?.detail).toContain('tolerates any difference');

    // And the pack produced at this moment says, in as many words, do not sign it.
    const pack = buildEvidencePack({
      period: PERIOD, tenantId: TENANT, totals, tradingDayCutoff: '23:00 IST',
      preparedBy: 'u-finance', at: '2026-08-05T10:00:00Z', deadLetteredCount: 1,
    });
    expect(pack.signable).toBe(false);
    expect(pack.statement[pack.statement.length - 1]).toContain('Do not sign them');
  });

  it('requeues the corrected posting as a NEW posting, keeping the failure on file', () => {
    const original: QueuedPosting = {
      postingId: `${RUN}-gst`, idempotencyKey: `jv:${PERIOD}:gst:${RUN}`, period: PERIOD,
      journalRef: 'JV-GST', debitMinor: GST, creditMinor: GST, state: 'dead_lettered',
      attempts: 1, queuedAt: '2026-08-01T02:00:00Z', deadLetteredAt: '2026-08-01T03:00:00Z',
      lastFailure: 'rejected by Tally: ledger "Output CGST 2.5%" does not exist',
    };
    const requeued = requeueCorrected({
      original,
      correctedPostingId: `${RUN}-gst-b`,
      correctedIdempotencyKey: `jv:${PERIOD}:gst:${RUN}:r2`,
      fixedBy: 'u-finance',
      reason: 'created the missing tax ledger in Tally',
      at: '2026-08-02T09:00:00Z',
    });
    expect(requeued.requeued).toBe(true);
    // The failure is still exactly as it was — evidence the month was once wrong.
    expect(requeued.postings[0]).toEqual(original);

    // And now it posts. A timeout on the retry is safe: idempotency makes a duplicate
    // one voucher, not two.
    const connector = connectorReturning([{ result: 'duplicate', voucherRef: 'V-1002' }]);
    const result = drainToTally([requeued.postings[1]!], connector, '2026-08-02T09:05:00Z');
    expect(result.posted).toBe(1);
    expect(result.postings[0]?.voucherRef).toBe('V-1002');
  });

  it('CLOSES ONLY when both sides agree exactly — and the pack is signable', async () => {
    const { net, tax } = await ledgerTotals();
    const totals: ControlTotal[] = [
      { name: 'Net sales', ledgerMinor: net, postedMinor: NET_SALES, method: 'sum of SaleCommitted netMinor vs sales-account credits' },
      { name: 'GST output', ledgerMinor: tax, postedMinor: GST, method: 'sum of SaleCommitted taxMinor vs tax-account credits' },
    ];

    const result = closePeriod({
      period: PERIOD, tenantId: TENANT, totals,
      deadLetteredCount: 0, unsentSyncCount: 0, openExceptionCount: 0,
      tradingDayCutoff: '23:00 IST', closedBy: 'u-finance', at: '2026-08-05T11:00:00Z',
    });
    expect(result.closed).toBe(true);
    expect(result.totals.every((t) => t.reconciles)).toBe(true);

    const pack = buildEvidencePack({
      period: PERIOD, tenantId: TENANT, totals, tradingDayCutoff: '23:00 IST',
      preparedBy: 'u-finance', at: '2026-08-05T11:00:00Z',
    });
    expect(pack.signable).toBe(true);
    expect(pack.verdict).toContain('reconciles exactly on every control total');
    // The CA can re-derive every figure from what the pack states.
    expect(pack.statement.join(' ')).toContain('sales-account credits');
    expect(pack.statement.join(' ')).toContain(`Net sales: ${NET_SALES} on both sides`);
  });

  it('will not reopen the closed period on one person\'s say-so, and routes corrections forward', () => {
    const alone = reopenPeriod({ period: PERIOD, requestedBy: 'u-finance', at: '2026-08-06T09:00:00Z' });
    expect(alone.reopened).toBe(false);

    const self = reopenPeriod({
      period: PERIOD, requestedBy: 'u-finance',
      approval: { subjectRef: PERIOD, status: 'approved', decidedBy: 'u-finance', reason: 'late credit note' },
      at: '2026-08-06T09:00:00Z',
    });
    expect(self.reopened).toBe(false);

    // A correction for a signed month does not go back into it.
    const routed = routeCorrection({ forPeriod: PERIOD, forPeriodState: 'closed', openPeriod: '2026-08' });
    expect(routed.postToPeriod).toBe('2026-08');
    expect(routed.detail).toContain('a signed period is never edited');
  });

  it('drills from the headline to the exact events in the database, scope-enforced', async () => {
    const { net, transactions } = await ledgerTotals();

    const owner = drillThrough({
      metric: 'net sales',
      kpiValueMinor: net,
      transactions,
      scope: { userId: 'u-owner', branchScope: 'all' },
    });
    expect(owner.reconciles).toBe(true);
    expect(owner.transactions).toHaveLength(4);
    expect(owner.shownTotalMinor).toBe(NET_SALES);

    // The branch manager sees their branch, the total is recomputed, and they are told
    // that money exists they cannot see.
    const manager = drillThrough({
      metric: 'net sales',
      kpiValueMinor: net,
      transactions,
      scope: { userId: 'u-mgr-1', branchScope: ['store-1'] },
    });
    expect(manager.shownTotalMinor).toBe(2_000_000);
    expect(manager.withheldTotalMinor).toBe(2_820_000);
    expect(manager.reconciles).toBe(true);
    expect(manager.detail).toContain('outside your access');

    // A headline that does not match its own events is called out, not shown quietly.
    const wrong = drillThrough({
      metric: 'net sales',
      kpiValueMinor: net + 50_000,
      transactions,
      scope: { userId: 'u-owner', branchScope: 'all' },
    });
    expect(wrong.discrepancy).toContain('DO NOT ADD UP');
  });

  it('ranks branches and categories, and the rows reconcile to the same total', async () => {
    const { transactions } = await ledgerTotals();
    const byBranch = compareBy({
      dimension: 'branch', metric: 'net sales', transactions,
      scope: { userId: 'u-owner', branchScope: 'all' },
    });
    expect(byBranch.reconciles).toBe(true);
    expect(byBranch.totalMinor).toBe(NET_SALES);
    expect(byBranch.rows.map((r) => [r.key, r.valueMinor])).toEqual([
      ['branch-2', 2_820_000],
      ['store-1', 2_000_000],
    ]);
    // 2,820,000 / 4,820,000 = 58.50% — exact basis points, no floating point.
    expect(byBranch.rows[0]?.shareBps).toBe(5_850);
  });

  it('reaches the owner: grouped alerts, an inbox that flags a superseded item, a brief that sends itself', () => {
    const alerts = raiseOwnerAlerts({
      events: [
        ...Array.from({ length: 6 }, (_, i) => ({
          eventId: `v-${i}`, kind: 'voided_bill' as const, at: `2026-07-10T1${i}:00:00Z`,
          branchId: 'store-1', actorId: 'u-cashier-7', valueMinor: 50_000, transactionRef: `S-v${i}`,
        })),
        {
          eventId: 'l-1', kind: 'after_hours_login' as const, at: '2026-07-11T02:15:00Z',
          branchId: 'branch-2', actorId: 'u-c', valueMinor: 0, transactionRef: 'L-1',
        },
      ],
      thresholds: { voidedBillCount: 3, tradingHours: [6, 23] },
    });
    // Six voids are ONE alert; the after-hours login outranks it.
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.kind).toBe('after_hours_login');
    expect(alerts[1]?.count).toBe(6);
    expect(alerts[1]?.transactionRefs).toHaveLength(6);

    const inbox = buildInbox({
      approvals: [
        { requestId: 'AP-live', subjectType: 'price_change', subjectRef: 'price:p-rice', requestedBy: 'u-buyer', branchId: 'store-1', valueMinor: 90_000, requestedAt: '2026-08-04T09:00:00Z', subjectVersion: 'v7', summary: 'Rice price change' },
        { requestId: 'AP-stale', subjectType: 'price_change', subjectRef: 'price:p-oil', requestedBy: 'u-buyer', branchId: 'store-1', valueMinor: 120_000, requestedAt: '2026-08-03T09:00:00Z', subjectVersion: 'v1', summary: 'Oil price change' },
      ],
      viewer: { userId: 'u-owner', branchScope: 'all', authorityLimitMinor: null },
      currentSubjectVersions: { 'price:p-rice': 'v7', 'price:p-oil': 'v4' },
      at: '2026-08-05T09:00:00Z',
    });
    expect(inbox[0]?.status).toBe('actionable');
    expect(inbox[1]?.status).toBe('superseded');
    expect(inbox[1]?.detail).toContain('undo the newer change');

    // And the brief goes out — three days running, with no AI at all.
    let schedule: ScheduleState = { scheduleId: 'daily', dueAt: [7, 30], sentDays: [] };
    const sent: string[] = [];
    for (const day of ['2026-08-04', '2026-08-05', '2026-08-06']) {
      const due = briefsDue({ schedule, tradingDays: [day], now: `${day}T07:31:00Z` });
      expect(due).toHaveLength(1);
      const brief = buildScheduledBrief({
        figures: {
          tradingDay: day, netSalesMinor: NET_SALES, marginMinor: 964_000, marginBps: 2_000,
          basketCount: 412, cashBankedMinor: 1_105_000, dataAgeMinutes: 8,
        },
        attention: alerts.map((a) => ({ headline: a.headline, valueMinor: a.valueMinor, ref: a.alertId })),
      });
      expect(brief.deterministic).toBe(true);
      expect(brief.lines.join(' ')).toContain('₹48,200.00');
      sent.push(brief.tradingDay);
      schedule = markSent(schedule, day);
    }
    expect(sent).toEqual(['2026-08-04', '2026-08-05', '2026-08-06']);
  });

  it('and none of the month can be deleted afterwards — the database refuses', async () => {
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

    const { net } = await ledgerTotals();
    expect(net).toBe(NET_SALES);
  });
});
