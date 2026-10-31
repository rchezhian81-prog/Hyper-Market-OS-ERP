import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { officeQuantityLabel } from '../../apps/web-erp/src/browser-entry';

// OB-31 · screen audit 31 Oct 2026 ("grams shown where kg is expected"). Every held quantity is the unit's smallest step —
// grams for a kg product — so an office page that printed `${quantityMinor} ${uom}` showed 2.5 kg of rice as "2500 kg".
// The pages now word it through one helper the bundle attaches (`window.sreQuantity.label`), the till's `quantityLabel`
// for kg and litres; a count of items keeps the words the pages already used.

describe('office pages read a weighed quantity in kg, not grams', () => {
  it('2500 of a kg product reads "2.500 kg"; 1250 of a litre product "1.250 L"; items are unchanged', () => {
    expect(officeQuantityLabel(2_500, 'kg')).toBe('2.500 kg');
    expect(officeQuantityLabel(2_500, 'KG')).toBe('2.500 kg');
    expect(officeQuantityLabel(1_250, 'LTR')).toBe('1.250 L');
    expect(officeQuantityLabel(10, 'EA')).toBe('10 EA');
    expect(officeQuantityLabel(1, 'ea')).toBe('1 ea');
    expect(officeQuantityLabel(500, 'g')).toBe('500 g');
    expect(officeQuantityLabel(7, '')).toBe('7');
  });

  const PAGES = ['count-plans', 'held-returns', 'indents', 'transfers'] as const;

  it.each(PAGES)('%s.js words its quantity-with-unit through the shared helper, never `${quantityMinor} ${uom}`', (page) => {
    const src = readFileSync(`apps/web-erp/web/${page}.js`, 'utf8');
    expect(src).toContain('window.sreQuantity');
    expect(src).not.toMatch(/\$\{[\w.?]*quantityMinor\} ?\$\{[\w.?]*uom/);
  });

  it('the bundle attaches the helper every page reads', () => {
    expect(readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8')).toMatch(/browserWindow\.sreQuantity = Object\.freeze\(\{ label: officeQuantityLabel \}\)/);
  });
});
