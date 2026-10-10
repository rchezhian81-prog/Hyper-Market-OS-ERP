// The Owner Intelligence (A01) and Purchase (A02) agents' deterministic legs (audit EA-08 · A01 · A02 · AI-NFR-01/04).
//
// Neither calls a model and neither spends anything: each reads head office's GOVERNED records through the same
// producers the reports use and drafts evidence-backed proposals a person acts on. Read-only by construction — nothing
// here appends an event, and every proposal names the human endpoint that would act on it (hard rule #5).
//
//   • A01 (read-only): today's takings against the last day traded, how current that figure is (EA-01 source freshness),
//     and the department doing the most — each an insight with its evidence, proposing no action at all.
//   • A02 (drafts, a buyer commits): a product that has stocked out at a location while it sold in the last seven days.
//     No reorder policy is stored at head office, so NO quantity is invented — the buyer decides how many, and raises the
//     order through the normal two-person purchase-order route.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Proposal } from '../../ai/src/index';
import type { IncomingSale } from '../../pos/src/sale-intake';
import { STREAM, inventoryAdapter } from './adapters';
import type { ReportProducers } from './report-producers';

type Draft = Omit<Proposal, 'committed'>;
const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A01 — the owner's insights for today, from the governed reports (read-only; proposes nothing to do). */
export async function ownerInsights(producers: ReportProducers, tenantId: string, now: string, today: string): Promise<Draft[]> {
  const out: Draft[] = [];
  const day = await producers.produce(tenantId, 'sales_by_day', { scope: 'all' });
  const taken = day.figures.find((f) => f.name === 'Taken');
  if (taken === undefined || taken.valueMinor === undefined) {
    out.push({
      proposalId: `a01-nothing-${today}`, agent: 'A01', createdAt: now,
      summary: `No sale has reached head office for ${today}: ${taken?.notAvailableBecause ?? 'nothing has arrived yet'}`,
      wouldRequire: 'nothing — A01 is read-only; check the store computer\'s sync if the shop is trading',
      evidence: [{ source: 'report sales_by_day', reference: `/v1/reports/sales_by_day?day=${today}`, summary: taken?.detail ?? 'no figure' }],
    });
    return out;
  }
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const before = await producers.produce(tenantId, 'sales_by_day', { tradingDay: yesterday, scope: 'all' });
  const prior = before.figures.find((f) => f.name === 'Taken')?.valueMinor;
  out.push({
    proposalId: `a01-takings-${today}`, agent: 'A01', createdAt: now,
    summary: prior === undefined || prior === 0
      ? `Taken so far today: ${rupees(taken.valueMinor)} (${taken.staleness}, as at ${taken.asAt}); no takings on record for ${yesterday} to compare with`
      : `Taken so far today: ${rupees(taken.valueMinor)} against ${rupees(prior)} on ${yesterday} (${taken.valueMinor >= prior ? 'up' : 'down'} ${rupees(Math.abs(taken.valueMinor - prior))}); figure ${taken.staleness}, as at ${taken.asAt}`,
    wouldRequire: 'nothing — A01 is read-only; a person decides what, if anything, to do',
    evidence: [
      { source: 'report sales_by_day', reference: `/v1/reports/sales_by_day?day=${today}`, summary: taken.detail },
      ...(prior === undefined ? [] : [{ source: 'report sales_by_day', reference: `/v1/reports/sales_by_day?day=${yesterday}`, summary: `${rupees(prior)} taken on ${yesterday}` }]),
    ],
  });
  if (taken.staleness !== 'live') {
    out.push({
      proposalId: `a01-stale-${today}`, agent: 'A01', createdAt: now,
      summary: `Today's figures are ${taken.staleness}: the newest sale head office holds is from ${taken.asAt}. Do not decide on them until the store's sync catches up`,
      wouldRequire: 'nothing — A01 is read-only; check the store computer\'s sync status',
      evidence: day.sources.map((s) => ({ source: 'source freshness', reference: s.source, summary: s.detail })),
    });
  }
  const depts = await producers.produce(tenantId, 'units_by_category', { scope: 'all' });
  const money = depts.figures.filter((f) => f.name.endsWith(' — taken') && f.valueMinor !== undefined).sort((a, b) => b.valueMinor! - a.valueMinor!);
  if (money.length > 0) {
    out.push({
      proposalId: `a01-top-department-${today}`, agent: 'A01', createdAt: now,
      summary: `The department taking the most today is ${money[0]!.name.replace(' — taken', '')}: ${rupees(money[0]!.valueMinor!)}`,
      wouldRequire: 'nothing — A01 is read-only',
      evidence: [{ source: 'report units_by_category', reference: `/v1/reports/units_by_category?day=${today}`, summary: money.map((f) => `${f.name} ${rupees(f.valueMinor!)}`).join('; ') }],
    });
  }
  return out;
}

/** A02 — stock-outs with recent demand: a DRAFT for a buyer, never a quantity it cannot justify, never an order. */
export async function purchaseSuggestions(store: EventStore, tenantId: string, now: string): Promise<Draft[]> {
  const from = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  const recent = await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from, to: now });
  const soldUnits = new Map<string, number>();
  for (const e of recent) {
    const s = e.event.payload as IncomingSale;
    for (const line of s.lines) {
      if (s.locationId === undefined) continue;
      const key = `${line.productId}@${s.locationId}`;
      soldUnits.set(key, (soldUnits.get(key) ?? 0) + (line.uom === 'ea' ? line.quantityMinor : 1));
    }
  }
  const rows = await inventoryAdapter({ store, now: () => now }).availability(tenantId);
  const out: Draft[] = [];
  for (const r of rows) {
    const sold = soldUnits.get(`${r.productId}@${r.locationId}`) ?? 0;
    if (r.onHandMinor > 0 || sold === 0) continue;
    out.push({
      proposalId: `a02-stockout-${r.productId}-${r.locationId}-${now.slice(0, 10)}`, agent: 'A02', createdAt: now,
      summary: `${r.productId} is out of stock at ${r.locationId} (on hand ${r.onHandMinor}) and sold ${sold} in the last 7 days — consider reordering. No reorder level is stored, so how many is the buyer's decision`,
      wouldRequire: 'POST /v1/purchase/orders/:poId by a buyer, approved by a second person (§28)',
      evidence: [
        { source: 'inventory availability', reference: `/v1/inventory/availability?productId=${r.productId}`, summary: `${r.productId} at ${r.locationId}: on hand ${r.onHandMinor}` },
        { source: 'sales ledger', reference: `SaleCommitted ${from}..${now}`, summary: `${sold} sold at ${r.locationId} in the last 7 days` },
      ],
    });
  }
  return out;
}
