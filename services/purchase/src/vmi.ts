// API-03 Vendor-managed inventory (D03-FR-04 · M24 supplier portal · §28 · §35 · P-05). The engine is `packages/purchasing/src/vmi.ts`.
//
//   Buyer side (head office):
//   • POST /v1/purchase/vmi/limits/:supplierId/:storeId/:productId — the buyer sets an item's minimum and maximum at a store
//     for this supplier ({ minQty, maxQty, uom }), or takes it off ({ clear: true, reason }). Append-only; the latest stands.
//   • GET  /v1/purchase/vmi/:supplierId — the supplier's VMI items, each with on hand, on order and the room left, and its
//     proposals. "Not set" (no item yet) is said, never an empty list read as nothing to do.
//   • GET  /v1/purchase/vmi-proposals — every proposal waiting for a buyer (and, ?all=true, the decided ones).
//   • POST /v1/purchase/vmi-proposals/:proposalId/decide — { decision: accept | reject, reason, poId?, lines?: [{ productId,
//     unitCost }], blanketAgreementId? }. Accepted: the proposal is judged AGAIN against the stock now (a change since is a
//     visible refusal, never a silent order — hard rule #10), then raised as a purchase-order PROPOSAL by this buyer through
//     the ordinary purchase-order route (its supplier, range, scope and limit checks all apply), which a second person still
//     issues. The supplier sets no price. Rejected: kept with the reason; nothing is ordered.
//
//   Supplier side (the portal — the partner is the login's binding, never the request):
//   • GET  /v1/supplier-portal/me/vmi — ITS OWN items only: the limits, on hand, on order, room; and its proposals.
//   • POST /v1/supplier-portal/me/vmi/proposals/:proposalId — { storeId, lines: [{ productId, quantity }], note? }. Judged
//     against the buyer's limits; a line for an item that is not the supplier's is refused AND recorded (a security event).
//
// Every record is append-only (hard rules #2, #6). Nothing a supplier sends commits anything (P-05, §28).

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { auditPartnerAction, type PartnerAuditEntry } from '../../../packages/supplier-portal/src/index';
import { limitsInForce, readLimit, positionOf, judgeVmiProposal, type VmiLimit, type VmiPosition, type VmiLineJudgement } from '../../../packages/purchasing/src/vmi';

export interface VmiProposal {
  readonly proposalId: string;
  readonly supplierId: string;
  readonly storeId: string;
  readonly lines: readonly { readonly productId: string; readonly quantity: number }[];
  readonly note: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  /** How each line stood against the limits when it was proposed. */
  readonly judged: readonly VmiLineJudgement[];
}

export interface VmiDecision {
  readonly proposalId: string;
  readonly decision: 'accepted' | 'rejected';
  readonly reason: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** The purchase-order proposal an acceptance raised. */
  readonly poId: string | null;
}

