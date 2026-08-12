import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// C4 / DPDP Act 2023 s.9 — children's data, end to end through the real API (API-06). A stateless decision:
// given an activity and the person's age (or date of birth) it says whether processing is permitted, needs
// verifiable parental consent, is prohibited outright (tracking / targeted ads at a child), or cannot be
// judged because the age is unproven. It commits nothing and stores no child's data — the rule is the pure
// `assessChildDataProcessing` guard; this proves it is reachable and authorized.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const check = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/customers/child-data/check', userId: u, tenantId: A, idempotencyKey: key, body });

interface Decision { allowed: boolean; verdict: string; isChild: boolean | 'unknown'; detail: string }
const decision = (res: { body: unknown }): Decision => res.body as Decision;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('child-data guard: DPDP s.9 processing decision, authorized (C4)', () => {
  it('permits an adult, needs parental consent for a child, and refuses when the age is unproven', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const adult = decision(await check(h, 'u-owner', { activity: 'marketing', ageYears: 40 }, 'cd-adult'));
    expect(adult.allowed).toBe(true);
    expect(adult.verdict).toBe('permitted');

    const child = decision(await check(h, 'u-owner', { activity: 'marketing', dateOfBirth: '2012-01-01' }, 'cd-child'));
    expect(child.allowed).toBe(false);
    expect(child.verdict).toBe('needs_parental_consent');
    expect(child.isChild).toBe(true);

    const withConsent = decision(await check(h, 'u-owner', { activity: 'account_enrolment', ageYears: 15, parentalConsentVerified: true }, 'cd-consent'));
    expect(withConsent.allowed).toBe(true);

    const unproven = decision(await check(h, 'u-owner', { activity: 'profiling' }, 'cd-unproven'));
    expect(unproven.allowed).toBe(false);
    expect(unproven.verdict).toBe('age_unverified');
  });

  it('prohibits tracking / targeted advertising of a child even with parental consent (s.9(3))', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const tracked = decision(await check(h, 'u-owner', { activity: 'behavioural_tracking', ageYears: 14, parentalConsentVerified: true }, 'cd-track'));
    expect(tracked.allowed).toBe(false);
    expect(tracked.verdict).toBe('prohibited_for_child');

    // A transactional message still reaches a child — it is not a child-restricted activity.
    const tx = decision(await check(h, 'u-owner', { activity: 'transactional', ageYears: 8 }, 'cd-tx'));
    expect(tx.allowed).toBe(true);
  });

  it('is authorized and refuses malformed input', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');       // enrolls at the counter — may check
    await h.provisionRole(A, 'u-acct', 'accountant');    // no customer.consent.read — may not

    expect((await check(h, 'u-cash', { activity: 'marketing', ageYears: 20 }, 'cd-cash')).status).toBe(200);
    expect((await check(h, 'u-acct', { activity: 'marketing', ageYears: 20 }, 'cd-acct')).status).toBe(403);

    expect(codeOf(await check(h, 'u-owner', { activity: 'not_a_thing', ageYears: 20 }, 'cd-bad'))).toBe('not_readable_as_a_child_data_check');
  });
});
