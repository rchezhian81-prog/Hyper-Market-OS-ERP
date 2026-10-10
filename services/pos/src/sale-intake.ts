// Taking a sale from a lane — API-05, §31.1, hard rules #1, #2 and #10, P-08, M12–M15.
//
// **The server does not get to say no.**
//
// That is the whole design, and it is the opposite of how an API normally works. By the time a
// sale reaches here it has already happened: the till committed it locally (hard rule #1), the
// money is in the drawer, the receipt is printed and the customer has gone home. There is no
// version of "rejected" that means the sale did not occur.
//
// So a server that refuses a sale it dislikes — unknown product, price it did not expect, a pack
// three days old — and a till that treats refusal as *"drop it"*, together delete a sale that
// really happened while the cash for it sits in the till. The day will not balance and nobody
// will know why, because the evidence was thrown away by the two systems that had it.
//
// Therefore: **a well-formed sale is always banked, and everything wrong with it becomes a visible
// exception attached to it** (hard rule #10, P-08). `banked` is typed as the literal `true`.
//
// The second half of that rule matters as much: **the server never corrects a sale to make it
// valid.** If the till charged ₹45 and the catalogue says ₹50, the customer paid ₹45 — that is
// what happened, and rewriting it to ₹50 makes the books agree with the catalogue and disagree
// with reality. The difference is an exception for a person to settle, and any correction is a
// compensating document, never an edit (hard rule #2). There is no function here that changes a
// sale, and a test reads the module's exports to prove it.

import { minimumAgeOf, type CatalogueProduct } from '../../../packages/catalogue/src/catalogue';

export interface IncomingSaleLine {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  /** What the lane actually charged, per unit. Not what anything thinks it should have been. */
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
  /** The lot/batch this unit came from, where the lane captured it — the one-step-forward half of the
   *  recall trace (M10-FR-03). Absent for a non-batch-tracked product; absent on a batch-tracked one is
   *  a finding, not a refusal (below). */
  readonly batchId?: string;
  /** The batch's use-by/expiry date (YYYY-MM-DD), where captured — carried for the recall record. */
  readonly batchExpiry?: string;
  /**
   * OB-35 "A": set ONLY by head office, when IT assigned this line's batch — the earliest-expiry batch on hand at the store
   * (FEFO) — because the till sent none. It says the batch is an ASSIGNMENT, not a scan. A till cannot claim it: head
   * office drops it from whatever arrives before it assigns anything.
   */
  readonly batchAssigned?: 'fefo';
  /** The HSN the lane priced this line under, FROZEN at the time of supply (from the pack it held). Carried
   *  so the GST return (GSTR-1, A5) files each sale under the HSN/rate that actually applied when it sold —
   *  correct even across a mid-period rate change. Absent on lanes that do not yet stamp it; the return then
   *  falls back to the current catalogue mapping. It is a record, never a control: a wrong/absent value can
   *  never refuse the sale (hard rule #1) — at worst the line surfaces as `unmapped` on the return. */
  readonly hsnCode?: string;
  /** The GST rate (basis points) the lane charged, frozen at the time of supply. Used with `hsnCode`. */
  readonly taxRateBps?: number;
  /**
   * The age check behind an age-restricted line (M12-FR-04 · Wave 2b audit PF-03): the age the line needed, the age the
   * customer was confirmed to be, and the signed-in person who checked and when. A record, never a control here — the
   * till refuses the sale without it; head office flags a restricted line that arrives without it (below).
   */
  readonly ageCheck?: {
    readonly minimumAge?: number;
    readonly confirmedAtLeast?: number;
    readonly confirmedBy?: string;
    readonly confirmedAt?: string;
  };
  /**
   * A price lowered at the till with a manager's approval (audit PF-07 · M12-FR-04): the unit price before, who approved
   * it and the till action that holds the evidence (on the loss-prevention record). A record, never a control.
   */
  readonly priceOverride?: {
    readonly fromUnitPriceMinor?: number;
    readonly approvedBy?: string;
    readonly activityId?: string;
  };
}

export interface IncomingTender {
  readonly kind: string;
  readonly amountMinor: number;
  /** A provider token or reference. Never a card number (hard rule #3). */
  readonly ref?: string;
  /** On a `loyalty_points` tender: the whole points the store computer took for this amount (PF-09 step 3). */
  readonly points?: number;
}

