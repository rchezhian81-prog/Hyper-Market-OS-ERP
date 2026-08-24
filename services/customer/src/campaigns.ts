// API-06 Campaigns — the consent gate at the send (M21-FR-01 / PRV / DPDP / P-02 / P-08).
//
// A campaign is the one place a shop can do real harm at scale in a single click: one send to the
// wrong list is thousands of people who did not agree to be messaged, and it cannot be recalled. So
// the gate is at the SEND, PER RECIPIENT, and it is not negotiable by the person running the campaign:
//
//   • Consent is checked for EACH person individually, against the shop's OWN consent ledger
//     (`mayWeSend`, the same record the rest of the system holds — P-02, one commerce truth), not a
//     list pasted into the request. A list "approved for marketing" is a property of a spreadsheet;
//     consent is a property of a person and it changes between the list being built and the send.
//   • The EXCLUDED COUNT is always reported, grouped by reason. A campaign that silently drops 400
//     people looks like a campaign to 1,600 — naming the number keeps the check defensible when reach
//     shrinks, instead of someone "fixing" it by loosening the gate.
//   • CHANNEL and PURPOSE are separate: consent to email is not consent to WhatsApp, and a marketing
//     send needs marketing consent even to a customer who agreed to service messages.
//   • A TRANSACTIONAL message rides the contract, not consent ("your order is out for delivery") — but
//     it must not become a route for marketing, so a transactional send carrying a promotion is refused
//     outright, for everyone.
//
// The decisions are the tested `planCampaign` in `@sre/service-desk` (the services-run-on-their-tested-
// engine guardrail). Nothing is SENT from here — this decides who may be sent to, and records that
// decision as an append-only audit fact (counts only; PRV — the recipient lists are not stored). The
// actual message transports (WhatsApp/SMS/email/push) are deployment steps (EX-04/05).
//
// Held as named follow-ons: journeys + honest attribution with a control group (FR-02, `measureCampaign`/
// `findJourneyCandidates`), the do-not-contact and frequency-cap signals (the ledger does not yet carry
// them), template approval sourced from the M31 document register (here it is asserted on the request),
// and a `service`-purpose campaign (the consent ledger models transactional/marketing/profiling/
// third_party, so this wires the two that map cleanly: marketing and transactional).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { planCampaign, type Campaign, type Channel, type Purpose } from '../../../packages/service-desk/src/index';
import { mayWeSend, type ConsentRecord, type ConsentPurpose, type Channel as ConsentChannel } from './index';

/** The append-only record of a campaign-send decision — who ran which campaign, to how many, excluding
 *  how many and why, and whether it was blocked outright. Counts only: the recipient lists are not
 *  stored (PRV — a marketing audience is not kept a moment longer than the send needs it). */
export interface CampaignPlanRecord {
  readonly campaignId: string;
  readonly purpose: Purpose;
  readonly channel: Channel;
  readonly templateId: string;
  readonly sendToCount: number;
  readonly excludedCount: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly blocked: boolean;
  readonly plannedBy: string;
  readonly at: string;
}

// The purposes and channels that map cleanly onto the stored consent ledger. `service` is deliberately
// excluded here (the ledger has no `service` consent) and named as a follow-on above.
const PURPOSES: readonly Purpose[] = ['marketing', 'transactional'];
const CHANNELS: readonly Channel[] = ['whatsapp', 'sms', 'email', 'push'];

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim() !== '') ? (v as string[]) : undefined;

