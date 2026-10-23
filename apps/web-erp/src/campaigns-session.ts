// The Campaigns page — plan, approve, send and follow a campaign, and the customer journeys (M21-FR-01 · M21-FR-02 ·
// M31-FR-03/04 · M16-FR-02 · P-03 · P-07 · P-08). A tested, DOM-free session over head office's own routes:
//   • the WORDS: message templates drafted by one person and approved by ANOTHER (GET/POST /v1/notifications/templates…);
//   • the AUDIENCE: a segment, after consent (GET /v1/customer/segments/audience) — who matches but may not be contacted
//     is counted, never hidden;
//   • the PLAN: who the campaign may reach after each customer's own consent and the do-not-contact register, the rest
//     grouped by reason (POST /v1/service/campaigns/:id/plan);
//   • the SEND: through the frequency cap and the budget, onto the message queue (POST /v1/service/campaigns/:id/send);
//   • the STATUS: where every message stands — waiting, sent, withheld, dead letter (GET /v1/service/campaigns/:id/status);
//   • the JOURNEYS: abandoned cart, occasion and win-back, each off until switched on with an approved template, who they
//     would reach now, and what was sent or held back (GET/PUT /v1/service/journeys…, POST /v1/service/journeys/run).
// Nothing is read or written on open; every write is a person's click.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export const SEGMENTS = ['new', 'regular', 'loyal', 'lapsing', 'lapsed'] as const;
export const CHANNELS = ['sms', 'whatsapp', 'email', 'push'] as const;
export const JOURNEYS = ['abandoned_cart', 'occasion', 'win_back'] as const;

export interface TemplateVersion { readonly templateId: string; readonly version: number; readonly purpose: string; readonly channel: string; readonly body: string; readonly state: string; readonly draftedBy: string; readonly approvedBy?: string }
export interface AudienceView { readonly customerRefs: readonly string[]; readonly excludedForConsent: number; readonly detail: string }
export interface PlanView { readonly campaignId: string; readonly blocked: boolean; readonly sendTo: readonly string[]; readonly sendToCount: number; readonly excludedCount: number; readonly excludedByReason: Readonly<Record<string, number>>; readonly detail: string }
export interface SendView { readonly campaignId: string; readonly queued: number; readonly alreadyQueued: number; readonly excludedCount: number; readonly detail: string }
export interface StatusView { readonly campaignId: string; readonly totals: { readonly queued: number; readonly pending: number; readonly sent: number; readonly withheld: number; readonly deadLettered: number } }
export interface JourneyView {
  readonly kind: string; readonly on: boolean; readonly templateId: string | null; readonly channel: string | null; readonly say: string; readonly eligibleCount: number;
  readonly candidates: readonly { readonly customerRef: string; readonly eligible: boolean; readonly detail: string }[];
  readonly outcomes: readonly { readonly customerRef: string; readonly outcome: string; readonly code?: string; readonly detail: string; readonly at: string }[];
}

