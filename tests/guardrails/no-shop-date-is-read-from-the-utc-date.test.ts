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

/**
 * **No screen takes its date from the DEVICE's own clock or zone (OB-606 · M01-FR-02 · P-08 · round 13, R13-A).**
 *
 * A browser's own date is the date in whatever zone its device is set to. The store PC and the tills are set to India time;
 * a manager's laptop abroad, a head-office browser in a data centre, a CI runner and a phone set to another zone are not —
 * and from 18:30 UTC a browser on UTC is still on the shop's yesterday. Round 13 moved every screen that did this (the day
 * book, the POSH report, the company report, GST returns, buying, migration, the food-safety board, the manager's day close,
 * the till's concession tag, the dates shown in the lists, …) to the shop's day: packages/calendar/src/shop-day.ts
 * (`window.sreShopDay` in the office bundle) or apps/pos/web/shop-date.js on the till's plain pages, in the shop's zone the
 * store computer serves from its signed pack (`window.shopTimeZone`).
 *
 * This tripwire fails when a device-local date idiom appears in SCREEN code (apps/, edge/):
 *   • `toLocaleDateString(…)` with no `timeZone` named in the call — the device's own date, in any locale (`'en-CA'` too);
 *   • a date or time built from the device's own fields: `.getFullYear()`, `.getMonth()`, `.getDate()`, `.getDay()`,
 *     `.getHours()`, `.getMinutes()` (the UTC twins, `getUTC…`, are not matched);
 *   • `wallClockIn(moment)` with no zone — the machine's own zone.
 *
 * **OB-607 (owner, 29 Oct 2026 · round 14, R14-A): times of day and date-times follow the shop's clock too.** Every time a
 * screen shows or defaults is read through the page's shop's day (`window.sreShopDay.timeOf` / `.dateTimeOf` / `.fieldOf`,
 * packages/calendar/src/shop-day.ts), so the tripwire also fails on:
 *   • `toLocaleString(…)` / `toLocaleTimeString(…)` with no `timeZone` named in the call — the device's own clock (a NUMBER
 *     written `toLocaleString('en-IN')`, with or without its fraction digits, is money or a count and is not matched);
 *   • `new Intl.DateTimeFormat(…)` with no `timeZone` — the device's own zone;
 *   • `.getSeconds()` beside `.getHours()` / `.getMinutes()` above;
 *   • an instant's UTC clock shown by slicing its ISO text (`.replace('T', ' ').slice(0, 16)`, `.slice(0, 16).replace('T', ' ')`,
 *     `.slice(11, 16)`) — 19:30 UTC is 01:00 the next morning in the shop.
 */
