import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSupplierBillsSession } from '../../apps/web-erp/src/supplier-bills-session';
import { permissionWords } from '../../apps/web-erp/src/role-change-session';

/**
 * **OB-827 A (owner, 16 Nov 2026): "See supplier bills", view only (`purchase.invoice.read`).** A person who holds it (and
 * the bill register read their role already has) sees the Supplier bills page's list and each bill's match result; nothing
 * is handed in, typed, checked, held or paid with it — those keep their own words, which head office checks on every route.
 */

const noCall = async () => { throw new Error('nothing is asked of head office here'); };

describe('OB-827 A: Supplier bills, view only', () => {
  it('a view-only holder may see, and may not hand in, type or match', () => {
    const s = createSupplierBillsSession(noCall as never, { permissions: ['purchase.invoice.read', 'purchase.commitment.read'] });
    expect(s.mayView).toBe(true);
    expect(s.mayReadBills).toBe(true);
    expect(s.mayCapture).toBe(false);
    expect(s.mayMatch).toBe(false);
  });
  it('without it, nothing about the bills is offered', () => {
    const s = createSupplierBillsSession(noCall as never, { permissions: ['purchase.commitment.read'] });
    expect(s.mayView).toBe(false);
  });
  it('the menu opens Supplier bills with the view-only word too', () => {
    const nav = readFileSync('apps/web-erp/src/navigation.ts', 'utf8');
    expect(nav).toMatch(/id: 'supplier-bills'[^\n]*requires: 'purchase\.invoice\.match', alsoOpenedWith: \['purchase\.invoice\.read'\]/);
  });
  it('the page says "view only" in both languages, and the match button stays the matcher\'s', () => {
    const page = readFileSync('apps/web-erp/web/supplier-bills.js', 'utf8');
    expect(page.match(/mayViewOnly:/g)).toHaveLength(2);
    expect(page).toContain("$('run-match').hidden = !(session !== null && session.mayMatch);");
  });
  it('the switch on the two-person screen reads in plain words', () => {
    expect(permissionWords('purchase.invoice.read', 'en')).toBe('See supplier bills (view only)');
    expect(permissionWords('purchase.invoice.read', 'ta')).toMatch(/பார்வைக்கு மட்டும்/);
  });
});
