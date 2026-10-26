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

import { isStoreComputerDefaultReceipt } from '../../../packages/contracts/src/receipt-number';
import { minimumAgeOf, type CatalogueProduct } from '../../../packages/catalogue/src/catalogue';
import { productRuleRefusals, lineIsWeighed, isWeighedUom } from '../../../packages/restricted-sales/src/till-gate';
import { weighingScaleVerification, InvalidScaleVerification } from '../../../packages/facilities/src/weighing-verification';
import type { CardTokenReference } from '../../../packages/tender/src/card-token';
import { withoutCardData, cardDataRemovalWords } from '../../../packages/tender/src/tender-card-data';

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
  /**
   * B6: the scales the lane took weight from for a WEIGHED line, and the last day each stamp was valid, as the till's gate
   * checked them (`till-gate.ts` `scaleEvidence`). A record, never a control here — the till and its store computer refuse
   * the line; head office flags a weighed line without it, or with a stamp that had lapsed.
   */
  readonly scaleCheck?: { readonly checkedOn?: string; readonly scales?: readonly { readonly assetId?: string; readonly reverificationDueOn?: string }[] };
  /** B13 (OB-138): the hallmark HUID of the gold piece sold on this line, as the till printed it on the bill. A record. */
  readonly huid?: string;
  /** A7: the compensation cess the line was charged under (frozen from the lane's pack), and what it came to. A record. */
  readonly cess?: { readonly advaloremBps?: number; readonly specificPerQuantityMinor?: number; readonly perQuantity?: number };
  readonly cessMinor?: number;
  /** B8 (OB-298): who confirmed the date printed on a perishable's pack at the till, and when. A record. */
  readonly packDateCheck?: { readonly confirmedBy?: string; readonly confirmedAt?: string };
  /**
   * OB-306 (M03-FR-02): when the line is an own-barcode BUNDLE, the till's explosion of it from its signed pack — the bundle,
   * the definition version and what each component took off the shelf. Head office writes one `sold` movement per component
   * from it (`sale-stock.ts`). A record; a malformed one is ignored and the line moves as itself.
   */
  readonly bundle?: { readonly bundleProductId?: string; readonly version?: number; readonly components?: readonly { readonly productId?: string; readonly quantityMinor?: number; readonly uom?: string }[] };
  /** B14: the pack size a tobacco line was judged against at the till. A record. */
  readonly packCheck?: { readonly packMinimumMinor?: number };
  /** B19: a carry-bag line's material and thickness as the till judged them. A record. */
  readonly carryBag?: { readonly material?: string; readonly thicknessMicrons?: number };
}

export interface IncomingTender {
  readonly kind: string;
  readonly amountMinor: number;
  /** A provider token or reference. Never a card number (hard rule #3): one shaped like it is removed before banking. */
  readonly ref?: string;
  /**
   * OB-271 · audit A9: on a card/UPI tender in real trading, the approval / reference number the shop's OWN machine showed
   * (OB-274: 4–20 letters or digits from any machine, typed from the slip; never card data) — what the day is matched against the machine's slip by.
   */
  readonly machineRef?: string;
  /** On a `loyalty_points` tender: the whole points the store computer took for this amount (PF-09 step 3). */
  readonly points?: number;
  /** C10: on a card tender, the ONLY card facts kept — the network-token reference, the last four digits, the network. */
  readonly card?: CardTokenReference;
  /**
   * NEW-3 (C10): the store computer REMOVED card data the till sent with this tender, before its disk — field names only,
   * never the values. Written by the store computer (one a till sends is dropped there); head office raises it, critical.
   */
  readonly cardDataRemoved?: { readonly fields?: readonly string[] };
}

