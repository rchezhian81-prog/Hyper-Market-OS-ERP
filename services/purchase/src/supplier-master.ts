// API-03 Supplier master (SP-7c · M06-FR-01 · M23-FR-01 · M23-FR-02 · M15-FR-03 · §28 · P-03 · P-08 · hard rules #2 #4 #5).
//
// The supplier finally has ONE record and ONE balance. Until SP-7c a supplier was an id other records happened to name —
// the order's, the invoice's, the bank change's — with no master to say who they are, whether a second person has approved
// dealing with them, or which documents they hold. This file adds the master, and the three things a master exists for:
//
//   • ONBOARDING (M06-FR-01): a purchase user PROPOSES a supplier (name, GSTIN, contact, compliance documents); a DIFFERENT
//     person with the approval authority makes them ACTIVE (§28 — the proposer can never approve their own supplier). A
//     supplier whose name or GSTIN matches another is SAID as a possible duplicate, never silently accepted or refused.
//     The record is versioned and append-only; the latest version applies. The creator of a supplier can never approve
//     its bank details either (that refusal lives on the bank-details route, fed from this register);
//   • the LIST every screen reads (`GET /v1/purchase/suppliers`): each supplier the registers name — with or without a
//     master — beside its block state, its verified bank account, what it is owed (the SP-7b account) and WHY it needs a
//     person (control by exception, P-03);
//   • PAYMENT (M23-FR-01 · M06-FR-01 acceptance · M15-FR-03): a payment is a fact a second person approved, recorded once
//     and never edited. It is REFUSED — nothing recorded — for a blocked supplier, for a bank payment to a supplier with no
//     independently verified bank account, for a supplier whose account another holder shares (the duplicate-bank control),
//     for the approver being the payer, and for more than the balance owed. This service records that money went; it moves
//     none (no bank file, no gateway — those are the owner's written call).
//   • a DEBIT NOTE the account raised (SP-7b) is ISSUED under a number from the tenant's own series (M23-FR-02) by a named
//     person, once; the account then carries the number.
//
// The rules are the tested engines `isPayable` / `detectDuplicateBankAccounts` / `holdersBlockedForDuplicate`
// (`packages/bank-controls`); the account is the SP-7b projection. This file is the persistence + HTTP skin.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { isPayable, detectDuplicateBankAccounts, holdersBlockedForDuplicate, type BankAccountHolder } from '../../../packages/bank-controls/src/index';
import type { PartnerDocumentKind } from '../../../packages/supplier-portal/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  accountRegisters, foldSupplierAccount, needsAttention,
  type SupplierAccountDeps, type SupplierAccountStatement, type SupplierPayment, type DebitNoteIssue,
} from './supplier-account';

const DOCUMENT_KINDS: readonly PartnerDocumentKind[] = ['fssai_licence', 'gst_registration', 'insurance', 'trade_licence', 'bank_mandate', 'quality_certificate'];
export const PAYMENT_METHODS = Object.freeze(['bank_transfer', 'cheque', 'upi', 'cash'] as const);
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** A compliance / KYC document the supplier holds — the same shape the supplier portal's compliance check reads (M24-FR-03). */
export interface SupplierDocument {
  readonly documentId: string;
  readonly kind: PartnerDocumentKind;
  readonly reference: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly verifiedBy?: string;
  readonly verifiedAt?: string;
}

/** The supplier's master record — versioned, append-only, the latest version applies. */
export interface SupplierRecord {
  readonly supplierId: string;
  readonly name: string;
  readonly gstin: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly paymentTermsDays: number | null;
  readonly documents: readonly SupplierDocument[];
  /** `proposed` until a DIFFERENT person with the authority approves; then `active`. */
  readonly status: 'proposed' | 'active';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  /** Other suppliers sharing this name or GSTIN — SAID, never a silent acceptance or a refusal (M06-FR-01). */
  readonly possibleDuplicates: readonly string[];
  readonly version: number;
}

/** The supplier's current, independently VERIFIED bank account — folded from the bank-change ledger (never a body). */
export interface SupplierBankState {
  /** The masked / tokenised account reference the bank-details route recorded (PRV: never a raw account number). */
  readonly accountRef: string;
  readonly requestedBy: string;
  readonly verifiedBy: string;
  readonly changedAt: string;
}

