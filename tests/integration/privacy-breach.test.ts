import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// C2 / DPDP s.8(6) — the breach-notification workflow on the live API (API-06). A stateless assessment:
// given a personal-data breach it returns the Board (immediate + 72-hour) and affected-person obligations
// with their deadlines and the prescribed content still missing. It drafts and tracks; a person sends.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const assess = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/privacy/breach/assess', userId: u, tenantId: A, idempotencyKey: key, body });

interface Obligation { obligation: string; due: string; status: string; missingContent: string[] }
interface Plan { breachId: string; reportDeadline: string; obligations: Obligation[]; allSatisfied: boolean; advisoryOnly: boolean }
const plan = (res: { body: unknown }): Plan => res.body as Plan;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const breach = (over: Record<string, unknown> = {}) => ({
  breachId: 'BR-1', discoveredAt: '2026-08-10T09:00:00Z',
  affectedDataCategories: ['contact', 'loyalty'], affectedPrincipalCount: 40, ...over,
});

describe('breach-notification workflow on the live API (C2 / DPDP s.8(6))', () => {
  it('returns the Board and affected-person obligations with the 72-hour deadline and missing content', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const p = plan(await assess(h, 'u-owner', breach(), 'br-1'));
    expect(p.reportDeadline).toBe('2026-08-13T09:00:00.000Z'); // discovery + 72h, independent of "now"
    expect(p.obligations.map((o) => o.obligation)).toEqual([
      'board_immediate_intimation', 'board_72h_report', 'affected_principal_notices',
    ]);
    expect(p.advisoryOnly).toBe(true);
    expect(p.allSatisfied).toBe(false);
    expect(p.obligations.find((o) => o.obligation === 'board_72h_report')!.missingContent).toContain('remedialMeasures');
  });

  it('clears missing content as the prescribed fields are supplied', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const p = plan(await assess(h, 'u-owner', breach({
      description: 'd', likelyConsequences: 'c', mitigationMeasures: 'm', remedialMeasures: 'r',
      safetyMeasuresForPrincipals: 's', contactPoint: 'dpo@sre.example',
    }), 'br-2'));
    expect(p.obligations.find((o) => o.obligation === 'board_72h_report')!.missingContent).toEqual([]);
    expect(p.obligations.find((o) => o.obligation === 'affected_principal_notices')!.missingContent).toEqual([]);
  });

  it('is authorized (a privacy-governance act, not the till) and refuses malformed input', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds customer.consent.write
    await h.provisionRole(A, 'u-cash', 'cashier');       // read only — may not

    expect((await assess(h, 'u-mgr', breach(), 'br-mgr')).status).toBe(200);
    expect((await assess(h, 'u-cash', breach(), 'br-cash')).status).toBe(403);

    expect(codeOf(await assess(h, 'u-owner', breach({ breachId: '' }), 'br-bad1'))).toBe('not_readable_as_a_breach');
    expect(codeOf(await assess(h, 'u-owner', breach({ discoveredAt: 'nope' }), 'br-bad2'))).toBe('invalid_breach_input');
  });
});
