// R2 gap lane 2 — payments and data protection (v2.1 addendum C6, C7, C13). Head-office wiring only; the rules live in
// the packages. Each register is append-only on its own stream (hard rules #2, #6); reads fold the streams.
//
//   • C6  — the data-processor contract register, and the EVIDENCE of who processes the shop's personal data: the enabled
//           integration adapters in a personal-data category, and the processors the shop has sent erasure notices to.
//   • C7  — the declaration of every personal-data field in the code and how it is protected (sealed / masked / never
//           kept / held by the identity server), checked against the sealing policy that really runs.
//   • C13 — the till's card/UPI refunds, by the reference of the capture they reverse, for the T+1 settlement review.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { ProcessorContractEntry, ProcessingActivity } from '../../../packages/customer/src/processor-register';
import type { PiiFieldDeclaration, SealedFieldsByEvent } from '../../../packages/customer/src/pii-safeguards';
import type { AdapterCategory, AdapterConfig } from '../../../packages/integration/src/adapters';
import type { PosRefund } from '../../../packages/settlement/src/settlement';
import type { ProcessorRegisterDeps } from '../../customer/src/processor-register';
import { STREAM, streamName, PERSONAL_DATA_POLICY } from './adapters';

const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

// ── C6 · the data-processor contract register ─────────────────────────────────────────────────────────────────────

const PROCESSOR_CONTRACTS = streamName(STREAM.privacy, 'processor-contracts');
const PROCESSOR_NOTICES = streamName(STREAM.privacy, 'processor-notices');

/**
 * Integration categories whose adapters carry the shop's personal data to a vendor: payments (the cardholder's token and
 * UPI handle), messaging (the customer's number and the words sent), logistics (the delivery address), accounting and the
 * tax portal (a buyer's name and GSTIN on an invoice). Hardware (scanners, printers, scales) does not. Written in one place
 * so the owner can narrow or widen it.
 */
export const PERSONAL_DATA_ADAPTER_CATEGORIES: readonly AdapterCategory[] = Object.freeze(['payment', 'messaging', 'logistics', 'accounting', 'tax_portal']);

