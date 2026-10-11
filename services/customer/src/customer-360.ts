// FUL-10 — the customer record built from what actually happened, and one identity governed (M16-FR-01 · M16-FR-04 ·
// P-02 · P-04 · P-08 · §28 · hard rules #2 #6).
//
// The audit: the customer profile read facts somebody POSTed by hand, so a member who bought every week could look like a
// stranger; and duplicates were only ever a proposal over records the caller supplied — nothing could actually be merged,
// let alone un-merged. Now:
//
//   • FACTS ARE DERIVED, NOT TYPED. Every sale head office banked that names a customer, and every return against such a
//     sale, becomes a fact on that customer's record — derived from the durable sale and return streams by a projector that
//     catches up on every read and is idempotent per sale and per return (a resent sale is one purchase; a return corrects
//     the purchase it came back against, it never deletes it). The same facts feed segmentation.
//   • THE 360 IS A READ OF THOSE FACTS — purchases, returns, net spend, loyalty standing — through the real API, gated by its
//     own permission, and every look at a person's record is itself recorded (who, when, which customer).
//   • ONE IDENTITY, GOVERNED. Two records for one person are MERGED only when one person proposes it and ANOTHER approves
//     it; the merged record's facts then count on the survivor's record. A merge is REVERSIBLE — the reversal is a new fact
//     (the merge is never erased) and the records separate again. A record already merged cannot be merged twice; a
//     survivor cannot itself be a merged-away record.
//   • A HOUSEHOLD LINK is recorded (and unlinked) as facts and shown on the record. What a household SHARES is the owner's
//     policy (M16-FR-01 "per policy"); pooled stored value already exists (M17-FR-04) and nothing here invents more.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';

/** One banked sale that named this customer, as their record holds it. */
export interface CustomerPurchase {
  readonly saleId: string;
  readonly customerRef: string;
  readonly receiptNumber: string;
  readonly at: string;
  readonly tradingDay?: string;
  readonly laneId?: string;
  readonly locationId?: string;
  readonly grossMinor: number;
  readonly lineCount: number;
}

/** One return against a sale that named this customer (or a refund made out to them). */
export interface CustomerReturn {
  readonly returnId: string;
  readonly customerRef: string;
  readonly saleId: string | null;
  readonly at: string;
  readonly refundMinor: number;
  readonly exchange: boolean;
}

/**
 * A CORRECTION of a banked sale after it was committed — the s.34 GST note issued against it (M23-FR-02): a credit note (a
 * price correction, a post-sale discount, an order cancelled — a void) takes value off the purchase; a debit note adds to
 * it. The purchase itself is never edited: the correction is its own fact. A credit note for goods returned on a sale that
 * already has a return recorded is the tax document FOR that return — kept, but not counted again (`counted: false`).
 */
export interface CustomerCorrection {
  readonly noteId: string;
  readonly customerRef: string;
  readonly saleId: string;
  readonly kind: 'credit_note' | 'debit_note';
  readonly reason: string;
  readonly grossMinor: number;
  readonly at: string;
  readonly counted: boolean;
}

/** A merge of two records for one person: proposed, approved by another, reversible. Each stage is its own fact. */
export interface CustomerMerge {
  readonly mergeId: string;
  readonly survivorRef: string;
  readonly mergedRef: string;
  readonly reason: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly reversedBy?: string;
  readonly reversedAt?: string;
  readonly reversalReason?: string;
}

export interface HouseholdLink {
  readonly customerRef: string;
  readonly householdId: string;
  readonly linked: boolean;
  readonly by: string;
  readonly at: string;
}

/** Who looked at whose record, and when — a person's record is personal data (M16 · P-04). */
export interface ProfileView {
  readonly customerRef: string;
  readonly viewedBy: string;
  readonly at: string;
}