export interface IncomingSale {
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly laneId: string;
  /**
   * The stock location this lane sells from — the store's own location id in a single-site store
   * (M08-FR-01: a sale is a stock movement, and a movement names its location). Optional so no
   * existing till is refused (hard rule #1); when absent the cloud resolves it from the store the
   * sale's catalogue pack was published for, and only then from the lane (`sale-stock.ts`).
   */
  readonly locationId?: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly committedAt: string;
  readonly totalMinor: number;
  readonly currency: string;
  /** The catalogue pack the lane priced this sale from. The single most useful field here. */
  readonly packVersion: number;
  readonly lines: readonly IncomingSaleLine[];
  readonly tenders: readonly IncomingTender[];
  /**
   * The store computer's sealed stamp on the cashier it verified at the till (ADR-0023): who, how, which till, and the
   * box's seal over that and this sale. Untrusted as it arrives — head office checks the seal, never takes it on trust.
   */
  readonly operatorVerified?: { readonly userId?: unknown; readonly via?: unknown; readonly laneId?: unknown; readonly seal?: unknown };
  /**
   * The loyalty member the cashier named (PF-09 · OB-28 "1"): the member CODE the store computer made from the mobile
   * number keyed at the till — never the number itself (P-04). Optional: a walk-in buys with no personal data (M16-FR-01).
   */
  readonly customerRef?: string;
}

export type SaleExceptionKind =
  /** The lane sold something the cloud catalogue does not have. */
  | 'product_not_in_catalogue'
  /** The lane charged a different price from the current catalogue. Often correct — see below. */
  | 'price_differs_from_catalogue'
  /** The lane sold something since recalled. **Critical**: it is in a customer's hands. */
  | 'sold_a_recalled_product'
  /** A line was charged ABOVE the product's printed MRP. **Critical**: MRP is a legal ceiling in India. */
  | 'sold_above_mrp'
  /** A batch-tracked product was sold with no batch captured — the sale cannot be traced in a recall. */
  | 'batch_tracked_sold_without_batch'
  /** A line's captured batch was PAST its use-by date on the day it sold. **Critical**: a food-safety breach. */
  | 'sold_expired_batch'
  /** An age-restricted product was sold with no confirmed age check covering it (PF-03). **Critical**: possibly a minor. */
  | 'age_restricted_sold_without_check'
  /** The tenders do not add up to the total. Somebody's day will not balance. */
  | 'tender_does_not_sum_to_total'
  /** Priced from a pack far behind the current one. */
  | 'sold_on_a_stale_pack'
  /** Two different sales claiming one receipt number. */
  | 'receipt_number_reused'
  /** A commit time ahead of the server's clock — a lane whose clock is wrong. */
  | 'committed_in_the_future'
  /** Lines do not add up to the sale total. */
  | 'lines_do_not_sum_to_total'
  /** The sale names no cashier — nobody can be asked about it (SP-4b · F09 · §28 · hard rule #4). */
  | 'sale_names_no_cashier'
  /** The named cashier holds no grants in this shop — head office does not know them (F09). */
  | 'cashier_unknown'
  /** The named cashier holds no till authority (`pos.sale.sync`) — they should not have been signed in (F09 · §28). */
  | 'cashier_lacks_authority'
  /** The sale arrived without the store computer's seal on who rang it (ADR-0023 · PF-02): head office cannot confirm the
   *  named cashier was signed in at a till — an old store computer, or a record that never passed through a till. */
  | 'cashier_not_verified_at_store'
  /** The store computer's seal on who rang it does not match this sale (ADR-0023 · PF-02). **Critical**: the record was
   *  changed after the store sealed it, or the seal was copied from another sale. */
  | 'cashier_seal_does_not_match'
  /** The sale names no lane — the till was never told which lane it is (F09). */
  | 'sale_names_no_lane'
  /** The sale carries no trading day — it cannot be placed in a day's books (F09 · M01-FR-02). */
  | 'sale_names_no_trading_day'
  /** Points or store credit spent at the till that the member's true balance could not cover when the sale arrived —
   *  another channel spent the same value first (PF-09 step 3 · M17-FR-04 · hard rule #10). Valued; a person settles it. */
  | 'loyalty_value_spent_twice';

/** How fast a person has to act, which is not the same as how large the number is. */
export type ExceptionSeverity = 'critical' | 'material' | 'informational';

export interface SaleException {
  readonly kind: SaleExceptionKind;
  readonly severity: ExceptionSeverity;
  readonly saleId: string;
  readonly productId?: string;
  readonly differenceMinor?: number;
  readonly detail: string;
  readonly ownerAction: string;
}

