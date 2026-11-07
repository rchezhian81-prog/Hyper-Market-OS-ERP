import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **One marked primary action per office page, and a greyed button says why (UI/UX gap audit 1 Nov 2026 G3 · design
 * system §1 rule 3 "one primary action per screen, visually dominant" · §4 "disabled state explains why" · P-07).**
 *
 * The audit found no office page marked its main action: every page painted its own `button { background: var(--accent) }`,
 * so a screen with three actions had three green buttons and a person guessed which one mattered. Round U1 puts the one
 * main action of each view on the foundation's `.sre-btn-primary`, every other button on `.sre-btn` (secondary), `-quiet`
 * or `-danger`, and strips the page-own paint so the foundation's rules show. This file keeps that true for the next page:
 *
 *   1. every office page carries at least one `sre-btn-primary` (in its html or its script), or is listed here as a page
 *      with no main action of its own — a read-only view, or an inbox whose only actions are one per row — with the reason;
 *   2. no page stylesheet paints a button green/blue by itself any more (`button`, `button.act`, `.x button`, `.primary`
 *      with an accent, ok or info background): the colour of a button is its foundation class, nothing else;
 *   3. where a page greys a button because of the person's role or the record's state, the same statement or the next three
 *      lines give the reason (`title` or `aria-describedby`, or the page's `whyDisabled(...)` helper) — a greyed button with
 *      no why is a dead end;
 *   4. a tripwire proves each check bites.
 *
 * Static: it cannot see which primary is visible at once — `tests/e2e/u1-every-office-page-shows-one-primary-action.e2e.ts`
 * renders every page and counts.
 */

const WEB = 'apps/web-erp/web';
const PAGES = readdirSync(WEB).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();

/** Pages with no main action of their own, each with the reason a reader can check on the page. */
const NO_PRIMARY: Readonly<Record<string, string>> = {
  'category-policy': 'read-only register of category rules (OB-564: rules are deferred to R8); the filter is a select',
  counts: 'read-only review of reconciled counts; the filter is a select',
  'data-quality': 'an inbox: "Not a problem" / "Bring back" are one per finding, none is the page\'s own action',
  finance: 'a read-only month view with tabs; its one link sends the accountant to Month-end',
  'food-safety': 'a check sheet: one tick per scheduled check, none is the page\'s own action',
  'gst-reconciliation': 'a queue: Retry / Resolve are one per document',
  'my-tasks': 'the person\'s own task list: one Done per task',
  operations: 'an inbox: set aside / bring back are one per item',
  'posh-report': 'one "Record as filed" per committee year',
  'return-governance': 'read-only list of refund exceptions',
  'supplier-submissions': 'an inbox: Accept / Reject are one per submission',
  unsellable: 'read-only list',
  waste: 'read-only 30-day view; the filter is a select',
  workforce: 'the assistant\'s findings: one action per finding',
  'approval-rules': 'three equal change requests (limits, waits, price), each with its own "Ask the owner"; none is the page\'s one job',
  'owner-alerts': 'four equal settings forms (contracts, kiosk, watch, schedule), each with its own Save; none is the page\'s one job',
  'related-parties': 'four equal registers (parties, staff, accounts, do-not-contact), each with its own Save',
  'payroll-payslip': 'the person\'s own payslip: the script draws its one export button per payslip shown',
  checklist: 'one "Sign and submit" per checklist, drawn by the script per list',
  // Pages main built after the audit (Round 4c/4d, W2–W7), judged at the merge of 5 Nov 2026:
  branches: 'one Save per branch row, drawn by the script',
  'compliance-registers': 'eight equal registers (licences, evidence, claims, controls, incidents, remediation, attendance, findings), each with its own Show',
  'developer-docs': 'read-only developer documentation',
  'document-retention': 'one Dispose per retention rule row, drawn by the script',
  'failed-jobs': 'one Retry per failed job row, drawn by the script',
  'old-system': 'the migration workbench: twenty steps on one page, each with its own action; none is the page\'s one job',
  'payroll-legal': 'read-only legal payroll figures for the CA',
  'production-costs': 'read-only cost view',
  settings: 'one Save per setting row, drawn by the script',
  'training-checks': 'one check per row, drawn by the script; Refresh is quiet',
};

const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const scriptOf = (page: string): string => {
  const js = page === 'index' ? 'app.js' : `${page}.js`;
  return existsSync(join(WEB, js)) ? code(readFileSync(join(WEB, js), 'utf8')) : '';
};
const styleOf = (html: string): string => (/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '');

/** Page-own rules that paint a button in a tone colour. Allowed: the chrome's banner, a danger button, a pressed toggle,
 *  a tone chip, and the devices page's per-row tone actions (block / retire / reinstate — the tone IS the meaning). */
export function tonePaintedButtonRules(css: string): string[] {
  const found: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1]!.trim(); const dec = m[2]!;
    if (!/button|\.primary|\.act\b|\.do\b/.test(sel)) continue;
    if (/\.banner|danger|aria-pressed|\.chip|act-block|act-retire|act-reinstate|\.sre-/.test(sel)) continue;
    if (/background(?:-color)?\s*:[^;]*var\(--(accent|ok|good|info)\b/.test(dec)) found.push(sel.replace(/\s+/g, ' '));
  }
  return found;
}

