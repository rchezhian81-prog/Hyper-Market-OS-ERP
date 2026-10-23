import { describe, it, expect } from 'vitest';
import { createCampaignsSession, approvedTemplates, CAMPAIGNS_COPY, type TemplateVersion, type PlanView } from '../../apps/web-erp/src/campaigns-session';

// M21-FR-01 / M21-FR-02: the Campaigns page sends ONLY the plan's own reachable list (never the raw segment), only with an
// approved template, fills the {value} blank, switches a journey on only with an approved template and a reason, and refuses
// the cheap things before any request. Every word has a Tamil twin.

const tpl = (over: Partial<TemplateVersion> = {}): TemplateVersion => ({ templateId: 'diwali', version: 1, purpose: 'marketing', channel: 'sms', body: 'Offer {value} (synthetic)', state: 'approved', draftedBy: 'u-a', approvedBy: 'u-b', ...over });
const MANAGER = { userId: 'u-mgr', permissions: ['customer.campaign.read', 'customer.campaign.send', 'customer.segment.read', 'document.template.manage', 'notification.send.check'] };

describe('the Campaigns session (M21-FR-01 · M21-FR-02)', () => {
  it('plans with the audience, then sends only the plan\'s reachable list with the approved words and the {value}', async () => {
    const asked: { method: string; path: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (path: string, init?: { method?: string; body?: string }) => {
      asked.push({ method: init?.method ?? 'GET', path: String(path), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      return new Response(JSON.stringify({ campaignId: 'c-1', queued: 1 }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const s = createCampaignsSession({ viewer: MANAGER, fetch });
    await s.audience('loyal', 'sms');
    await s.plan({ campaignId: 'c-1', template: tpl(), containsPromotion: true, audience: ['a', 'b', 'c'] });
    const plan: PlanView = { campaignId: 'c-1', blocked: false, sendTo: ['a'], sendToCount: 1, excludedCount: 2, excludedByReason: { no_consent: 2 }, detail: '' };
    await s.send({ campaignId: 'c-1', template: tpl(), containsPromotion: true, plan, value: ' ₹50 off ' });
    await s.switchJourney('win_back', true, tpl(), ' owner said ');
    expect(asked.map((a) => `${a.method} ${a.path}`)).toEqual([
      'GET /v1/customer/segments/audience?segment=loyal&purpose=marketing&channel=sms',
      'POST /v1/service/campaigns/c-1/plan',
      'POST /v1/service/campaigns/c-1/send',
      'PUT /v1/service/journeys/win_back',
    ]);
    expect(asked[1]!.body).toEqual({ purpose: 'marketing', channel: 'sms', templateId: 'diwali', templateApproved: true, containsPromotion: true, audience: ['a', 'b', 'c'] });
    expect(asked[2]!.body).toEqual({ purpose: 'marketing', channel: 'sms', templateId: 'diwali', containsPromotion: true, audience: ['a'], values: { value: '₹50 off' } });
    expect(asked[3]!.body).toEqual({ on: true, templateId: 'diwali', channel: 'sms', reason: 'owner said' });
  });

  it('refuses before any request: no template, no audience, no plan (or another campaign\'s), no {value}, no reason, no permission', async () => {
    let calls = 0;
    const fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const s = createCampaignsSession({ viewer: MANAGER, fetch });
    const plan: PlanView = { campaignId: 'c-1', blocked: false, sendTo: ['a'], sendToCount: 1, excludedCount: 0, excludedByReason: {}, detail: '' };
    expect(await s.plan({ campaignId: 'c-1', template: undefined, containsPromotion: true, audience: ['a'] })).toEqual({ result: 'invalid', why: 'needTemplate' });
    expect(await s.plan({ campaignId: 'c-1', template: tpl(), containsPromotion: true, audience: [] })).toEqual({ result: 'invalid', why: 'needAudience' });
    expect(await s.send({ campaignId: 'c-1', template: tpl(), containsPromotion: true, plan: undefined })).toEqual({ result: 'invalid', why: 'needPlan' });
    expect(await s.send({ campaignId: 'c-2', template: tpl(), containsPromotion: true, plan })).toEqual({ result: 'invalid', why: 'needPlan' });
    expect(await s.send({ campaignId: 'c-1', template: tpl(), containsPromotion: true, plan, value: ' ' })).toEqual({ result: 'invalid', why: 'needValue' });
    expect(await s.switchJourney('occasion', true, undefined, 'x')).toEqual({ result: 'invalid', why: 'needTemplate' });
    expect(await s.switchJourney('occasion', false, undefined, ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.draftWords('bad id!', 'sms', 'x')).toEqual({ result: 'invalid', why: 'needWords' });
    expect(await s.status(' ')).toEqual({ result: 'invalid', why: 'needCampaign' });
    const cashier = createCampaignsSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch });
    expect(await cashier.journeys()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await cashier.send({ campaignId: 'c-1', template: tpl(), containsPromotion: true, plan })).toEqual({ result: 'invalid', why: 'cannotSend' });
    expect(await cashier.draftWords('x', 'sms', 'y')).toEqual({ result: 'invalid', why: 'cannotWords' });
    expect(await createCampaignsSession({ viewer: undefined, fetch }).templates()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(calls).toBe(0);
  });

  it('only the newest approved version of each template can be chosen; drafts and withdrawn ones cannot', () => {
    const all = [tpl({ templateId: 'a', version: 1 }), tpl({ templateId: 'a', version: 2, state: 'draft' }), tpl({ templateId: 'b', version: 1, state: 'draft' }), tpl({ templateId: 'c', version: 1 }), tpl({ templateId: 'c', version: 1, state: 'withdrawn' })];
    expect(approvedTemplates(all).map((v) => `${v.templateId}v${v.version}`)).toEqual(['av1']);
  });

  it('every English word has a Tamil twin', () => {
    expect(Object.keys(CAMPAIGNS_COPY.ta).sort()).toEqual(Object.keys(CAMPAIGNS_COPY.en).sort());
  });
});
