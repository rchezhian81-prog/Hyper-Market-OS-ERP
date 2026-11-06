import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'playwright-core';
import { CONNECTED, operatorGrant, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';

/**
 * **W4 · M36-FR-04 (P-06 · OB-385 · hard rules #4 and #7): the Partners and sandboxes page and the Developer guide — ONE
 * connected run: real Chromium, served by a REAL store computer, over the PRODUCTION API on real PostgreSQL.**
 * (`w3-partners-sandboxes-and-the-developer-guide.e2e.ts` proves the same pages over the in-memory route set.)
 *   • the IT administrator makes a sandbox for SRE's own integrator and seeds it with generated records; registers a
 *     sandbox-only credential; head office refuses that credential in the real shop, by name, and allows it in the sandbox;
 *     records a connector certification against the API version head office's manifest publishes and checks it; revokes
 *     the credential (the record stays, on PostgreSQL);
 *   • no secret, password or token is made, typed or shown anywhere on the page;
 *   • the Developer guide lists every call from the published contract and finds one by a word, with its permission and
 *     its Idempotency-Key; it sends nothing; Tamil words on both pages;
 *   • a cashier is not given the page (her words are head office's own), and head office refuses her read.
 * Synthetic data only. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const IT = 'u-it'; const CASH = 'u-cash'; const STORE = 'br-1';
type Doc = { document: { querySelector(s: string): { textContent: string | null } | null } };
const says = async (page: Page, selector: string, re: RegExp): Promise<void> => {
  try {
    await page.waitForFunction(([sel, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.querySelector(sel!)?.textContent ?? ''), [selector, re.source] as const, { timeout: 15_000 });
  } catch {
    throw new Error(`${selector} says ${JSON.stringify(await page.textContent(selector).catch(() => null))}, not ${String(re)}`);
  }
};

describe.skipIf(!CONNECTED)('M36-FR-04 connected: partners, sandboxes and the Developer guide on the store computer, over the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'm36-partners', store: STORE,
      people: [{ userId: IT }, { userId: CASH, branchId: STORE }],
      seed: async (cloud) => {
        // The IT role, laid on the ledger by the operator (the owner may not hand out platform_admin's own permissions).
        await operatorGrant(cloud, IT, 'platform_admin');
        await cloud.grant(CASH, 'cashier', undefined, [STORE]);
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  it('a sandbox, a sandbox-only credential, a certification and an access check, kept on PostgreSQL — no secret anywhere', async () => {
    const p = await shop.open(IT, '/partners');
    expect(p.status).toBe(200);
    await says(p.page, '#sb-rows', /No sandbox yet/);
    await says(p.page, '#cred-rows', /No credential registered yet/);
    // A sandbox, seeded with generated records.
    await p.page.fill('#sb-id', 'sb-integrator');
    await p.page.fill('#sb-partner', 'sre-integrator');
    await p.page.fill('#sb-expires', '2099-01-01');
    await p.page.click('#sb-save');
    await says(p.page, '#sb-status', /^Sandbox made\./);
    await says(p.page, '#sb-rows', /sb-integrator.*sre-integrator.*Made-up data only/);
    await p.page.fill('#sb-count', '5');
    await p.page.click('#sb-rows tr[data-id="sb-integrator"] button');
    await says(p.page, '#sb-status', /checked 5 generated record\(s\)/);
    // A credential that reaches only that sandbox.
    await p.page.click('#cr-save');
    await says(p.page, '#cred-status', /Fill in the name/);
    await p.page.fill('#cr-id', 'cred-integrator');
    await p.page.fill('#cr-partner', 'sre-integrator');
    await p.page.selectOption('#cr-env', 'sandbox');
    await p.page.fill('#cr-reach', 'sb-integrator');
    await p.page.fill('#cr-scopes', 'catalogue.pack.read');
    await p.page.fill('#cr-expires', '2099-01-01');
    await p.page.click('#cr-save');
    await says(p.page, '#cred-status', /Registered\. Its access token is issued to the partner out of band/);
    await says(p.page, '#cred-rows', /cred-integrator.*sre-integrator.*Sandbox only.*sb-integrator.*catalogue\.pack\.read.*2099-01-01.*In force/);
    // Head office decides from the stored credential: refused in the real shop, allowed in the sandbox.
    await p.page.selectOption('#ac-cred', 'cred-integrator');
    await p.page.selectOption('#ac-env', 'production');
    await p.page.fill('#ac-tenant', 'sb-integrator');
    await p.page.fill('#ac-scope', 'catalogue.pack.read');
    await p.page.selectOption('#ac-api', 'API-02');
    await p.page.click('#ac-check');
    await says(p.page, '#ac-status', /^Refused: .*sandbox/i);
    await p.page.selectOption('#ac-env', 'sandbox');
    await p.page.click('#ac-check');
    await says(p.page, '#ac-status', /^Allowed:/);
    // A connector certification against the version head office's manifest publishes, checked against today.
    await p.page.fill('#ce-id', 'cert-tally-bridge');
    await p.page.fill('#ce-partner', 'sre-integrator');
    await p.page.fill('#ce-conn', 'tally-bridge');
    await p.page.fill('#ce-on', '2026-10-01');
    await p.page.check('#ce-apis input[value="API-09"]');
    await p.page.click('#ce-save');
    await says(p.page, '#ce-status', /^Certification recorded/);
    await says(p.page, '#ce-rows', new RegExp(`sre-integrator.*tally-bridge.*2026-10-01.*${IT}.*API-09 v1`));
    await p.page.click('#ce-rows button');
    await says(p.page, '#ce-rows', /may run in the real shop/);
    // Revoked: kept, with the date.
    await p.page.click('#cred-rows tr[data-id="cred-integrator"] button');
    await says(p.page, '#cred-status', /^Revoked from \d{4}-\d{2}-\d{2}\. The record stays\.$/);
    await says(p.page, '#cred-rows', /cred-integrator.*Revoked on/);
    // Head office (PostgreSQL) holds the revoked credential, the sandbox and the certification.
    const reg = (await shop.call('GET', '/v1/platform/partners', IT)).body as { credentials: { credentialId: string; state: string }[] };
    expect(reg.credentials).toEqual([expect.objectContaining({ credentialId: 'cred-integrator', state: 'revoked' })]);
    // No secret, password or token is ever on the page.
    expect(await p.page.$$('input[type="password"]')).toHaveLength(0);
    expect((await p.page.textContent('main')) ?? '').not.toMatch(/secret:|token:/i);
    await p.page.click('#lang');
    await says(p.page, '#page-h', /^கூட்டாளர்களும் சோதனைத் தளங்களும்$/);
    expect(p.errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('the Developer guide lists every call from the published contract and finds one by a word', async () => {
    const d = await shop.open(IT, '/developer-docs');
    expect(d.status).toBe(200);
    await says(d.page, '#version', /^Contract v1-.* — \d{3,} calls, from docs\/api\/openapi\.json\.$/);
    await d.page.fill('#q', 'partners/sandboxes');
    await says(d.page, '#count', /^\d+ call\(s\) match\./);
    const op = d.page.locator('li[data-op="POST /v1/platform/partners/sandboxes/{sandboxId}"]');
    await op.locator('summary').click();
    await says(d.page, 'li[data-op="POST /v1/platform/partners/sandboxes/{sandboxId}"]', /Needs the permission: platform\.partner\.manage.*Send an Idempotency-Key header.*partnerId: string \(required\)/);
    await d.page.selectOption('#group', 'API-05 POS');
    await d.page.fill('#q', '');
    await says(d.page, '#count', /call\(s\) match/);
    expect(await d.page.locator('#ops li').count()).toBeGreaterThan(0);
    await d.page.click('#lang');
    await says(d.page, '#page-h', /^உருவாக்குநர் வழிகாட்டி$/);
    expect(d.errors).toEqual([]);
    expect(d.writes).toEqual([]);
    await d.close();
  }, 120_000);

  it('a cashier is not given the page by the store computer, and head office refuses her read', async () => {
    const c = await shop.open(CASH, '/partners');
    expect(c.status).toBe(403);
    expect(c.writes).toEqual([]);
    await c.close();
    expect((await shop.call('GET', '/v1/platform/partners', CASH)).status).toBe(403);
  }, 60_000);
});
