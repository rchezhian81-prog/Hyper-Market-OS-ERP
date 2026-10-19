import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeHeldAssignmentsFeed } from '../../edge/store-edge/src/assignments-feed-file';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { withTillPeople, issueTillPins } from '../support/till-operator';
import { signInOnPhonePage } from '../support/phone-sign-in-page';
import { auditPage } from './lib/a11y-audit';

/**
 * **R4 · WF-16 (signed, OB-227) — an online return after delivery is COLLECTED BY THE DRIVER on his phone, at a phone's
 * width (360px), in English and Tamil.**
 *
 * Everything below the browser is production: the real `startEdge` serves the real driver shell over its DEVICE socket with
 * the route head office assigned — its delivery stop AND its booked return collections (the box restored them from its disk,
 * as it does after a reboot with the cable out). A REAL headless Chromium:
 *
 *   • enrols, signs in as the driver (OB-180 / OB-187), and sees "Returns to collect" with each return's area, references,
 *     booked lines and a "To collect" chip — and the words that no money changes hands at the door;
 *   • at the first return, tries to record MORE than was booked: the keypad says so as he types, and the phone refuses it BY
 *     NAME ("More than was booked") — nothing is queued;
 *   • records what he took (1 of 2 milk, 0 of 1 bread): "Collected", queued under his sign-in, handed to the box (its
 *     fsync'd log holds one `ReturnCollectionRecorded`, naming the driver and no customer, with no money in it);
 *   • at the second return, nobody is in: "Not collected · Customer not available", queued the same way;
 *   • in Tamil every word of the section changes; the accessibility audit is clean at 360px in both languages;
 *   • reloads: the collected return is still "Collected" (the durable phone queue decides) and nothing is sent twice.
 *
 * Head office's re-checks are proven in `tests/integration/the-driver-collects-an-online-return-through-the-box.test.ts`.
 * Synthetic data only. No physical device: PENDING (SP-10).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['driver', 'returns', 'browser', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const PHONE = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const TARGET = 56;
const SHOTS = '/tmp/claude-0/-home-user-Hyper-Market-OS-ERP/dd60fb69-cb30-56fe-be36-e296ef065642/scratchpad/ui-shots';
const SHOT_TAG = process.env['SHOT_TAG'] ?? 'after';

const PHONE_PERSON = 'u-driver';
const PACK_JSON = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privilegedActions: [] },
  lossPreventionRules: [],
  products: [
    { productId: 'MILK', name: 'Aavin Milk 1L', nameTa: 'ஆவின் பால் 1லி', categoryId: 'dairy', unitPriceMinor: 60_00, uom: 'each', barcodes: ['8901234567891'], status: 'active' },
    { productId: 'BREAD', name: 'Bread 400g', nameTa: 'ரொட்டி 400கி', categoryId: 'bakery', unitPriceMinor: 40_00, uom: 'each', barcodes: ['8901234567892'], status: 'active' },
  ],
  devices: [{ deviceId: 'hh-03', kind: 'handheld', status: 'registered', label: 'Van phone', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, [{ userId: PHONE_PERSON, permissions: ['delivery.attempt.record'] }]));

/** Head office's open assignments for the store, as the box last pulled them: a stop AND two booked return collections. */
const FEED = {
  asAt: '2026-10-19T06:00:00.000Z', storeId: 'store-1', waves: [],
  routes: [{
    routeId: 'R-7', driverId: PHONE_PERSON, assignedBy: 'u-owner', assignedAt: '2026-10-19T05:59:00.000Z',
    stops: [{ stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar', codMinor: 0 }],
    collections: [
      { returnId: 'RET-1', orderRef: 'ORD-0990', area: 'Gandhipuram', collectOn: '2026-10-19', lines: [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'BREAD', quantityMinor: 1 }] },
      { returnId: 'RET-2', orderRef: 'ORD-0991', area: 'RS Puram', collectOn: '2026-10-19', lines: [{ productId: 'MILK', quantityMinor: 1 }] },
    ],
  }],
};

interface PhoneWindow {
  readonly routeSession?: { sentWork(): { kind: string; id: string; state: string; detail: string }[]; collections(): { returnId: string; state: string }[] };
  readonly driverRelay?: unknown;
  readonly laneWriteBase?: string;
  readonly location: { pathname: string };
}

describe.skipIf(!HAVE_BROWSER)('WF-16 — the driver collects an online return on his phone, at 360px, in English and Tamil', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'delivery-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    mkdirSync(SHOTS, { recursive: true });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-driver-returns-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    await issueTillPins(dir, KEY, [PHONE_PERSON]);
    await writeHeldAssignmentsFeed(dir, { tenantId: TENANT, feed: FEED, receivedAt: '2026-10-19T06:00:05.000Z' });
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return { edge, base: `http://127.0.0.1:${edge.devices!.port}` };
  }

  async function phone(base: string): Promise<Page> {
    const context = await browser.newContext(PHONE);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}/driver/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-03');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'driver', PHONE_PERSON);
    await page.waitForFunction(() => { const w = globalThis as unknown as PhoneWindow; return w.routeSession !== undefined && w.driverRelay !== undefined && w.laneWriteBase === ''; }, undefined, { timeout: 15_000 });
    return page;
  }
  /** The route scrolls inside `main`; the picture is taken on a taller phone (still 360 wide) so the section is in it. */
  const shoot = async (page: Page, name: string): Promise<void> => {
    await page.setViewportSize({ width: 360, height: 1280 });
    await page.screenshot({ path: join(SHOTS, `gap-driver-${SHOT_TAG}-${name}.png`) });
    await page.setViewportSize(PHONE.viewport);
  };
  const card = (id: string) => `#collections .pickup[data-return-id="${id}"]`;
  const sentCollections = (page: Page) => page.evaluate(() => (globalThis as unknown as PhoneWindow).routeSession!.sentWork().filter((w) => w.kind === 'collection').map((w) => [w.id, w.state, w.detail]));
  const audit = (page: Page, lang: 'en' | 'ta') => auditPage(page, { minTarget: TARGET, expectLang: lang });

  it('lists the booked collections; more than booked is refused by name; collected and not-collected are queued and handed to the box; Tamil; reload keeps them', async () => {
    const { edge, base } = await box();
    const page = await phone(base);
    await shoot(page, 'en-route');

    // The section: the heading, the no-money words, a card per booked return with its lines named from the catalogue.
    await page.waitForSelector(card('RET-1'));
    expect((await page.textContent('#returns-heading'))?.trim()).toBe('Returns to collect');
    expect(await page.textContent('#returns-note')).toContain('No money changes hands at the door');
    expect(await page.textContent(`${card('RET-1')} .area`)).toBe('Gandhipuram');
    expect(await page.textContent(`${card('RET-1')} .order`)).toBe('RET-1 · ORD-0990 · Booked for 2026-10-19');
    expect(await page.textContent(`${card('RET-1')} .lines`)).toBe('2 × Aavin Milk 1L · 1 × Bread 400g');
    expect(await page.textContent(`${card('RET-1')} .state`)).toBe('To collect');
    expect(await audit(page, 'en')).toEqual([]);

    // MORE THAN BOOKED: 3 milk where 2 were booked — said while typing, then refused by name; nothing is queued.
    await page.click(card('RET-1'));
    await page.waitForSelector('#choices:not([hidden])');
    await page.click('#choices button:has-text("Collected — record what I took")');
    await page.waitForSelector('#keypad:not([hidden])');
    expect(await page.textContent('#sheet-title')).toBe('How many did you take of Aavin Milk 1L?');
    expect(await page.textContent('#entry')).toBe('2');
    await page.click('#keypad button:has-text("C")');
    await page.click('#keypad button:text-is("3")');
    expect(await page.textContent('#entry-hint')).toBe('More than was booked — this cannot be recorded.');
    await shoot(page, 'en-over');
    await page.click('#sheet-ok');
    await page.waitForSelector('#keypad:not([hidden])'); // the bread line is asked next
    await page.click('#sheet-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Not recorded');
    expect(await page.textContent('#banner-text')).toBe('More than was booked — this cannot be recorded. (MILK: collected 3, but 2 was booked for collection)');
    await page.click('#banner-ok');
    expect(await sentCollections(page)).toEqual([]);
    expect(await page.textContent(`${card('RET-1')} .state`)).toBe('To collect');

    // COLLECTED: 1 of 2 milk, none of the bread.
    await page.click(card('RET-1'));
    await page.click('#choices button:has-text("Collected — record what I took")');
    await page.waitForSelector('#keypad:not([hidden])');
    await page.click('#keypad button:has-text("C")');
    await page.click('#keypad button:text-is("1")');
    await page.click('#sheet-ok');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#sheet-title')?.textContent === 'How many did you take of Bread 400g?', undefined, { timeout: 5_000 });
    await page.click('#keypad button:has-text("C")');
    await page.click('#sheet-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Recorded as collected');
    expect(await page.textContent('#banner-text')).toBe('Gandhipuram · 1 × Aavin Milk 1L');
    await page.click('#banner-ok');
    expect(await page.textContent(`${card('RET-1')} .state`)).toBe('Collected');
    expect(await page.textContent(`${card('RET-1')} .lines`)).toBe('1 / 2 × Aavin Milk 1L · 0 / 1 × Bread 400g');

    // NOT COLLECTED: nobody in at the second return.
    await page.click(card('RET-2'));
    await page.click('#choices button:has-text("Not collected")');
    await page.waitForSelector('#choices button:has-text("Customer not available")');
    await page.click('#choices button:has-text("Customer not available")');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Recorded as not collected');
    await page.click('#banner-ok');
    expect(await page.textContent(`${card('RET-2')} .state`)).toBe('Not collected · Customer not available');

    // Both are with the store computer, on its fsync'd log — naming the driver, no customer, no money.
    await page.waitForFunction(() => { const s = (globalThis as unknown as PhoneWindow).routeSession!.sentWork().filter((w) => w.kind === 'collection'); return s.length === 2 && s.every((w) => w.state === 'handed_to_box'); }, undefined, { timeout: 15_000 });
    await page.waitForSelector('#sent-work .sent[data-kind="collection"][data-id="RET-1"][data-state="handed_to_box"]');
    expect(await page.textContent('#sent-work .sent[data-id="RET-1"] .what')).toBe('Return collection · Gandhipuram · RET-1 — collected 1 × MILK');
    expect(await page.textContent('#sent-work .sent[data-id="RET-2"] .what')).toBe('Return collection · RS Puram · RET-2 — not collected · customer_not_available');
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; idempotencyKey: string; payload: Record<string, unknown> });
    expect(records.map((r) => [r.type, r.idempotencyKey])).toEqual([
      ['ReturnCollectionRecorded', 'return-collection:R-7:RET-1:collected'],
      ['ReturnCollectionRecorded', 'return-collection:R-7:RET-2:not_collected:1'],
    ]);
    expect(records[0]!.payload).toMatchObject({ returnId: 'RET-1', routeId: 'R-7', driverId: PHONE_PERSON, outcome: 'collected', lines: [{ productId: 'MILK', collectedMinor: 1 }, { productId: 'BREAD', collectedMinor: 0 }] });
    expect(records[1]!.payload).toMatchObject({ returnId: 'RET-2', outcome: 'not_collected', reason: 'customer_not_available' });
    expect(JSON.stringify(records.map((r) => r.payload))).not.toMatch(/cod|cash|refund|amount|customerRef/i);
    expect(await audit(page, 'en')).toEqual([]);
    await shoot(page, 'en-recorded');

    // TAMIL: every word of the section.
    await page.click('#lang');
    expect((await page.textContent('#returns-heading'))?.trim()).toBe('திரும்பப் பெற வேண்டியவை');
    expect(await page.textContent('#returns-note')).toContain('வாசலில் பணம்');
    expect(await page.textContent(`${card('RET-1')} .state`)).toBe('எடுக்கப்பட்டது');
    expect(await page.textContent(`${card('RET-1')} .lines`)).toBe('1 / 2 × ஆவின் பால் 1லி · 0 / 1 × ரொட்டி 400கி');
    expect(await page.textContent(`${card('RET-2')} .state`)).toBe('எடுக்கப்படவில்லை · வாடிக்கையாளர் இல்லை');
    expect(await audit(page, 'ta')).toEqual([]);
    await shoot(page, 'ta-recorded');
    await page.click(card('RET-2'));
    await page.waitForSelector('#choices:not([hidden])');
    expect(await page.textContent('#choices')).toContain('எடுத்தேன் — எடுத்ததைப் பதிவு செய்');
    expect(await audit(page, 'ta')).toEqual([]);
    await shoot(page, 'ta-choice');
    await page.click('#sheet-cancel');

    // RELOAD: the collected one stays collected (the durable queue decides); nothing is sent twice.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PhoneWindow).routeSession !== undefined, undefined, { timeout: 15_000 });
    await page.waitForSelector(card('RET-1'));
    expect(await page.evaluate(() => (globalThis as unknown as PhoneWindow).routeSession!.collections().map((c) => [c.returnId, c.state]))).toEqual([['RET-1', 'collected'], ['RET-2', 'not_collected']]);
    expect(await page.textContent(`${card('RET-1')} .state`)).toBe('Collected');
    await page.click(card('RET-1'));
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-text')).toBe('That return is already collected.');
    await page.click('#banner-ok');
    expect((await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok)).toHaveLength(2);
  }, 120_000);
});