export function processorRegisterAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<ProcessorRegisterDeps, 'recordAudit'> {
  return {
    now: input.now,
    entries: (tenantId) => all<ProcessorContractEntry>(input.store, tenantId, PROCESSOR_CONTRACTS, 'ProcessorContractRecorded'),
    recordEntry: async (tenantId, entry) => {
      // One fact per (vendor, contract, dates, categories): the same entry sent twice collapses; a change is a new fact.
      const fact = `${entry.vendorId}|${entry.contractRef}|${entry.contractFrom}|${entry.contractUntil ?? ''}|${entry.dataCategories.join(',')}|${entry.purpose}`;
      const d = createHash('sha256').update(fact).digest('hex').slice(0, 32);
      await input.store.append(tenantId, PROCESSOR_CONTRACTS, makeEvent({
        id: `processor-contract-${entry.vendorId}-${entry.recordedAt}`, type: 'ProcessorContractRecorded', occurredAt: entry.recordedAt,
        idempotencyKey: `processor-contract-${tenantId}-${d}`, source: 'api/customer', payload: entry,
      }));
    },
    activities: async (tenantId): Promise<readonly ProcessingActivity[]> => {
      const out: ProcessingActivity[] = [];
      // The integration adapters as registered — the latest configuration per adapter, enabled, in a personal-data category.
      const latest = new Map<string, AdapterConfig>();
      for (const c of await all<AdapterConfig>(input.store, tenantId, STREAM.integration, 'IntegrationAdapterRegistered')) latest.set(c.adapterId, c);
      for (const c of [...latest.values()].sort((a, b) => a.adapterId.localeCompare(b.adapterId))) {
        if (c.enabled && PERSONAL_DATA_ADAPTER_CATEGORIES.includes(c.category)) {
          out.push({ vendorName: c.vendor, seenIn: `integration-adapter:${c.adapterId}`, dataCategories: [] });
        }
      }
      // The processors the shop has told to erase a customer's data — it shared that data with them.
      const byProcessor = new Map<string, Set<string>>();
      for (const m of await all<{ readonly payload?: { readonly processorId?: unknown; readonly categories?: unknown } }>(input.store, tenantId, PROCESSOR_NOTICES, 'ProcessorNoticeEnqueued')) {
        const id = m.payload?.processorId;
        if (typeof id !== 'string' || id === '') continue;
        const cats = byProcessor.get(id) ?? new Set<string>();
        if (Array.isArray(m.payload?.categories)) for (const c of m.payload.categories) if (typeof c === 'string') cats.add(c);
        byProcessor.set(id, cats);
      }
      for (const [id, cats] of [...byProcessor.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        out.push({ vendorName: id, vendorId: id, seenIn: `erasure-notice:${id}`, dataCategories: [...cats].sort() });
      }
      return out;
    },
  };
}

// ── C7 · every personal-data field in the code, and how it is protected ───────────────────────────────────────────

/** The sealing policy that really runs (ADR-0025), as the C7 check reads it. */
export const SEALED_FIELDS: SealedFieldsByEvent = PERSONAL_DATA_POLICY;

/**
 * Every field in `packages/`, `services/` and `edge/` whose name says it holds a person's details, and how it is
 * protected. The guardrail `tests/guardrails/personal-data-is-sealed-or-masked.test.ts` finds every such field in the
 * source and fails when one is not declared here — a new field cannot arrive unprotected and unnoticed.
 */
export const PII_FIELD_INVENTORY: readonly PiiFieldDeclaration[] = Object.freeze([
  // Customers
  { file: 'services/customer/src/loyalty-members.ts', field: 'mobileLast4', whose: 'customer', protection: 'sealed_per_subject', evidence: 'LoyaltyMember' },
  { file: 'services/customer/src/customer-360.ts', field: 'mobileLast4', whose: 'customer', protection: 'sealed_per_subject', evidence: 'LoyaltyMember' },
  { file: 'services/purchase/src/data-export.ts', field: 'mobileLast4', whose: 'customer', protection: 'sealed_per_subject', evidence: 'LoyaltyMember' },
  { file: 'services/customer/src/duplicates.ts', field: 'phone', whose: 'customer', protection: 'not_kept', evidence: 'the duplicate-detection route reads the candidates in the request and keeps only the match it proposes' },
  { file: 'services/customer/src/duplicates.ts', field: 'email', whose: 'customer', protection: 'not_kept', evidence: 'the duplicate-detection route reads the candidates in the request and keeps only the match it proposes' },
  { file: 'services/customer/src/index.ts', field: 'dateOfBirth', whose: 'customer', protection: 'not_kept', evidence: 'the child-data route computes an age from it for one decision and keeps the decision only' },
  { file: 'services/platform/src/outbound-webhooks.ts', field: 'address', whose: 'shop', protection: 'not_personal', evidence: 'the network address a partner webhook is sent to — not a person' },
  { file: 'packages/customer/src/matching.ts', field: 'phone', whose: 'customer', protection: 'not_kept', evidence: 'duplicate detection reads the candidates in the request and keeps only the match it proposes' },
  { file: 'packages/customer/src/matching.ts', field: 'email', whose: 'customer', protection: 'not_kept', evidence: 'duplicate detection reads the candidates in the request and keeps only the match it proposes' },
  { file: 'packages/customer/src/child-data-guard.ts', field: 'dateOfBirth', whose: 'customer', protection: 'not_kept', evidence: 'the child-data check computes an age from it for one decision and keeps the decision only' },
  { file: 'services/orders/src/index.ts', field: 'contact', whose: 'customer', protection: 'not_personal', evidence: 'how staff reached the customer and a call-log or message id a person can check — a reference, not the number' },
  { file: 'packages/migration/src/synthetic.ts', field: 'phone', whose: 'customer', protection: 'not_personal', evidence: 'the synthetic legacy dataset — invented numbers for rehearsals, no real person' },
  { file: 'packages/migration/src/loyalty-verification.ts', field: 'customerName', whose: 'customer', protection: 'not_kept', evidence: 'the loyalty witness reads balances in the request; the witness record keeps counts only' },
  // Staff and users
  { file: 'packages/payroll/src/mask.ts', field: 'bankAccount', whose: 'staff', protection: 'masked_on_read', evidence: 'maskBankAccount' },
  { file: 'packages/payroll/src/mask.ts', field: 'uan', whose: 'staff', protection: 'masked_on_read', evidence: 'maskUan' },
  { file: 'packages/payroll/src/mask.ts', field: 'aadhaar', whose: 'staff', protection: 'masked_on_read', evidence: 'maskAadhaar' },
  { file: 'packages/payroll/src/bank-file.ts', field: 'accountNumber', whose: 'staff', protection: 'not_kept', evidence: 'the salary bank file is built from the request and handed back; it is never stored' },
  { file: 'packages/payroll/src/bank-file.ts', field: 'ifsc', whose: 'staff', protection: 'not_kept', evidence: 'the salary bank file is built from the request and handed back; it is never stored' },
  { file: 'packages/identity/src/account.ts', field: 'fullName', whose: 'user', protection: 'held_by_identity_server', evidence: 'people and their contacts live at the identity server (ADR-0019); this is the policy shape only' },
  { file: 'packages/identity/src/account.ts', field: 'contact', whose: 'user', protection: 'held_by_identity_server', evidence: 'people and their contacts live at the identity server (ADR-0019); this is the policy shape only' },
  { file: 'packages/identity/src/otp.ts', field: 'phoneNumber', whose: 'user', protection: 'held_by_identity_server', evidence: 'one-time codes are the identity server\'s; no challenge is stored by head office' },
  { file: 'packages/identity/src/oidc-port.ts', field: 'email', whose: 'user', protection: 'held_by_identity_server', evidence: 'a claim read from the signed token for one request' },
  { file: 'packages/identity/src/oidc-port.ts', field: 'phoneNumber', whose: 'user', protection: 'held_by_identity_server', evidence: 'a claim read from the signed token for one request' },
  { file: 'packages/identity/src/access-binding.ts', field: 'email', whose: 'user', protection: 'held_by_identity_server', evidence: 'a claim read from the signed token for one request' },
  { file: 'packages/identity/src/access-binding.ts', field: 'phoneNumber', whose: 'user', protection: 'held_by_identity_server', evidence: 'a claim read from the signed token for one request' },
  // The shop's own details
  { file: 'packages/receipt/src/presets.ts', field: 'phone', whose: 'shop', protection: 'not_personal', evidence: 'the shop\'s own number, printed on its bill' },
  // Suppliers' contact details — kept in the supplier master as typed. Whether a supplier's contact is personal data (a
  // sole proprietor's own mobile is) is an owner decision; until it is made they are declared UNPROTECTED, and the C7
  // check reports them as such rather than passing quietly.
  { file: 'services/purchase/src/supplier-master.ts', field: 'phone', whose: 'supplier_contact', protection: 'unprotected', evidence: 'the supplier master keeps it as typed', awaitingDecision: 'the owner\'s decision on supplier contact details (C7)' },
  { file: 'services/purchase/src/supplier-master.ts', field: 'email', whose: 'supplier_contact', protection: 'unprotected', evidence: 'the supplier master keeps it as typed', awaitingDecision: 'the owner\'s decision on supplier contact details (C7)' },
  { file: 'services/purchase/src/supplier-master.ts', field: 'address', whose: 'supplier_contact', protection: 'unprotected', evidence: 'the supplier master keeps it as typed', awaitingDecision: 'the owner\'s decision on supplier contact details (C7)' },
  { file: 'services/purchase/src/data-export.ts', field: 'phone', whose: 'supplier_contact', protection: 'unprotected', evidence: 'the owner\'s export of the supplier master (P-06) carries it as kept', awaitingDecision: 'the owner\'s decision on supplier contact details (C7)' },
  { file: 'services/purchase/src/data-export.ts', field: 'email', whose: 'supplier_contact', protection: 'unprotected', evidence: 'the owner\'s export of the supplier master (P-06) carries it as kept', awaitingDecision: 'the owner\'s decision on supplier contact details (C7)' },
  { file: 'services/purchase/src/data-export.ts', field: 'address', whose: 'supplier_contact', protection: 'unprotected', evidence: 'the owner\'s export of the supplier master (P-06) carries it as kept', awaitingDecision: 'the owner\'s decision on supplier contact details (C7)' },
]);

// ── C13 · the till's card/UPI refunds, for the T+1 settlement review ──────────────────────────────────────────────

const ELECTRONIC = new Set(['card', 'upi']);

/**
 * The refunds the till gave back to a card or UPI tender in `[fromIso, toIso)`, each by the reference of the capture it
 * reverses (the original bill's tender of the same kind). A refund whose bill or tender reference cannot be found is
 * still returned — keyed `bill:<saleId>` — so it surfaces as an unmatched refund for a person, never vanishes (P-08).
 */
export function settlementRefundsAdapter(input: { readonly store: EventStore }) {
  return {
    electronicRefunds: async (tenantId: string, fromIso: string, toIso: string): Promise<readonly PosRefund[]> => {
      const returns = await input.store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', from: fromIso, to: toIso });
      const out: PosRefund[] = [];
      for (const e of returns) {
        const r = e.event.payload as { readonly returnId: string; readonly originalSaleId: string | null; readonly refundMinor: number; readonly refundTender: string; readonly processedAt: string };
        if (!ELECTRONIC.has(r.refundTender) || !(r.refundMinor > 0)) continue;
        let originalRef = r.originalSaleId === null ? `bill:none:${r.returnId}` : `bill:${r.originalSaleId}`;
        if (r.originalSaleId !== null) {
          const held = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${r.originalSaleId}`);
          const tenders = (held?.event.payload as { readonly tenders?: readonly { readonly kind: string; readonly ref?: string }[] } | undefined)?.tenders ?? [];
          const ref = tenders.find((t) => t.kind === r.refundTender && typeof t.ref === 'string' && t.ref.trim() !== '')?.ref;
          if (ref !== undefined) originalRef = ref;
        }
        out.push({ id: r.returnId, originalRef, amountMinor: r.refundMinor, refundedOn: r.processedAt.slice(0, 10) });
      }
      return out;
    },
  };
}