export interface IncomingSale {
  /**
   * OB-299 (M12-FR-02): the customer paid in full at the till and the bill is to be DELIVERED — the delivery-fee product and
   * what its line charged. Head office books it as one delivery job after banking (`deliveryOnSale`). A record.
   */
  readonly delivery?: { readonly requested: true; readonly feeProductId?: string; readonly feeMinor?: number };
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
   * OB-279 (real trading): what rounding the bill's CGST and SGST to the rupee added (+) or took off (−) — at most ₹1 either
   * way. The total is the lines plus this. Absent on every other bill.
   */
  readonly roundOffMinor?: number;
  /**
   * The store computer's sealed stamp on the cashier it verified at the till (ADR-0023): who, how, which till, and the
   * box's seal over that and this sale. Untrusted as it arrives — head office checks the seal, never takes it on trust.
   */
  readonly operatorVerified?: { readonly userId?: unknown; readonly via?: unknown; readonly laneId?: unknown; readonly seal?: unknown };
  /**
   * Round 29 · OB-108: when the STORE COMPUTER took this bill from the till and wrote it to its disk — by the store computer's
   * own clock (the clock its health reports are written by). Untrusted as it arrives: head office keeps it on the bill's
   * receipt-number index only when it is a well-formed time, never later than head office received the bill. Not part of
   * what makes a bill the same bill (`billFingerprint`): an older store computer sends none.
   */
  readonly storeComputerTakenAt?: string;
  /**
   * Round 35 · verifier r34 NEW-6: a store-computer time that was sent but NOT kept, because the sale did not come from the
   * store computer's own sign-in (written by head office, never trusted from the body: a sent one is replaced).
   */
  readonly storeComputerTakenAtIgnored?: { readonly offered: string; readonly by: string; readonly why: string };
  /**
   * The loyalty member the cashier named (PF-09 · OB-28 "1"): the member CODE the store computer made from the mobile
   * number keyed at the till — never the number itself (P-04). Optional: a walk-in buys with no personal data (M16-FR-01).
   */
  readonly customerRef?: string;
  /**
   * OB-264 (owner, 20 Oct 2026, "Key old bill number"): in the mirror pilot, the OLD ERP's bill number for the same
   * customer's bill — the legal invoice (OB-248) — keyed at the till, so a mirror refund finds the sale by it and the
   * day book lists it. Kept only in its checked form (`packages/tender/src/old-erp-bill-number.ts`); anything else is
   * dropped before banking and `oldErpBillNumberIgnored` says so (never the value: it may be a customer's number).
   */
  readonly oldErpBillNumber?: string;
  /** OB-264: an old bill number was sent but not kept, and why (written by head office; one sent in the body is dropped). */
  readonly oldErpBillNumberIgnored?: { readonly why: 'not_an_old_bill_number' };
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
  /**
   * B8 (OB-298): a perishable sold with neither a date in its barcode nor the cashier's pack-date confirmation on the line —
   * an older till, or a product made perishable after the lane's pack was built. Material: nobody looked at the date.
   */
  | 'perishable_sold_without_date_check'
  /**
   * A7: head office's own catalogue says the product carries a GST Compensation Cess, and the line arrived with none — an
   * older till, or a pack from before the cess. Material: the cess is under-declared on the return until it is corrected.
   */
  | 'cess_not_on_the_line'
  /** An age-restricted product was sold with no confirmed age check covering it (PF-03). **Critical**: possibly a minor. */
  | 'age_restricted_sold_without_check'
  /** B19: a banned single-use plastic, a carry bag below 120 µm, or a carry bag given free — or (OB-173) charged below its
   *  list price — was sold. **Critical**: unlawful / against the owner's written rule. */
  | 'unlawful_plastic_sold'
  /** B14: a tobacco line below one whole pack, or not a whole number of packs (OB-160), was sold — loose cigarettes.
   *  **Critical**: COTPA s.7. */
  | 'tobacco_sold_below_pack'
  /** B17 · OB-348: liquor was sold — refused by the shop's state (Tamil Nadu: TASMAC). **Critical**: against state law. */
  | 'liquor_sold'
  /** B18 · OB-310: a medicine was sold — SRE sells no medicines (no drug licence). **Critical**: against the Drugs and Cosmetics Act. */
  | 'medicine_sold'
  /** B13 (OB-138): a gold piece was sold with no hallmark HUID on head office's product. **Critical**: BIS hallmarking. */
  | 'gold_sold_without_huid'
  /** B13: a HUID head office already holds a sale for was sold again — one hallmarked piece, sold twice. **Critical**. */
  | 'gold_huid_sold_twice'
  /** B6: a weighed line came with no scale evidence, or its scale's Legal Metrology stamp had lapsed when it sold. Judged
   *  against head office's OWN scale register where it is wired (L3), not only the till's claim. */
  | 'weighed_on_unverified_scale'
  /** NEW-2 (B6): a line's unit is not the product's unit in head office's catalogue (a weighed product sent as "L" or "ea"). */
  | 'unit_differs_from_catalogue'
  /** NEW-3 (C10 · hard rule #3): a tender arrived carrying card data a tender may not keep (a card number, a security
   *  code, an expiry, any field beyond token / last four / network). **Critical**. It was removed before banking. */
  | 'card_data_in_tender'
  /** B5: a weighed line was charged more than weighed quantity × the price per kg (rounded against the customer). */
  | 'weighed_line_charged_above_weight_times_price'
  /** The tenders do not add up to the total. Somebody's day will not balance. */
  | 'tender_does_not_sum_to_total'
  /** Priced from a pack far behind the current one. */
  | 'sold_on_a_stale_pack'
  /** Two different sales claiming one receipt number. */
  | 'receipt_number_reused'
  /** OB-81: numbered under the store computer's own store prefix — head office never issued the till one (multi-store). */
  | 'receipt_numbered_without_issued_prefix'
  /** A commit time ahead of the server's clock — a lane whose clock is wrong. */
  | 'committed_in_the_future'
  /** Lines do not add up to the sale total. */
  | 'lines_do_not_sum_to_total'
  /** Verifier r2final NEW-2: a line was recorded below zero — a negative taxable value and negative GST, which no return
   *  can file. An offer spread onto a line more than the line charged. */
  | 'line_charged_below_zero'
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
  | 'loyalty_value_spent_twice'
  /** Verifier r20 IC-3: a bill head office did NOT bank (a different bill already holds its sale id) carried a member, points
   *  or store credit. Loyalty follows only the banked bill; this one's is raised for a person to settle when it is banked. */
  | 'loyalty_on_a_bill_not_banked';

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
  /**
   * L3 (B6): head office's OWN scale register for the lane this sale came from — the scales it says weigh for that lane and
   * the last day each stamp is valid. A weighed line is judged against THIS, on the sale's trading day, not against what
   * the till claimed. Absent when the composition has no register (then the till's evidence is judged, as before).
   */
  readonly laneScalesOnRegister?: readonly { readonly assetId: string; readonly reverificationDueOn: string }[];
  /**
   * B13 (OB-138): for each HUID this sale carries, the OTHER sale head office already banked it on (absent when none) —
   * the cloud's backstop for a piece sold at another store, or by a till whose store computer did not know.
   */
  readonly huidsSoldElsewhere?: ReadonlyMap<string, string>;
  /** OB-348 (B17): the shop's state from store setup — liquor is judged by its rule. Absent → "not set" (still refused). */
  readonly shopState?: string;
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