const DEVICE_RULES: Rule[] = [
  { rule: 'toLocaleDateString with no timeZone (the device\'s own date)', re: /\.toLocaleDateString\((?![^)]*timeZone)/ },
  { rule: 'a date built from the device\'s own fields', re: /\.get(?:FullYear|Month|Date|Day|Hours|Minutes)\(\)/ },
  { rule: 'wallClockIn with no zone (the machine\'s own zone)', re: /\bwallClockIn\((?:[^(),]|\((?:[^()]|\([^()]*\))*\))*\)/ },
  // OB-607 — times of day and date-times.
  {
    rule: 'toLocaleString / toLocaleTimeString with no timeZone (the device\'s own clock)',
    re: /\.toLocale(?:String|TimeString)\((?!(?:[^()]|\([^()]*\))*timeZone)(?!\s*'en-IN'\s*(?:,\s*\{\s*(?:(?:minimum|maximum)FractionDigits:\s*\d+\s*,?\s*)+\})?\s*\))/,
  },
  { rule: 'Intl.DateTimeFormat with no timeZone (the device\'s own zone)', re: /\bIntl\.DateTimeFormat\((?!(?:[^()]|\([^()]*\))*timeZone)/ },
  { rule: 'a time built from the device\'s own seconds', re: /\.getSeconds\(\)/ },
  {
    rule: 'an instant\'s UTC clock shown by slicing its ISO text',
    re: /\.replace\(\s*'T'\s*,\s*' '\s*\)\s*\.slice\(\s*0\s*,\s*16\s*\)|\.slice\(\s*0\s*,\s*16\s*\)\s*\.replace\(\s*'T'\s*,\s*' '\s*\)|\.slice\(\s*11\s*,\s*16\s*\)/,
  },
];

/** The places in screen code that may read the device's own fields, each with its reason (file + a piece of the line). */
const DEVICE_ALLOWED: readonly { readonly file: string; readonly line: string; readonly why: string }[] = [
  // Empty (OB-607). Round 13's two entries are gone: the manager's sample stand-in now reads the shop's wall clock too (the
  // zone the store computer served, else Asia/Kolkata), and a card payment's time of day on the manager's Today screen is
  // the shop's clock (window.sreShopDay.timeOf). Neither truly wanted the device's clock.
];

const SCREEN_DIRS = ['apps', 'edge'];

function deviceHits() {
  const entries = loadCodeEntries(SCREEN_DIRS).map((e) => ({ ...e, content: stripComments(e.content) }));
  return scan(entries, DEVICE_RULES);
}

describe('no screen takes its date from the device\'s own clock or zone (OB-606)', () => {
  it('screen code has no device-local date idiom outside the allowlist — each allowed place says why', () => {
    const found = deviceHits().filter((f) => !DEVICE_ALLOWED.some((a) => a.file === f.file && f.snippet.includes(a.line)));
    // Fix it with the shop's day (window.sreShopDay / packages/calendar/src/shop-day.ts, or apps/pos/web/shop-date.js), or —
    // only if the device's own clock is genuinely meant — add it to DEVICE_ALLOWED with the reason.
    expect(found.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.snippet}`)).toEqual([]);
  });

  it('every allowlist entry still matches a real hit and gives a reason (no stale or silent excuses)', () => {
    const all = deviceHits();
    for (const a of DEVICE_ALLOWED) {
      expect(a.why.trim().length, `${a.file}: a reason`).toBeGreaterThan(20);
      expect(all.filter((f) => f.file === a.file && f.snippet.includes(a.line)).length, `${a.file}: "${a.line}" still there`).toBeGreaterThan(0);
    }
  });

  it('tripwire — the detector fires on each device idiom, and not on the shop\'s day or a zoned call', () => {
    const bad = [
      "const today = new Date().toLocaleDateString('en-CA');",
      "fact(t('due'), new Date(r.dueOn).toLocaleDateString()),",
      "const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}`; };",
      "const m = d.getMonth() === 0 ? 12 : d.getMonth();",
      "export const startOfToday = (now = new Date()) => new Date(now.getFullYear(), 0, 1).toISOString();",
      "const hh = String(d.getHours()).padStart(2, '0');",
      "const asOf = wallClockIn(new Date().toISOString()).slice(0, 10);",
      "const by = wallClockIn(dueBy).slice(0, 10);",
      // OB-607 — times of day and date-times on the device's (or the UTC) clock.
      "note.textContent = `${t('boardAsOf')} ${new Date(board.asAt).toLocaleString()}`;",
      "const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });",
      "setText('asked', `${t('asked')} ${askedAt.toLocaleTimeString()}`);",
      "const when = (iso) => new Date(iso).toLocaleString(lang() === 'ta' ? 'ta-IN' : 'en-IN', { weekday: 'short', hour: '2-digit' });",
      "const hhmm = (iso) => new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });",
      "const f = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });",
      "const ss = String(d.getSeconds()).padStart(2, '0');",
      "const when = (iso) => (typeof iso === 'string' ? iso.replace('T', ' ').slice(0, 16) : '');",
      "li.textContent = `${row.receivedAt.slice(0, 16).replace('T', ' ')}`;",
      "what.textContent = `${w(m.kind)} · ${m.at.slice(11, 16)}`;",
    ];
    const good = [
      "const today = window.sreShopDay.today();",
      "const shown = new Date(at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });",
      "const y = d.getUTCFullYear(); const m = d.getUTCMonth(); const dd = d.getUTCDate();",
      "const at = wallClockIn(now(), timeZone).slice(0, 10);",
      "const at = wallClockIn(new Date(guess).toISOString(), timeZone);",
      "const ms = d.getTime();",
      // OB-607 — the shop's clock, a zoned call, and numbers.
      "const clock = (iso) => window.sreShopDay?.timeOf(iso) ?? '';",
      "strip.textContent = `${t('staleShell')} ${window.sreShopDay?.dateTimeOf(at) ?? ''}`;",
      "const when = (iso) => new Date(iso).toLocaleString(lang() === 'ta' ? 'ta-IN' : 'en-IN', { timeZone: shopZone(), weekday: 'short' });",
      "const clockOf = (iso) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit' });",
      "const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric' });",
      "const inr = (minor) => '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });",
      "const n = (count).toLocaleString('en-IN');",
      "return (minor / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });",
      "const shown = wallClockIn(iso, zone).replace('T', ' ');",
    ];
    expect(scan([sample('apps/x/bad.js', bad.join('\n'))], DEVICE_RULES).map((f) => f.line)).toEqual(bad.map((_, i) => i + 1));
    expect(scan([sample('apps/x/good.js', good.join('\n'))], DEVICE_RULES)).toEqual([]);
  });
});