export type AttentionReason =
  | 'no_master_record' | 'awaiting_approval' | 'blocked' | 'possible_duplicate' | 'duplicate_bank_account' | 'no_verified_bank_account'
  | 'unmatched_invoices' | 'blocked_invoices' | 'withheld' | 'pending_returns' | 'over_invoiced';

export interface SupplierListRow {
  readonly supplierId: string;
  readonly name: string | null;
  readonly status: 'proposed' | 'active' | 'no_master_record';
  readonly blocked: boolean;
  readonly bank: SupplierBankState | null;
  readonly totals: SupplierAccountStatement['totals'];
  readonly needsAttention: boolean;
  readonly attention: readonly AttentionReason[];
}

export interface SupplierMasterDeps extends SupplierAccountDeps {
  readonly record: (tenantId: string, supplierId: string) => Promise<SupplierRecord | undefined> | SupplierRecord | undefined;
  readonly records: (tenantId: string) => Promise<readonly SupplierRecord[]> | readonly SupplierRecord[];
  /** Append a version of the record; the latest version applies. */
  readonly recordSupplier: (tenantId: string, record: SupplierRecord) => Promise<void> | void;
  readonly supplierBlocked: (tenantId: string, supplierId: string) => Promise<boolean> | boolean;
  readonly bankState: (tenantId: string, supplierId: string) => Promise<SupplierBankState | undefined> | SupplierBankState | undefined;
  /** Every holder → account reference the tenant holds (suppliers now; employees when recorded) — the duplicate-bank control. */
  readonly bankHolders: (tenantId: string) => Promise<readonly BankAccountHolder[]> | readonly BankAccountHolder[];
  /** The permissions a named user holds; `undefined` for a name head office does not know. */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly recordPayment: (tenantId: string, payment: SupplierPayment) => Promise<void> | void;
  /** Allocate the next number in the tenant's series for a document type (`debit_note`). */
  readonly allocateNumber: (tenantId: string, docType: string) => Promise<number>;
  readonly recordDebitNoteIssue: (tenantId: string, issue: DebitNoteIssue) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isOptStr = (v: unknown): v is string | undefined | null => v === undefined || v === null || isStr(v);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isDateTime = (s: unknown): s is string => isStr(s) && !Number.isNaN(Date.parse(s));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Read the supplier's documents off the wire, or undefined when any is malformed. */
export function readSupplierDocuments(v: unknown): readonly SupplierDocument[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: SupplierDocument[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !isStr(raw['documentId']) || !DOCUMENT_KINDS.includes(raw['kind'] as PartnerDocumentKind) || !isStr(raw['reference'])
      || !isDate(raw['validFrom']) || !isDate(raw['validUntil'])
      || (raw['verifiedBy'] !== undefined && !isStr(raw['verifiedBy'])) || (raw['verifiedAt'] !== undefined && !isDateTime(raw['verifiedAt']))) {
      return undefined;
    }
    out.push({
      documentId: raw['documentId'], kind: raw['kind'] as PartnerDocumentKind, reference: raw['reference'], validFrom: raw['validFrom'], validUntil: raw['validUntil'],
      ...(isStr(raw['verifiedBy']) ? { verifiedBy: raw['verifiedBy'] } : {}),
      ...(isDateTime(raw['verifiedAt']) ? { verifiedAt: raw['verifiedAt'] } : {}),
    });
  }
  return out;
}

/** Other suppliers sharing this name (case-insensitively) or this GSTIN — the "duplicate supplier flagged" of M06-FR-01. Pure. */
export function possibleDuplicatesOf(supplierId: string, name: string, gstin: string | null, others: readonly SupplierRecord[]): readonly string[] {
  const norm = name.trim().toLowerCase();
  return others
    .filter((o) => o.supplierId !== supplierId && (o.name.trim().toLowerCase() === norm || (gstin !== null && o.gstin !== null && o.gstin.toUpperCase() === gstin.toUpperCase())))
    .map((o) => o.supplierId)
    .sort();
}