export interface IntakeResult {
  /**
   * Typed as the literal `true`. A sale that reached this service happened, and no finding below
   * can un-happen it — the money is already in the drawer.
   */
  readonly banked: true;
  readonly saleId: string;
  readonly exceptions: readonly SaleException[];
  /** True when this exact sale had already been banked; the resend is not a second sale. */
  readonly alreadyBanked: boolean;
  readonly detail: string;
}

const SEVERITY_RANK: Readonly<Record<ExceptionSeverity, number>> = {
  critical: 0, material: 1, informational: 2,
};

export interface IntakeContext {
  /** The cloud catalogue as it stands now — which is not what the lane priced from. */
  readonly catalogue: ReadonlyMap<string, CatalogueProduct>;
  readonly currentPackVersion: number;
  /**
   * Which sale, if any, already holds this sale's receipt number — and whether this exact sale
   * has already been banked.
   *
   * These were a `Map` of every receipt number the shop has ever issued and a `Set` of every sale
   * it has ever made, from which this function took **one lookup each**. That is the whole of the
   * difference: a type that hands back the history obliges every implementation to read the
   * history, so no adapter written against it could be quick, and the cost was paid on every sale.
   * At 2,000 sales a day the till would have been waiting on a quarter of a million rows by month
   * three, for a two-word answer.
   */
  readonly saleHoldingThisReceipt: string | undefined;
  readonly alreadyBanked: boolean;
  readonly now: string;
  /** How many pack versions behind is worth mentioning. Per-tenant. Default 3. */
  readonly stalePackVersions?: number;
  /** Price difference below which nobody is told. Per-tenant. Default 0. */
  readonly priceToleranceMinor?: number;
  /**
   * The permissions the sale's named cashier holds through their grants in this tenant (SP-4b · F09): `null` when head
   * office has no such user, absent when nobody looked (no finding is raised then). Re-verified here, never taken on
   * the till's word — the same rule every relayed identity follows (§28 · hard rule #4).
   */
  readonly cashierGrants?: readonly string[] | null;
  /**
   * What head office made of the store computer's seal on the cashier (ADR-0023): there and matching, missing, or not
   * matching this sale. Absent when nobody checked (no seal key in this composition, or a sale banked at head office's
   * own desk) — then no finding is raised.
   */
  readonly cashierSeal?: 'verified' | 'missing' | 'does_not_match';
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The permission that says "may ring sales at a till" in the role catalogue (`cashier`, `store_manager`, `owner`). */
export const TILL_AUTHORITY = 'pos.sale.sync';

/**
 * Take a sale and say what is wrong with it — without ever declining it.
 *
 * Deterministic: no clock, no I/O. Everything the decision needs is in the context, so the same
 * sale and the same catalogue always produce the same findings.
 */
export function acceptSale(sale: IncomingSale, ctx: IntakeContext): IntakeResult {
  const exceptions: SaleException[] = [];
  const staleAfter = ctx.stalePackVersions ?? 3;
  const priceTolerance = ctx.priceToleranceMinor ?? 0;

  const add = (
    kind: SaleExceptionKind, severity: ExceptionSeverity, detail: string, ownerAction: string,
    extra: { productId?: string; differenceMinor?: number } = {},
  ): void => {
    exceptions.push({ kind, severity, saleId: sale.saleId, detail, ownerAction, ...extra });
  };

  // ── Arithmetic first. It needs no catalogue and it is never ambiguous. ──────
  const tendered = sale.tenders.reduce((t, x) => t + x.amountMinor, 0);
  if (tendered !== sale.totalMinor) {
    add('tender_does_not_sum_to_total', 'material',
      `the tenders add to ${tendered} against a total of ${sale.totalMinor}`,
      'This lane\'s day will not balance by that amount. Check the shift close before the cash is banked.',
      { differenceMinor: tendered - sale.totalMinor });
  }

  const lineSum = sale.lines.reduce((t, l) => t + l.lineTotalMinor, 0);
  if (sale.lines.length > 0 && lineSum !== sale.totalMinor) {
    add('lines_do_not_sum_to_total', 'material',
      `the lines add to ${lineSum} against a total of ${sale.totalMinor}`,
      'The receipt the customer holds does not add up. Keep it for the day-end review.',
      { differenceMinor: lineSum - sale.totalMinor });
  }

  // ── Who rang it, on which lane, on which day (SP-4b · F09). The money is real either way; a sale that ──────
  // ── names nobody, no lane or no day is one the shop cannot answer for, so each is a MATERIAL finding. ──────
  const cashierId = text(sale.cashierId);
  if (cashierId === '') {
    add('sale_names_no_cashier', 'material',
      'the sale names no cashier',
      'Nobody can be asked about this sale. Find out which till sent it and who was on it — a till must be signed in before it takes payment.');
  } else if (ctx.cashierGrants === null) {
    add('cashier_unknown', 'material',
      `cashier "${cashierId}" holds no grants in this shop`,
      'Head office does not know this staff code. Check who was on the till; a sale under an unknown name cannot be attributed to anyone.');
  } else if (ctx.cashierGrants !== undefined && !ctx.cashierGrants.includes(TILL_AUTHORITY)) {
    add('cashier_lacks_authority', 'material',
      `cashier "${cashierId}" holds no till authority`,
      'This person is not allowed to ring sales. Check who was on the till and why they were signed in.');
  }
  // ── Whether the store computer vouches for that cashier (ADR-0023 · PF-02): its seal over who it verified at the ──
  // ── till and this sale. Missing is material — nobody can say the person was at a till; a seal that does not ──────
  // ── match is critical — the record was changed after the store sealed it, or the seal belongs to another sale. ──
  if (cashierId !== '' && ctx.cashierSeal === 'missing') {
    add('cashier_not_verified_at_store', 'material',
      `the sale arrived without the store computer's seal on who rang it (named: "${cashierId}")`,
      'Head office cannot confirm this person was signed in at a till. Check which store computer sent it — an old one needs updating — or whether it was sent from somewhere other than a till.');
  } else if (cashierId !== '' && ctx.cashierSeal === 'does_not_match') {
    add('cashier_seal_does_not_match', 'critical',
      `the store computer's seal on who rang it does not match this sale (named: "${cashierId}")`,
      'Treat this sale as possibly altered after it was rung. Compare it with the store computer\'s own record and the receipt before anything is paid out or corrected.');
  }
  if (text(sale.laneId) === '') {
    add('sale_names_no_lane', 'material',
      'the sale names no lane',
      'The till was never told which lane it is. Set EDGE_LANE_ID on that store computer.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(sale.tradingDay))) {
    add('sale_names_no_trading_day', 'material',
      `the sale carries no trading day ("${text(sale.tradingDay)}")`,
      'It cannot be placed in a day\'s books until the till dates its sales. Check that store computer\'s cut-off setting and clock.');
  }

  // ── The catalogue. Every finding here is "the lane and the cloud disagree", ──
  // ── and the lane is not automatically the one that is wrong. ────────────────
  for (const line of sale.lines) {
    const product = ctx.catalogue.get(line.productId);

    if (product === undefined) {
      add('product_not_in_catalogue', 'material',
        `${line.productId} was sold and is not in the catalogue`,
        'Either it was added at the lane or the catalogue has lost it. The sale stands either way — find out which before the stock figure is trusted.',
        { productId: line.productId });
      continue;
    }

    if (product.recallBlock === true) {
      // The one finding on this list that is about a person rather than a number.
      add('sold_a_recalled_product', 'critical',
        `${product.sku} is recall-blocked and this lane sold it — its pack (v${sale.packVersion}) predates the block`,
        `ACT NOW: ${product.sku} is in a customer's hands. Check whether the receipt identifies them, and follow the recall procedure. Then confirm every lane has taken the pack that blocks it.`,
        { productId: line.productId });
    }

    // A lot/batch-tracked good (perishable, pharma) must carry its batch so a recall can trace who
    // bought it (M10-FR-03). Sold without one, the sale still stands — but that unit is now untraceable,
    // which a recall needs to know before it trusts the trace, so it is a finding (hard rule #10, P-08).
    if (product.batchTracked === true && (typeof line.batchId !== 'string' || line.batchId.trim() === '')) {
      add('batch_tracked_sold_without_batch', 'material',
        `${product.sku} is lot/batch-tracked and was sold with no batch captured`,
        'This unit cannot be traced to a batch, so a recall could not tell whether it was affected. Check that the lane is capturing the batch for this product.',
        { productId: line.productId });
    }

    // A batch sold PAST its use-by date (B8 / M10·M12). The expiry date is the LAST sellable day, so a
    // sale strictly after it is expired stock in a customer's hands — a food-safety breach (FSSAI), not a
    // stock note. The sale still stands (the money is in the drawer, hard rule #1), but it is surfaced
    // CRITICAL, ranked with a recall. The offline till's own FEFO-at-scan block is the primary defence;
    // this is the cloud's backstop, catching anything that slipped it.
    if (/^\d{4}-\d{2}-\d{2}$/.test(line.batchExpiry ?? '') && (line.batchExpiry as string) < sale.tradingDay) {
      add('sold_expired_batch', 'critical',
        `${product.sku} batch ${line.batchId ?? '(unnamed)'} expired on ${line.batchExpiry} and was sold on ${sale.tradingDay} — past-use-by stock`,
        `ACT NOW: expired stock reached a customer. Check whether the receipt identifies them, pull the batch from the shelf, and find why the lane did not block it at scan.`,
        { productId: line.productId });
    }

    // An AGE-RESTRICTED product sold with no confirmed check covering its age (M12-FR-04 · Wave 2b audit PF-03). The till
    // refuses such a sale before the money; this is head office's backstop for anything that slipped it — an old till, a
    // product restricted after the lane's pack was built, an answer for a lower age. The sale stands (the goods are gone,
    // hard rule #1), so it is surfaced CRITICAL, ranked with a recall: a minor may have been sold alcohol or tobacco.
    const requiredAge = minimumAgeOf(product);
    if (requiredAge !== undefined) {
      const check = line.ageCheck;
      const confirmedAge = typeof check?.confirmedAtLeast === 'number' ? check.confirmedAtLeast : 0;
      const confirmer = typeof check?.confirmedBy === 'string' ? check.confirmedBy.trim() : '';
      if (confirmedAge < requiredAge || confirmer === '') {
        add('age_restricted_sold_without_check', 'critical',
          check === undefined
            ? `${product.sku} is restricted to ${requiredAge}+ and was sold with no age check recorded`
            : confirmer === ''
              ? `${product.sku} is restricted to ${requiredAge}+ and its age check names nobody`
              : `${product.sku} is restricted to ${requiredAge}+ but the customer was only confirmed ${confirmedAge}+`,
          'ACT NOW: an age-restricted item may have been sold to someone under age. Ask the cashier on that bill what was checked, and find why the till did not stop the sale (an old till, or a pack that predates the restriction).',
          { productId: line.productId });
      }
    }

    // Charged ABOVE the printed MRP (B1 / M03·M12). MRP is a LEGAL CEILING in India, not a shop policy,
    // so this is never an ordinary price variance and never a stale-pack excuse — it is a prosecution
    // risk with a customer overcharged right now. The sale still stands (the money is in the drawer, hard
    // rule #1), but it is surfaced CRITICAL, ranked with a recall, and no approval can bless it (there is
    // no override anywhere — the price-setting surface refuses it too, price-guard `above_mrp`). It
    // subsumes the ordinary price-difference finding for this line, so the overcharge is not buried in it.
    const aboveMrp = product.mrpMinor !== undefined && line.unitPriceMinor > product.mrpMinor;
    if (aboveMrp) {
      add('sold_above_mrp', 'critical',
        `${product.sku} was charged at ${line.unitPriceMinor}, above its printed MRP of ${product.mrpMinor} — an illegal overcharge`,
        `ACT NOW: the customer was charged above MRP, which is a legal breach. Refund the difference and keep the receipt, then find how a price above MRP reached this lane (a pack must never carry one).`,
        { productId: line.productId, differenceMinor: line.unitPriceMinor - (product.mrpMinor ?? 0) });
    }

    const difference = line.unitPriceMinor - product.unitPriceMinor;
    // A price the till LOWERED with a manager's approval (PF-07) from the catalogue's own price is explained by that
    // approval: still listed, as informational, naming who approved it and the evidence — never "check the lane".
    const override = line.priceOverride;
    const approvedOverride = override !== undefined && typeof override.approvedBy === 'string' && override.approvedBy.trim() !== ''
      && typeof override.fromUnitPriceMinor === 'number' && Math.abs(override.fromUnitPriceMinor - product.unitPriceMinor) <= priceTolerance
      && line.unitPriceMinor < override.fromUnitPriceMinor;
    if (!aboveMrp && approvedOverride && Math.abs(difference) > priceTolerance) {
      add('price_differs_from_catalogue', 'informational',
        `${product.sku} was charged at ${line.unitPriceMinor}, lowered at the till from ${product.unitPriceMinor} with ${override!.approvedBy}'s approval`,
        `A manager approved this price change at the till; the evidence is on the loss-prevention record${typeof override!.activityId === 'string' ? ` (${override!.activityId})` : ''}. Nothing to do unless the store's override rules raise it.`,
        { productId: line.productId, differenceMinor: difference });
    } else if (!aboveMrp && Math.abs(difference) > priceTolerance) {
      // Usually nobody's fault: the lane priced from the pack it held, which is exactly what it is
      // supposed to do offline. The pack version says whether that explains it.
      const behind = ctx.currentPackVersion - sale.packVersion;
      add('price_differs_from_catalogue', behind > 0 ? 'informational' : 'material',
        `${product.sku} was charged at ${line.unitPriceMinor} and the catalogue now says ${product.unitPriceMinor}`,
        behind > 0
          ? `The lane was ${behind} pack version(s) behind, which is the ordinary explanation — it charged what it held. Nothing to do unless the difference is large.`
          : 'The lane was on the current pack and still charged a different price. That is not a timing difference — check the lane.',
        { productId: line.productId, differenceMinor: difference });
    }
  }

  // ── The lane's own state ───────────────────────────────────────────────────
  const behind = ctx.currentPackVersion - sale.packVersion;
  if (behind > staleAfter) {
    add('sold_on_a_stale_pack', 'material',
      `priced from catalogue v${sale.packVersion}; current is v${ctx.currentPackVersion}`,
      `This lane has not taken a pack in ${behind} versions. It is still selling — that is by design — but at prices that old. Check why its updates are not arriving.`);
  }

  if (Date.parse(sale.committedAt) > Date.parse(ctx.now)) {
    add('committed_in_the_future', 'material',
      `committed at ${sale.committedAt}, which is ahead of ${ctx.now}`,
      'This lane\'s clock is wrong. Its sales will land in the wrong trading day until it is fixed.');
  }

  const heldBy = ctx.saleHoldingThisReceipt;
  if (heldBy !== undefined && heldBy !== sale.saleId) {
    add('receipt_number_reused', 'material',
      `receipt ${sale.receiptNumber} already belongs to sale ${heldBy}`,
      'Two sales carry one receipt number, so a customer returning goods cannot be matched to the right one. Both sales stand; the numbering needs looking at.');
  }

  const alreadyBanked = ctx.alreadyBanked;

  return {
    banked: true,
    saleId: sale.saleId,
    // Worst first: severity, then value. A critical finding worth ₹40 outranks a ₹4,000 one that
    // can wait until Monday, because one of them is about a customer.
    exceptions: [...exceptions].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      || Math.abs(b.differenceMinor ?? 0) - Math.abs(a.differenceMinor ?? 0)),
    alreadyBanked,
    detail: alreadyBanked
      ? `sale ${sale.saleId} was already banked; this is a resend, not a second sale`
      : exceptions.length === 0
        ? `sale ${sale.saleId} banked, nothing to report`
        : `sale ${sale.saleId} banked with ${exceptions.length} exception(s) — the sale stands; the findings are work`,
  };
}

export interface IntakeSummary {
  readonly banked: number;
  readonly resends: number;
  readonly critical: readonly SaleException[];
  readonly material: readonly SaleException[];
  readonly informational: number;
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * The position after a batch — a lane coming back from three days offline sends hundreds at once.
 *
 * Informational findings are **counted, not listed**. A lane that was offline for three days
 * produces one price-difference finding per line it sold, all of them explained by the pack it
 * held, and printing them buries the one that is not.
 */
export function summariseIntake(results: readonly IntakeResult[]): IntakeSummary {
  const all = results.flatMap((r) => r.exceptions);
  const critical = all.filter((e) => e.severity === 'critical');
  const material = all.filter((e) => e.severity === 'material');
  const informational = all.filter((e) => e.severity === 'informational').length;
  const resends = results.filter((r) => r.alreadyBanked).length;

  return {
    banked: results.length - resends,
    resends,
    critical,
    material,
    informational,
    detail: `${results.length - resends} sale(s) banked, ${resends} resend(s) collapsed, ${critical.length} critical and ${material.length} material finding(s), ${informational} informational`,
    ownerAction: critical.length > 0
      ? `${critical.length} finding(s) need acting on now, not at day end: ${critical.map((e) => e.detail).join('; ')}`
      : material.length > 0
        ? `${material.length} finding(s) for the day-end review. Every sale is banked — these are differences to settle, not sales to chase`
        : 'nothing — every sale came in clean',
  };
}
