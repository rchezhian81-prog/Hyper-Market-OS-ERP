import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **U2 (UI/UX gap audit G5, G14, G16) — five of the HARD pages pick a thing by name instead of typing its code.**
 *
 * Record a write-off (both forms and the free sample), Store tasks, Delegation, Quotations and Customer cases asked a shop
 * person for a product id, a place id, a sign-in id (`u-ravi`), a store code, a customer code, an approval id or a typed
 * case number. Each now mounts the chrome's picker on those fields (`sreOffice.pick`, the typed code kept as the fallback
 * when the list cannot be read — never a dead end), takes its dates through the shared dd/mm field, fills in the person's
 * own store, and the case number is GIVEN by the page, never typed. Static: the files say so, in both languages.
 */

const web = (f: string): string => readFileSync(`apps/web-erp/web/${f}`, 'utf8');
const src = (f: string): string => readFileSync(`apps/web-erp/src/${f}`, 'utf8');

const PICKS: Record<string, { readonly file: string; readonly fields: readonly string[] }> = {
  'write-off-capture.js': { file: 'write-off-capture.js', fields: ['wo-product', 'wo-location'] },
  'write-off-queue.js': { file: 'write-off-queue.js', fields: ['woq-product', 'woq-location', 'fs-product', 'fs-location'] },
  'store-tasks.js': { file: 'store-tasks.js', fields: ['a-person', 'a-branch'] },
  'delegation.js': { file: 'delegation.js', fields: ['from', 'to'] },
  'quotations.js': { file: 'quotations.js', fields: ['q-store', 'q-customer', 'l-code', 'q-approval'] },
  'service-desk.js': { file: 'service-desk.js', fields: ['new-customer'] },
};

describe('U2: the five HARD pages pick things by name', () => {
  it('every id/code field is mounted on the chrome picker, the typed code kept as the fallback', () => {
    for (const { file, fields } of Object.values(PICKS)) {
      const js = web(file);
      expect(js, `${file} reaches the picker`).toMatch(/window\.sreOffice/);
      expect(js, `${file} calls the chrome's pick`).toMatch(/office\.pick\(\{ kind/);
      for (const id of fields) expect(js, `${file}: #${id} is pickable`).toMatch(new RegExp(`pickable\\('${id}'`));
      expect(js, `${file} says the typed code stays the fallback`).toMatch(/allowCode: true/);
    }
  });

  it('dates go through the shared dd/mm field and are read as ISO from it', () => {
    for (const [file, ids] of [['delegation.js', ['from-date', 'until-date']], ['quotations.js', ['q-until']]] as const) {
      const js = web(file);
      for (const id of ids) expect(js, `${file}: #${id} is a shared date field`).toMatch(new RegExp(`dateable\\('${id}'`));
      expect(js, `${file} reads the date through the chrome`).toMatch(/dateValue/);
    }
  });

  it('no label on these pages asks for an id or a code to be typed (English and Tamil)', () => {
    const storeOps = src('store-ops-session.ts');
    expect(storeOps).not.toMatch(/tkPerson: 'Who does it \(their sign-in id\)'/);
    expect(storeOps).toMatch(/tkPerson: 'Who does it'/);
    expect(storeOps).not.toMatch(/tkPerson: '[^']*உள்நுழைவு அடையாளம்[^']*'/);
    const quotations = src('quotations-session.ts');
    expect(quotations).not.toMatch(/store: 'Store code'/);
    expect(quotations).not.toMatch(/approval: 'Approval id/);
    expect(quotations).not.toMatch(/store: 'கடைக் குறியீடு'/);
    expect(quotations).not.toMatch(/approval: 'அனுமதி அடையாளம்/);
    const desk = web('service-desk.js');
    expect(desk).not.toMatch(/customer: 'Customer code'/);
    expect(desk).not.toMatch(/customer: 'வாடிக்கையாளர் குறியீடு'/);
    const deskHtml = web('service-desk.html');
    expect(deskHtml, 'the case number is given, never typed').toMatch(/<input id="new-id"[^>]*readonly/);
  });

  it('the case number is proposed by the page from what it reads, and the store is filled in from the sign-in', () => {
    expect(web('service-desk.js')).toMatch(/function proposeCaseNumber/);
    expect(web('quotations.js')).toMatch(/quotationsData\?\.storeId|sreOffice\.me\(\)/);
  });

  it('every new word has a Tamil twin', () => {
    for (const file of ['write-off-capture.js', 'write-off-queue.js', 'store-tasks.js', 'delegation.js', 'quotations.js', 'service-desk.js']) {
      const js = web(file);
      const en = js.match(/pickWords[\s\S]*?en:\s*\{([^}]*)\}/);
      const ta = js.match(/pickWords[\s\S]*?ta:\s*\{([^}]*)\}/);
      expect(en, `${file} carries the picker words`).not.toBeNull();
      expect(ta, `${file} carries them in Tamil`).not.toBeNull();
      const keys = (s: string): string[] => [...s.matchAll(/(\w+):/g)].map((m) => m[1]!);
      expect(keys(ta![1]!).sort()).toEqual(keys(en![1]!).sort());
    }
  });
});
