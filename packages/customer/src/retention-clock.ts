// Automated retention clock + pre-erasure notice (C3 / M16·M35 — DPDP Act 2023 s.8(7)). Personal data is
// not kept forever: the moment its **purpose is served** — or **consent is withdrawn** — the clock starts,
// and the data is erased. This runs that clock without waiting for the person to ask (unlike the erasure
// REQUEST that `planErasure` handles), and it does two things the Act insists on:
//
//   • **A pre-erasure notice.** Before erasing, the person is told — what will go, and when. So a category
//     whose trigger has fired sits in a `notice` window first, and only erases once that window elapses.
//   • **It honours the same law `planErasure` does.** Two statutes still point opposite ways: a tax invoice
//     or an audit record must survive years even after the purpose is served. So a legally-retained category
//     is NOT erased on the clock — it is **minimised** (the person becomes a pseudonym, the record lives) or,
//     for audit evidence and legal holds, **kept in full** (hard rule #6 — audit evidence is never deleted).
//
// Pure and deterministic — the clock is injected (`asOf`), nothing is deleted here: it produces the sweep a
// fulfilment step executes and an auditor later reads.

import type { DataCategory, RetentionBasis } from './data-rights';

export interface RetainedCategory extends DataCategory {
  /** When the purpose this data was collected for was served (ISO). Starts the erasure clock. */
  readonly purposeServedAt?: string;
  /** When consent for this data was withdrawn (ISO). Also starts the clock. */
  readonly consentWithdrawnAt?: string;
}

export type RetentionAction =
  /** The purpose is still live and consent is held — keep it. */
  | 'retain'
  /** The clock has started and this data is erasable, but it is in its pre-erasure notice window. */
  | 'notice'
  /** The clock has started, the notice window has elapsed — erase it now. */
  | 'erase'
  /** Legally retained but minimisable — strip the person's identity now, keep the record. */
  | 'minimise'
  /** Legally retained and NOT minimisable (audit evidence / legal hold) — kept in full, never erased. */
  | 'retain_by_law';

export interface CategoryRetention {
  readonly category: string;
  readonly recordCount: number;
  readonly action: RetentionAction;
  /** What started the clock and when — the earlier of purpose-served / consent-withdrawn. */
  readonly trigger?: { readonly reason: 'purpose_served' | 'consent_withdrawn'; readonly at: string };
  /** For an erasable category past its trigger — when it is (or was) scheduled to erase (trigger + notice days). */
  readonly erasureScheduledFor?: string;
  readonly retentionBasis?: RetentionBasis;
  readonly detail: string;
}

export interface RetentionSweep {
  readonly asOf: string;
  readonly categories: readonly CategoryRetention[];
  readonly eraseNowCount: number;
  readonly noticeDueCount: number;
  readonly minimiseCount: number;
  /** The pre-erasure notice to the customer, present when any category is in its notice window. */
  readonly preErasureNotice?: readonly string[];
  readonly detail: string;
}

export class InvalidRetentionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRetentionInputError';
  }
}

const DAY_MS = 86_400_000;
const isIso = (v: string): boolean => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

/** The earlier of the two clock-starting facts, if either is set. */
function triggerOf(c: RetainedCategory): { reason: 'purpose_served' | 'consent_withdrawn'; at: string } | undefined {
  const served = typeof c.purposeServedAt === 'string' && isIso(c.purposeServedAt) ? Date.parse(c.purposeServedAt) : undefined;
  const withdrawn = typeof c.consentWithdrawnAt === 'string' && isIso(c.consentWithdrawnAt) ? Date.parse(c.consentWithdrawnAt) : undefined;
  if (served === undefined && withdrawn === undefined) return undefined;
  if (withdrawn !== undefined && (served === undefined || withdrawn <= served)) {
    return { reason: 'consent_withdrawn', at: c.consentWithdrawnAt! };
  }
  return { reason: 'purpose_served', at: c.purposeServedAt! };
}

