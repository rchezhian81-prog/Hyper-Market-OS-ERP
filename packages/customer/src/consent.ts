// Consent enforcement (M16-FR-02) — consent-scoped processing (PRV). A message may
// be sent only where the customer has granted consent for that PURPOSE and CHANNEL
// and has not withdrawn it, and within the frequency cap. A send that would breach
// consent or frequency is BLOCKED, not warned-and-allowed (M16-FR-02 acceptance).
// Withdrawal takes effect immediately. Pure and deterministic.

export interface ConsentGrant {
  readonly purpose: string;
  readonly channel: string;
  readonly granted: boolean;
  /** A withdrawal takes effect immediately and is retained in history. */
  readonly withdrawn?: boolean;
}

export interface ConsentState {
  readonly grants: readonly ConsentGrant[];
}

export type SendBlockReason = 'no_consent' | 'withdrawn' | 'frequency_cap';

export interface SendDecision {
  readonly allowed: boolean;
  readonly reason?: SendBlockReason;
}

function findGrant(state: ConsentState, purpose: string, channel: string): ConsentGrant | undefined {
  return state.grants.find((g) => g.purpose === purpose && g.channel === channel);
}

/** True only if consent is granted for this purpose+channel and not withdrawn. */
export function hasConsent(state: ConsentState, purpose: string, channel: string): boolean {
  const grant = findGrant(state, purpose, channel);
  return grant !== undefined && grant.granted && !grant.withdrawn;
}

export interface CanSendInput {
  readonly state: ConsentState;
  readonly purpose: string;
  readonly channel: string;
  /** Messages already sent for this purpose+channel in the frequency window. */
  readonly sentInWindow?: number;
  /** Max messages allowed in the window; omit for no frequency limit. */
  readonly frequencyCap?: number;
}

/**
 * Decide whether a message may be sent. Blocks (does not warn) when there is no
 * consent, when consent was withdrawn, or when the frequency cap is reached.
 */
export function canSend(input: CanSendInput): SendDecision {
  const grant = findGrant(input.state, input.purpose, input.channel);
  if (grant !== undefined && grant.withdrawn) {
    return { allowed: false, reason: 'withdrawn' };
  }
  if (grant === undefined || !grant.granted) {
    return { allowed: false, reason: 'no_consent' };
  }
  if (
    input.frequencyCap !== undefined &&
    (input.sentInWindow ?? 0) >= input.frequencyCap
  ) {
    return { allowed: false, reason: 'frequency_cap' };
  }
  return { allowed: true };
}
