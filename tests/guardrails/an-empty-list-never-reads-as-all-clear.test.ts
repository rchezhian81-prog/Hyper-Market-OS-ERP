import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **An empty list never reads as "all clear", and a stand-in never reaches a real store computer (U0 of the UI/UX gap
 * audit, 1 November 2026 · G6 · G7 · P-08 · design system §4.1).**
 *
 * The 1 Nov sweep found pages that said good news about nothing: Shelves said "everything on the plan has been counted"
 * under a banner saying there is no plan; Expiry said "nothing is close to its date" with no batch on record; Customer
 * cases said "every resolved case has a root cause" with no case at all; the owner's phone said "no alerts today" on a
 * phone that had never heard from the shop; and "Products nobody can sell", Migration and the two handhelds showed their
 * announced SAMPLE stand-in to a real person on a real store computer. Each of these is one line of code, and each is
 * exactly the kind of line a tidy-up puts back. These checks hold them, statically, on the shipped files.
 */

const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const read = (path: string): string => code(readFileSync(path, 'utf8'));

describe('an empty list says what it covers, or "not known" — never good news about nothing', () => {
  it('Shelves & space: with no shelf plan, "still to count" says there is nothing to count against, not "everything is counted"', () => {
    const view = read('apps/web-erp/web/merchandising.js');
    expect(view).toMatch(/noPlan \? t\('noPlanToCount'\) : t\('allCounted'\)/);
    expect(view).toMatch(/noPlanToCount: 'Nothing is on the list because this shop has no shelf plan yet/);
    expect(view).toMatch(/noPlanToCount: '[஀-௿]/);
    // and the good empty says how many facings it vouches for
    expect(view).toMatch(/allCounted: 'Everything on the plan has been counted recently — all \{n\} facings\./);
  });

  it('Expiry & recalls: an empty list says how many batches it covers; with none on record it says nothing can be close to its date', () => {
    const view = read('apps/web-erp/web/expiry.js');
    expect(view).toMatch(/known === 0 \? t\('noBatchesYet'\) : t\('nothingExpiring'\)\.replace\('\{n\}'/);
    expect(view).toMatch(/noBatchesYet: 'No batches are on record yet, so nothing can be close to its date/);
    expect(view).toMatch(/nothingExpiring: 'Nothing is close to its date among the \{n\} batches on record\.'/);
    expect(view).toMatch(/noBatchesYet: '[஀-௿]/);
  });

  it('Customer cases: "every resolved case has a root cause" is said only when a case was resolved; no case at all says so', () => {
    const view = read('apps/web-erp/web/service-desk.js');
    expect(view).toMatch(/resolved === 0 \? t\('noneResolved'\) : t\('allExplained'\)/);
    expect(view).toMatch(/noneResolved: 'No case has been resolved yet, so there is no root cause to record\.'/);
    expect(view).toMatch(/none: 'No cases yet — head office holds no case for this shop\.'/);
    expect(view).toMatch(/noneResolved: '[஀-௿]/);
  });

  it('the owner\'s phone: an empty attention, alert or approval list is "not known" when the phone has never synced or is stale', () => {
    const view = read('apps/owner-app/web/app.js');
    // Merged with main's UI-3 `emptyLine` (5 Nov 2026): one helper, "not known" when never synced AND when stale.
    expect(view).toMatch(/function emptyLine\(words, freshness\)/);
    expect(view).toMatch(/freshness\.state === 'stale' \? `\$\{t\('notKnownStale'\)\} \$\{ageInWords\(freshness\.ageSeconds\)\}\.`/);
    expect(view).toMatch(/freshness\.state === 'missing' \? t\('notKnownNoData'\)/); // main's UI-3 word for the never-synced case
    expect(view).toMatch(/freshness\.state === 'stale' \? `\$\{t\('notKnownStale'\)\} \$\{ageInWords\(freshness\.ageSeconds\)\}\.`/);
    expect(view.match(/const none = emptyLine\(t\('(nothingToDecide|noAlerts|nothingWaiting)'\), freshness\)/g)).toHaveLength(3);
    expect(view).toMatch(/notKnownNever: 'Not known — no data has ever reached this phone\.'/);
    expect(view).toMatch(/notKnownStale: 'Not known — the last word from the shop was'/);
    expect(view).toMatch(/notKnownNever: '[஀-௿]/);
    expect(view).toMatch(/notKnownStale: '[஀-௿]/);
  });
});

describe('a sample stand-in is shown only off the store computer (P-08)', () => {
  // The box injects `shopTimeZone` on EVERY screen it serves (screen-server.ts), payload or none — so a page with no
  // payload AND that global is a real box that was told nothing, and says so; a page with neither is a bare file.
  const servedByBox = /const servedByBox = window\.shopTimeZone !== undefined/;

  it('Products nobody can sell: on the box with no catalogue it says the list is not known, never the sample', () => {
    const view = read('apps/web-erp/web/unsellable.js');
    expect(view).toMatch(servedByBox);
    expect(view).toMatch(/el\('sample'\)\.hidden = real !== undefined \|\| servedByBox/);
    expect(view).toMatch(/notTold: 'Not known — the store computer has not been given the catalogue yet, so it cannot say what nobody can sell\.'/);
    expect(view).toMatch(/notTold: '[஀-௿]/);
  });

  it('Migration: on the box it never shows the sample figures', () => {
    const view = read('apps/web-erp/web/migration.js');
    expect(view).toMatch(servedByBox);
    expect(view).toMatch(/el\('sample'\)\.hidden = real !== undefined \|\| servedByBox/);
    expect(view).toMatch(/notTold: 'Not known — the store computer has not been given the migration setup yet/);
  });

  for (const [app, word] of [['picker-app', 'noWave'], ['delivery-app', 'noRoute']] as const) {
    it(`${app}: on the box with no work it says none is assigned yet, never the sample`, () => {
      const view = read(`apps/${app}/web/app.js`);
      expect(view).toMatch(servedByBox);
      expect(view).toMatch(/el\('sample'\)\.hidden = real !== undefined \|\| servedByBox/);
      expect(view).toMatch(new RegExp(`real === undefined && \\(window\\.\\w+Data !== undefined \\|\\| servedByBox\\)`));
      expect(view).toMatch(new RegExp(`${word}: '`));
    });
  }
});
