import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';
import {
  PickSession, NotAskFirstLineError, LineAlreadyResolvedError, WaveNotCompleteError, NO_WAIT_SET_REASON,
  SUBSTITUTION_PROPOSED, PICK_LINE_RESOLVED, SENT_WORK_KINDS, type PickLineInput,
} from '../../apps/picker-app/src/pick-session';
import { readAnswersBody, openPickerAnswers, bootPicker } from '../../apps/picker-app/src/browser-entry';
import { openDeviceOutbox, guardedStore } from '../../packages/sync/src/device-outbox';
import { RELAYABLE_DEVICE_EVENTS, isRelayable } from '../../packages/sync/src/device-relay';
import { HANDHELD_PERSON_FIELD } from '../../edge/store-edge/src/handheld-sign-in';

/**
 * **W6 · OB-687 (owner, 4 Nov 2026) · FUL-14 · M19-FR-02 — a substitute that needs the customer's yes is answered by the
 * customer: the picker phone PROPOSES it, queues it for the store computer, waits the owner's minutes, and packs by the
 * answer read back.** Local and synchronous; nothing here waits on a network.
 */

const T0 = '2026-11-04T10:00:00.000Z';
const at = (mins: number) => new Date(Date.parse(T0) + mins * 60_000).toISOString();
const ASK: PickLineInput = { lineId: 'L1', orderRef: 'ORD-9', productId: 'MILK-1L', description: 'Milk 1 L', bin: 'C-01', requiredQty: 2, uom: 'ea', unitPrice: money(30_00, 'INR'), substitution: 'ask_first' };
const PLAIN: PickLineInput = { lineId: 'L2', orderRef: 'ORD-9', productId: 'RICE', description: 'Rice', bin: 'A-01', requiredQty: 1, uom: 'ea', unitPrice: money(80_00, 'INR') };

function session(clock: { now: string } = { now: T0 }) {
  const outbox = new SyncOutbox();
  return { s: new PickSession('W-9', [ASK, PLAIN], outbox, { now: () => clock.now, pickerId: 'u-picker' }), outbox, clock };
}

