import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { TEST_IDP } from '../support/api-harness';

/**
 * **W7 · QG-01 ("No build without approved ID, rules, actors, errors, permissions and testable acceptance", roadmap §22) — the
 * requirement-records reading on the Quality gates page, in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * The CI's own reading step (scripts/requirement-records-reading.mts — the guardrail's check, packages/compliance/src/
 * requirement-records.ts) is RUN here for real, and its report is sent by the CI's own push step (scripts/push-findings.mjs)
 * under the CI scanner's machine identity (OB-331), exactly as the build does:
 *   • with no reading on file, the QG-01 row says NOT KNOWN and the gate is held by that check, by name;
 *   • a reading that could not read every record (a requirement file missing) is NOT KNOWN too;
 *   • a reading of a copy in which one record has lost its acceptance criteria names that record on the QG-01 row and holds
 *     the gate by an open finding; the owner's GO on QG-01 is refused in head office's own words and nothing is recorded;
 *   • a complete reading of the repository's real records (all 144 complete) clears what held it — and the row still says
 *     it is evidence for the owner's decision, NOT the decision: QG-01 reads "Not decided — silence is not approval";
 *   • Tamil. Synthetic data only. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w7', 'qg01', 'e2e', 'key'].join('-').padEnd(48, '0');
const CI = 'ci-scanner-w7';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('QG-01: the requirement-records reading on the Quality gates page, connected on PostgreSQL', () => {
  let browser: Browser;
  let shop: InboxShop;
  let dir = '';

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/gates', html: 'gates.html', dataGlobal: 'gatesData' },
      seed: async (cloud) => { await cloud.grant(CI, 'findings_push'); },
    });
    dir = await mkdtemp(join(tmpdir(), 'sre-w7-qg01-'));
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); if (dir !== '') await rm(dir, { recursive: true, force: true }); });

  /** The build's two steps, for real: read the records in `records` with the guardrail's check, then push the report. */
  const ciReads = async (records: string, name: string): Promise<string> => {
    const reports = join(dir, `reports-${name}`);
    // The run is told nothing about GitHub (a local run id each time), whatever environment this test runs in.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_')));
    const read = await promisify(execFile)('node', ['--experimental-strip-types', 'scripts/requirement-records-reading.mts', '--dir', records, '--out', join(reports, 'requirement-records.findings.json')], { env });
    const token = TEST_IDP.issue({ sub: CI, tenantId: shop.cloud().tenantId, authTimeFromNowSeconds: null, amr: null });
    const pushed = await promisify(execFile)('node', ['scripts/push-findings.mjs', reports], { env: { ...env, FINDINGS_PUSH_TOKEN: token, FINDINGS_REGISTER_URL: shop.cloud().baseUrl } });
    expect(pushed.stdout).toContain('findings push: 1 of 1 report(s) on the register');
    expect(pushed.stdout).not.toContain(token);
    return read.stdout;
  };
  const copyOfTheRecords = async (name: string): Promise<string> => { const to = join(dir, name); await cp('docs/requirements', to, { recursive: true }); return to; };

  const open = async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}/gates`, { waitUntil: 'load' });
    await page.selectOption('#release', 'R1');
    await page.click('#show');
    await page.locator('#gates li.row').first().waitFor({ timeout: 15_000 });
    return { page, errors, close: () => context.close() };
  };
  const qg01 = (page: Page) => page.locator('#gates li.row[data-gate="QG-01"]');
  const standing = async (page: Page, want: string): Promise<string> => {
    await page.locator(`#qg01-reading[data-qg01="${want}"]`).waitFor({ timeout: 15_000 });
    return page.locator('#qg01-reading').innerText();
  };

  it('no reading → NOT KNOWN; a short reading → NOT KNOWN; a record missing a field holds the gate and GO is refused; a clean reading is evidence, never "passed"', async () => {
    // ── Nothing on file: NOT KNOWN, and the gate is held by that check.
    let s = await open();
    try {
      expect(await standing(s.page, 'not_known')).toMatch(/⚠\s*NOT KNOWN — no reading of the requirement records is on file\./);
      expect(await qg01(s.page).locator('.blockers').innerText()).toMatch(/Check — the requirement records are NOT KNOWN — no reading of them is on file/);
      expect(await qg01(s.page).getAttribute('data-state')).toBe('undecided');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── A reading that could not read every record (the last module's file is not there): NOT KNOWN. (Files and records are
    //    found, not named, so this gate test cites no module requirement itself.)
    const modules = (await readdir('docs/requirements')).filter((n) => /^M\d\d\.md$/.test(n)).sort();
    const short = await copyOfTheRecords('short');
    await rm(join(short, modules.at(-1)!));
    expect(await ciReads(short, 'short')).toMatch(/read 140 requirement records .* where 144 are expected — the reading is not complete/);
    s = await open();
    try {
      const said = await standing(s.page, 'not_known');
      expect(said).toMatch(/NOT KNOWN — the latest reading could not read every requirement record\./);
      expect(said).toMatch(/read 140 requirement records/);
      expect(await qg01(s.page).locator('.blockers').innerText()).toMatch(/the requirement records are NOT KNOWN — the latest reading \(.+\) could not read every record/);
    } finally { await s.close(); }

    // ── A copy in which the first record has lost its acceptance criteria: the record is named, the gate held; GO refused.
    const broken = await copyOfTheRecords('broken');
    const FILE = modules[0]!;
    const m01 = await readFile(join(broken, FILE), 'utf8');
    const ids = [...m01.matchAll(/^## (M\d\d-FR-\d\d)/gm)].map((m) => m[1]!);
    const ID = ids[0]!;
    const head = m01.indexOf(`## ${ID}`); const next = m01.indexOf(`## ${ids[1]!}`);
    const fr01 = m01.slice(head, next).replace(/\*\*Acceptance(?: criteria)?[^*\n]{0,40}:\*\*/i, '');
    expect(fr01).not.toBe(m01.slice(head, next));
    await writeFile(join(broken, FILE), m01.slice(0, head) + fr01 + m01.slice(next));
    expect(await ciReads(broken, 'broken')).toContain(`1 of 144 records are missing a field: ${ID} (acceptance criteria)`);
    s = await open();
    try {
      const said = await standing(s.page, 'failing');
      expect(said).toMatch(/⚠\s*Requirement records missing a field: 1/);
      expect(said).toContain(`QG-01: ${ID} is missing acceptance criteria — docs/requirements/${FILE} ${ID}`);
      expect(said).toContain('QG-01 holds until a complete reading finds nothing missing.');
      expect(await qg01(s.page).locator('.blockers').innerText()).toContain(`Security finding — open high finding "QG-01: ${ID} is missing acceptance criteria"`);
      // It is a QG-01 matter only — not QG-03's.
      expect(await s.page.locator('#gates li.row[data-gate="QG-03"] .blockers').innerText()).not.toContain(ID);
      await s.page.selectOption('#decide-gate', 'QG-01');
      await s.page.check('input[name="decision"][value="GO"]');
      await s.page.fill('#evidence-label', 'Requirement records reading');
      await s.page.fill('#evidence-ref', 'scan-reports-security/requirement-records.findings.json');
      await s.page.fill('#rationale', 'trying to pass it');
      await s.page.click('#record');
      await s.page.locator('#decide-status', { hasText: 'QG-01 cannot be GO while' }).waitFor({ timeout: 15_000 });
      expect(await s.page.textContent('#decide-status')).toMatch(new RegExp(`^Head office refused: QG-01 cannot be GO while 1 thing\\(s\\) block it: open high finding "QG-01: ${ID} is missing acceptance criteria"`));
      expect((await shop.cloud().request({ method: 'GET', path: '/v1/compliance/gate-decisions/QG-01/R1', userId: OWNER })).body).toMatchObject({ count: 0 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The repository's real records, read complete: what held QG-01 is cleared — and it is still NOT passed.
    expect(await ciReads('docs/requirements', 'clean')).toContain('all 144 module requirement records carry actors, rules, error flow, permissions and acceptance');
    s = await open();
    try {
      const said = await standing(s.page, 'check_clean');
      expect(said).toMatch(/✓\s*The latest reading found all 144 records complete\./);
      expect(said).toContain('This is evidence for the owner\'s QG-01 decision, not the decision — the gate is not passed until he records it with his signed review.');
      expect(said).toMatch(/Latest reading: \d{4}-\d{2}-\d{2} \d{2}:\d{2} · run: local-/);
      expect(await qg01(s.page).innerText()).toContain('Nothing blocks this gate now.');
      expect(await qg01(s.page).getAttribute('data-state')).toBe('undecided');
      expect(await qg01(s.page).locator('.state').innerText()).toMatch(/Not decided — silence is not approval/);
      const findings = (await shop.cloud().request({ method: 'GET', path: '/v1/compliance/findings', userId: OWNER })).body as { findings: { tool: string; status: string }[] };
      expect(findings.findings.filter((f) => f.tool === 'requirement-records').map((f) => f.status)).toEqual(['fixed']); // closed by the reading, never by hand
      await s.page.click('#lang');
      await s.page.locator('#qg01-reading h4', { hasText: 'தேவைப் பதிவுகள்' }).waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#qg01-reading').innerText()).toContain('முடிவு அல்ல');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 240_000);
});
