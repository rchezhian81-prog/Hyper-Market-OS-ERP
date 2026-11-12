import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { expectChromePickableKeepsTheRules, expectNoFallbackSwitchedOff, usesChromePickable } from '../support/picker-pins';
import { beforeFixture } from '../support/before-fixture';

/**
 * **U2b (UI/UX gap audit G5, G14, G16) — the people and stock pages pick a thing by name instead of typing its code, and
 * write a date as the shop writes it.**
 *
 * After U2 put the chrome's picker on the ten HARD pages, these pages still asked a shop person for a staff id (`u-ravi`),
 * a supplier id, an approval id, a location id, a product id, a store code, a procedure id, or a typed "YYYY-MM-DD".
 * Each now mounts the chrome's picker on those fields (`sreOffice.pick`, the typed code kept as the fallback when the
 * list cannot be read — never a dead end), takes a thing the page already lists from that list (a case, a procedure, a
 * route, an order), gives a new record's number itself, and takes its dates through the shared dd/mm field or a list
 * of months / financial years. Static: the files say so, in both languages; a bite test reads the commit before U2b.
 */

const web = (f: string): string => readFileSync(`apps/web-erp/web/${f}`, 'utf8');
const src = (f: string): string => readFileSync(`apps/web-erp/src/${f}`, 'utf8');

const PICKS: Record<string, readonly string[]> = {
  'loss-prevention.js': ['together-id', 'open-assignee', 'cctv-by'],
  'related-parties.js': ['a-emp', 'w-emp', 'a-ref'],
  'adoption.js': ['t-emp', 'hd-emp'],
  'appointment-letters.js': ['mk-emp'],
  'help.js': ['d-branch', 'd-who'],
  'warehouse.js': ['t-from', 't-to', 'k-bin', 't-product', 'k-product', 'k-assignee'],
  'dispatch.js': ['picker', 'off-driver'],
  'schedule.js': ['branch'],
  'store-computers.js': ['f-store'],
  'incidents.js': ['a-owner'],
};

