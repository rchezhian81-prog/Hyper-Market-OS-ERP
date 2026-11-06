// Wave 3 (security, people and operations): open an office page in a real browser AS a person, through the shell of
// `startInboxShop` (the production API over real PostgreSQL; the shell injects who is looking from head office's own
// `GET /v1/identity/me` and forwards every `/v1` call with that person's token). Every write the page sends is listed, and
// every page error kept. Synthetic data only.

import type { Browser, Page } from 'playwright-core';
import type { InboxShop } from './ai-inbox-shop';

export interface OpenPage { readonly page: Page; readonly errors: string[]; readonly writes: string[]; close(): Promise<void> }

/** `branch`: the store the person signs in at — needed for a person whose grant names stores (the br-1 manager). */
export async function openAs(shop: InboxShop, browser: Browser, who: string, path: string, branch?: string): Promise<OpenPage> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await shop.signIn(context, who, branch);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  const writes: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
  const res = await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
  if (res?.status() !== 200) throw new Error(`${path} as ${who}: the shell answered ${res?.status()}`);
  return { page, errors, writes, close: () => context.close() };
}
