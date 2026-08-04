import { describe, it, expect } from 'vitest';
import {
  bookDockSlot,
  receiveScan,
  compareAgainstAsn,
  DockConflictError,
  DEFAULT_RECEIVING_POLICY,
  type Asn,
  type BarcodeResolution,
  type DockSlot,
  type OrderedProduct,
  type ReceiveCommand,
} from '../../packages/receiving/src/index';
import type { PackHierarchy } from '../../packages/product/src/index';
import { money } from '../../packages/contracts/src/money';

// M07-FR-01 — the handheld at the back door. Four things go wrong there that
// nothing downstream can fix.

const INR = 'INR' as const;
const AT = '2026-08-04T08:00:00Z';

const PACKS: PackHierarchy[] = [
  {
    productId: 'p-rice',
    baseUom: 'ea',
    levels: [
      { level: 'unit', containsMinor: 1, barcode: '890RICE' },
      { level: 'case', containsMinor: 24, barcode: '890RICECASE' },
    ],
  },
];

const BARCODES: BarcodeResolution[] = [
  { barcode: '890RICE', productId: 'p-rice', level: 'unit' },
  { barcode: '890RICECASE', productId: 'p-rice', level: 'case' },
  { barcode: '890MILK', productId: 'p-milk', level: 'unit' },
];

const ORDERED: OrderedProduct[] = [
  { productId: 'p-rice', quantityMinor: 100, unitCost: money(4_000, INR) },
];

function command(over: Partial<ReceiveCommand> = {}): ReceiveCommand {
  return {
    commandId: 'cmd-1',
    grnId: 'grn-1',
    storeId: 'store-1',
    receivedBy: 'receiver-1',
    at: AT,
    source: 'po',
    poId: 'po-1',
    barcode: '890RICE',
    scannedQuantity: 10,
    ...over,
  };
}

function scan(over: Partial<Parameters<typeof receiveScan>[0]> = {}) {
  return receiveScan({
    command: command(),
    appliedCommandIds: [],
    barcodes: BARCODES,
    packs: PACKS,
    ordered: ORDERED,
    ...over,
  });
}

describe('the double scan — a hesitating handheld must not double-count (§31.1)', () => {
  it('counts the first scan', () => {
    const result = scan();
    expect(result.accepted).toBe(true);
    expect(result.quantityMinor).toBe(10);
  });

  it('makes a repeat a genuine no-op that says so', () => {
    const result = scan({ appliedCommandIds: ['cmd-1'] });
    expect(result.outcome).toBe('duplicate_ignored');
    expect(result.accepted).toBe(false);
    expect(result.quantityMinor).toBe(0);
    expect(result.detail).toContain('scanning again changes nothing');
  });

  it('checks the repeat BEFORE anything stateful, so a retry never trips another rule', () => {
    // Same command id, but now it would also breach the over-delivery rule.
    const result = scan({
      command: command({ scannedQuantity: 500 }),
      appliedCommandIds: ['cmd-1'],
      receivedSoFar: { 'p-rice': 100 },
    });
    expect(result.outcome).toBe('duplicate_ignored');
  });
});

describe('the case counted as one', () => {
  it('converts a case scan to the correct unit count (acceptance)', () => {
    const result = scan({ command: command({ barcode: '890RICECASE', scannedQuantity: 2 }) });
    expect(result.quantityMinor).toBe(48); // 2 × 24
    expect(result.detail).toBe('2 × case = 48 unit(s) received');
  });

  it('refuses to guess when a case barcode has no pack definition', () => {
    const result = scan({
      command: command({ barcode: '890RICECASE', scannedQuantity: 2 }),
      packs: [],
    });
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain('the unit count would be a guess');
    expect(result.resolutionRequired).toBe(true);
  });
});

describe('the unknown barcode — never "closest match"', () => {
  it('sends it to the resolution queue and lets the delivery carry on', () => {
    const result = scan({ command: command({ barcode: '000UNKNOWN' }) });
    expect(result.outcome).toBe('unknown_barcode');
    expect(result.resolutionRequired).toBe(true);
    expect(result.detail).toContain('the delivery carries on');
  });

  it('refuses a product that is not on the order, suggesting the DSD path', () => {
    const result = scan({ command: command({ barcode: '890MILK' }) });
    expect(result.outcome).toBe('not_on_order');
    expect(result.detail).toContain('receive it as a DSD if it is genuinely being delivered');
  });
});

describe('the price edited at the door (§28)', () => {
  it('refuses a receiver changing the agreed price', () => {
    const result = scan({
      command: command({ declaredUnitCost: money(4_500, INR) }),
    });
    expect(result.outcome).toBe('price_change_refused');
    expect(result.detail).toContain('not the one that was convenient');
  });

  it('accepts a price that matches the order — nothing has changed', () => {
    expect(scan({ command: command({ declaredUnitCost: money(4_000, INR) }) }).accepted).toBe(true);
  });
});

