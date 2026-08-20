// API-03 Purchase orders — the front door of buying (M06-FR-01/02/04). A purchase order is a
// *controlled, approved commitment*, and this is the cloud boundary that makes one durable:
//
//   • a PO is PROPOSED by a buyer (the requisitioner is the authenticated user, never a client
//     field), then ISSUED only by a SECOND person — the approver cannot be the requisitioner (§28,
//     hard rule #5). Both identities are server-attributed, so separation of duties cannot be spoofed
//     by sending someone else's name in the body. The tested `decide` (packages/approvals) builds the
//     approval and refuses a self-approval; the tested `issuePurchaseOrder` (packages/purchasing)
//     re-checks it and refuses a blocked supplier (M06-FR-01) and an empty/negative line;
//   • a blocked supplier can never be issued a PO — the block is its own append-only, latest-wins
//     record, so "this supplier is under a hold" is a fact the boundary reads, not a client claim;
//   • the OPEN COMMITMENT (M06-FR-04) — what the shop is on the hook to pay for and has not yet
//     received — is computed from the issued POs by the tested `computeOpenCommitment`. Until a PO
//     exists this figure is *not known* (see the `/commitments` route), which is a different answer
//     from zero; once POs are issued it is a real number an owner can buy against.
//
// The rules are the tested engines in `@sre/purchasing` and `@sre/approvals` (the
// `services-run-on-their-tested-engine` guardrail); this file is the persistence + HTTP skin.
// Proposing/issuing is gated distinctly (`purchase.order.propose` vs `purchase.order.approve`, the
// same split as price.change and catalogue.merge); reads are `purchase.commitment.read`. Receipt-
// and cancellation-netting of the open figure is the next increment — the engine already takes both.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  issuePurchaseOrder, computeOpenCommitment, BlockedSupplierError,
  type PurchaseOrderLineInput, type OpenCommitment,
} from '../../../packages/purchasing/src/index';
import { requestApproval, decide, type Approver } from '../../../packages/approvals/src/index';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';

/** A durable purchase order — proposed by a buyer, and (once a second person approves) issued. */
export interface StoredPurchaseOrder {
  readonly poId: string;
  readonly number: string;
  readonly supplierId: string;
  /** The buyer who raised it — the authenticated user, not a client field (§28). */
  readonly requisitionedBy: string;
  readonly at: string;
  readonly lines: readonly PurchaseOrderLineInput[];
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  readonly status: 'proposed' | 'issued';
  /** The approver, once issued — always someone other than the requisitioner (§28). */
  readonly approvedBy: string | null;
  readonly issuedAt: string | null;
}

