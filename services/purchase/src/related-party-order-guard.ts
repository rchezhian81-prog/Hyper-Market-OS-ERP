// API-03 A RELATED-PARTY SUPPLIER needs the OWNER'S approval before a purchase order (M15-FR-03 · OB-301, owner,
// 23 Oct 2026, in writing: "a supplier matching that list by GSTIN, phone or bank account needs the owner's approval
// before a purchase order").
//
// The guard stands in front of the ONE step that commits the shop to buying — ISSUING the order
// (`POST /v1/purchase/orders/:poId/approval`). Proposing an order is still allowed (it commits nothing), and the
// proposer is told at once that it will need the owner. At the issue step:
//
//   • the supplier's facts (GSTIN, phone, current verified bank account) are matched against the owner's related-party
//     list (`packages/loss-prevention/src/related-party.ts`);
//   • no match → the order goes through exactly as before;
//   • a match → the order is issued only when the OWNER has approved it: either he is the one issuing it now (his
//     written reason is his approval, recorded), or he approved THIS order for THESE facts beforehand
//     (`POST /v1/purchase/orders/:poId/related-party-approval`). An approval is for the match's fingerprint: if the
//     supplier's GSTIN, phone or account, or the list's matching entries, changed since, it no longer covers the order.
//
// The refusal is 409 `related_party_needs_owner`, nothing saved, sealed on the audit trail. It says WHICH fact matched
// (GSTIN / phone / bank account) — never the related person's name or relation, which are the owner's to read.
// The owner raising the order himself does not deadlock it: he approves it with the approval route, and the usual
// second person issues it (§28: nobody issues their own order).

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { matchSupplier, matchFingerprint, type RelatedParty, type SupplierFacts, type RelatedPartyMatch } from '../../../packages/loss-prevention/src/related-party';
import type { StoredPurchaseOrder } from './purchase-orders';

/** The owner's approval of one order with a related-party supplier, for the facts it matched on. */
export interface RelatedPartyOrderApproval {
  readonly poId: string;
  readonly supplierId: string;
  readonly fingerprint: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly at: string;
  /** How the approval was given: beforehand on the approval route, or by the owner issuing the order himself. */
  readonly via: 'approval_route' | 'owner_issued';
}

export interface RelatedPartyOrderGuardDeps {
  readonly order: (tenantId: string, poId: string) => Promise<StoredPurchaseOrder | undefined> | StoredPurchaseOrder | undefined;
  readonly supplierFacts: (tenantId: string, supplierId: string) => Promise<SupplierFacts>;
  readonly relatedParties: (tenantId: string) => Promise<readonly RelatedParty[]>;
  readonly approvals: (tenantId: string, poId: string) => Promise<readonly RelatedPartyOrderApproval[]>;
  readonly recordApproval: (tenantId: string, approval: RelatedPartyOrderApproval) => Promise<void>;
  /** Does this person hold the owner's role now (from head office's own grants, never a body)? */
  readonly isOwner: (tenantId: string, userId: string) => Promise<boolean>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

export const RELATED_PARTY_GUARDED_ROUTES = Object.freeze({
  propose: { method: 'POST', path: '/v1/purchase/orders/:poId' },
  issue: { method: 'POST', path: '/v1/purchase/orders/:poId/approval' },
} as const);

const ON_WORDS: Readonly<Record<RelatedPartyMatch['on'], string>> = { gstin: 'GSTIN', phone: 'phone number', bank_account: 'bank account' };
/** Which facts matched, in words a non-owner may read (never the person's name or relation). */
export const matchedFactsWords = (m: readonly RelatedPartyMatch[]): string => [...new Set(m.map((x) => ON_WORDS[x.on]))].join(', ');

/** The supplier's current match and its fingerprint. */
export async function relatedPartyPosition(deps: Pick<RelatedPartyOrderGuardDeps, 'supplierFacts' | 'relatedParties'>, tenantId: string, supplierId: string): Promise<{ readonly matches: readonly RelatedPartyMatch[]; readonly fingerprint: string }> {
  const facts = await deps.supplierFacts(tenantId, supplierId);
  const matches = matchSupplier(facts, await deps.relatedParties(tenantId));
  return { matches, fingerprint: matchFingerprint(facts, matches) };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The owner's approval route for one order (owner only — checked on the server from his grants). */
export function relatedPartyApprovalRoutes(deps: RelatedPartyOrderGuardDeps): readonly Route[] {
  return [
    {
      // Body: { reason } — his written approval. Only the owner. The approval names the facts it was given for.
      api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId/related-party-approval',
      permission: 'purchase.relatedparty.approve', idempotent: true,
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const reason = isStr((ctx.body as { reason?: unknown } | null)?.reason) ? ((ctx.body as { reason: string }).reason).trim() : '';
        const po = poId === '' ? undefined : await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        if (!(await deps.isOwner(ctx.tenantId, ctx.userId))) {
          throw apiError(403, { code: 'owner_only', whatHappened: 'Only the owner approves an order with a related party (OB-301).', wasItSaved: 'not_saved', nextSafeAction: 'Ask the owner. Nothing was approved.' });
        }
        if (reason === '') {
          throw apiError(422, { code: 'reason_required', whatHappened: 'The owner\'s approval of a related-party order is written: say why this order is approved.', wasItSaved: 'not_saved', nextSafeAction: 'Write the reason and approve again. Nothing was approved.' });
        }
        const pos = await relatedPartyPosition(deps, ctx.tenantId, po.supplierId);
        if (pos.matches.length === 0) {
          return { status: 200, body: { poId, needed: false, detail: `Supplier ${po.supplierId} matches nothing on the related-party list now; this order needs no related-party approval.` } };
        }
        const prior = (await deps.approvals(ctx.tenantId, poId)).find((a) => a.fingerprint === pos.fingerprint);
        if (prior !== undefined) return { status: 200, body: { poId, needed: true, approval: prior, alreadyApproved: true } };
        const approval: RelatedPartyOrderApproval = { poId, supplierId: po.supplierId, fingerprint: pos.fingerprint, approvedBy: ctx.userId, reason, at: deps.now(), via: 'approval_route' };
        await deps.recordApproval(ctx.tenantId, approval);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'purchase.order.related_party_approved', objectType: 'purchase-order', objectId: poId, at: approval.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { supplierId: po.supplierId, matchedOn: matchedFactsWords(pos.matches), via: approval.via }, reason, correlationId: poId,
        });
        return { status: 201, body: { poId, needed: true, approval } };
      },
    },
    {
      // Whether an order needs the owner's related-party approval, and whether it has it — for any buyer or approver.
      // Names the matched FACTS only, never the related person.
      api: 'API-03', method: 'GET', path: '/v1/purchase/orders/:poId/related-party',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const po = poId === '' ? undefined : await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        const pos = await relatedPartyPosition(deps, ctx.tenantId, po.supplierId);
        const approval = (await deps.approvals(ctx.tenantId, poId)).find((a) => a.fingerprint === pos.fingerprint) ?? null;
        return { status: 200, body: { poId, supplierId: po.supplierId, needed: pos.matches.length > 0, matchedOn: pos.matches.length === 0 ? null : matchedFactsWords(pos.matches), approved: approval !== null, approval } };
      },
    },
  ];
}

