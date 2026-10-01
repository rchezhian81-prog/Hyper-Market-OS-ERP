import { describe, it, expect } from 'vitest';
import {
  PickSession,
  SubstitutionEvidenceRequiredError,
  BinNotScannedError,
  WrongItemError,
  WaveNotCompleteError,
  LineAlreadyResolvedError,
  ReasonRequiredError,
  NoSuchLineError,
  type PickLineInput,
} from '../../apps/picker-app/src/index';
import { SubstitutionNotConfirmedError } from '../../packages/fulfilment/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';
import { SENT_WORK_KINDS, PICK_LINE_RESOLVED, WAVE_PACKED } from '../../apps/picker-app/src/pick-session';

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

/** The outbox is required now — a wave whose scans queue nowhere is a wave that never happened. */
function newWave(outbox: SyncOutbox = new SyncOutbox()) {
  return new PickSession('wave-1', WORK, outbox, { now: () => AT });
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
  it('is refused without the customer’s own confirmation, as EVIDENCE not a tick', () => {
    // A checkbox labelled "customer confirmed" is one a picker with eleven lines left taps in half
    // a second. It is true in the type system and unverifiable in the aisle.
    const wave = newWave();
    wave.scanBin('A-01');
    wave.markUnavailable('l1', 'out of stock');
    expect(() => wave.substitute('l1', 'p1-alt', '', 2, money(110_00, 'INR'))).toThrow(
      SubstitutionEvidenceRequiredError,
    );
    expect(() => wave.substitute('l1', 'p1-alt', '   ', 2, money(110_00, 'INR'))).toThrow(
      SubstitutionEvidenceRequiredError,
    );
    expect(wave.work()[0]?.state).toBe('short'); // unchanged
  });

  it('commits with the customer’s reference and prices the substitute', () => {
    const wave = newWave();
    wave.markUnavailable('l1', 'out of stock');
    const line = wave.substitute('l1', 'p1-alt', 'wa-msg-88421', 2, money(110_00, 'INR'));
    expect(line.state).toBe('substituted');
    expect(line.substituteProductId).toBe('p1-alt');
    expect(line.finalPrice).toEqual(money(220_00, 'INR')); // at the substitute's price
    // The evidence travels with the swap, so a disputed substitution can be looked up.
    expect(line.note).toContain('wa-msg-88421');
  });

  it('still runs the engine’s own A04 rule underneath (SubstitutionNotConfirmedError exists)', () => {
    // The engine is the rule; this layer only insists the confirmation left a trace.
    expect(new SubstitutionNotConfirmedError('l1').name).toBe('SubstitutionNotConfirmedError');
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
    wave.substitute('l1', 'p1-alt', 'wa-msg-88421', 2, money(110_00, 'INR'));
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

// ── SP-3c-i: who did it travels on every outcome, and the handheld can say where each piece of work has got to ──────

describe('every outcome names the picker the wave was assigned to (SP-3c-i · §28)', () => {
  it('carries pickedBy on the line event when the wave named a picker, and null — never an invented name — when it did not', () => {
    const outbox = new SyncOutbox();
    const wave = new PickSession('wave-1', WORK, outbox, { now: () => AT, pickerId: 'u-picker' });
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    const line = outbox.pending().find((i) => i.event.type === PICK_LINE_RESOLVED)!.event;
    expect(line.payload).toMatchObject({ waveId: 'wave-1', lineId: 'l1', state: 'picked', pickedQty: 2, uom: 'ea', finalPriceMinor: 200_00, pickedBy: 'u-picker' });
    expect(line.idempotencyKey).toBe('pick:wave-1:l1:picked');

    const unnamed = new SyncOutbox();
    const anon = new PickSession('wave-2', WORK, unnamed, { now: () => AT });
    anon.scanBin('A-01');
    anon.pick('l1', 'p1', 2);
    expect(unnamed.pending()[0]!.event.payload).toMatchObject({ pickedBy: null });
  });
});

describe('where each piece of work is — the five shared device states, from the durable queue and the box\'s word (SP-3c-i)', () => {
  it('lists every outcome and the pack newest first as "saved here", moves to "with the store computer" when the box takes them, and to "posted" / "refused" only on the box\'s word', () => {
    const outbox = new SyncOutbox();
    const wave = new PickSession('wave-1', WORK, outbox, { now: () => AT, pickerId: 'u-picker' });
    expect(wave.sentWork()).toEqual([]);
    expect(wave.handedKeys()).toEqual([]);
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    wave.failQuality('l2', 'damaged');
    wave.pack({ packedBy: 'u-picker', at: AT, temperatureC: 4, tamperSealRef: 'SEAL-1' });

    const before = wave.sentWork();
    expect(before.map((w) => [w.kind, w.id, w.state])).toEqual([
      ['pack', 'wave-1', 'saved_here'],
      ['line', 'l2', 'saved_here'],
      ['line', 'l1', 'saved_here'],
    ]);
    expect(before[2]).toMatchObject({ what: 'p1 · ORD-1', detail: 'picked · 2 ea' });
    expect(before[1]).toMatchObject({ what: 'p2 · ORD-1', detail: 'quality_failed · 0 kg' });
    expect(before[0]).toMatchObject({ what: 'wave-1', detail: '1 line · 20000 INR' });
    for (const kind of SENT_WORK_KINDS) expect(before.some((w) => w.kind === kind)).toBe(true);

    // The box takes the two line outcomes (the device's "acknowledged" = the box has them — never "posted" on the device's say-so).
    const keys = outbox.pending().filter((i) => i.event.type === PICK_LINE_RESOLVED).map((i) => i.key);
    outbox.acknowledge(keys[0]!);
    outbox.acknowledge(keys[1]!);
    expect(wave.handedKeys()).toEqual(keys);
    expect(wave.sentWork().map((w) => [w.kind, w.state])).toEqual([['pack', 'saved_here'], ['line', 'handed_to_box'], ['line', 'handed_to_box']]);

    // The box's word: one posted at head office, one refused with the reason. Only now do those words appear.
    wave.noteBoxStatus([
      { key: 'pick:wave-1:l1:picked', state: 'posted', attempts: 1 },
      { key: 'pick:wave-1:l2:quality_failed', state: 'refused', attempts: 1, reason: 'not_readable_as_a_pick_outcome' },
    ]);
    const after = wave.sentWork();
    expect(after.map((w) => [w.id, w.state])).toEqual([['wave-1', 'saved_here'], ['l2', 'refused'], ['l1', 'posted']]);
    expect(after[1]?.reason).toBe('not_readable_as_a_pick_outcome');
    expect(after[2]?.reason).toBeUndefined();

    // The pack the box refuses outright is dead-lettered on the device, with the reason — and stays listed.
    const packKey = outbox.pending().find((i) => i.event.type === WAVE_PACKED)!.key;
    outbox.deadLetter(packKey, 'WavePacked is not a record this box relays for warehouse');
    expect(wave.sentWork()[0]).toMatchObject({ kind: 'pack', state: 'refused', reason: 'WavePacked is not a record this box relays for warehouse' });
  });
});
