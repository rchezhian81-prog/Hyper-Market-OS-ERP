// R3 lane 2 — input credit, TDS, refunds and customer rights (A17, A24, C14, C5, A23 remainder). Head-office wiring only;
// the rules live in the packages (`packages/input-tax`, `packages/withholding`, `packages/payment-disputes`,
// `packages/returns/src/refund-channel.ts`, `packages/customer/src/nomination.ts`). Every register is append-only on its
// own stream (hard rules #2, #6); reads fold the streams. `r3TaxPayRoutes` is the lane's one registration in main.ts; the
// `…Hooks` functions are spread into the existing registrations they extend (supplier payments, desk refunds, transfers).

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { makeItcForPeriod, type BookedInvoice, type ItcLineAction, type ItcReversal, type ItcForPeriod } from '../../../packages/input-tax/src/index';
import { taxOfLines } from '../../purchase/src/index';
import { itcStoreRoutes, loadItcReview, type ItcStoreDeps, type StoredStatement } from '../../finance/src/itc-store';
import { STREAM, streamName, supplierMasterAdapter } from './adapters';

const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

/** Canonical JSON (keys sorted) — so the same file uploaded twice has one fingerprint however its keys were ordered. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// ── A17 · input tax credit through GSTR-2B + IMS ───────────────────────────────────────────────────────────────────

const ITC_STREAM = streamName(STREAM.finance, 'itc-gstr2b');

/**
 * The shop's booked supplier invoices as the ITC match reads them: every live captured invoice, its supplier's GSTIN from
 * the supplier master (the latest version), the supplier's own invoice number and date as captured, the GST its lines
 * charge, and whether it has passed the three-way match (its latest match recorded and clear). Purchase lines carry no
 * cess, so cess is 0.
 */
export async function bookedInvoicesFor(store: EventStore, now: () => string, tenantId: string): Promise<readonly BookedInvoice[]> {
  const m = supplierMasterAdapter({ store, now });
  const [invoices, matches, records] = await Promise.all([m.invoices(tenantId), m.latestMatches(tenantId), m.records(tenantId)]);
  const gstinOf = new Map(records.map((r) => [r.supplierId, r.gstin]));
  return invoices.map((inv): BookedInvoice => {
    const tax = taxOfLines(inv.lines);
    return {
      invoiceId: inv.invoiceId, supplierId: inv.supplierId, supplierGstin: gstinOf.get(inv.supplierId) ?? null,
      supplierInvoiceNo: inv.supplierInvoiceNo ?? null, supplierInvoiceDate: inv.supplierInvoiceDate ?? null,
      igstMinor: tax.igstMinor, cgstMinor: tax.cgstMinor, sgstMinor: tax.sgstMinor, cessMinor: 0,
      // Received and agreed: the latest three-way match is recorded and NOT blocked (goods short or price over is not yet
      // a bill the shop holds in full — s.16(2)(b)).
      threeWayMatched: matches.get(inv.invoiceId)?.blocked === false,
    };
  });
}

export function itcStoreAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<ItcStoreDeps, 'recordAudit'> {
  const { store, now } = input;
  return {
    now,
    fingerprint: (raw) => sha(canonical(raw)).slice(0, 32),
    statements: async (tenantId) => {
      const latest = new Map<string, StoredStatement>();
      for (const s of await all<StoredStatement>(store, tenantId, ITC_STREAM, 'Gstr2bUploaded')) latest.set(s.statement.period, s);
      return [...latest.values()];
    },
    recordStatement: async (tenantId, s) => {
      await store.append(tenantId, ITC_STREAM, makeEvent({
        id: `gstr2b-${s.statement.period}-${s.fingerprint}`, type: 'Gstr2bUploaded', occurredAt: s.uploadedAt,
        // One fact per month and file: the same file again collapses; a different file is a new, later fact.
        idempotencyKey: `gstr2b-${tenantId}-${s.statement.period}-${s.fingerprint}`, source: 'api/finance', payload: s,
      }));
    },
    booked: (tenantId) => bookedInvoicesFor(store, now, tenantId),
    actions: (tenantId) => all<ItcLineAction>(store, tenantId, ITC_STREAM, 'ItcLineActioned'),
    recordAction: async (tenantId, a) => {
      const key = sha(`${a.period}|${a.lineId}|${a.action}|${a.by}|${a.at}`).slice(0, 32);
      await store.append(tenantId, ITC_STREAM, makeEvent({
        id: `itc-action-${key}`, type: 'ItcLineActioned', occurredAt: a.at,
        idempotencyKey: `itc-action-${tenantId}-${key}`, source: 'api/finance', payload: a,
      }));
    },
    reversals: (tenantId) => all<ItcReversal>(store, tenantId, ITC_STREAM, 'ItcReversalRecorded'),
    recordReversal: async (tenantId, r) => {
      const res = await store.append(tenantId, ITC_STREAM, makeEvent({
        id: `itc-reversal-${r.reversalId}-${sha(r.at).slice(0, 8)}`, type: 'ItcReversalRecorded', occurredAt: r.at,
        idempotencyKey: `itc-reversal-${tenantId}-${r.reversalId}`, source: 'api/finance', payload: r,
      }));
      return res.record.event.payload as ItcReversal;
    },
  };
}

/**
 * **The port for GSTR-3B Table 4** — `itcForPeriod(tenantId, period)` (period YYYY-MM): `{ status: 'reconciled', igstMinor,
 * cgstMinor, sgstMinor, cessMinor }` summing the ACCEPTED 2B lines of the month, or `{ status: 'not_reconciled', reason }`
 * while no 2B is uploaded or any line awaits a person. Never a silent zero (P-08).
 */
export function itcForPeriodAdapter(input: { readonly store: EventStore; readonly now: () => string }): ItcForPeriod {
  const deps = itcStoreAdapter(input);
  return makeItcForPeriod((tenantId, period) => loadItcReview(deps, tenantId, period));
}

// ── the lane's routes, registered once in main.ts ───────────────────────────────────────────────────────────────────

export function r3TaxPayRoutes(input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): readonly Route[] {
  const { store, now } = input;
  const audit = input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit };
  const none = <T>(v: T) => () => v;
  return [
    ...itcStoreRoutes(store === undefined
      ? { statements: none([]), recordStatement: () => {}, booked: none([]), actions: none([]), recordAction: () => {}, reversals: none([]), recordReversal: (_t, r) => r, fingerprint: (raw) => sha(canonical(raw)).slice(0, 32), now }
      : { ...itcStoreAdapter({ store, now }), ...audit }),
  ];
}