  // OB-279 · OB-285: a real-trading bill's total is its lines plus the stated round off — below 0 and at most ₹1, since a
  // bill is never above its lines; any other round off is not counted, so the bill shows as not adding up.
  const roundOff = Number.isSafeInteger(sale.roundOffMinor) && (sale.roundOffMinor as number) <= 0 && (sale.roundOffMinor as number) >= -100 ? sale.roundOffMinor as number : 0;
  const lineSum = sale.lines.reduce((t, l) => t + l.lineTotalMinor, 0) + roundOff;
  if (sale.lines.length > 0 && lineSum !== sale.totalMinor) {
    add('lines_do_not_sum_to_total', 'material',
      `the lines add to ${lineSum} against a total of ${sale.totalMinor}`,
      'The receipt the customer holds does not add up. Keep it for the day-end review.',
      { differenceMinor: lineSum - sale.totalMinor });
  }

  // NEW-2: a line below zero is never a sale anybody made — it is an offer spread past what the line charged.
  for (const l of sale.lines) {
    if (typeof l.lineTotalMinor === 'number' && l.lineTotalMinor < 0) {
      add('line_charged_below_zero', 'material',
        `${l.productId} was recorded at ${l.lineTotalMinor} — below zero, so its taxable value and GST are negative`,
        'This bill cannot be filed as it stands. Find which till sent it (an old till spread an offer by the price per kg) and correct the GST record for that bill.',
        { productId: l.productId, differenceMinor: l.lineTotalMinor });
    }
  }

