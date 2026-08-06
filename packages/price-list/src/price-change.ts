// Making a price (M05-FR-01/02, §28) — the half of pricing that has never existed.
//
// `resolvePrice` reads a price. `priceHistory` reports on them. `checkPrice` says whether one is
// allowed. `buildCatalogueSnapshot` ships them to the lane. **Nothing has ever produced one.** The
// only `PriceEntry` values in this repository are test fixtures written by hand, so the catalogue
// snapshot builder has never had anything real to build from and no lane has ever been given a
// price this system decided.
//
// That is the same shape as the supplier invoice nobody captured: every rule built and tested, the
// join missing, and nothing failing to say so.
//
// ── What this file will not do ──────────────────────────────────────────────
//
// **It never edits a price.** A change is a new entry with a higher version and its own effective
// date; the entry it supersedes is left exactly as it was (hard rule #2, §29.1). That is not
// bookkeeping neatness — a receipt printed last Tuesday has to stay explainable, and a price that
// was overwritten cannot explain anything.
//
// **It never activates on one person's say-so.** Above MRP is refused outright and no approval can
// authorise it, because MRP is a legal ceiling rather than a policy. Below the margin floor, or
// below cost, is allowed — a loss leader is a real decision — but only with a named separate
// approver and a written reason (§28).
//
// **It never checks a margin it cannot compute.** A product with no landed cost has no knowable
// margin, and defaulting the cost to zero makes every price look like 100% margin: the check
// passes, loudly and wrongly, exactly where a buyer most needs it. So an unknown cost is its own
// refusal, and it is escalated to an approver rather than assumed away.
//
// **It never back-dates.** A price active from yesterday changes what `resolvePrice` says
// yesterday's sales should have charged, so the report and the receipt stop agreeing and there is
// no way to tell which is right. Today or later, or it is refused.

import { compare, type Money } from '../../contracts/src/money';
import { checkPrice, type PriceCheck } from '../../price-guard/src/price-guard';
import type { DecidedRequest } from '../../approvals/src/approvals';
import type { PriceEntry, PriceScope } from './price-list';

/** What the shop knows about a product's cost, or that it does not know (P-08). */
export type CostRegister =
  | { readonly known: true; readonly cost: Money }
  | { readonly known: false; readonly why: string };

export interface PriceChangeRequest {
  /** The id the entry will carry, and the `subjectRef` an approval must reference. */
  readonly id: string;
  readonly productId: string;
  readonly scope: PriceScope;
  readonly scopeRef: string;
  readonly price: Money;
  /** ISO-8601 date (YYYY-MM-DD) this price starts. Never earlier than `today`. */
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  /** Who is setting it. They may not also approve it (§28). */
  readonly setBy: string;
}

export interface PriceChangeContext {
  /** Today, as YYYY-MM-DD, in the shop's own calendar. Injected — never read from a clock here. */
  readonly today: string;
  /** The legal ceiling for this product, or absent when the shop has not recorded one. */
  readonly mrp?: Money;
  readonly cost: CostRegister;
  /** Minimum gross margin in basis points. Per-tenant policy, never a constant here. */
  readonly marginFloorBps: number;
  /** Every entry already recorded for this product — read to version and to compare. */
  readonly existing: readonly PriceEntry[];
}

export type PriceChangeRefusal =
  | 'above_the_printed_mrp'
  | 'below_the_margin_floor'
  | 'below_what_it_cost_us'
  | 'the_cost_is_not_known_so_the_margin_was_never_checked'
  | 'no_mrp_recorded'
  | 'approved_by_the_person_who_set_it'
  | 'starts_in_the_past'
  | 'same_as_the_price_already_running';

/**
 * The same set at runtime, so a screen can be checked against it.
 *
 * `Record<PriceChangeRefusal, PriceChangeRefusal>` makes the compiler insist this stays complete:
 * add a refusal and this stops building, rather than somebody being shown a blank reason for a
 * price change that would not go through.
 */
const REFUSALS: Readonly<Record<PriceChangeRefusal, PriceChangeRefusal>> = Object.freeze({
  above_the_printed_mrp: 'above_the_printed_mrp',
  below_the_margin_floor: 'below_the_margin_floor',
  below_what_it_cost_us: 'below_what_it_cost_us',
  the_cost_is_not_known_so_the_margin_was_never_checked: 'the_cost_is_not_known_so_the_margin_was_never_checked',
  no_mrp_recorded: 'no_mrp_recorded',
  approved_by_the_person_who_set_it: 'approved_by_the_person_who_set_it',
  starts_in_the_past: 'starts_in_the_past',
  same_as_the_price_already_running: 'same_as_the_price_already_running',
});

