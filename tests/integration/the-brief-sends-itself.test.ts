import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport, type NotificationTransport } from '../../packages/notifications/src/index';
import { scheduledBriefAdapter, STREAM } from '../../services/api/src/adapters';
import { reportProducers } from '../../services/api/src/report-producers';
import { scheduledBriefRoutes, type BriefRunLine, type ScheduledBriefDeps } from '../../services/reporting/src/scheduled-brief';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * **The daily brief sends itself — three scheduled days running, a missed day caught up, no AI involved (audit EA-07 ·
 * M29-FR-04 acceptance: "the daily brief arrives on the phone at the set time for three days running without anyone
 * sending it … if AI is off, the numbers still arrive").**
 *
 * The real schedule store, the real head-office report producer (sales by day, with its source freshness) and the brief
 * engine run over one event store, against a clock the test moves through the shop's mornings (IST, 08:00 due). The
 * phone transport is the RECORDING test adapter — the real provider is release R4 (OB-29). A brief is acknowledged as
 * sent only when the transport took it; a failed send stays due and the next run retries it; with no transport each due
 * brief is composed and said to be unsent, never marked sent. Head office has no cost of goods, so the margin line says
 * "not available" — never ₹0.
 */

const T = '33333333-3333-4333-8333-333333333333';
const IST = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' };

function rig(transport: NotificationTransport | undefined) {
  const store = new InMemoryEventStore();
  let clock = '2026-10-01T00:00:00.000Z';
  const now = (): string => clock;
  const producers = reportProducers({ store, now, calendar: () => IST, loyaltyRule: () => ({ pointValuePaise: 0 }) });
  const deps: ScheduledBriefDeps = {
    ...scheduledBriefAdapter({ store, now }),
    calendar: () => IST,
    dayFigures: async (tenantId, tradingDay) => {
      const day = await producers.produce(tenantId, 'sales_by_day', { tradingDay, scope: 'all' });
      const taken = day.figures.find((f) => f.name === 'Taken');
      const bills = day.figures.find((f) => f.name === 'Bills');
      return {
        tradingDay,
        ...(taken?.valueMinor === undefined ? {} : { grossTakenMinor: taken.valueMinor }),
        ...(bills?.valueMinor === undefined ? {} : { basketCount: bills.valueMinor }),
        ...(taken?.asAt == null ? {} : { dataAgeMinutes: Math.round((Date.parse(now()) - Date.parse(taken.asAt)) / 60_000) }),
      };
    },
    recipient: () => 'u-owner',
    ...(transport === undefined ? {} : { transport }),
  };
  const routes = scheduledBriefRoutes(deps);
  const route = (path: string): Route => routes.find((r) => r.path === path)!;
  const ctx = (body?: unknown): RequestContext => ({ tenantId: T, userId: 'u-scheduler', branchId: null, params: {}, query: {}, body, traceId: 't', idempotencyKey: `k-${clock}` } as RequestContext);
  return {
    store,
    at: (iso: string) => { clock = iso; },
    setSchedule: () => route('/v1/reporting/brief-schedule').handler(ctx({ dueAt: [8, 0] })),
    run: async () => ((await route('/v1/reporting/brief-schedule/run').handler(ctx({}))).body as { ran: BriefRunLine[] }).ran,
    sale: (id: string, tradingDay: string, at: string, totalMinor: number) => store.append(T, STREAM.sales, makeEvent({
      id: `e-${id}`, type: 'SaleCommitted', occurredAt: at, idempotencyKey: `sale-${T}-${id}`, source: 'test',
      payload: { saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-c', tradingDay, committedAt: at, totalMinor, currency: 'INR', packVersion: 1, lines: [], tenders: [{ kind: 'cash', amountMinor: totalMinor }] },
    })),
  };
}

describe('the daily brief sends itself (EA-07 · M29-FR-04)', () => {
  it('three mornings running at the shop\'s 08:00, with nobody sending it — the numbers, no AI, margin said "not available"', async () => {
    const transport = recordingTransport();
    const r = rig(transport);
    r.at('2026-10-01T01:00:00.000Z'); // 06:30 IST on the 1st
    await r.setSchedule();
    for (const [day, utcSale, total] of [['2026-10-01', '2026-10-01T02:00:00.000Z', 120_000], ['2026-10-02', '2026-10-02T02:00:00.000Z', 95_000], ['2026-10-03', '2026-10-03T02:00:00.000Z', 150_000]] as const) {
      await r.sale(`S-${day}`, day, utcSale, total);
      r.at(`${day}T02:20:00.000Z`); // 07:50 IST — not yet due
      expect(await r.run()).toEqual([]);
      r.at(`${day}T02:35:00.000Z`); // 08:05 IST — due
      const ran = await r.run();
      expect(ran).toEqual([expect.objectContaining({ tradingDay: day, reason: 'scheduled', outcome: 'sent', deterministic: true })]);
      expect(ran[0]!.lines).toEqual(expect.arrayContaining([
        `Taken at the tills (incl. GST): ₹${(total / 100).toLocaleString('en-IN')}.00`, 'Margin: not available', 'Baskets: 1',
      ]));
      // A second run the same morning sends nothing more.
      expect(await r.run()).toEqual([]);
    }
    expect(transport.sent.map((m) => m.messageId)).toEqual([`brief-${T}-2026-10-01`, `brief-${T}-2026-10-02`, `brief-${T}-2026-10-03`]);
    expect(transport.sent.every((m) => m.customerId === 'u-owner')).toBe(true);
  });

  it('a missed morning is caught up next run, labelled LATE — never skipped as though the day never happened', async () => {
    const transport = recordingTransport();
    const r = rig(transport);
    r.at('2026-10-01T01:00:00.000Z');
    await r.setSchedule();
    r.at('2026-10-01T02:35:00.000Z');
    expect((await r.run()).map((x) => x.outcome)).toEqual(['sent']);
    // The scheduler did not run on the 2nd at all. On the 3rd it sends the 2nd (late) and the 3rd.
    r.at('2026-10-03T02:35:00.000Z');
    const ran = await r.run();
    expect(ran.map((x) => [x.tradingDay, x.reason, x.outcome])).toEqual([['2026-10-02', 'missed_catch_up', 'sent'], ['2026-10-03', 'scheduled', 'sent']]);
    expect(ran[0]!.lines[0]).toMatch(/^LATE — the brief for 2026-10-02/);
  });

  it('a failed send is not acknowledged and the next run retries it; with no transport it is composed and said UNSENT', async () => {
    const transport = recordingTransport();
    const r = rig(transport);
    r.at('2026-10-01T01:00:00.000Z');
    await r.setSchedule();
    r.at('2026-10-01T02:35:00.000Z');
    transport.failWith({ reason: 'provider timeout' }, 1);
    expect((await r.run()).map((x) => x.outcome)).toEqual(['send_failed_will_retry']);
    r.at('2026-10-01T02:50:00.000Z');
    expect((await r.run()).map((x) => x.outcome)).toEqual(['sent']);

    const quiet = rig(undefined);
    quiet.at('2026-10-01T01:00:00.000Z');
    await quiet.setSchedule();
    quiet.at('2026-10-01T02:35:00.000Z');
    const ran = await quiet.run();
    expect(ran).toEqual([expect.objectContaining({ outcome: 'composed_not_sent' })]);
    expect(ran[0]!.detail).toMatch(/NOT sent, still due/);
    // No sale ever reached head office: the brief says so rather than printing ₹0.
    expect(ran[0]!.lines[0]).toMatch(/nothing has arrived from the shop yet/);
    // Still due on the next run — an unsent brief is never marked sent.
    quiet.at('2026-10-01T03:00:00.000Z');
    expect((await quiet.run()).map((x) => x.outcome)).toEqual(['composed_not_sent']);
  });
});