/**
 * Run the retention clock over the categories held for a person. Each category whose purpose is served or
 * whose consent is withdrawn is moved toward erasure — through a pre-erasure notice window first — unless the
 * law requires it kept, in which case it is minimised or retained in full (never erased; hard rule #6).
 * `noticeLeadDays` is the warning period before an erasable category is erased (per-tenant, default 30).
 */
export function assessRetention(input: {
  readonly categories: readonly RetainedCategory[];
  readonly asOf: string;
  readonly noticeLeadDays?: number;
}): RetentionSweep {
  if (!isIso(input.asOf)) throw new InvalidRetentionInputError('asOf must be an ISO date-time');
  if (!Array.isArray(input.categories)) throw new InvalidRetentionInputError('categories must be a list');
  const noticeLeadDays = input.noticeLeadDays ?? 30;
  if (!Number.isInteger(noticeLeadDays) || noticeLeadDays < 0) {
    throw new InvalidRetentionInputError('noticeLeadDays must be a whole number of at least 0');
  }
  const now = Date.parse(input.asOf);

  const categories = input.categories.map((c): CategoryRetention => {
    const trigger = triggerOf(c);
    const triggerNote = trigger === undefined ? '' : trigger.reason === 'consent_withdrawn' ? 'consent was withdrawn' : 'the purpose was served';

    if (trigger === undefined) {
      return {
        category: c.category, recordCount: c.recordCount, action: 'retain',
        detail: 'kept — the purpose is still live and consent is held',
      };
    }

    // Legally retained: the clock cannot erase it. Minimise where the record must survive but the person
    // need not be identifiable in it; keep audit evidence / a legal hold in full (hard rule #6).
    if (c.retentionBasis !== undefined) {
      const action: RetentionAction = c.minimisable === true ? 'minimise' : 'retain_by_law';
      return {
        category: c.category, recordCount: c.recordCount, action,
        trigger, retentionBasis: c.retentionBasis,
        detail: action === 'minimise'
          ? `identity stripped now (${triggerNote}); the record is kept because the law requires it${c.retainUntil === undefined ? '' : `, until ${c.retainUntil}`}`
          : `kept in full (${triggerNote}) — this cannot be erased on the clock (${c.retentionBasis})`,
      };
    }

    // Erasable: erase after the pre-erasure notice window from the trigger.
    const erasureScheduledFor = new Date(Date.parse(trigger.at) + noticeLeadDays * DAY_MS).toISOString();
    const action: RetentionAction = now >= Date.parse(erasureScheduledFor) ? 'erase' : 'notice';
    return {
      category: c.category, recordCount: c.recordCount, action, trigger, erasureScheduledFor,
      detail: action === 'erase'
        ? `erase now — ${triggerNote}, and the notice window to ${erasureScheduledFor} has passed`
        : `pre-erasure notice due — ${triggerNote}; scheduled to erase on ${erasureScheduledFor}`,
    };
  });

  const eraseNowCount = categories.filter((c) => c.action === 'erase').length;
  const noticeDueCount = categories.filter((c) => c.action === 'notice').length;
  const minimiseCount = categories.filter((c) => c.action === 'minimise').length;

  const noticed = categories.filter((c) => c.action === 'notice');
  const preErasureNotice = noticed.length === 0 ? undefined : [
    'Some of your data is no longer needed and we are going to delete it. We are telling you first:',
    ...noticed.map((c) => `• ${c.category}: to be deleted on ${c.erasureScheduledFor}.`),
    'If you believe we still need to keep any of this, contact us before that date.',
  ];

  return {
    asOf: input.asOf,
    categories,
    eraseNowCount,
    noticeDueCount,
    minimiseCount,
    ...(preErasureNotice === undefined ? {} : { preErasureNotice }),
    detail: `${eraseNowCount} to erase now, ${noticeDueCount} entering the notice window, ${minimiseCount} to minimise; the rest are retained`,
  };
}
