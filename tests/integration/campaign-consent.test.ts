import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The campaign send-gate, end to end (M21-FR-01 · PRV/DPDP · P-02 · P-08, API-06). A campaign is the one
// click that can do harm at thousands of people at once, so the gate is at the SEND, PER RECIPIENT, and it
// consults the shop's OWN consent ledger (the same record the rest of the system holds — not a list pasted
// into the request). Consent to one channel is not consent to another; a marketing send needs marketing
// consent; a transactional message rides the contract but may not smuggle a promotion; and the excluded
// count is always reported so the check stays defensible when reach shrinks. Gated customer.campaign.send/.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const consent = (h: ApiHarness, u: string, customerId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/customers/${customerId}/consent`, userId: u, tenantId: A, idempotencyKey: key, body });
const plan = (h: ApiHarness, u: string, campaignId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/service/campaigns/${campaignId}/plan`, userId: u, tenantId: A, idempotencyKey: key, body });
const listPlans = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/service/campaigns/plans', userId: u, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const marketingEmail = (over: Record<string, unknown> = {}) =>
  ({ purpose: 'marketing', channel: 'email', templateId: 't-newsletter', templateApproved: true, containsPromotion: true, ...over });

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // campaign.send/.read + consent.write
  await h.provisionRole(A, 'u-cash', 'cashier');       // none of these
  // The shop's own consent ledger, seeded through the live API:
  await consent(h, 'u-mgr', 'c-yes', { purpose: 'marketing', channel: 'email', given: true, evidence: 'sign-up form on the web' }, 'k-yes');
  await consent(h, 'u-mgr', 'c-no', { purpose: 'marketing', channel: 'email', given: false, evidence: 'unsubscribed via the link' }, 'k-no');
  await consent(h, 'u-mgr', 'c-sms', { purpose: 'marketing', channel: 'sms', given: true, evidence: 'consented for SMS at the till' }, 'k-sms');
  // c-none has no consent record at all.
  return h;
}

describe('campaign send-gate: consent per recipient, from the real ledger (M21-FR-01)', () => {
  it('sends only to the consented, and reports who was excluded and why', async () => {
    const h = await seeded();
    const audience = ['c-yes', 'c-no', 'c-sms', 'c-none'];
    const res = await plan(h, 'u-mgr', 'camp-1', marketingEmail({ audience }), 'p1');
    expect(res.status).toBe(200);
    // Only c-yes has marketing+email consent. c-no withdrew; c-sms consented on a DIFFERENT channel
    // (consent to SMS is not consent to email); c-none has nothing on record — silence is not agreement.
    expect(res.body).toMatchObject({
      blocked: false,
      sendTo: ['c-yes'],
      sendToCount: 1,
      excludedCount: 3,
      excludedByReason: { withdrawn: 1, no_consent: 2 },
      plannedBy: 'u-mgr',
    });
  });

  it('blocks the whole campaign when the template is not approved — no partial send', async () => {
    const h = await seeded();
    const res = await plan(h, 'u-mgr', 'camp-2', marketingEmail({ templateApproved: false, audience: ['c-yes', 'c-no'] }), 'p2');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ blocked: true, sendTo: [], excludedCount: 2, excludedByReason: { template_not_approved: 2 } });
  });

  it('lets a transactional message ride the contract, but refuses a promotion smuggled into it', async () => {
    const h = await seeded();
    // Transactional: no marketing consent needed — reaches even c-none.
    const ok = await plan(h, 'u-mgr', 'camp-3', { purpose: 'transactional', channel: 'email', templateId: 't-dispatch', templateApproved: true, containsPromotion: false, audience: ['c-none', 'c-yes'] }, 'p3');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ blocked: false, excludedCount: 0 });
    expect((ok.body as { sendTo: string[] }).sendTo.sort()).toEqual(['c-none', 'c-yes']);

    // A transactional message carrying a promotion is a route around consent — refused for everyone.
    const bad = await plan(h, 'u-mgr', 'camp-4', { purpose: 'transactional', channel: 'email', templateId: 't-dispatch', templateApproved: true, containsPromotion: true, audience: ['c-none', 'c-yes'] }, 'p4');
    expect(bad.body).toMatchObject({ blocked: true, sendTo: [], excludedByReason: { promotion_in_transactional: 2 } });
  });

  it('is gated, validates the request, records the decision (counts only), and survives a restart', async () => {
    const h = await seeded();
    // Gating: a cashier can neither run a campaign nor read the log.
    expect((await plan(h, 'u-cash', 'camp-x', marketingEmail({ audience: ['c-yes'] }), 'px')).status).toBe(403);
    expect((await listPlans(h, 'u-cash')).status).toBe(403);
    // Validation: an empty audience / missing fields is a 400, nothing recorded.
    expect(codeOf(await plan(h, 'u-mgr', 'camp-y', marketingEmail({ audience: [] }), 'py'))).toBe('not_readable_as_a_campaign');

    await plan(h, 'u-mgr', 'camp-log', marketingEmail({ audience: ['c-yes', 'c-no', 'c-none'] }), 'plog');
    const listed = (await listPlans(h, 'u-owner')).body as { plans: Record<string, unknown>[]; count: number };
    const row = listed.plans.find((p) => p['campaignId'] === 'camp-log');
    expect(row).toMatchObject({ sendToCount: 1, excludedCount: 2, blocked: false, plannedBy: 'u-mgr' });
    // PRV: the audit log keeps counts, not the recipient lists.
    expect(row).not.toHaveProperty('sendTo');
    expect(row).not.toHaveProperty('audience');

    // The decision log is durable — a fresh process over the same store still has it.
    const restarted = apiHarness({ store: h.store });
    const after = (await listPlans(restarted, 'u-owner')).body as { plans: { campaignId: string }[] };
    expect(after.plans.some((p) => p.campaignId === 'camp-log')).toBe(true);
  });
});
