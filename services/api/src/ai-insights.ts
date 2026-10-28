// The Owner Intelligence (A01) and Purchase (A02) agents' deterministic legs (audit EA-08 · A01 · A02 · AI-NFR-01/04).
//
// Neither calls a model and neither spends anything: each reads head office's GOVERNED records through the same
// producers the reports use and drafts evidence-backed proposals a person acts on. Read-only by construction — nothing
// here appends an event, and every proposal names the human endpoint that would act on it (hard rule #5).
//
//   • A01 (read-only): today's takings against the last day traded, how current that figure is (EA-01 source freshness),
//     and the department doing the most — each an insight with its evidence, proposing no action at all; and, when the
//     takings are DOWN, the "likely because…" lines (roadmap §7 "causal hypotheses", ai-owner-causes.ts) — each with its
//     evidence and a confidence, read-only.
//   • A02 (drafts, a buyer commits): a product that has stocked out at a location while it sold in the last seven days.
//     No reorder policy is stored at head office, so NO quantity is invented — the buyer decides how many, and raises the
//     order through the normal two-person purchase-order route.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Proposal } from '../../ai/src/index';
import type { IncomingSale } from '../../pos/src/sale-intake';
import { STREAM, inventoryAdapter, orgStructureAdapter } from './adapters';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import type { ReportProducers } from './report-producers';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { likelyCauses } from './ai-owner-causes';

type Draft = Omit<Proposal, 'committed'>;
const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A01 — the owner's insights for today, from the governed reports (read-only; proposes nothing to do). */
export async function ownerInsights(producers: ReportProducers, tenantId: string, now: string, today: string, ledgers?: { readonly store: EventStore }): Promise<Draft[]> {
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
  // Roadmap §7 "causal hypotheses": when the takings are down, the likely causes the governed records support.
  if (prior !== undefined && prior > taken.valueMinor) {
    const deptMoney = (figures: readonly { name: string; valueMinor?: number }[]): Map<string, number> =>
      new Map(figures.filter((f) => f.name.endsWith(' — taken') && f.valueMinor !== undefined).map((f) => [f.name.replace(' — taken', ''), f.valueMinor!] as const));
    const deptsBefore = await producers.produce(tenantId, 'units_by_category', { tradingDay: yesterday, scope: 'all' });
    const sync = await producers.produce(tenantId, 'sync_health', { scope: 'all' });
    const unsent = sync.figures.find((f) => f.name === 'Records not yet sent')?.valueMinor;
    const products = ledgers === undefined ? { today: new Map<string, number>(), yesterday: new Map<string, number>(), onHand: new Map<string, number>() } : await productTakings(ledgers.store, tenantId, now, today, yesterday);
    out.push(...likelyCauses({
      today, yesterday, now, takenToday: taken.valueMinor, takenYesterday: prior, staleness: taken.staleness, asAt: taken.asAt,
      departmentsToday: deptMoney(depts.figures), departmentsYesterday: deptMoney(deptsBefore.figures),
      productsToday: products.today, productsYesterday: products.yesterday, onHand: products.onHand, unsentRecords: unsent,
    }));
  }
  return out;
}

/** What each product took at each location on the two trading days (the sales ledger), and what the stock ledger holds now. */
async function productTakings(store: EventStore, tenantId: string, now: string, today: string, yesterday: string): Promise<{ today: Map<string, number>; yesterday: Map<string, number>; onHand: Map<string, number> }> {
  // A bounded read: from two days before the last day (a late-synced bill is still found by its trading day) to now.
  const from = new Date(Date.parse(`${yesterday}T00:00:00Z`) - 2 * 86_400_000).toISOString();
  const events = await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from, to: now });
  const byDay = { [today]: new Map<string, number>(), [yesterday]: new Map<string, number>() } as Record<string, Map<string, number>>;
  for (const e of events) {
    const s = e.event.payload as IncomingSale;
    const into = byDay[s.tradingDay];
    if (into === undefined || s.locationId === undefined) continue;
    for (const line of s.lines) {
      const key = `${line.productId}@${s.locationId}`;
      into.set(key, (into.get(key) ?? 0) + line.lineTotalMinor);
    }
  }
  const onHand = new Map<string, number>();
  for (const r of await inventoryAdapter({ store, now: () => now }).availability(tenantId)) {
    const key = `${r.productId}@${r.locationId}`;
    onHand.set(key, (onHand.get(key) ?? 0) + r.onHandMinor);
  }
  return { today: byDay[today]!, yesterday: byDay[yesterday]!, onHand };
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
      proposalId: `a02-stockout-${r.productId}-${r.locationId}-${shopDateIn(now)}`, agent: 'A02', createdAt: now,
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

