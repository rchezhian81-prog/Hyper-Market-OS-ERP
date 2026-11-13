import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **U3 · G2 (UI/UX gap audit, 1 Nov 2026 · OB-699 · NFR-08): on the Tamil screen, every word the PAGE itself prints is Tamil —
 * the lane-3 (finance, owner, CRM) and lane-4 (people, admin, platform) office pages.**
 *
 * The audit found 279 English fragments on 56 pages after the toggle: labels, hints, captions, button words, state words,
 * "Not known" reasons, chip labels, column headings that a page printed from one language only. Decision OB-699 (owner,
 * 7 Nov 2026): the product's OWN words are carried in both languages; a FINDING head office wrote (a GST return's finding,
 * an alert's message, a brief's evidence line) stays English — the page says so once and marks it `lang="en"`, the way a
 * screen reader is told a passage is in another language (WCAG 3.1.2).
 *
 * This test opens every page of the two lanes on the REAL store computer fed by the REAL head office, as the role that
 * opens it, toggles to Tamil, and reads every visible text leaf (and every placeholder and option) outside the chrome:
 * a leaf with two or more Latin letters that is not a proper noun, a code, an id, a unit or an abbreviation the shop uses
 * in English (GST, UPI, HSN, PIN …), and not inside `[lang="en"]`, is a fragment. The list of fragments per page is written
 * to the scratchpad for the builder; the assertion is zero.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 900 } };
const REPORT = process.env['U3_REPORT_DIR'];

const A = PEOPLE.accountant, M = PEOPLE.manager, O = PEOPLE.owner, C = PEOPLE.cashier;
export const LANE_3: readonly { id: string; who: string }[] = [
  { id: 'day-book', who: A }, { id: 'finance-close', who: A }, { id: 'reconciliation', who: A }, { id: 'tally-files', who: A },
  { id: 'promotion-funding', who: A }, { id: 'concessions', who: A }, { id: 'gst-reconciliation', who: M }, { id: 'gst-returns', who: A },
  { id: 'itc-review', who: A }, { id: 'day-reopen', who: A }, { id: 'basket-affinity', who: A }, { id: 'branch-compare', who: M },
  { id: 'company-report', who: A }, { id: 'waste-analytics', who: M }, { id: 'b2b', who: A }, { id: 'campaigns', who: M },
  { id: 'customers', who: M }, { id: 'online-store', who: O }, { id: 'quotations', who: M }, { id: 'return-governance', who: A },
  { id: 'service', who: M }, { id: 'service-desk', who: M }, { id: 'stored-value', who: A },
];
export const LANE_4: readonly { id: string; who: string }[] = [
  { id: 'adoption', who: M }, { id: 'appointment-letters', who: O }, { id: 'certificates', who: M }, { id: 'checklist', who: M },
  { id: 'payroll', who: O }, { id: 'posh-report', who: O }, { id: 'rostering', who: M }, { id: 'schedule', who: M },
  { id: 'store-tasks', who: M }, { id: 'workforce', who: M }, { id: 'ess', who: C }, { id: 'help', who: M },
  { id: 'my-payslip', who: C }, { id: 'my-tasks', who: C }, { id: 'access-review', who: O }, { id: 'ai', who: O },
  { id: 'approval-rules', who: O }, { id: 'audit', who: O }, { id: 'data-io', who: O }, { id: 'delegation', who: O },
  { id: 'document-templates', who: O }, { id: 'migration', who: O }, { id: 'rollout', who: O }, { id: 'settings', who: O },
  { id: 'support-access', who: O }, { id: 'switches', who: O }, { id: 'fleet', who: M }, { id: 'incidents', who: M },
  { id: 'integration-health', who: M }, { id: 'scales', who: M }, { id: 'store-computers', who: M },
];

/** Words the shop reads in English on a Tamil screen by nature: names, codes, units, abbreviations. Whole-token matches. */
/**
 * Words the shop reads in English on a Tamil screen by nature — whole-token matches: statutory abbreviations (GST, UPI,
 * HSN, PIN, TDS …), units, proper nouns (SRE Hyper Market, Tally, WhatsApp), ids and codes (u-mgr, S1, P-MILK, SOP-04,
 * thermal-80, owner-guide-12), format patterns (dd/mm/yyyy, MMYYYY, HH:MM), template keys ({value}, {{employeeName}}),
 * and machine identifiers (camelCase, snake_case, dotted.event.names). One real English word in a leaf is a fragment.
 */
