import { describe, it, expect } from 'vitest';
import { runOwnerSetup, type SetupClient, type SetupRequest } from '../../packages/migration/src/owner-steps-command';
import { pinVerifier, credentialsFileOf } from '../../scripts/lib/owner-setup-pins';
import { buildPersonToken, STORE_PC_PIN_AMR } from '../../scripts/lib/operator-env';
import { issueTillCredential, tillPinKey } from '../../packages/identity/src/till-pin';
import { verifyToken } from '../../services/identity/src/token';
import { evaluateStepUp } from '../../services/kernel/src/step-up';
import { TEST_IDP } from '../support/api-harness';

/**
 * OB-257 — the owner setup commands decide before they call: production and the demo tenant refused; every missing value
 * named, nothing defaulted; the plan said and a YES asked; each person's OWN PIN asked and checked on this PC — a wrong
 * PIN, no PIN, or a PIN never issued, and NOTHING is called; one person never both asks and approves. The PIN check is the
 * till's own (the latest credential wins, a revoked one opens nothing), and the person's token carries the step-up the
 * API reads — minted only for a person whose PIN matched.
 */

const KEY = ['owner', 'setup', 'pin', 'key'].join('-').padEnd(64, '0');
const T = 'ab000000-0000-4000-8000-000000000257';
const SHOP = { as: 'u-owner', company: 'SRE', 'legal-name': 'SRE Hyper Market Private Limited', gstin: '33AABCS1429B1Z1', store: 'SRE-MAIN', 'store-name': 'SRE Hyper Market' };

function world(over: { pins?: Record<string, string>; yes?: boolean; typed?: Record<string, string | undefined> } = {}) {
  const calls: SetupRequest[] = [];
  const client: SetupClient = { request: async (r) => { calls.push(r); return { status: r.path.endsWith('/approve') ? 201 : r.path === '/v1/identity/grants' ? 202 : 201, body: {} }; } };
  const pins = over.pins ?? { 'u-owner': '135790', 'u-manager': '246801' };
  const deps = {
    client,
    confirm: async () => over.yes ?? true,
    askPin: async (u: string) => (over.typed !== undefined ? over.typed[u] : pins[u]),
    verifyPin: (u: string, p: string) => (pins[u] === undefined ? 'no_pin_issued' as const : pins[u] === p ? 'ok' as const : 'wrong' as const),
  };
  const run = (step: string, values: Record<string, string>, extra: { targetKind?: string; tenantId?: string } = {}) => runOwnerSetup({
    step, tenantId: extra.tenantId ?? T, targetKind: extra.targetKind ?? 'rehearsal', demoTenantIds: ['pilot-demo'], values, today: '2026-10-20', now: () => '2026-10-20T10:00:00.000Z',
  }, deps);
  return { calls, run };
}

