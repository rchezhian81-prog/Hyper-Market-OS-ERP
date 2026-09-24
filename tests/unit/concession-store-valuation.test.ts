import { describe, it, expect } from 'vitest';
import { splitStoreValuation, type OwnedStockValue } from '../../packages/concession/src/index';
import { checkMovement, ownershipOf, type Movement } from '../../services/inventory/src/index';

// M27-FR-02 — the two pure pieces that keep concession stock out of the store's books.
//
//  • `splitStoreValuation` takes stock already valued per owner (folded from the M08 ledger at
//    weighted-average cost) and reports what the STORE owns, EXCLUDING and NAMING what it does not.
//  • the M08 ledger's own validation: stock marked as somebody else's must say WHOSE, or it cannot
//    be told apart from the store's own — `checkMovement` refuses it, `ownershipOf` defaults to own.

const row = (over: Partial<OwnedStockValue> = {}): OwnedStockValue => ({
  productId: 'RICE', locationId: 'L1', ownership: 'own', ownerId: 'store', valueMinor: 0, onHandMinor: 0, ...over,
});

describe('splitStoreValuation — the store owns only what it owns (M27-FR-02)', () => {
  it('values only the store\'s own stock, all owned', () => {
    const r = splitStoreValuation({
      branchId: 'L1',
      rows: [row({ valueMinor: 5_000, onHandMinor: 10 }), row({ productId: 'OIL', valueMinor: 3_000, onHandMinor: 4 })],
    });
    expect(r.ownedValueMinor).toBe(8_000);
    expect(r.ownedLots).toBe(2);
    expect(r.excluded).toEqual([]);
    expect(r.excludedValueMinor).toBe(0);
    expect(r.detail).toContain('all owned by the store');
  });

  it('excludes concession stock and NAMES its owner, never silently dropping it', () => {
    const r = splitStoreValuation({
      branchId: 'L1',
      rows: [
        row({ valueMinor: 5_000, onHandMinor: 10 }),
        row({ productId: 'GOLD', ownership: 'concession', ownerId: 'jeweller-1', valueMinor: 4_000_000, onHandMinor: 2 }),
      ],
    });
    expect(r.ownedValueMinor).toBe(5_000);       // the ₹40,00,000 of gold is NOT in the store's value
    expect(r.excludedValueMinor).toBe(4_000_000);
    expect(r.excluded).toEqual([{ ownership: 'concession', ownerId: 'jeweller-1', lots: 1, valueMinor: 4_000_000 }]);
    expect(r.detail).toContain('belongs to somebody else and is EXCLUDED');
  });

  it('groups the excluded stock by owner and ownership', () => {
    const r = splitStoreValuation({
      branchId: 'L1',
      rows: [
        row({ ownership: 'concession', ownerId: 'jeweller-1', productId: 'RING', valueMinor: 100, onHandMinor: 1 }),
        row({ ownership: 'concession', ownerId: 'jeweller-1', productId: 'CHAIN', valueMinor: 200, onHandMinor: 1 }),
        row({ ownership: 'consignment', ownerId: 'phones-co', productId: 'PHONE', valueMinor: 900, onHandMinor: 3 }),
      ],
    });
    expect(r.ownedValueMinor).toBe(0);
    expect(r.excluded).toEqual([
      { ownership: 'concession', ownerId: 'jeweller-1', lots: 2, valueMinor: 300 },
      { ownership: 'consignment', ownerId: 'phones-co', lots: 1, valueMinor: 900 },
    ]);
    expect(r.excludedValueMinor).toBe(1_200);
  });

  it('values only the branch asked for', () => {
    const r = splitStoreValuation({
      branchId: 'L1',
      rows: [row({ valueMinor: 5_000, onHandMinor: 10 }), row({ locationId: 'L2', valueMinor: 9_999, onHandMinor: 1 })],
    });
    expect(r.ownedValueMinor).toBe(5_000); // L2 stock is another branch's valuation, not this one's
    expect(r.ownedLots).toBe(1);
  });
});

const mv = (over: Partial<Movement> = {}): Movement => ({
  movementId: 'm1', productId: 'RICE', locationId: 'L1', kind: 'received',
  quantityMinor: 5, uom: 'each', occurredAt: '2026-09-24T10:00:00.000Z', enteredBy: 'u-owner', ...over,
});

describe('the M08 ledger carries ownership, and refuses stock with no owner (M27-FR-02)', () => {
  it('accepts a movement with no ownership — it is the store\'s own', () => {
    const m = mv();
    expect(checkMovement(m).ok).toBe(true);
    expect(ownershipOf(m)).toBe('own');
  });

  it('accepts concession stock that names its owner', () => {
    const m = mv({ ownership: 'concession', ownerId: 'jeweller-1' });
    expect(checkMovement(m).ok).toBe(true);
    expect(ownershipOf(m)).toBe('concession');
  });

  it('refuses non-own stock with no owner — it could not be told apart from the store\'s own', () => {
    const check = checkMovement(mv({ ownership: 'concession' }));
    expect(check.ok).toBe(false);
    expect(check.refusedBecause).toBe('ownership_without_an_owner');
    expect(checkMovement(mv({ ownership: 'consignment', ownerId: '   ' })).refusedBecause).toBe('ownership_without_an_owner');
  });
});
