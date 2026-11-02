import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { openAs } from './lib/w3-page';
import { says } from './lib/r4c-box-page';

/**
 * **W3 · M35-FR-04 (§32 · P-03 · P-08): an operational alert is owned, ticked as seen and re-owned on the Operational
 * alerts page, in a real browser, on the PRODUCTION API over real PostgreSQL.** The owner says who owns the "queue not
 * known" alert (the br-1 manager, 30 minutes, then to the owner) — the shop's first rules version; head office raises it;
 * it is in the manager's own alerts, open; he ticks it as seen, so it will not escalate; the owner then hands it to
 * himself — a new version, based on the one he read; and a save based on a version someone else has since replaced is
 * refused by head office, nothing lost.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'alerts', 'key'].join('-').padEnd(48, '0');
const RULE = 'shop:queue:unknown';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Operational alerts (M35-FR-04) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/ops-alerts', html: 'ops-alerts.html', dataGlobal: 'opsAlertsData' },
      seed: async () => {},
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the owner names the owner; the manager ticks it as seen; the owner re-owns it; a stale save is refused', async () => {
    // ── The owner says who owns the alert ──
    let s = await openAs(shop, browser, OWNER, '/ops-alerts');
    try {
      await says(s.page, '#rules', /No alert rules of the shop's own are set yet\./);
      await says(s.page, '#mine', /No alert is waiting for you\./);
      await s.page.fill('#n-component', 'queue'); await s.page.selectOption('#n-fires', 'unknown');
      await s.page.fill('#n-owner', MGR); await s.page.fill('#n-name', 'Store manager br-1'); await s.page.fill('#n-minutes', '30'); await s.page.fill('#n-escalates', OWNER);
      await s.page.click('#n-add');
      await says(s.page, '#add-status', /^Saved\. The rules in force are now version 1\.$/);
      await says(s.page, `#rules li[data-rule="${RULE}"]`, /queue — not known.*owner Store manager br-1 \(u-mgr-br1\) · 30 min · went to u-owner/);
      expect(s.writes).toEqual(['PUT /v1/platform/alert-rules']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // Head office raises it from the evidence (the queue is not reporting), under the rule in force.
    const rules = (await shop.cloud().request({ method: 'GET', path: '/v1/platform/alert-rules', userId: OWNER })).body as { rules: { version: number; rules: unknown[] } };
    expect(rules.rules.version).toBe(1);
    const raised = await shop.cloud().request({ method: 'POST', path: '/v1/platform/alerts/raise', userId: OWNER, idempotencyKey: 'raise-queue', body: { signals: {}, alertRules: rules.rules.rules } });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);

    // ── The manager sees it in his own alerts and ticks it as seen ──
    s = await openAs(shop, browser, MGR, '/ops-alerts', 'br-1');
    try {
      const row = `#mine li[data-alert="${RULE}"]`;
      await says(s.page, row, /⚠ queue — not known · open — nobody has ticked it yet/);
      await s.page.click(`${row} button`);
      await says(s.page, '#all', /queue — not known · seen.*seen by u-mgr-br1/);
      expect(s.writes).toEqual([`POST /v1/platform/alerts/${encodeURIComponent(RULE)}/acknowledge`]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const board = (await shop.cloud().request({ method: 'GET', path: '/v1/platform/alerts', userId: OWNER })).body as { alerts: { alert: { alertId: string }; state: string; acknowledgedBy?: string }[] };
    expect(board.alerts.find((a) => a.alert.alertId === RULE)).toMatchObject({ state: 'acknowledged', acknowledgedBy: MGR });

    // ── The owner hands it to himself; a save on a version someone else has replaced is refused ──
    s = await openAs(shop, browser, OWNER, '/ops-alerts');
    try {
      const row = `#rules li[data-rule="${RULE}"]`;
      await says(s.page, row, /owner Store manager br-1/);
      // Someone else saves a change while this page still shows version 1.
      const other = await shop.cloud().request({ method: 'PUT', path: '/v1/platform/alert-rules', userId: OWNER, idempotencyKey: 'other-save', body: { rules: rules.rules.rules, backupMaxAgeSeconds: 7200, basedOnVersion: 1 } });
      expect(other.status, JSON.stringify(other.body)).toBe(200);
      await s.page.fill(`${row} .o-owner`, OWNER); await s.page.fill(`${row} .o-name`, 'Owner'); await s.page.fill(`${row} .o-escalates`, '');
      await s.page.click(`${row} button`);
      await says(s.page, `${row} .status`, /^Head office refused: Someone else just changed these rules/);
      // Read again, and save on what it shows now.
      await s.page.reload({ waitUntil: 'load' });
      await says(s.page, row, /owner Store manager br-1/);
      await s.page.fill(`${row} .o-owner`, OWNER); await s.page.fill(`${row} .o-name`, 'Owner'); await s.page.fill(`${row} .o-escalates`, '');
      await s.page.click(`${row} button`);
      await says(s.page, row, /owner Owner \(u-owner\) · 30 minOwner/);
      expect(await s.page.inputValue('#b-hours'), 'the other person\'s backup age is kept').toBe('2');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const after = (await shop.cloud().request({ method: 'GET', path: '/v1/platform/alert-rules', userId: OWNER })).body as { rules: { version: number; backupMaxAgeSeconds: number; rules: { alertId: string; ownerUserId: string; escalatesToUserId?: string }[] } };
    expect(after.rules.version).toBe(3);
    expect(after.rules.backupMaxAgeSeconds).toBe(7200);
    expect(after.rules.rules.find((r) => r.alertId === RULE)).toMatchObject({ ownerUserId: OWNER });
    expect(after.rules.rules.find((r) => r.alertId === RULE)?.escalatesToUserId).toBeUndefined();
  }, 240_000);
});