export const CAMPAIGNS_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Campaigns',
    lead: 'Send offers only to customers who said yes, within the owner\'s frequency cap and budget, in words a second person approved — and see where every message is. Journeys reach a customer once, when the shop\'s own facts say so, and only when switched on.',
    wordsH: 'The words (message templates)', showWords: 'Show the templates', templateId: 'Template name', channel: 'Channel', words: 'The words (use {value} where an amount goes)', draft: 'Draft these words', approve: 'Approve', approved: 'approved', drafted: 'waiting for a second person', withdrawn: 'withdrawn', draftedBy: 'drafted by', approvedBy: 'approved by', draftSaved: 'Drafted — a different person approves it before it can be sent.', approvedSaved: 'Approved.',
    capH: 'Frequency cap', capNotSet: 'No frequency cap is set — the owner sets it first; until then no marketing message is sent.',
    planH: 'Plan a campaign', segment: 'Customers', promotion: 'It contains an offer or a price', findAudience: 'Who can we reach?', plan: 'Check consent and plan', send: 'Send', campaignK: 'Campaign',
    reach: 'can be reached', notContactable: 'match but have not said yes and are not contacted', willSend: 'will be sent', excluded: 'held back', queuedK: 'queued', alreadyK: 'already queued', blocked: 'Blocked:',
    statusH: 'Where the messages are', showStatus: 'Show the status', pendingK: 'waiting', sentK: 'sent', withheldK: 'withheld', deadK: 'dead letter',
    journeysH: 'Journeys', showJourneys: 'Show the journeys', on: 'ON', off: 'OFF', eligibleK: 'would be reached now', switchOn: 'Switch on', switchOff: 'Switch off', reason: 'Why (kept with the change)', run: 'Run the journeys now', ranSay: 'Journeys run — queued:', heldBack: 'held back',
    j_abandoned_cart: 'A basket left without an order', j_occasion: 'A birthday or anniversary the customer gave', j_win_back: 'A customer who has not bought for a while',
    template: 'Template', why_no_consent: 'have not said yes', why_withdrawn: 'took back their yes', why_do_not_contact: 'asked never to be contacted', why_frequency_cap: 'already had enough messages this week', why_template_not_approved: 'the words are not approved', why_promotion_in_transactional: 'an offer cannot go in a service message',
    seg_new: 'New', seg_regular: 'Regular', seg_loyal: 'Loyal', seg_lapsing: 'Lapsing', seg_lapsed: 'Lapsed',
    needTemplate: 'Choose an approved template first. Nothing was sent.', needWords: 'Give the template a name and its words. Nothing was sent.', needAudience: 'Find who can be reached first. Nothing was sent.', needPlan: 'Plan the campaign first, so you see who it reaches. Nothing was sent.', needReason: 'Say why first. Nothing was sent.', needCampaign: 'Give the campaign name. Nothing was read.', needValue: 'These words have a {value} blank — fill it in first. Nothing was sent.', value: 'What goes in {value}',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read campaigns.', cannotSend: 'Your role cannot plan or send campaigns.', cannotWords: 'Your role cannot draft or approve message words.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'பிரச்சாரங்கள்',
    lead: 'ஒப்புக்கொண்ட வாடிக்கையாளர்களுக்கு மட்டும், உரிமையாளரின் அனுப்பும் வரம்பு மற்றும் செலவு வரம்புக்குள், இரண்டாவது நபர் ஒப்புக்கொண்ட வார்த்தைகளில் சலுகைகளை அனுப்புங்கள் — ஒவ்வொரு செய்தியும் எங்கே என்று பாருங்கள். பயணங்கள் கடையின் சொந்தத் தகவல்களின்படி ஒருமுறை மட்டும், இயக்கப்பட்டால் மட்டும் சென்றடையும்.',
    wordsH: 'வார்த்தைகள் (செய்தி வார்ப்புருக்கள்)', showWords: 'வார்ப்புருக்களைக் காட்டு', templateId: 'வார்ப்புருவின் பெயர்', channel: 'வழி', words: 'வார்த்தைகள் (தொகை வரும் இடத்தில் {value})', draft: 'இந்த வார்த்தைகளை வரைவு செய்', approve: 'ஒப்புக்கொள்', approved: 'ஒப்புக்கொள்ளப்பட்டது', drafted: 'இரண்டாவது நபருக்காகக் காத்திருக்கிறது', withdrawn: 'திரும்பப் பெறப்பட்டது', draftedBy: 'வரைந்தவர்', approvedBy: 'ஒப்புக்கொண்டவர்', draftSaved: 'வரைவு செய்யப்பட்டது — அனுப்பும் முன் வேறொருவர் ஒப்புக்கொள்வார்.', approvedSaved: 'ஒப்புக்கொள்ளப்பட்டது.',
    capH: 'அனுப்பும் வரம்பு', capNotSet: 'அனுப்பும் வரம்பு அமைக்கப்படவில்லை — உரிமையாளர் முதலில் அமைக்க வேண்டும்; அதுவரை எந்த விளம்பரச் செய்தியும் அனுப்பப்படாது.',
    planH: 'ஒரு பிரச்சாரத்தைத் திட்டமிடு', segment: 'வாடிக்கையாளர்கள்', promotion: 'இதில் சலுகை அல்லது விலை உள்ளது', findAudience: 'யாரைச் சென்றடையலாம்?', plan: 'ஒப்புதலைச் சரிபார்த்துத் திட்டமிடு', send: 'அனுப்பு', campaignK: 'பிரச்சாரம்',
    reach: 'சென்றடையலாம்', notContactable: 'பொருந்துகின்றனர், ஆனால் ஒப்புக்கொள்ளவில்லை, தொடர்பு கொள்ளப்படமாட்டார்கள்', willSend: 'அனுப்பப்படும்', excluded: 'நிறுத்தப்பட்டவை', queuedK: 'வரிசையில்', alreadyK: 'ஏற்கனவே வரிசையில்', blocked: 'தடுக்கப்பட்டது:',
    statusH: 'செய்திகள் எங்கே உள்ளன', showStatus: 'நிலையைக் காட்டு', pendingK: 'காத்திருக்கிறது', sentK: 'அனுப்பப்பட்டது', withheldK: 'நிறுத்தி வைக்கப்பட்டது', deadK: 'தோல்விப் பட்டியல்',
    journeysH: 'பயணங்கள்', showJourneys: 'பயணங்களைக் காட்டு', on: 'இயக்கம்', off: 'நிறுத்தம்', eligibleK: 'இப்போது சென்றடையப்படுவார்கள்', switchOn: 'இயக்கு', switchOff: 'நிறுத்து', reason: 'ஏன் (மாற்றத்துடன் வைக்கப்படும்)', run: 'இப்போதே பயணங்களை இயக்கு', ranSay: 'பயணங்கள் இயக்கப்பட்டன — வரிசையில்:', heldBack: 'நிறுத்தப்பட்டவை',
    j_abandoned_cart: 'ஆர்டர் இல்லாமல் விடப்பட்ட கூடை', j_occasion: 'வாடிக்கையாளர் கொடுத்த பிறந்தநாள் அல்லது ஆண்டுவிழா', j_win_back: 'சில காலமாக வாங்காத வாடிக்கையாளர்',
    template: 'வார்ப்புரு', why_no_consent: 'ஒப்புக்கொள்ளவில்லை', why_withdrawn: 'ஒப்புதலைத் திரும்பப் பெற்றனர்', why_do_not_contact: 'ஒருபோதும் தொடர்பு கொள்ள வேண்டாம் என்று கேட்டனர்', why_frequency_cap: 'இந்த வாரம் ஏற்கனவே போதுமான செய்திகள் பெற்றனர்', why_template_not_approved: 'வார்த்தைகள் ஒப்புக்கொள்ளப்படவில்லை', why_promotion_in_transactional: 'சேவைச் செய்தியில் சலுகை இருக்கக்கூடாது',
    seg_new: 'புதியவர்', seg_regular: 'வழக்கமானவர்', seg_loyal: 'விசுவாசமானவர்', seg_lapsing: 'விலகிச் செல்பவர்', seg_lapsed: 'விலகியவர்',
    needTemplate: 'முதலில் ஒப்புக்கொண்ட வார்ப்புருவைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needWords: 'வார்ப்புருவுக்குப் பெயரும் வார்த்தைகளும் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needAudience: 'முதலில் யாரைச் சென்றடையலாம் என்று கண்டறியுங்கள். எதுவும் அனுப்பப்படவில்லை.', needPlan: 'முதலில் திட்டமிடுங்கள், யாரைச் சென்றடையும் என்று பார்க்க. எதுவும் அனுப்பப்படவில்லை.', needReason: 'முதலில் காரணத்தைச் சொல்லுங்கள். எதுவும் அனுப்பப்படவில்லை.', needCampaign: 'பிரச்சாரத்தின் பெயரைக் கொடுங்கள். எதுவும் படிக்கப்படவில்லை.', needValue: 'இந்த வார்த்தைகளில் {value} இடம் உள்ளது — முதலில் அதை நிரப்புங்கள். எதுவும் அனுப்பப்படவில்லை.', value: '{value} இடத்தில் வருவது',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு பிரச்சாரங்களைப் படிக்க முடியாது.', cannotSend: 'உங்கள் பங்கு பிரச்சாரங்களைத் திட்டமிடவோ அனுப்பவோ முடியாது.', cannotWords: 'உங்கள் பங்கு செய்தி வார்த்தைகளை வரையவோ ஒப்புக்கொள்ளவோ முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type CampaignsKey = keyof typeof CAMPAIGNS_COPY.en;
