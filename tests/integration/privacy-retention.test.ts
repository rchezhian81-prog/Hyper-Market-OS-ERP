import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// C3 / DPDP s.8(7) — the automated retention clock on the live API (API-06). Given the categories held for a
// person, it decides which to erase (after a pre-erasure notice), which to minimise, and which the law keeps
// in full. A stateless assessment (asOf = the server clock); it commits nothing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECENT = new Date(Date.now() - 3 * 86_400_000).toISOString(); // 3 days ago → inside a 30-day notice window

const sweep = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/privacy/retention/sweep', userId: u, tenantId: A, idempotencyKey: key, body });

interface Category { category: string; action: string; erasureScheduledFor?: string }
interface Sweep { categories: Category[]; eraseNowCount: number; noticeDueCount: number; minimiseCount: number; preErasureNotice?: string[] }
const result = (res: { body: unknown }): Sweep => res.body as Sweep;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const actionOf = (s: Sweep, category: string) => s.categories.find((c) => c.category === category)!.action;

const held = {
  noticeLeadDays: 30,
  categories: [
    { category: 'Marketing preferences', recordCount: 1, purposeServedAt: '2020-01-01T00:00:00Z' },       // erase (long past)
    { category: 'Sales invoices', recordCount: 3, purposeServedAt: '2020-01-01T00:00:00Z', retentionBasis: 'tax_invoice', retainUntil: '2034-03-31', minimisable: true }, // minimise
    { category: 'Audit trail', recordCount: 96, consentWithdrawnAt: '2020-01-01T00:00:00Z', retentionBasis: 'audit_evidence' }, // retain in full
    { category: 'App activity', recordCount: 400 },                                                       // retain (no trigger)
    { category: 'Recent opt-out', recordCount: 1, consentWithdrawnAt: RECENT },                           // notice window
  ],
};

describe('retention clock on the live API (C3 / DPDP s.8(7))', () => {
  it('classifies each category into erase / notice / minimise / retain and issues a pre-erasure notice', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const s = result(await sweep(h, 'u-owner', held, 'rt-1'));
    expect(actionOf(s, 'Marketing preferences')).toBe('erase');
    expect(actionOf(s, 'Sales invoices')).toBe('minimise');       // kept for tax, identity stripped
    expect(actionOf(s, 'Audit trail')).toBe('retain_by_law');     // never erased (hard rule #6)
    expect(actionOf(s, 'App activity')).toBe('retain');           // purpose still live
    expect(actionOf(s, 'Recent opt-out')).toBe('notice');

    expect(s.eraseNowCount).toBe(1);
    expect(s.minimiseCount).toBe(1);
    expect(s.noticeDueCount).toBe(1);
    expect(s.preErasureNotice).toBeDefined();
    expect(s.preErasureNotice!.join(' ')).toContain('Recent opt-out');
  });

  it('is authorized (a privacy-governance act, not the till) and refuses malformed input', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds customer.consent.write
    await h.provisionRole(A, 'u-cash', 'cashier');       // read only — may not

    expect((await sweep(h, 'u-mgr', held, 'rt-mgr')).status).toBe(200);
    expect((await sweep(h, 'u-cash', held, 'rt-cash')).status).toBe(403);

    expect(codeOf(await sweep(h, 'u-owner', { categories: 'not-a-list' }, 'rt-bad1'))).toBe('not_readable_as_retention_categories');
    expect(codeOf(await sweep(h, 'u-owner', { categories: [{ recordCount: 1 }] }, 'rt-bad2'))).toBe('not_readable_as_a_retention_category');
  });
});
