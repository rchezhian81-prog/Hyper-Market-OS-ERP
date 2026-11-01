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
import { prepareTillBox, pinOf } from '../support/till-operator';

/**
 * **R8-3 · D04-FR-06 · OB-302 · OB-316 — the self-checkout lane, in a real browser, served by a real store computer with
 * NO head office anywhere (hard rule #1).** The lane is off unless the owner's `self_checkout` switch is on for it; a
 * colleague opens it with their own PIN; the customer scans; an age-restricted item, a weighed item without a label and
 * the payment each wait for the colleague, who settles each with their own PIN — the customer reads only neutral words;
 * the sale lands on the box's disk through the till's own path, names the colleague, and carries the card attempt's
 * reference; the basket's evidence (who settled what) is kept on the box for head office. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
/** Screenshots for the owner, only when SRE_SHOTS names a directory. */
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['self', 'checkout', 'lane', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const RICE = '8900000000707';
const CIGS = '8900000000110';
const BANANA_PLAIN = '8900000000999'; // the banana's own plain code — a weighed item with no scale label
const SOAP = '8900000000505';

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 7, builtAt: new Date().toISOString(),
    products: [
      { productId: 'P-RICE', sku: 'RICE-1', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 0, status: 'active' },
      { productId: 'P-SOAP', sku: 'SOAP-1', name: 'Soap 100g', baseUom: 'ea', unitPriceMinor: 45_00, taxBps: 1800, status: 'active' },
      { productId: 'P-CIG', sku: 'CIG-PACK', name: 'Cigarettes 10s (demo)', baseUom: 'ea', unitPriceMinor: 180_00, taxBps: 2800, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 1, minimumAge: 18 } },
      { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 0, status: 'active' },
    ],
    barcodes: [
      { code: RICE, productId: 'P-RICE', kind: 'standard' }, { code: SOAP, productId: 'P-SOAP', kind: 'standard' },
      { code: CIGS, productId: 'P-CIG', kind: 'standard' }, { code: BANANA_PLAIN, productId: 'P-BAN', kind: 'standard' },
    ],
    embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

const ROLLOUT_ON = { format: 'sre-rollout/1', branchId: 'store-1', switches: [{ key: 'self_checkout', branch: null, lanes: [{ laneId: 'lane-1', enabled: true, version: 1 }] }] };

interface LaneWindow {
  readonly selfCheckout?: { view(): { open: boolean; interventions: { id: string; kind: string; attendantDetail: string }[]; lines: unknown[]; receipt: { number: string; basketRecorded: boolean } | null } };
}
type Doc = { document: { querySelector(s: string): { textContent: string | null } | null } };

