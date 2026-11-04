import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, says, type W4Shop, type OpenPage } from './lib/w4-office-shop';
import { pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { TEST_IDP } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { Pool } from 'pg';
import { addDays } from '../../services/platform/src/secret-use';
import { secretUseRollupSweep, secretUseAlertId } from '../../services/api/src/w6-secret-use-adapters';

/**
 * **W6 · M32-FR-03 ("abnormal usage alerts") · owner decision OB-688, connected: the secret-use count on the Integration
 * health page and the abnormal-use alert on the Operational alerts page, in a real browser, on the production API surface
 * over real PostgreSQL (DATABASE_URL).**
 *   • the store computer box-1 signs in with its machine credential (reference cred-box-1) — 10 calls a week before, 200 on
 *     the day that changed sharply, and real calls today through head office; the backup job called a week before and then
 *     stopped;
 *   • the nightly pass (missed nights caught up) judges each day once and raises the spike and the silence to the named IT
 *     custodian (the security reviewer, OB-405) and the owner;
 *   • Integration health → Secrets → Show: each credential's last-30-days use (reference, caller, part of the system, calls,
 *     refused, days used, last used), the registered secret's own 30-day use, the last day checked and what was unusual —
 *     never a token or a value; nothing is written;
 *   • Operational alerts: the abnormal-use alert is on the board, owned by the IT custodian, with the reference, the caller
 *     and the counts.
 * Synthetic data only.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const SIVA = 'u-siva';
const PAGES = {
  '/integration-health': { html: 'integration-health.html', dataGlobal: 'integrationHealthData' },
  '/ops-alerts': { html: 'ops-alerts.html', dataGlobal: 'opsAlertsData' },
};
const evening = pinTheEveningClock();
const TODAY = evening.shopDate;
const A = addDays(TODAY, -9);
const B = addDays(TODAY, -2);
const noonOf = (day: string): string => `${day}T06:30:00.000Z`;

/** The W4 office page opener, with the page's clock pinned to the same evening as this process (a browser on UTC is on the shop's yesterday). */
async function openAs(shop: W4Shop, browser: Browser, who: string, path: string): Promise<OpenPage> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await pinThePageClock(context);
  await context.addCookies([{ name: 'who', value: who, domain: new URL(shop.base).hostname, path: '/' }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = []; const writes: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
  const res = await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
  if (res?.status() !== 200) throw new Error(`${path} as ${who}: the shell answered ${res?.status()}`);
  return { page, errors, writes, close: () => context.close() };
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('W6 secret use and its alert, connected on PostgreSQL', () => {
  let browser: Browser;
  let shop: W4Shop;
  let pool: Pool;
  const T = randomUUID();
  let token = '';
  const as = async (userId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => {
    const r = await shop.ho().request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `seed-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: PAGES });
    const h = shop.ho();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, 'box-1', 'store_computer', ['store-1']);
    await h.provisionRole(T, SIVA, 'security_reviewer');
    await as(OWNER, 'PUT', '/v1/compliance/security-reviewer', { userId: SIVA, displayName: 'Mr Sivakumar', reason: 'OB-405: the IT custodian' });
    // The box's credential is registered by REFERENCE (never its value) — under the same id it signs in with.
    await as(OWNER, 'POST', '/v1/integration/secrets/cred-box-1', { kind: 'service_identity', vaultRef: 'vault://store-computers/box-1#v1', owner: SIVA, protects: 'store 1\'s computer sending its sales to head office', rotateEveryDays: 365, environment: 'production' });
    await as(OWNER, 'POST', '/v1/integration/secrets/sec-pay', { kind: 'payment_provider', vaultRef: 'vault://payments/sandbox#v1', owner: OWNER, protects: 'card payments at the tills', rotateEveryDays: 90, environment: 'sandbox' });
    const past = (callerId: string, ref: string, api: string, role: string, day: string, n: number): void => {
      for (let i = 0; i < n; i++) h.secretUse.record({ tenantId: T, callerId, credentialRef: ref, api, status: 200, at: noonOf(day), roleIds: [role] });
    };
    past('box-1', 'cred-box-1', 'API-07', 'store_computer', A, 10);
    past('backup', 'cred-backup', 'API-11', 'backup_job', A, 3);
    past('box-1', 'cred-box-1', 'API-07', 'store_computer', B, 200);
    token = TEST_IDP.issue({ sub: 'box-1', tenantId: T, branchId: 'store-1', jti: 'cred-box-1', authTimeFromNowSeconds: null, amr: null });
    for (let i = 0; i < 3; i++) {
      const r = await h.raw({ method: 'GET', path: '/v1/catalogue/ratings', token });
      if (r.status !== 200) throw new Error(`box call: ${r.status} ${JSON.stringify(r.body)}`);
    }
    await h.secretUse.flush();
    // The nightly pass, after nine missed nights.
    pool = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    const raised = await secretUseRollupSweep({ store: new SqlEventStore(pgPoolClient(pool)), now: () => new Date().toISOString() })(T, new Date().toISOString());
    if (raised !== 2) throw new Error(`the nightly pass raised ${raised} alert(s), not 2`);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); await pool?.end(); vi.useRealTimers(); });

  it('M32-FR-03: Integration health shows each credential\'s last 30 days of use and what was unusual — never a value', async () => {
    expect(shop.backing).toBe('PostgreSQL');
    const s = await openAs(shop, browser, OWNER, '/integration-health');
    try {
      await says(s.page, '#w5-sec-h', /Secrets the shop's connections use/);
      await s.page.click('#w5-sec-show');
      await says(s.page, '#w5-sec-use li[data-ref="cred-box-1"]', new RegExp(`^reference cred-box-1 · by box-1 · on API-07 · 213 calls · 0 refused or failed · 3 days used · last used ${TODAY}$`));
      await says(s.page, '#w5-sec-use li[data-ref="cred-backup"]', new RegExp(`^reference cred-backup · by backup · on API-11 · 3 calls · 0 refused or failed · 1 days used · last used ${A}$`));
      await says(s.page, '#w5-sec-list li[data-id="cred-box-1"]', /vault:\/\/store-computers\/box-1#v1 .* · use in the last 30 days: 213 calls, 0 refused or failed$/);
      await says(s.page, '#w5-sec-list li[data-id="sec-pay"]', /no use recorded in the last 30 days$/);
      await says(s.page, '#w5-sec-checked', new RegExp(`^Last day checked: ${addDays(TODAY, -1)}`));
      await says(s.page, '#w5-sec-unusual li[data-signal="spike"]', new RegExp(`^${B} · box-1 · API-07 · far more calls than the same day a week before \\(${A}\\)$`));
      await says(s.page, '#w5-sec-unusual li[data-signal="silent"]', new RegExp(`^${B} · backup · API-11 · stopped calling \\(${A}\\)$`));
      // Never a token or a secret value anywhere on the page; nothing written.
      const text = await s.page.textContent('body') ?? '';
      for (const bad of [token, token.split('.')[2]!, 'eyJ']) expect(text).not.toContain(bad);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('M32-FR-03: the abnormal-use alert is on the Operational alerts page, owned by the IT custodian, with the reference and the counts', async () => {
    const s = await openAs(shop, browser, OWNER, '/ops-alerts');
    try {
      const row = `#all li[data-alert="${secretUseAlertId(B, 'box-1', 'API-07', 'spike')}"]`;
      await says(s.page, row, /⚠ Secret use · box-1 · API-07/);
      await says(s.page, row, new RegExp(`On ${B}, box-1 \\(credential reference cred-box-1\\) used API-07: 200 call\\(s\\), 0 refused or failed; on ${A} \\(the same day a week before\\): 10 call\\(s\\).*Reported, not blocked.*owner Mr Sivakumar \\(u-siva\\)`));
      await says(s.page, `#all li[data-alert="${secretUseAlertId(B, 'backup', 'API-11', 'silent')}"]`, /Secret use · backup · API-11.*it stopped calling/);
      const text = await s.page.textContent('body') ?? '';
      for (const bad of [token, 'eyJ']) expect(text).not.toContain(bad);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
