// Return eligibility (M13-FR-02) — is this return within the shop's return policy?
//
// FR-02 acceptance: *an out-of-window return is blocked per policy.* A shop takes goods back only
// within a window it decides. The NUMBER of days in that window is the owner's to set, not ours to
// invent (roadmap M13 "Open items — AVR-07: return window/policy"): this engine DECIDES eligibility
// from a window handed to it; it never chooses the window.
//
// Secure by default (P-04, §28, P-08). Three outcomes are NOT a silent free pass:
//   • past the window          → blocked; a supervisor may authorise an override (an exception a
//                                named person owns), but the return does not simply pass;
//   • the window is not yet set → blocked the same way, until the owner sets it — an unset policy
//                                must never read as "any return, any age, is fine";
//   • the return is dated before its own sale, or on an unreadable date → a data fault, refused
//                                outright and NOT overridable (there is nothing to authorise — the
//                                dates have to be fixed first).
// Only a return genuinely inside the window needs no second person.
//
// Pure and deterministic: the caller supplies both timestamps, the policy window, and whether a
// genuine §28 override is present (the role/approval read the route does, not this engine — the same
// division as `refundGovernanceFindings`). No clock, no I/O.

/** Milliseconds in one 24-hour period — the unit `ageDays` counts. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a return is (or is not) eligible under the window policy. */
export type ReturnEligibility =
  | 'within_window' //     inside the policy window — no override needed
  | 'outside_window' //    past the window — needs a supervisor override
  | 'window_not_set' //    the shop has not set a return window yet — needs an override until it does
  | 'return_before_sale' // dated before its own sale — a data fault, not overridable
  | 'unreadable_dates'; // a timestamp could not be read — a data fault, not overridable

/** The two data faults that no override can clear — the dates themselves must be fixed. */
const DATA_FAULTS: ReadonlySet<ReturnEligibility> = new Set<ReturnEligibility>([
  'return_before_sale',
  'unreadable_dates',
]);

export interface EligibilityAssessment {
  /** May this return proceed? True only when within window, or blocked-but-genuinely-overridden. */
  readonly eligible: boolean;
  readonly status: ReturnEligibility;
  /** Does this STATUS require a supervisor's authorised override to proceed? */
  readonly requiresOverride: boolean;
  /** Was an authorised override actually applied to clear an out-of-window / unset-policy block? */
  readonly overridden: boolean;
  /** Whole 24-hour periods from sale to return. 0 when same instant; NaN when a date is unreadable. */
  readonly ageDays: number;
  readonly detail: string;
}

/**
 * The per-tenant return window (M13-FR-02) — the number of whole days from the sale within which a
 * return needs no override. **Configuration, not a per-request input**: were the caller to send their
 * own window, they could declare any stale return "in window" and skip the supervisor. There is no
 * default — an unset window blocks (needs an override) rather than silently admitting everything — so
 * the owner's real policy has to be entered before returns flow freely (AVR-07).
 */
export function readReturnWindowDays(v: unknown): number | 'invalid' {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const d = (v as Record<string, unknown>)['returnWindowDays'];
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 0) return 'invalid';
  return d;
}

/** A window is usable only when it is a whole, non-negative number of days; anything else is "not set". */
function windowIsSet(returnWindowDays: number | undefined): returnWindowDays is number {
  return returnWindowDays !== undefined && Number.isInteger(returnWindowDays) && returnWindowDays >= 0;
}

/**
 * Decide whether a return is eligible under the shop's return window.
 *
 * `soldAt` is the original sale's timestamp (e.g. `OriginalSale.committedAt`); `returnedAt` is this
 * return's `processedAt`. `returnWindowDays` is the per-tenant policy (undefined = not yet set).
 * `hasAuthorisedOverride` says a genuine §28 supervisor override is present — the route establishes
 * that (an approved decision by a different person who holds the authority); the engine only decides
 * whether an override is *needed* and, if present, whether it clears the block.
 */
export function assessReturnEligibility(input: {
  readonly soldAt: string;
  readonly returnedAt: string;
  readonly returnWindowDays?: number;
  readonly hasAuthorisedOverride?: boolean;
}): EligibilityAssessment {
  const soldMs = Date.parse(input.soldAt);
  const returnedMs = Date.parse(input.returnedAt);
  const overrideOffered = input.hasAuthorisedOverride === true;

  // A data fault first: an unreadable timestamp, or a return dated before its own sale. Neither can
  // be authorised away — the record is wrong and must be corrected, so no override clears it.
  if (Number.isNaN(soldMs) || Number.isNaN(returnedMs)) {
    return {
      eligible: false,
      status: 'unreadable_dates',
      requiresOverride: false,
      overridden: false,
      ageDays: Number.NaN,
      detail: 'the sale or return timestamp could not be read, so the return age cannot be judged',
    };
  }
  const ageDays = Math.floor((returnedMs - soldMs) / DAY_MS);
  if (returnedMs < soldMs) {
    return {
      eligible: false,
      status: 'return_before_sale',
      requiresOverride: false,
      overridden: false,
      ageDays,
      detail: 'the return is dated before the sale it is against — a data fault to fix, not a policy call',
    };
  }

  // Window not set: blocked until the owner sets a policy, but a supervisor may authorise it.
  if (!windowIsSet(input.returnWindowDays)) {
    return {
      eligible: overrideOffered,
      status: 'window_not_set',
      requiresOverride: true,
      overridden: overrideOffered,
      ageDays,
      detail: overrideOffered
        ? `no return window is set; a supervisor authorised this ${ageDays}-day-old return`
        : `no return window is set yet, so this ${ageDays}-day-old return needs a supervisor to authorise it (set the return window to let it pass on its own)`,
    };
  }

  // Inside the window (inclusive of the boundary day): eligible, no second person needed.
  if (ageDays <= input.returnWindowDays) {
    return {
      eligible: true,
      status: 'within_window',
      requiresOverride: false,
      overridden: false,
      ageDays,
      detail: `${ageDays} day(s) after the sale, within the ${input.returnWindowDays}-day return window`,
    };
  }

  // Past the window: blocked; a supervisor may authorise an override (M13-FR-02 acceptance).
  return {
    eligible: overrideOffered,
    status: 'outside_window',
    requiresOverride: true,
    overridden: overrideOffered,
    ageDays,
    detail: overrideOffered
      ? `${ageDays} days after the sale, past the ${input.returnWindowDays}-day window; a supervisor authorised it`
      : `${ageDays} days after the sale is past the ${input.returnWindowDays}-day return window; it needs a supervisor to authorise it`,
  };
}

/** True for the statuses that no override can clear — the dates themselves are wrong. */
export function isDataFault(status: ReturnEligibility): boolean {
  return DATA_FAULTS.has(status);
}