describe('U2b: the people and stock pages pick things by name', () => {
  it('every id/code field is mounted on the chrome picker, the typed code kept as the fallback', () => {
    for (const [file, fields] of Object.entries(PICKS)) {
      const js = web(file);
      expect(js, `${file} reaches the picker`).toMatch(/window\.sreOffice/);
      for (const id of fields) expect(js, `${file}: #${id} is pickable`).toMatch(new RegExp(`pickable\\('${id}'`));
      if (usesChromePickable(js)) { expectChromePickableKeepsTheRules(); expectNoFallbackSwitchedOff(js, file); }
      else {
        expect(js, `${file} calls the chrome's pick`).toMatch(/office\.pick\(\{ kind/);
        expect(js, `${file} says the typed code stays the fallback`).toMatch(/allowCode: true/);
      }
    }
    // the per-unit form on Returned goods builds its inputs itself: the supplier and the approval are mounted on the element
    const held = web('held-returns.js');
    expect(held).toMatch(/pickableEl\(supplier, 'supplier', 'pickSupplier'\)/);
    expect(held).toMatch(/pickableEl\(approval, 'approval', 'pickApproval'/);
    if (usesChromePickable(held)) { expectChromePickableKeepsTheRules(); expectNoFallbackSwitchedOff(held, 'held-returns.js'); } // U5: the chrome's one copy
    else expect(held).toMatch(/allowCode: true/);
  });

  it('the subject on Investigations is a product or a person by what the person chose to look at', () => {
    expect(web('loss-prevention.js')).toMatch(/kindOf: \(\) => \(el\('together-kind'\)\.value === 'cashier' \? 'person' : 'product'\)/);
  });

  it('a thing the page already lists is taken from that list, and a new record\'s number is given by the page', () => {
    const lp = web('loss-prevention.js');
    expect(lp, 'the CCTV reference offers the open cases').toMatch(/el\('case-list'\)/);
    expect(web('loss-prevention.html')).toMatch(/<input id="cctv-case"[^>]*list="case-list"/);
    expect(lp, 'a new case number is proposed from the shop\'s day').toMatch(/function proposeCaseId\(\)/);
    expect(lp).toMatch(/window\.sreShopDay\?\.today\?\.\(\)/);
    expect(web('related-parties.js'), 'a new entry\'s code is given').toMatch(/`RP-\$\{parties\.parties\.length \+ 1\}`/);
    expect(web('adoption.html'), 'the curriculum item from the list').toMatch(/<input id="t-item"[^>]*list="t-item-list"/);
    expect(web('adoption.js')).toMatch(/itemOption\(i\.itemId, titleOf\(i\)\)/);
    expect(web('help.html'), 'the drill\'s procedure from the list').toMatch(/<input id="d-sop"[^>]*list="d-sop-list"/);
    expect(web('help.js')).toMatch(/\$\('d-sop-list'\)/);
    expect(web('help.html'), 'the roles from a list').toMatch(/<input id="w-roles"[^>]*list="w-roles-list"/);
    expect(web('dispatch.js'), 'the wave number is given').toMatch(/const mintWaveId = \(\) => `W-/);
    expect(web('dispatch.html'), 'the route from the board').toMatch(/<input id="settle-route"[^>]*list="route-list"/);
    expect(web('order-refunds.js'), 'a tap on a pending row fills the order').toMatch(/li\.addEventListener\('click', \(\) => \{ \$\('order-id'\)\.value = r\.orderId; \}\)/);
    expect(web('order-refunds.html')).toMatch(/<input id="order-id"[^>]*list="order-list"/);
  });

  it('dates go through the shared dd/mm field and are read as ISO from it; a month or a financial year is picked from a list', () => {
    for (const [file, ids] of [['scales.js', ['f-stamped', 'f-valid']], ['loss-prevention.js', ['together-from', 'together-to']], ['migration.js', ['ec-date', 'day-date']], ['ai.js', ['period']]] as const) {
      const js = web(file);
      for (const id of ids) expect(js, `${file}: #${id} is a shared date field`).toMatch(new RegExp(`shopDate\\('${id}'`));
      expect(js, `${file} reads the date through the chrome`).toMatch(/dateValue/);
    }
    const conc = web('concessions.js');
    for (const id of ['f-start', 'f-end', 'f-ins', 'f-lic', 'm-from', 'm-to']) {
      expect(conc, `concessions: #${id} read as ISO`).toMatch(new RegExp(`dateOf\\('${id}'\\)`));
      expect(conc, `concessions: #${id} not read raw`).not.toMatch(new RegExp(`\\$\\('${id}'\\)\\.value`));
    }
    expect(conc).toMatch(/\['f-start', 'startsOn'\], \['f-end', 'endsOn'\], \['f-ins', 'insurance'\], \['f-lic', 'licence'\], \['m-from', 'from'\], \['m-to', 'to'\]/);
    expect(web('scales.js'), 'the scales form reads its two dates through the chrome').toMatch(/DATE_FIELDS\.has\(id\) \? dateOf\(id\) : \$\(id\)\.value/);
    expect(web('migration.js')).not.toMatch(/el\('day-date'\)\.value/);
    expect(web('migration.js')).not.toMatch(/el\('ec-date'\)\.value/);
    expect(web('ai.js')).not.toMatch(/el\('period'\)\.value/);
    expect(web('epr.js'), 'the financial year is a list of the last five').toMatch(/function fyList\(\)/);
    expect(web('epr.js')).toMatch(/for \(let k = 0; k < 5; k \+= 1\)/);
    expect(web('app.js'), 'the month of manufacture is a list of the last 36 months').toMatch(/function mfgMonthList\(\)/);
    expect(web('app.js')).toMatch(/for \(let k = 0; k < 36; k \+= 1\)/);
    expect(web('app.js'), 'the list is built from the shop\'s own day, never the device clock').not.toMatch(/mfgMonthList[\s\S]*new Date\(\)/);
  });

  it('no label on these pages asks for an id, a code or a format to be typed (English and Tamil)', () => {
    for (const [file, bad] of [
      ['related-parties-session.ts', ["employee: 'Staff id'", "partyId: 'Entry id'", "needEmployee: 'Type the staff id", "employee: 'பணியாளர் எண்'", "partyId: 'பதிவு எண்'"]],
      ['adoption-session.ts', ["employee: 'Staff id'", "champion: 'Champion (staff id)'", "employee: 'பணியாளர் எண்'", "champion: 'சாம்பியன் (பணியாளர் எண்)'"]],
      ['appointment-letters-session.ts', ["employee: 'Staff id'", "employee: 'பணியாளர் எண்'"]],
      ['incidents-session.ts', ["aOwner: 'Who owns it (their sign-in id)'", "உள்நுழைவு அடையாளம்"]],
      ['help-session.ts', ["sopId: 'Procedure id'", "sopId: 'நடைமுறை எண்'"]],
      ['lp-correlation-session.ts', ["subjectId: 'Product code or cashier'", "subjectId: 'பொருள் குறியீடு அல்லது காசாளர்'"]],
      ['scales-session.ts', ['YYYY-MM-DD']],
    ] as const) {
      const t = src(file);
      for (const b of bad) expect(t, `${file} still says ${b}`).not.toContain(b);
    }
    expect(src('related-parties-session.ts')).toMatch(/employee: 'Staff member'/);
    expect(src('related-parties-session.ts')).toMatch(/employee: 'பணியாளர்'/);
    expect(src('incidents-session.ts')).toMatch(/aOwner: 'Who owns it'/);
    expect(src('incidents-session.ts')).toMatch(/aOwner: 'பொறுப்பாளர்'/);
    expect(src('scales-session.ts')).toMatch(/notDate: 'Pick both dates first\. Nothing was sent\.'/);
    const held = web('held-returns.js');
    expect(held).not.toContain("approvalLabel: 'Approval id (big loss)'");
    expect(held).toContain("approvalLabel: 'Approval (big loss)'");
    expect(held).toContain("approvalLabel: 'அனுமதி (பெரிய இழப்பு)'");
    expect(web('app.js')).not.toContain("mfgHint: 'As printed on the pack, for example 2026-09.");
    expect(web('app.js')).toContain("mfgHint: 'Pick the month printed on the pack.");
  });

  it('every picker word has a Tamil twin on every page that mounts one', () => {
    for (const file of [...Object.keys(PICKS), 'held-returns.js']) {
      const js = web(file);
      const line = /const u2bWords = Object\.freeze\(\{ en: \{ (.*?) \}, ta: \{ (.*?) \} \}\);/.exec(js);
      expect(line, `${file} carries its picker words in both languages on one line`).not.toBeNull();
      const keys = (block: string): string[] => [...block.matchAll(/(\w+): '/g)].map((m) => m[1]!);
      expect(keys(line![1]!).length).toBeGreaterThan(5);
      expect(keys(line![2]!), `${file}: every picker word has a Tamil twin`).toEqual(keys(line![1]!));
    }
  });

  it('bites: the pages as they were before U2b (commit 6bc69ed) typed the codes', () => {
    const before = beforeFixture('6bc69ed', 'apps/web-erp/web/warehouse.js');
    expect(before).not.toMatch(/pickable\('t-from'/);
    const session = beforeFixture('6bc69ed', 'apps/web-erp/src/incidents-session.ts');
    expect(session).toContain("aOwner: 'Who owns it (their sign-in id)'");
  });
});
