// R3 lane 1 — GST liability and returns (A15 GSTR-3B · A16 lock · A14 reverse charge · A19 filing calendar · A18
// GSTR-9/9C · A21 30-day e-invoice guard). Head-office wiring only: the rules live in `packages/finance`, the routes in
// `services/finance/src/{gst-controls,gstr3b-store,rcm-store,filing-register,annual-return,einvoice-reporting-guard}.ts`.
//
// Every register here is append-only on its own stream under `gstreturns` (hard rules #2, #6); every read folds the
// stored facts. The sales, returns, outward documents, catalogue tax table, GSTR-1 submissions, supplier master, day
// book and e-invoice lifecycle are READ through the existing adapters — this lane never writes them.
//
// GSTR-3B Table 4 reads input credit through the A17 port (`packages/finance/src/itc-port.ts`). main.ts wires the A17
// reconciliation through `r3-itc-bridge.ts`; with no port given, the stand-in answers "ITC not yet reconciled" — an
// exception on the return, never zero.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import { InMemoryEventStore, ConcurrencyConflictError, type EventStore } from '../../../packages/persistence/src/event-store';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import type { Route } from '../../kernel/src/index';
import {
  computeGstr1Figures, gstr1CanonicalForm, reverseChargeForPeriod, nextSelfInvoiceNumber, parseMonthlyPeriod, parseFinancialYear,
  periodOfDate, periodsBetween, comparePeriods, ITC_NOT_YET_RECONCILED, buildFilingCalendar,
  type ItcPort, type Gstr3bLock, type CarriedAmendment, type Gstr1FilingState, type RcmControl, type RcmSelfInvoice, type RcmPayment,
  type FilingFact, type CalendarEntry, type Gstr9cReason, type AnnualMonthInput, type SoldTaxLine, type OutwardDocument,
} from '../../../packages/finance/src/index';
import type { Gstr1SubmissionEvent } from '../../../packages/finance/src/gstr1-submission';
import { gstControlsRoutes, gstControlsOf, timeBarWindowSaid, type GstControlChange, type RcmHeadChange, type GstControlsDeps } from '../../finance/src/gst-controls';
import { gstr3bRoutes, type GstMonth } from '../../finance/src/gstr3b-store';
import { rcmRoutes, type RecordedRcmPurchase } from '../../finance/src/rcm-store';
import { filingRegisterRoutes, financialYearsOf, type RecordedFiling, type FilingRegisterDeps } from '../../finance/src/filing-register';
import { annualReturnRoutes } from '../../finance/src/annual-return';
import { eInvoiceGuardRoutes, eInvoiceReportingGuard, type EInvoiceReportingBlock, type EInvoiceGuardDeps } from '../../finance/src/einvoice-reporting-guard';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import type { PeriodSoldLine } from '../../finance/src/gst-returns';
import {
  STREAM, streamName, gstReturnsAdapter, gstr1SubmissionAdapter, supplierMasterAdapter, alertLifecycleAdapter, effectiveGrants, eInvoiceAdapter,
  type ShopCalendarOf,
} from './adapters';
import { OWNER_ROLE_ID } from './roles';

// ── streams ──────────────────────────────────────────────────────────────────────────────────────────────────────

const CONTROLS = streamName(STREAM.gstreturns, 'r3-controls');
const GSTR3B = streamName(STREAM.gstreturns, 'gstr3b');
const RCM = streamName(STREAM.gstreturns, 'rcm');
const FILINGS = streamName(STREAM.gstreturns, 'filings');
const GSTR9C_REASONS = streamName(STREAM.gstreturns, 'gstr9c-reasons');
const EINVOICE_GUARD = streamName(STREAM.gstreturns, 'einvoice-guard');
/** The GSTR-1 submission stream of a month, as `gstr1SubmissionAdapter` writes it — read here for the filed date only. */
const gstr1SubmissionStream = (period: string): string => streamName(STREAM.gstreturns, 'submission', period);

