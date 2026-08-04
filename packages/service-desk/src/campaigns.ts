// Campaigns, journeys and attribution (M21-FR-01 / M21-FR-02 / PRV / P-08).
//
// A campaign is the one place where a shop can do real damage at scale in a single
// click: one send to the wrong list is thousands of people who did not consent, and it
// cannot be recalled. So the gate is at the **send**, per recipient, and it is not
// negotiable by the person running the campaign.
//
//   • **EVERY RECIPIENT IS CHECKED INDIVIDUALLY**, not the list as a whole. A list
//     "approved for marketing" is a property of a spreadsheet; consent is a property of
//     a person, and it changes between the list being built and the message being sent.
//   • **THE EXCLUDED COUNT IS ALWAYS REPORTED.** A campaign that quietly drops 400
//     people looks like a campaign to 1,600 — and when the reach keeps shrinking,
//     somebody "fixes" it by loosening the check. Naming the number keeps the check
//     defensible.
//   • **CHANNEL AND PURPOSE ARE SEPARATE PERMISSIONS.** Consent to email is not consent
//     to WhatsApp, and consent to service messages is never consent to marketing.
//   • **A TRANSACTIONAL MESSAGE IS NOT A CAMPAIGN.** "Your order is out for delivery" is
//     performance of the contract and does not need marketing consent — but it must not
//     become a route for marketing, so a transactional send carrying a promotion is
//     refused outright.
//
// **Attribution is measured honestly** (M21-FR-02): only orders placed *after* the
// message, inside the attribution window, from people who actually received it — and the
// module reports the **control group's** conversion beside it, because a win-back campaign
// that "recovered" customers who were coming back anyway is a cost reported as a success.
//
// Pure and deterministic: nothing is sent from here; this decides who may be sent to.

export type Channel = 'whatsapp' | 'sms' | 'email' | 'push';
export type Purpose = 'marketing' | 'service' | 'transactional';

export interface RecipientConsent {
  readonly customerRef: string;
  /** Channels this person accepted, per purpose. */
  readonly granted: readonly { readonly purpose: Purpose; readonly channel: Channel }[];
  readonly withdrawnAt?: string;
  /** Do-not-contact overrides everything, including transactional marketing. */
  readonly doNotContact?: boolean;
  /** Messages already sent in the frequency window. */
  readonly sentInWindow?: number;
}

export interface Campaign {
  readonly campaignId: string;
  readonly purpose: Purpose;
  readonly channel: Channel;
  /** The approved template id — an unapproved template cannot be sent (M31-FR-03). */
  readonly templateId: string;
  readonly templateApproved: boolean;
  /** True when the message contains an offer or promotion. */
  readonly containsPromotion: boolean;
  readonly frequencyCapInWindow?: number;
}

export type SendRefusal =
  | 'sendable'
  | 'template_not_approved'
  | 'do_not_contact'
  | 'no_consent'
  | 'withdrawn'
  | 'frequency_cap'
  | 'promotion_in_transactional';

export interface RecipientDecision {
  readonly customerRef: string;
  readonly sendable: boolean;
  readonly reason: SendRefusal;
  readonly detail: string;
}

export interface CampaignPlan {
  readonly campaignId: string;
  readonly channel: Channel;
  readonly purpose: Purpose;
  readonly sendTo: readonly string[];
  readonly excluded: readonly RecipientDecision[];
  readonly excludedCount: number;
  /** Excluded, grouped by reason — the shape a manager can actually act on. */
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly blocked: boolean;
  readonly detail: string;
}

function hasConsent(c: RecipientConsent, purpose: Purpose, channel: Channel): boolean {
  return c.granted.some((g) => g.purpose === purpose && g.channel === channel);
}

/**
 * Decide, **per recipient**, who this campaign may reach.
 *
 * A refusal that applies to everyone (an unapproved template, a promotion smuggled into a
 * transactional send) blocks the whole campaign rather than producing an empty list with
 * no explanation.
 */