export interface CampaignDeps {
  /** This customer's consent ledger — the SAME record the rest of the system reads (P-02). */
  readonly consentRecords: (tenantId: string, customerId: string) => Promise<readonly ConsentRecord[]> | readonly ConsentRecord[];
  /** The append-only campaign-decision log for the tenant. */
  readonly plans: (tenantId: string) => Promise<readonly CampaignPlanRecord[]> | readonly CampaignPlanRecord[];
  readonly recordPlan: (tenantId: string, rec: CampaignPlanRecord, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function campaignRoutes(deps: CampaignDeps): readonly Route[] {
  return [
    {
      // Decide who a campaign may reach, checking each recipient against the shop's own consent ledger.
      // Body: { purpose (marketing/transactional), channel (whatsapp/sms/email/push), templateId,
      // templateApproved, containsPromotion, audience: string[] }. Records the decision (counts only)
      // and returns the plan — the send-to list plus the excluded, grouped by reason.
      api: 'API-06', method: 'POST', path: '/v1/service/campaigns/:campaignId/plan',
      permission: 'customer.campaign.send', idempotent: true,
      handler: async (ctx) => {
        const campaignId = (ctx.params['campaignId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const audience = strArray(b['audience']);
        if (campaignId === '' || !PURPOSES.includes(b['purpose'] as Purpose) || !CHANNELS.includes(b['channel'] as Channel)
          || !isStr(b['templateId']) || !isBool(b['templateApproved']) || !isBool(b['containsPromotion']) || audience === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_campaign',
            whatHappened: 'A campaign plan needs a campaignId in the path and { purpose (marketing/transactional), channel (whatsapp/sms/email/push), templateId, templateApproved, containsPromotion, audience[] } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the campaign, the approved template and the audience to check against consent.',
          });
        }
        const purpose = b['purpose'] as Purpose;
        const channel = b['channel'] as Channel;
        const now = deps.now();

        // Fold each recipient's stored consent into the engine's per-recipient shape, driven by
        // `mayWeSend` for THIS purpose/channel — so a withdrawal reads as a withdrawal and an absent
        // record reads as no-consent (never as agreement), and a transactional send (which mayWeSend
        // always clears) rides the contract for everyone. An entry is produced for every audience member
        // so the engine can still surface the whole-campaign blocks (unapproved template, promotion in a
        // transactional message) rather than an unexplained empty list.
        const consents = await Promise.all(audience.map(async (customerRef) => {
          const records = await deps.consentRecords(ctx.tenantId, customerRef);
          const d = mayWeSend({ customerId: customerRef, purpose: purpose as ConsentPurpose, channel: channel as ConsentChannel, records, now });
          if (d.verdict === 'may_send') return { customerRef, granted: [{ purpose, channel }] };
          if (d.verdict === 'must_not_send') return { customerRef, granted: [], withdrawnAt: d.basis?.recordedAt ?? d.decidedAt };
          return { customerRef, granted: [] }; // no_consent_on_record — silence is not agreement
        }));

        const campaign: Campaign = {
          campaignId, purpose, channel,
          templateId: b['templateId'] as string, templateApproved: b['templateApproved'] as boolean,
          containsPromotion: b['containsPromotion'] as boolean,
        };
        const plan = planCampaign({ campaign, audience, consents });

        const rec: CampaignPlanRecord = {
          campaignId, purpose, channel, templateId: campaign.templateId,
          sendToCount: plan.sendTo.length, excludedCount: plan.excludedCount,
          excludedByReason: plan.excludedByReason, blocked: plan.blocked,
          plannedBy: ctx.userId, at: now,
        };
        await deps.recordPlan(ctx.tenantId, rec, `${campaignId}-${ctx.idempotencyKey ?? now}`);

        return {
          status: 200,
          body: {
            campaignId, purpose, channel, blocked: plan.blocked,
            sendTo: plan.sendTo, sendToCount: plan.sendTo.length,
            excluded: plan.excluded, excludedCount: plan.excludedCount, excludedByReason: plan.excludedByReason,
            plannedBy: ctx.userId, at: now, detail: plan.detail,
          },
        };
      },
    },
    {
      // The campaign-decision log — who ran what, to how many, excluding how many and why. Most recent
      // first. The trail that keeps the consent gate defensible when reach shrinks (P-08).
      api: 'API-06', method: 'GET', path: '/v1/service/campaigns/plans',
      permission: 'customer.campaign.read',
      handler: async (ctx) => {
        const plans = [...(await deps.plans(ctx.tenantId))].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        return { status: 200, body: { plans, count: plans.length } };
      },
    },
  ];
}
