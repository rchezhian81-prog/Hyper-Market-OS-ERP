import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W5 · platform operations, connected: the new sections on five office pages, in a real browser, on the production API
 * surface over real PostgreSQL (DATABASE_URL).**
 *   • M33-FR-02 — Store devices: a live remote session is ended with a reason; the version policy is set; a broken release is
 *     withdrawn only once the person ticks to confirm; the current version cannot be withdrawn (head office's words);
 *   • M33-FR-04 — Roll-out: a licence is recorded with its named owner; one past its end is in the alerts naming that owner;
 *     Incidents: a service request is raised, given to a person and resolved with a note;
 *   • M32-FR-03 — Integration health: the secrets list shows where each is kept, its dates and state — never a value — and the
 *     check names the one overdue for a change;
 *   • M35-FR-04 — Incidents: a raised alert is linked to an open incident;
 *   • PA-09 — Document templates: an issued document is found as issued and reprinted as a numbered, audited duplicate;
 *   • a cashier, whose role does not cover the shop's devices, is told so and offered nothing.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cashier';
const PAGES = {
  '/fleet': { html: 'fleet.html', dataGlobal: 'fleetData' },
  '/rollout': { html: 'rollout.html', dataGlobal: 'rolloutData' },
  '/integration-health': { html: 'integration-health.html', dataGlobal: 'integrationHealthData' },
  '/incidents': { html: 'incidents.html', dataGlobal: 'incidentsData' },
  '/document-templates': { html: 'document-templates.html', dataGlobal: 'documentTemplatesData' },
};

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('W5 platform operations sections, connected on PostgreSQL', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const as = async (userId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => {
    const r = await shop.ho().request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `seed-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: PAGES });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, MGR, 'store_manager');
    await shop.ho().provisionRole(T, CASHIER, 'cashier', ['store-1']);
    // A support engineer is connected to lane 2's till right now.
    await as(OWNER, 'POST', '/v1/platform/remote-sessions', { sessionId: 'rs-1', deviceId: 'pos-lane-2', userId: 'u-vendor', kind: 'remote' });
    // A payment secret's REFERENCE (never its value) — registered by the custodian outside this page.
    await as(OWNER, 'POST', '/v1/integration/secrets/sec-pay', { kind: 'payment_provider', vaultRef: 'vault://payments/sandbox#v1', owner: 'u-owner', protects: 'card payments at the tills', rotateEveryDays: 90, environment: 'sandbox', lastRotatedOn: '2025-01-01' });
    // An alert raised by head office under the shop's own rule, and an open incident.
    await as(OWNER, 'PUT', '/v1/platform/alert-rules', { rules: [{ alertId: 'shop:queue:unknown', component: 'queue', firesAt: 'unknown', ownerUserId: OWNER, ownerName: 'Owner', ackWithinMinutes: 30 }], basedOnVersion: 0 });
    const rules = await as(OWNER, 'GET', '/v1/platform/alert-rules') as { rules: { rules: unknown[] } };
    await as(OWNER, 'POST', '/v1/platform/alerts/raise', { signals: {}, alertRules: rules.rules.rules });
    await as(OWNER, 'POST', '/v1/platform/incidents/inc-1', { title: 'Tills slow to sync', severity: 'sev3', summary: 'lane sync lagging' });
    // An issued document (a template version drafted by the owner, approved by the manager, then issued).
    await as(OWNER, 'POST', '/v1/documents/templates/order-notice/versions', { kind: 'notification', body: 'ORDER {{order}} IS READY', changeNote: 'first' });
    await as(MGR, 'POST', '/v1/documents/templates/order-notice/versions/1/approve', {});
    await as(OWNER, 'POST', '/v1/documents/templates/order-notice/issue', { kind: 'notification', documentId: 'notice-ord-1', subjectRef: 'order:ORD-1', data: { order: 'ORD-1' }, retainUntil: '2099-12-31' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('M33-FR-02: the owner ends a remote session, sets the version policy and withdraws a broken release', async () => {
    expect(shop.backing).toBe('PostgreSQL');
    const s = await openAs(shop, browser, OWNER, '/fleet');
    try {
      await s.page.click('#w5-fc-show');
      await says(s.page, '#w5-rs-list li[data-session="rs-1"]', /rs-1 · for u-vendor · on pos-lane-2 · remote · .* · connected now/);
      await says(s.page, '#w5-vp-now', /No version policy is set yet\./);
      await s.page.click('#w5-rs-end-rs-1');
      await says(s.page, '#w5-fc-status', /^Say, in writing, why\.$/);
      await s.page.fill('#w5-rs-why-rs-1', 'the printer fix is done');
      await s.page.click('#w5-rs-end-rs-1');
      await says(s.page, '#w5-fc-status', /^Ended\. It is kept on the record\.$/);
      await says(s.page, '#w5-rs-list li[data-session="rs-1"]', /ended by u-owner — the printer fix is done/);

      await s.page.fill('#w5-vp-current', '1.5.0'); await s.page.fill('#w5-vp-previous', '1.4.0'); await s.page.fill('#w5-vp-minimum', '1.3.0');
      await s.page.click('#w5-vp-set');
      await says(s.page, '#w5-fc-status', /^Saved\. Devices are judged by it from now\.$/);
      await says(s.page, '#w5-vp-now', /Current version: 1\.5\.0.*Previous version \(optional\): 1\.4\.0.*Oldest version still allowed: 1\.3\.0/);

      await s.page.fill('#w5-kill-version', '1.4.0');
      await s.page.click('#w5-kill-go');
      await says(s.page, '#w5-fc-status', /^Tick the box to confirm you are withdrawing this release\.$/);
      await s.page.check('#w5-kill-confirm');
      await s.page.click('#w5-kill-go');
      await says(s.page, '#w5-fc-status', /^Withdrawn\. Devices on it are moved back\.$/);
      await says(s.page, '#w5-vp-now', /Withdrawn releases: 1\.4\.0/);
      // The current version can never be withdrawn — head office says so in its words.
      await s.page.fill('#w5-kill-version', '1.5.0'); await s.page.check('#w5-kill-confirm');
      await s.page.click('#w5-kill-go');
      await says(s.page, '#w5-fc-status', /^Head office refused: /);
      expect(s.writes).toEqual(['POST /v1/platform/remote-sessions/rs-1/terminate', 'POST /v1/platform/version-policy', 'POST /v1/platform/version-policy/kill', 'POST /v1/platform/version-policy/kill']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const policy = await as(OWNER, 'GET', '/v1/platform/version-policy') as { policy: { killedVersions?: string[] } };
    expect(policy.policy.killedVersions).toEqual(['1.4.0']);
  }, 120_000);

  it('a cashier is told his role cannot see the shop\'s devices — no show, end, set or withdraw button', async () => {
    const s = await openAs(shop, browser, CASHIER, '/fleet', 'store-1');
    try {
      await says(s.page, '#w5-fc-status', /^Your role cannot do this\.$/);
      expect(await s.page.locator('#w5-fc-show, #w5-vp-set, #w5-kill-go, [id^="w5-rs-end-"]').count()).toBe(0);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('M33-FR-04: a licence with a named owner is recorded on Roll-out; one past its end alerts that owner', async () => {
    const s = await openAs(shop, browser, OWNER, '/rollout');
    try {
      await s.page.fill('#w5-lic-module', 'tally-link'); await s.page.fill('#w5-lic-name', 'Tally link');
      await s.page.fill('#w5-lic-expires', '2026-01-31'); await s.page.fill('#w5-lic-owner-id', OWNER);
      await s.page.click('#w5-lic-save');
      await says(s.page, '#w5-lic-status', /^Fill in every box marked for this\.$/);
      await s.page.fill('#w5-lic-owner-name', 'Mr Sivakumar');
      await s.page.click('#w5-lic-save');
      await says(s.page, '#w5-lic-status', /^Saved\.$/);
      await says(s.page, '#w5-lic-list li[data-id="tally-link"]', /^Tally link \(tally-link\) · on · ends 2026-01-31 · renewed by Mr Sivakumar \(u-owner\)$/);
      await says(s.page, '#w5-lic-alerts li[data-module="tally-link"]', /Tally link EXPIRED \d+ day\(s\) ago — Mr Sivakumar must renew it now/);
      expect(s.writes).toEqual(['POST /v1/platform/licences/tally-link']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('M32-FR-03: Integration health lists the secrets — where kept, dates, state — never a value; the check names the one overdue for a change', async () => {
    const s = await openAs(shop, browser, OWNER, '/integration-health');
    try {
      await s.page.click('#w5-sec-show');
      await says(s.page, '#w5-sec-list li[data-id="sec-pay"]', /sec-pay · payment_provider · sandbox · card payments at the tills · u-owner · kept at vault:\/\/payments\/sandbox#v1 · v1 · made \d{4}-\d{2}-\d{2} · last changed 2025-01-01 · change every 90 days · state: in use/);
      await s.page.click('#w5-sec-review-go');
      await says(s.page, '#w5-sec-review li[data-finding="overdue_rotation"]', /^Needs attention · sec-pay — the key protecting card payments at the tills has not been rotated in \d+ day\(s\) against a 90-day policy$/);
      expect(await s.page.locator('[data-w5="secrets"] input, [data-w5="secrets"] textarea').count(), 'the section has no box to type a secret into').toBe(0);
      expect(s.writes, 'the check reads; it writes nothing').toEqual(['POST /v1/integration/secrets/review']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('M35-FR-04 · M33-FR-04: on Incidents an alert is linked to the open incident, and a service request is raised, given and resolved', async () => {
    const s = await openAs(shop, browser, OWNER, '/incidents');
    try {
      await s.page.click('#w5-link-show');
      await expect.poll(async () => s.page.locator('#w5-link-alert option').count(), { timeout: 15_000 }).toBe(1);
      await s.page.selectOption('#w5-link-incident', 'inc-1');
      await s.page.click('#w5-link-go');
      await says(s.page, '#w5-link-status', /^Linked\.$/);

      await s.page.fill('#w5-sr-title', 'Lane 3 receipt printer prints blank');
      await s.page.fill('#w5-sr-detail', 'Since this morning; paper is loaded');
      await s.page.selectOption('#w5-sr-priority', 'high');
      await s.page.click('#w5-sr-raise');
      await says(s.page, '#w5-sr-status', /^Raised\.$/);
      const row = '#w5-sr-list li[data-title="Lane 3 receipt printer prints blank"]';
      await says(s.page, row, /Open · High · other · raised by u-owner/);
      const id = await s.page.getAttribute(row, 'data-request');
      await s.page.fill(`#w5-sr-to-${id}`, MGR);
      await s.page.click(`#w5-sr-assign-${id}`);
      await says(s.page, row, /Being worked · High .* · with u-mgr/);
      await s.page.selectOption(`#w5-sr-status-${id}`, 'resolved');
      await s.page.click(`#w5-sr-move-${id}`);
      await says(s.page, '#w5-sr-status', /^Say, in writing, why\.$/);
      await s.page.fill(`#w5-sr-note-${id}`, 'printer head cleaned');
      await s.page.click(`#w5-sr-move-${id}`);
      await says(s.page, row, /Resolved · High .* printer head cleaned/);
      await says(s.page, '#w5-sr-count', /^0 still need work$/);
      expect(s.writes).toEqual(['POST /v1/platform/incidents/inc-1/alerts', 'POST /v1/platform/service-requests', `POST /v1/platform/service-requests/${id}/assign`, `POST /v1/platform/service-requests/${id}/status`]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const inc = await as(OWNER, 'GET', '/v1/platform/incidents') as { incidents: { incidentId: string; alertIds: string[] }[] };
    expect(inc.incidents.find((i) => i.incidentId === 'inc-1')!.alertIds).toEqual(['shop:queue:unknown']);
  }, 120_000);

  it('PA-09: Document templates finds the issued notice as issued and reprints it as a numbered, audited duplicate', async () => {
    const s = await openAs(shop, browser, OWNER, '/document-templates');
    try {
      await s.page.fill('#w5-doc-id', 'notice-ord-1');
      await s.page.click('#w5-doc-find');
      await says(s.page, '#w5-doc-about', /^Kind: notification · issued .* by u-owner · Reprints so far: 0$/);
      await says(s.page, '#w5-doc-content', /ORDER ORD-1 IS READY/);
      await s.page.click('#w5-doc-reprint');
      await says(s.page, '#w5-doc-status', /^Say, in writing, why\.$/);
      await s.page.fill('#w5-doc-why', 'the customer lost the message');
      await s.page.click('#w5-doc-reprint');
      await says(s.page, '#w5-doc-status', /^Reprinted:$/);
      await says(s.page, '#w5-doc-marking', /^DUPLICATE — copy 1/);
      await says(s.page, '#w5-doc-about', /Reprints so far: 1$/);
      expect(s.writes).toEqual(['POST /v1/documents/issued/notice-ord-1/reprint']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