/** A role- or state-based `disabled` on a BUTTON with no reason near it. A button is one of the page's `<button id>`s
 *  named by `$('id')` / `el('id')` (alone or in a `for (const id of [...])` list), a script-made button held in a
 *  variable named like one (`b`, `btn`, `button`, `yes`, `no`, `accept`, `both`, `saveBtn`), or a `querySelectorAll`
 *  that lists `button`. An input or select greyed for a role is the field's business, not this rule's. */
const BUTTON_VARS = /\b(b|btn|button|yes|no|accept|both|saveBtn|go|ask|remove)\.disabled\s*=/;
export function unexplainedDisables(js: string, buttonIds: ReadonlySet<string>): string[] {
  const lines = js.split('\n'); const out: string[] = [];
  const ROLE = /\.disabled\s*=\s*(!|.*\b(may|enabled|online|readFailed|editable|mayEdit|mayAct|mayPropose|mayZone|none|vmiMay)\b)/;
  lines.forEach((line, i) => {
    if (!ROLE.test(line)) return;
    const named = [...line.matchAll(/(?:\$|el)\('([^']+)'\)\.disabled\s*=/g)].map((m) => m[1]!);
    const listed = /for \(const id of \[([^\]]*)\]\)\s*(?:\$|el)\(id\)\.disabled/.exec(line)?.[1]?.split(',').map((x) => x.trim().replace(/^'|'$/g, '')) ?? [];
    const onButton = named.some((id) => buttonIds.has(id)) || listed.some((id) => buttonIds.has(id)) || BUTTON_VARS.test(line) || (/querySelectorAll\([^)]*button/.test(line) && /\.disabled\s*=/.test(line));
    if (!onButton) return;
    const near = lines.slice(i, i + 4).join('\n');
    if (/aria-describedby|\.title\s*=|whyDisabled\(/.test(near)) return;
    out.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return out;
}
const buttonIdsOf = (html: string): Set<string> => new Set([...html.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!));

describe('one marked primary action per office page (U1 · G3 · §1 rule 3)', () => {
  it('every office page marks a primary action, or says here why it has none', () => {
    const missing: string[] = [];
    for (const page of PAGES) {
      const html = readFileSync(join(WEB, `${page}.html`), 'utf8');
      const has = html.includes('sre-btn-primary') || scriptOf(page).includes('sre-btn-primary');
      if (!has && !(page in NO_PRIMARY)) missing.push(page);
      if (has && page in NO_PRIMARY) missing.push(`${page} (marks a primary, so it leaves the no-primary list)`);
    }
    expect(missing).toEqual([]);
    for (const page of Object.keys(NO_PRIMARY)) expect(PAGES, `exception ${page} names a page`).toContain(page);
  });

  it('no page paints a button green or blue by itself — the colour is its foundation class', () => {
    const wrong: string[] = [];
    for (const page of PAGES) for (const sel of tonePaintedButtonRules(styleOf(readFileSync(join(WEB, `${page}.html`), 'utf8')))) wrong.push(`${page}: ${sel}`);
    expect(wrong).toEqual([]);
  });

  it('a button greyed for a role or a state says why beside it', () => {
    const wrong: string[] = [];
    for (const page of PAGES) for (const line of unexplainedDisables(scriptOf(page), buttonIdsOf(readFileSync(join(WEB, `${page}.html`), 'utf8')))) wrong.push(`${page}.js ${line}`);
    expect(wrong).toEqual([]);
  });

  it('tripwire: each check bites', () => {
    expect(tonePaintedButtonRules('button { font: inherit; background: var(--accent); color: var(--on-accent); }')).toEqual(['button']);
    expect(tonePaintedButtonRules('.card button.do { background: var(--info); }')).toEqual(['.card button.do']);
    expect(tonePaintedButtonRules('.banner button { background: var(--danger-surface); } button.danger { background: var(--danger-surface); } .sre-btn-primary { background: var(--accent); }')).toEqual([]);
    const ids = new Set(['show']);
    expect(unexplainedDisables("$('show').disabled = !may.read;", ids)).toHaveLength(1);
    expect(unexplainedDisables("for (const id of ['a', 'show']) $(id).disabled = !may.read;", ids)).toHaveLength(1);
    expect(unexplainedDisables("$('show').disabled = !may.read;\nwhyDisabled($('show'), may.read ? '' : 'role');", ids)).toEqual([]);
    expect(unexplainedDisables("$('price-percent').disabled = !may.propose;", ids), 'an input is not a button').toEqual([]);
    expect(unexplainedDisables("btn.disabled = !enabled;", ids)).toHaveLength(1);
    expect(unexplainedDisables("btn.disabled = true;\ntry { await work(); } finally { btn.disabled = false; }", ids), 'busy while sending is not a refusal').toEqual([]);
  });
});
