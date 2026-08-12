// Itemised consent notice (C1 / M16 — DPDP Act 2023 s.5–6). Consent is only real if the person was told,
// in plain terms, WHAT data is taken and WHY — and can walk it back as easily as they gave it. This
// validates a consent notice against exactly that: each data category paired with its purpose, and the
// three ways out the Act requires present IN the notice — withdraw, grievance redressal, and complaining to
// the Data Protection Board.
//
// **Withdrawal as easy as giving (s.6(6))** is the commonest dark pattern, and it is never built on purpose
// — it accumulates one reasonable step at a time. So it is checked structurally here too: the steps to
// withdraw must not exceed the steps to give. (The served customer app enforces the same symmetry at the
// screen; this checks the notice's own declaration.)
//
// Pure and deterministic — it validates the notice it is handed and commits nothing.

export interface ConsentNoticeItem {
  readonly dataCategory: string;
  /** WHY this category is processed — a specific, non-empty purpose (blanket "for business" is not one). */
  readonly purpose: string;
}

export interface ConsentNotice {
  readonly items: readonly ConsentNoticeItem[];
  /** How to withdraw consent. */
  readonly withdrawMethod?: string;
  /** The grievance-redressal contact (the Data Protection Officer / grievance officer). */
  readonly grievanceContact?: string;
  /** How to complain to the Data Protection Board. */
  readonly boardComplaintLink?: string;
  /** Steps to GIVE consent, and to WITHDRAW it — withdrawal must not take more (s.6(6)). Optional; the
   *  symmetry is only checked when both are supplied. */
  readonly giveSteps?: number;
  readonly withdrawSteps?: number;
}

export type ConsentNoticeDefect =
  /** No (category, purpose) items at all — a notice that itemises nothing. */
  | 'no_itemised_purposes'
  /** A data category with a blank purpose — data taken with no stated why. */
  | 'purpose_missing'
  /** No way to withdraw consent (s.6). */
  | 'no_withdraw_method'
  /** Withdrawal takes more steps than giving (s.6(6)). */
  | 'withdrawal_harder_than_giving'
  /** No grievance-redressal contact (s.5 / s.13). */
  | 'no_grievance_contact'
  /** No way to complain to the Data Protection Board. */
  | 'no_board_complaint_link';

export interface ConsentNoticeCheck {
  readonly compliant: boolean;
  readonly defects: readonly { readonly defect: ConsentNoticeDefect; readonly detail: string }[];
  readonly itemCount: number;
}

const present = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Check a consent notice against DPDP s.5–6: itemised (category, purpose), a withdraw method, a grievance
 * contact, a Board-complaint link, and withdrawal no harder than giving. Every gap is a named defect;
 * the notice is compliant only when there are none. It names EVERY defect at once, not just the first.
 */
export function checkConsentNotice(notice: ConsentNotice): ConsentNoticeCheck {
  const defects: { defect: ConsentNoticeDefect; detail: string }[] = [];
  const items = Array.isArray(notice.items) ? notice.items : [];

  if (items.length === 0) {
    defects.push({ defect: 'no_itemised_purposes', detail: 'the notice lists no data category with a purpose — consent cannot be specific to nothing' });
  }
  for (const item of items) {
    if (!present(item.purpose)) {
      defects.push({
        defect: 'purpose_missing',
        detail: `${present(item.dataCategory) ? item.dataCategory : '(unnamed category)'} is taken with no stated purpose`,
      });
    }
  }

  if (!present(notice.withdrawMethod)) {
    defects.push({ defect: 'no_withdraw_method', detail: 'the notice carries no way to withdraw consent (s.6)' });
  }
  if (typeof notice.giveSteps === 'number' && typeof notice.withdrawSteps === 'number'
    && notice.withdrawSteps > notice.giveSteps) {
    defects.push({
      defect: 'withdrawal_harder_than_giving',
      detail: `withdrawing takes ${notice.withdrawSteps} step(s) against ${notice.giveSteps} to give — s.6(6) requires it be as easy`,
    });
  }
  if (!present(notice.grievanceContact)) {
    defects.push({ defect: 'no_grievance_contact', detail: 'the notice carries no grievance-redressal contact (s.5/s.13)' });
  }
  if (!present(notice.boardComplaintLink)) {
    defects.push({ defect: 'no_board_complaint_link', detail: 'the notice carries no way to complain to the Data Protection Board' });
  }

  return { compliant: defects.length === 0, defects, itemCount: items.length };
}
