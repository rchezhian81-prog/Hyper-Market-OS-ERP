// Staff purchases (M15-FR-03 · OB-301, owner, 23 Oct 2026, in writing): "staff buy only at the service desk, under an
// owner-set staff-discount cap that shows 'not set' until entered; staff never bill themselves".
//
// The rule is one small pure function so it can run in three places with the same answer:
//
//   • at the TILL, before the bill commits, from the signed store pack the lane already holds (no network — hard
//     rule #1). The till refuses the bill and says why; nothing is committed.
//   • at HEAD OFFICE, over the bills that arrived, as an exception list: a bill from an older till, or a till whose
//     pack predates the rule, can still arrive, and it is SHOWN, never silently accepted (P-08) and never un-banked
//     (a committed bill is a fact on the ledger — hard rule #2).
//   • at the SERVICE DESK screen, to tell the person at the desk before they ring it.
//
// The three refusals, in the order they are judged:
//
//   1. **self_billing** — the cashier on the bill is the customer named on it. Nobody rings their own shopping,
//      anywhere, ever: not at a lane, not at the desk, not with a manager standing by.
//   2. **not_at_service_desk** — a staff member's shopping rung at a lane that is not the service desk. Until the owner
//      names the service-desk till, NO till is the service desk, so a staff purchase is refused everywhere and the
//      words say the owner has not named it yet ("not set" — never a guessed lane).
//   3. **discount_above_cap** — the bill gives the staff member more off than the owner's cap. Until the owner enters
//      the cap, the cap is "not set" and no staff discount may be given at all (a staff purchase at the shelf price is
//      still fine) — a discount judged against a number nobody chose would be a number the software made up.
//
// A staff member is recognised by the customer account the shop recorded for them (their own loyalty member code,
// recorded by HR — `staffAccounts`), never by a name. The discount on a bill is what the lines charged below the price
// the lane priced them at before any person lowered it (`listUnitPriceMinor` — the till's own price, or the price a
// manager's override started from), so the figure is the till's own arithmetic, not a judgement.

/** The owner's staff-purchase setting, as the store pack carries it. `null` = "not set" (the owner has not entered it). */
export interface StaffPurchasePolicy {
  /** The most a staff purchase may be discounted, in basis points of the bill (1000 = 10%). `null` = not set. */
  readonly staffDiscountCapBps: number | null;
  /** The till(s) that are the service desk. `null` = not set — no till is the service desk yet. */
  readonly serviceDeskLaneIds: readonly string[] | null;
}

/** One line as the till holds it: the price the lane charged, and the price it started from before a person lowered it. */
export interface StaffBillLine {
  readonly quantityMinor: number;
  readonly unitPriceMinor: number;
  /** The lane's own price before a manual reduction; absent = the line was charged at the lane's price. */
  readonly listUnitPriceMinor?: number;
  /** Whole-unit price per `per` units (weighed lines in grams at a price per kg): the line's own total, used as is. */
  readonly lineTotalMinor: number;
}

export interface StaffBill {
  readonly laneId: string;
  readonly cashierId: string;
  /** The customer account named on the bill (a member code), when one was keyed. */
  readonly customerRef?: string;
  readonly lines: readonly StaffBillLine[];
}

export type StaffPurchaseRefusal = 'self_billing' | 'not_at_service_desk' | 'discount_above_cap';

export type StaffPurchaseDecision =
  | { readonly staffPurchase: false; readonly allowed: true }
  | {
    readonly staffPurchase: true;
    readonly employeeId: string;
    readonly allowed: boolean;
    readonly refusals: readonly StaffPurchaseRefusal[];
    /** The discount the bill gives, in paise and basis points of the bill at its list price. */
    readonly discountMinor: number;
    readonly discountBps: number;
    /** What was not set when it was judged — said, never filled in. */
    readonly notSet: readonly ('staff_discount_cap' | 'service_desk')[];
    readonly words: { readonly en: string; readonly ta: string };
  };

/** The list value of one line: quantity × the lane's own price, scaled exactly as the line's own total was. */
function listValueOf(l: StaffBillLine): number {
  if (l.listUnitPriceMinor === undefined || l.unitPriceMinor === 0) return l.lineTotalMinor;
  // The line total already carries the unit arithmetic (grams × price per kg); scale it by the price ratio, rounded once.
  return Math.round((l.lineTotalMinor * l.listUnitPriceMinor) / l.unitPriceMinor);
}

/** The staff discount on a bill: what the lines charged below the lane's own prices. Never negative. */
export function staffDiscountOf(lines: readonly StaffBillLine[]): { readonly discountMinor: number; readonly listMinor: number; readonly discountBps: number } {
  let list = 0; let charged = 0;
  for (const l of lines) { list += Math.max(listValueOf(l), l.lineTotalMinor); charged += l.lineTotalMinor; }
  const discountMinor = Math.max(0, list - charged);
  return { discountMinor, listMinor: list, discountBps: list === 0 ? 0 : Math.round((discountMinor * 10_000) / list) };
}