const keyed = (prefix: string, key: string): string => `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;

async function payloads<T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<readonly T[]> {
  return (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
}

async function append(store: EventStore, tenantId: string, stream: string, type: string, key: string, at: string, payload: unknown): Promise<void> {
  await store.append(tenantId, stream, makeEvent({ id: keyed(`r3gst-${type}`, `${tenantId}|${key}`), type, occurredAt: at, idempotencyKey: `r3gst-${tenantId}-${type}-${key}`, source: 'api/finance', payload }));
}

/** The shop's own calendar date for an instant, in its time zone. */
export function localDateOf(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const shiftDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000).toISOString();

export interface R3GstInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  /** The shop's IANA time zone (store setup). Default Asia/Kolkata. */
  readonly timeZone?: (tenantId: string) => Promise<string>;
  /** The shop's trading calendar (time zone + cut-off): the trading day a till return is dated to (M01-FR-02). */
  readonly calendar?: ShopCalendarOf;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown>;
  /** A17's implementation of the ITC port (main.ts: `itcPortForStore`, r3-itc-bridge.ts). Absent: "ITC not yet reconciled". */
  readonly itc?: ItcPort;
}

/** The R3 GST lane composed over one store. */
export function r3GstLedger(input: { readonly store: EventStore; readonly now: () => string; readonly timeZone?: (tenantId: string) => Promise<string>; readonly calendar?: ShopCalendarOf; readonly itc?: ItcPort }) {
  const { store, now } = input;
  const itc = input.itc ?? ITC_NOT_YET_RECONCILED;
  const gst = gstReturnsAdapter({ store, now, ...(input.calendar !== undefined ? { calendar: input.calendar } : {}) });
  const submissions = gstr1SubmissionAdapter({ store, now });
  const today = async (tenantId: string): Promise<string> => localDateOf(now(), input.timeZone === undefined ? 'Asia/Kolkata' : await input.timeZone(tenantId));

  // controls
  const controlChanges = (t: string) => payloads<GstControlChange>(store, t, CONTROLS, 'GstControlChanged');
  const headChanges = (t: string) => payloads<RcmHeadChange>(store, t, CONTROLS, 'RcmHeadChanged');
  const controls = (t: string) => gstControlsOf({ controlChanges, headChanges }, t);
  const rcmControl = async (t: string): Promise<RcmControl> => {
    const c = await controls(t);
    return { switchedOn: c.reverseCharge.value, heads: c.rcmHeads.map(({ headCode, name, rateBps, notifiedUnder }) => ({ headCode, name, rateBps, notifiedUnder })) };
  };

  // the GSTR-3B register
  const locks = (t: string) => payloads<Gstr3bLock>(store, t, GSTR3B, 'Gstr3bLocked');
  const amendments = (t: string) => payloads<CarriedAmendment>(store, t, GSTR3B, 'Gstr1AmendmentRecorded');

  // reverse charge
  const purchases = (t: string) => payloads<RecordedRcmPurchase>(store, t, RCM, 'RcmPurchaseRecorded');
  const selfInvoices = (t: string) => payloads<RcmSelfInvoice>(store, t, RCM, 'RcmSelfInvoiceIssued');
  const payments = (t: string) => payloads<RcmPayment>(store, t, RCM, 'RcmLiabilityPaid');

  // filings
  const recordedFilings = (t: string) => payloads<RecordedFiling>(store, t, FILINGS, 'GstReturnFiledRecorded');

  /** The GSTR-1 filing state of a month: the submission store's, else a filing recorded as made outside this system. */
  const gstr1Of = async (t: string, period: string): Promise<GstMonth['gstr1']> => {
    const agg = await submissions.load(t, period);
    if (agg !== undefined) return { state: agg.state, ...(agg.arn !== undefined ? { arn: agg.arn } : {}), returnDigest: agg.returnDigest };
    const outside = (await recordedFilings(t)).find((f) => f.type === 'GSTR1' && f.period === period);
    return outside !== undefined ? { state: 'filed', arn: outside.arn } : { state: 'not_started' };
  };

  const toSold = (l: PeriodSoldLine): SoldTaxLine => ({
    productId: l.productId, quantityMinor: l.quantityMinor, uom: l.uom, lineTotalMinor: l.lineTotalMinor,
    ...(l.hsnCode !== undefined ? { hsnCode: l.hsnCode } : {}), ...(l.rateBps !== undefined ? { rateBps: l.rateBps } : {}),
  });

  /** The banked sale and return lines whose trading day falls in the month (a window wide enough for late syncs). */
  const tillLines = async (t: string, from: string, to: string) => {
    const wf = shiftDays(from, -2);
    const wt = shiftDays(to, 45);
    const inMonth = (l: PeriodSoldLine): boolean => l.tradingDay >= from && l.tradingDay <= to;
    const sold = (await gst.soldTaxLines(t, wf, wt)).filter(inMonth);
    const returned = (await gst.returnedTaxLines(t, wf, wt)).filter(inMonth);
    return { sold, returned };
  };

  const month = async (t: string, period: string, annualTurnoverMinor: number): Promise<GstMonth> => {
    const p = parseMonthlyPeriod(period);
    const { sold, returned } = await tillLines(t, p.from, p.to);
    const documents: OutwardDocument[] = (await gst.documents(t)).filter((d) => d.documentDate >= p.from && d.documentDate <= p.to);
    const all = await amendments(t);
    const amendmentsIn = all.filter((a) => a.intoPeriod === period);
    const amendmentsOut = all.filter((a) => a.fromPeriod === period);
    const current = computeGstr1Figures({
      period, sold: sold.map(toSold), returned: returned.map(toSold), taxTable: [...(await gst.productTaxTable(t))],
      annualTurnoverMinor, documents, amendmentsIn,
    });
    const lock = (await locks(t)).find((l) => l.period === period);
    const rc = reverseChargeForPeriod({ from: p.from, to: p.to, selfInvoices: await selfInvoices(t), payments: await payments(t) });
    return {
      period, current, gstr1: await gstr1Of(t, period),
      ...(lock !== undefined ? { lock } : {}),
      amendmentsIn, amendmentsOut, reverseCharge: rc, itc: await itc.itcForPeriod(t, period),
    };
  };

  /** Every filed fact: GSTR-1 from the submission store (with the date the portal acknowledged it) and the recorded ones. */
  const facts = async (t: string): Promise<readonly FilingFact[]> => {
    const out: FilingFact[] = [];
    const tz = input.timeZone === undefined ? 'Asia/Kolkata' : await input.timeZone(t);
    for (const period of await submissions.listPeriods(t)) {
      const agg = await submissions.load(t, period);
      if (agg?.state !== 'filed') continue;
      const events = await payloads<Gstr1SubmissionEvent>(store, t, gstr1SubmissionStream(period), 'Gstr1SubmissionRecorded');
      const filedAt = [...events].reverse().find((e) => e.kind === 'acknowledged' || (e.kind === 'reconciled' && e.resolvedState === 'filed'))?.at;
      out.push({ type: 'GSTR1', period, filedOn: filedAt === undefined ? '' : localDateOf(filedAt, tz), ...(agg.arn !== undefined ? { arn: agg.arn } : {}), source: 'gstr1-submission' });
    }
    for (const f of await recordedFilings(t)) out.push({ type: f.type, period: f.period, filedOn: f.filedOn, arn: f.arn, source: 'recorded' });
    return out;
  };

  /** The months the shop has traded or filed in, from the first to the current month. */
  const monthlyPeriods = async (t: string, todayIso: string): Promise<readonly string[]> => {
    const current = periodOfDate(todayIso);
    const known: string[] = [
      ...(await submissions.listPeriods(t)),
      ...(await recordedFilings(t)).filter((f) => f.type === 'GSTR1' || f.type === 'GSTR3B').map((f) => f.period),
      ...(await locks(t)).map((l) => l.period),
      ...(await purchases(t)).map((p) => periodOfDate(p.supplyDate)),
    ].filter((p) => { try { parseMonthlyPeriod(p); return true; } catch { return false; } });
    // The first banked sale before anything known (the shop's first trading month on this system).
    const bound = known.length === 0 ? undefined : [...known].sort(comparePeriods)[0]!;
    const firstSale = (await store.readStream(t, STREAM.sales, { type: 'SaleCommitted', ...(bound === undefined ? {} : { to: `${parseMonthlyPeriod(bound).from}T00:00:00.000Z` }) }))
      .map((e) => (e.event.payload as { tradingDay?: string }).tradingDay).filter((d): d is string => typeof d === 'string').sort()[0];
    if (firstSale !== undefined) known.push(periodOfDate(firstSale));
    if (known.length === 0) return [];
    const first = [...known].sort(comparePeriods)[0]!;
    return comparePeriods(first, current) > 0 ? [] : periodsBetween(first, current);
  };

  return {
    today, controls, controlChanges, headChanges, rcmControl, month, locks, amendments, purchases, selfInvoices, payments,
    recordedFilings, gstr1Of, facts, monthlyPeriods, tillLines,
    digestOf: (f: Parameters<typeof gstr1CanonicalForm>[0]): string => createHash('sha256').update(gstr1CanonicalForm(f)).digest('hex'),
  };
}

/** The A21 guard's dependencies over a store — shared by its read route and the e-invoice submit boundary. */
export function eInvoiceGuardAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly timeZone?: (tenantId: string) => Promise<string> }): EInvoiceGuardDeps {
  const ledger = r3GstLedger(input);
  const einv = eInvoiceAdapter({ store: input.store, now: input.now });
  return {
    now: input.now,
    today: ledger.today,
    switchedOn: async (t) => (await ledger.controls(t)).einvoice30DayGuard.value,
    blocks: (t) => payloads<EInvoiceReportingBlock>(input.store, t, EINVOICE_GUARD, 'EInvoiceReportingBlocked'),
    recordBlock: (t, b) => append(input.store, t, EINVOICE_GUARD, 'EInvoiceReportingBlocked', `${b.invoiceId}|${b.blockedOn}`, input.now(), b),
    lifecycle: async (t) => {
      const rows = [];
      for (const id of await einv.listInvoiceIds(t)) {
        const agg = await einv.load(t, id);
        if (agg?.request === undefined) continue;
        rows.push({ invoiceId: id, state: agg.state, documentType: agg.request.documentType, documentNumber: agg.request.documentNumber, documentDate: agg.request.documentDate });
      }
      return rows;
    },
  };
}

/** A21: the guard the e-invoice submit route consults (off until the owner switches it on). */
export function eInvoiceReportingGuardFor(input: { readonly store: EventStore; readonly now: () => string; readonly timeZone?: (tenantId: string) => Promise<string> }) {
  return eInvoiceReportingGuard(eInvoiceGuardAdapter(input));
}

/** The routes this lane adds to head office, composed from its store (or an in-memory one when there is none). */
export function r3GstRoutes(input: R3GstInput): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  const { now } = input;
  const ledger = r3GstLedger({ store, now, ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}), ...(input.calendar !== undefined ? { calendar: input.calendar } : {}), ...(input.itc !== undefined ? { itc: input.itc } : {}) });
  const recordAudit = input.recordAudit;

  const controlsDeps: GstControlsDeps = {
    now, controlChanges: ledger.controlChanges, headChanges: ledger.headChanges,
    recordControl: (t, c) => append(store, t, CONTROLS, 'GstControlChanged', `${c.control}|${c.at}|${c.by}`, c.at, c),
    recordHead: (t, h) => append(store, t, CONTROLS, 'RcmHeadChanged', `${h.headCode}|${h.change}|${h.at}|${h.by}`, h.at, h),
    ...(recordAudit !== undefined ? { recordAudit } : {}),
  };

  const filingDeps: FilingRegisterDeps = {
    now, today: ledger.today, monthlyPeriods: ledger.monthlyPeriods, facts: ledger.facts,
    nearBarDays: async (t) => (await ledger.controls(t)).timeBarWarningDays.value,
    // OB-191: 180 days unless the owner has changed it — said as "180 days (owner's decision OB-191)".
    nearBarDaysSaid: async (t) => timeBarWindowSaid((await ledger.controls(t)).timeBarWarningDays),
    gstr1State: async (t, p) => (await submissions(t, p)),
    gstr3bLocked: async (t, p) => (await ledger.locks(t)).some((l) => l.period === p),
    recordFiling: (t, f) => append(store, t, FILINGS, 'GstReturnFiledRecorded', `${f.type}|${f.period}`, f.recordedAt, f),
    raiseToOwners: (t, raise, filed, by, at) => raiseTimeBarAlerts(store, now, t, raise, filed, by, at),
    ...(recordAudit !== undefined ? { recordAudit } : {}),
  };
  async function submissions(t: string, p: string): Promise<Gstr1FilingState> {
    const agg = await gstr1SubmissionAdapter({ store, now }).load(t, p);
    return agg === undefined ? 'not_started' : agg.state;
  }

  return [
    ...gstControlsRoutes(controlsDeps),
    ...gstr3bRoutes({
      now, month: ledger.month, digestOf: ledger.digestOf,
      recordLock: (t, l) => append(store, t, GSTR3B, 'Gstr3bLocked', `lock|${l.period}`, l.lockedAt, l),
      recordAmendment: (t, a) => append(store, t, GSTR3B, 'Gstr1AmendmentRecorded', `amendment|${a.fromPeriod}|${a.amendmentId}`, a.recordedAt, a),
    }),
    ...rcmRoutes({
      now, control: ledger.rcmControl, purchases: ledger.purchases, selfInvoices: ledger.selfInvoices, payments: ledger.payments,
      supplierGstin: async (t, id) => {
        const r = await supplierMasterAdapter({ store, now }).record(t, id);
        return r === undefined ? undefined : { gstin: r.gstin ?? null };
      },
      recordPurchase: (t, p, issue) => recordRcmPurchase(store, ledger.selfInvoices, t, p, issue),
      recordPayment: (t, pay) => append(store, t, RCM, 'RcmLiabilityPaid', `paid|${pay.number}`, now(), pay),
      ...(recordAudit !== undefined ? { recordAudit } : {}),
    }),
    ...filingRegisterRoutes(filingDeps),
    ...annualReturnRoutes({
      now,
      months: (t, fy, turnover) => annualMonths(store, ledger, t, fy, turnover),
      reasons: async (t, fy) => (await payloads<Gstr9cReason & { fy: string }>(store, t, GSTR9C_REASONS, 'Gstr9cReasonRecorded')).filter((r) => r.fy === fy),
      recordReason: (t, fy, r) => append(store, t, GSTR9C_REASONS, 'Gstr9cReasonRecorded', `${fy}|${r.period}|${r.code}|${r.at}|${r.by}`, r.at, { ...r, fy }),
    }),
    ...eInvoiceGuardRoutes(eInvoiceGuardAdapter({ store, now, ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}) })),
  ];
}

/**
 * Record a reverse-charge purchase and, when it raises one, its self-invoice — in ONE atomic write guarded on the
 * financial year's series, so two purchases at once can never take the same number and no number is ever skipped
 * (A2: gap-free). A lost race re-reads the series and tries again.
 */
async function recordRcmPurchase(
  store: EventStore, issuedOf: (t: string) => Promise<readonly RcmSelfInvoice[]>,
  tenantId: string, purchase: RecordedRcmPurchase, issue: { readonly headCode: string; readonly tax: RcmSelfInvoice['tax'] } | undefined,
): Promise<string | undefined> {
  const purchaseEvent = (p: RecordedRcmPurchase) => makeEvent({
    id: keyed('r3gst-rcm-purchase', `${tenantId}|${p.purchaseId}`), type: 'RcmPurchaseRecorded', occurredAt: p.recordedAt,
    idempotencyKey: `r3gst-${tenantId}-rcm-purchase-${p.purchaseId}`, source: 'api/finance', payload: p,
  });
  if (issue === undefined) {
    await store.append(tenantId, RCM, purchaseEvent(purchase));
    return undefined;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const next = nextSelfInvoiceNumber(await issuedOf(tenantId), purchase.supplyDate);
    const key = `rcm-self-invoice-series:${next.fyCompact}`;
    const version = await store.guardVersion(tenantId, key);
    // Re-read under the guard version: what is issued now is what the number is allocated against.
    const fresh = nextSelfInvoiceNumber(await issuedOf(tenantId), purchase.supplyDate);
    const invoice: RcmSelfInvoice = {
      number: fresh.number, seq: fresh.seq, fyCompact: fresh.fyCompact, purchaseId: purchase.purchaseId, supplierId: purchase.supplierId,
      headCode: issue.headCode, supplyDate: purchase.supplyDate, tax: issue.tax, issuedBy: purchase.recordedBy, issuedAt: purchase.recordedAt,
    };
    try {
      await store.appendBatch(tenantId, [
        { stream: RCM, event: purchaseEvent({ ...purchase, selfInvoiceNumber: fresh.number }) },
        { stream: RCM, event: makeEvent({ id: keyed('r3gst-rcm-self-invoice', `${tenantId}|${fresh.number}`), type: 'RcmSelfInvoiceIssued', occurredAt: purchase.recordedAt, idempotencyKey: `r3gst-${tenantId}-rcm-self-invoice-${fresh.number}`, source: 'api/finance', payload: invoice }) },
      ], { guard: { key, expectedVersion: version } });
      return fresh.number;
    } catch (e) {
      if (e instanceof ConcurrencyConflictError) continue;
      throw e;
    }
  }
  throw new ConcurrencyConflictError(`rcm-self-invoice-series`, -1);
}

/** The year's twelve months as the annual return reads them, with the day book's figures beside each. */
async function annualMonths(store: EventStore, ledger: ReturnType<typeof r3GstLedger>, t: string, fy: string, turnover: number): Promise<readonly AnnualMonthInput[]> {
  const year = parseFinancialYear(fy);
  const recorded = await ledger.recordedFilings(t);
  // The day book's posted sale / return vouchers (what the books hold), by trading day.
  const journals = (await store.readStream(t, STREAM.finance, { type: 'JournalPosted' }))
    .map((e) => (e.event.payload as { dayBook?: { tradingDay: string; kind: string; components: Record<string, number> } }).dayBook)
    .filter((d): d is { tradingDay: string; kind: string; components: Record<string, number> } => d !== undefined && (d.kind === 'sale' || d.kind === 'sale_return'));
  const out: AnnualMonthInput[] = [];
  for (const period of year.periods) {
    const m = await ledger.month(t, period, turnover);
    const p = parseMonthlyPeriod(period);
    let turnoverMinor = 0;
    let taxMinor = 0;
    const posted = new Set<string>();
    for (const j of journals) {
      if (j.tradingDay < p.from || j.tradingDay > p.to) continue;
      posted.add(j.tradingDay);
      const sign = j.kind === 'sale' ? 1 : -1;
      turnoverMinor += sign * (j.components['net'] ?? 0);
      taxMinor += sign * ((j.components['cgst'] ?? 0) + (j.components['sgst'] ?? 0) + (j.components['igst'] ?? 0));
    }
    const { sold, returned } = await ledger.tillLines(t, p.from, p.to);
    const traded = new Set([...sold, ...returned].map((l) => l.tradingDay));
    out.push({
      period, ...(m.lock !== undefined ? { lock: m.lock } : {}),
      gstr3bFiled: recorded.some((f) => f.type === 'GSTR3B' && f.period === period),
      current: m.current.figures, amendmentsOut: m.amendmentsOut,
      reverseCharge: { liability: m.reverseCharge.liability, itcPaid: m.reverseCharge.itcPaid },
      itc: m.itc,
      books: posted.size === 0 ? null : { turnoverMinor, taxMinor },
      daysNotInBooks: [...traded].filter((d) => !posted.has(d)).sort(),
    });
  }
  return out;
}

/**
 * A19 on a timer: the same raise the `raise-owner-exceptions` route runs, for the ops-alert worker's `alsoEachPass` hook
 * (`services/api/src/main.ts`), so a return near the bar reaches the owners without anyone pressing anything. Answers
 * how many alerts it newly raised. Wired into the worker through `alsoEachPassOf` (ops-alert-sweeps.ts).
 */
export function gstTimeBarSweep(input: { readonly store: EventStore; readonly now: () => string; readonly timeZone?: (tenantId: string) => Promise<string> }) {
  const ledger = r3GstLedger(input);
  return async (tenantId: string, at: string): Promise<number> => {
    const today = await ledger.today(tenantId);
    const periods = await ledger.monthlyPeriods(tenantId, today);
    const facts = await ledger.facts(tenantId);
    const cal = buildFilingCalendar({ today, monthlyPeriods: periods, financialYears: financialYearsOf(periods), facts, nearBarDays: (await ledger.controls(tenantId)).timeBarWarningDays.value });
    return (await raiseTimeBarAlerts(input.store, input.now, tenantId, cal.ownerExceptions, facts, 'system:gst-time-bar', at)).raised;
  };
}

const TIME_BAR_ALERT = 'gst-time-bar:';

/**
 * A19: raise every return near or past the 3-year bar into EACH owner's alert inbox (once per return — a re-raise of an
 * open alert is the same condition), and clear an alert whose return is now filed (kept, never deleted). The ops-alert
 * worker delivers an open alert to its owners' inboxes and, when a message provider is set, their phones.
 */
async function raiseTimeBarAlerts(store: EventStore, now: () => string, t: string, raise: readonly CalendarEntry[], filed: readonly FilingFact[], by: string, at: string) {
  const lifecycle = alertLifecycleAdapter({ store, now });
  const owners = [...new Set((await effectiveGrants(store, t)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
  const live = await lifecycle.alerts(t);
  let raised = 0;
  let alreadyOpen = 0;
  let cleared = 0;
  if (owners.length > 0) {
    for (const e of raise) {
      const alertId = `${TIME_BAR_ALERT}${e.type}:${e.period}`;
      const current = live.find((a) => a.alert.alertId === alertId);
      if (current !== undefined && current.state !== 'cleared') { alreadyOpen += 1; continue; }
      const event: AlertLifecycleEvent = {
        alertId, change: 'raised', by, at,
        alert: {
          alertId, component: `GST ${e.type} ${e.period}`, status: e.warning === 'time_barred' ? 'down' : 'degraded',
          ownerUserId: owners[0]!, ownerName: owners[0]!, detail: e.detail, raisedAt: at,
          ackDueBy: e.warning === 'time_barred' ? at : `${e.timeBarDate}T00:00:00Z`,
          ...(owners.length > 1 ? { alsoToUserIds: owners.slice(1) } : {}),
        },
      };
      await lifecycle.recordAlertEvent(t, event, `${alertId}|${e.warning}|${current?.clearedAt ?? 'first'}`);
      raised += 1;
    }
  }
  const isFiled = new Set(filed.filter((f) => f.filedOn !== undefined).map((f) => `${TIME_BAR_ALERT}${f.type}:${f.period}`));
  for (const a of live) {
    if (!a.alert.alertId.startsWith(TIME_BAR_ALERT) || a.state === 'cleared' || !isFiled.has(a.alert.alertId)) continue;
    await lifecycle.recordAlertEvent(t, { alertId: a.alert.alertId, change: 'cleared', by, at, detail: 'the return is now filed' }, `${a.alert.alertId}|cleared|${at}`);
    cleared += 1;
  }
  return { raised, alreadyOpen, cleared, owners: owners.length };
}