describe('over-delivery — stock you did not choose to buy', () => {
  it('accepts a small over-delivery inside tolerance', () => {
    const result = scan({
      command: command({ scannedQuantity: 2 }),
      receivedSoFar: { 'p-rice': 100 },
    });
    expect(result.accepted).toBe(true); // 102 of 100, within 2%
  });

  it('needs approval beyond tolerance, and takes it from a second person', () => {
    const blocked = scan({
      command: command({ scannedQuantity: 20 }),
      receivedSoFar: { 'p-rice': 100 },
    });
    expect(blocked.outcome).toBe('over_delivery_needs_approval');
    expect(blocked.detail).toContain('stock you did not choose to buy');

    const selfApproved = scan({
      command: command({ scannedQuantity: 20 }),
      receivedSoFar: { 'p-rice': 100 },
      approval: { subjectRef: 'grn-1', status: 'approved', decidedBy: 'receiver-1' },
    });
    expect(selfApproved.accepted).toBe(false);

    const approved = scan({
      command: command({ scannedQuantity: 20 }),
      receivedSoFar: { 'p-rice': 100 },
      approval: { subjectRef: 'grn-1', status: 'approved', decidedBy: 'manager-1' },
    });
    expect(approved.accepted).toBe(true);
  });
});

describe('direct-store-delivery — the commonest way goods enter unaccounted', () => {
  const dsd = command({
    commandId: 'cmd-dsd',
    source: 'dsd',
    poId: undefined,
    barcode: '890MILK',
    scannedQuantity: 20,
    declaredUnitCost: money(3_000, INR),
  });

  it('needs a second person before it enters stock', () => {
    const result = scan({ command: dsd, ordered: undefined });
    expect(result.outcome).toBe('dsd_needs_approval');
    expect(result.detail).toContain('arriving with no purchase order');
  });

  it('accepts it once approved by someone other than the receiver', () => {
    const result = scan({
      command: dsd,
      ordered: undefined,
      approval: { subjectRef: 'grn-1', status: 'approved', decidedBy: 'manager-1' },
    });
    expect(result.accepted).toBe(true);
    expect(result.quantityMinor).toBe(20);
    expect(result.detail).toContain('approved by manager-1');
  });

  it('lets a tenant refuse deliveries without a purchase order entirely', () => {
    const result = scan({
      command: dsd,
      ordered: undefined,
      policy: { ...DEFAULT_RECEIVING_POLICY, allowDsd: false },
      approval: { subjectRef: 'grn-1', status: 'approved', decidedBy: 'manager-1' },
    });
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain('does not accept deliveries without a purchase order');
  });
});

describe('dock scheduling — two lorries at one door is a queue', () => {
  const slot: DockSlot = {
    slotId: 'ds-1',
    storeId: 'store-1',
    dockId: 'dock-A',
    startsAt: '2026-08-05T06:00:00Z',
    endsAt: '2026-08-05T07:00:00Z',
    status: 'booked',
  };

  it('books a free slot', () => {
    expect(bookDockSlot(slot, []).slotId).toBe('ds-1');
  });

  it('refuses an overlapping booking on the same dock', () => {
    expect(() =>
      bookDockSlot({ ...slot, slotId: 'ds-2', startsAt: '2026-08-05T06:30:00Z', endsAt: '2026-08-05T07:30:00Z' }, [slot]),
    ).toThrow(DockConflictError);
  });

  it('allows the same time on a different dock, and back-to-back on the same one', () => {
    expect(() =>
      bookDockSlot({ ...slot, slotId: 'ds-3', dockId: 'dock-B' }, [slot]),
    ).not.toThrow();
    expect(() =>
      bookDockSlot({ ...slot, slotId: 'ds-4', startsAt: '2026-08-05T07:00:00Z', endsAt: '2026-08-05T08:00:00Z' }, [slot]),
    ).not.toThrow();
  });

  it('frees the slot when a booking is cancelled or the lorry never came', () => {
    expect(() =>
      bookDockSlot({ ...slot, slotId: 'ds-5' }, [{ ...slot, status: 'cancelled' }]),
    ).not.toThrow();
    expect(() =>
      bookDockSlot({ ...slot, slotId: 'ds-6' }, [{ ...slot, status: 'no_show' }]),
    ).not.toThrow();
  });
});

describe('the ASN is a promise, not a receipt', () => {
  const asn: Asn = {
    asnId: 'asn-1',
    supplierId: 'sup-1',
    poId: 'po-1',
    expectedAt: '2026-08-05T06:00:00Z',
    lines: [
      { lineId: 'l1', productId: 'p-rice', quantityMinor: 100, uom: 'ea' },
      { lineId: 'l2', productId: 'p-milk', quantityMinor: 50, uom: 'ea' },
    ],
  };

  it('reports only what differs from the advice note', () => {
    const differences = compareAgainstAsn(asn, { 'p-rice': 100, 'p-milk': 44 });
    expect(differences).toHaveLength(1);
    expect(differences[0]?.productId).toBe('p-milk');
    expect(differences[0]?.differenceMinor).toBe(-6);
    expect(differences[0]?.detail).toContain('the note is a promise, not a receipt');
  });

  it('catches something delivered that was never advised', () => {
    const differences = compareAgainstAsn(asn, { 'p-rice': 100, 'p-milk': 50, 'p-oil': 12 });
    expect(differences[0]?.productId).toBe('p-oil');
    expect(differences[0]?.detail).toContain('12 more than advised');
  });

  it('says nothing when the delivery matches', () => {
    expect(compareAgainstAsn(asn, { 'p-rice': 100, 'p-milk': 50 })).toEqual([]);
  });
});