export function planCampaign(input: {
  readonly campaign: Campaign;
  readonly audience: readonly string[];
  readonly consents: readonly RecipientConsent[];
}): CampaignPlan {
  const c = input.campaign;
  const byRef = new Map(input.consents.map((x) => [x.customerRef, x]));

  const blockAll = (reason: SendRefusal, detail: string): CampaignPlan => ({
    campaignId: c.campaignId,
    channel: c.channel,
    purpose: c.purpose,
    sendTo: [],
    excluded: input.audience.map((customerRef) => ({ customerRef, sendable: false, reason, detail })),
    excludedCount: input.audience.length,
    excludedByReason: { [reason]: input.audience.length },
    blocked: true,
    detail,
  });

  if (!c.templateApproved) {
    return blockAll('template_not_approved', `template ${c.templateId} is not approved — nothing is sent`);
  }
  if (c.purpose === 'transactional' && c.containsPromotion) {
    // The loophole this closes: dressing marketing as an order update to bypass consent.
    return blockAll(
      'promotion_in_transactional',
      'this is a transactional message carrying a promotion — a service message cannot be used as a route around marketing consent',
    );
  }

  const decisions = input.audience.map((customerRef): RecipientDecision => {
    const consent = byRef.get(customerRef);
    if (consent === undefined) {
      return { customerRef, sendable: false, reason: 'no_consent', detail: 'no consent record for this customer' };
    }
    if (consent.doNotContact === true) {
      return { customerRef, sendable: false, reason: 'do_not_contact', detail: 'this customer has asked never to be contacted' };
    }
    if (consent.withdrawnAt !== undefined) {
      return { customerRef, sendable: false, reason: 'withdrawn', detail: `consent withdrawn on ${consent.withdrawnAt.slice(0, 10)}` };
    }
    // Transactional messages ride the contract, not consent — but only when they carry
    // no promotion, which is checked above for the whole campaign.
    if (c.purpose !== 'transactional' && !hasConsent(consent, c.purpose, c.channel)) {
      return {
        customerRef,
        sendable: false,
        reason: 'no_consent',
        detail: `no ${c.purpose} consent for ${c.channel} — consent to one channel is not consent to another`,
      };
    }
    if (
      c.frequencyCapInWindow !== undefined &&
      (consent.sentInWindow ?? 0) >= c.frequencyCapInWindow
    ) {
      return {
        customerRef,
        sendable: false,
        reason: 'frequency_cap',
        detail: `already received ${consent.sentInWindow} message(s) against a cap of ${c.frequencyCapInWindow}`,
      };
    }
    return { customerRef, sendable: true, reason: 'sendable', detail: 'consented and within the cap' };
  });

  const sendTo = decisions.filter((d) => d.sendable).map((d) => d.customerRef);
  const excluded = decisions.filter((d) => !d.sendable);
  const excludedByReason: Record<string, number> = {};
  for (const e of excluded) excludedByReason[e.reason] = (excludedByReason[e.reason] ?? 0) + 1;

  return {
    campaignId: c.campaignId,
    channel: c.channel,
    purpose: c.purpose,
    sendTo,
    excluded,
    excludedCount: excluded.length,
    excludedByReason,
    blocked: false,
    detail:
      excluded.length === 0
        ? `${sendTo.length} recipient(s)`
        : `${sendTo.length} recipient(s); ${excluded.length} excluded (${Object.entries(excludedByReason).map(([k, v]) => `${v} ${k}`).join(', ')}) — the number is stated so the check stays defensible`,
  };
}

// --- journeys and attribution (M21-FR-02) ------------------------------------------

export type JourneyKind = 'abandoned_cart' | 'occasion' | 'win_back';

export interface JourneyTrigger {
  readonly customerRef: string;
  readonly kind: JourneyKind;
  readonly triggeredAt: string;
  readonly valueMinor: number;
  readonly ref: string;
}

export interface JourneyCandidate extends JourneyTrigger {
  readonly eligible: boolean;
  readonly detail: string;
}

/**
 * Find who a journey should reach. The **quiet period** matters more than it looks: an
 * abandoned-cart message fired four minutes after someone put down their phone is not a
 * nudge, it is surveillance, and it is the message people screenshot.
 */
export function findJourneyCandidates(input: {
  readonly kind: JourneyKind;
  readonly triggers: readonly JourneyTrigger[];
  readonly now: string;
  /** Minutes to wait before contacting. Default 60 for a cart. */
  readonly quietMinutes?: number;
  /** Minutes after which the trigger is too old to be relevant. Default 2880 (2 days). */
  readonly staleAfterMinutes?: number;
  /** Customers who already completed the thing the journey is chasing. */
  readonly completedRefs?: readonly string[];
  readonly minimumValueMinor?: number;
}): readonly JourneyCandidate[] {
  const quiet = (input.quietMinutes ?? 60) * 60_000;
  const stale = (input.staleAfterMinutes ?? 2_880) * 60_000;
  const completed = new Set(input.completedRefs ?? []);
  const now = Date.parse(input.now);

  return input.triggers
    .filter((t) => t.kind === input.kind)
    .map((t): JourneyCandidate => {
      const age = now - Date.parse(t.triggeredAt);
      if (completed.has(t.customerRef)) {
        return { ...t, eligible: false, detail: 'they already did it — chasing them now is an apology waiting to happen' };
      }
      if (age < quiet) {
        return { ...t, eligible: false, detail: `only ${Math.round(age / 60_000)} minutes ago — a message this soon reads as surveillance, not a reminder` };
      }
      if (age > stale) {
        return { ...t, eligible: false, detail: `${Math.round(age / 60_000 / 60)} hours ago — too late to be relevant` };
      }
      if (input.minimumValueMinor !== undefined && t.valueMinor < input.minimumValueMinor) {
        return { ...t, eligible: false, detail: `${t.valueMinor} is below the ${input.minimumValueMinor} threshold for this journey` };
      }
      return { ...t, eligible: true, detail: `${Math.round(age / 60_000)} minutes ago, worth ${t.valueMinor}` };
    })
    .sort((a, b) => b.valueMinor - a.valueMinor || a.customerRef.localeCompare(b.customerRef));
}

