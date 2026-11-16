// A LARGE ORDER IS ASKED ABOUT AGAIN — OB-821 (owner, 16 Nov 2026, in writing: "OB-821 B") · daily-work defect D-039 ·
// M06-FR-02 · P-03 · P-05.
//
// The walkthrough found the Buying page raised a requisition for 48,112 packs with no warning. The owner chose the limit:
// warn, and ask again, before raising a purchase order worth more than ₹1,00,000 — the order's total BEFORE GST, the way an
// order is raised. It is a warning only: an order over the limit is still raised when the person says yes a second time,
// and every order is still issued by a second person at head office exactly as before. Nothing is loosened. An order of
// exactly ₹1,00,000 is not over the limit. Pure.

/** OB-821 B: the owner's limit — ₹1,00,000 in paise. One place; every screen that raises an order reads this. */
export const ORDER_WARN_ABOVE_MINOR = 1_00_000_00;

/** True when an order's total before GST is over the owner's limit (strictly more than ₹1,00,000). */
export const orderNeedsSecondLook = (totalBeforeGstMinor: number): boolean =>
  Number.isFinite(totalBeforeGstMinor) && totalBeforeGstMinor > ORDER_WARN_ABOVE_MINOR;
