import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { saasRolloutSweep } from '../../services/api/src/saas-rollout-adapters';
import { CONSENT_RECORD_FORMAT } from '../../packages/customer/src/consent-manager-format';

// C8 · C9 · OB-324 (owner, 23 Oct 2026, in writing): build both. C8 — the consent record exported and imported in the
// consent-manager shape of the DPDP Rules (Rule 4, First Schedule); withdrawals apply at once, a stale grant is a visible
// exception, never applied. C9 — a customer-data volume watch with a threshold the CA sets: "not set" until entered,
// never fires while unset, alerts every owner once when reached. Through the real API, in memory and — with
// DATABASE_URL — on real PostgreSQL, with cold restarts. Synthetic data only.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

describe.each(backings)('consent-manager records and the customer-data volume watch — on $name', ({ harness }) => {
  it('C8: export (whole shop and one customer), import judged against the ledger, exceptions kept; who may do what', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Record<string, unknown>> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body as Record<string, unknown>; };

    // The shop's own consent facts, through the ordinary consent route.
    await ok(call('POST', '/v1/customers/C-1/consent', 'u-mgr', { purpose: 'marketing', channel: 'sms', given: true, evidence: 'signed form at the service desk' }), 'c1 give');
    await ok(call('POST', '/v1/customers/C-1/consent', 'u-mgr', { purpose: 'marketing', channel: 'sms', given: false, evidence: 'asked at the till to stop messages' }), 'c1 withdraw');
    await ok(call('POST', '/v1/customers/C-2/consent', 'u-mgr', { purpose: 'profiling', channel: 'email', given: false, evidence: 'said no at sign-up' }), 'c2 deny');

    expect((await call('GET', '/v1/privacy/consent-manager/export', 'u-mgr')).status).toBe(403); // the owner exports
    const doc = await ok(call('GET', '/v1/privacy/consent-manager/export', 'u-owner'), 'export') as { format: string; records: { dataPrincipalRef: string; action: string; artefactId: string }[]; counts: Record<string, number>; dataFiduciary: { name: string }; keepForAtLeastYears: number };
    expect([doc.format, doc.dataFiduciary.name, doc.keepForAtLeastYears]).toEqual([CONSENT_RECORD_FORMAT, 'not set', 7]);
    expect(doc.records.map((r) => [r.dataPrincipalRef, r.action])).toEqual([['C-1', 'given'], ['C-1', 'withdrawn'], ['C-2', 'denied']]);
    expect(doc.counts).toEqual({ records: 3, dataPrincipals: 2, given: 1, denied: 1, withdrawn: 1 });
    const one = await ok(call('GET', '/v1/privacy/consent-manager/export', 'u-owner', undefined, { dataPrincipalRef: 'C-2' }), 'one') as { records: unknown[]; scope: unknown };
    expect([one.records.length, one.scope]).toEqual([1, { dataPrincipalRef: 'C-2' }]);

    // An import from a consent manager: refused whole when unreadable or for another shop.
    const base = { format: CONSENT_RECORD_FORMAT, consentManager: { id: 'CM-REG-0042', name: 'Synthetic Consent Manager' }, dataFiduciary: { tenantId: T, name: 'SRE' } };
    expect((await call('POST', '/v1/privacy/consent-manager/import', 'u-mgr', { ...base, records: [] })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/privacy/consent-manager/import', 'u-owner', { ...base, dataFiduciary: { tenantId: 'someone-else', name: 'x' }, records: [] }))).toBe('wrong_shop');
    expect(codeOf(await call('POST', '/v1/privacy/consent-manager/import', 'u-owner', { ...base, records: [{ artefactId: 'A0', dataPrincipalRef: 'C-1', purpose: 'marketing', channel: 'pigeon', action: 'given', at: ago(1) }] }))).toBe('bad_record');
    const records = [
      // C-3 newly consents through the manager → applied.
      { artefactId: 'ART-1', dataPrincipalRef: 'C-3', purpose: 'marketing', channel: 'email', action: 'given', at: ago(30), noticeReference: 'NOTICE-V2' },
      // C-2 withdraws email marketing → applied at once.
      { artefactId: 'ART-2', dataPrincipalRef: 'C-2', purpose: 'marketing', channel: 'email', action: 'withdrawn', at: ago(20) },
      // C-1 "gave" sms marketing an hour ago — but the shop holds a LATER withdrawal → an exception, not applied.
      { artefactId: 'ART-3', dataPrincipalRef: 'C-1', purpose: 'marketing', channel: 'sms', action: 'given', at: ago(24 * 60) },
    ];
    const imp = await ok(call('POST', '/v1/privacy/consent-manager/import', 'u-owner', { ...base, records }), 'import') as { applied: number; withdrawalsApplied: number; exceptions: { artefactId: string; detail: string }[] };
    expect([imp.applied, imp.withdrawalsApplied, imp.exceptions.map((e) => e.artefactId)]).toEqual([2, 1, ['ART-3']]);
    expect(imp.exceptions[0]!.detail).toContain('later withdrawal');
    // The same document again is the same facts — nothing doubled.
    const again = await ok(call('POST', '/v1/privacy/consent-manager/import', 'u-owner', { ...base, records }), 'again') as { applied: number; alreadyImported: number };
    expect([again.applied, again.alreadyImported]).toEqual([0, 2]);

    h = harness(h); // ── COLD RESTART ──
    // The ledger decides as the import left it: C-3 may be emailed; C-1 still may not be texted.
    expect(((await ok(call('GET', '/v1/customers/C-3/may-we-send', 'u-mgr', undefined, { purpose: 'marketing', channel: 'email' }), 'c3')) as { verdict: string }).verdict).toBe('may_send');
    expect(((await ok(call('GET', '/v1/customers/C-1/may-we-send', 'u-mgr', undefined, { purpose: 'marketing', channel: 'sms' }), 'c1')) as { verdict: string }).verdict).toBe('must_not_send');
    const ex = await ok(call('GET', '/v1/privacy/consent-manager/exceptions', 'u-mgr'), 'exceptions') as { count: number; exceptions: { artefactId: string; consentManagerId: string }[] };
    expect([ex.count, ex.exceptions[0]!.consentManagerId]).toEqual([1, 'CM-REG-0042']);
    expect((await call('GET', '/v1/privacy/consent-manager/exceptions', 'u-cash')).status).toBe(403);
    // The export now shows where each fact came from.
    const after = await ok(call('GET', '/v1/privacy/consent-manager/export', 'u-owner', undefined, { dataPrincipalRef: 'C-3' }), 'c3 export') as { records: { artefactId: string; capturedVia: string; noticeReference: string | null }[] };
    expect(after.records).toEqual([expect.objectContaining({ artefactId: 'ART-1', capturedVia: 'consent manager CM-REG-0042', noticeReference: 'NOTICE-V2' })]);
  }, 120_000);

  it('C9: "not set" and silent until the CA sets it; the CA alone sets it; reaching it alerts every owner once; below clears', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-owner-2', 'owner');
    await h.provisionRole(T, 'u-ca', 'chartered_accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Record<string, unknown>> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body as Record<string, unknown>; };
    const member = async (ref: string, status: 'member' | 'left') => {
      await h.store.append(T, streamName(STREAM.loyalty, 'members'), makeEvent({
        id: `loyalty-member-${ref}-${status}`, type: 'LoyaltyMember', occurredAt: new Date().toISOString(), idempotencyKey: `loyalty-member-${T}-${ref}-${status}`, source: 'test/seed',
        payload: { memberRef: ref, mobileLast4: '0000', status, consentGivenAt: ago(60), enrolledBy: 'u-cash', verifiedHow: 'seen_on_phone' },
      }));
    };
    for (const m of ['M-1', 'M-2', 'M-3']) await member(m, 'member');
    const sweep = saasRolloutSweep({ store: h.store, now: () => new Date().toISOString(), plans: [] });
    const volumeAlerts = async (): Promise<{ alertId: string; state: string; alsoToUserIds?: string[] }[]> =>
      ((await ok(call('GET', '/v1/platform/alerts', 'u-owner'), 'alerts')) as { alerts: { alert: { alertId: string; alsoToUserIds?: string[] }; state: string }[] }).alerts
        .filter((a) => a.alert.alertId.startsWith('dpdp-volume:')).map((a) => ({ alertId: a.alert.alertId, state: a.state, ...(a.alert.alsoToUserIds === undefined ? {} : { alsoToUserIds: a.alert.alsoToUserIds }) }));

    // Not set: shown as such, and the watch never fires.
    const unset = await ok(call('GET', '/v1/privacy/data-volume-watch', 'u-owner'), 'watch') as { threshold: unknown; crossed: unknown; volume: { principals: number } };
    expect([unset.threshold, unset.crossed, unset.volume.principals]).toEqual([{ set: false, words: 'not set' }, null, 3]);
    await sweep(T, new Date().toISOString());
    expect(await ok(call('POST', '/v1/privacy/data-volume-watch/check', 'u-owner', {}), 'check')).toMatchObject({ raised: false, crossed: null });
    expect(await volumeAlerts()).toEqual([]);

    // Only the CA sets it, with its basis.
    expect((await call('PUT', '/v1/privacy/data-volume-watch/threshold', 'u-owner', { principals: 4, basis: 'owner guess' })).status).toBe(403);
    expect((await call('GET', '/v1/privacy/data-volume-watch', 'u-cash')).status).toBe(403);
    expect(codeOf(await call('PUT', '/v1/privacy/data-volume-watch/threshold', 'u-ca', { principals: 0, basis: 'none' }))).toBe('not_readable_as_a_threshold');
    expect(codeOf(await call('PUT', '/v1/privacy/data-volume-watch/threshold', 'u-ca', { principals: 4 }))).toBe('not_readable_as_a_threshold');
    await ok(call('PUT', '/v1/privacy/data-volume-watch/threshold', 'u-ca', { principals: 4, basis: 'synthetic: lawyer letter of 20 Oct' }), 'set');
    await sweep(T, new Date().toISOString());
    expect(await volumeAlerts()).toEqual([]); // 3 < 4

    h = harness(h); // ── COLD RESTART ──
    await member('M-4', 'member');
    const s2 = saasRolloutSweep({ store: h.store, now: () => new Date().toISOString(), plans: [] });
    await s2(T, new Date().toISOString());
    await s2(T, new Date().toISOString()); // once — not twice
    expect(await volumeAlerts()).toEqual([{ alertId: 'dpdp-volume:v1', state: 'open', alsoToUserIds: ['u-owner-2'] }]);
    const crossed = await ok(call('GET', '/v1/privacy/data-volume-watch', 'u-ca'), 'watch') as { crossed: boolean; detail: string };
    expect(crossed.crossed).toBe(true);
    expect(crossed.detail).toContain('Significant Data Fiduciary');
    // A member leaves: below again → the alert is cleared (kept, never deleted).
    await member('M-4', 'left');
    await s2(T, new Date().toISOString());
    expect(await volumeAlerts()).toEqual([{ alertId: 'dpdp-volume:v1', state: 'cleared', alsoToUserIds: ['u-owner-2'] }]);
  }, 120_000);
});