  // ── Card data on a tender (C10 · hard rule #3 · NEW-3). A tender keeps a token reference, the last four digits and the ──
  // ── network — nothing else. What arrived beyond that is REMOVED before banking (`withoutCardData`, by the route) and ──
  // ── raised here, critical, by field NAME: the value is never repeated. The sale stands — it happened. ──────────────────
  const cardData = withoutCardData(sale.tenders);
  if (cardData.removed.length > 0) {
    add('card_data_in_tender', 'critical',
      `a tender arrived with card data a tender may not keep — ${cardDataRemovalWords(cardData.removed)}; it was removed and not banked`,
      'ACT NOW: something sent a card number, security code or expiry with this sale. Nothing card-like was kept. Find which till, card machine link or program sent it and stop it — card data must never leave the card machine.');
  }
  const removedAtStore = sale.tenders.flatMap((t, i) => {
    const fields = t !== null && typeof t === 'object' && t.cardDataRemoved !== undefined && Array.isArray(t.cardDataRemoved.fields)
      ? t.cardDataRemoved.fields.filter((f): f is string => typeof f === 'string') : undefined;
    return fields === undefined ? [] : [`tender ${i + 1} (${typeof t.kind === 'string' ? t.kind : ''}): ${fields.length === 0 ? 'card data' : fields.join(', ')}`];
  });
  if (removedAtStore.length > 0) {
    add('card_data_in_tender', 'critical',
      `the store computer removed card data the till sent, before its disk — ${removedAtStore.join('; ')}`,
      'ACT NOW: a till or a card machine link sent card data with this sale. The store computer kept nothing card-like. Find which program on that till sent it and stop it — card data must never leave the card machine.');
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
      // B17 · OB-348: a product head office does not hold, sold under an alcoholic-drink HSN the till froze on the line, is
      // liquor all the same — judged by the shop's state and raised critical (a liquor product never reaches a pack).
      const liquor = productRuleRefusals({
        productId: line.productId, description: line.productId, quantityMinor: line.quantityMinor, uom: line.uom, unitPriceMinor: line.unitPriceMinor,
        ...(text(line.hsnCode) === '' ? {} : { hsnCode: text(line.hsnCode) }),
      }, ctx.shopState === undefined ? {} : { shopState: ctx.shopState }).find((r) => r.reason === 'liquor_not_sold' || r.reason === 'medicine_not_sold');
      if (liquor?.reason === 'liquor_not_sold') {
        add('liquor_sold', 'critical', `${line.productId}: ${liquor.detail}`,
          'ACT NOW: liquor was sold, which the shop\'s state does not allow (Tamil Nadu: only TASMAC may sell liquor). Find the till that sold it and why its pack carried it, and keep the receipt for the record.',
          { productId: line.productId });
      } else if (liquor?.reason === 'medicine_not_sold') {
        // B18 · OB-310: a product head office does not hold, sold under a medicaments HSN the till froze on the line.
        add('medicine_sold', 'critical', `${line.productId}: ${liquor.detail}`,
          'ACT NOW: a medicine was sold, and SRE holds no drug licence (OB-310). Find the till that sold it and why its pack carried it, and keep the receipt for the record.',
          { productId: line.productId });
      }
      continue;
    }