/** Wrap the issue step (and tell the proposer). Throws when a guarded route is missing (a guard that guards nothing). */
export function withRelatedPartyOrderGuard(routes: readonly Route[], deps: RelatedPartyOrderGuardDeps): Route[] {
  const out = [...routes];
  const at = (m: string, p: string): number => {
    const i = out.findIndex((r) => r.method === m && r.path === p);
    if (i < 0) throw new Error(`the related-party order guard cannot find ${m} ${p} — the owner's approval would silently not be asked for`);
    return i;
  };
  const issueAt = at(RELATED_PARTY_GUARDED_ROUTES.issue.method, RELATED_PARTY_GUARDED_ROUTES.issue.path);
  const issue = out[issueAt]!;
  out[issueAt] = {
    ...issue,
    handler: async (ctx: RequestContext): Promise<HandlerResult> => {
      const poId = (ctx.params['poId'] ?? '').trim();
      const po = poId === '' ? undefined : await deps.order(ctx.tenantId, poId);
      if (po === undefined || po.status === 'issued') return issue.handler(ctx); // 404 / an issued order: the route answers
      const pos = await relatedPartyPosition(deps, ctx.tenantId, po.supplierId);
      if (pos.matches.length === 0) return issue.handler(ctx);
      const approved = (await deps.approvals(ctx.tenantId, poId)).find((a) => a.fingerprint === pos.fingerprint);
      if (approved !== undefined) return issue.handler(ctx);
      if (await deps.isOwner(ctx.tenantId, ctx.userId)) {
        // The owner issuing it himself: his issue (with its written reason) is his approval — recorded once it issues.
        const res = await issue.handler(ctx);
        if (res.status < 300 && (res.body as { alreadyIssued?: boolean } | null)?.alreadyIssued !== true) {
          const reason = isStr((ctx.body as { reason?: unknown } | null)?.reason) ? ((ctx.body as { reason: string }).reason).trim() : 'issued by the owner';
          await deps.recordApproval(ctx.tenantId, { poId, supplierId: po.supplierId, fingerprint: pos.fingerprint, approvedBy: ctx.userId, reason, at: deps.now(), via: 'owner_issued' });
        }
        return res;
      }
      await deps.recordAudit?.(ctx.tenantId, {
        actorId: ctx.userId, action: 'purchase.order.refused_related_party', objectType: 'purchase-order', objectId: poId, at: deps.now(),
        origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
        after: { supplierId: po.supplierId, matchedOn: matchedFactsWords(pos.matches), outcome: 'refused' }, reason: 'OB-301: a related-party supplier needs the owner\'s approval', correlationId: poId,
      });
      throw apiError(409, {
        code: 'related_party_needs_owner',
        whatHappened: `Supplier ${po.supplierId}'s ${matchedFactsWords(pos.matches)} matches an entry on the owner's related-party list. An order with a related party is issued only with the owner's written approval (OB-301).`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Ask the owner to approve this order (Related parties page, or POST /v1/purchase/orders/:poId/related-party-approval), then issue it again. Nothing was issued.',
      });
    },
  };
  // Propose: unchanged, but the reply says at once when the order will need the owner.
  const proposeAt = at(RELATED_PARTY_GUARDED_ROUTES.propose.method, RELATED_PARTY_GUARDED_ROUTES.propose.path);
  const propose = out[proposeAt]!;
  out[proposeAt] = {
    ...propose,
    handler: async (ctx: RequestContext): Promise<HandlerResult> => {
      const res = await propose.handler(ctx);
      if (res.status >= 300) return res;
      const supplierId = (res.body as { order?: { supplierId?: unknown } } | null)?.order?.supplierId;
      if (!isStr(supplierId)) return res;
      const pos = await relatedPartyPosition(deps, ctx.tenantId, supplierId);
      if (pos.matches.length === 0) return res;
      return { ...res, body: { ...(res.body as Record<string, unknown>), relatedParty: { needsOwnerApproval: true, matchedOn: matchedFactsWords(pos.matches), detail: `This supplier's ${matchedFactsWords(pos.matches)} matches the owner's related-party list; the order is issued only with the owner's written approval (OB-301).` } } };
    },
  };
  return out;
}
