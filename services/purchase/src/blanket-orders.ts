// API-03 Blanket purchase orders (M06-FR-02 "Requisition, RFQ, quotation comparison, PO, blanket PO and approvals").
//
// A blanket PO is a standing AGREEMENT with one supplier — products at agreed prices, a value ceiling, optional quantity
// ceilings, a validity window — and it commits no money by itself. This file is the persistence + HTTP skin over the tested
// `@sre/purchasing` blanket engine:
//
//   • PROPOSE (`POST /v1/purchase/blanket-orders/:agreementId`, a buyer) — refused by name for an unknown or unapproved
//     supplier (OB-32), a store that is not an open place in the hierarchy (OB-37), a discontinued or clearance product
//     (D-16), or terms that do not hold together. The proposer is the signed-in buyer, never a field.
//   • APPROVE (`…/approval`, a second person) — never the proposer (§28), with a reason; the approver's value limit comes
//     from the M02-FR-02 seam when the system holds one (package P1), else none, as for any purchase order.
//   • CALL OFF — a release is an ordinary purchase order naming `blanketAgreementId` (`POST /v1/purchase/orders/:poId`),
//     judged against the agreement when proposed and again when a second person issues it (purchase-orders.ts).
//   • READ — each agreement with its DRAWDOWN: issued, waiting, remaining, per product, and its releases.
//
// Append-only: an agreement is proposed once (a re-send returns it), approved once; nothing is edited or deleted.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  agreementProblems, blanketDrawdown,
  type BlanketAgreement, type BlanketLine, type BlanketRelease,
} from '../../../packages/purchasing/src/index';
import { requestApproval, decide, type Approver } from '../../../packages/approvals/src/index';
import { mayApproveValue, authorityWords } from '../../../packages/approvals/src/authority-rules';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import { normaliseUom } from '../../../packages/contracts/src/quantity';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { requireApprovedSupplier, requireDeliverTo, type PurchaseOrderDeps, type AuthorityOf } from './purchase-orders';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