    // SF-08 · OB-139 "A" (R3): a line whose batch the till read off a 2D code, for a product blocked only by OTHER named
    // batches, is a sibling batch that may be sold. Every other line of a blocked product is the finding it always was —
    // and a line naming a blocked batch says which batch reached a customer.
    const lineBatch = typeof line.batchId === 'string' && line.batchId.trim() !== '' && line.batchAssigned === undefined ? line.batchId.trim() : undefined;
    const siblingOfABlockedBatch = product.recallBlock === true && lineBatch !== undefined
      && product.blockedBatches !== undefined && !product.blockedBatches.includes(lineBatch);
    if (product.recallBlock === true && !siblingOfABlockedBatch) {
      // The one finding on this list that is about a person rather than a number.
      const batchWords = lineBatch !== undefined && product.blockedBatches?.includes(lineBatch) === true ? ` (recalled batch ${lineBatch})` : '';
      add('sold_a_recalled_product', 'critical',
        `${product.sku}${batchWords} is recall-blocked and this lane sold it — its pack (v${sale.packVersion}) predates the block`,
        `ACT NOW: ${product.sku}${batchWords} is in a customer's hands. Check whether the receipt identifies them, and follow the recall procedure. Then confirm every lane has taken the pack that blocks it.`,
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

    // A7: the cess head office's catalogue gives the product, missing from the line — a finding (the sale stands).
    if (product.cess !== undefined && (product.cess.advaloremBps > 0 || product.cess.specificPerQuantityMinor > 0)
      && !(typeof line.cessMinor === 'number' && line.cessMinor > 0)) {
      add('cess_not_on_the_line', 'material',
        `${product.sku} carries a compensation cess in head office's price list and was sold with none on the line`,
        'The GST return would under-declare the cess on this sale. Check which till sold it and that it has the current price list; the accountant corrects the return.',
        { productId: line.productId });
    }

    // B8 (OB-298): a perishable sold with no date in its barcode AND no pack-date confirmation on the line. The till asks
    // for one tap before the line is added and checks again at payment; this is head office's backstop for an older till.
    if (product.regulatedFlags?.['perishable'] === true && !/^\d{4}-\d{2}-\d{2}$/.test(line.batchExpiry ?? '')
      && !(typeof line.packDateCheck?.confirmedBy === 'string' && line.packDateCheck.confirmedBy.trim() !== '')) {
      add('perishable_sold_without_date_check', 'material',
        `${product.sku} is perishable and was sold with no date in its barcode and no pack-date check by the cashier`,
        'Nobody looked at the date on this pack at the till. Check the shelf for out-of-date stock of this item, and find why the till did not ask (an older till, or a pack from before the product was marked perishable).',
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

    // ── The till's legal gates, re-checked against head office's OWN catalogue (B14 · B19). The till and its store ──────
    // ── computer refuse these before the money; this is the backstop for an old till, or a product whose flags changed ──
    // ── after the lane's pack was built. The sale stands (the goods are gone, hard rule #1), so each is CRITICAL. ─────────
    // NEW-1 (B19): judged as CHARGED — a bag that a promotion took to zero is a free bag.
    // OB-173 (owner, 17 Oct 2026, "Never discount bags"): a carry bag is charged its FULL list price — judged against the
    // higher of head office's own catalogue price (when the lane priced from the current pack — a lane a pack behind sold at
    // the price it was given, which is the pack-lag exception's business) and the line's price before any change at the till.
    const listUnit = Math.max(
      sale.packVersion >= ctx.currentPackVersion && typeof product.unitPriceMinor === 'number' && Number.isFinite(product.unitPriceMinor) ? product.unitPriceMinor : 0,
      typeof line.priceOverride?.fromUnitPriceMinor === 'number' && Number.isFinite(line.priceOverride.fromUnitPriceMinor) ? line.priceOverride.fromUnitPriceMinor : 0,
      line.unitPriceMinor,
    );
    const legal = productRuleRefusals({
      productId: line.productId, description: product.sku, quantityMinor: line.quantityMinor, uom: line.uom,
      unitPriceMinor: line.unitPriceMinor, listUnitPriceMinor: listUnit,
      ...(typeof line.lineTotalMinor === 'number' && Number.isFinite(line.lineTotalMinor) ? { chargedMinor: line.lineTotalMinor } : {}),
      // L1: a carry bag is judged in head office's catalogue unit, whatever unit the line says.
      ...(typeof product.baseUom === 'string' && product.baseUom !== '' ? { catalogueUom: product.baseUom } : {}),
      ...(product.regulatedFlags === undefined ? {} : { regulatedFlags: product.regulatedFlags }),
      // B17 · OB-348: the HSN in head office's own catalogue, else the one the till froze on the line.
      ...((h) => (h === undefined ? {} : { hsnCode: h }))(text(product.hsnCode) !== '' ? text(product.hsnCode) : text(line.hsnCode) !== '' ? text(line.hsnCode) : undefined),
    }, ctx.shopState === undefined ? {} : { shopState: ctx.shopState });
    for (const r of legal) {
      if (r.reason === 'medicine_not_sold') {
        add('medicine_sold', 'critical',
          `${product.sku}: ${r.detail}`,
          'ACT NOW: a medicine was sold, and SRE holds no drug licence (OB-310). Take it off sale, find why the till did not stop it (an old till, or a pack that predates the rule), and keep the receipt for the record.',
          { productId: line.productId });
        continue;
      }
      if (r.reason === 'liquor_not_sold') {
        add('liquor_sold', 'critical',
          `${product.sku}: ${r.detail}`,
          'ACT NOW: liquor was sold, which the shop\'s state does not allow (Tamil Nadu: only TASMAC may sell liquor). Take it off sale, find why the till did not stop it (an old till, or a pack that predates the rule), and keep the receipt for the record.',
          { productId: line.productId });
        continue;
      }
      if (r.reason === 'banned_single_use_plastic' || r.reason === 'carry_bag_below_min_thickness' || r.reason === 'carry_bag_not_priced' || r.reason === 'carry_bag_discounted') {
        add('unlawful_plastic_sold', 'critical',
          `${product.sku}: ${r.detail}`,
          'ACT NOW: an item the plastic rules forbid was sold. Take the item off sale, find why the till did not stop it (an old till, or a pack that predates the rule), and keep the receipt for the record.',
          { productId: line.productId });
      } else if (r.reason === 'tobacco_below_pack' || r.reason === 'tobacco_not_whole_packs') {
        add('tobacco_sold_below_pack', 'critical',
          `${product.sku}: ${r.detail}`,
          'ACT NOW: loose cigarettes were sold, which the law forbids. Ask the cashier on that bill, and find why the till did not stop it.',
          { productId: line.productId });
      }
    }

    // ── B13 (BIS IS 1417:2016 · OB-138): a gold piece is sold with its HUID, once. The till and its store computer refuse ──
    // ── both before the money; this is head office's backstop — an old till, or a piece sold at another store. ──────────
    if (product.regulatedFlags?.['gold'] === true) {
      const onProduct = typeof product.regulatedFlags['huid'] === 'string' ? product.regulatedFlags['huid'] : undefined;
      const huid = typeof line.huid === 'string' && line.huid !== '' ? line.huid : onProduct;
      if (huid === undefined) {
        add('gold_sold_without_huid', 'critical',
          `${product.sku} is gold and was sold with no hallmark HUID`,
          'ACT NOW: a gold piece left the store without its hallmark HUID on the bill. Record the HUID on the product, give the customer a bill that shows it, and find why the till did not stop the sale.',
          { productId: line.productId });
      } else if (ctx.huidsSoldElsewhere?.has(huid) === true) {
        add('gold_huid_sold_twice', 'critical',
          `${product.sku} HUID ${huid} was already sold on sale ${ctx.huidsSoldElsewhere.get(huid)} and has been sold again on ${sale.saleId}`,
          'ACT NOW: one hallmarked piece cannot be sold twice. Check both bills and the piece itself — either the HUID on the product is wrong, or a piece is missing from the record. Do not sell the HUID again until it is resolved.',
          { productId: line.productId });
      }
    }

    // ── NEW-2 (B6): the unit is head office's catalogue's, not the line's word for it. ─────────────────────────────────
    if (typeof product.baseUom === 'string' && product.baseUom !== '' && line.uom !== product.baseUom) {
      add('unit_differs_from_catalogue', 'material',
        `${product.sku} was sold in "${String(line.uom)}" and head office's catalogue sells it in "${product.baseUom}"`,
        isWeighedUom(product.baseUom)
          ? 'This product is sold by weight. Check the till that sent it: a weighed item sent in another unit skips the scale check and is priced on the wrong unit.'
          : 'Check which till sent it and whether its catalogue is current — the quantity and the price may be read on the wrong unit.',
        { productId: line.productId });
    }

    // ── B6 · B5 — a WEIGHED line (by head office's catalogue OR the line's unit): its scale's stamp, and its amount ─────
    // ── against weight × price. ────────────────────────────────────────────────────────────────────────────────────────
    if (lineIsWeighed({ uom: line.uom, ...(typeof product.baseUom === 'string' ? { catalogueUom: product.baseUom } : {}) })) {
      const evidence = line.scaleCheck;
      // L3: head office's OWN register for this lane, on the sale's trading day, when it is wired; else the till's claim.
      const onRegister = ctx.laneScalesOnRegister;
      const scales = onRegister !== undefined ? onRegister : Array.isArray(evidence?.scales) ? evidence.scales : [];
      const day = onRegister !== undefined ? sale.tradingDay : typeof evidence?.checkedOn === 'string' ? evidence.checkedOn : sale.tradingDay;
      const lapsed = scales.filter((s) => {
        try { return weighingScaleVerification({ reverificationDueOn: String(s.reverificationDueOn ?? '') }, day).tradingBlocked; } catch (err) {
          if (err instanceof InvalidScaleVerification) return true; // an unreadable stamp date is no proof of a current one
          throw err;
        }
      });
      if (scales.length === 0) {
        add('weighed_on_unverified_scale', 'material',
          onRegister !== undefined
            ? `${product.sku} was sold by weight on lane ${sale.laneId}, and head office's scale register has no scale for that lane`
            : `${product.sku} was sold by weight with no record of a verified scale`,
          onRegister !== undefined
            ? 'Head office cannot show this weight came from a scale with a current Legal Metrology stamp: put the scale on that lane on the register (Scales page), with its stamp date and certificate.'
            : 'Head office cannot show this weight came from a scale with a current Legal Metrology stamp. Check which till sent it (an old till sends no scale record) and that its scale is on the register.',
          { productId: line.productId });
      } else if (lapsed.length > 0) {
        add('weighed_on_unverified_scale', 'critical',
          `${product.sku} was weighed on ${lapsed.map((s) => `${String(s.assetId)} (stamp valid to ${String(s.reverificationDueOn)})`).join(', ')} on ${day} — the verification had lapsed`,
          'ACT NOW: goods were sold by weight on a scale whose Legal Metrology stamp had run out. Stop weighing on it, book the re-verification, and find why the till did not stop the sale.',
          { productId: line.productId });
      }
      // The amount the customer may be charged at most: weighed net quantity × the price per unit, rounded DOWN (B5). The
      // unit is the catalogue's when it says the product is weighed (NEW-2), else the line's.
      const unit = typeof product.baseUom === 'string' && isWeighedUom(product.baseUom) ? product.baseUom : line.uom;
      const per = unit === 'kg' ? 1000 : 1;
      const most = Math.floor((line.unitPriceMinor * line.quantityMinor) / per);
      if (Number.isSafeInteger(most) && line.lineTotalMinor > most) {
        add('weighed_line_charged_above_weight_times_price', 'material',
          `${product.sku}: ${line.quantityMinor} ${line.uom === 'kg' ? 'g' : line.uom} at ${line.unitPriceMinor} per ${line.uom} is at most ${most}, and the line charged ${line.lineTotalMinor}`,
          'The customer was charged more than the weight times the displayed price. Refund the difference if they ask, and find which till rounds against the customer.',
          { productId: line.productId, differenceMinor: line.lineTotalMinor - most });
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

  // OB-81 "A": a bill numbered under a store computer's own store prefix (ZZ…) — its till was never issued a prefix by head
  // office while the business has more than one store. The bill is unique and stands; the owner is told to issue one.
  if (isStoreComputerDefaultReceipt(sale.receiptNumber)) {
    add('receipt_numbered_without_issued_prefix', 'material',
      `receipt ${sale.receiptNumber} from lane ${sale.laneId} was numbered under the store computer's own store prefix — head office has not issued this till its bill-number prefix`,
      'Issue this till its bill-number prefix (store setup → till bill-number prefixes). Its bills stay unique meanwhile, but the numbers are not the ones head office chose.');
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