describe('W6 · OB-687: the picker proposes a swap on a line whose customer asked to be asked first', () => {
  it('queues ONE proposal for the store computer (no PII), the line waits for the customer, and the crate cannot be packed', () => {
    const { s, outbox } = session();
    const out = s.proposeSubstitute('L1', 'MILK-ORG-1L', 'out_of_stock', 15);
    expect(out).toMatchObject({ outcome: 'asked', answerBy: at(15) });
    expect(s.work().find((l) => l.lineId === 'L1')).toMatchObject({ state: 'awaiting_customer', proposal: { proposalId: 'W-9:L1:MILK-ORG-1L', substituteProductId: 'MILK-ORG-1L', answerBy: at(15), waitMinutes: 15 } });
    const queued = outbox.all().map((i) => i.event);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: SUBSTITUTION_PROPOSED, idempotencyKey: 'subprop:W-9:L1:MILK-ORG-1L', source: 'W-9' });
    expect(queued[0]!.payload).toEqual({
      proposalId: 'W-9:L1:MILK-ORG-1L', waveId: 'W-9', lineId: 'L1', orderRef: 'ORD-9', orderedProductId: 'MILK-1L', description: 'Milk 1 L',
      substituteProductId: 'MILK-ORG-1L', quantity: 2, uom: 'ea', why: 'out_of_stock', waitMinutes: 15, proposedAt: T0, answerBy: at(15), proposedBy: 'u-picker',
    });
    // Waiting is not resolved: pick the rest, and the pack is still refused.
    s.scanBin('A-01'); s.pick('L2', 'RICE', 1);
    expect(s.progress()).toMatchObject({ pending: 1, complete: false });
    expect(() => s.pack({ packedBy: 'u-picker', at: T0 })).toThrow(WaveNotCompleteError);
    // Asked once: a second proposal on the same line is refused.
    expect(() => s.proposeSubstitute('L1', 'MILK-OTHER', 'out_of_stock', 15)).toThrow(LineAlreadyResolvedError);
    expect(s.sentWork().find((w) => w.kind === 'proposal')).toMatchObject({ id: 'L1', what: 'MILK-ORG-1L · ORD-9', state: 'saved_here' });
    expect(SENT_WORK_KINDS).toContain('proposal');
  });

  it('with NO wait set by the owner the picker does not wait: the line goes short now, said, and nothing is put to the customer', () => {
    const { s, outbox } = session();
    const out = s.proposeSubstitute('L1', 'MILK-ORG-1L', 'not_found', null);
    expect(out.outcome).toBe('short_no_wait');
    expect(out.line).toMatchObject({ state: 'short', pickedQty: 0, note: NO_WAIT_SET_REASON });
    expect(outbox.all().map((i) => i.event.type)).toEqual([PICK_LINE_RESOLVED]);
  });

  it('refuses a proposal on a line whose customer did not ask first, the same product, or an unreadable wait', () => {
    const { s } = session();
    expect(() => s.proposeSubstitute('L2', 'RICE-2', 'out_of_stock', 15)).toThrow(NotAskFirstLineError);
    expect(() => s.proposeSubstitute('L1', 'MILK-1L', 'out_of_stock', 15)).toThrow(RangeError);
    expect(() => s.proposeSubstitute('L1', 'MILK-ORG-1L', 'out_of_stock', 0)).toThrow(RangeError);
  });

  it('a YES read back packs the swap at the substitute\'s published price, the answer as the customer\'s own reference', () => {
    const { s, outbox } = session();
    s.proposeSubstitute('L1', 'MILK-ORG-1L', 'out_of_stock', 15);
    const settled = s.applyAnswers([{ proposalId: 'W-9:L1:MILK-ORG-1L', lineId: 'L1', state: 'yes', substituteUnitPriceMinor: 45_00, via: 'app' }], at(3));
    expect(settled.map((x) => x.outcome)).toEqual(['swapped']);
    expect(settled[0]!.line).toMatchObject({ state: 'substituted', substituteProductId: 'MILK-ORG-1L', pickedQty: 2, finalPrice: { minor: 90_00 } });
    expect(settled[0]!.line.note).toMatch(/customer said yes in the app · proposal W-9:L1:MILK-ORG-1L/);
    const last = outbox.all().at(-1)!.event;
    expect(last).toMatchObject({ type: PICK_LINE_RESOLVED });
    expect(last.payload).toMatchObject({ lineId: 'L1', state: 'substituted', productId: 'MILK-ORG-1L', substituted: true, finalPriceMinor: 90_00 });
  });

  it('a YES given to staff by phone counts the same; a NO, the shop\'s refusal and no answer by the owner\'s time each leave the line short', () => {
    for (const [answer, outcome, note] of [
      [{ state: 'yes', substituteUnitPriceMinor: 30_00, via: 'staff', reference: 'phone: CALL-77' }, 'swapped', /to staff \(phone: CALL-77\)/],
      [{ state: 'no' }, 'customer_said_no', /the customer said no to MILK-ORG-1L/],
      [{ state: 'refused', reason: 'introduces allergen(s) the customer avoids (nuts)' }, 'refused_by_rule', /the shop's rules refuse MILK-ORG-1L: introduces allergen/],
      [{ state: 'too_late' }, 'no_answer_in_time', /no answer from the customer within 15 minute/],
    ] as const) {
      const { s } = session();
      s.proposeSubstitute('L1', 'MILK-ORG-1L', 'out_of_stock', 15);
      const settled = s.applyAnswers([{ proposalId: 'W-9:L1:MILK-ORG-1L', lineId: 'L1', ...answer }], at(5));
      expect(settled.map((x) => x.outcome)).toEqual([outcome]);
      expect(settled[0]!.line.note).toMatch(note);
      expect(settled[0]!.line.state).toBe(outcome === 'swapped' ? 'substituted' : 'short');
    }
  });

  it('still waiting before the owner\'s time; after it, the line goes short even with no word from head office (offline)', () => {
    const { s } = session();
    s.proposeSubstitute('L1', 'MILK-ORG-1L', 'out_of_stock', 15);
    expect(s.applyAnswers([{ proposalId: 'W-9:L1:MILK-ORG-1L', lineId: 'L1', state: 'waiting' }], at(14))).toEqual([]);
    expect(s.applyAnswers([], at(14))).toEqual([]);
    expect(s.waitingForCustomer()).toHaveLength(1);
    const late = s.applyAnswers([], at(16));
    expect(late.map((x) => x.outcome)).toEqual(['no_answer_in_time']);
    expect(s.waitingForCustomer()).toHaveLength(0);
  });

  it('a yes with no published price is not packed on a guess — the line keeps waiting until the time runs out', () => {
    const { s } = session();
    s.proposeSubstitute('L1', 'MILK-ORG-1L', 'out_of_stock', 15);
    expect(s.applyAnswers([{ proposalId: 'W-9:L1:MILK-ORG-1L', lineId: 'L1', state: 'yes', substituteUnitPriceMinor: null }], at(2))).toEqual([]);
  });

  it('offline first: closed and opened again, the waiting line still waits (from the device queue), never asked twice', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    const first = bootPicker({ waveId: 'W-9', pickerId: 'u-picker', lines: [ASK, PLAIN], substitutionWaitMinutes: 15 }, openDeviceOutbox(guardedStore('k', storage, () => {}), () => {}), () => T0)!;
    first.proposeSubstitute('L1', 'MILK-ORG-1L', 'out_of_stock', 15);
    const again = bootPicker({ waveId: 'W-9', pickerId: 'u-picker', lines: [ASK, PLAIN], substitutionWaitMinutes: 15 }, openDeviceOutbox(guardedStore('k', storage, () => {}), () => {}), () => T0)!;
    expect(again.work().find((l) => l.lineId === 'L1')).toMatchObject({ state: 'awaiting_customer', proposal: { proposalId: 'W-9:L1:MILK-ORG-1L', answerBy: at(15) } });
    expect(() => again.proposeSubstitute('L1', 'MILK-OTHER', 'out_of_stock', 15)).toThrow(LineAlreadyResolvedError);
  });
});

