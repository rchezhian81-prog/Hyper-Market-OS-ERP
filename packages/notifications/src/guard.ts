// Notification send guard (M31-FR-03/04) — consent-safe BY CONSTRUCTION. Before any
// notification goes out, every gate must pass: the template is approved (§28), the
// contact is not on the suppression / do-not-contact list (absolute), consent for
// the purpose+channel is granted and within the frequency cap (reusing the customer
// consent engine, M16-FR-02), and the messaging budget is not exceeded. A breach
// BLOCKS the send (never warned-and-sent). Pure and deterministic.

import { canSend, type ConsentState, type SendBlockReason } from '../../customer/src/consent';

export type NotifyBlockReason = 'unapproved_template' | 'suppressed' | SendBlockReason | 'over_budget';

export interface NotifyInput {
  readonly consent: ConsentState;
  readonly purpose: string;
  readonly channel: string;
  /** Templates must be approved before use (M31-FR-04 / §28). */
  readonly templateApproved: boolean;
  /** Do-not-contact suppression — absolute (M31-FR-04). */
  readonly suppressed?: boolean;
  readonly sentInWindow?: number;
  readonly frequencyCap?: number;
  /** Cost of this send and the remaining messaging budget (both minor units). */
  readonly costMinor?: number;
  readonly budgetRemainingMinor?: number;
}

export interface NotifyDecision {
  readonly allowed: boolean;
  readonly reason?: NotifyBlockReason;
}

/**
 * Decide whether a notification may be sent. Gates, in order: approved template →
 * suppression (absolute) → consent + frequency → budget. Blocks (never warns) on the
 * first failing gate.
 */
export function canNotify(input: NotifyInput): NotifyDecision {
  if (!input.templateApproved) {
    return { allowed: false, reason: 'unapproved_template' };
  }
  if (input.suppressed) {
    return { allowed: false, reason: 'suppressed' };
  }
  const consentDecision = canSend({
    state: input.consent,
    purpose: input.purpose,
    channel: input.channel,
    sentInWindow: input.sentInWindow,
    frequencyCap: input.frequencyCap,
  });
  if (!consentDecision.allowed) {
    return { allowed: false, reason: consentDecision.reason };
  }
  if (
    input.costMinor !== undefined &&
    input.budgetRemainingMinor !== undefined &&
    input.costMinor > input.budgetRemainingMinor
  ) {
    return { allowed: false, reason: 'over_budget' };
  }
  return { allowed: true };
}
