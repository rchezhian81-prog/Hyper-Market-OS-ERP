// API-06 Campaign SEND — from the consent-checked plan to the durable queue, within the frequency cap, with the
// delivery status visible (audit PF-10 · M21-FR-01 · M31-FR-04 · PRV / DPDP).
//
// The plan route (`campaigns.ts`) decides who MAY be sent to. The audit found nothing after it: no frequency history,
// nothing queued, no delivery status. This is that half, on head office's own records only:
//
//   • FREQUENCY. The owner sets the cap (how many marketing messages one customer may get on one channel in a window of
//     days). The history is the PA-08 notification queue itself — every marketing message already queued for that
//     customer on that channel inside the window (a message withheld or dead-lettered never reached them and does not
//     count). A recipient at the cap is EXCLUDED and named (`frequency_cap`), never warned-and-sent. With no cap set, a
//     marketing send is refused (it would not be "within frequency rules", M21-FR-01); transactional messages are not
//     capped.
//   • QUEUE. Each approved recipient is enqueued on the PA-08 queue as a full intent (recipient, purpose, the approved
//     template version, the rendered words) with a deterministic id per campaign and customer — the same campaign sent
//     twice queues nothing twice. The queue's sender (Batch 1's worker) RE-CHECKS consent immediately before each message
//     and withholds one whose consent was withdrawn after queuing; this route only enqueues.
//   • DELIVERY CALLBACKS. A provider's delivery report (delivered / failed / read) is recorded against the message it is
//     about — only for a message of this campaign that the queue actually handed to a provider, and only with that
//     provider's own reference. `GET …/status` shows every message's queue state and its latest report.
//
// Provider access (credentials, certification, the real webhook) is an external gate; tests use the recording adapter.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { planCampaign, type Campaign, type Channel, type Purpose } from '../../../packages/service-desk/src/index';
import type { NotificationQueue } from '../../../packages/notifications/src/index';
import { mayWeSend, type ConsentRecord, type ConsentPurpose, type Channel as ConsentChannel } from './index';
import { approvedTemplate, renderTemplate, type MessageTemplateVersion, type NotificationQueueEvent } from './notification-queue';

/** The owner's cap: at most `capPerWindow` marketing messages to one customer on one channel in `windowDays` days. */
export interface CampaignFrequencyPolicy {
  readonly capPerWindow: number;
  readonly windowDays: number;
  readonly setBy: string;
  readonly setAt: string;
}

/** What one campaign send queued — the append-only record of the send (counts and message ids; no contact details). */
export interface CampaignSendRecord {
  readonly campaignId: string;
  readonly purpose: Purpose;
  readonly channel: Channel;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly messageIds: readonly string[];
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly sentBy: string;
  readonly at: string;
}