describe.skipIf(!HAVE_BROWSER)('the self-checkout lane (R8-3 · OB-302 · OB-316)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'self-checkout'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function lane(rollout: unknown): Promise<{ edge: EdgeProcess; page: Page; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-self-checkout-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({
        dir, key: KEY, people: [{ userId: 'u-attend', displayName: 'Attendant' }],
        pack: { version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [], ...(rollout === undefined ? {} : { rollout }) },
      }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    // No CLOUD_API_URL: there is no head office at all — the lane must sell regardless (hard rule #1).
    expect(edge.agent).toBeNull();
    const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/self-checkout/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as LaneWindow).selfCheckout !== undefined, undefined, { timeout: 15_000 });
    return { edge, page, dir };
  }
  const now = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as Doc).document.querySelector('#now')?.textContent ?? '');
  const scan = async (page: Page, code: string): Promise<void> => { await page.click('#total'); await page.keyboard.type(code); await page.keyboard.press('Enter'); };
  const asColleague = async (page: Page, staff: string, pin: string): Promise<void> => {
    if (await page.isHidden('#panel')) await page.click('#colleague');
    await page.fill('#staff', staff);
    await page.fill('#pin', pin);
  };
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
  const view = (page: Page) => page.evaluate(() => (globalThis as unknown as LaneWindow).selfCheckout!.view());

  it('switched off for this lane (OB-316): it says so, and a colleague cannot open it', async () => {
    const { page } = await lane(undefined);
    expect(await now(page)).toMatch(/Self-checkout is switched off on this lane/);
    // Round 3: the colleague's notes on the page name WHERE it is switched on — the owner's Trial switches page.
    expect(await page.textContent('#notes')).toMatch(/switches it on for this lane on the "Trial switches and shop account" page \(Administration menu\)/);
    expect(await page.isDisabled('#pay-card')).toBe(true);
    await asColleague(page, 'u-attend', pinOf('u-attend'));
    await page.click('#open-lane');
    expect(await page.textContent('#said')).toMatch(/switched off/);
    expect((await view(page)).open).toBe(false);
  });

  it('opened by a colleague; age, a weighed item and the payment go to them; the sale and the basket\'s evidence land on the box', async () => {
    const { edge, page, dir } = await lane(ROLLOUT_ON);
    expect(await now(page)).toMatch(/This lane is closed/);

    // A colleague opens it with their own code and PIN.
    await asColleague(page, 'u-attend', pinOf('u-attend'));
    await page.click('#open-lane');
    await page.waitForFunction(() => (globalThis as unknown as LaneWindow).selfCheckout!.view().open);
    await page.click('#panel-done');
    expect(await now(page)).toMatch(/Scan your items/);

    // The customer scans rice, then cigarettes (18+), then a loose banana by its plain code.
    await scan(page, RICE);
    await scan(page, CIGS);
    await scan(page, BANANA_PLAIN);
    await scan(page, SOAP);
    const waiting = await view(page);
    expect(waiting.lines).toHaveLength(2); // rice and soap — the cigarettes and the banana wait for a colleague
    expect(waiting.interventions.map((i) => i.kind).sort()).toEqual(['age_check', 'weighed_item']);
    // The customer reads only neutral words — never the reason, never "age" or a number.
    const customerWords = await now(page);
    expect(customerWords).toMatch(/A colleague will/);
    expect(customerWords).not.toMatch(/age|18|restricted|weigh.*kg/i);
    expect(await page.isDisabled('#pay-card')).toBe(true);
    await shot(page, 'self-checkout-waiting-for-a-colleague');
    // Tamil on the same screen.
    await page.click('#lang');
    expect(await now(page)).toMatch(/ஊழியர்/);
    await page.click('#lang');

    // The customer removes the soap — kept as void evidence on the box, under the colleague who opened the lane.
    await page.locator('.line', { hasText: 'Soap' }).locator('button[data-line]').click();
    await page.waitForFunction(() => (globalThis as unknown as LaneWindow).selfCheckout!.view().lines.length === 1);

    // A wrong PIN settles nothing; the colleague's own PIN does, every time.
    await asColleague(page, 'u-attend', '000000');
    await page.click('[data-kind="age_check"] [data-decision="old_enough"]');
    await page.waitForFunction(() => /Not accepted/.test((globalThis as unknown as Doc).document.querySelector('#said')?.textContent ?? ''));
    expect((await view(page)).interventions.map((i) => i.kind)).toContain('age_check');
    await asColleague(page, 'u-attend', pinOf('u-attend'));
    await shot(page, 'self-checkout-colleague-panel');
    await page.click('[data-kind="age_check"] [data-decision="old_enough"]');
    await page.waitForFunction(() => (globalThis as unknown as LaneWindow).selfCheckout!.view().lines.length === 2);
    // OB-302: the banana is never priced by a typed weight — it is taken to the scale for its own label.
    const weighed = (await view(page)).interventions.find((i) => i.kind === 'weighed_item')!;
    expect(weighed.attendantDetail).toMatch(/Never key a weight/);
    await asColleague(page, 'u-attend', pinOf('u-attend'));
    await page.click('[data-kind="weighed_item"] [data-decision="sent_to_scale"]');
    await page.waitForFunction(() => (globalThis as unknown as LaneWindow).selfCheckout!.view().interventions.length === 0);
    await page.click('#panel-done');

    // The customer pays by card: the attempt is on the box's disk before the machine is used.
    expect(await page.isDisabled('#pay-card')).toBe(false);
    await page.click('#pay-card');
    await page.waitForFunction(() => /Pay on the machine now/.test((globalThis as unknown as Doc).document.querySelector('#now')?.textContent ?? ''));
    const attempts = async () => (await readLog(join(dir, 'payment-attempts.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { kind: string; outcome?: string; attemptId: string }] : []));
    expect((await attempts()).map((a) => a.kind)).toEqual(['asked']);
    expect(await readLog(edge.log.path)).toHaveLength(0);

    // The colleague confirms what the machine said, with their own PIN.
    await asColleague(page, 'u-attend', pinOf('u-attend'));
    await page.click('#paid-approved');
    await page.waitForFunction(() => /Thank you/.test((globalThis as unknown as Doc).document.querySelector('#now')?.textContent ?? ''), undefined, { timeout: 10_000 });
    expect(await page.textContent('#receipt')).toMatch(/Bill /);
    await page.click('#panel-done');
    await shot(page, 'self-checkout-paid');
    await page.click('#colleague');

    // The sale is on the box's disk through the till's own path: the colleague is its cashier, the card its attempt.
    const sales = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { cashierId: string; tenders: { kind: string; ref?: string }[]; lines: { productId: string; ageCheck?: { confirmedBy?: string } }[] }] : []));
    expect(sales).toHaveLength(1);
    expect(sales[0]!.cashierId).toBe('u-attend');
    expect(sales[0]!.lines.map((l) => l.productId).sort()).toEqual(['P-CIG', 'P-RICE']);
    const approved = (await attempts()).filter((a) => a.outcome === 'approved').map((a) => a.attemptId);
    expect(sales[0]!.tenders).toEqual([expect.objectContaining({ kind: 'card', ref: approved[0] })]);
    expect(JSON.stringify(sales[0])).toContain('u-attend'); // the age evidence names the colleague

    // The basket's evidence and the void are on the box's device log, queued for head office.
    await expect.poll(async () => (await view(page)).receipt?.basketRecorded, { timeout: 5_000 }).toBe(true);
    const device = (await readLog(join(dir, 'device-events.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : []));
    const basket = device.find((e) => e.type === 'SelfCheckoutBasketRecorded')!;
    expect(basket.payload).toMatchObject({ cashierId: 'u-attend', laneId: 'lane-1' });
    const ev = basket.payload['selfCheckout'] as { interventions: { kind: string; outcome: string; settledBy: string }[]; riskBps: unknown; voids: number };
    expect(ev.interventions.map((i) => [i.kind, i.outcome, i.settledBy])).toEqual([['age_check', 'old_enough', 'u-attend'], ['weighed_item', 'sent_to_scale', 'u-attend'], ['payment', 'approved', 'u-attend']]);
    expect([ev.riskBps, ev.voids]).toEqual([null, 1]); // the owner's watch numbers are not set: no risk figure invented
    expect(device.filter((e) => e.type === 'TillActivityRecorded' && e.payload['kind'] === 'void')).toHaveLength(1);

    // The next customer starts empty, the lane still open under the same colleague.
    await page.click('#panel-done');
    await page.click('#next');
    expect(await now(page)).toMatch(/Scan your items/);
  }, 90_000);
});