/**
 * A03 — the TRANSFER-SUGGESTION leg (round 8 · M09-FR-03 "recommend inter-store transfers" · A03 "transfer suggestion" ·
 * manager approval). A product that is OUT at a selling location (on hand ≤ 0) while it sold there in the last seven days,
 * and that another place of the company HOLDS, is a draft transfer for a manager: from the store's own back store first,
 * then a warehouse outside any store (head office's), then another store — each source named with what head office's
 * ledger says it holds. No reorder or transfer level is stored, so NO quantity is invented: the evidence says what the
 * source holds and what the destination sold, and the manager decides how many and raises the transfer through the
 * ordinary route, where held, recalled or expired stock is refused (M09-FR-03). Read-only: nothing is appended here.
 */
export async function transferSuggestions(store: EventStore, tenantId: string, now: string): Promise<Draft[]> {
  const from = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  const recent = await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from, to: now });
  const sold = new Map<string, number>();
  for (const e of recent) {
    const s = e.event.payload as IncomingSale;
    if (s.locationId === undefined) continue;
    for (const line of s.lines) {
      const key = `${line.productId}@${s.locationId}`;
      sold.set(key, (sold.get(key) ?? 0) + line.quantityMinor);
    }
  }
  const nodes = await orgStructureAdapter({ store, now: () => now }).nodes(tenantId);
  const kindOf = new Map(nodes.map((n) => [n.nodeId, n.kind] as const));
  const branchOf = branchOfLocationIn(nodes.map((n) => ({ nodeId: n.nodeId, kind: n.kind, parentId: n.parentId ?? null })));
  const rows = await inventoryAdapter({ store, now: () => now }).availability(tenantId);
  const onHand = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const byLoc = onHand.get(r.productId) ?? new Map<string, number>();
    byLoc.set(r.locationId, (byLoc.get(r.locationId) ?? 0) + r.onHandMinor);
    onHand.set(r.productId, byLoc);
  }
  const out: Draft[] = [];
  for (const [key, units] of [...sold].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (units <= 0) continue;
    const [productId, destination] = key.split('@') as [string, string];
    const byLoc = onHand.get(productId) ?? new Map<string, number>();
    const here = byLoc.get(destination) ?? 0;
    if (here > 0) continue;
    const destBranch = branchOf(destination);
    // Sources: every OTHER place holding it, the destination's own back store first, then head office's, then other stores.
    const rank = (loc: string): number => (branchOf(loc) === destBranch ? 0 : kindOf.get(loc) === 'warehouse' && branchOf(loc) === loc ? 1 : 2);
    const sources = [...byLoc].filter(([loc, q]) => loc !== destination && q > 0).sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const best = sources[0];
    if (best === undefined) continue; // nowhere holds it — that is A02's reorder, not a transfer
    const [source, held] = best;
    const where = rank(source) === 0 ? 'its own back store' : rank(source) === 1 ? 'head office\'s warehouse' : 'another store';
    out.push({
      proposalId: `a03-transfer-${productId}-${source}-${destination}-${shopDateIn(now)}`, agent: 'A03', createdAt: now,
      summary: `${productId} is out at ${destination} (on hand ${here}) and sold ${units} there in the last 7 days; ${source} (${where}) holds ${held}. Consider a transfer — how many is the manager's decision (no transfer level is stored)`,
      wouldRequire: 'POST /v1/warehouse/transfers/:transferId by a person, dispatched and received by others (M09-FR-03 · §28)',
      evidence: [
        { source: 'inventory availability', reference: `/v1/inventory/availability?productId=${productId}`, summary: sources.map(([l, q]) => `${l}: ${q}`).concat(`${destination}: ${here}`).join('; ') },
        { source: 'sales ledger', reference: `SaleCommitted ${from}..${now}`, summary: `${units} sold at ${destination} in the last 7 days` },
      ],
    });
  }
  return out;
}