export interface BlanketOrderDeps extends Pick<PurchaseOrderDeps, 'supplierStatus' | 'orgLocation' | 'locationBranches' | 'productUom' | 'masterLifecycle'> {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  readonly agreement: (tenantId: string, agreementId: string) => Promise<BlanketAgreement | undefined> | BlanketAgreement | undefined;
  readonly agreements: (tenantId: string) => Promise<readonly BlanketAgreement[]> | readonly BlanketAgreement[];
  /** Every release raised against an agreement (the purchase orders that name it), with each one's state. */
  readonly releases: (tenantId: string, agreementId: string) => Promise<readonly (BlanketRelease & { readonly number: string; readonly requisitionedBy: string; readonly approvedBy: string | null })[]>;
  /** Record a proposed agreement — idempotent on its id. */
  readonly recordProposed: (tenantId: string, agreement: BlanketAgreement) => Promise<void> | void;
  /** Record the approval — once; a second approval of the same agreement collapses. */
  readonly recordApproved: (tenantId: string, agreementId: string, approvedBy: string, approvedAt: string, reason: string) => Promise<void> | void;
  readonly supplierBlocked: (tenantId: string, supplierId: string) => Promise<boolean> | boolean;
  readonly authorityOf?: AuthorityOf;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const PROBLEM_WORDS: Readonly<Record<string, string>> = {
  no_lines: 'it names no products', bad_ceiling: 'the ceiling must be a whole amount above 0',
  bad_dates: 'the validity dates must be real dates (YYYY-MM-DD)', ends_before_it_starts: 'it ends before it starts',
  duplicate_product: 'a product is named twice', bad_line: 'a line needs a productId, a whole agreed cost and (if given) a whole quantity ceiling above 0',
  currency_mismatch: 'every agreed cost must be in the agreement\'s currency',
};

interface RawTerm { productId: string; agreedUnitCost: { minor: number; currency: string; per?: number }; maxQty?: number }
const isRawTerm = (v: unknown): v is RawTerm => isObj(v) && isStr(v['productId']) && isObj(v['agreedUnitCost'])
  && isNonNegInt((v['agreedUnitCost'] as Record<string, unknown>)['minor']) && typeof (v['agreedUnitCost'] as Record<string, unknown>)['currency'] === 'string'
  && (v['maxQty'] === undefined || isPosInt(v['maxQty']));

/** The agreement as every read presents it: its drawdown and its releases beside it. */
async function presented(deps: BlanketOrderDeps, tenantId: string, a: BlanketAgreement) {
  const releases = await deps.releases(tenantId, a.agreementId);
  const today = await shopToday(deps, tenantId); // R1c: the shop's today
  return {
    agreement: a, drawdown: blanketDrawdown(a, releases),
    validToday: a.status === 'approved' && today >= a.validFrom && today <= a.validTo,
    expired: today > a.validTo,
    releases: releases.map((r) => ({ poId: r.poId, number: r.number, status: r.status, requisitionedBy: r.requisitionedBy, approvedBy: r.approvedBy })),
  };
}

export function blanketOrderRoutes(deps: BlanketOrderDeps): readonly Route[] {
  return [
    {
      // Propose a standing agreement. Body: { supplierId, currency, ceilingMinor, validFrom, validTo, deliverToLocationId?,
      // lines[] each { productId, agreedUnitCost { minor, currency, per? }, maxQty? } }. Idempotent on the agreement id.
      api: 'API-03', method: 'POST', path: '/v1/purchase/blanket-orders/:agreementId',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const agreementId = (ctx.params['agreementId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = b['lines'];
        if (agreementId === '' || !isStr(b['supplierId']) || !isStr(b['currency']) || !isCurrencyCode(b['currency']) || !isPosInt(b['ceilingMinor'])
          || !isStr(b['validFrom']) || !isStr(b['validTo']) || !Array.isArray(lines) || lines.length === 0 || !lines.every(isRawTerm)) {
          throw apiError(400, {
            code: 'not_readable_as_a_blanket_agreement',
            whatHappened: 'A blanket agreement needs the agreementId in the path and { supplierId, currency, ceilingMinor (whole, above 0), validFrom, validTo (YYYY-MM-DD), lines[] (each { productId, agreedUnitCost { minor, currency }, maxQty? }) }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the supplier, the products at their agreed prices, the ceiling and the validity window. Nothing was saved.',
          });
        }
        const existing = await deps.agreement(ctx.tenantId, agreementId);
        if (existing !== undefined) return { status: 200, body: { ...(await presented(deps, ctx.tenantId, existing)), alreadyProposed: true } };
        const currency = b['currency'] as CurrencyCode;
        const terms: BlanketLine[] = [];
        for (const l of lines as RawTerm[]) {
          const master = deps.productUom === undefined ? undefined : await deps.productUom(ctx.tenantId, l.productId);
          const uom = master === undefined ? undefined : normaliseUom(master) ?? master;
          const per = l.agreedUnitCost.per;
          terms.push({
            productId: l.productId.trim(),
            // A cost in another currency is kept as sent, so the engine refuses it by name (`currency_mismatch`).
            agreedUnitCost: { minor: l.agreedUnitCost.minor, currency: l.agreedUnitCost.currency as CurrencyCode, ...(per === undefined ? {} : { per }) },
            ...(uom === undefined ? {} : { uom }), ...(l.maxQty === undefined ? {} : { maxQty: l.maxQty }),
          });
        }
        const problems = agreementProblems({ currency, ceilingMinor: b['ceilingMinor'] as number, validFrom: b['validFrom'] as string, validTo: b['validTo'] as string, lines: terms });
        if (problems.length > 0) {
          throw apiError(422, {
            code: `agreement_${problems[0]}`,
            whatHappened: `This blanket agreement cannot be recorded: ${problems.map((p) => PROBLEM_WORDS[p] ?? p).join('; ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the terms and propose it again. Nothing was saved.',
          });
        }
        await requireApprovedSupplier(deps, ctx.tenantId, b['supplierId'] as string);
        // D-16 (R3): a discontinued or clearance product is never put on a standing order either.
        for (const t of terms) {
          const lifecycle = deps.masterLifecycle === undefined ? undefined : await deps.masterLifecycle(ctx.tenantId, t.productId);
          if (lifecycle === 'discontinued' || lifecycle === 'clearance') {
            throw apiError(422, {
              code: 'product_lifecycle_stops_ordering',
              whatHappened: `${t.productId} is marked ${lifecycle} on the product master, so it cannot be put on a standing agreement (D-16).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Take the product off the agreement. Nothing was saved.',
            });
          }
        }
        const deliverToLocationId = b['deliverToLocationId'] === undefined ? undefined : await requireDeliverTo(deps, ctx, b['deliverToLocationId']);
        const agreement: BlanketAgreement = {
          agreementId, supplierId: (b['supplierId'] as string).trim(), currency, ceilingMinor: b['ceilingMinor'] as number,
          validFrom: b['validFrom'] as string, validTo: b['validTo'] as string, lines: terms,
          proposedBy: ctx.userId, proposedAt: deps.now(), status: 'proposed', approvedBy: null, approvedAt: null,
          ...(deliverToLocationId === undefined ? {} : { deliverToLocationId }),
        };
        await deps.recordProposed(ctx.tenantId, agreement);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'purchase.blanket.propose', objectType: 'blanket-agreement', objectId: agreementId,
          at: agreement.proposedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { supplierId: agreement.supplierId, ceilingMinor: String(agreement.ceilingMinor), validFrom: agreement.validFrom, validTo: agreement.validTo, lineCount: String(terms.length) },
          correlationId: agreementId,
        });
        return { status: 201, body: { ...(await presented(deps, ctx.tenantId, agreement)), alreadyProposed: false } };
      },
    },
    {
      // A second person approves the agreement (never its proposer, §28). Body: { reason }. Idempotent — approved once.
      api: 'API-03', method: 'POST', path: '/v1/purchase/blanket-orders/:agreementId/approval',
      permission: 'purchase.order.approve', idempotent: true,
      handler: async (ctx) => {
        const agreementId = (ctx.params['agreementId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reason = isStr(b['reason']) ? b['reason'].trim() : '';
        const a = await deps.agreement(ctx.tenantId, agreementId);
        if (a === undefined) throw notFound(`blanket agreement ${agreementId}`);
        if (a.status === 'approved') return { status: 200, body: { ...(await presented(deps, ctx.tenantId, a)), alreadyApproved: true } };
        if (reason === '') {
          throw apiError(422, { code: 'reason_required', whatHappened: 'Approving a standing agreement needs a reason for the audit trail.', wasItSaved: 'not_saved', nextSafeAction: 'Send { "reason": "…" }. Nothing was approved.' });
        }
        // M02-FR-02 · OB-290: the approver's server-held authority for a standing agreement. The owner's rules hold money limits
        // for refunds, purchase orders and stock adjustments only, so an agreement is not money-limited there (each release
        // is a purchase order, judged against the issuer's PO limit when it is issued).
        const authority = deps.authorityOf === undefined ? undefined : await deps.authorityOf(ctx.tenantId, ctx.userId, 'blanket_agreement');
        if (authority !== undefined && ctx.userId !== a.proposedBy && !mayApproveValue(authority, a.ceilingMinor)) {
          throw apiError(422, { code: 'above_your_limit_goes_to_owner', whatHappened: `This standing agreement's ceiling is above ${ctx.userId}'s limit (${authorityWords(authority)}).`, wasItSaved: 'not_saved', nextSafeAction: 'The owner approves it. Nothing was approved.' });
        }
        const approver: Approver = { userId: ctx.userId, branchScope: 'all', authorityLimit: null };
        const outcome = decide(requestApproval({ id: agreementId, subjectType: 'blanket_agreement', subjectRef: agreementId, requestedBy: a.proposedBy, value: money(a.ceilingMinor, a.currency) }), approver, 'approved', reason, deps.now());
        if (!outcome.ok) {
          throw apiError(outcome.refusal === 'self_approval_forbidden' ? 409 : 422, {
            code: outcome.refusal === 'self_approval_forbidden' ? 'proposer_cannot_approve' : outcome.refusal,
            whatHappened: outcome.refusal === 'self_approval_forbidden'
              ? `${ctx.userId} proposed this standing agreement and cannot also approve it — it needs a second person (§28).`
              : `The approval was refused: ${outcome.refusal}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Have a different authorised person approve it. Nothing was approved.',
          });
        }
        await requireApprovedSupplier(deps, ctx.tenantId, a.supplierId);
        if (await deps.supplierBlocked(ctx.tenantId, a.supplierId)) {
          throw apiError(409, { code: 'supplier_blocked', whatHappened: `Supplier ${a.supplierId} is under a hold, so a standing agreement with them cannot be approved (M06-FR-01).`, wasItSaved: 'not_saved', nextSafeAction: 'Lift the hold (with a reason) if it is resolved, then approve again. Nothing was approved.' });
        }
        const at = deps.now();
        await deps.recordApproved(ctx.tenantId, agreementId, ctx.userId, at, reason);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'purchase.blanket.approve', objectType: 'blanket-agreement', objectId: agreementId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { status: 'proposed' }, after: { status: 'approved', reason },
          correlationId: agreementId,
        });
        return { status: 200, body: { ...(await presented(deps, ctx.tenantId, { ...a, status: 'approved', approvedBy: ctx.userId, approvedAt: at })), alreadyApproved: false } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/purchase/blanket-orders/:agreementId',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const agreementId = (ctx.params['agreementId'] ?? '').trim();
        const a = await deps.agreement(ctx.tenantId, agreementId);
        if (a === undefined) throw notFound(`blanket agreement ${agreementId}`);
        return { status: 200, body: await presented(deps, ctx.tenantId, a) };
      },
    },
    {
      // Every standing agreement, the ones waiting for a second person first (control by exception, P-03).
      api: 'API-03', method: 'GET', path: '/v1/purchase/blanket-orders',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const all = await deps.agreements(ctx.tenantId);
        const rows = await Promise.all(all.map((a) => presented(deps, ctx.tenantId, a)));
        rows.sort((x, y) => (x.agreement.status === y.agreement.status ? x.agreement.agreementId.localeCompare(y.agreement.agreementId) : x.agreement.status === 'proposed' ? -1 : 1));
        return { status: 200, body: { agreements: rows, count: rows.length, awaitingApprovalCount: rows.filter((r) => r.agreement.status === 'proposed').length, asAt: deps.now() } };
      },
    },
  ];
}
