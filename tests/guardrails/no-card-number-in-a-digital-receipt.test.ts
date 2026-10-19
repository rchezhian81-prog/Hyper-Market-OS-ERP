import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { digitalCopyOf, type BankedSaleForCopy } from '../../packages/receipt/src/digital-copy';

/**
 * **Guardrail — a digital receipt carries a card's last four digits and nothing else (R4 · D-28 · hard rule #3).**
 *
 * Whatever a banked tender carries — a network token, a provider reference, or (from a hostile or broken till) fields
 * that should never exist — the member's copy shows "card ending NNNN" and the amount. The copy's code reads exactly one
 * card field, and the receipts service reads no tender reference at all.
 */

const code = (path: string): string => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const PAN_LIKE = '4111' + '1111' + '1111' + '1111';

describe('guardrail: no card number in a digital receipt (D-28 · hard rule #3)', () => {
  it('a hostile tender yields only the last four digits', () => {
    const hostile = {
      saleId: 's', receiptNumber: 'R1', tradingDay: '2026-10-19', committedAt: '2026-10-19T00:00:00.000Z', totalMinor: 100, currency: 'INR',
      lines: [{ productId: 'P', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 100, taxRateBps: 0 }],
      tenders: [{ kind: 'card', amountMinor: 100, ref: PAN_LIKE, card: { tokenRef: `ntok_${PAN_LIKE}`, last4: '1111', network: 'visa', pan: PAN_LIKE, expires: '12/29', securityCode: '123' } }],
    } as unknown as BankedSaleForCopy;
    const copy = JSON.stringify(digitalCopyOf(hostile));
    expect(copy).not.toContain(PAN_LIKE);
    expect(copy).not.toMatch(/ntok|tokenRef|12\/29|"123"|visa/);
    expect(copy).toContain('"cardLast4":"1111"');
  });

  it('the copy reads exactly one card field — last4 — and never a tender reference', () => {
    const src = code('packages/receipt/src/digital-copy.ts');
    const reads = [...src.matchAll(/\.card\?\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(new Set(['last4']));
    expect(src).not.toMatch(/\.ref\b|tokenRef/);
  });

  it('the receipts service and its wiring never touch a tender\'s reference or token', () => {
    for (const path of ['services/customer/src/digital-receipts.ts', 'services/api/src/r4-online-adapters.ts']) {
      expect(code(path), path).not.toMatch(/tokenRef|\.ref\b|tenders\[/);
    }
  });
});