/** Why an account needs a person — every reason, so the list can say them all (P-03, P-08). Pure. */
export function attentionReasons(input: {
  readonly record: SupplierRecord | undefined;
  readonly blocked: boolean;
  readonly bank: SupplierBankState | undefined;
  readonly duplicateBank: boolean;
  readonly account: SupplierAccountStatement;
}): readonly AttentionReason[] {
  const out: AttentionReason[] = [];
  if (input.record === undefined) out.push('no_master_record');
  else if (input.record.status === 'proposed') out.push('awaiting_approval');
  if (input.record !== undefined && input.record.possibleDuplicates.length > 0) out.push('possible_duplicate');
  if (input.blocked) out.push('blocked');
  if (input.duplicateBank) out.push('duplicate_bank_account');
  if (input.bank === undefined && input.account.totals.owedMinor > 0) out.push('no_verified_bank_account');
  if (input.account.totals.unmatchedInvoices > 0) out.push('unmatched_invoices');
  if (input.account.totals.blockedInvoices > 0) out.push('blocked_invoices');
  if (input.account.totals.withheldMinor > 0) out.push('withheld');
  if (input.account.totals.pendingReturns > 0) out.push('pending_returns');
  if (input.account.invoices.some((i) => i.flags.includes('order_over_invoiced'))) out.push('over_invoiced');
  return out;
}

