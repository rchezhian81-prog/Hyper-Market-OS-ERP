import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * D-10 (R4, OB-227): "Each supplier's scorecard is built from its own purchase orders, goods receipts and matched invoices,
 * with no typed figures." The claim is structural, so it is pinned on the source: the scorecard route reads only the
 * registers (through `deps.facts`, fed by `supplierFactsFor`), never the retired typed delivery-outcome register, and the
 * old typed door writes nothing.
 */
const code = (p: string): string => readFileSync(p, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const ROUTE = code('services/purchase/src/supplier-scorecard.ts');
const FACTS = code('services/api/src/r4-supply-lp-adapters.ts');

describe('a supplier scorecard takes no typed figure (D-10)', () => {
  it('the scorecard is the derived engine over the registers — never the typed outcomes, never the old typed scorer', () => {
    expect(ROUTE).toMatch(/deriveSupplierScorecard\(/);
    expect(ROUTE).not.toMatch(/deps\.receipts\(/);
    expect(ROUTE).not.toMatch(/deps\.recordReceipt\(/);
    expect(ROUTE).not.toMatch(/scoreSupplier\(/);
  });

  it('the old typed door answers 410 and saves nothing', () => {
    const door = ROUTE.slice(ROUTE.indexOf("path: '/v1/purchase/suppliers/:supplierId/receipts/:poId'"), ROUTE.indexOf("path: '/v1/purchase/contracts/:contractId'"));
    expect(door).toMatch(/apiError\(410/);
    expect(door).toMatch(/typed_delivery_outcome_retired/);
    expect(door).not.toMatch(/deps\./);
  });

  it('the facts come from the purchase-order fold, the goods receipts and the matched invoices — and are only read', () => {
    const from = FACTS.indexOf('export function supplierFactsFor');
    const facts = FACTS.slice(from, FACTS.indexOf('\n// ── ', from));
    expect(facts).toMatch(/foldPurchaseOrders\(/);
    expect(facts).toMatch(/goodsReceiptAdapter\(input\)\.all\(/);
    expect(facts).toMatch(/'InvoiceMatched'/);
    expect(facts).not.toMatch(/\.append\(|\.appendBatch\(/);
  });
});