export const PRICE_CHANGE_REFUSALS: readonly PriceChangeRefusal[] = Object.freeze(Object.values(REFUSALS));

/** What a proposed price would do, worked out before anything is written. */
export interface PriceProposal {
  /** The entry that WOULD be written. Status `draft` — it prices nothing until activated. */
  readonly draft: PriceEntry;
  /** The price this replaces, when there is one running. */
  readonly replaces: PriceEntry | null;
  /** `checkPrice`'s verdict, when the cost was known well enough to run it. */
  readonly check: PriceCheck | null;
  /** True when this could be activated with no approval at all. */
  readonly cleanToActivate: boolean;
  /** True when it could go through, but only with somebody else's approval. */
  readonly needsApproval: boolean;
  /** Everything wrong with it, worst first. Empty means only an approval stands in the way. */
  readonly refusals: readonly PriceChangeRefusal[];
  /** One sentence per refusal, for a person rather than a log. */
  readonly detail: readonly string[];
}

export type PriceChangeOutcome =
  | { readonly ok: true; readonly entry: PriceEntry; readonly approvedBy: string | null }
  | { readonly ok: false; readonly refusals: readonly PriceChangeRefusal[]; readonly detail: readonly string[] };

const DETAIL: Readonly<Record<PriceChangeRefusal, string>> = Object.freeze({
  above_the_printed_mrp:
    'this is more than the MRP printed on the pack. No approval can allow it — MRP is a legal ceiling, not a shop policy.',
  below_the_margin_floor:
    'this earns less than the shop’s minimum margin. It can still be done, but somebody else has to approve it and say why.',
  below_what_it_cost_us:
    'this sells for less than the goods cost. It can still be done, but somebody else has to approve it and say why.',
  the_cost_is_not_known_so_the_margin_was_never_checked:
    'the shop has no cost price for this item, so nobody can say what this price earns. Costing it at nothing would make any price look perfect, so this needs somebody to approve it with their eyes open.',
  no_mrp_recorded:
    'no MRP has been recorded for this item, so the legal ceiling cannot be checked. Add the MRP from the pack first.',
  approved_by_the_person_who_set_it:
    'the person who set this price cannot also approve it. Somebody else has to look at it.',
  starts_in_the_past:
    'a price cannot start before today. Back-dating it would change what yesterday’s sales should have charged, and the receipts would stop agreeing with the reports.',
  same_as_the_price_already_running:
    'this is the price already running. Nothing would change, and a second identical entry only makes the history harder to read.',
});

