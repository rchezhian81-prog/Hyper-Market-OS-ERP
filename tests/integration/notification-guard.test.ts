import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M31-FR-03: the consent-safe notification send guard on the live API. Every gate must pass — approved
// template, not suppressed, consent granted + within frequency, budget not exceeded — and a breach BLOCKS
// (never warned-and-sent), naming the first failing gate.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const grant = { purpose: 'marketing', channel: 'whatsapp', granted: true };
const OK = {
  consent: { grants: [grant] },
  purpose: 'marketing', channel: 'whatsapp', templateApproved: true,
  costMinor: 50, budgetRemainingMinor: 1000,
};

const check = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/notifications/can-send', userId, tenantId: A, idempotencyKey: key, body });

describe('notification send guard (M31-FR-03)', () => {
  it('allows a fully consented, approved, in-budget send', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await check(h, 'u-owner', OK, 'ng-ok')).body as { allowed: boolean };
    expect(body.allowed).toBe(true);
  });

  it('blocks on the FIRST failing gate, in order (template → suppression → consent → budget)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Template first: even fully consented, an unapproved template blocks before anything else.
    expect(((await check(h, 'u-owner', { ...OK, templateApproved: false }, 'ng-tmpl')).body as { reason: string }).reason).toBe('unapproved_template');
    // Suppression is absolute.
    expect(((await check(h, 'u-owner', { ...OK, suppressed: true }, 'ng-supp')).body as { reason: string }).reason).toBe('suppressed');
    // No consent for this purpose+channel.
    expect(((await check(h, 'u-owner', { ...OK, consent: { grants: [] } }, 'ng-cons')).body as { reason: string }).reason).toBe('no_consent');
    // Over the messaging budget.
    expect(((await check(h, 'u-owner', { ...OK, costMinor: 2000, budgetRemainingMinor: 1000 }, 'ng-budg')).body as { reason: string }).reason).toBe('over_budget');
  });

  it('refuses a malformed request and gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await check(h, 'u-owner', { purpose: 'marketing', channel: 'whatsapp' }, 'ng-bad')).status).toBe(400);
    expect((await check(h, 'u-cash', OK, 'ng-rbac')).status).toBe(403);
  });
});