const ALLOWED = new RegExp(String.raw`^(?:GST|GSTR|GSTR-?\d[ABC]?|GSTN|GSTIN|CGST|SGST|IGST|UTGST|HSN|SAC|UPI|PIN|OTP|PDF|CSV|XLSX?|JSON|XML|API|URL|QR|ARN|TDS|TCS|ITC|CA|IT|B2B|B2C|POS|ESL|IFSC|UTR|PAN|CIN|EPF|ESI|PF|PT|LWF|IRN|EWB|SMS|IVR|KYC|RBI|SEBI|ICAI|ISO|UTC|IST|AM|PM|OK|MRP|SKU|EAN|UOM|KG|kg|g|ml|L|ea|No\.?|Rs\.?|INR|₹|FSSAI|FoSTaC|POSH|AI|MFA|Tally|Excel|WhatsApp|Keycloak|PostgreSQL|Chromium|Android|iOS|SRE|Hyper|Market|Retail|Kolkata|Asia|Tamil|English|Nadu|S1|C1|br-\d+|u-[a-z]+|M-\d+|P-[A-Z0-9-]+|SKU-[A-Z0-9-]+|MILK-500|SOP-[A-Z0-9-]+|owner-guide-\d+|thermal-\d+|gstr\d[a-z]?|[A-Z]{2,5}-?\d*|v\d+(?:\.\d+)*|\d+(?:[.,:/-]\d+)*(?:[a-z]{1,3})?|dd|mm|yyyy|YYYY|YY|MM|DD|HH|MMYYYY|YYYY-YY|YYYY-MM-DD|HH:MM|dd/mm/yyyy|[a-z]+[A-Z][A-Za-z0-9]*|[a-z]+(?:_[a-z0-9]+)+|[a-z_]+(?:\.[a-z_]+)+)$`);
const LATIN = /[A-Za-z]{2,}/;

/** Every visible text leaf on the page outside the chrome, on the Tamil screen, that still carries Latin words. */
async function fragments(page: Page): Promise<{ sel: string; text: string }[]> {
  return page.evaluate(() => {
    // The browser's DOM, typed structurally (this test file compiles without the DOM lib).
    interface El { tagName: string; id: string; classList: { length: number; [i: number]: string }; parentElement: El | null; closest(sel: string): El | null; matches(sel: string): boolean; getBoundingClientRect(): { width: number; height: number }; placeholder?: string; textContent: string | null }
    interface TextNode { textContent: string | null; parentElement: El | null }
    interface Doc { body: El; createTreeWalker(root: El, what: number): { nextNode(): TextNode | null }; querySelectorAll(sel: string): ArrayLike<El> }
    const g = globalThis as unknown as { document: Doc; getComputedStyle(el: El): { display: string; visibility: string } };
    const d = g.document;
    // The chrome's own words (menu, header line, strips, sheets, pager) are Group C's; so are the shared DATE FIELD's
    // the shared date field's "(required)", format hint and placeholder are the chrome's words and follow the toggle too
    // (Group C, U5) — so they are READ here like any other word; a page's own label on the field counts as well.
    const chrome = (el: El): boolean => el.closest('nav#sre-menu, #sre-page > header, .sre-strip, .sre-sheet, .sre-badge, .sre-pager, [data-sre-chrome], .sre-confirm, .sre-pick, #sre-menu-sheet') !== null;
    const visible = (el: El): boolean => { const r = el.getBoundingClientRect(); const cs = g.getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && (r.width > 0 || r.height > 0); };
    const classes = (el: El): string[] => Array.from({ length: el.classList.length }, (_, i) => el.classList[i]!);
    const path = (el: El): string => { const parts: string[] = []; let e: El | null = el; let n = 0; while (e && n < 4) { parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (el.classList.length ? `.${classes(e).slice(0, 2).join('.')}` : '')); e = e.parentElement; n += 1; } return parts.join('>'); };
    const out: { sel: string; text: string }[] = [];
    const walker = d.createTreeWalker(d.body, 4 /* SHOW_TEXT */);
    let node: TextNode | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const el = node.parentElement; if (!el) continue;
      if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'CODE', 'KBD', 'PRE'].includes(el.tagName)) continue;
      if (chrome(el) || el.closest('[lang="en"]') !== null || !visible(el)) continue;
      out.push({ sel: path(el), text });
    }
    for (const el of Array.from(d.querySelectorAll('input[placeholder], textarea[placeholder]'))) {
      if (chrome(el) || el.closest('[lang="en"]') !== null || !visible(el)) continue;
      out.push({ sel: path(el) + '[placeholder]', text: (el.placeholder ?? '').trim() });
    }
    for (const el of Array.from(d.querySelectorAll('option'))) {
      const sel = el.closest('select'); if (!sel || chrome(sel) || sel.closest('[lang="en"]') !== null || !visible(sel)) continue;
      out.push({ sel: path(sel) + '>option', text: (el.textContent ?? '').trim() });
    }
    return out;
  });
}

