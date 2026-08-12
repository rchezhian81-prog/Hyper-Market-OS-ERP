import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// C1 / DPDP s.5–6 — consent-notice completeness check on the live API (API-06). A pure design-time
// validation: is the notice itemised (category + purpose) and does it carry the withdraw / grievance /
// Board links, with withdrawal as easy as giving? It commits nothing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const check = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/privacy/consent-notice/check', userId: u, tenantId: A, idempotencyKey: key, body });

interface Result { compliant: boolean; defects: { defect: string; detail: string }[]; itemCount: number }
const result = (res: { body: unknown }): Result => res.body as Result;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const complete = {
  items: [{ dataCategory: 'contact', purpose: 'order updates' }],
  withdrawMethod: 'one tap in the app', grievanceContact: 'dpo@sre.example',
  boardComplaintLink: 'https://dpb.gov.in/complaint', giveSteps: 2, withdrawSteps: 1,
};

describe('consent-notice check on the live API (C1 / DPDP s.5–6)', () => {
  it('passes a complete notice and names the gaps in an incomplete one', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect(result(await check(h, 'u-owner', complete, 'cn-ok')).compliant).toBe(true);

    const bad = result(await check(h, 'u-owner', { items: [{ dataCategory: 'location', purpose: '' }], withdrawMethod: 'ok' }, 'cn-bad'));
    expect(bad.compliant).toBe(false);
    expect(bad.defects.map((d) => d.defect)).toEqual(
      expect.arrayContaining(['purpose_missing', 'no_grievance_contact', 'no_board_complaint_link']),
    );
  });

  it('is authorized and refuses a malformed body', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // holds customer.consent.read

    expect((await check(h, 'u-cash', complete, 'cn-cash')).status).toBe(200); // the counter may check a notice
    expect(codeOf(await check(h, 'u-owner', { items: 'not-a-list' }, 'cn-malformed'))).toBe('not_readable_as_a_consent_notice');
  });
});
