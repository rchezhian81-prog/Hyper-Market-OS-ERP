// A screenshot helper for the office look (batch 12) — not a test, never run by a suite. Synthetic sales only.
//   npx tsx tests/support/shot-today.ts <out-folder>
import { chromium, type Page } from 'playwright-core';
import { join } from 'node:path';
import { startOfficeBox, PEOPLE } from './office-box';
import { openFileLog } from '../../edge/store-edge/src/file-log';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

const out = process.argv[2] ?? '/tmp/shot';
const first = await startOfficeBox({ packExtras: { managerPolicy: { userId: PEOPLE.owner.userId, approvalLimitMinor: null } } });
const dir = first.dataDir;
await first.stop();
const log = await openFileLog({ dataDir: dir, capacityBytes: 10_485_760 });
const now = Date.now();
const today = shopDateIn(new Date(now).toISOString());
const yesterday = shopDateIn(new Date(now - 86_400_000).toISOString());
let n = 0;
const shopMidnight = (day: string): number => Date.parse(`${day}T00:00:00+05:30`);
for (const [day, scale] of [[yesterday, 0.85], [today, 1]] as const) {
  for (let h = 8; h <= 21; h++) {
    const at = shopMidnight(day) + h * 3_600_000;
    if (at > now) continue;
    const bills = Math.max(1, Math.round((h >= 11 && h <= 14 ? 9 : 4) * scale));
    for (let b = 0; b < bills; b++) {
      n += 1;
      const total = 12_000 + ((n * 7919) % 90_000);
      await log.append(JSON.stringify({ id: `S-${n}`, number: `B-${String(n).padStart(4, '0')}`, laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: day, committedAt: new Date(at + b * 240_000).toISOString(), total, currency: 'INR', lines: [{ productId: 'p-rice', quantityMinor: 1, lineTotalMinor: total }], tenders: [{ kind: 'cash', amount: { minor: total } }] }));
    }
  }
}
await log.close();
const box = await startOfficeBox({ dataDir: dir });
const browser = await chromium.launch({ headless: true, executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium' });
const signIn = async (page: Page): Promise<void> => {
  await page.goto(`${box.base}/manager/`);
  await page.fill('#office-staff', PEOPLE.owner.userId);
  await page.fill('#office-pin', PEOPLE.owner.pin);
  await Promise.all([page.waitForURL(/manager/), page.press('#office-pin', 'Enter')]);
  await page.waitForTimeout(2500);
};
const desk = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
const page = await desk.newPage();
await page.goto(`${box.base}/`);
await page.screenshot({ path: join(out, 'sign-in.png') });
if (process.argv[3] === 'sign-in-only') { await browser.close(); await box.stop(); process.exit(0); }
await signIn(page);
await page.screenshot({ path: join(out, 'today.png') });
await page.screenshot({ path: join(out, 'today-full.png'), fullPage: true });
await page.goto(`${box.base}/approvals/`);
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, 'approvals.png') });
const phone = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: 'block' });
const p2 = await phone.newPage();
await signIn(p2);
await p2.screenshot({ path: join(out, 'phone.png'), fullPage: true });
await browser.close();
await box.stop();
console.log('ok', today, n);