export interface AttributionResult {
  readonly campaignId: string;
  readonly sent: number;
  readonly converted: number;
  readonly conversionBps: number;
  readonly attributedRevenueMinor: number;
  readonly attributedMarginMinor: number;
  /** The control group's conversion — the number that says whether it worked. */
  readonly controlConversionBps: number | 'no_control_group';
  readonly upliftBps: number | 'not_meaningful';
  readonly detail: string;
}

/**
 * Measure a campaign honestly.
 *
 * Two disciplines that separate a real measurement from a flattering one:
 *   • **Only orders after the send, inside the window, by people who received it.** An
 *     order placed an hour before the message did not come from the message.
 *   • **The control group is reported beside it.** A win-back campaign that "recovered"
 *     18% of lapsed customers, when 15% of an untouched control came back anyway, cost
 *     money to achieve 3% — and without the control it reads as a triumph.
 */
export function measureCampaign(input: {
  readonly campaignId: string;
  readonly sentTo: readonly string[];
  readonly sentAt: string;
  readonly attributionWindowHours: number;
  readonly orders: readonly {
    readonly customerRef: string;
    readonly at: string;
    readonly netMinor: number;
    readonly marginMinor: number;
  }[];
  /** Comparable customers deliberately not sent to. */
  readonly controlGroup?: readonly string[];
}): AttributionResult {
  const sent = new Set(input.sentTo);
  const windowEnd = Date.parse(input.sentAt) + input.attributionWindowHours * 3_600_000;
  const sentAtMs = Date.parse(input.sentAt);

  const inWindow = input.orders.filter((o) => {
    const at = Date.parse(o.at);
    return at >= sentAtMs && at <= windowEnd;
  });

  const attributed = inWindow.filter((o) => sent.has(o.customerRef));
  const convertedRefs = new Set(attributed.map((o) => o.customerRef));
  const conversionBps =
    input.sentTo.length === 0 ? 0 : Math.round((convertedRefs.size / input.sentTo.length) * 10_000);

  let controlConversionBps: number | 'no_control_group' = 'no_control_group';
  let upliftBps: number | 'not_meaningful' = 'not_meaningful';
  if (input.controlGroup !== undefined && input.controlGroup.length > 0) {
    const control = new Set(input.controlGroup);
    const controlConverted = new Set(
      inWindow.filter((o) => control.has(o.customerRef)).map((o) => o.customerRef),
    );
    controlConversionBps = Math.round((controlConverted.size / input.controlGroup.length) * 10_000);
    upliftBps = conversionBps - controlConversionBps;
  }

  return {
    campaignId: input.campaignId,
    sent: input.sentTo.length,
    converted: convertedRefs.size,
    conversionBps,
    attributedRevenueMinor: attributed.reduce((s, o) => s + o.netMinor, 0),
    attributedMarginMinor: attributed.reduce((s, o) => s + o.marginMinor, 0),
    controlConversionBps,
    upliftBps,
    detail:
      controlConversionBps === 'no_control_group'
        ? `${convertedRefs.size} of ${input.sentTo.length} converted (${(conversionBps / 100).toFixed(2)}%) — with no control group this cannot be called uplift, only activity`
        : upliftBps === 'not_meaningful' || upliftBps <= 0
          ? `${(conversionBps / 100).toFixed(2)}% converted against ${(controlConversionBps / 100).toFixed(2)}% of an untouched control — this campaign did not beat doing nothing`
          : `${(conversionBps / 100).toFixed(2)}% converted against ${(controlConversionBps / 100).toFixed(2)}% control — ${(Number(upliftBps) / 100).toFixed(2)} points of real uplift`,
  };
}
