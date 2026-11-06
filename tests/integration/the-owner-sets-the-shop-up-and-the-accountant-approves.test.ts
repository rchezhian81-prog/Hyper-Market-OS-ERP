import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ApiHarness } from '../support/api-harness';
import { TEST_IDP } from '../support/api-harness';
import { r3OpsBackings } from '../support/r3-ops-backings';
import { runOwnerSetup, type SetupClient } from '../../packages/migration/src/owner-steps-command';
import { buildPersonToken } from '../../scripts/lib/operator-env';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * Store PC, 6 Nov 2026 (M01-FR-01 · OB-613 · OB-95): the shop has no IT person, so nobody holds `platform_admin`, and
 * the first people laid down by tenant:bootstrap are the owner, the accountant and the store manager (OB-277). Part 17
 * of the Windows guide asked for "the setup person" — a login that does not exist. The owner holds the setup right
 * himself; when he raises the structural change, the store's accountant is the second person (OB-613). This proves the
 * guide's line works with exactly the three people the store PC has, and that the store manager cannot be the checker.
 */

const backings = r3OpsBackings();
const OWNER = 'owner-01';
const ACCOUNTANT = 'accountant-01';
const MANAGER = 'store-manager-01';
const GSTIN = '33AABCS1429B1Z1';

function personClient(get: () => ApiHarness): SetupClient {
  return {
    request: async (r) => get().raw({
      method: r.method, path: r.path, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }),
      token: buildPersonToken({ sub: r.userId, tenantId: r.tenantId, ttlSeconds: 300, authTimeSec: Math.floor(Date.parse(r.signedInAt) / 1000) }, TEST_IDP.policy(), Date.now()),
    }),
  };
}

describe.each(backings)('the owner sets the shop up and the accountant approves the store going live — on $name', ({ harness }) => {
  const setUp = async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, ACCOUNTANT, 'accountant');
    await h.provisionRole(T, MANAGER, 'store_manager');
    const deps = { client: personClient(() => h), confirm: async () => true, askPin: async () => '123456', verifyPin: () => 'ok' as const };
    const run = (values: Record<string, string>) => runOwnerSetup({ step: 'shop', tenantId: T, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], values, today: shopDateIn(new Date().toISOString()), now: () => new Date().toISOString() }, deps);
    return { run };
  };
  const shop = (store: string, approver: string) => ({ as: OWNER, approver, company: 'SRE', 'legal-name': 'SRE Hyper Market Private Limited', gstin: GSTIN, store, 'store-name': 'SRE Hyper Market' });

  it('owner-01 asks, accountant-01 approves: the store is active, with no IT login on the box', async () => {
    const { run } = await setUp();
    const o = await run(shop('SRE-MAIN', ACCOUNTANT));
    expect(o.exitCode, o.lines.join('\n')).toBe(0);
    expect(o.lines.join('\n')).toContain('DONE — the shop is set up at head office on this computer');
    expect(o.lines.join('\n')).toContain('approved by accountant-01');
  }, 60_000);

  it('the store manager is not the second person for the owner\'s structural change — refused, the store stays inactive', async () => {
    const { run } = await setUp();
    const o = await run(shop('SRE-MAIN', MANAGER));
    expect(o.exitCode).not.toBe(0);
    expect(o.lines.join('\n')).not.toContain('DONE — the shop is set up');
  }, 60_000);
});

describe('the Windows guide gives Part 17 with the logins the store PC really has', () => {
  it('owner-01 asks, accountant-01 approves — no "setup person" login', () => {
    const guide = readFileSync('docs/runbooks/store-computer-owner-guide-windows.md', 'utf8');
    expect(guide).toContain('pnpm run store-computer -- shop --as owner-01 --approver accountant-01 --company');
    expect(guide).not.toContain('<setup-person-login>');
  });
});