export interface Customer360Deps {
  /** Bring the derived facts up to date with the durable sale and return streams (idempotent). Returns how far it read. */
  readonly catchUp: (tenantId: string) => Promise<{ readonly sales: number; readonly returns: number }>;
  readonly purchasesOf: (tenantId: string, customerRef: string) => Promise<readonly CustomerPurchase[]> | readonly CustomerPurchase[];
  readonly returnsOf: (tenantId: string, customerRef: string) => Promise<readonly CustomerReturn[]> | readonly CustomerReturn[];
  /** FUL-10: the corrections (credit / debit notes) against this customer's banked sales. Optional: a stub has none. */
  readonly correctionsOf?: (tenantId: string, customerRef: string) => Promise<readonly CustomerCorrection[]> | readonly CustomerCorrection[];
  readonly merges: (tenantId: string) => Promise<readonly CustomerMerge[]> | readonly CustomerMerge[];
  readonly recordMerge: (tenantId: string, m: CustomerMerge) => Promise<void> | void;
  readonly households: (tenantId: string) => Promise<readonly HouseholdLink[]> | readonly HouseholdLink[];
  readonly recordHousehold: (tenantId: string, h: HouseholdLink) => Promise<void> | void;
  /** The loyalty standing of a member code: points held and whether they are (still) a member. */
  readonly loyaltyOf: (tenantId: string, customerRef: string) => Promise<{ readonly pointsBalance?: number; readonly member?: { readonly status: string; readonly mobileLast4: string } }>;
  readonly recordView: (tenantId: string, v: ProfileView) => Promise<void> | void;
  readonly views: (tenantId: string, customerRef: string) => Promise<readonly ProfileView[]> | readonly ProfileView[];
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The latest stage of each merge (proposed → approved → reversed). */
export function mergeState(all: readonly CustomerMerge[]): CustomerMerge[] {
  const byId = new Map<string, CustomerMerge>();
  for (const m of all) byId.set(m.mergeId, { ...(byId.get(m.mergeId) ?? {}), ...m });
  return [...byId.values()];
}
const inForce = (m: CustomerMerge): boolean => m.approvedBy !== undefined && m.reversedBy === undefined;

export function customer360Routes(deps: Customer360Deps): readonly Route[] {
  const merges = async (tenantId: string) => mergeState(await deps.merges(tenantId));
  /** A record exists when head office holds a fact for it — a purchase, a return — or it is a loyalty member. */
  const exists = async (tenantId: string, ref: string): Promise<boolean> => {
    if ((await deps.purchasesOf(tenantId, ref)).length > 0 || (await deps.returnsOf(tenantId, ref)).length > 0) return true;
    const loyalty = await deps.loyaltyOf(tenantId, ref);
    return loyalty.member !== undefined || loyalty.pointsBalance !== undefined;
  };

  return [
    {
      // The customer's record — derived from what they actually bought and returned, with their loyalty standing, the
      // records merged into it and their household. Every look is recorded.
      api: 'API-06', method: 'GET', path: '/v1/customers/:customerRef/profile',
      permission: 'customer.profile.read',
      handler: async (ctx) => {
        const customerRef = ctx.params['customerRef'] ?? '';
        const read = await deps.catchUp(ctx.tenantId);
        const all = await merges(ctx.tenantId);
        const absorbedBy = all.find((m) => inForce(m) && m.mergedRef === customerRef);
        await deps.recordView(ctx.tenantId, { customerRef, viewedBy: ctx.userId, at: deps.now() });
        if (absorbedBy !== undefined) {
          return { status: 200, body: { customerRef, mergedInto: absorbedBy.survivorRef, mergeId: absorbedBy.mergeId, detail: `This record was merged into ${absorbedBy.survivorRef}; its purchases count there. The merge can be reversed.` } };
        }
        const refs = [customerRef, ...all.filter((m) => inForce(m) && m.survivorRef === customerRef).map((m) => m.mergedRef)];
        const purchases: CustomerPurchase[] = [];
        const returns: CustomerReturn[] = [];
        const corrections: CustomerCorrection[] = [];
        for (const r of refs) {
          purchases.push(...await deps.purchasesOf(ctx.tenantId, r));
          returns.push(...await deps.returnsOf(ctx.tenantId, r));
          corrections.push(...(await deps.correctionsOf?.(ctx.tenantId, r) ?? []));
        }
        if (purchases.length === 0 && returns.length === 0 && refs.length === 1) {
          const loyalty = await deps.loyaltyOf(ctx.tenantId, customerRef);
          if (loyalty.member === undefined && loyalty.pointsBalance === undefined) throw notFound(`a customer record for ${customerRef}`);
        }
        purchases.sort((a, b) => b.at.localeCompare(a.at));
        returns.sort((a, b) => b.at.localeCompare(a.at));
        const grossMinor = purchases.reduce((s, p) => s + p.grossMinor, 0);
        // What came back, at the value credited for it (an exchange's goods too — their replacement is a purchase of its own).
        const returnedMinor = returns.reduce((s, r) => s + r.refundMinor, 0);
        // What corrections took off (credit notes, a void among them) or added (debit notes) after the sale was committed.
        const counted = corrections.filter((c) => c.counted);
        const creditedMinor = counted.filter((c) => c.kind === 'credit_note').reduce((s, c) => s + c.grossMinor, 0);
        const debitedMinor = counted.filter((c) => c.kind === 'debit_note').reduce((s, c) => s + c.grossMinor, 0);
        corrections.sort((a, b) => b.at.localeCompare(a.at));
        const loyalty = await deps.loyaltyOf(ctx.tenantId, customerRef);
        const links = (await deps.households(ctx.tenantId));
        const latestLink = new Map<string, HouseholdLink>();
        for (const l of links) latestLink.set(l.customerRef, l);
        const mine = latestLink.get(customerRef);
        const household = mine !== undefined && mine.linked
          ? { householdId: mine.householdId, members: [...latestLink.values()].filter((l) => l.linked && l.householdId === mine.householdId).map((l) => l.customerRef) }
          : null;
        return {
          status: 200,
          body: {
            customerRef,
            identities: refs,
            purchases: { count: purchases.length, grossMinor, recent: purchases.slice(0, 50) },
            returns: { count: returns.length, refundedMinor: returnedMinor, recent: returns.slice(0, 50) },
            corrections: { count: corrections.length, creditedMinor, debitedMinor, recent: corrections.slice(0, 50) },
            netSpendMinor: grossMinor - returnedMinor - creditedMinor + debitedMinor,
            lastPurchaseAt: purchases[0]?.at ?? null,
            loyalty,
            household,
            source: 'derived from the sales and returns head office banked — never typed in',
            factsRead: read,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // Who has looked at this customer's record — the record of the records (P-04).
      api: 'API-06', method: 'GET', path: '/v1/customers/:customerRef/profile/views',
      permission: 'customer.identity.approve',
      handler: async (ctx) => {
        const customerRef = ctx.params['customerRef'] ?? '';
        const views = await deps.views(ctx.tenantId, customerRef);
        return { status: 200, body: { customerRef, views, count: views.length } };
      },
    },
    {
      // Propose that two records are one person. Not in force until someone ELSE approves it. Body: { mergedRef, reason }.
      api: 'API-06', method: 'POST', path: '/v1/customers/:survivorRef/merges/:mergeId',
      permission: 'customer.identity.manage', idempotent: true,
      handler: async (ctx) => {
        const survivorRef = ctx.params['survivorRef'] ?? '';
        const mergeId = ctx.params['mergeId'] ?? '';
        const b = (ctx.body ?? {}) as { mergedRef?: unknown; reason?: unknown };
        if (!isStr(b.mergedRef) || !isStr(b.reason) || b.mergedRef === survivorRef) {
          throw apiError(400, { code: 'not_readable_as_a_merge', whatHappened: 'A merge names the other record { mergedRef } (not this one) and why { reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send it again. Nothing was changed.' });
        }
        const all = await merges(ctx.tenantId);
        const prior = all.find((m) => m.mergeId === mergeId);
        if (prior !== undefined) return { status: 200, body: { ...prior, alreadyRecorded: true } };
        // FUL-10: only records that EXIST can be one person — a customer head office holds facts for (a banked purchase or a
        // return) or a loyalty member. A merge naming an unknown record would graft an id nobody has onto a real person.
        await deps.catchUp(ctx.tenantId);
        const unknown: string[] = [];
        for (const ref of [survivorRef, b.mergedRef]) if (!(await exists(ctx.tenantId, ref))) unknown.push(ref);
        if (unknown.length > 0) {
          throw apiError(404, { code: 'customer_record_unknown', whatHappened: `No customer record ${unknown.join(' or ')} is held here — no purchase, return or loyalty membership — so there is nothing to merge.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the customer codes on both records. Nothing was changed.' });
        }
        const busy = all.find((m) => (m.approvedBy === undefined || inForce(m)) && m.reversedBy === undefined
          && (m.mergedRef === b.mergedRef || m.mergedRef === survivorRef));
        // A record that has absorbed others is a survivor; merging it away would strand them — reverse those first.
        const survivorOfOthers = all.find((m) => inForce(m) && m.survivorRef === b.mergedRef);
        if (busy === undefined && survivorOfOthers !== undefined) {
          throw apiError(409, { code: 'record_holds_merged_records', whatHappened: `${b.mergedRef} holds ${survivorOfOthers.mergedRef} (${survivorOfOthers.mergeId}); it cannot itself be merged away.`, wasItSaved: 'not_saved', nextSafeAction: 'Merge the other way round, or reverse that merge first. Nothing was changed.' });
        }
        if (busy !== undefined) {
          throw apiError(409, { code: 'record_already_merged', whatHappened: `${busy.mergedRef} is already merged (or proposed to be) into ${busy.survivorRef} (${busy.mergeId}).`, wasItSaved: 'not_saved', nextSafeAction: 'Reverse that merge first, or merge into the surviving record. Nothing was changed.' });
        }
        const m: CustomerMerge = { mergeId, survivorRef, mergedRef: b.mergedRef, reason: b.reason.slice(0, 300), proposedBy: ctx.userId, proposedAt: deps.now() };
        await deps.recordMerge(ctx.tenantId, m);
        return { status: 201, body: { ...m, inForce: false } };
      },
    },
    {
      // Approve a proposed merge — by someone other than its proposer (§28). The merged record's facts then count on the survivor.
      api: 'API-06', method: 'POST', path: '/v1/customers/merges/:mergeId/approve',
      permission: 'customer.identity.approve', idempotent: true,
      handler: async (ctx) => {
        const m = (await merges(ctx.tenantId)).find((x) => x.mergeId === (ctx.params['mergeId'] ?? ''));
        if (m === undefined) throw notFound(`merge ${ctx.params['mergeId'] ?? ''}`);
        if (m.reversedBy !== undefined) throw apiError(409, { code: 'merge_reversed', whatHappened: 'This merge was reversed; it cannot be approved again.', wasItSaved: 'not_saved', nextSafeAction: 'Propose a new merge if the records are one person after all. Nothing was changed.' });
        if (m.approvedBy !== undefined) return { status: 200, body: { ...m, inForce: true } };
        if (m.proposedBy === ctx.userId) throw apiError(403, { code: 'self_approval', whatHappened: 'A merge must be approved by someone other than the person who proposed it.', wasItSaved: 'not_saved', nextSafeAction: 'Ask another approver. Nothing was changed.' });
        const approved: CustomerMerge = { ...m, approvedBy: ctx.userId, approvedAt: deps.now() };
        await deps.recordMerge(ctx.tenantId, approved);
        return { status: 200, body: { ...approved, inForce: true } };
      },
    },
    {
      // Reverse a merge — a new fact, the merge itself is kept (hard rule #6). The two records separate again. Body: { reason }.
      api: 'API-06', method: 'POST', path: '/v1/customers/merges/:mergeId/reverse',
      permission: 'customer.identity.approve', idempotent: true,
      handler: async (ctx) => {
        const m = (await merges(ctx.tenantId)).find((x) => x.mergeId === (ctx.params['mergeId'] ?? ''));
        if (m === undefined) throw notFound(`merge ${ctx.params['mergeId'] ?? ''}`);
        const reason = ((ctx.body ?? {}) as { reason?: unknown }).reason;
        if (!isStr(reason)) throw apiError(400, { code: 'reversal_needs_a_reason', whatHappened: 'Reversing a merge needs { reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Say why. Nothing was changed.' });
        if (m.reversedBy !== undefined) return { status: 200, body: { ...m, inForce: false } };
        const reversed: CustomerMerge = { ...m, reversedBy: ctx.userId, reversedAt: deps.now(), reversalReason: reason.slice(0, 300) };
        await deps.recordMerge(ctx.tenantId, reversed);
        return { status: 200, body: { ...reversed, inForce: false } };
      },
    },
    {
      // Every merge a record took part in — proposed, approved, reversed, with who and why.
      api: 'API-06', method: 'GET', path: '/v1/customers/:customerRef/identity-history',
      permission: 'customer.profile.read',
      handler: async (ctx) => {
        const ref = ctx.params['customerRef'] ?? '';
        const history = (await merges(ctx.tenantId)).filter((m) => m.survivorRef === ref || m.mergedRef === ref).map((m) => ({ ...m, inForce: inForce(m) }));
        return { status: 200, body: { customerRef: ref, merges: history } };
      },
    },
    {
      // Link a record to a household, or unlink it (a new fact). Body: { householdId } or { unlink: true }.
      api: 'API-06', method: 'POST', path: '/v1/customers/:customerRef/household',
      permission: 'customer.identity.manage', idempotent: true,
      handler: async (ctx) => {
        const customerRef = ctx.params['customerRef'] ?? '';
        const b = (ctx.body ?? {}) as { householdId?: unknown; unlink?: unknown };
        const current = [...await deps.households(ctx.tenantId)].reverse().find((l) => l.customerRef === customerRef);
        if (b.unlink === true) {
          if (current === undefined || !current.linked) return { status: 200, body: { customerRef, household: null } };
          await deps.recordHousehold(ctx.tenantId, { customerRef, householdId: current.householdId, linked: false, by: ctx.userId, at: deps.now() });
          return { status: 200, body: { customerRef, household: null, unlinkedFrom: current.householdId } };
        }
        if (!isStr(b.householdId)) throw apiError(400, { code: 'not_readable_as_a_household_link', whatHappened: 'A household link is { householdId } (or { unlink: true }).', wasItSaved: 'not_saved', nextSafeAction: 'Send it again. Nothing was changed.' });
        const link: HouseholdLink = { customerRef, householdId: b.householdId, linked: true, by: ctx.userId, at: deps.now() };
        await deps.recordHousehold(ctx.tenantId, link);
        return { status: 201, body: link };
      },
    },
  ];
}
