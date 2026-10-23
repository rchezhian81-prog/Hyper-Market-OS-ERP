// Blanket purchase orders (M06-FR-02 "… PO, blanket PO and approvals"). A blanket PO is a standing AGREEMENT with one
// supplier: the products it covers at agreed prices, a value ceiling, optional quantity ceilings per product, and a validity
// window. It commits no money by itself — money is committed only by its CALL-OFF RELEASES, each of which is an ordinary
// purchase order, proposed by a buyer and approved and issued by a second person exactly like any other PO (§28).
//
// The rules this engine holds, so every release is judged the same way online and at approval:
//
//   • An agreement is usable only once a SECOND person approved it (never its proposer), and only inside its validity
//     window (YYYY-MM-DD, inclusive). An agreement waiting for approval, or not yet valid, or expired, releases nothing.
//   • A release names products ON the agreement only, at the AGREED price (the price is the agreement's, never the
//     release's — a buyer cannot quietly re-price a standing deal at call-off).
//   • The DRAWDOWN is what the releases already hold: an issued release counts what it still commits plus what it already
//     received (ordered − cancelled), valued at the agreed cost; a proposed release counts in full while it waits (so two
//     releases raised at once can never together pass the ceiling). A release that would take the drawdown past the
//     value ceiling — or past a product's quantity ceiling — is refused by name, with what is left.
//   • Cancelling part of an issued release gives that value back to the agreement (it is no longer committed).
//
// Pure and deterministic; composes Money and the OB-31/OB-46 cost rule (`valueAtCost`). No clock: the date is injected.

import { valueAtCost } from '../../contracts/src/quantity';
import type { CurrencyCode, Money } from '../../contracts/src/money';
import type { PurchaseOrderLineInput } from './purchasing';

export interface BlanketLine {
  readonly productId: string;
  /** The agreed cost per whole unit (or, OB-46, per `per` whole units). */
  readonly agreedUnitCost: Money & { readonly per?: number };
  /** OB-31: the product's unit as the master names it; absent ⇒ whole items. */
  readonly uom?: string;
  /** Optional ceiling on the quantity released for this product, in its smallest steps. */
  readonly maxQty?: number;
}

export interface BlanketAgreement {
  readonly agreementId: string;
  readonly supplierId: string;
  readonly currency: CurrencyCode;
  /** The most the releases may commit in all, in minor units. */
  readonly ceilingMinor: number;
  /** YYYY-MM-DD, inclusive. */
  readonly validFrom: string;
  readonly validTo: string;
  readonly lines: readonly BlanketLine[];
  /** The buyer who proposed it — server-attributed. */
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly status: 'proposed' | 'approved';
  /** The second person who approved it — never the proposer (§28). */
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  /** OB-37: the store releases are delivered to by default (a release may name its own). */
  readonly deliverToLocationId?: string;
}

/** A release as the drawdown reads it — one purchase order raised against the agreement. */
export interface BlanketRelease {
  readonly poId: string;
  readonly status: 'proposed' | 'issued';
  readonly lines: readonly PurchaseOrderLineInput[];
  readonly cancelledByProduct: Readonly<Record<string, number>>;
}

export type AgreementProblem =
  | 'no_lines' | 'bad_ceiling' | 'bad_dates' | 'ends_before_it_starts' | 'duplicate_product'
  | 'bad_line' | 'currency_mismatch';

const isDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00.000Z`))
  && new Date(Date.parse(`${d}T00:00:00.000Z`)).toISOString().slice(0, 10) === d;

/** Every reason an agreement cannot be recorded — empty when it can. */
export function agreementProblems(a: Pick<BlanketAgreement, 'currency' | 'ceilingMinor' | 'validFrom' | 'validTo' | 'lines'>): readonly AgreementProblem[] {
  const out: AgreementProblem[] = [];
  if (a.lines.length === 0) out.push('no_lines');
  if (!Number.isSafeInteger(a.ceilingMinor) || a.ceilingMinor <= 0) out.push('bad_ceiling');
  if (!isDate(a.validFrom) || !isDate(a.validTo)) out.push('bad_dates');
  else if (a.validTo < a.validFrom) out.push('ends_before_it_starts');
  const seen = new Set<string>();
  for (const l of a.lines) {
    if (seen.has(l.productId)) out.push('duplicate_product');
    seen.add(l.productId);
    const per = l.agreedUnitCost.per;
    if (l.productId.trim() === '' || !Number.isSafeInteger(l.agreedUnitCost.minor) || l.agreedUnitCost.minor < 0
      || (per !== undefined && (!Number.isSafeInteger(per) || per < 2))
      || (l.maxQty !== undefined && (!Number.isSafeInteger(l.maxQty) || l.maxQty <= 0))) out.push('bad_line');
    if (l.agreedUnitCost.currency !== a.currency) out.push('currency_mismatch');
  }
  return [...new Set(out)];
}

const lineValue = (qty: number, l: Pick<PurchaseOrderLineInput, 'uom' | 'unitCost'>): number => valueAtCost(qty, l.uom ?? 'ea', l.unitCost);

/** What one release holds against the agreement: issued ⇒ ordered − cancelled; proposed ⇒ all of it. */
function heldBy(release: BlanketRelease): { readonly valueMinor: number; readonly qtyByProduct: Readonly<Record<string, number>> } {
  const qty: Record<string, number> = {};
  let value = 0;
  for (const l of release.lines) {
    const cancelled = release.status === 'issued' ? Math.min(l.orderedQty, release.cancelledByProduct[l.productId] ?? 0) : 0;
    const held = l.orderedQty - cancelled;
    qty[l.productId] = (qty[l.productId] ?? 0) + held;
    value += lineValue(held, l);
  }
  return { valueMinor: value, qtyByProduct: qty };
}

export interface BlanketDrawdown {
  readonly agreementId: string;
  readonly ceilingMinor: number;
  /** Issued releases: ordered − cancelled, at the agreed cost. */
  readonly issuedMinor: number;
  /** Releases still waiting for their second person. */
  readonly pendingMinor: number;
  readonly remainingMinor: number;
  readonly releases: number;
  readonly byProduct: readonly { readonly productId: string; readonly maxQty: number | null; readonly releasedQty: number; readonly remainingQty: number | null }[];
}

/** The agreement's drawdown over its releases (control by exception: what is left is said, never assumed). */
export function blanketDrawdown(agreement: BlanketAgreement, releases: readonly BlanketRelease[]): BlanketDrawdown {
  let issued = 0;
  let pending = 0;
  const qty: Record<string, number> = {};
  for (const r of releases) {
    const h = heldBy(r);
    if (r.status === 'issued') issued += h.valueMinor; else pending += h.valueMinor;
    for (const [p, q] of Object.entries(h.qtyByProduct)) qty[p] = (qty[p] ?? 0) + q;
  }
  return {
    agreementId: agreement.agreementId, ceilingMinor: agreement.ceilingMinor, issuedMinor: issued, pendingMinor: pending,
    remainingMinor: agreement.ceilingMinor - issued - pending, releases: releases.length,
    byProduct: agreement.lines.map((l) => ({
      productId: l.productId, maxQty: l.maxQty ?? null, releasedQty: qty[l.productId] ?? 0,
      remainingQty: l.maxQty === undefined ? null : l.maxQty - (qty[l.productId] ?? 0),
    })),
  };
}

export type CallOffRefusal =
  | 'agreement_not_approved' | 'outside_validity' | 'no_lines' | 'bad_quantity' | 'product_not_on_agreement'
  | 'ceiling_exceeded' | 'quantity_ceiling_exceeded';

export type CallOffJudgement =
  | { readonly ok: true; readonly lines: readonly PurchaseOrderLineInput[]; readonly valueMinor: number; readonly remainingAfterMinor: number }
  | { readonly ok: false; readonly refusal: CallOffRefusal; readonly detail: string; readonly productId?: string };

/**
 * Judge one call-off release against the agreement and the OTHER releases already raised on it (the release being judged
 * must not be among `others`). On success the release's lines are priced at the agreement's cost — never the caller's.
 */
export function judgeCallOff(input: {
  readonly agreement: BlanketAgreement;
  readonly others: readonly BlanketRelease[];
  readonly onDate: string;
  readonly lines: readonly { readonly productId: string; readonly quantity: number }[];
}): CallOffJudgement {
  const a = input.agreement;
  if (a.status !== 'approved' || a.approvedBy === null) {
    return { ok: false, refusal: 'agreement_not_approved', detail: `blanket agreement ${a.agreementId} has not been approved by a second person, so nothing can be released against it` };
  }
  if (input.onDate < a.validFrom || input.onDate > a.validTo) {
    return { ok: false, refusal: 'outside_validity', detail: `blanket agreement ${a.agreementId} is valid ${a.validFrom} to ${a.validTo}; ${input.onDate} is outside it` };
  }
  if (input.lines.length === 0) return { ok: false, refusal: 'no_lines', detail: 'a release needs at least one line' };
  const merged = new Map<string, number>();
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity <= 0) return { ok: false, refusal: 'bad_quantity', detail: `${l.productId}: a release quantity is whole and more than 0`, productId: l.productId };
    merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.quantity);
  }
  const priced: PurchaseOrderLineInput[] = [];
  for (const [productId, quantity] of merged) {
    const term = a.lines.find((l) => l.productId === productId);
    if (term === undefined) {
      return { ok: false, refusal: 'product_not_on_agreement', detail: `${productId} is not on blanket agreement ${a.agreementId}; raise an ordinary purchase order for it`, productId };
    }
    priced.push({ productId, orderedQty: quantity, unitCost: term.agreedUnitCost, ...(term.uom === undefined ? {} : { uom: term.uom }) });
  }
  const before = blanketDrawdown(a, input.others);
  const valueMinor = priced.reduce((s, l) => s + lineValue(l.orderedQty, l), 0);
  for (const l of priced) {
    const row = before.byProduct.find((r) => r.productId === l.productId);
    if (row !== undefined && row.remainingQty !== null && l.orderedQty > row.remainingQty) {
      return {
        ok: false, refusal: 'quantity_ceiling_exceeded', productId: l.productId,
        detail: `${l.productId}: the agreement allows ${row.maxQty} in all, ${row.releasedQty} is already released, so at most ${Math.max(0, row.remainingQty)} more — this release asks ${l.orderedQty}`,
      };
    }
  }
  if (valueMinor > before.remainingMinor) {
    return {
      ok: false, refusal: 'ceiling_exceeded',
      detail: `blanket agreement ${a.agreementId} has a ceiling of ${a.ceilingMinor}; ${before.issuedMinor + before.pendingMinor} is already released, leaving ${Math.max(0, before.remainingMinor)} — this release is worth ${valueMinor}`,
    };
  }
  return { ok: true, lines: priced, valueMinor, remainingAfterMinor: before.remainingMinor - valueMinor };
}
