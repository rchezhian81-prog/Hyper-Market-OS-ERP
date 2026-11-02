import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { openAs } from './lib/w3-page';
import { says } from './lib/r4c-box-page';

/**
 * **W3 · M31-FR-01 (hard rule #6 · §28): a document past its keeping time is disposed of on the Document retention page,
 * in a real browser, on the PRODUCTION API over real PostgreSQL.** Two notices were issued: one kept until 2020 (its time
 * is over), one until 2099. The page lists the first as "may be disposed of" and offers the act on it alone; the second is
 * kept and offers nothing. A disposal needs a reason; once recorded it is head office's fact, the notice drops off the list
 * and the count of disposed documents says one. The layout version a notice was issued under must be kept.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'retention', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Document retention (M31-FR-01) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/document-retention', html: 'document-retention.html', dataGlobal: 'documentRetentionData' },
      seed: async (cloud) => {
        // A notice layout: the owner drafts it, the br-1 manager approves it (two people, Wave 2b · PA-03).
        const drafted = await cloud.request({ method: 'POST', path: '/v1/documents/templates/notice/versions', userId: OWNER, idempotencyKey: 'tpl-draft', body: { kind: 'notification', body: 'NOTICE {{text}}', changeNote: 'first notice layout' } });
        if (drafted.status !== 201) throw new Error(`draft: ${drafted.status} ${JSON.stringify(drafted.body)}`);
        const version = (drafted.body as { version: number }).version;
        await ok(cloud.request({ method: 'POST', path: `/v1/documents/templates/notice/versions/${version}/approve`, userId: MGR, branchId: 'br-1', idempotencyKey: 'tpl-approve', body: {} }), 'approve');
        for (const [documentId, retainUntil] of [['notice-old', '2020-01-31'], ['notice-new', '2099-12-31']] as const) {
          await ok(cloud.request({ method: 'POST', path: '/v1/documents/templates/notice/issue', userId: OWNER, idempotencyKey: `issue-${documentId}`, body: { kind: 'notification', documentId, subjectRef: `notice:${documentId}`, data: { text: 'shop closed for Pongal' }, retainUntil } }), `issue ${documentId}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the manager disposes of the notice whose time is over, with a reason; the other is kept', async () => {
    const s = await openAs(shop, browser, MGR, '/document-retention', 'br-1');
    try {
      await says(s.page, '#docs li[data-document="notice-old"]', /notice-old · notification — may be disposed of/);
      await says(s.page, '#docs li[data-document="notice-new"]', /notice-new · notification — keep.*retained until 2099-12-31/);
      expect(await s.page.locator('#docs li[data-document="notice-new"] button').count(), 'nothing to dispose of while it is kept').toBe(0);
      await says(s.page, '#tpls', /notice v1 — must be kept/);
      await s.page.click('#docs li[data-document="notice-old"] button');
      await says(s.page, '#docs li[data-document="notice-old"] .status', /^Say why\.$/);
      expect(s.writes).toEqual([]);
      await s.page.fill('#why-notice-old', 'festival notice; kept the agreed three years');
      await s.page.click('#docs li[data-document="notice-old"] button');
      await says(s.page, '#docs-sum', /0 may be disposed of · 1 already disposed/);
      expect(await s.page.locator('#docs li[data-document="notice-old"]').count()).toBe(0);
      expect(s.writes).toEqual(['POST /v1/documents/notice-old/disposal']);
      await s.page.click('#lang');
      await says(s.page, '#docs-h', /^வழங்கிய ஆவணங்கள்$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const plan = (await shop.cloud().request({ method: 'GET', path: '/v1/documents/retention/documents', userId: OWNER })).body as { disposedCount: number; plan: { documentId: string }[] };
    expect(plan.disposedCount).toBe(1);
    expect(plan.plan.map((p) => p.documentId)).toEqual(['notice-new']);
    // A second disposal of the same notice is refused by head office — a disposal is decided once.
    const again = await shop.cloud().request({ method: 'POST', path: '/v1/documents/notice-old/disposal', userId: OWNER, idempotencyKey: 'again', body: { reason: 'again' } });
    expect((again.body as { error?: { code?: string } }).error?.code).toBe('disposal_refused_already_disposed');
  }, 240_000);
});