export const campaignsWords = (lang: Lang, key: CampaignsKey | string): string => (CAMPAIGNS_COPY[lang] as Record<string, string>)[key] ?? (CAMPAIGNS_COPY.en as Record<string, string>)[key] ?? key;
export const campaignsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => campaignsWords(lang, k), out);

/** The approved versions of each template, newest first — the only ones a campaign or journey may send with. */
export function approvedTemplates(all: readonly TemplateVersion[]): readonly TemplateVersion[] {
  const latest = new Map<string, TemplateVersion>();
  for (const v of all) latest.set(`${v.templateId}|${v.version}`, v);
  const best = new Map<string, TemplateVersion>();
  for (const v of latest.values()) if (v.state === 'approved' && (best.get(v.templateId)?.version ?? 0) < v.version) best.set(v.templateId, v);
  return [...best.values()].sort((a, b) => a.templateId.localeCompare(b.templateId));
}

export interface CampaignsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly send: boolean; readonly words: boolean; readonly templates: boolean; readonly audience: boolean };
  templates(): Promise<Outcome<{ readonly templates: readonly TemplateVersion[] }>>;
  draftWords(templateId: string, channel: string, body: string): Promise<Outcome<{ readonly template: TemplateVersion }>>;
  approveWords(templateId: string, version: number): Promise<Outcome<{ readonly template: TemplateVersion }>>;
  frequencyCap(): Promise<Outcome<{ readonly policy: { readonly capPerWindow: number; readonly windowDays: number } | null; readonly detail: string }>>;
  audience(segment: string, channel: string): Promise<Outcome<AudienceView>>;
  plan(input: { readonly campaignId: string; readonly template: TemplateVersion | undefined; readonly containsPromotion: boolean; readonly audience: readonly string[] | undefined }): Promise<Outcome<PlanView>>;
  send(input: { readonly campaignId: string; readonly template: TemplateVersion | undefined; readonly containsPromotion: boolean; readonly plan: PlanView | undefined; readonly value?: string }): Promise<Outcome<SendView>>;
  status(campaignId: string): Promise<Outcome<StatusView>>;
  journeys(): Promise<Outcome<{ readonly journeys: readonly JourneyView[] }>>;
  switchJourney(kind: string, on: boolean, template: TemplateVersion | undefined, reason: string): Promise<Outcome<unknown>>;
  runJourneys(): Promise<Outcome<{ readonly queued: number; readonly notQueued: number }>>;
  newCampaignId(): string;
}