export interface PurchaseOrderDeps {
  /** One PO by id, folded to its current state, or undefined. */
  readonly order: (tenantId: string, poId: string) => Promise<StoredPurchaseOrder | undefined> | StoredPurchaseOrder | undefined;
  /** Every PO — the buying review surface. */
  readonly all: (tenantId: string) => Promise<readonly StoredPurchaseOrder[]> | readonly StoredPurchaseOrder[];
  /** Whether this supplier is currently under a hold (latest-wins block record). */
  readonly supplierBlocked: (tenantId: string, supplierId: string) => Promise<boolean> | boolean;
  /** Record a proposed PO. Idempotent on the PO id. */
  readonly propose: (tenantId: string, po: StoredPurchaseOrder, key: string) => Promise<void> | void;
  /** Record the issue decision (the approver + reason). Idempotent on the PO id. */
  readonly issue: (tenantId: string, poId: string, approvedBy: string, issuedAt: string, reason: string, key: string) => Promise<void> | void;
  /** Set a supplier's block state. Append-only; latest wins. */
  readonly setSupplierBlocked: (tenantId: string, supplierId: string, blocked: boolean, reason: string, by: string, at: string, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isMinor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

interface RawLine { readonly productId: string; readonly orderedQty: number; readonly unitCost: { readonly minor: number; readonly currency: string }; }

const isRawLine = (v: unknown): v is RawLine =>
  isObj(v) && isStr(v['productId']) && isPosInt(v['orderedQty'])
  && isObj(v['unitCost']) && isMinor((v['unitCost'] as Record<string, unknown>)['minor'])
  && typeof (v['unitCost'] as Record<string, unknown>)['currency'] === 'string';

/** The open-commitment view an issued PO carries (M06-FR-04) — before receipt/cancellation netting. */
const openOf = (po: StoredPurchaseOrder): OpenCommitment | null =>
  po.status === 'issued' ? computeOpenCommitment(po.lines) : null;

export function purchaseOrderRoutes(deps: PurchaseOrderDeps): readonly Route[] {
  return [
    {
      // Propose a purchase order. Body: { number?, supplierId, lines[] each { productId, orderedQty,
      // unitCost{minor,currency} } }. The requisitioner is the authenticated buyer. Idempotent on the
      // PO id — a re-sent proposal returns the existing PO unchanged (hard rule #2).
      api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = b['lines'];
        if (poId === '' || !isStr(b['supplierId']) || !Array.isArray(lines) || lines.length === 0 || !lines.every(isRawLine)) {
          throw apiError(400, {
            code: 'not_readable_as_a_purchase_order',
            whatHappened: 'A purchase order needs a poId in the path and { supplierId, lines[] (each with productId, a positive whole orderedQty, and unitCost { minor, currency }) } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the supplier and at least one line with a positive quantity and a unit cost.',
          });
        }
        const currency = (lines[0] as RawLine).unitCost.currency;
        if (!isCurrencyCode(currency) || !(lines as RawLine[]).every((l) => l.unitCost.currency === currency)) {
          throw apiError(422, {
            code: 'purchase_order_currency_mismatch',
            whatHappened: `Every line on a purchase order must be priced in the same known currency (${currency}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Price all lines in one currency the system knows (e.g. INR), then send again.',
          });
        }
        // Idempotent: a re-sync of the same PO returns it unchanged rather than raising a second one.
        const existing = await deps.order(ctx.tenantId, poId);
        if (existing !== undefined) {
          return { status: 200, body: { order: existing, openCommitment: openOf(existing), alreadyProposed: true } };
        }
        const poLines: PurchaseOrderLineInput[] = (lines as RawLine[]).map((l) => ({
          productId: l.productId, orderedQty: l.orderedQty, unitCost: money(l.unitCost.minor, currency),
        }));
        const totalMinor = poLines.reduce((s, l) => s + l.unitCost.minor * l.orderedQty, 0);
        const po: StoredPurchaseOrder = {
          poId,
          number: isStr(b['number']) ? b['number'] : poId,
          supplierId: b['supplierId'],
          requisitionedBy: ctx.userId, // server-attributed — the buyer the kernel authenticated
          at: deps.now(),
          lines: poLines,
          totalMinor,
          currency,
          status: 'proposed',
          approvedBy: null,
          issuedAt: null,
        };
        await deps.propose(ctx.tenantId, po, ctx.idempotencyKey ?? poId);
        return { status: 201, body: { order: po, openCommitment: null } };
      },
    },
    {
      // Approve and issue a proposed PO — the SECOND person. Body: { reason }. §28 is enforced twice:
      // the tested `decide` refuses a self-approval, and `issuePurchaseOrder` re-checks the approver is
      // not the requisitioner. A blocked supplier is refused. Idempotent — a re-issue returns the PO.
      api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId/approval',
      permission: 'purchase.order.approve', idempotent: true,
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reason = isStr(b['reason']) ? b['reason'].trim() : '';
        const po = await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        if (po.status === 'issued') {
          return { status: 200, body: { order: po, openCommitment: openOf(po), alreadyIssued: true } };
        }
        if (reason === '') {
          throw apiError(422, {
            code: 'reason_required',
            whatHappened: 'Issuing a purchase order needs a reason for the audit trail — why this order, at this value, is approved.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "reason": "…" } and issue again. Nothing was issued.',
          });
        }
        // Build the approval server-side from the stored proposal — the value is the PO total, the
        // maker is the recorded requisitioner, and the approver is THIS authenticated user.
        const request = requestApproval({
          id: poId, subjectType: 'purchase_order', subjectRef: poId,
          requestedBy: po.requisitionedBy, value: money(po.totalMinor, po.currency),
        });
        const approver: Approver = { userId: ctx.userId, branchScope: 'all', authorityLimit: null };
        const outcome = decide(request, approver, 'approved', reason, deps.now());
        if (!outcome.ok) {
          if (outcome.refusal === 'self_approval_forbidden') {
            throw apiError(409, {
              code: 'proposer_cannot_approve',
              whatHappened: `${ctx.userId} raised this purchase order and cannot also approve it — a PO is a spend commitment and needs a second person (§28).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Have a different authorised person approve it. Nothing was issued.',
            });
          }
          throw apiError(422, {
            code: outcome.refusal,
            whatHappened: `The approval was refused: ${outcome.refusal}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Resolve the reason above and issue again. Nothing was issued.',
          });
        }
        const blocked = await deps.supplierBlocked(ctx.tenantId, po.supplierId);
        try {
          issuePurchaseOrder({
            id: po.poId, number: po.number, supplierId: po.supplierId,
            requisitionedBy: po.requisitionedBy, at: po.at, lines: po.lines,
            supplierBlocked: blocked, approval: outcome.request,
          });
        } catch (err) {
          if (err instanceof BlockedSupplierError) {
            throw apiError(409, {
              code: 'supplier_blocked',
              whatHappened: `Supplier ${po.supplierId} is under a hold and cannot be issued a purchase order (M06-FR-01).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Lift the supplier hold (with a reason) if it is resolved, then issue again. Nothing was issued.',
            });
          }
          throw err;
        }
        const issuedAt = deps.now();
        await deps.issue(ctx.tenantId, poId, ctx.userId, issuedAt, reason, ctx.idempotencyKey ?? poId);
        const issued: StoredPurchaseOrder = { ...po, status: 'issued', approvedBy: ctx.userId, issuedAt };
        return { status: 200, body: { order: issued, openCommitment: openOf(issued) } };
      },
    },
    {
      // Put a supplier under a hold, or lift it (M06-FR-01). Append-only, latest wins, reason mandatory.
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/block-status',
      permission: 'purchase.supplier.block', idempotent: true,
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const blocked = b['blocked'];
        const reason = isStr(b['reason']) ? b['reason'].trim() : '';
        if (supplierId === '' || typeof blocked !== 'boolean' || reason === '') {
          throw apiError(400, {
            code: 'not_readable_as_a_block_status',
            whatHappened: 'A supplier hold needs a supplierId in the path and { blocked: true|false, reason } in the body — a hold and its removal both need a reason for the audit trail.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "blocked": true, "reason": "…" } to hold, or { "blocked": false, "reason": "…" } to lift.',
          });
        }
        await deps.setSupplierBlocked(ctx.tenantId, supplierId, blocked, reason, ctx.userId, deps.now(),
          ctx.idempotencyKey ?? `${supplierId}-${blocked}`);
        return { status: 200, body: { supplierId, blocked } };
      },
    },
    {
      // Read one PO — its state and (once issued) its open commitment. 404 when unknown.
      api: 'API-03', method: 'GET', path: '/v1/purchase/orders/:poId',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const po = await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        return { status: 200, body: { order: po, openCommitment: openOf(po) } };
      },
    },
    {
      // Every PO — the ones still awaiting a second person's approval first (control by exception, P-03).
      api: 'API-03', method: 'GET', path: '/v1/purchase/orders',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const all = [...(await deps.all(ctx.tenantId))];
        const awaiting = all.filter((p) => p.status === 'proposed');
        const ordered = [...awaiting, ...all.filter((p) => p.status !== 'proposed')];
        return { status: 200, body: { orders: ordered, count: ordered.length, awaitingApprovalCount: awaiting.length } };
      },
    },
  ];
}