/** The highest version this product has ever had, so a new entry is always above it. */
function nextVersion(existing: readonly PriceEntry[], productId: string): number {
  const versions = existing.filter((e) => e.productId === productId).map((e) => e.version);
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

/** The entry currently running for this exact scope, if any. */
function runningEntry(
  existing: readonly PriceEntry[],
  request: PriceChangeRequest,
  today: string,
): PriceEntry | null {
  const live = existing
    .filter((e) =>
      e.productId === request.productId &&
      e.scope === request.scope &&
      e.scopeRef === request.scopeRef &&
      e.status === 'active' &&
      e.effectiveFrom <= today &&
      (e.effectiveTo === undefined || e.effectiveTo === null || e.effectiveTo >= today))
    .sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? b.version - a.version : a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return live[0] ?? null;
}

/**
 * Work out what a proposed price would do. **Writes nothing and activates nothing.**
 *
 * The draft it returns has status `draft`, which `resolvePrice` will never select, so a proposal
 * that is put down and picked up again tomorrow still prices nothing in the meantime.
 */
export function proposePriceChange(
  request: PriceChangeRequest,
  context: PriceChangeContext,
): PriceProposal {
  const refusals: PriceChangeRefusal[] = [];

  const draft: PriceEntry = {
    id: request.id,
    productId: request.productId,
    scope: request.scope,
    scopeRef: request.scopeRef,
    price: request.price,
    effectiveFrom: request.effectiveFrom,
    ...(request.effectiveTo === undefined ? {} : { effectiveTo: request.effectiveTo }),
    status: 'draft',
    version: nextVersion(context.existing, request.productId),
  };

  if (request.effectiveFrom < context.today) refusals.push('starts_in_the_past');

  const replaces = runningEntry(context.existing, request, context.today);
  if (replaces !== null && compare(replaces.price, request.price) === 0) {
    refusals.push('same_as_the_price_already_running');
  }

  // Without an MRP there is no ceiling to check against, and this is the one country where that
  // ceiling is the law rather than a preference. Say so rather than checking half of it.
  if (context.mrp === undefined) {
    refusals.push('no_mrp_recorded');
    return {
      draft,
      replaces,
      check: null,
      cleanToActivate: false,
      needsApproval: false,
      refusals,
      detail: refusals.map((r) => DETAIL[r]),
    };
  }

  // A margin nobody can compute is not a margin that passed. Escalated, never assumed.
  if (!context.cost.known) {
    const check = checkPrice({
      id: request.id,
      proposedPrice: request.price,
      mrp: context.mrp,
      // Compared against the MRP only. The cost is deliberately set to the price itself so the
      // floor arithmetic cannot produce a flattering answer out of a number nobody has.
      cost: request.price,
      marginFloorBps: 0,
      setBy: request.setBy,
    });
    if (check.verdict === 'above_mrp') refusals.push('above_the_printed_mrp');
    else refusals.push('the_cost_is_not_known_so_the_margin_was_never_checked');
    return {
      draft,
      replaces,
      check,
      cleanToActivate: false,
      // An MRP breach is not an approvable thing; an unknown cost is.
      needsApproval: check.verdict !== 'above_mrp' && !refusals.includes('starts_in_the_past'),
      refusals,
      detail: refusals.map((r) => DETAIL[r]),
    };
  }

  const check = checkPrice({
    id: request.id,
    proposedPrice: request.price,
    mrp: context.mrp,
    cost: context.cost.cost,
    marginFloorBps: context.marginFloorBps,
    setBy: request.setBy,
  });

  if (check.verdict === 'above_mrp') refusals.push('above_the_printed_mrp');
  if (check.verdict === 'below_cost') refusals.push('below_what_it_cost_us');
  if (check.verdict === 'below_floor') refusals.push('below_the_margin_floor');

  const blocking = refusals.includes('above_the_printed_mrp')
    || refusals.includes('starts_in_the_past')
    || refusals.includes('same_as_the_price_already_running');

  return {
    draft,
    replaces,
    check,
    cleanToActivate: refusals.length === 0,
    needsApproval: !blocking && check.requiresApproval,
    refusals,
    detail: refusals.map((r) => DETAIL[r]),
  };
}

/**
 * Turn a proposal into a live price — **a new append-only entry, never an edit**.
 *
 * The entry it supersedes is returned untouched; the caller appends. Nothing here mutates its
 * inputs, so a caller that ignores the result has changed nothing, which is the correct failure
 * mode for a function that sets what customers are charged.
 */
export function activatePriceChange(
  proposal: PriceProposal,
  input: { readonly setBy: string; readonly approval?: DecidedRequest },
): PriceChangeOutcome {
  const refuse = (refusals: readonly PriceChangeRefusal[]): PriceChangeOutcome =>
    ({ ok: false, refusals, detail: refusals.map((r) => DETAIL[r]) });

  // Refusals nothing can authorise.
  const unauthorisable = proposal.refusals.filter((r) =>
    r === 'above_the_printed_mrp' || r === 'starts_in_the_past'
    || r === 'same_as_the_price_already_running' || r === 'no_mrp_recorded');
  if (unauthorisable.length > 0) return refuse(unauthorisable);

  if (proposal.refusals.length > 0) {
    const approval = input.approval;
    if (approval === undefined || approval.status !== 'approved' || approval.subjectRef !== proposal.draft.id) {
      return refuse(proposal.refusals);
    }
    // §28, checked here as well as in `checkPrice`: the unknown-cost path never reaches that
    // function's approval test, and an approval nobody else gave is not an approval.
    if (approval.decidedBy === input.setBy) return refuse(['approved_by_the_person_who_set_it']);

    return {
      ok: true,
      entry: { ...proposal.draft, status: 'active' },
      approvedBy: approval.decidedBy,
    };
  }

  return { ok: true, entry: { ...proposal.draft, status: 'active' }, approvedBy: null };
}

/**
 * Withdraw a price that should not have gone live.
 *
 * A **new** entry marked `rolled_back`, so the history shows a price that ran and was withdrawn
 * rather than a price that was never set. `resolvePrice` ignores anything that is not `active`, so
 * the previous entry takes over again on the next resolution — which is the honest outcome: the
 * shop goes back to what it was charging before, and the record says why it moved twice.
 */
export function rollBackPrice(entry: PriceEntry, at: string): PriceEntry {
  return { ...entry, id: `${entry.id}-rolled-back`, status: 'rolled_back', version: entry.version + 1, effectiveFrom: at };
}
