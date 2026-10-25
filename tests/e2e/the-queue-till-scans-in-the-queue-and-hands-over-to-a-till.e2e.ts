import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { readLog } from '../../edge/store-edge/src/file-log';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { prepareTillBox, signInThroughScreen, pinOf } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';

/**
 * **D04-FR-05 mobile POS and queue-busting, in a real Chromium on a low-spec phone's screen (360 × 640, touch): a member of
 * staff enrols the handheld, signs in with their own till PIN, scans in the queue — the till's own gates ask the age
 * question — hands the basket to a till by a four-digit code, and takes a card payment; the fixed till keys the code and
 * rings the lines through its own pack, asking the age again itself.** English and Tamil; every control at least 56 px;
 * the WCAG audit on each view. The till's change is one entry under More, shown only while its lane's switch is on.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['queue', 'till', 'e2e', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const DAL = '8901234567890';
const CIG = '8900000000110';
const ENROL = 'QUEUE-TILL1-ENROL-CODE1';
const HANDHELD = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 3, builtAt: new Date().toISOString(),
    products: [
      { productId: 'P-DAL', sku: 'DAL-1', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 120_00, taxBps: 500, status: 'active' },
      { productId: 'P-CIG', sku: 'CIG-PACK', name: 'Cigarettes 10s (demo)', baseUom: 'ea', unitPriceMinor: 180_00, taxBps: 2800, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 1, minimumAge: 18 } },
    ],
    barcodes: [{ code: DAL, productId: 'P-DAL', kind: 'standard' }, { code: CIG, productId: 'P-CIG', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface QueueWindow { readonly queueSession?: { ready: Promise<boolean>; till: { basket(): { productId: string }[]; payableMinor(): number } } }
interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; payableMinor(): number; basket(): { productId: string }[] } }

describe.skipIf(!existsSync(CHROMIUM))('the queue till scans in the queue and hands the basket to a till (D04-FR-05)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'queue-pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const choose = async (page: Page, label: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden]) #choices button');
    await page.locator("#choices button", { hasText: label }).first().click();
  };
  const banner = async (page: Page): Promise<{ title: string; text: string; bill: string }> => {
    await page.waitForSelector('#banner:not([hidden])');
    const out = { title: (await page.textContent('#banner-title')) ?? '', text: (await page.textContent('#banner-text')) ?? '', bill: (await page.textContent('#banner-bill')) ?? '' };
    await page.click('#banner-ok');
    return out;
  };
  const audit = (page: Page, expectLang = 'en') => auditPage(page, { minTarget: 56, expectLang });

  it('enrol, sign in for selling, scan (the age asked), hand over by code, pay by card; the till rings the code; Tamil; 56 px', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-queue-till-e2e-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({
        dir, key: KEY,
        people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-ravi', displayName: 'Ravi' }],
        pack: {
          version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' }, lossPreventionRules: [],
          devices: [{ deviceId: 'hh-q1', kind: 'handheld', status: 'registered', label: 'Queue till 1', enrolment: { codeHash: enrolmentCodeHash(ENROL), expiresAt: '2099-01-01T00:00:00.000Z' } }],
          rollout: { format: 'sre-rollout/1', branchId: 'store-1', switches: [
            { key: 'pos.queue_busting', branch: null, lanes: [{ laneId: 'lane-1', enabled: true, version: 1 }] },
            { key: 'payments.mobile_pos', branch: { enabled: true, version: 1 }, lanes: [] },
          ] },
        },
      }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const dev = `http://127.0.0.1:${edge.devices!.port}`;

    // ── The handheld: not enrolled → the enrolment page, then straight to the queue till's sign-in.
    const phone = await browser.newContext(HANDHELD);
    stops.push(() => phone.close());
    const page = await phone.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${dev}/queue-pos/`, { waitUntil: 'load' });
    expect(page.url()).toContain('/device/enrol');
    await page.fill('#deviceId', 'hh-q1');
    await page.fill('#code', ENROL);
    await page.click('button[type=submit]');
    await page.waitForURL(/\/queue-pos\/sign-in$/);
    expect(await page.textContent('h1')).toMatch(/Sign in on this handheld/);
    await page.fill('input[name=staffId]', 'u-ravi');
    await page.fill('input[name=pin]', pinOf('u-ravi'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/queue-pos\/$/);
    await page.waitForFunction(async () => (await (globalThis as unknown as QueueWindow).queueSession?.ready) === true, undefined, { timeout: 15_000 });
    await page.waitForFunction(() => /Ravi/.test((globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById('who').textContent));
    expect(await page.isVisible('#card')).toBe(true);
    expect(await audit(page), 'the empty basket').toEqual([]);
    // Every control the staff member taps is at least 56 px tall.
    for (const id of ['key', 'waiting', 'card', 'upi', 'handover', 'lang']) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect([id, (box?.height ?? 0) >= 56]).toEqual([id, true]);
    }

    // ── Scan in the queue: the till's own pack prices it; the tobacco line waits for the age question.
    await page.keyboard.type(DAL); await page.keyboard.press('Enter');
    await page.waitForSelector('#lines .line');
    expect(await page.textContent('#total')).toBe('₹120.00');
    await page.keyboard.type(CIG); await page.keyboard.press('Enter');
    await page.waitForSelector('#sheet:not([hidden]) #choices button');
    expect(await page.textContent('#sheet-title')).toMatch(/Cigarettes 10s \(demo\) is age restricted/);
    expect(await audit(page), 'the age question').toEqual([]);
    await choose(page, 'Yes — 18 or over');
    await page.waitForFunction(() => (globalThis as unknown as QueueWindow).queueSession!.till.basket().length === 2);
    expect(await page.textContent('#total')).toBe('₹300.00');

    // ── Tamil, every word.
    await page.click('#lang');
    expect(await page.textContent('#handover')).toBe('பில்லிங்குக்கு ஒப்படை');
    expect(await audit(page, 'ta'), 'Tamil').toEqual([]);
    await page.click('#lang');

    // ── Hand it to a till: the four digits, as big as the screen allows.
    await page.click('#handover');
    await page.waitForSelector('#handed:not([hidden])');
    const code = (await page.textContent('#handed-code')) ?? '';
    expect(code).toMatch(/^\d{4}$/);
    expect(await audit(page), 'the hand-over code').toEqual([]);
    await page.click('#handed-next');
    expect(await page.isVisible('#empty')).toBe(true);

    // ── The next customer pays on the handheld: card, the machine approved, the bill on the screen.
    await page.keyboard.type(DAL); await page.keyboard.press('Enter');
    await page.waitForSelector('#lines .line');
    await page.click('#card');
    await choose(page, 'Approved');
    const paid = await banner(page);
    expect(paid.title).toMatch(/^Paid — Card — /);
    expect(paid.bill).toMatch(/Toor dal 1kg/);
    // OB-373: no printer on the handheld — it says where the paper bill is printed, with the bill's number.
    const billNumber = paid.title.replace(/^Paid — Card — /, '').trim();
    expect(paid.text).toBe(`Ask at a till or the service desk to print this bill: bill number ${billNumber}. This handheld does not print.`);
    const sold = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { laneId: string; cashierId: string; total: number }] : []));
    expect(sold).toEqual([expect.objectContaining({ laneId: 'device:hh-q1', cashierId: 'u-ravi', total: 120_00 })]);
    expect(errors).toEqual([]);

    // ── The fixed till: More → Handheld basket → the code → rung through ITS pack; it asks the age itself.
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => desk.close());
    const till = await desk.newPage();
    await till.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await till.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(till);
    // The till's one new entry, in Tamil too.
    await till.click('#lang');
    await till.click('#more');
    await till.waitForSelector('#pay:not([hidden])');
    expect(await till.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''))).toContain('கருவிக் கூடை (வரிசை)');
    await till.click('#pay-cancel');
    await till.click('#lang');
    await till.click('#more');
    await till.waitForSelector('#pay:not([hidden])');
    expect(await till.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''))).toContain('Handheld basket (queue)');
    await till.click('#pay-kinds button:text-is("Handheld basket (queue)")');
    await till.waitForSelector('#sheet:not([hidden])');
    for (const digit of code) await till.click(`#keypad button:text-is("${digit}")`);
    await till.click('#sheet-ok');
    await till.waitForSelector('#refusal:not([hidden])');
    expect(await till.textContent('#refusal-text')).toBe(`Handheld basket ${code}: 1 line(s) rung; 1 need the cashier — scan or ask about each one.`);
    expect(await till.locator('#refusal').innerText()).toMatch(/Cigarettes 10s \(demo\)/);
    await till.click('#refusal-ok');
    expect(await till.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().map((l) => l.productId))).toEqual(['P-DAL']);

    // ── OB-373: the till prints the handheld's bill by its number — a copy, recorded on the store computer first ──
    const copyOf = async (typed: string): Promise<{ title: string; text: string; slip: string }> => {
      await till.click('#more');
      await till.waitForSelector('#pay:not([hidden])');
      await till.click('#pay-kinds button:text-is("Print a copy of a bill by its number")');
      await till.waitForSelector('#entry-text:not([hidden])');
      await till.fill('#entry-text', typed);
      await till.click('#sheet-ok');
      await till.waitForSelector('#pay:not([hidden])');
      expect(await audit(till), 'why a copy').toEqual([]);
      await till.click('#pay-kinds button:text-is("Paid on a handheld queue till")');
      await till.waitForSelector('#refusal:not([hidden])');
      const out = { title: (await till.textContent('#refusal-title')) ?? '', text: (await till.textContent('#refusal-text')) ?? '', slip: (await till.textContent('#refusal-receipt')) ?? '' };
      return out;
    };
    const copy = await copyOf(billNumber);
    expect(copy.title).toBe(`Copy 1 of bill ${billNumber}`);
    expect(copy.text).toBe('This bill was taken on handheld hh-q1. It prints marked as a copy.');
    expect(copy.slip).toMatch(/\*\*\* REPRINT \*\*\*[\s\S]*Paid on a handheld queue till — Copy 1[\s\S]*Toor dal 1kg/);
    expect(await audit(till), 'the copy').toEqual([]);
    await till.click('#refusal-ok');
    const copies = (await readLog(join(dir, 'device-events.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : [])).filter((e) => e.type === 'BillCopyPrinted');
    expect(copies.map((e) => [e.payload['billNumber'], e.payload['copyNumber'], e.payload['billLaneId']])).toEqual([[billNumber, 1, 'device:hh-q1']]);
    // A number this store computer does not hold: said, nothing printed — in Tamil too.
    await till.click('#lang');
    await till.click('#more');
    await till.waitForSelector('#pay:not([hidden])');
    expect(await till.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''))).toContain('பில் எண் மூலம் பில்லின் நகலை அச்சிடு');
    await till.click('#pay-cancel');
    await till.click('#lang');
    const missing = await copyOf('NO-SUCH-9');
    expect(missing.text).toMatch(/^Bill NO-SUCH-9 is not on this store computer\./);
    await till.click('#refusal-ok');
    expect(errors).toEqual([]);
  }, 120_000);

  it('switched off (nobody set it, OB-316): the handheld page says so in both languages and the till offers no entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-queue-till-off-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({
        dir, key: KEY,
        pack: {
          version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' }, lossPreventionRules: [],
          devices: [{ deviceId: 'hh-q1', kind: 'handheld', status: 'registered', label: 'Queue till 1', enrolment: { codeHash: enrolmentCodeHash(ENROL), expiresAt: '2099-01-01T00:00:00.000Z' } }],
        },
      }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const phone = await browser.newContext(HANDHELD);
    stops.push(() => phone.close());
    const page = await phone.newPage();
    await page.goto(`http://127.0.0.1:${edge.devices!.port}/queue-pos/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-q1');
    await page.fill('#code', ENROL);
    await page.click('button[type=submit]');
    await page.waitForSelector('[data-queue-pos-off]');
    expect(await page.textContent('[data-queue-pos-off]')).toMatch(/Queue-busting is switched off[\s\S]*அணைக்கப்பட்டுள்ளது/);
    expect(await audit(page), 'the off page').toEqual([]);

    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => desk.close());
    const till = await desk.newPage();
    await till.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await till.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(till);
    await till.click('#more');
    await till.waitForSelector('#pay:not([hidden])');
    expect(await till.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''))).not.toContain('Handheld basket (queue)');
  }, 120_000);
});