export function createCampaignsSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): CampaignsSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = {
    named, read: named && perms.has('customer.campaign.read'), send: named && perms.has('customer.campaign.send'),
    words: named && perms.has('document.template.manage'), templates: named && perms.has('notification.send.check'), audience: named && perms.has('customer.segment.read'),
  };
  const call = makeCaller({ keyPrefix: 'campaigns', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const guard = (need: boolean, why: CampaignsKey): Outcome<never, CampaignsKey> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !need ? { result: 'invalid', why } : undefined);
  const enc = encodeURIComponent;
  return {
    may,
    newCampaignId: () => newId('cmp').replace(/_/g, '-'),
    templates: async () => guard(may.templates, 'cannotRead') ?? call('GET', '/v1/notifications/templates'),
    draftWords: async (templateId, channel, body) => {
      const g = guard(may.words, 'cannotWords'); if (g) return g;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(templateId.trim()) || body.trim() === '') return { result: 'invalid', why: 'needWords' };
      return call('POST', `/v1/notifications/templates/${enc(templateId.trim())}`, { purpose: 'marketing', channel, body: body.trim() });
    },
    approveWords: async (templateId, version) => guard(may.words, 'cannotWords') ?? call('POST', `/v1/notifications/templates/${enc(templateId)}/approval`, { version }),
    frequencyCap: async () => guard(may.read, 'cannotRead') ?? call('GET', '/v1/service/campaigns/frequency-policy'),
    audience: async (segment, channel) => guard(may.audience, 'cannotRead') ?? call('GET', `/v1/customer/segments/audience?segment=${enc(segment)}&purpose=marketing&channel=${enc(channel)}`),
    plan: async ({ campaignId, template, containsPromotion, audience }) => {
      const g = guard(may.send, 'cannotSend'); if (g) return g;
      if (template === undefined) return { result: 'invalid', why: 'needTemplate' };
      if (audience === undefined || audience.length === 0) return { result: 'invalid', why: 'needAudience' };
      return call('POST', `/v1/service/campaigns/${enc(campaignId)}/plan`, { purpose: 'marketing', channel: template.channel, templateId: template.templateId, templateApproved: true, containsPromotion, audience });
    },
    send: async ({ campaignId, template, containsPromotion, plan, value }) => {
      const g = guard(may.send, 'cannotSend'); if (g) return g;
      if (template === undefined) return { result: 'invalid', why: 'needTemplate' };
      if (plan === undefined || plan.campaignId !== campaignId || plan.sendTo.length === 0) return { result: 'invalid', why: 'needPlan' };
      // The words' {value} — the one blank a campaign template carries — is asked for when the words have it.
      const needsValue = /\{value\}/.test(template.body);
      if (needsValue && (value ?? '').trim() === '') return { result: 'invalid', why: 'needValue' };
      return call('POST', `/v1/service/campaigns/${enc(campaignId)}/send`, { purpose: 'marketing', channel: template.channel, templateId: template.templateId, containsPromotion, audience: plan.sendTo, ...(needsValue ? { values: { value: (value ?? '').trim() } } : {}) });
    },
    status: async (campaignId) => {
      const g = guard(may.read, 'cannotRead'); if (g) return g;
      return campaignId.trim() === '' ? { result: 'invalid', why: 'needCampaign' } : call('GET', `/v1/service/campaigns/${enc(campaignId.trim())}/status`);
    },
    journeys: async () => guard(may.read, 'cannotRead') ?? call('GET', '/v1/service/journeys'),
    switchJourney: async (kind, on, template, reason) => {
      const g = guard(may.send, 'cannotSend'); if (g) return g;
      if (on && template === undefined) return { result: 'invalid', why: 'needTemplate' };
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('PUT', `/v1/service/journeys/${enc(kind)}`, on ? { on: true, templateId: template!.templateId, channel: template!.channel, reason: reason.trim() } : { on: false, reason: reason.trim() });
    },
    runJourneys: async () => guard(may.send, 'cannotSend') ?? call('POST', '/v1/service/journeys/run', {}),
  };
}