/**
 * **What `packages/` writes for a PERSON to read — a printed label, a staff message, a receipt line — never slices the UTC
 * clock out of ISO text (OB-607 outside screen code · round 15, R15-A).**
 *
 * `useBy.slice(0, 16).replace('T', ' ')` printed a pack good until 19:30 UTC as "USE BY … 19:30" — 01:00 the next morning
 * in the shop — and a roster gap for a shift at 00:30 UTC said "00:30" for the shop's 06:00. Round 15 moved the food label,
 * the scale label and the roster gap's message to the shop's clock (`shownShopDateTime`, packages/calendar/src/shop-day.ts)
 * in the zone of the store pack (the label printer, offline) or the tenant's calendar (head office).
 *
 * This tripwire fails when package code slices a clock out of ISO text: `.slice(0, 16).replace('T', ' ')`,
 * `.replace('T', ' ').slice(0, 16)`, `.slice(0, 19).replace('T', ' ')`, `.slice(11, 16)`, `.slice(11, 19)` (and the
 * `substring` twins). A place whose text is ALREADY the shop's wall clock (read in the shop's zone, or shifted by the
 * shop's offset first) goes on the allowlist below with the reason.
 */
const PACKAGE_RULES: Rule[] = [
  {
    rule: 'a clock sliced out of ISO text (the UTC clock, unless it was the shop\'s wall clock already)',
    re: /\.(?:slice|substring)\(\s*0\s*,\s*1[69]\s*\)\s*\.replace\(\s*['"]T['"]\s*,\s*['"] ['"]\s*\)|\.replace\(\s*['"]T['"]\s*,\s*['"] ['"]\s*\)\s*\.(?:slice|substring)\(\s*0\s*,\s*1[69]\s*\)|\.(?:slice|substring)\(\s*11\s*,\s*1[69]\s*\)/,
  },
];

/** Package code whose sliced text is already the shop's wall clock — each with its reason (file + a piece of the line). */
const PACKAGE_ALLOWED: readonly { readonly file: string; readonly line: string; readonly why: string }[] = [
  {
    file: 'packages/calendar/src/shop-day.ts', line: 'return shopWallClockOf(value, timeZone).slice(11, 16);',
    why: 'the text sliced is `shopWallClockOf` — the moment already read in the shop\'s zone ("YYYY-MM-DDTHH:MM"), so its HH:MM is the shop\'s clock',
  },
  {
    file: 'packages/receipt/src/tax-invoice.ts', line: 'return { date: local.slice(0, 10), time: local.slice(11, 16) };',
    why: '`local` is the instant moved by India\'s fixed +05:30 first (no daylight saving) — the tax invoice\'s date and time of issue in India time, not the UTC clock',
  },
  {
    file: 'packages/workforce/src/working-time.ts', line: 'new Date(ms + off * 60_000).toISOString().slice(11, 16)',
    why: 'the moment is moved by the shop\'s own offset (`off`, minutes) before it is sliced — the working-time breach text names the shop\'s hour',
  },
];

function packageHits() {
  const entries = loadCodeEntries(['packages']).map((e) => ({ ...e, content: stripComments(e.content) }));
  return scan(entries, PACKAGE_RULES);
}

describe('what packages/ writes for a person never slices the UTC clock out of ISO text (OB-607)', () => {
  it('package code has no sliced clock outside the allowlist — each allowed place says why', () => {
    const found = packageHits().filter((f) => !PACKAGE_ALLOWED.some((a) => a.file === f.file && f.snippet.includes(a.line)));
    // Fix it with the shop's clock (shownShopDateTime / shopDateTimeOf / wallClockIn with the shop's zone), or — only if the
    // text sliced is already the shop's wall clock — add it to PACKAGE_ALLOWED with the reason.
    expect(found.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.snippet}`)).toEqual([]);
  });

  it('every allowlist entry still matches a real hit and gives a reason (no stale or silent excuses)', () => {
    const all = packageHits();
    for (const a of PACKAGE_ALLOWED) {
      expect(a.why.trim().length, `${a.file}: a reason`).toBeGreaterThan(20);
      expect(all.filter((f) => f.file === a.file && f.snippet.includes(a.line)).length, `${a.file}: "${a.line}" still there`).toBeGreaterThan(0);
    }
  });

  it('tripwire — the detector fires on each sliced clock, and not on the shop\'s clock or a hash', () => {
    const bad = [
      "`USE BY ${label.useBy.slice(0, 16).replace('T', ' ')}`,",
      "`${shift.startsAt.slice(0, 16).replace('T', ' ')} has NOBODY rostered as ${role}`",
      "const when = at.replace('T', ' ').slice(0, 16);",
      "const stamp = at.slice(0, 19).replace('T', ' ');",
      "const hhmm = at.slice(11, 16);",
      "const hms = new Date(ms).toISOString().substring(11, 19);",
    ];
    const good = [
      "`USE BY ${shownShopDateTime(label.useBy, timeZone)}`,",
      "const hhmm = shopTimeOf(at, zone);",
      "const shown = wallClockIn(at, zone).replace('T', ' ');",
      "const ref = sha256Hex(key).slice(0, 16);",
      "const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);",
      "const day = at.slice(0, 10);",
    ];
    expect(scan([sample('packages/x/bad.ts', bad.join('\n'))], PACKAGE_RULES).map((f) => f.line)).toEqual(bad.map((_, i) => i + 1));
    expect(scan([sample('packages/x/good.ts', good.join('\n'))], PACKAGE_RULES)).toEqual([]);
  });
});