const pct = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/**
 * Judge one bill. `staffAccounts` maps a customer account (member code) to the employee it belongs to. A bill that
 * names no staff account is not a staff purchase and is allowed by this rule (other rules still apply).
 */
export function judgeStaffPurchase(bill: StaffBill, policy: StaffPurchasePolicy, staffAccounts: ReadonlyMap<string, string>): StaffPurchaseDecision {
  const ref = bill.customerRef?.trim();
  const employeeId = ref === undefined || ref === '' ? undefined : staffAccounts.get(ref);
  if (employeeId === undefined) return { staffPurchase: false, allowed: true };
  const refusals: StaffPurchaseRefusal[] = [];
  const notSet: ('staff_discount_cap' | 'service_desk')[] = [];
  if (employeeId === bill.cashierId) refusals.push('self_billing');
  if (policy.serviceDeskLaneIds === null) { notSet.push('service_desk'); refusals.push('not_at_service_desk'); }
  else if (!policy.serviceDeskLaneIds.includes(bill.laneId)) refusals.push('not_at_service_desk');
  const d = staffDiscountOf(bill.lines);
  if (policy.staffDiscountCapBps === null) {
    notSet.push('staff_discount_cap');
    if (d.discountMinor > 0) refusals.push('discount_above_cap');
  } else if (d.discountBps > policy.staffDiscountCapBps) refusals.push('discount_above_cap');

  const en: string[] = []; const ta: string[] = [];
  for (const r of refusals) {
    if (r === 'self_billing') {
      en.push('A staff member may never bill their own shopping. Another person at the service desk must ring it.');
      ta.push('ஒரு பணியாளர் தன் சொந்தப் பொருட்களுக்குத் தானே பில் போடக் கூடாது. சேவை மேசையில் வேறொருவர் பில் போட வேண்டும்.');
    } else if (r === 'not_at_service_desk') {
      if (policy.serviceDeskLaneIds === null) {
        en.push('Staff shopping is rung only at the service desk, and the owner has not named the service-desk till yet (not set).');
        ta.push('பணியாளர் பொருட்கள் சேவை மேசையில் மட்டுமே பில் போடப்படும்; சேவை மேசைக் கவுண்டரை உரிமையாளர் இன்னும் குறிப்பிடவில்லை (அமைக்கப்படவில்லை).');
      } else {
        en.push('Staff shopping is rung only at the service desk. Send the staff member to the service desk.');
        ta.push('பணியாளர் பொருட்கள் சேவை மேசையில் மட்டுமே பில் போடப்படும். பணியாளரைச் சேவை மேசைக்கு அனுப்பவும்.');
      }
    } else if (policy.staffDiscountCapBps === null) {
      en.push('The owner has not set the staff discount yet (not set), so no staff discount can be given. Ring it at the shelf price.');
      ta.push('பணியாளர் தள்ளுபடியை உரிமையாளர் இன்னும் அமைக்கவில்லை (அமைக்கப்படவில்லை); அதனால் தள்ளுபடி தர முடியாது. அலமாரி விலையில் பில் போடவும்.');
    } else {
      en.push(`This bill gives ${pct(d.discountBps)} off; the owner's staff discount is at most ${pct(policy.staffDiscountCapBps)}.`);
      ta.push(`இந்தப் பில் ${pct(d.discountBps)} தள்ளுபடி தருகிறது; உரிமையாளரின் பணியாளர் தள்ளுபடி அதிகபட்சம் ${pct(policy.staffDiscountCapBps)}.`);
    }
  }
  return {
    staffPurchase: true, employeeId, allowed: refusals.length === 0, refusals,
    discountMinor: d.discountMinor, discountBps: d.discountBps, notSet,
    words: { en: en.join(' '), ta: ta.join(' ') },
  };
}

/** Read the owner's setting as it is stored (each part absent or null = "not set"); a malformed part is "not set". */
export function readStaffPurchasePolicy(raw: unknown): StaffPurchasePolicy {
  const b = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const cap = b['staffDiscountCapBps'];
  const lanes = b['serviceDeskLaneIds'];
  return {
    staffDiscountCapBps: Number.isInteger(cap) && (cap as number) >= 0 && (cap as number) <= 10_000 ? cap as number : null,
    serviceDeskLaneIds: Array.isArray(lanes) && lanes.length > 0 && lanes.every((l) => typeof l === 'string' && l.trim() !== '') ? (lanes as string[]).map((l) => l.trim()) : null,
  };
}
