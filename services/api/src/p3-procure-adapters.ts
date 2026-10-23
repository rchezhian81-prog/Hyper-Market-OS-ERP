// OB-288 package P3 — procure-to-pay completion. Head office's wiring for M06-FR-02 (blanket POs, separation of duties
// across one purchase, the value-limit seam), M06-FR-03 (rebate basis folded from the registers, rebate receipts as
// journals), M06-FR-04 (the open-commitment report), M07-FR-01 (the durable dock diary, receiving against a stored ASN),
// M07-FR-04 (landed cost into stock value), WF-03 (a proposal becomes a requisition by a buyer's own act) and WF-05 (the
// Tally voucher file of the payables journals).
//
// Every register here is append-only on its own stream (hard rules #2, #6); reads fold the streams. Nothing here edits or
// deletes a record, and nothing here commits money, stock or a price by itself — each write is a person's act through a
// route, or a compensating event a person's match caused (P-05). One entry point, `p3ProcureRoutes`, is registered from
// main.ts; the hooks below are spread into the existing routes' deps there.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import {
  STREAM, streamName, foldPurchaseOrders, purchaseOrdersAdapter, orgStructureAdapter,
} from './adapters';
import { masterLifecycleOf } from './r3-ops-adapters';
import { branchOfLocationIn, type LocationBranches } from '../../inventory/src/location-scope';
import {
  judgeCallOff, type BlanketAgreement, type BlanketRelease,
} from '../../../packages/purchasing/src/index';
import type { BlanketReleaseHooks, StoredPurchaseOrder } from '../../purchase/src/purchase-orders';
import { blanketOrderRoutes, type BlanketOrderDeps } from '../../purchase/src/blanket-orders';
import { tallyExportRoutes, type TallyExportDeps, type TallyLedgerNames, type ExportableJournal } from '../../finance/src/tally-export';
import type { JournalEntry } from '../../finance/src/index';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
interface Base { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }

/** Every payload of one type in a stream, oldest first (the type goes to the store, not to a filter afterwards). */
async function payloads<T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<readonly T[]> {
  return (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
}

const locationBranches = (input: Base): LocationBranches =>
  async (tenantId) => branchOfLocationIn(await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId));

// ── M06-FR-02 — blanket agreements and their call-off releases ──────────────────────────────────────────────────────

/** The purchase-order register's stream (the same one `purchaseOrdersAdapter` writes). */
const PURCHASE_ORDERS = streamName(STREAM.purchase, 'orders');
const BLANKET_AGREEMENTS = streamName(STREAM.purchase, 'blanket-agreements');
/** One write guard per agreement: every release proposed or issued against it moves it (two at once: one lands). */
export const blanketGuardKey = (agreementId: string): string => `blanket-agreement:${agreementId}`;

/** Each agreement at its current state: proposed once (the first proposal of an id stands), approved once. */
export async function foldBlanketAgreements(store: EventStore, tenantId: string): Promise<Map<string, BlanketAgreement>> {
  const byId = new Map<string, BlanketAgreement>();
  for (const e of await store.readStream(tenantId, BLANKET_AGREEMENTS)) {
    if (e.event.type === 'BlanketAgreementProposed') {
      const a = e.event.payload as unknown as BlanketAgreement;
      if (!byId.has(a.agreementId)) byId.set(a.agreementId, a);
    } else if (e.event.type === 'BlanketAgreementApproved') {
      const p = e.event.payload as { agreementId: string; approvedBy: string; approvedAt: string };
      const cur = byId.get(p.agreementId);
      if (cur !== undefined && cur.status === 'proposed') byId.set(p.agreementId, { ...cur, status: 'approved', approvedBy: p.approvedBy, approvedAt: p.approvedAt });
    }
  }
  return byId;
}

const asRelease = (po: StoredPurchaseOrder): BlanketRelease & { readonly number: string; readonly requisitionedBy: string; readonly approvedBy: string | null } => ({
  poId: po.poId, number: po.number, status: po.status, lines: po.lines, cancelledByProduct: po.cancelledByProduct,
  requisitionedBy: po.requisitionedBy, approvedBy: po.approvedBy,
});

async function releasesOf(store: EventStore, tenantId: string, agreementId: string) {
  return [...(await foldPurchaseOrders(store, tenantId)).values()].filter((p) => p.blanketAgreementId === agreementId).map(asRelease);
}

export function blanketAgreementsAdapter(input: Base): BlanketOrderDeps {
  const pos = purchaseOrdersAdapter(input);
  return {
    now: input.now,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    ...(pos.supplierStatus === undefined ? {} : { supplierStatus: pos.supplierStatus }),
    ...(pos.orgLocation === undefined ? {} : { orgLocation: pos.orgLocation }),
    ...(pos.productUom === undefined ? {} : { productUom: pos.productUom }),
    supplierBlocked: pos.supplierBlocked,
    locationBranches: locationBranches(input),
    masterLifecycle: masterLifecycleOf(input),
    agreement: async (tenantId, agreementId) => (await foldBlanketAgreements(input.store, tenantId)).get(agreementId),
    agreements: async (tenantId) => [...(await foldBlanketAgreements(input.store, tenantId)).values()],
    releases: (tenantId, agreementId) => releasesOf(input.store, tenantId, agreementId),
    recordProposed: async (tenantId, a) => {
      await input.store.append(tenantId, BLANKET_AGREEMENTS, makeEvent({
        id: `blanket-${a.agreementId}-proposed`, type: 'BlanketAgreementProposed', occurredAt: a.proposedAt,
        idempotencyKey: `blanket-${tenantId}-${a.agreementId}-proposed`, source: 'api/purchase', payload: a as unknown as Record<string, unknown>,
      }));
    },
    recordApproved: async (tenantId, agreementId, approvedBy, approvedAt, reason) => {
      await input.store.append(tenantId, BLANKET_AGREEMENTS, makeEvent({
        id: `blanket-${agreementId}-approved`, type: 'BlanketAgreementApproved', occurredAt: approvedAt,
        // Once per agreement: a second approval collapses (the route already answers `alreadyApproved`).
        idempotencyKey: `blanket-${tenantId}-${agreementId}-approved`, source: 'api/purchase', payload: { agreementId, approvedBy, approvedAt, reason },
      }));
    },
  };
}

