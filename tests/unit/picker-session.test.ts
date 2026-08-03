import { describe, it, expect } from 'vitest';
import {
  PickSession,
  BinNotScannedError,
  WrongItemError,
  WaveNotCompleteError,
  LineAlreadyResolvedError,
  ReasonRequiredError,
  NoSuchLineError,
  type PickLineInput,
} from '../../apps/picker-app/src/index';
import { SubstitutionNotConfirmedError } from '../../packages/fulfilment/src/index';
import { money } from '../../packages/contracts/src/money';

// Every pick is a scan, in order; a substitution needs the customer's agreement;
// weighed lines capture their final price; the manifest matches the crate (M19).

const AT = '2026-08-02T10:00:00Z';

const WORK: PickLineInput[] = [
  {
    lineId: 'l1',
    orderRef: 'ORD-1',
    productId: 'p1',
    description: 'Rice 1kg',
    bin: 'A-01',
    requiredQty: 2,
    uom: 'ea',
    unitPrice: money(100_00, 'INR'),
  },
  {
    lineId: 'l2',
    orderRef: 'ORD-1',
    productId: 'p2',
    description: 'Tomato',
    bin: 'B-04',
    requiredQty: 1500, // 1.5 kg in grams
    uom: 'kg',
    unitPrice: money(80_00, 'INR'),
  },
];

function newWave() {
  return new PickSession('wave-1', WORK);
}

const evidence = { packedBy: 'picker-1', at: AT, temperatureC: 4, tamperSealRef: 'SEAL-9' };

describe('PickSession — assigned work', () => {
  it('lists the assigned wave with everything pending', () => {
    const wave = newWave();
    expect(wave.work()).toHaveLength(2);
    expect(wave.progress()).toEqual({ total: 2, resolved: 0, pending: 2, complete: false });
  });

  it('refuses a pick before the bin is scanned', () => {
    const wave = newWave();
    expect(() => wave.pick('l1', 'p1', 2)).toThrow(BinNotScannedError);
  });

  it('refuses a pick at the wrong bin', () => {
    const wave = newWave();
    wave.scanBin('B-04'); // standing at the wrong bin for line 1
    expect(() => wave.pick('l1', 'p1', 2)).toThrow(BinNotScannedError);
  });

  it('refuses the wrong item even at the right bin', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    expect(() => wave.pick('l1', 'p9', 2)).toThrow(WrongItemError);
  });

  it('picks a full line in three steps: scan bin, scan item, confirm', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    const line = wave.pick('l1', 'p1', 2);
    expect(line.state).toBe('picked');
    expect(line.pickedQty).toBe(2);
    expect(line.finalPrice).toEqual(money(200_00, 'INR'));
  });

  it('captures a weighed line’s final price exactly at pick (D09)', () => {
    const wave = newWave();
    wave.scanBin('B-04');
    // picked 1.234 kg of the 1.5 kg asked for → short, priced to the paisa
    const line = wave.pick('l2', 'p2', 1234);
    expect(line.state).toBe('short');
    expect(line.finalPrice).toEqual(money(98_72, 'INR')); // 1.234 × ₹80
  });

  it('treats picking less than required as a short pick, not a silent complete', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    expect(wave.pick('l1', 'p1', 1).state).toBe('short');
  });

  it('refuses to pick more than was required, or an unknown line', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    expect(() => wave.pick('l1', 'p1', 5)).toThrow(RangeError);
    expect(() => wave.pick('nope', 'p1', 1)).toThrow(NoSuchLineError);
  });

  it('will not re-pick a resolved line', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    expect(() => wave.pick('l1', 'p1', 2)).toThrow(LineAlreadyResolvedError);
  });
});

describe('substitution', () => {
  it('is refused without the customer’s confirmation (A04)', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    wave.markUnavailable('l1', 'out of stock');
    expect(() => wave.substitute('l1', 'p1-alt', false, 2, money(110_00, 'INR'))).toThrow(
      SubstitutionNotConfirmedError,
    );
    expect(wave.work()[0]?.state).toBe('short'); // unchanged
  });

  it('commits with confirmation and prices the substitute', () => {
    const wave = newWave();
    wave.markUnavailable('l1', 'out of stock');
    const line = wave.substitute('l1', 'p1-alt', true, 2, money(110_00, 'INR'));
    expect(line.state).toBe('substituted');
    expect(line.substituteProductId).toBe('p1-alt');
    expect(line.finalPrice).toEqual(money(220_00, 'INR')); // at the substitute's price
  });
});

describe('quality and shorts', () => {
  it('needs a reason to fail quality or mark unavailable', () => {
    const wave = newWave();
    expect(() => wave.failQuality('l1', ' ')).toThrow(ReasonRequiredError);
    expect(() => wave.markUnavailable('l1', '')).toThrow(ReasonRequiredError);
  });

  it('excludes a quality-failed line from the pack', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    wave.failQuality('l2', 'bruised');
    const manifest = wave.pack(evidence);
    expect(manifest.lines.map((l) => l.lineId)).toEqual(['l1']);
  });
});

describe('packing and the dispatch manifest', () => {
  it('is blocked while any line is unresolved', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    expect(() => wave.pack(evidence)).toThrow(WaveNotCompleteError);
    expect(wave.manifest()).toBeNull();
  });

  it('matches exactly what was packed, with cold-chain evidence', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    wave.scanBin('B-04');
    wave.pick('l2', 'p2', 1234);

    const manifest = wave.pack(evidence);
    expect(manifest.lines).toHaveLength(2);
    expect(manifest.totalValue).toEqual(money(298_72, 'INR')); // 200.00 + 98.72
    expect(manifest.evidence.temperatureC).toBe(4);
    expect(manifest.evidence.tamperSealRef).toBe('SEAL-9');
    expect(manifest.waveId).toBe('wave-1');
    expect(wave.manifest()).toEqual(manifest);
  });

  it('lists a substituted line under the substitute, flagged as substituted', () => {
    const wave = newWave();
    wave.markUnavailable('l1', 'out of stock');
    wave.substitute('l1', 'p1-alt', true, 2, money(110_00, 'INR'));
    wave.markUnavailable('l2', 'none left');

    const manifest = wave.pack(evidence);
    expect(manifest.lines).toHaveLength(1); // the zero-pick short is not in the crate
    expect(manifest.lines[0]?.productId).toBe('p1-alt');
    expect(manifest.lines[0]?.substituted).toBe(true);
  });

  it('carries the order reference but no customer PII', () => {
    const wave = newWave();
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    wave.markUnavailable('l2', 'none left');
    const manifest = wave.pack(evidence);
    expect(manifest.lines[0]?.orderRef).toBe('ORD-1');
    expect(JSON.stringify(manifest)).not.toMatch(/customer|phone|address/i);
  });
});
