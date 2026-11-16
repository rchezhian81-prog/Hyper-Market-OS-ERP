// CASH ROUND-OFF — the owner's OB-805 A (16 Nov 2026, in writing) · daily-work defect D-003 · OB-285 · hard rule #1.
//
// A cash bill of ₹303.50 always left the drawer short: the blind count has no coin below ₹1, so the 50 paise the customer
// "paid" was never in the drawer. OB-805 A: a CASH bill is rounded to the rupee, with a "Round off" line on the bill.
//
// The direction is DOWN. OB-285 (owner, 21 Oct 2026, in writing — Legal Metrology, roadmap B1) says the customer never pays
// more than the goods' MRP-based total; rounding ₹303.50 UP to ₹304 would charge 50 paise above the printed MRPs. So the paise
// of a cash amount come off (₹303.50 → ₹303.00, round off −₹0.50), never on. The whole chain already carries a round off of
// this kind (`roundOffMinor`: 0 to −₹1, total = lines + round off — the till, the store computer, head office's intake, the
// day book's `round_off` account), so nothing downstream had to learn a new figure.
//
// Only CASH is rounded: a card, UPI, store credit, points or gift-card part is paid to the paisa. On a split, the cash part
// that finishes the bill is rounded (the paise of what is left when the cash is taken); a cash part that leaves something
// still to pay by card is taken as keyed. A cash amount under ₹1 is not rounded to nothing. Pure — the till works it out
// with no network call (hard rule #1).

/** The paise taken off a cash amount: 0, or −1 … −99. Never positive (OB-285: never above the goods). */
export function cashRoundOffMinor(cashDueMinor: number): number {
  if (!Number.isSafeInteger(cashDueMinor) || cashDueMinor < 100) return 0;
  const paise = cashDueMinor % 100;
  return paise === 0 ? 0 : -paise;
}

/** The cash the customer is asked for: the cash due less its paise. */
export function cashToTakeMinor(cashDueMinor: number): number {
  return cashDueMinor + cashRoundOffMinor(cashDueMinor);
}