const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  agreement_not_approved: 409, outside_validity: 409, ceiling_exceeded: 409, quantity_ceiling_exceeded: 409,
  product_not_on_agreement: 422, no_lines: 400, bad_quantity: 400,
};

/** The call-off side the purchase-order routes run: judge (guard read first), propose and issue under the guard. */
export function blanketReleaseHooks(input: Base): BlanketReleaseHooks {
  return {
    judge: async (tenantId, j) => {
      const key = blanketGuardKey(j.agreementId);
      // The guard first, then the agreement and the releases it protects — anything landing in between refuses the write.
      const expectedVersion = await input.store.guardVersion(tenantId, key);
      const agreement = (await foldBlanketAgreements(input.store, tenantId)).get(j.agreementId);
      if (agreement === undefined) return { ok: false, status: 404, code: 'blanket_agreement_unknown', detail: `There is no blanket agreement ${j.agreementId} on head office's register` };
      if (j.supplierId !== undefined && j.supplierId !== agreement.supplierId) {
        return { ok: false, status: 422, code: 'supplier_not_the_agreements', detail: `Blanket agreement ${j.agreementId} is with ${agreement.supplierId}, not ${j.supplierId}` };
      }
      const others = (await releasesOf(input.store, tenantId, j.agreementId)).filter((r) => r.poId !== j.poId);
      const judged = judgeCallOff({ agreement, others, onDate: j.onDate, lines: j.lines });
      if (!judged.ok) return { ok: false, status: REFUSAL_STATUS[judged.refusal] ?? 422, code: judged.refusal, detail: judged.detail };
      return {
        ok: true, supplierId: agreement.supplierId, currency: agreement.currency, lines: judged.lines,
        ...(agreement.deliverToLocationId === undefined ? {} : { deliverToLocationId: agreement.deliverToLocationId }),
        guard: { key, expectedVersion },
      };
    },
    propose: async (tenantId, po, guard) => {
      // The same event the ordinary proposal writes (same id and key), under the agreement's guard.
      await input.store.appendBatch(tenantId, [{ stream: PURCHASE_ORDERS, event: makeEvent({
        id: `po-${po.poId}-proposed`, type: 'PurchaseOrderProposed', occurredAt: input.now(),
        idempotencyKey: `po-${tenantId}-${po.poId}-proposed`, source: 'api/purchase', payload: po as unknown as Record<string, unknown>,
      }) }], { guard });
    },
    issue: async (tenantId, poId, approvedBy, issuedAt, reason, guard, budgetGuard) => {
      await input.store.appendBatch(tenantId, [{ stream: PURCHASE_ORDERS, event: makeEvent({
        id: `po-${poId}-issued`, type: 'PurchaseOrderIssued', occurredAt: issuedAt,
        idempotencyKey: `po-${tenantId}-${poId}-issued`, source: 'api/purchase', payload: { poId, approvedBy, issuedAt, reason },
      }) }], { guard, ...(budgetGuard === undefined ? {} : { alsoGuards: [budgetGuard] }) });
    },
  };
}

// ── WF-05 — the payables journals as a Tally import file ─────────────────────────────────────────────────────────────

const TALLY_LEDGER_NAMES = streamName(STREAM.finance, 'tally-ledger-names');

export function tallyExportAdapter(input: Base): TallyExportDeps {
  return {
    now: input.now,
    ledgerNames: async (tenantId) => (await payloads<TallyLedgerNames>(input.store, tenantId, TALLY_LEDGER_NAMES, 'TallyLedgerNamesSet')).at(-1),
    recordLedgerNames: async (tenantId, names) => {
      await input.store.append(tenantId, TALLY_LEDGER_NAMES, makeEvent({
        id: `tally-ledger-names-v${names.version}`, type: 'TallyLedgerNamesSet', occurredAt: names.setAt,
        idempotencyKey: `tally-ledger-names-${tenantId}-v${names.version}`, source: 'api/finance', payload: names as unknown as Record<string, unknown>,
      }));
    },
    // The payables vouchers on the ledger — the same `JournalPosted` events the payables reconciliation reads.
    payablesJournals: async (tenantId) => (await payloads<JournalEntry & Partial<ExportableJournal>>(input.store, tenantId, STREAM.finance, 'JournalPosted'))
      .filter((j): j is ExportableJournal => 'payables' in j && j.payables !== undefined),
  };
}

// ── the entry point ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Every P3 route on head office's surface. With no store, an in-memory one (the bare surface the guardrails build). */
export function p3ProcureRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder }): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  const base: Base = { store, now: input.now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) };
  return [
    ...blanketOrderRoutes(blanketAgreementsAdapter(base)),
    ...tallyExportRoutes(tallyExportAdapter(base)),
  ];
}

/** The hooks the existing purchase-order routes take (spread into their deps in main.ts). */
export function p3PurchaseOrderHooks(input: { readonly store: EventStore; readonly now: () => string }): Pick<import('../../purchase/src/purchase-orders').PurchaseOrderDeps, 'blanket'> {
  return { blanket: blanketReleaseHooks(input) };
}
