import { describe, it, expect } from 'vitest';
import { createUnsellableSession, UNSELLABLE_COPY, COPY_KEYS, UNSELLABLE_REASONS, type UnsellableRow } from '../../apps/web-erp/src/unsellable-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * SP-8c-ii (F08 · P-08 · M03-FR-03 · M10-FR-04): the "Products nobody can sell" screen's DOM-free session model. It presents
 * the list the box builds the till's catalogue from — grouped by WHY, recall first, each with what to do, in both languages —
 * and says plainly when the box had no catalogue to judge, rather than "all clear".
 */

const ROWS: UnsellableRow[] = [
  { productId: 'p-unit', name: 'Odd unit', nameTa: 'வித்தியாச அலகு', reason: 'unknown_uom', detail: 'unknown unit of measure "each" on the catalogue' },
  { productId: 'p-tax-b', name: 'No tax B', reason: 'no_tax_rate', detail: 'no tax rate on the catalogue' },
  { productId: 'p-recall', name: 'Recalled tin', reason: 'recall_block', detail: 'recall block set on the catalogue — refused at the till by name' },
  { productId: 'p-tax-a', name: 'No tax A', reason: 'no_tax_rate', detail: 'no tax rate on the catalogue' },
  { productId: 'p-draft', name: 'Not yet', reason: 'not_on_sale', detail: 'status "draft" on the catalogue — refused at the till' },
];
const AS_AT = '2026-10-01T06:00:00.000Z';

describe('the copy is complete in both languages', () => {
  it('has no gap in either language, and a label + what-to-do for every reason the box can give', () => {
    const gaps = bilingualGaps(UNSELLABLE_COPY, COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
    for (const reason of UNSELLABLE_REASONS) {
      expect(COPY_KEYS).toContain(`r_${reason}`);
      expect(COPY_KEYS).toContain(`d_${reason}`);
    }
  });
});

describe('the list, recall first, each with what to do (P-08)', () => {
  it('groups by reason in the order a person should look — recall before the catalogue gaps — sorted by product within a group, with a count against the sellable ones', () => {
    const v = createUnsellableSession({ storeId: 'S1', asAt: AS_AT, rows: ROWS, sellableCount: 120 }).view('en');
    expect(v.screenState).toMatchObject({ tone: 'ok', label: 'Every product below is refused at the till or was never given to it.' });
    expect(v.asOf).toBe(AS_AT);
    expect([v.count, v.countLabel, v.sellableCount]).toEqual([5, '5 products nobody can sell', 120]);
    expect(v.groups.map((g) => [g.reason, g.rows.map((r) => r.productId)])).toEqual([
      ['recall_block', ['p-recall']], ['no_tax_rate', ['p-tax-a', 'p-tax-b']], ['unknown_uom', ['p-unit']], ['not_on_sale', ['p-draft']],
    ]);
    expect(v.groups[0]).toMatchObject({ label: 'Under recall — the till refuses it by name, even offline', whatToDo: expect.stringContaining('Expiry & recalls') });
    expect(v.rows.map((r) => r.productId)).toEqual(['p-recall', 'p-tax-a', 'p-tax-b', 'p-unit', 'p-draft']);
  });

  it('every row is a tone AND an icon AND a word, never colour alone; a recall is the error tone, a catalogue gap the degraded tone; the box\'s own sentence rides along', () => {
    const v = createUnsellableSession({ rows: ROWS }).view('en');
    for (const r of v.rows) {
      expect(r.status.needsAttention).toBe(true);
      expect(r.status.icon.trim().length).toBeGreaterThan(0);
      expect(r.status.label.length).toBeGreaterThan(0);
      expect((r.status.announcement ?? '').length).toBeGreaterThan(0);
      expect(r.whatToDo.length).toBeGreaterThan(10);
    }
    expect(v.rows.find((r) => r.productId === 'p-recall')?.status.tone).toBe('error');
    expect(v.rows.find((r) => r.productId === 'p-unit')).toMatchObject({ status: { tone: 'degraded' }, detail: 'unknown unit of measure "each" on the catalogue' });
  });

  it('speaks Tamil when asked — the product\'s Tamil name where it has one, the reason and what to do in Tamil', () => {
    const v = createUnsellableSession({ rows: ROWS, sellableCount: 3 }).view('ta');
    expect(v.countLabel).toBe('யாரும் விற்க முடியாத பொருட்கள் 5');
    const unit = v.rows.find((r) => r.productId === 'p-unit')!;
    expect(unit.name).toBe('வித்தியாச அலகு');
    expect(unit.reasonLabel).toBe(UNSELLABLE_COPY.ta.r_unknown_uom);
    expect(unit.whatToDo).toBe(UNSELLABLE_COPY.ta.d_unknown_uom);
    expect(v.rows.find((r) => r.productId === 'p-recall')?.name).toBe('Recalled tin'); // no Tamil name → the one it has
    expect(createUnsellableSession({ rows: [ROWS[0]!] }).view('ta').countLabel).toBe('யாரும் விற்க முடியாத பொருள் 1');
  });

  it('a clean catalogue says every product can be sold; a box with no catalogue says it cannot say — never "all clear" by default', () => {
    const clean = createUnsellableSession({ asAt: AS_AT, rows: [], sellableCount: 40 }).view('en');
    expect(clean.screenState).toMatchObject({ tone: 'idle', label: 'Every product in the catalogue can be sold at the till.' });
    expect([clean.count, clean.groups, clean.sellableCount]).toEqual([0, [], 40]);
    const unknown = createUnsellableSession({}).view('en');
    expect(unknown.screenState).toMatchObject({ tone: 'idle', label: expect.stringContaining('has not been given a catalogue') });
    expect([unknown.count, unknown.asOf, unknown.sellableCount]).toEqual([0, null, null]);
  });

  it('a reason this screen does not know is still a product nobody can sell — shown under "not on sale", never dropped', () => {
    const v = createUnsellableSession({ rows: [{ productId: 'p-x', name: 'X', reason: 'something_new' as UnsellableRow['reason'], detail: 'the box said so' }] }).view('en');
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]).toMatchObject({ reason: 'not_on_sale', detail: 'the box said so' });
  });
});
