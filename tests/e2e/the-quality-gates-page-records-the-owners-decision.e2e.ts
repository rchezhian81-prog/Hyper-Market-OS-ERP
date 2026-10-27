import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { TEST_IDP } from '../support/api-harness';
import { qg10Record } from '../../scripts/lib/release-reconcile.mjs';

/**
 * QG-12 (roadmap §22 "Every gate ends GO, HOLD or REWORK with evidence; silence is not approval"; §36; OB-288 gates lane)
 * — the Quality gates page, in a real browser, on the PRODUCTION API over real PostgreSQL:
 *
 *   • opening the page writes nothing and reads nothing until a release is chosen;
 *   • every gate of a fresh release reads "Not decided — silence is not approval" (an icon AND words), never GO;
 *   • an open HIGH container-image finding stands against QG-06 and QG-03 and is named on their rows;
 *   • the owner's GO on QG-06 is refused in head office's own words and nothing is recorded;
 *   • the owner's HOLD, with evidence and a reason, is recorded in the owner's name and shown;
 *   • the br-1 manager reads the register but is offered no decision; Tamil; after an API RESTART it all reads back;
 *   • OB-423: the QG-10 row lists the release script's own QG-10 notes — posted by the release tool's real `post-qg10`
 *     command, each computer under ITS OWN machine login — each an icon AND words (✓ all five verified / ⚠ naming what was
 *     not, with its differences), read only with the register; owner's answer (c): EVERY attempt of every release is
 *     listed, newest first, each with its outcome, box, run and attempt (two attempts of one release both shown, nothing
 *     collapsed into "latest"); they read back after the restart.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['gates', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');

const IMAGE_FINDING = {
  tool: 'trivy-image', source: 'container', runId: 'ci-e2e-1', scannedAt: '2026-10-23T08:00:00.000Z', complete: true,
  observations: [{ fingerprint: 'trivy-image|sre-api:ci|openssl|CVE-2026-0042', source: 'container', tool: 'trivy-image', ruleId: 'CVE-2026-0042', title: 'openssl 3.0.1: synthetic high vulnerability', severity: 'high', toolSeverity: 'HIGH', location: 'sre-api:ci (alpine)' }],
};

// OB-423: three release attempts' QG-10 notes — release c fully verified on the canary box; release d rolled back on the
// demo box on its first attempt, then deployed on the pipeline's re-run (attempt 2). Each computer posts with its own login.
const LOGIN_OF: Record<string, string> = { 'canary-box': 'qg10-release-canary-box', 'demo-box': 'qg10-release-demo-box' };
const NOTES = [
  qg10Record({ sha: 'c'.repeat(40), previous: 'b'.repeat(40), at: '2026-10-27T04:00:00.000Z', by: 'octocat', run: '7', attempt: '1', box: 'canary-box', outcome: 'deployed',
    checks: { health: 'verified', smoke: 'verified', reconciliation: 'verified', monitoring: 'verified', rollback: 'ready' } }),
  qg10Record({ sha: 'd'.repeat(40), previous: 'c'.repeat(40), at: '2026-10-27T05:00:00.000Z', by: 'octocat', run: '8', attempt: '1', box: 'demo-box', outcome: 'rolled_back_on_reconcile',
    checks: { health: 'verified', smoke: 'verified', reconciliation: 'failed', monitoring: 'not_run_on_this_box', rollback: 'exercised_ok' }, differences: ['the ledger held 10 event(s) before the release and holds 9 of them now — some were LOST'] }),
  qg10Record({ sha: 'd'.repeat(40), previous: 'c'.repeat(40), at: '2026-10-27T06:00:00.000Z', by: 'octocat', run: '8', attempt: '2', box: 'demo-box', outcome: 'deployed',
    checks: { health: 'verified', smoke: 'verified', reconciliation: 'verified', monitoring: 'not_run_on_this_box', rollback: 'ready' } }),
];

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Quality gates page (QG-12) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/gates', html: 'gates.html', dataGlobal: 'gatesData' },
      seed: async (cloud) => {
        await ok(cloud.request({ method: 'POST', path: '/v1/compliance/finding-scans', userId: OWNER, idempotencyKey: 'scan-1', body: { report: IMAGE_FINDING } }), 'import the image scan');
        // OB-423: ONE QG-10 machine login PER COMPUTER (granted the product's way: asked, then approved by the owner), and three
        // QG-10 notes posted by the release tool's own command with each computer's key in its file — as release.sh does.
        for (const login of Object.values(LOGIN_OF)) await cloud.grant(login, 'qg10_release_evidence');
        const dir = await mkdtemp(join(tmpdir(), 'sre-qg10-e2e-'));
        const post = async (note: (typeof NOTES)[number], login: string, i: number) => {
          const keyFile = join(dir, `qg10-push-${i}.token`);
          await writeFile(keyFile, `${TEST_IDP.issue({ sub: login, tenantId: cloud.tenantId, authTimeFromNowSeconds: null, amr: null })}\n`, { mode: 0o600 });
          const lineFile = join(dir, `line-${i}.json`);
          await writeFile(lineFile, `${JSON.stringify(note)}\n`);
          return (await promisify(execFile)('node', ['scripts/release-reconcile.mjs', 'post-qg10', '--line', lineFile, '--url', cloud.baseUrl, '--token-file', keyFile]).catch((e: { stdout: string }) => e)).stdout;
        };
        try {
          for (const [i, note] of NOTES.entries()) {
            const said = await post(note, LOGIN_OF[note.box]!, i);
            if (!said.startsWith('QG-10 note posted')) throw new Error(`QG-10 note ${i}: ${said}`);
          }
          // The demo box's login cannot post the canary box's note (one login per computer): refused, said, nothing recorded.
          const crossed = await post({ ...NOTES[0]!, attempt: '2' }, LOGIN_OF['demo-box']!, 9);
          if (!/NOT POSTED[^\n]*belongs to another computer \(HTTP 403 qg10_note_names_another_computer\)/.test(crossed)) throw new Error(`cross-computer note: ${crossed}`);
        } finally { await rm(dir, { recursive: true, force: true }); }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/v1/')) return; (r.method() === 'GET' ? reads : writes).push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/gates`, { waitUntil: 'load' });
    return { page, writes, reads, errors, close: () => context.close() };
  };
  const showRelease = async (page: Page, release: string): Promise<void> => {
    await page.selectOption('#release', release);
    await page.click('#show');
    await page.locator('#gates li.row').first().waitFor({ timeout: 15_000 });
  };
  const row = (page: Page, gate: string) => page.locator(`#gates li.row[data-gate="${gate}"]`);

  it('every gate starts "Not decided"; GO over a high finding is refused in head office\'s words; the owner\'s HOLD is recorded with its evidence', async () => {
    const s = await open(OWNER);
    try {
      expect(s.writes, 'nothing is written on open').toEqual([]);
      expect(s.reads, 'nothing is read before a release is chosen').toEqual([]);
      await showRelease(s.page, 'R5');
      expect(await s.page.locator('#gates li.row').count()).toBe(12);
      expect(await s.page.locator('#gates li.row[data-state="undecided"]').count()).toBe(12);
      expect(await row(s.page, 'QG-01').locator('.state').innerText()).toMatch(/○\s*Not decided — silence is not approval/);
      expect(await s.page.locator('#counts [data-count="undecided"]').innerText()).toMatch(/Not decided: 12/);
      // OB-423: the QG-10 row lists EVERY attempt of every release, newest first, each an icon AND words, with its outcome,
      // box, run and attempt; read only with the register.
      expect(s.reads.filter((r) => r.startsWith('GET /v1/compliance/'))).toEqual(['GET /v1/compliance/gate-register', 'GET /v1/compliance/gate-register/qg10-evidence']);
      const notes = row(s.page, 'QG-10').locator('#qg10-evidence ul.qg10-notes > li');
      await notes.nth(2).waitFor({ timeout: 15_000 });
      expect(await notes.count()).toBe(3);
      const keys = [];
      for (let i = 0; i < 3; i += 1) keys.push(`${(await notes.nth(i).getAttribute('data-release'))!.slice(0, 1)} ${await notes.nth(i).getAttribute('data-box')} ${await notes.nth(i).getAttribute('data-run')}/${await notes.nth(i).getAttribute('data-attempt')} ${await notes.nth(i).getAttribute('data-outcome')}`);
      expect(keys).toEqual(['d demo-box 8/2 deployed', 'd demo-box 8/1 rolled_back_on_reconcile', 'c canary-box 7/1 deployed']);
      // Both attempts of release d are shown in full — the re-run did not hide the first.
      const retry = await notes.nth(0).innerText();
      expect(retry).toMatch(/⚠\s*dddddddddddd · deployed · not verified: monitoring/);
      expect(retry).toMatch(/box: demo-box · run: 8 · attempt: 2 · merged by: octocat/);
      expect(await notes.nth(1).getAttribute('data-verified')).toBe('false');
      const first = await notes.nth(1).innerText();
      expect(first).toMatch(/⚠\s*dddddddddddd · rolled back — the books did not reconcile · not verified: reconciliation, monitoring/);
      expect(first).toMatch(/box: demo-box · run: 8 · attempt: 1 · merged by: octocat/);
      expect(first).toMatch(/reconciliation: failed · monitoring: not run on this box · rollback: used, and it worked/);
      expect(first).toMatch(/Difference: the ledger held 10 event\(s\) before the release and holds 9 of them now — some were LOST/);
      expect(await notes.nth(2).innerText()).toMatch(/✓\s*cccccccccccc · deployed · all five verified/);
      expect(await notes.nth(2).innerText()).toMatch(/box: canary-box · run: 7 · attempt: 1/);
      expect(await row(s.page, 'QG-10').locator('#qg10-evidence h4').innerText()).toBe('Release evidence from the release script (every attempt of every release, newest first)');
      // Evidence is never a decision: QG-10 itself still reads "Not decided".
      expect(await row(s.page, 'QG-10').getAttribute('data-state')).toBe('undecided');
      // Nobody but the release machine identity adds a note — not even the owner.
      expect((await shop.cloud().request({ method: 'POST', path: '/v1/compliance/gate-register/qg10-evidence', userId: OWNER, idempotencyKey: 'owner-note', body: { note: NOTES[0] } })).status).toBe(403);
      // The high finding stands against QG-06 and QG-03, by name.
      for (const gate of ['QG-06', 'QG-03']) expect(await row(s.page, gate).locator('.blockers').innerText()).toMatch(/Security finding — open high finding "openssl 3\.0\.1: synthetic high vulnerability"/);

      // GO on QG-06 is head office's refusal, shown in its words; nothing is recorded.
      await s.page.selectOption('#decide-gate', 'QG-06');
      await s.page.check('input[name="decision"][value="GO"]');
      await s.page.fill('#evidence-label', 'CI run');
      await s.page.fill('#evidence-ref', 'https://example.test/ci/1');
      await s.page.fill('#rationale', 'trying to pass it');
      await s.page.click('#record');
      await s.page.waitForFunction(() => /QG-06 cannot be GO while/.test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById('decide-status')?.textContent ?? ''), undefined, { timeout: 15_000 });
      expect(await s.page.textContent('#decide-status')).toMatch(/^Head office refused: QG-06 cannot be GO while 1 thing\(s\) block it: open high finding/);
      expect((await shop.cloud().request({ method: 'GET', path: '/v1/compliance/gate-decisions/QG-06/R5', userId: OWNER })).body).toMatchObject({ count: 0 });

      // No evidence → refused on the screen, nothing sent.
      const before = s.writes.length;
      await s.page.check('input[name="decision"][value="HOLD"]');
      await s.page.fill('#evidence-ref', '');
      await s.page.click('#record');
      expect(await s.page.textContent('#decide-status')).toBe('A decision needs evidence: say what it is and where to find it.');
      expect(s.writes.length).toBe(before);

      // HOLD with evidence and a reason: recorded in the owner's name.
      await s.page.fill('#evidence-label', 'Container scan: one open high finding');
      await s.page.fill('#evidence-ref', 'scan-reports-security/trivy-image.findings.json');
      await s.page.fill('#rationale', 'Hold until the image is rebuilt and the scan is clean');
      await s.page.click('#record');
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(x: string): { getAttribute(a: string): string | null } | null } }).document.querySelector('#gates li.row[data-gate="QG-06"]')?.getAttribute('data-state') === 'HOLD', undefined, { timeout: 15_000 });
      expect(await s.page.textContent('#decide-status')).toBe('✓ Recorded at head office, in your name.');
      const q6 = await row(s.page, 'QG-06').innerText();
      expect(q6).toMatch(/⏸\s*HOLD — waiting/);
      expect(q6).toMatch(/Decided by: u-owner/);
      expect(q6).toMatch(/Evidence: Container scan: one open high finding — scan-reports-security\/trivy-image\.findings\.json/);
      expect(s.writes.filter((w) => w.startsWith('POST /v1/compliance/gate-decisions/QG-06/R5'))).toHaveLength(2); // the refused GO and the HOLD
      // Tamil.
      await s.page.click('#lang');
      expect(await row(s.page, 'QG-01').locator('.state').innerText()).toMatch(/முடிவு இல்லை — மௌனம் ஒப்புதல் அல்ல/);
      await s.page.locator('#qg10-evidence h4', { hasText: 'வெளியீட்டு நிரலின் சான்று' }).waitFor({ timeout: 15_000 });
      expect(await row(s.page, 'QG-10').locator('ul.qg10-notes > li').nth(1).innerText()).toMatch(/சரிபார்க்கப்படாதவை: கணக்குச் சரிபார்ப்பு, கண்காணிப்பு/);
      expect(await row(s.page, 'QG-10').locator('ul.qg10-notes > li').nth(0).innerText()).toMatch(/முயற்சி: 2/);
      expect(await s.page.textContent('#page-h')).toBe('தர வாயில்கள்');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('the manager reads the register but is offered no decision; after an API restart the owner\'s HOLD reads back', async () => {
    let s = await open(MGR);
    try {
      await showRelease(s.page, 'R5');
      expect(await s.page.locator('#decide-form').isHidden()).toBe(true);
      expect(await s.page.textContent('#decide-not')).toBe('Deciding a gate is the owner\'s — you can read the register.');
      // The manager reads the QG-10 notes too (the register's read right) — and cannot add one.
      await row(s.page, 'QG-10').locator('ul.qg10-notes > li').nth(2).waitFor({ timeout: 15_000 });
      expect((await shop.cloud().request({ method: 'POST', path: '/v1/compliance/gate-register/qg10-evidence', userId: MGR, branchId: 'br-1', idempotencyKey: 'mgr-note', body: { note: NOTES[0] } })).status).toBe(403);
      expect((await shop.cloud().request({ method: 'POST', path: '/v1/compliance/gate-decisions/QG-01/R5', userId: MGR, idempotencyKey: 'mgr-try', body: { decision: 'GO', evidence: [{ label: 'x', ref: 'y' }], rationale: 'z' } })).status).toBe(403);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    await shop.restart();
    s = await open(OWNER);
    try {
      await showRelease(s.page, 'R5');
      expect(await row(s.page, 'QG-06').getAttribute('data-state')).toBe('HOLD');
      expect(await s.page.locator('#gates li.row[data-state="undecided"]').count()).toBe(11);
      // OB-423: every attempt's note reads back after the restart — all three, nothing collapsed.
      await row(s.page, 'QG-10').locator('ul.qg10-notes > li').nth(2).waitFor({ timeout: 15_000 });
      expect(await row(s.page, 'QG-10').locator('ul.qg10-notes > li').count()).toBe(3);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);
});
