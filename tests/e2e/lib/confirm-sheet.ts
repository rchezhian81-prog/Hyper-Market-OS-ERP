// The shared consequence-and-confirm sheet (U1 · OB-698 · design system §1.3, §27.1), as a browser test drives it: the sheet
// the chrome draws (`sreOffice.confirm`) opens with the action's own figure in its title, "Go back" sends nothing, and
// "Confirm" sends the action once. Every page test that moves money, stock, a price or a privilege uses these three.

import type { Page } from 'playwright-core';

const SHEET = '#sre-confirm';

/** Waits for the sheet to be on screen and returns its title — the one line that says what will happen, with the figure. */
export async function sheetOpens(page: Page): Promise<string> {
  await page.waitForSelector(`${SHEET}:not([hidden])`, { timeout: 10_000 });
  return ((await page.textContent(`${SHEET} #sre-confirm-title`)) ?? '').replace(/\s+/g, ' ').trim();
}

/** Taps "Go back": the sheet closes and nothing is sent. */
export async function goBack(page: Page): Promise<void> {
  await page.click(`${SHEET} #sre-confirm-back`);
  await page.waitForSelector(SHEET, { state: 'hidden', timeout: 10_000 });
}

/** Taps the action's own confirm button (never "OK"): the sheet closes and the action is sent once. */
export async function confirmIt(page: Page): Promise<void> {
  await page.waitForSelector(`${SHEET}:not([hidden])`, { timeout: 10_000 });
  await page.click(`${SHEET} #sre-confirm-go`);
  await page.waitForSelector(SHEET, { state: 'hidden', timeout: 10_000 });
}

/** The sheet is asked, read, gone back from (nothing sent), asked again and confirmed — one call for the common proof. */
export async function askedThenConfirmed(page: Page, click: () => Promise<void>, titleLike: RegExp, writesSoFar: () => number): Promise<string> {
  const before = writesSoFar();
  await click();
  const title = await sheetOpens(page);
  if (!titleLike.test(title)) throw new Error(`the sheet's title "${title}" does not say what will happen (expected ${titleLike})`);
  await goBack(page);
  if (writesSoFar() !== before) throw new Error('Go back sent something');
  await click();
  await confirmIt(page);
  return title;
}

/** Counts every non-GET `/v1` request the page makes from now on. */
export function writeCounter(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/v1/')) n += 1; });
  return () => n;
}
