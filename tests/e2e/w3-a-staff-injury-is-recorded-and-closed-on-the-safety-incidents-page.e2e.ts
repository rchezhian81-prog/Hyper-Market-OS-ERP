import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { openAs } from './lib/w3-page';
import { says } from './lib/r4c-box-page';

/**
 * **W3 · D11-FR-06 (M26 · §28 · hard rule #6): a staff injury is recorded and closed on the Safety incidents page, in a
 * real browser, on the PRODUCTION API over real PostgreSQL.** The br-1 manager records a SERIOUS injury with its evidence
 * (when it happened is typed on the shop's clock); head office refuses to let the person who recorded it close it (a
 * second person, §28) and refuses a close with no corrective action — the incident stays open, and the page says why in
 * head office's words; the owner closes it with what was done. Both acts are head office's record, with who did each.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'safety', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Safety incidents (D11-FR-06) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/safety-incidents', html: 'safety-incidents.html', dataGlobal: 'safetyIncidentsData' },
      seed: async () => {},
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the manager records a serious injury; he may not close it himself; the owner closes it with what was done', async () => {
    let s = await openAs(shop, browser, MGR, '/safety-incidents', 'br-1');
    let incidentId = '';
    try {
      await s.page.fill('#s-store', 'br-1');
      await s.page.click('#s-read');
      await says(s.page, '#rows', /No incident has been recorded at this store\./);
      await s.page.selectOption('#r-kind', 'injury'); await s.page.selectOption('#r-severity', 'serious');
      await s.page.fill('#r-who', 'Meena (packer)'); await s.page.fill('#r-what', 'cut her hand on a crate strap in the back store');
      await s.page.click('#r-raise');
      await says(s.page, '#raise-status', /^Say when it happened\.$/);
      expect(s.writes).toEqual([]);
      await s.page.fill('#r-when', '2026-11-02T10:15');
      await s.page.fill('#r-evidence', 'photo-strap-1, first-aid-log-7');
      await s.page.click('#r-raise');
      await says(s.page, '#raise-status', /^Recorded\./);
      await says(s.page, '#rows li[data-open="true"]', /open · Staff injury · Serious · 2026-11-02 10:15/);
      await says(s.page, '#rows li[data-open="true"]', /reported by Meena \(packer\) · 2 evidence items/);
      incidentId = (await s.page.getAttribute('#rows li[data-open="true"]', 'data-incident'))!;
      // The person who recorded it may not close a serious one — head office says so, and it stays open.
      await s.page.fill(`#c-action-${incidentId}`, 'strap cutter issued to the back store');
      await s.page.click(`#rows li[data-incident="${incidentId}"] button`);
      await says(s.page, `#rows li[data-incident="${incidentId}"] .status`, /^Head office refused: u-mgr-br1 both recorded and closed this — a serious incident needs a second person/);
      expect(s.writes).toEqual([`POST /v1/facilities/incidents/${incidentId}`, `POST /v1/facilities/incidents/${incidentId}/close`]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    s = await openAs(shop, browser, OWNER, '/safety-incidents');
    try {
      await s.page.fill('#s-store', 'br-1');
      await s.page.click('#s-read');
      const row = `#rows li[data-incident="${incidentId}"]`;
      await says(s.page, row, /open · Staff injury/);
      // No corrective action is no close.
      await s.page.click(`${row} button`);
      await says(s.page, `${row} .status`, /^Head office refused: an incident closed with no corrective action/);
      await s.page.fill(`#c-action-${incidentId}`, 'strap cutter issued; staff shown how to open crates');
      await s.page.click(`${row} button`);
      await says(s.page, `#rows li[data-incident="${incidentId}"][data-open="false"]`, /closed · Staff injury.*action taken: strap cutter issued/);
      await s.page.click('#lang');
      await says(s.page, '#list-h', /^இந்தக் கடையின் நிகழ்வுகள்$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    const office = (await shop.cloud().request({ method: 'GET', path: '/v1/facilities/office?branchId=br-1', userId: OWNER })).body as { incidents: { incidentId: string; open: boolean; reportedBy: string; actionTaken: string; evidence: number }[] };
    expect(office.incidents).toEqual([expect.objectContaining({ incidentId, open: false, reportedBy: 'Meena (packer)', evidence: 2, actionTaken: 'strap cutter issued; staff shown how to open crates' })]);
  }, 240_000);
});