describe('W6 · OB-687: the answers are read back through the store computer, strictly', () => {
  it('reads the box\'s body strictly — an unreadable wait or state is no word, never a guess', () => {
    expect(readAnswersBody({ waitMinutes: 15, answers: [{ proposalId: 'p', lineId: 'L1', state: 'yes', substituteUnitPriceMinor: 1 }, { proposalId: 'q', lineId: 'L2', state: 'maybe' }], asAt: T0 }))
      .toEqual({ waitMinutes: 15, answers: [{ proposalId: 'p', lineId: 'L1', state: 'yes', substituteUnitPriceMinor: 1 }], asAt: T0 });
    expect(readAnswersBody({ waitMinutes: null, answers: [] })).toEqual({ waitMinutes: null, answers: [] });
    expect(readAnswersBody({ waitMinutes: 0, answers: [] })).toBeUndefined();
    expect(readAnswersBody({ waitMinutes: 5 })).toBeUndefined();
  });

  it('asks the store computer only while a line waits, takes the owner\'s wait it reports, and settles by the answer', async () => {
    const calls: string[] = [];
    const g = globalThis as { fetch?: typeof fetch };
    const real = g.fetch;
    g.fetch = (async (url: string) => { calls.push(String(url)); return { ok: true, json: async () => ({ waitMinutes: 20, answers: [{ proposalId: 'W-9:L1:MILK-ORG-1L', lineId: 'L1', state: 'no' }] }) }; }) as unknown as typeof fetch;
    try {
      const { s } = session();
      const reader = openPickerAnswers('', s, { substitutionWaitMinutes: 15 }, () => at(1));
      expect(reader.waitMinutes()).toBe(15);
      expect((await reader.readNow()).reached).toBe(false); // nothing waits → the box is not asked
      expect(calls).toEqual([]);
      s.proposeSubstitute('L1', 'MILK-ORG-1L', 'out_of_stock', reader.waitMinutes());
      const r = await reader.readNow();
      expect(calls).toEqual(['/lane/picker/substitution-answers?waveId=W-9']);
      expect(r.reached).toBe(true);
      expect(r.settled.map((x) => x.outcome)).toEqual(['customer_said_no']);
      expect(reader.waitMinutes()).toBe(20);
    } finally { g.fetch = real; }
  });

  it('the proposal is a picker record the store computer relays — and names the person who asked', () => {
    expect(RELAYABLE_DEVICE_EVENTS[SUBSTITUTION_PROPOSED]?.surfaces).toEqual(['picker']);
    expect(isRelayable(SUBSTITUTION_PROPOSED, 'warehouse')).toBe(false);
    expect(HANDHELD_PERSON_FIELD[SUBSTITUTION_PROPOSED]).toBe('proposedBy');
  });
});