const isEnglish = (text: string): boolean => {
  if (!LATIN.test(text)) return false;
  // A Latin word with a Tamil suffix glued on ("CA-க்காக", "AI-ஐ") is judged by its Latin core; a template key ({value},
  // {{employeeName}}) is a code; a CSV line (commas, no spaces — column names or a sample row) is a code line, not prose.
  const core = (t: string): string => t.replace(/^[^A-Za-z{]+|[^A-Za-z0-9}]+$/g, '').replace(/-?[\u0B80-\u0BFF]+.*$/, '');
  return text.split(/\\n|\n/).some((line) => {
    if (!LATIN.test(line) || (line.includes(',') && !/\s/.test(line.trim()))) return false;
    const tokens = line.split(/[\s(),;:"'“”‘’·•—–/|[\]\\]+/).filter((t) => /[A-Za-z]/.test(t));
    return tokens.some((t) => { const c = core(t); return c !== '' && c.length > 1 && !c.startsWith('{') && !ALLOWED.test(c); });
  });
};

describe.skipIf(!existsSync(CHROMIUM))('U3: the lane-3 and lane-4 pages speak Tamil after the toggle', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const sweep = async (lane: string, pages: readonly { id: string; who: string }[]): Promise<void> => {
    const found: Record<string, { sel: string; text: string }[]> = {};
    for (const p of pages) {
      const item = ERP_NAVIGATION.find((i) => i.id === p.id);
      expect(item, `${p.id} is a menu item`).toBeDefined();
      const s = await shop.asPerson(p.who, DESK);
      await s.page.goto(`${shop.base}${item!.path}`, { waitUntil: 'load' });
      await s.page.waitForFunction('globalThis.sreChrome !== undefined');
      await s.page.waitForLoadState('networkidle').catch(() => {});
      await s.page.waitForTimeout(400);
      await s.page.click('#lang');
      await s.page.waitForTimeout(600);
      expect(await s.page.getAttribute('html', 'lang'), p.id).toBe('ta');
      const english = (await fragments(s.page)).filter((f) => isEnglish(f.text));
      const unique = [...new Map(english.map((f) => [`${f.sel}|${f.text}`, f])).values()];
      if (unique.length > 0) found[p.id] = unique;
      await s.context.close();
    }
    if (REPORT) { mkdirSync(REPORT, { recursive: true }); writeFileSync(`${REPORT}/${lane}.json`, JSON.stringify(found, null, 2)); }
    const summary = Object.entries(found).map(([id, f]) => `${id}: ${f.length} — ${f.slice(0, 6).map((x) => JSON.stringify(x.text)).join(', ')}`).join('\n');
    expect(Object.keys(found), `English fragments on the Tamil screen:\n${summary}`).toEqual([]);
  };

  it('lane 3 — finance, owner and CRM pages', async () => { await sweep('lane-3', LANE_3); }, 600_000);
  it('lane 4 — people, admin and platform pages', async () => { await sweep('lane-4', LANE_4); }, 600_000);
});
