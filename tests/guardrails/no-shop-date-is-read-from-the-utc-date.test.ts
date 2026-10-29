import { describe, it, expect } from 'vitest';
import { loadCodeEntries, scan, sample, type Rule } from './lib/scan';

/**
 * **No business date is read from the UTC date of "now" (M01-FR-02 · P-08 · round 12, R12-A).**
 *
 * The shop's day is Asia/Kolkata (UTC+5:30). `new Date().toISOString().slice(0, 10)` is the UTC date, which is the SHOP'S
 * YESTERDAY from 18:30 to 24:00 UTC — 00:00 to 05:30 in the shop. On 28 Oct 2026, 13 browser test files failed between
 * 19:00 and 19:25 UTC and passed at 14:30 the same day; four of them had found a screen or a route doing exactly this
 * (or reading the browser's own date). A customer or a member of staff at 00:00–05:30 shop time must get the shop's date,
 * which is read from the shop clock (packages/calendar/src/shop-clock.ts: `shopDateIn`, `shopToday`, `shopClock(…).today`,
 * `tradingDayOf`), never by slicing a moment.
 *
 * This tripwire fails when a NEW UTC-today idiom appears in product code (apps/, services/, edge/, packages/):
 *   • `new Date().toISOString().slice(0, 10)` — and `.substring(0, 10)`, `.substr(0, 10)`, `.split('T')[0]`, `toJSON()`;
 *   • the same on `new Date(Date.now() …)`;
 *   • a `now` port's moment sliced to its date: `now().slice(0, 10)`, `deps.now().slice(0, 10)`, `nowIso.slice(0, 10)`,
 *     `input.now.slice(0, 10)`;
 *   • the UTC date of now (or of a moment named `at`) moved by a span: `new Date(Date.parse(input.now) + n * DAY)…slice(0, 10)`.
 * A moment first turned into the shop's wall clock (`wallClockIn(now(), zone).slice(0, 10)`) is the shop's date and is not
 * matched.
 * Date ARITHMETIC on a date that is already a shop date (`new Date(Date.parse(\`${day}T00:00:00Z\`) + n * DAY)…`) is not
 * an idiom of "now" and is not matched. A place that genuinely wants the UTC date goes on the allowlist below WITH its reason.
 */

const UTC_DAY = String.raw`(?:\.(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)|\.split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\])`;
const RULES: Rule[] = [
  { rule: 'the UTC date of new Date()', re: new RegExp(String.raw`new Date\(\s*\)\s*\.to(?:ISOString|JSON)\(\)\s*${UTC_DAY}`) },
  { rule: 'the UTC date of Date.now()', re: new RegExp(String.raw`new Date\(\s*Date\.now\(\)[^;\n]*?\)\s*\.to(?:ISOString|JSON)\(\)\s*${UTC_DAY}`) },
  { rule: 'a now() moment sliced to its UTC date', re: new RegExp(String.raw`\bnow(?:Iso|ISO|At)?\s*(?:\(\s*\))?\s*${UTC_DAY}`) },
  { rule: 'the UTC date of now (or a moment `at`) moved by a span', re: new RegExp(String.raw`new Date\(\s*Date\.parse\(\s*[\w.]*\b(?:now|nowIso|at)\s*(?:\(\s*\))?\s*\)\s*[+-][^;\n]*?\)\s*\.to(?:ISOString|JSON)\(\)\s*${UTC_DAY}`) },
];

/**
 * The places that genuinely want the UTC date (or are not a date of "now" at all), each with its reason. An entry names the
 * file and a piece of the line, so it survives the line moving; it never excuses a second hit in the same file.
 */
const ALLOWED: readonly { readonly file: string; readonly line: string; readonly why: string }[] = [
  {
    file: 'apps/web-erp/src/migration-session.ts', line: 'config.now.slice(0, 10) : wallClockIn(config.now)',
    why: 'slices only when `now` is NOT an instant (Date.parse fails: the page was handed a plain YYYY-MM-DD day); an instant is read through wallClockIn',
  },
  {
    file: 'packages/owner-control/src/scheduled-brief.ts', line: 'const today = input.now.slice(0, 10);',
    why: '`now` here is already the SHOP\'s wall clock by contract (callers pass "<shop date>T<shop hh:mm>:00Z"), so its first ten characters are the shop\'s today',
  },
  {
    file: 'packages/integration/src/secrets.ts', line: 'const oldValidUntil = new Date(Date.parse(input.at)',
    why: 'a rotated credential\'s grace end for the platform\'s secret store — a technical validity in UTC, said in the rotation note and compared by nothing on the shop\'s day; not a business date',
  },
  {
    file: 'packages/platform-admin/src/support-access.ts', line: 'const cutoff = new Date(Date.parse(input.now) + warnDays',
    why: 'the platform operator\'s "entitlements expiring within 30 days" warning window (status centre) — a SaaS-wide horizon, not a shop business date; a day either way moves a 30-day warning, never a decision',
  },
];

const PRODUCT_DIRS = ['apps', 'services', 'edge', 'packages'];
const stripComments = (content: string): string => content
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  .split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');

function hits() {
  const entries = loadCodeEntries(PRODUCT_DIRS).map((e) => ({ ...e, content: stripComments(e.content) }));
  return scan(entries, RULES);
}

describe('no shop date is read from the UTC date of "now" (M01-FR-02)', () => {
  it('product code has no UTC-today idiom outside the allowlist — each allowed place says why', () => {
    const found = hits().filter((f) => !ALLOWED.some((a) => a.file === f.file && f.snippet.includes(a.line)));
    // Named all at once. Fix it with the shop clock (shopDateIn / shopToday / tradingDayOf), or — only if the UTC date is
    // genuinely meant — add it to ALLOWED with the reason.
    expect(found.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.snippet}`)).toEqual([]);
  });

  it('every allowlist entry still matches a real hit and gives a reason (no stale or silent excuses)', () => {
    const all = hits();
    for (const a of ALLOWED) {
      expect(a.why.trim().length, `${a.file}: a reason`).toBeGreaterThan(20);
      expect(all.filter((f) => f.file === a.file && f.snippet.includes(a.line)), `${a.file}: "${a.line}" still there`).toHaveLength(1);
    }
  });

  it('tripwire — the detector fires on each idiom, and not on date arithmetic or the shop clock', () => {
    const bad = [
      "const today = new Date().toISOString().slice(0, 10);",
      "const d = new Date().toISOString().substring(0, 10);",
      "const d = new Date().toISOString().split('T')[0];",
      "const d = new Date().toJSON().slice(0, 10);",
      "const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);",
      "const today = deps.now().slice(0, 10);",
      "const today = input.now.slice(0, 10);",
      "const today = nowIso.slice(0, 10);",
      "const cutoff = new Date(Date.parse(input.now) + warnDays * 86_400_000).toISOString().slice(0, 10);",
      "const until = new Date(Date.parse(input.at) + grace * DAY_MS).toISOString().slice(0, 10);",
    ];
    const good = [
      "const today = shopDateIn(new Date().toISOString());",
      "const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);",
      "const at = new Date().toISOString();",
      "const today = await shopToday(deps, tenantId);",
      "const month = now().slice(0, 7);",
      "const today = wallClockIn(deps.now(), timeZone).slice(0, 10);",
      "const today = shown(now()).slice(0, 10);",
    ];
    expect(scan([sample('apps/x/bad.ts', bad.join('\n'))], RULES).map((f) => f.line)).toEqual(bad.map((_, i) => i + 1));
    expect(scan([sample('apps/x/good.ts', good.join('\n'))], RULES)).toEqual([]);
  });
});