/** A provider's delivery report, recorded against the message it is about. */
export interface DeliveryCallback {
  readonly campaignId: string;
  readonly messageId: string;
  readonly status: 'delivered' | 'failed' | 'read';
  readonly providerRef: string;
  readonly reportedAt: string;
  readonly reason?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface CampaignSendDeps {
  readonly consentRecords: (tenantId: string, customerId: string) => Promise<readonly ConsentRecord[]> | readonly ConsentRecord[];
  readonly templates: (tenantId: string) => Promise<readonly MessageTemplateVersion[]> | readonly MessageTemplateVersion[];
  /** The PA-08 queue: its facts (the frequency history and receipts), its current state, and its enqueue. */
  readonly queueEvents: (tenantId: string) => Promise<readonly NotificationQueueEvent[]> | readonly NotificationQueueEvent[];
  readonly queue: (tenantId: string) => Promise<NotificationQueue> | NotificationQueue;
  readonly enqueue: (tenantId: string, event: NotificationQueueEvent, key: string) => Promise<void> | void;
  readonly frequencyPolicy: (tenantId: string) => Promise<CampaignFrequencyPolicy | undefined> | CampaignFrequencyPolicy | undefined;
  readonly recordFrequencyPolicy: (tenantId: string, p: CampaignFrequencyPolicy) => Promise<void> | void;
  readonly sends: (tenantId: string, campaignId: string) => Promise<readonly CampaignSendRecord[]> | readonly CampaignSendRecord[];
  readonly recordSend: (tenantId: string, r: CampaignSendRecord, key: string) => Promise<void> | void;
  readonly callbacks: (tenantId: string, campaignId: string) => Promise<readonly DeliveryCallback[]> | readonly DeliveryCallback[];
  readonly recordCallback: (tenantId: string, c: DeliveryCallback, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const PURPOSES: readonly Purpose[] = ['marketing', 'transactional'];
const CHANNELS: readonly Channel[] = ['whatsapp', 'sms', 'email', 'push'];
const STATUSES: readonly DeliveryCallback['status'][] = ['delivered', 'failed', 'read'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The message id for one recipient of one campaign — deterministic, so a re-send queues nothing twice. */
export const campaignMessageId = (campaignId: string, customerRef: string): string => `cmp-${campaignId}-${customerRef}`;

/** Marketing messages already queued for this customer on this channel inside the window (that were not withheld/dead). */
export function sentInWindow(input: {
  readonly events: readonly NotificationQueueEvent[];
  readonly queue: NotificationQueue;
  readonly customerRef: string;
  readonly channel: string;
  readonly now: string;
  readonly windowDays: number;
  /** This campaign's own message — a retry of the same send must not cap itself. */
  readonly except: string;
}): number {
  const from = Date.parse(input.now) - input.windowDays * 86_400_000;
  let n = 0;
  for (const e of input.events) {
    if (e.change !== 'enqueued' || e.intent === undefined || e.id === input.except) continue;
    if (e.intent.customerId !== input.customerRef || e.intent.purpose !== 'marketing' || e.channel !== input.channel) continue;
    if (Date.parse(e.at) < from) continue;
    const state = input.queue.find(e.id)?.state;
    if (state === 'withheld' || state === 'dead_letter') continue; // never reached them
    n += 1;
  }
  return n;
}

export function campaignSendRoutes(deps: CampaignSendDeps): readonly Route[] {
  return [
    {
      // The owner's frequency cap. Body: { capPerWindow (1–50), windowDays (1–90) }. A new version each time.
      api: 'API-06', method: 'PUT', path: '/v1/service/campaigns/frequency-policy',
      permission: 'customer.campaign.policy', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isInt(b['capPerWindow']) || (b['capPerWindow'] as number) < 1 || (b['capPerWindow'] as number) > 50
          || !isInt(b['windowDays']) || (b['windowDays'] as number) < 1 || (b['windowDays'] as number) > 90) {
          throw apiError(400, { code: 'not_readable_as_a_frequency_policy', whatHappened: 'A frequency cap needs { capPerWindow (1–50 messages), windowDays (1–90 days) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send both numbers. The cap in force is unchanged.' });
        }
        const policy: CampaignFrequencyPolicy = { capPerWindow: b['capPerWindow'] as number, windowDays: b['windowDays'] as number, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordFrequencyPolicy(ctx.tenantId, policy);
        return { status: 200, body: { policy, detail: `At most ${policy.capPerWindow} marketing message(s) per customer per channel in any ${policy.windowDays} day(s).` } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/service/campaigns/frequency-policy',
      permission: 'customer.campaign.read',
      handler: async (ctx) => {
        const policy = await deps.frequencyPolicy(ctx.tenantId);
        return { status: 200, body: { policy: policy ?? null, detail: policy === undefined ? 'No frequency cap is set — marketing campaigns cannot be sent until the owner sets one.' : `At most ${policy.capPerWindow} per customer per channel in ${policy.windowDays} day(s).` } };
      },
    },
    {
      // SEND a campaign: consent per recipient from the ledger, the template from the register, the frequency history
      // from the queue — then each approved recipient enqueued on the PA-08 queue. Body: { purpose, channel, templateId,
      // containsPromotion, audience[], values? }.
      api: 'API-06', method: 'POST', path: '/v1/service/campaigns/:campaignId/send',
      permission: 'customer.campaign.send', idempotent: true,
      handler: async (ctx) => {
        const campaignId = (ctx.params['campaignId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const audience = Array.isArray(b['audience']) && b['audience'].length > 0 && b['audience'].every(isStr) ? [...new Set(b['audience'] as string[])] : undefined;
        const values = b['values'] === undefined ? {} : b['values'];
        if (!/^[A-Za-z0-9-]{1,48}$/.test(campaignId) || !PURPOSES.includes(b['purpose'] as Purpose) || !CHANNELS.includes(b['channel'] as Channel)
          || !isStr(b['templateId']) || typeof b['containsPromotion'] !== 'boolean' || audience === undefined
          || !isObj(values) || !Object.values(values).every((v) => typeof v === 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_campaign_send',
            whatHappened: 'A campaign send needs { purpose (marketing/transactional), channel (whatsapp/sms/email/push), templateId, containsPromotion, audience[], values? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was queued. Send the campaign as planned.',
          });
        }
        const purpose = b['purpose'] as Purpose;
        const channel = b['channel'] as Channel;
        const now = deps.now();
        const template = approvedTemplate(await deps.templates(ctx.tenantId), (b['templateId'] as string).trim());
        const templateOk = template !== undefined && template.purpose === purpose && template.channel === channel;
        const policy = await deps.frequencyPolicy(ctx.tenantId);
        if (purpose === 'marketing' && policy === undefined) {
          throw apiError(409, {
            code: 'frequency_cap_not_set',
            whatHappened: 'No frequency cap is set, so a marketing campaign cannot be sent within the frequency rules (M21-FR-01).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was queued. The owner sets the cap first (PUT /v1/service/campaigns/frequency-policy).',
          });
        }
        const [events, queue] = await Promise.all([deps.queueEvents(ctx.tenantId), deps.queue(ctx.tenantId)]);
        const consents = await Promise.all(audience.map(async (customerRef) => {
          const d = mayWeSend({ customerId: customerRef, purpose: purpose as ConsentPurpose, channel: channel as ConsentChannel, records: await deps.consentRecords(ctx.tenantId, customerRef), now });
          const sent = purpose === 'marketing' ? sentInWindow({ events, queue, customerRef, channel, now, windowDays: policy!.windowDays, except: campaignMessageId(campaignId, customerRef) }) : 0;
          if (d.verdict === 'may_send') return { customerRef, granted: [{ purpose, channel }], sentInWindow: sent };
          if (d.verdict === 'must_not_send') return { customerRef, granted: [], withdrawnAt: d.basis?.recordedAt ?? d.decidedAt, sentInWindow: sent };
          return { customerRef, granted: [], sentInWindow: sent };
        }));
        const campaign: Campaign = {
          campaignId, purpose, channel, templateId: (b['templateId'] as string).trim(), templateApproved: templateOk,
          containsPromotion: b['containsPromotion'] as boolean,
          ...(purpose === 'marketing' ? { frequencyCapInWindow: policy!.capPerWindow } : {}),
        };
        const plan = planCampaign({ campaign, audience, consents });
        if (plan.blocked || !templateOk) {
          throw apiError(422, {
            code: templateOk ? 'campaign_blocked' : 'template_not_approved',
            whatHappened: templateOk ? plan.detail : `Template ${String(b['templateId'])} has no version approved for ${purpose} on ${channel} — nothing is sent with words a second person has not approved.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was queued.',
          });
        }
        const rendered = renderTemplate(template!.body, values as Record<string, string>);
        if (!rendered.ok) {
          throw apiError(422, { code: 'template_value_missing', whatHappened: `The template needs ${rendered.missing.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was queued. Send a value for every {placeholder}.' });
        }
        const queued: string[] = [];
        const alreadyQueued: string[] = [];
        for (const customerRef of plan.sendTo) {
          const id = campaignMessageId(campaignId, customerRef);
          if (queue.find(id) !== undefined) { alreadyQueued.push(id); continue; }
          await deps.enqueue(ctx.tenantId, {
            id, change: 'enqueued', by: ctx.userId, at: now, channel,
            intent: { customerId: customerRef, purpose: purpose as ConsentPurpose, templateId: template!.templateId, templateVersion: template!.version, text: rendered.text },
          }, `notif-enqueue-${id}`);
          queued.push(id);
        }
        const record: CampaignSendRecord = {
          campaignId, purpose, channel, templateId: template!.templateId, templateVersion: template!.version,
          messageIds: [...alreadyQueued, ...queued].sort(), excludedByReason: plan.excludedByReason, sentBy: ctx.userId, at: now,
        };
        if (queued.length > 0) await deps.recordSend(ctx.tenantId, record, `${campaignId}-${queued.sort().join(',')}`);
        return {
          status: queued.length > 0 ? 201 : 200,
          body: {
            campaignId, queued: queued.length, alreadyQueued: alreadyQueued.length, messageIds: record.messageIds,
            excluded: plan.excluded, excludedCount: plan.excludedCount, excludedByReason: plan.excludedByReason,
            ...(purpose === 'marketing' ? { frequencyCap: { capPerWindow: policy!.capPerWindow, windowDays: policy!.windowDays } } : {}),
            detail: `${queued.length} message(s) queued, ${alreadyQueued.length} already queued, ${plan.excludedCount} excluded. Consent is checked again by the sender just before each message goes.`,
          },
        };
      },
    },
    {
      // A provider's DELIVERY REPORT for one message of this campaign. Body: { status (delivered/failed/read), providerRef,
      // reportedAt?, reason? }. Only for a message the queue handed to a provider, and only with that provider's reference.
      api: 'API-06', method: 'POST', path: '/v1/service/campaigns/:campaignId/messages/:messageId/status',
      permission: 'notification.send.check', idempotent: true,
      handler: async (ctx) => {
        const campaignId = (ctx.params['campaignId'] ?? '').trim();
        const messageId = (ctx.params['messageId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!STATUSES.includes(b['status'] as DeliveryCallback['status']) || !isStr(b['providerRef'])
          || (b['reportedAt'] !== undefined && (!isStr(b['reportedAt']) || Number.isNaN(Date.parse(b['reportedAt'] as string))))
          || (b['status'] === 'failed' && !isStr(b['reason']))) {
          throw apiError(400, { code: 'not_readable_as_a_delivery_report', whatHappened: 'A delivery report needs { status (delivered/failed/read), providerRef, reportedAt?, reason (for a failure) }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded.' });
        }
        const sent = (await deps.sends(ctx.tenantId, campaignId)).some((s) => s.messageIds.includes(messageId));
        if (!sent) throw apiError(404, { code: 'unknown_campaign_message', whatHappened: `Campaign ${campaignId} queued no message ${messageId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. Check the campaign and message ids.' });
        const receipt = [...(await deps.queueEvents(ctx.tenantId))].reverse().find((e) => e.id === messageId && e.change === 'delivered');
        if (receipt === undefined) {
          throw apiError(409, { code: 'not_handed_to_a_provider', whatHappened: `Message ${messageId} has not been handed to a provider, so no provider can report on it.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. A report is taken only after the sender has sent the message.' });
        }
        if (receipt.providerRef !== undefined && receipt.providerRef !== b['providerRef']) {
          throw apiError(409, { code: 'provider_reference_mismatch', whatHappened: `The report names provider reference ${String(b['providerRef'])}, but message ${messageId} was sent as ${receipt.providerRef}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. A report must come from the provider that took the message.' });
        }
        const callback: DeliveryCallback = {
          campaignId, messageId, status: b['status'] as DeliveryCallback['status'], providerRef: b['providerRef'] as string,
          reportedAt: isStr(b['reportedAt']) ? b['reportedAt'] as string : deps.now(),
          ...(isStr(b['reason']) ? { reason: b['reason'] as string } : {}), recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        await deps.recordCallback(ctx.tenantId, callback, `${messageId}-${callback.status}-${callback.providerRef}`);
        return { status: 201, body: { campaignId, messageId, status: callback.status, providerRef: callback.providerRef } };
      },
    },
    {
      // Where every message of the campaign stands: the queue's state, the provider's receipt, the latest report.
      api: 'API-06', method: 'GET', path: '/v1/service/campaigns/:campaignId/status',
      permission: 'customer.campaign.read',
      handler: async (ctx) => {
        const campaignId = (ctx.params['campaignId'] ?? '').trim();
        const sends = await deps.sends(ctx.tenantId, campaignId);
        if (sends.length === 0) throw apiError(404, { code: 'campaign_never_sent', whatHappened: `Campaign ${campaignId} has not been sent.`, wasItSaved: 'not_saved', nextSafeAction: 'Send it first.' });
        const [queue, events, callbacks] = await Promise.all([deps.queue(ctx.tenantId), deps.queueEvents(ctx.tenantId), deps.callbacks(ctx.tenantId, campaignId)]);
        const ids = [...new Set(sends.flatMap((s) => s.messageIds))].sort();
        const messages = ids.map((id) => {
          const item = queue.find(id);
          const receipt = [...events].reverse().find((e) => e.id === id && e.change === 'delivered');
          const report = [...callbacks].filter((c) => c.messageId === id).sort((a, b) => a.reportedAt.localeCompare(b.reportedAt)).at(-1);
          return {
            messageId: id, queueState: item?.state ?? 'unknown', ...(item?.reason === null || item?.reason === undefined ? {} : { queueReason: item.reason }),
            ...(receipt?.providerRef === undefined ? {} : { providerRef: receipt.providerRef }),
            ...(report === undefined ? {} : { report: { status: report.status, at: report.reportedAt, ...(report.reason === undefined ? {} : { reason: report.reason }) } }),
          };
        });
        const count = (f: (m: typeof messages[number]) => boolean) => messages.filter(f).length;
        return {
          status: 200,
          body: {
            campaignId, messages,
            totals: {
              queued: messages.length, pending: count((m) => m.queueState === 'pending'), sent: count((m) => m.queueState === 'delivered'),
              withheld: count((m) => m.queueState === 'withheld'), deadLettered: count((m) => m.queueState === 'dead_letter'),
              deliveredReported: count((m) => m.report?.status === 'delivered' || m.report?.status === 'read'), failedReported: count((m) => m.report?.status === 'failed'),
            },
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}

/** No store wired (a bare surface): every call refuses honestly — nothing is queued, nothing is claimed. */
export function campaignSendUnwired(now: () => string): CampaignSendDeps {
  const refuse = (): never => {
    throw apiError(503, { code: 'campaign_store_not_wired', whatHappened: 'Head office cannot keep campaign sends here, so nothing was done.', wasItSaved: 'not_saved', nextSafeAction: 'Use the full head-office service.' });
  };
  return {
    consentRecords: refuse, templates: refuse, queueEvents: refuse, queue: refuse, enqueue: refuse, frequencyPolicy: refuse,
    recordFrequencyPolicy: refuse, sends: refuse, recordSend: refuse, callbacks: refuse, recordCallback: refuse, now,
  };
}
