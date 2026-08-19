// API-02 Product MERGE — the §28-gated, reversible resolution of a duplicate (M03-FR-04). Detection
// (`/v1/catalogue/products/duplicates`) only produces a review list; this is the write path that acts on
// one, and it acts the way the roadmap insists a merge must:
//
//     A MERGE IS NEVER AUTOMATIC, AND NEVER DESTRUCTIVE.
//
// A wrong auto-merge destroys a product's history with nothing left to compare against, so a merge takes
// TWO people — one PROPOSES it (`catalogue.merge.propose`), a DIFFERENT one APPROVES it
// (`catalogue.merge.approve`) — exactly as a price change is proposed by a manager and approved by the
// owner. The person who proposed it can never be the one who approves it (§28), and the engine enforces
// that on two server-attributed identities, so it holds even for an owner who happens to hold both codes.
//
// And the result is a LINK, not a deletion (hard rule #2): the superseded record keeps its history and the
// merge can be REVERSED. `resolveProductId` then tells any reader where a product id now points.
//
// The rule is the tested `mergeProducts`/`reverseMerge`/`resolveProductId` in `@sre/product` (the
// `services-run-on-their-tested-engine` guardrail); this file is the persistence + HTTP skin around it. The
// lifecycle is event-sourced (`MergeProposed` → `MergeApproved`/`MergeRejected` → `MergeReversed`), so a
// merge survives a restart and reads as exactly what happened and who decided it.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  mergeProducts, reverseMerge, resolveProductId,
  MergeApprovalRequiredError, SelfMergeError,
  type MergeRequest, type MergeApproval, type MergeLink,
} from '../../../packages/product/src/index';

/** Where a merge is in its life. A proposal is `pending` until a second person decides it. */
export type MergeStatus = 'pending' | 'approved' | 'rejected' | 'reversed';

/** A recorded rejection — the second person declined the merge. Kept, never erased (hard rule #6). */
export interface MergeRejection {
  readonly mergeId: string;
  readonly decidedBy: string;
  readonly at: string;
}

/** One merge, folded from its events — the proposal plus whatever was decided about it. */
export interface MergeView {
  readonly request: MergeRequest;
  readonly status: MergeStatus;
  /** Present once approved; carries `reversed: true` after a reversal. */
  readonly link?: MergeLink;
  /** Who approved or rejected it, once there is a decision. */
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}