describe('the owner setup commands refuse before they call (OB-257)', () => {
  it('production and the demo tenant are refused first; a missing value is named and nothing defaulted', async () => {
    const w = world();
    expect((await w.run('shop', SHOP, { targetKind: 'production' })).lines.join('\n')).toMatch(/REFUSED \(production_target\)/);
    expect((await w.run('shop', SHOP, { tenantId: 'pilot-demo' })).lines.join('\n')).toMatch(/REFUSED \(demo_tenant\)/);
    const missing = await w.run('store-settings', { as: 'u-owner', store: 'SRE-MAIN', cutoff: '25:00' });
    expect(missing.exitCode).toBe(2);
    const said = missing.lines.join('\n');
    for (const f of ['--cutoff must be', '--stale-after-minutes', '--count-approval-rupees', '--handover-tolerance-rupees', '--cash-variance-rupees']) expect(said).toContain(f);
    expect(said).toMatch(/Nothing is filled in for you/);
    expect((await w.run('teleport', {})).exitCode).toBe(2);
    expect(w.calls).toEqual([]);
  });

  it('says the plan and asks for a YES; no YES, nothing done', async () => {
    const w = world({ yes: false });
    const out = await w.run('shop', SHOP);
    expect(out.lines[0]).toBe(`This will, at head office on this computer (tenant ${T}):`);
    expect(out.lines.join('\n')).toContain('Record the GST registration 33AABCS1429B1Z1 for "SRE Hyper Market Private Limited"');
    expect(out.lines.at(-1)).toBe('NOT DONE — you did not type YES. Nothing was done.');
    expect(out.exitCode).toBe(1);
    expect(w.calls).toEqual([]);
  });

  it('each person types their own PIN: a wrong one, none, or one never issued, and nothing is called — for EITHER person', async () => {
    const grant = { as: 'u-manager', approver: 'u-owner', person: 'u-cashier', role: 'cashier', store: 'SRE-MAIN', reason: 'pilot cashier' };
    const wrongSecond = world({ typed: { 'u-manager': '246801', 'u-owner': '000000' } });
    const out = await wrongSecond.run('grant', grant);
    expect(out.lines.join('\n')).toContain("REFUSED — that is not u-owner's till PIN. Nothing was done.");
    expect(wrongSecond.calls).toEqual([]); // the manager's half was never sent either
    const none = world({ typed: { 'u-manager': undefined } });
    expect((await none.run('grant', grant)).lines.at(-1)).toBe('NOT DONE — no PIN was typed for u-manager. Nothing was done.');
    const never = world({ pins: { 'u-owner': '135790' }, typed: { 'u-manager': '246801', 'u-owner': '135790' } });
    expect((await never.run('grant', grant)).lines.at(-1)).toMatch(/^REFUSED — u-manager has no till PIN on this computer\. Make one first, with u-manager there: pnpm run till:pin -- --user u-manager/);
    expect([...none.calls, ...never.calls]).toEqual([]);
    // Nobody asks and approves; nobody grants themselves; the store role is the till's own sign-in only.
    const same = await world().run('grant', { ...grant, approver: 'u-manager' });
    expect(same.lines.join('\n')).toMatch(/two different people/);
    expect((await world().run('grant', { ...grant, person: 'u-owner' })).lines.join('\n')).toMatch(/never asks for it or approves it for themselves/);
    expect((await world().run('grant', { ...grant, person: 'u-friend', role: 'store_computer' })).lines.join('\n')).toMatch(/only for the till's own sign-in, store-edge/);
  });

  it('with both PINs right it calls the request as the asker and the approval as the approver, each at its own sign-in', async () => {
    const w = world();
    const out = await w.run('grant', { as: 'u-manager', approver: 'u-owner', person: 'store-edge', role: 'store_computer', store: 'SRE-MAIN', reason: 'the till syncs' });
    expect(out.exitCode).toBe(0);
    expect(w.calls.map((c) => [c.method, c.path, c.userId])).toEqual([
      ['POST', '/v1/identity/grants', 'u-manager'],
      ['POST', '/v1/identity/grants/grant-store-edge-store_computer-SRE-MAIN/approve', 'u-owner'],
    ]);
    expect(w.calls[0]!.body).toEqual({ grantId: 'grant-store-edge-store_computer-SRE-MAIN', userId: 'store-edge', roleId: 'store_computer', branchScope: ['SRE-MAIN'], reason: 'the till syncs' });
    expect(out.lines.join('\n')).not.toMatch(/135790|246801/);
    // Store settings: rupees and minutes as the owner types them, sent as paise and seconds; the privacy days fixed.
    const s = world();
    await s.run('store-settings', { as: 'u-owner', store: 'SRE-MAIN', cutoff: '00:00', 'stale-after-minutes': '15', 'count-approval-rupees': '500', 'handover-tolerance-rupees': '0', 'cash-variance-rupees': '10.50' });
    expect(s.calls[0]!.body).toEqual({ tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 50_000, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 1_050, privacySlaDays: 15 });
  });
});

describe('the PIN check and the person\'s token (OB-257 · OB-251)', () => {
  const at = '2026-10-20T09:00:00.000Z';
  const files = (credentials: unknown[] | undefined) => ({
    tillEnv: { EDGE_DATA_DIR: '/data/till/edge-data', PACK_SIGNING_KEY: KEY },
    settings: {},
    readFile: (p: string) => (p === credentialsFileOf({ EDGE_DATA_DIR: '/data/till/edge-data' }) && credentials !== undefined ? JSON.stringify({ version: 1, credentials }) : undefined),
  });

  it('is the till\'s own check: the latest PIN wins, a revoked one opens nothing, no till means it cannot check', () => {
    const old = issueTillCredential({ userId: 'u-m', pin: '111111', key: tillPinKey(KEY), issuedAt: at, issuedBy: 'owner' });
    const reissued = issueTillCredential({ userId: 'u-m', pin: '222222', key: tillPinKey(KEY), issuedAt: at, issuedBy: 'owner' });
    const check = pinVerifier(files([old, reissued]));
    expect(check('u-m', '222222')).toBe('ok');
    expect(check('u-m', '111111')).toBe('wrong');
    expect(check('u-x', '222222')).toBe('no_pin_issued');
    expect(pinVerifier(files([reissued, { userId: 'u-m', revoked: true, issuedAt: at, issuedBy: 'owner' }]))('u-m', '222222')).toBe('no_pin_issued');
    expect(pinVerifier(files(undefined))('u-m', '222222')).toBe('no_pin_issued');
    expect(pinVerifier({ tillEnv: undefined, settings: {}, readFile: () => undefined })('u-m', '222222')).toBe('cannot_check');
    // A different PC's key opens nothing.
    expect(pinVerifier({ ...files([reissued]), tillEnv: { EDGE_DATA_DIR: '/data/till/edge-data', PACK_SIGNING_KEY: 'x'.repeat(64) } })('u-m', '222222')).toBe('wrong');
  });

  it('the token verifies against the API\'s policy and carries the step-up the grant route asks for — PIN plus this PC', () => {
    const now = Date.parse('2026-10-20T10:00:00.000Z');
    const token = buildPersonToken({ sub: 'u-owner', tenantId: T, ttlSeconds: 300, authTimeSec: Math.floor(now / 1000) }, TEST_IDP.policy(), now);
    const v = verifyToken(token, TEST_IDP.policy(), now + 1000);
    if (!v.ok || v.principal === undefined) throw new Error(v.detail);
    expect(STORE_PC_PIN_AMR).toEqual(['pin', 'swk']);
    expect(v.principal.amr).toEqual(['pin', 'swk', 'mfa']);
    expect(evaluateStepUp({ withinSeconds: 300, amr: ['mfa'] }, { authTime: v.principal.authTime!, amr: v.principal.amr! }, now + 1000).ok).toBe(true);
    // Six minutes after the PIN was typed, the step-up is stale — a sensitive act needs the PIN again.
    expect(evaluateStepUp({ withinSeconds: 300, amr: ['mfa'] }, { authTime: v.principal.authTime!, amr: v.principal.amr! }, now + 360_000).ok).toBe(false);
  });
});
