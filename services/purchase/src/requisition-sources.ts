// API-03 WF-03 "Demand/min-max/budget → requisition → RFQ → comparison → approval → PO" (OB-288 P3): a proposal becomes a
// requisition only by a BUYER'S OWN ACT. Until now the replenishment proposals and the A02 purchase drafts were read-only and
// requisitions were typed in separately, so nothing linked the demand to the buying.
//
//   • FROM A REPLENISHMENT PROPOSAL (`POST /v1/purchase/requisitions/:id/from-replenishment`) — the buyer sends the store, the
//     planning parameters and the lines they ACCEPT. Head office works the proposal out again itself, on its own stock,
//     orders and sales (the same route the proposal screen reads), so the quantities are never the caller's; a line the
//     proposal did not suggest is refused by name. The buyer may change a quantity — that is their decision, and the
//     requisition keeps the proposed figure beside the chosen one.
//   • FROM AN A02 DRAFT (`…/from-drafts`) — the drafts name no quantity ("how many is the buyer's decision"), so the buyer
//     names product and quantity per draft. Each draft must be an A02 proposal on head office's register whose evidence is
//     about that product; the AI wrote nothing and commits nothing (hard rule #5) — the requisition is the buyer's.
//
// Either way the requisition is an ordinary one (RFQ, comparison, and a PO through the second-person approval follow), with
// its raiser and its source on the record.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { RfqDeps, StoredRequisition } from './rfq';

export interface ProposedLine { readonly productId: string; readonly suggestedQty: number; readonly reason: string }

