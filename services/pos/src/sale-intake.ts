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

import type { CatalogueProduct } from '../../../packages/catalogue/src/catalogue';

export interface IncomingSaleLine {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  /** What the lane actually charged, per unit. Not what anything thinks it should have been. */
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
}

export interface IncomingTender {
  readonly kind: string;
  readonly amountMinor: number;
  /** A provider token or reference. Never a card number (hard rule #3). */
  readonly ref?: string;
}

export interface IncomingSale {
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly committedAt: string;
  readonly totalMinor: number;
  readonly currency: string;
  /** The catalogue pack the lane priced this sale from. The single most useful field here. */
  readonly packVersion: number;
  readonly lines: readonly IncomingSaleLine[];
  readonly tenders: readonly IncomingTender[];
}

export type SaleExceptionKind =
  /** The lane sold something the cloud catalogue does not have. */
  | 'product_not_in_catalogue'
  /** The lane charged a different price from the current catalogue. Often correct — see below. */
  | 'price_differs_from_catalogue'
  /** The lane sold something since recalled. **Critical**: it is in a customer's hands. */
  | 'sold_a_recalled_product'
  /** The tenders do not add up to the total. Somebody's day will not balance. */
  | 'tender_does_not_sum_to_total'
  /** Priced from a pack far behind the current one. */
  | 'sold_on_a_stale_pack'
  /** Two different sales claiming one receipt number. */
  | 'receipt_number_reused'
  /** A commit time ahead of the server's clock — a lane whose clock is wrong. */
  | 'committed_in_the_future'
  /** Lines do not add up to the sale total. */
  | 'lines_do_not_sum_to_total';

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
  /** Receipt numbers already banked, and which sale each belongs to. */
  readonly receiptNumbers: ReadonlyMap<string, string>;
  readonly alreadyBanked: ReadonlySet<string>;
  readonly now: string;
  /** How many pack versions behind is worth mentioning. Per-tenant. Default 3. */
  readonly stalePackVersions?: number;
  /** Price difference below which nobody is told. Per-tenant. Default 0. */
  readonly priceToleranceMinor?: number;
}

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

    const difference = line.unitPriceMinor - product.unitPriceMinor;
    if (Math.abs(difference) > priceTolerance) {
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

  const heldBy = ctx.receiptNumbers.get(sale.receiptNumber);
  if (heldBy !== undefined && heldBy !== sale.saleId) {
    add('receipt_number_reused', 'material',
      `receipt ${sale.receiptNumber} already belongs to sale ${heldBy}`,
      'Two sales carry one receipt number, so a customer returning goods cannot be matched to the right one. Both sales stand; the numbering needs looking at.');
  }

  const alreadyBanked = ctx.alreadyBanked.has(sale.saleId);

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
