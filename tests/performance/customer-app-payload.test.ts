import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * **M20 "low-bandwidth" (D08 · M20.md rules and tests: "it works on a low-spec phone at low bandwidth") — the customer
 * app's first load, measured.**
 *
 * The roadmap names low bandwidth but gives no number, so this holds an ENGINEERING budget, stated here and in the report
 * for the owner: everything the shop's front page loads, compressed as the server sends it, is at most 150 KB — about
 * five seconds on a weak 2G-class link of 250 kbit/s. And the page loads nothing from anywhere else: no web fonts, no
 * pictures, no outside scripts — each of which would cost a slow phone another connection.
 *
 * Also: the answers the new commerce screens fetch are small JSON — the basket price is one request, sent only on a tap.
 */

const WEB = 'apps/customer-app/web';
const FIRST_LOAD_GZIP_BUDGET = 150 * 1024;
const LINK_KBPS = 250;

const html = (): string => readFileSync(join(WEB, 'index.html'), 'utf8');
/** Every file the front page asks for: its scripts, its stylesheet, its manifest. */
function firstLoad(): string[] {
  const page = html();
  const refs = [...page.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
  return refs;
}

describe('the customer app loads within a low-bandwidth budget (M20 · D08)', () => {
  beforeAll(() => { execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' }); }, 120_000);

  it('loads nothing from another origin — no fonts, no pictures, no outside scripts', () => {
    const refs = firstLoad();
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r, r).toMatch(/^\.\//);
    expect(html()).not.toMatch(/<img\b|@font-face|fonts\.googleapis|https?:\/\//);
    for (const r of refs.filter((x) => x.endsWith('.css'))) expect(readFileSync(join(WEB, r), 'utf8')).not.toMatch(/@font-face|url\(\s*['"]?https?:/);
  });

  it(`the whole first load, compressed, is within ${FIRST_LOAD_GZIP_BUDGET / 1024} KB (~${Math.round((FIRST_LOAD_GZIP_BUDGET * 8) / (LINK_KBPS * 1000))} s at ${LINK_KBPS} kbit/s)`, () => {
    const files = ['index.html', ...firstLoad().map((r) => r.replace(/^\.\//, ''))];
    const sizes = files.map((f) => ({ f, gz: gzipSync(readFileSync(join(WEB, f)), { level: 9 }).length }));
    const total = sizes.reduce((t, s) => t + s.gz, 0);
    expect(files).toEqual(expect.arrayContaining(['customer-app.bundle.js', 'app.js', 'online-store.js', 'customer-commerce.js']));
    expect(total, JSON.stringify(sizes)).toBeLessThanOrEqual(FIRST_LOAD_GZIP_BUDGET);
    // No single file grows into the budget on its own.
    for (const s of sizes) expect(s.gz, s.f).toBeLessThanOrEqual(40 * 1024);
  });

  it('the new screens fetch nothing on open — every shop call is a tap, through the shop model (never a fetch of their own)', () => {
    const js = readFileSync(join(WEB, 'customer-commerce.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|setInterval\(/);
    // The only module-level calls are the voice and scan paints, which ask the phone, not the shop.
    const tail = js.slice(js.lastIndexOf('window.shopCommerce'));
    expect(tail).not.toMatch(/commerce\.(quote|repeatOrders|addresses|occasions|suggestions|paymentMethods)\(/);
  });
});