export interface ProductMergeDeps {
  /** Record a pending proposal (idempotent on the caller's key). */
  readonly recordProposal: (tenantId: string, request: MergeRequest, key: string) => Promise<void> | void;
  /** Record an approved merge as a reversible link. */
  readonly recordApproved: (tenantId: string, link: MergeLink, key: string) => Promise<void> | void;
  /** Record a rejection — the merge did not happen, and that is kept. */
  readonly recordRejected: (tenantId: string, rejection: MergeRejection, key: string) => Promise<void> | void;
  /** Record the reversal of an approved merge. */
  readonly recordReversed: (tenantId: string, link: MergeLink, key: string) => Promise<void> | void;
  /** The current state of one merge, or undefined when the mergeId is unknown. */
  readonly view: (tenantId: string, mergeId: string) => Promise<MergeView | undefined> | MergeView | undefined;
  /** Every merge, for the review surface and for resolving where an id now points. */
  readonly all: (tenantId: string) => Promise<readonly MergeView[]> | readonly MergeView[];
  /** The business moment a decision is stamped with. */
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The approved, unreversed links only — what `resolveProductId` follows. */
const activeLinks = (views: readonly MergeView[]): readonly MergeLink[] =>
  views.map((v) => v.link).filter((l): l is MergeLink => l !== undefined);

const byMergeId = (a: MergeView, b: MergeView): number =>
  a.request.mergeId < b.request.mergeId ? -1 : a.request.mergeId > b.request.mergeId ? 1 : 0;

export function productMergeRoutes(deps: ProductMergeDeps): readonly Route[] {
  return [
    {
      // PROPOSE a merge. Body: { keepProductId, supersedeProductId, reason }. The proposer is the
      // authenticated caller (never a client-supplied value), and the merge does NOT happen here — it waits
      // for a second person's approval.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/merges/:mergeId',
      permission: 'catalogue.merge.propose', idempotent: true,
      handler: async (ctx) => {
        const mergeId = (ctx.params['mergeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const keepProductId = isStr(b['keepProductId']) ? b['keepProductId'].trim() : '';
        const supersedeProductId = isStr(b['supersedeProductId']) ? b['supersedeProductId'].trim() : '';
        const reason = isStr(b['reason']) ? b['reason'] : '';
        if (mergeId === '' || keepProductId === '' || supersedeProductId === '' || reason === '') {
          throw apiError(400, {
            code: 'not_readable_as_a_merge_proposal',
            whatHappened: 'Proposing a merge needs a mergeId in the path and { keepProductId, supersedeProductId, reason } in the body — a merge with no reason is never recorded.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the two product ids and a plain reason for merging them; the record kept is what one person later has to justify.',
          });
        }
        if (keepProductId === supersedeProductId) {
          // A product cannot be merged into itself — nonsensical, and caught before anyone approves it.
          throw apiError(422, {
            code: 'a_product_cannot_merge_into_itself',
            whatHappened: `"${keepProductId}" was named as both the record to keep and the one to supersede.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Name two different products — the one that survives and the duplicate it replaces.',
          });
        }
        const existing = await deps.view(ctx.tenantId, mergeId);
        if (existing !== undefined && existing.status !== 'pending') {
          throw apiError(409, {
            code: 'merge_already_decided',
            whatHappened: `Merge "${mergeId}" has already been ${existing.status} — a decided merge is not re-opened by re-proposing it.`,
            wasItSaved: 'not_saved',
            nextSafeAction: existing.status === 'reversed'
              ? 'Propose a new merge under a fresh id if these two products should be merged again.'
              : 'Use a fresh mergeId, or look up the existing decision.',
          });
        }
        const request: MergeRequest = {
          mergeId, keepProductId, supersedeProductId,
          requestedBy: ctx.userId, // server-attributed — the person the kernel authenticated, not a body field
          reason,
        };
        await deps.recordProposal(ctx.tenantId, request, ctx.idempotencyKey ?? mergeId);
        return { status: 201, body: { merge: { request, status: 'pending' as MergeStatus } } };
      },
    },
    {
      // DECIDE a pending proposal. Body: { decision: 'approved' | 'rejected' }. The approver is the
      // authenticated caller; the tested engine refuses the merge if that is the same person who proposed it
      // (§28). On approval the merge becomes a reversible LINK; on rejection nothing is merged and the
      // rejection is kept.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/merges/:mergeId/decision',
      permission: 'catalogue.merge.approve', idempotent: true,
      handler: async (ctx) => {
        const mergeId = (ctx.params['mergeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'];
        if (decision !== 'approved' && decision !== 'rejected') {
          throw apiError(400, {
            code: 'not_readable_as_a_merge_decision',
            whatHappened: 'Deciding a merge needs { decision: "approved" | "rejected" } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send "approved" to merge the two records, or "rejected" to decline — either way the decision and who made it are kept.',
          });
        }
        const view = await deps.view(ctx.tenantId, mergeId);
        if (view === undefined) throw notFound(`merge ${mergeId}`);
        if (view.status !== 'pending') {
          throw apiError(409, {
            code: 'merge_already_decided',
            whatHappened: `Merge "${mergeId}" is already ${view.status}, so it cannot be decided again.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Look up the existing decision; a decided merge is changed only by reversing an approved one.',
          });
        }
        const at = deps.now();
        if (decision === 'rejected') {
          await deps.recordRejected(ctx.tenantId, { mergeId, decidedBy: ctx.userId, at }, ctx.idempotencyKey ?? `${mergeId}:reject`);
          return { status: 200, body: { merge: { request: view.request, status: 'rejected' as MergeStatus, decidedBy: ctx.userId, decidedAt: at } } };
        }
        const approval: MergeApproval = { subjectRef: mergeId, status: 'approved', decidedBy: ctx.userId };
        let link: MergeLink;
        try {
          // The §28 gate, run on two server-attributed identities: the proposer stored on the request and
          // this approver. An owner holding both codes still cannot approve their own proposal.
          link = mergeProducts(view.request, approval, at);
        } catch (err) {
          if (err instanceof MergeApprovalRequiredError) {
            throw apiError(409, {
              code: 'merge_needs_a_second_person',
              whatHappened: `This merge cannot be approved: ${err.why}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'A different person from the one who proposed the merge must approve it — that separation is the whole point of the control.',
            });
          }
          if (err instanceof SelfMergeError) {
            throw apiError(422, {
              code: 'a_product_cannot_merge_into_itself',
              whatHappened: `"${err.productId}" was named as both the record to keep and the one to supersede.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Reject this proposal and raise a fresh one naming two different products.',
            });
          }
          throw err;
        }
        await deps.recordApproved(ctx.tenantId, link, ctx.idempotencyKey ?? `${mergeId}:approve`);
        return { status: 201, body: { merge: { request: view.request, status: 'approved' as MergeStatus, link, decidedBy: link.approvedBy, decidedAt: link.at } } };
      },
    },
    {
      // REVERSE an approved merge — the undo the reversibility exists for. Recorded as a reversal, never by
      // erasing the original link (hard rule #2), so the history reads as "merged, then unmerged".
      api: 'API-02', method: 'POST', path: '/v1/catalogue/merges/:mergeId/reverse',
      permission: 'catalogue.merge.approve', idempotent: true,
      handler: async (ctx) => {
        const mergeId = (ctx.params['mergeId'] ?? '').trim();
        const view = await deps.view(ctx.tenantId, mergeId);
        if (view === undefined) throw notFound(`merge ${mergeId}`);
        if (view.status !== 'approved' || view.link === undefined) {
          throw apiError(409, {
            code: 'only_an_approved_merge_can_be_reversed',
            whatHappened: `Merge "${mergeId}" is ${view.status}; only a merge that was approved and not already reversed can be reversed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: view.status === 'reversed' ? 'This merge has already been reversed.' : 'A pending or rejected merge never took effect, so there is nothing to reverse.',
          });
        }
        const reversed = reverseMerge(view.link);
        await deps.recordReversed(ctx.tenantId, reversed, ctx.idempotencyKey ?? `${mergeId}:reverse`);
        return { status: 200, body: { merge: { request: view.request, status: 'reversed' as MergeStatus, link: reversed, decidedBy: view.decidedBy, decidedAt: view.decidedAt } } };
      },
    },
    {
      // The review surface — every merge and where it stands, pending ones first so the person deciding
      // sees what is waiting on them.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/merges',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const all = [...(await deps.all(ctx.tenantId))].sort(byMergeId);
        const pending = all.filter((v) => v.status === 'pending');
        // Pending first (they need a decision), then the rest by id.
        const ordered = [...pending, ...all.filter((v) => v.status !== 'pending')];
        return { status: 200, body: { merges: ordered, count: ordered.length, pendingCount: pending.length } };
      },
    },
    {
      // Where a product id now points, following any approved, unreversed merge — the question every reader
      // of an old id (a re-scanned label, an old order line) needs answered.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products/:productId/canonical',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        if (productId === '') throw notFound('product (no id given)');
        const canonical = resolveProductId(productId, activeLinks(await deps.all(ctx.tenantId)));
        return { status: 200, body: { productId, canonicalProductId: canonical, merged: canonical !== productId } };
      },
    },
  ];
}