export interface RequisitionSourceDeps extends Pick<RfqDeps, 'requisition' | 'recordRequisition'> {
  /** Head office's own replenishment proposal for the store (the tested engine on its own facts), as the caller may read it. */
  readonly proposalFor: (ctx: RequestContext, storeId: string, items: unknown) => Promise<{ readonly proposals: readonly ProposedLine[]; readonly asAt: string }>;
  /** An A02 purchase draft on the register: its id and the evidence references it cites; undefined when there is none. */
  readonly a02Draft: (tenantId: string, proposalId: string) => Promise<{ readonly proposalId: string; readonly references: readonly string[] } | undefined>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

async function refuseExisting(deps: RequisitionSourceDeps, tenantId: string, requisitionId: string): Promise<StoredRequisition | undefined> {
  return (await deps.requisition(tenantId, requisitionId)) as StoredRequisition | undefined;
}

export function requisitionSourceRoutes(deps: RequisitionSourceDeps): readonly Route[] {
  return [
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/requisitions/:requisitionId/from-replenishment',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const requisitionId = (ctx.params['requisitionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const accept = b['accept'];
        if (requisitionId === '' || !isStr(b['storeId']) || !isStr(b['currency']) || !isCurrencyCode(b['currency']) || !Array.isArray(b['items'])
          || !Array.isArray(accept) || accept.length === 0 || !accept.every((a) => isObj(a) && isStr(a['productId']) && (a['quantity'] === undefined || isPosInt(a['quantity'])))) {
          throw apiError(400, {
            code: 'not_readable_as_a_requisition_from_replenishment',
            whatHappened: 'Turning a replenishment proposal into a requisition needs { storeId, currency, items (the planning parameters the proposal is worked out on), accept: [{ productId, quantity? }] }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the store, the planning parameters and the lines you accept. Nothing was saved.',
          });
        }
        const existing = await refuseExisting(deps, ctx.tenantId, requisitionId);
        if (existing !== undefined) return { status: 200, body: { requisition: existing, alreadyRaised: true } };
        // Head office works the proposal out again — on its own stock, orders and sales — never the caller's figures.
        const proposal = await deps.proposalFor(ctx, (b['storeId'] as string).trim(), b['items']);
        const lines: { productId: string; quantity: number }[] = [];
        const proposed: Record<string, number> = {};
        for (const a of accept as { productId: string; quantity?: number }[]) {
          const p = proposal.proposals.find((x) => x.productId === a.productId);
          if (p === undefined || p.suggestedQty <= 0) {
            throw apiError(422, {
              code: 'not_proposed',
              whatHappened: `${a.productId} is not on today's replenishment proposal for this store${p !== undefined ? ` (${p.reason === 'held_shelf_life' ? 'held: ordering any would over-stock a perishable' : 'nothing to order'})` : ' — it is not below its reorder point'}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Accept only the lines the proposal suggests, or raise an ordinary requisition for anything else. Nothing was saved.',
            });
          }
          if (lines.some((l) => l.productId === a.productId)) {
            throw apiError(400, { code: 'line_named_twice', whatHappened: `${a.productId} is accepted twice.`, wasItSaved: 'not_saved', nextSafeAction: 'Name each line once. Nothing was saved.' });
          }
          proposed[a.productId] = p.suggestedQty;
          lines.push({ productId: a.productId, quantity: a.quantity ?? p.suggestedQty });
        }
        const req: StoredRequisition = {
          requisitionId, currency: b['currency'] as CurrencyCode, lines, raisedBy: ctx.userId, raisedAt: deps.now(),
          source: { kind: 'replenishment', storeId: (b['storeId'] as string).trim(), proposedAt: proposal.asAt, proposed },
        };
        await deps.recordRequisition(ctx.tenantId, req);
        return { status: 201, body: { requisition: req, alreadyRaised: false, changedByBuyer: lines.filter((l) => l.quantity !== proposed[l.productId]).map((l) => ({ productId: l.productId, proposed: proposed[l.productId], chosen: l.quantity })) } };
      },
    },
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/requisitions/:requisitionId/from-drafts',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const requisitionId = (ctx.params['requisitionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = b['lines'];
        if (requisitionId === '' || !isStr(b['currency']) || !isCurrencyCode(b['currency']) || !Array.isArray(lines) || lines.length === 0
          || !lines.every((l) => isObj(l) && isStr(l['proposalId']) && isStr(l['productId']) && isPosInt(l['quantity']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_requisition_from_drafts',
            whatHappened: 'Turning A02 purchase drafts into a requisition needs { currency, lines: [{ proposalId, productId, quantity (whole, above 0 — the draft names none; it is your decision) }] }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send each draft with the product and how many. Nothing was saved.',
          });
        }
        const existing = await refuseExisting(deps, ctx.tenantId, requisitionId);
        if (existing !== undefined) return { status: 200, body: { requisition: existing, alreadyRaised: true } };
        for (const l of lines as { proposalId: string; productId: string }[]) {
          const draft = await deps.a02Draft(ctx.tenantId, l.proposalId);
          if (draft === undefined) {
            throw apiError(404, { code: 'draft_unknown', whatHappened: `There is no A02 purchase draft ${l.proposalId} on head office's register.`, wasItSaved: 'not_saved', nextSafeAction: 'Run the purchase agent, or raise an ordinary requisition. Nothing was saved.' });
          }
          if (!draft.references.some((r) => r.includes(`productId=${encodeURIComponent(l.productId)}`))) {
            throw apiError(422, { code: 'draft_is_about_another_product', whatHappened: `Draft ${l.proposalId} is not about ${l.productId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Pair each draft with the product it names. Nothing was saved.' });
          }
        }
        const typed = lines as { proposalId: string; productId: string; quantity: number }[];
        if (new Set(typed.map((l) => l.productId)).size !== typed.length) {
          throw apiError(400, { code: 'line_named_twice', whatHappened: 'A product is named twice.', wasItSaved: 'not_saved', nextSafeAction: 'Name each product once. Nothing was saved.' });
        }
        const req: StoredRequisition = {
          requisitionId, currency: b['currency'] as CurrencyCode, lines: typed.map((l) => ({ productId: l.productId, quantity: l.quantity })),
          raisedBy: ctx.userId, raisedAt: deps.now(), source: { kind: 'a02_draft', proposalIds: typed.map((l) => l.proposalId) },
        };
        await deps.recordRequisition(ctx.tenantId, req);
        return { status: 201, body: { requisition: req, alreadyRaised: false } };
      },
    },
  ];
}