export function supplierMasterRoutes(deps: SupplierMasterDeps): readonly Route[] {
  const audit = async (tenantId: string, entry: AuditEntry): Promise<void> => { await deps.recordAudit?.(tenantId, entry); };

  return [
    {
      // Propose a supplier, or update its details. Body: { name, gstin?, phone?, email?, address?, paymentTermsDays?, documents? }.
      // A new record is `proposed`; an update keeps the status and is a new version. Duplicates are said, never refused.
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId',
      permission: 'purchase.supplier.manage', idempotent: true,
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const documents = readSupplierDocuments(b['documents']);
        if (supplierId === '' || !isStr(b['name']) || !isOptStr(b['gstin']) || !isOptStr(b['phone']) || !isOptStr(b['email']) || !isOptStr(b['address'])
          || !(b['paymentTermsDays'] === undefined || b['paymentTermsDays'] === null || isNonNegInt(b['paymentTermsDays'])) || documents === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_supplier',
            whatHappened: 'A supplier needs a supplierId in the path and a name; gstin, phone, email, address, paymentTermsDays (whole days) and documents ({ documentId, kind, reference, validFrom, validUntil, verifiedBy?, verifiedAt? }) are optional.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { name, … }. Nothing was saved.',
          });
        }
        const now = deps.now();
        const existing = await deps.record(ctx.tenantId, supplierId);
        const others = (await deps.records(ctx.tenantId)).filter((r) => r.supplierId !== supplierId);
        const gstin = isStr(b['gstin']) ? b['gstin'].trim().toUpperCase() : null;
        const record: SupplierRecord = {
          supplierId, name: b['name'].trim(), gstin,
          phone: isStr(b['phone']) ? b['phone'].trim() : null, email: isStr(b['email']) ? b['email'].trim() : null, address: isStr(b['address']) ? b['address'].trim() : null,
          paymentTermsDays: isNonNegInt(b['paymentTermsDays']) ? b['paymentTermsDays'] : null,
          documents,
          status: existing?.status ?? 'proposed',
          createdBy: existing?.createdBy ?? ctx.userId, createdAt: existing?.createdAt ?? now,
          updatedBy: ctx.userId, updatedAt: now,
          approvedBy: existing?.approvedBy ?? null, approvedAt: existing?.approvedAt ?? null,
          possibleDuplicates: possibleDuplicatesOf(supplierId, b['name'], gstin, others),
          version: (existing?.version ?? 0) + 1,
        };
        await deps.recordSupplier(ctx.tenantId, record);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: existing === undefined ? 'supplier.propose' : 'supplier.update', objectType: 'supplier', objectId: supplierId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: existing === undefined ? null : { name: existing.name, gstin: existing.gstin ?? '', version: String(existing.version) },
          after: { name: record.name, gstin: record.gstin ?? '', status: record.status, documents: String(record.documents.length), possibleDuplicates: record.possibleDuplicates.join(','), version: String(record.version) },
          correlationId: supplierId,
        });
        return { status: existing === undefined ? 201 : 200, body: { supplier: record, created: existing === undefined } };
      },
    },
    {
      // A DIFFERENT person with the authority approves the supplier (M06-FR-01 · §28). Body: { reason }.
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/approval',
      permission: 'purchase.supplier.approve', idempotent: true,
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (supplierId === '' || !isStr(b['reason'])) {
          throw apiError(400, { code: 'approval_needs_a_reason', whatHappened: 'Approving a supplier needs the supplierId in the path and a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Send { reason }. Nothing was changed.' });
        }
        const record = await deps.record(ctx.tenantId, supplierId);
        if (record === undefined) throw notFound(`supplier ${supplierId}`);
        if (record.status === 'active') return { status: 200, body: { supplier: record, alreadyApproved: true } };
        if (record.createdBy === ctx.userId) {
          throw apiError(422, {
            code: 'self_approval',
            whatHappened: `${ctx.userId} proposed this supplier and cannot also approve it (§28 separation of duties).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'A different person with the supplier-approval authority must approve it. Nothing was changed.',
          });
        }
        const now = deps.now();
        const approved: SupplierRecord = { ...record, status: 'active', approvedBy: ctx.userId, approvedAt: now, updatedBy: ctx.userId, updatedAt: now, version: record.version + 1 };
        await deps.recordSupplier(ctx.tenantId, approved);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'supplier.approve', objectType: 'supplier', objectId: supplierId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { status: record.status, createdBy: record.createdBy }, after: { status: 'active', version: String(approved.version) },
          reason: b['reason'].trim(), correlationId: supplierId,
        });
        return { status: 200, body: { supplier: approved, alreadyApproved: false } };
      },
    },
    {
      // Every supplier the registers name — those needing a person first (P-03) — with the master, the block, the verified bank
      // account and the balance beside each other. The list a Suppliers screen renders.
      api: 'API-03', method: 'GET', path: '/v1/purchase/suppliers',
      permission: 'supplier.view',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const [regs, records, holders] = await Promise.all([accountRegisters(deps, t), deps.records(t), deps.bankHolders(t)]);
        const duplicateBank = holdersBlockedForDuplicate(detectDuplicateBankAccounts(holders));
        const ids = [...new Set([
          ...records.map((r) => r.supplierId), ...regs.invoices.map((i) => i.supplierId), ...regs.orders.map((o) => o.supplierId), ...(regs.payments ?? []).map((p) => p.supplierId),
        ])].sort();
        const rows: SupplierListRow[] = [];
        for (const supplierId of ids) {
          const record = records.find((r) => r.supplierId === supplierId);
          const [blocked, bank] = await Promise.all([deps.supplierBlocked(t, supplierId), deps.bankState(t, supplierId)]);
          const account = foldSupplierAccount({ ...regs, supplierId });
          const attention = attentionReasons({ record, blocked, bank, duplicateBank: duplicateBank.has(supplierId), account });
          rows.push({
            supplierId, name: record?.name ?? null, status: record?.status ?? 'no_master_record', blocked, bank: bank ?? null,
            totals: account.totals, needsAttention: attention.length > 0 || needsAttention(account), attention,
          });
        }
        const first = rows.filter((r) => r.needsAttention);
        return {
          status: 200,
          body: {
            suppliers: [...first, ...rows.filter((r) => !r.needsAttention)], count: rows.length, needingAttentionCount: first.length,
            owedMinor: rows.reduce((s, r) => s + r.totals.owedMinor, 0), asAt: deps.now(),
          },
        };
      },
    },
    {
      // ONE supplier: the master record (or null, said), the block, the verified bank account, the full account statement and
      // why it needs a person. 404 for an id no register names — not known is not a zero.
      api: 'API-03', method: 'GET', path: '/v1/purchase/suppliers/:supplierId',
      permission: 'supplier.view',
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const t = ctx.tenantId;
        const [regs, record, blocked, bank, holders] = await Promise.all([accountRegisters(deps, t), deps.record(t, supplierId), deps.supplierBlocked(t, supplierId), deps.bankState(t, supplierId), deps.bankHolders(t)]);
        const known = record !== undefined || regs.invoices.some((i) => i.supplierId === supplierId) || regs.orders.some((o) => o.supplierId === supplierId) || (regs.payments ?? []).some((p) => p.supplierId === supplierId);
        if (!known) throw notFound(`supplier ${supplierId}`);
        const account = foldSupplierAccount({ ...regs, supplierId });
        const duplicateBank = holdersBlockedForDuplicate(detectDuplicateBankAccounts(holders)).has(supplierId);
        return {
          status: 200,
          body: { supplier: record ?? null, blocked, bank: bank ?? null, duplicateBankAccount: duplicateBank, account, attention: attentionReasons({ record, blocked, bank, duplicateBank, account }) },
        };
      },
    },
    {
      // Record a PAYMENT to the supplier (M23-FR-01 · M06-FR-01 · M15-FR-03 · §28). Body: { amountMinor, paidOn, method, reference,
      // approvedBy }. Refused — nothing recorded — when the supplier is blocked, when a bank payment has no independently
      // verified account to go to, when another holder shares the account, when the approver is the payer or lacks the
      // authority, or when it exceeds what is owed. Idempotent per paymentId. Records that money went; moves none.
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/payments/:paymentId',
      permission: 'purchase.supplier.pay', idempotent: true,
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const paymentId = (ctx.params['paymentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (supplierId === '' || paymentId === '' || !isPosInt(b['amountMinor']) || !isDate(b['paidOn'])
          || !(PAYMENT_METHODS as readonly unknown[]).includes(b['method']) || !isStr(b['reference']) || !isStr(b['approvedBy'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_supplier_payment',
            whatHappened: `A supplier payment needs the supplierId and paymentId in the path and { amountMinor (whole, positive), paidOn (YYYY-MM-DD), method (${PAYMENT_METHODS.join(' / ')}), reference, approvedBy }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the payment as it was made. Nothing was recorded.',
          });
        }
        const t = ctx.tenantId;
        const method = b['method'] as PaymentMethod;
        const approvedBy = b['approvedBy'].trim();
        const regs = await accountRegisters(deps, t);
        const prior = (regs.payments ?? []).find((p) => p.paymentId === paymentId);
        if (prior !== undefined) return { status: 200, body: { payment: prior, alreadyRecorded: true, owedMinor: foldSupplierAccount({ ...regs, supplierId: prior.supplierId }).totals.owedMinor } };
        if (approvedBy === ctx.userId) {
          throw apiError(422, {
            code: 'self_approval',
            whatHappened: `${ctx.userId} is recording this payment and cannot also be the person who approved it (§28 separation of duties).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Name the different person who approved the payment. Nothing was recorded.',
          });
        }
        const approverPermissions = await deps.permissionsOfUser(t, approvedBy);
        if (approverPermissions === undefined || !approverPermissions.includes('purchase.supplier.pay')) {
          throw apiError(422, {
            code: 'approver_lacks_authority',
            whatHappened: `${approvedBy} ${approverPermissions === undefined ? 'is not known here' : 'does not hold the authority to approve a supplier payment'}, so their approval does not count.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Have someone who holds purchase.supplier.pay, and who is not the payer, approve it. Nothing was recorded.',
          });
        }
        const [blocked, bank, holders] = await Promise.all([deps.supplierBlocked(t, supplierId), deps.bankState(t, supplierId), deps.bankHolders(t)]);
        if (!isPayable({ blocked })) {
          throw apiError(409, {
            code: 'supplier_blocked',
            whatHappened: `Supplier ${supplierId} is under a hold (M06-FR-01) — nothing may be paid to them until the hold is lifted.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Lift the hold (with a reason) first, or do not pay. Nothing was recorded.',
          });
        }
        if (method !== 'cash' && bank === undefined) {
          throw apiError(409, {
            code: 'no_verified_bank_account',
            whatHappened: `Supplier ${supplierId} has no independently verified bank account on record, so a ${method.replace('_', ' ')} to them cannot be recorded (M06-FR-01: an unverified bank change blocks payment).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Verify the account on the bank-details route first (a call back on a number already held, approved by a second person). Nothing was recorded.',
          });
        }
        if (holdersBlockedForDuplicate(detectDuplicateBankAccounts(holders)).has(supplierId)) {
          throw apiError(409, {
            code: 'duplicate_bank_account',
            whatHappened: `Another holder shares supplier ${supplierId}'s bank account (M15-FR-03) — payment is blocked until a person has reviewed it.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Review the duplicate-account flag on the fraud-signals report and resolve it. Nothing was recorded.',
          });
        }
        const account = foldSupplierAccount({ ...regs, supplierId });
        if (b['amountMinor'] > account.totals.owedMinor) {
          throw apiError(422, {
            code: 'payment_exceeds_balance',
            whatHappened: `Supplier ${supplierId} is owed ${account.totals.owedMinor}; a payment of ${b['amountMinor']} would pay more than the matched, netted balance.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Pay up to the balance owed, or match the invoice that justifies the rest first. Nothing was recorded.',
          });
        }
        const now = deps.now();
        const payment: SupplierPayment = {
          paymentId, supplierId, amountMinor: b['amountMinor'], currency: 'INR', paidOn: b['paidOn'], method, reference: b['reference'].trim(),
          recordedBy: ctx.userId, recordedAt: now, approvedBy, approvedAt: now,
        };
        await deps.recordPayment(t, payment);
        await audit(t, {
          actorId: ctx.userId, action: 'supplier.payment.record', objectType: 'supplier', objectId: supplierId,
          at: now, origin: { tenantId: t, branchId: ctx.branchId ?? null },
          before: { owedMinor: String(account.totals.owedMinor) },
          after: { paymentId, amountMinor: String(payment.amountMinor), method, reference: payment.reference, approvedBy, owedMinor: String(account.totals.owedMinor - payment.amountMinor) },
          correlationId: paymentId,
        });
        return { status: 201, body: { payment, alreadyRecorded: false, owedMinor: account.totals.owedMinor - payment.amountMinor } };
      },
    },
    {
      // ISSUE a debit note the account raised (SP-7b) under a number from the tenant's series (M23-FR-02), once. 404 when the
      // account holds no such note; the same again returns the number already issued.
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/debit-notes/:debitNoteRef/issue',
      permission: 'purchase.invoice.match', idempotent: true,
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const debitNoteRef = (ctx.params['debitNoteRef'] ?? '').trim();
        const t = ctx.tenantId;
        const regs = await accountRegisters(deps, t);
        const account = foldSupplierAccount({ ...regs, supplierId });
        const note = account.debitNotes.find((d) => d.debitNoteRef === debitNoteRef);
        if (note === undefined) throw notFound(`debit note ${debitNoteRef} on supplier ${supplierId}`);
        if (note.number !== null) return { status: 200, body: { debitNoteRef, number: note.number, issuedBy: note.issuedBy, issuedAt: note.issuedAt, valueMinor: note.valueMinor, alreadyIssued: true } };
        const seq = await deps.allocateNumber(t, 'debit_note');
        const now = deps.now();
        const issue: DebitNoteIssue = { debitNoteRef, supplierId, number: `DN-${String(seq).padStart(6, '0')}`, seq, valueMinor: note.valueMinor, issuedBy: ctx.userId, issuedAt: now };
        await deps.recordDebitNoteIssue(t, issue);
        await audit(t, {
          actorId: ctx.userId, action: 'supplier.debit_note.issue', objectType: 'supplier', objectId: supplierId,
          at: now, origin: { tenantId: t, branchId: ctx.branchId ?? null },
          before: null, after: { debitNoteRef, number: issue.number, valueMinor: String(issue.valueMinor), grnId: note.grnId, lineId: note.lineId },
          correlationId: debitNoteRef,
        });
        return { status: 201, body: { debitNoteRef, number: issue.number, issuedBy: issue.issuedBy, issuedAt: issue.issuedAt, valueMinor: issue.valueMinor, alreadyIssued: false } };
      },
    },
  ];
}