export interface VmiDeps {
  readonly limits: (tenantId: string) => Promise<readonly VmiLimit[]>;
  readonly recordLimit: (tenantId: string, limit: VmiLimit) => Promise<void>;
  readonly proposals: (tenantId: string) => Promise<readonly VmiProposal[]>;
  readonly recordProposal: (tenantId: string, proposal: VmiProposal) => Promise<void>;
  readonly decisions: (tenantId: string) => Promise<readonly VmiDecision[]>;
  readonly recordDecision: (tenantId: string, decision: VmiDecision) => Promise<void>;
  /** The supplier a portal login is bound to (the buyer binds it) — never read from a request. */
  readonly partnerForUser: (tenantId: string, userId: string) => Promise<string | undefined>;
  readonly supplierKnown: (tenantId: string, supplierId: string) => Promise<boolean>;
  readonly storeKnown: (tenantId: string, storeId: string) => Promise<boolean>;
  readonly productKnown: (tenantId: string, productId: string) => Promise<boolean>;
  /** On hand at the store (its back stores included) and still on order from this supplier for it there. */
  readonly stockOf: (tenantId: string, supplierId: string, storeId: string, productId: string) => Promise<{ readonly onHand: number; readonly onOrder: number; readonly asAt: string }>;
  /** Raise a purchase-order proposal through the ordinary purchase-order route, as the deciding buyer. */
  readonly proposePurchaseOrder: (ctx: RequestContext, poId: string, body: Record<string, unknown>) => Promise<HandlerResult>;
  readonly recordPartnerAudit: (tenantId: string, entry: PartnerAuditEntry, key: string) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const bodyOf = (b: unknown): Record<string, unknown> => (b !== null && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
const NOT_SET = 'Not set. The buyer has set no minimum and maximum for this supplier\'s items yet, so it can propose nothing.';

export function vmiRoutes(deps: VmiDeps): readonly Route[] {
  const positionsOf = async (tenantId: string, supplierId: string, storeId?: string): Promise<{ positions: (VmiPosition & { asAt: string })[] }> => {
    const mine = limitsInForce(await deps.limits(tenantId)).filter((l) => l.supplierId === supplierId && (storeId === undefined || l.storeId === storeId));
    const positions = await Promise.all(mine.map(async (l) => {
      const s = await deps.stockOf(tenantId, supplierId, l.storeId, l.productId);
      return { ...positionOf(l, s.onHand, s.onOrder), asAt: s.asAt };
    }));
    return { positions };
  };
  const statusOf = (p: VmiProposal, decisions: readonly VmiDecision[]) => {
    const d = decisions.find((x) => x.proposalId === p.proposalId);
    return { ...p, status: d === undefined ? 'awaiting_buyer' as const : d.decision, decision: d ?? null };
  };
  const partnerOf = async (ctx: RequestContext): Promise<string> => {
    const partnerId = await deps.partnerForUser(ctx.tenantId, ctx.userId);
    if (partnerId === undefined) {
      throw apiError(403, { code: 'not_a_supplier_login', whatHappened: 'This login is not bound to any supplier, so it has no items of its own to manage.', wasItSaved: 'not_saved', nextSafeAction: 'A buyer binds a login to a supplier when they configure the partner.' });
    }
    const asked = ctx.query['partnerId'];
    if (isStr(asked) && asked.trim() !== partnerId) {
      const session = { sessionId: `portal-${partnerId}`, partnerId, tenantId: ctx.tenantId, userId: ctx.userId, grants: [] };
      const detail = `session belongs to ${partnerId} and the request asked for ${asked.trim()} — refused and recorded`;
      await deps.recordPartnerAudit(ctx.tenantId, auditPartnerAction({ session, action: 'read:vmi', outcome: 'not_your_data', detail, at: deps.now() }), `${partnerId}-${ctx.userId}-read:vmi-${asked.trim()}`);
      throw apiError(403, { code: 'not_your_data', whatHappened: detail, wasItSaved: 'not_saved', nextSafeAction: 'You can only see your own items. This attempt was recorded.' });
    }
    return partnerId;
  };
  const audit = async (tenantId: string, entry: AuditEntry) => { await deps.recordAudit?.(tenantId, entry); };

  return [
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/vmi/limits/:supplierId/:storeId/:productId',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = bodyOf(ctx.body);
        const at = deps.now();
        let limit: VmiLimit;
        if (b['clear'] === true) {
          if (!isStr(b['reason'])) throw apiError(400, { code: 'clearing_needs_a_reason', whatHappened: 'Taking an item off the supplier\'s managed list needs a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Send { clear: true, reason }. Nothing was changed.' });
          limit = { supplierId, storeId, productId, minQty: null, maxQty: null, uom: isStr(b['uom']) ? b['uom'].trim() : 'ea', setBy: ctx.userId, setAt: at, reason: b['reason'].trim().slice(0, 300) };
        } else {
          const read = readLimit(b['minQty'], b['maxQty']);
          if (!read.ok || !isStr(b['uom'])) {
            throw apiError(400, { code: 'not_readable_as_a_vmi_limit', whatHappened: `A supplier-managed limit is { minQty, maxQty, uom }${read.ok ? '' : `: ${read.why}`}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the minimum, the maximum and the unit. Nothing was changed.' });
          }
          limit = { supplierId, storeId, productId, minQty: read.minQty, maxQty: read.maxQty, uom: b['uom'].trim(), setBy: ctx.userId, setAt: at };
        }
        if (!(await deps.supplierKnown(ctx.tenantId, supplierId))) throw apiError(422, { code: 'supplier_unknown', whatHappened: `${supplierId} is not an approved supplier on the supplier master.`, wasItSaved: 'not_saved', nextSafeAction: 'Approve the supplier first (two people). Nothing was changed.' });
        if (!(await deps.storeKnown(ctx.tenantId, storeId))) throw apiError(422, { code: 'unknown_store', whatHappened: `${storeId} is not a store head office knows.`, wasItSaved: 'not_saved', nextSafeAction: 'Name a store from the organisation. Nothing was changed.' });
        if (!(await deps.productKnown(ctx.tenantId, productId))) throw apiError(422, { code: 'unknown_product', whatHappened: `${productId} is not on the product master.`, wasItSaved: 'not_saved', nextSafeAction: 'Publish the product first. Nothing was changed.' });
        const before = (await deps.limits(ctx.tenantId)).filter((l) => l.supplierId === supplierId && l.storeId === storeId && l.productId === productId).at(-1);
        await deps.recordLimit(ctx.tenantId, limit);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: limit.minQty === null ? 'purchase.vmi_limit.clear' : 'purchase.vmi_limit.set', objectType: 'vmi_limit', objectId: `${supplierId}/${storeId}/${productId}`, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: before === undefined || before.minQty === null ? { limit: 'not set' } : { minQty: String(before.minQty), maxQty: String(before.maxQty) },
          after: limit.minQty === null ? { limit: 'not set' } : { minQty: String(limit.minQty), maxQty: String(limit.maxQty), uom: limit.uom },
          ...(limit.reason === undefined ? {} : { reason: limit.reason }), correlationId: `${supplierId}/${storeId}/${productId}`,
        });
        return { status: 201, body: { limit } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/purchase/vmi/:supplierId',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const { positions } = await positionsOf(ctx.tenantId, supplierId);
        const decisions = await deps.decisions(ctx.tenantId);
        const proposals = (await deps.proposals(ctx.tenantId)).filter((p) => p.supplierId === supplierId).map((p) => statusOf(p, decisions));
        return { status: 200, body: { supplierId, items: positions, ...(positions.length === 0 ? { notSet: NOT_SET } : {}), proposals, asAt: deps.now() } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/purchase/vmi-proposals',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const decisions = await deps.decisions(ctx.tenantId);
        const all = (await deps.proposals(ctx.tenantId)).map((p) => statusOf(p, decisions));
        const rows = ctx.query['all'] === 'true' ? all : all.filter((p) => p.status === 'awaiting_buyer');
        return { status: 200, body: { proposals: rows, awaiting: all.filter((p) => p.status === 'awaiting_buyer').length, asAt: deps.now() } };
      },
    },
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/vmi-proposals/:proposalId/decide',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const proposalId = (ctx.params['proposalId'] ?? '').trim();
        const b = bodyOf(ctx.body);
        const decision = b['decision'] === 'accept' ? 'accepted' as const : b['decision'] === 'reject' ? 'rejected' as const : undefined;
        if (decision === undefined || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_vmi_decision', whatHappened: 'A decision is { decision: "accept" | "reject", reason } — an acceptance also names the poId and prices the order: lines [{ productId, unitCost }] or a blanketAgreementId.', wasItSaved: 'not_saved', nextSafeAction: 'Send the decision. Nothing was decided.' });
        }
        const proposal = (await deps.proposals(ctx.tenantId)).find((p) => p.proposalId === proposalId);
        if (proposal === undefined) throw notFound(`supplier proposal ${proposalId}`);
        const prior = (await deps.decisions(ctx.tenantId)).find((d) => d.proposalId === proposalId);
        if (prior !== undefined) {
          if (prior.decision === decision) return { status: 200, body: { decision: prior, alreadyDecided: true } };
          throw apiError(409, { code: 'already_decided', whatHappened: `${prior.decidedBy} already ${prior.decision} proposal ${proposalId} at ${prior.decidedAt}.`, wasItSaved: 'not_saved', nextSafeAction: 'Read the proposal again. Nothing was changed.' });
        }
        if (proposal.proposedBy === ctx.userId) {
          throw apiError(403, { code: 'self_decision', whatHappened: `${ctx.userId} sent proposal ${proposalId} and cannot also decide it (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'A buyer decides it. Nothing was decided.' });
        }
        const at = deps.now();
        let poId: string | null = null;
        if (decision === 'accepted') {
          if (!isStr(b['poId'])) throw apiError(400, { code: 'not_readable_as_a_vmi_decision', whatHappened: 'An acceptance names the purchase order it raises (poId).', wasItSaved: 'not_saved', nextSafeAction: 'Send the poId. Nothing was decided.' });
          // Judged again on the stock as it is NOW: a sale, a delivery or a changed limit since the proposal is a visible
          // refusal, never an order past the maximum (hard rule #10).
          const { positions } = await positionsOf(ctx.tenantId, proposal.supplierId, proposal.storeId);
          const again = judgeVmiProposal({ lines: proposal.lines, positions });
          if (!again.ok) {
            throw apiError(409, { code: 'vmi_limits_changed_since', whatHappened: `Since the supplier proposed it: ${again.lines.filter((l) => !l.ok).map((l) => l.detail).join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Reject it with the reason, so the supplier can propose again. Nothing was ordered.' });
          }
          const agreementId = isStr(b['blanketAgreementId']) ? b['blanketAgreementId'].trim() : undefined;
          const costs = Array.isArray(b['lines']) ? b['lines'] as Record<string, unknown>[] : [];
          let lines: Record<string, unknown>[];
          if (agreementId !== undefined) lines = proposal.lines.map((l) => ({ productId: l.productId, orderedQty: l.quantity }));
          else {
            lines = [];
            for (const l of proposal.lines) {
              const c = costs.find((x) => x !== null && typeof x === 'object' && x['productId'] === l.productId);
              if (c === undefined || c['unitCost'] === undefined) {
                throw apiError(400, { code: 'vmi_order_needs_a_price', whatHappened: `The order for ${l.productId} needs its price — the buyer's unit cost, or a blanket agreement. The supplier never sets the price on its own proposal.`, wasItSaved: 'not_saved', nextSafeAction: 'Send lines [{ productId, unitCost }] for every item, or a blanketAgreementId. Nothing was ordered.' });
              }
              lines.push({ productId: l.productId, orderedQty: l.quantity, unitCost: c['unitCost'] });
            }
          }
          poId = b['poId'].trim();
          const res = await deps.proposePurchaseOrder(ctx, poId, {
            supplierId: proposal.supplierId, deliverToLocationId: proposal.storeId, lines, ...(agreementId === undefined ? {} : { blanketAgreementId: agreementId }),
          });
          if (res.status >= 300) return res;
        }
        const record: VmiDecision = { proposalId, decision, reason: b['reason'].trim().slice(0, 300), decidedBy: ctx.userId, decidedAt: at, poId };
        await deps.recordDecision(ctx.tenantId, record);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: `purchase.vmi_proposal.${decision === 'accepted' ? 'accept' : 'reject'}`, objectType: 'vmi_proposal', objectId: proposalId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { status: 'awaiting_buyer' },
          after: { status: decision, supplierId: proposal.supplierId, storeId: proposal.storeId, poId: poId ?? '' }, reason: record.reason, correlationId: proposalId,
        });
        return { status: 201, body: { decision: record, alreadyDecided: false } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/supplier-portal/me/vmi',
      permission: 'supplier.portal.self',
      handler: async (ctx) => {
        const partnerId = await partnerOf(ctx);
        const { positions } = await positionsOf(ctx.tenantId, partnerId);
        const decisions = await deps.decisions(ctx.tenantId);
        // The supplier sees its own proposals and the buyer's decision with the reason — never the order's prices.
        const proposals = (await deps.proposals(ctx.tenantId)).filter((p) => p.supplierId === partnerId).map((p) => {
          const s = statusOf(p, decisions);
          return { proposalId: s.proposalId, storeId: s.storeId, lines: s.lines, note: s.note, proposedAt: s.proposedAt, status: s.status, reason: s.decision?.reason ?? null, decidedAt: s.decision?.decidedAt ?? null };
        });
        return { status: 200, body: { partnerId, items: positions, ...(positions.length === 0 ? { notSet: NOT_SET } : {}), proposals, asAt: deps.now() } };
      },
    },
    {
      api: 'API-03', method: 'POST', path: '/v1/supplier-portal/me/vmi/proposals/:proposalId',
      permission: 'supplier.portal.self.submit', idempotent: true,
      handler: async (ctx) => {
        const proposalId = (ctx.params['proposalId'] ?? '').trim();
        const b = bodyOf(ctx.body);
        if (b['supplierId'] !== undefined || b['partnerId'] !== undefined) {
          throw apiError(400, { code: 'proposal_names_a_supplier', whatHappened: 'A proposal names no supplier — the supplier is the one this login belongs to.', wasItSaved: 'not_saved', nextSafeAction: 'Send { storeId, lines, note? } only. Nothing was received.' });
        }
        const lines = Array.isArray(b['lines']) ? (b['lines'] as unknown[]) : [];
        if (proposalId === '' || !isStr(b['storeId']) || lines.length === 0 || !lines.every((l) => l !== null && typeof l === 'object' && isStr((l as Record<string, unknown>)['productId']))
          || (b['note'] !== undefined && typeof b['note'] !== 'string')) {
          throw apiError(400, { code: 'not_readable_as_a_vmi_proposal', whatHappened: 'A replenishment proposal is { storeId, lines: [{ productId, quantity }], note? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store and the items with how many. Nothing was received.' });
        }
        const partnerId = await partnerOf(ctx);
        const storeId = b['storeId'].trim();
        const asked = (lines as Record<string, unknown>[]).map((l) => ({ productId: (l['productId'] as string).trim(), quantity: l['quantity'] }));
        const existing = (await deps.proposals(ctx.tenantId)).find((p) => p.proposalId === proposalId);
        if (existing !== undefined) {
          const same = existing.supplierId === partnerId && existing.storeId === storeId && JSON.stringify(existing.lines) === JSON.stringify(asked);
          if (same) return { status: 200, body: { proposal: existing, alreadyReceived: true } };
          throw apiError(409, { code: 'proposal_id_used', whatHappened: `Proposal ${proposalId} was already sent with other contents.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new proposal id. Nothing was received.' });
        }
        const { positions } = await positionsOf(ctx.tenantId, partnerId, storeId);
        const judged = judgeVmiProposal({ lines: asked, positions });
        const session = { sessionId: `portal-${partnerId}`, partnerId, tenantId: ctx.tenantId, userId: ctx.userId, grants: [] };
        if (!judged.ok) {
          const foreign = judged.lines.some((l) => l.refusal === 'not_your_item');
          const detail = judged.lines.filter((l) => !l.ok).map((l) => l.detail).join('; ');
          // Every refusal is recorded; asking for an item that is not yours is a security event (findProbing reads it).
          await deps.recordPartnerAudit(ctx.tenantId, auditPartnerAction({ session, action: 'submit:vmi_proposal', outcome: foreign ? 'not_your_data' : 'invalid', securityEvent: foreign, detail, at: deps.now() }), `${partnerId}-${proposalId}-${foreign ? 'foreign' : 'invalid'}`);
          throw apiError(foreign ? 403 : 422, { code: foreign ? 'not_your_item' : 'outside_the_agreed_limits', whatHappened: `${detail}.`, wasItSaved: 'not_saved', nextSafeAction: foreign ? 'Propose only your own items. This attempt was recorded.' : 'Propose within the room the buyer\'s maximum leaves. Nothing was received.' });
        }
        const proposal: VmiProposal = {
          proposalId, supplierId: partnerId, storeId, lines: asked.map((l) => ({ productId: l.productId, quantity: l.quantity as number })),
          note: typeof b['note'] === 'string' ? b['note'].trim().slice(0, 300) : '', proposedBy: ctx.userId, proposedAt: deps.now(), judged: judged.lines,
        };
        await deps.recordProposal(ctx.tenantId, proposal);
        await deps.recordPartnerAudit(ctx.tenantId, auditPartnerAction({ session, action: 'submit:vmi_proposal', outcome: 'accepted', detail: `${proposal.lines.length} line(s) for ${storeId}, waiting for a buyer`, at: proposal.proposedAt }), `${partnerId}-${proposalId}-accepted`);
        return { status: 201, body: { proposal, status: 'awaiting_buyer' } };
      },
    },
  ];
}
