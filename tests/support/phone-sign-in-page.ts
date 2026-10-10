// Browser test support for the phones' sign-in (Wave 4 · PA-06 = DF-3-c · OB-28 "A").
//
// After an enrolled phone opens a job's screen the box sends it to the sign-in page; the person keys their staff ID and the
// same PIN as the till, and the box sends the phone on to the job's screen as them. The PIN is made at run time from a seed
// (`pinOf`) — none is written in the repo.

import type { Page } from 'playwright-core';
import { pinOf } from './till-operator';

/** Wait for the phone's sign-in page, key the person's staff ID and PIN, submit, and wait for the job's screen. */
export async function signInOnPhonePage(page: Page, screen: 'warehouse' | 'picker' | 'driver', staffId: string): Promise<void> {
  await page.waitForFunction(() => (globalThis as unknown as { location: { pathname: string } }).location.pathname === '/device/sign-in', undefined, { timeout: 15_000 });
  await page.fill('input[name="staffId"]', staffId);
  await page.fill('input[name="pin"]', pinOf(staffId));
  await page.click('button[type="submit"]');
  await page.waitForFunction((s) => (globalThis as unknown as { location: { pathname: string } }).location.pathname === `/${s}/`, screen, { timeout: 15_000 });
}
