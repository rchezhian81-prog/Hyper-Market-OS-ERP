import { describe, it, expect } from 'vitest';
import {
  handOverBasket, recallQueueBasket, giveUpQueueBasket, waitingFrom, readQueueBasketLines, QUEUE_BASKET_WORDS, QUEUE_BASKET_MAX_LINES,
  QUEUE_BUSTING_SWITCH, MOBILE_POS_PAYMENT_SWITCH, type QueueBasket,
} from '../../packages/suspended-sales/src/queue-basket';
import { isHighImpactFlag } from '../../services/platform/src/governed-config';
import { ROLLOUT_KEY } from '../../packages/platform/src/rollout';

/**
 * **D04-FR-05 queue-busting — the rules a hand-over from a queue handheld to a till must keep (pure).** One basket per
 * hand-over (a lost reply re-sent is the same code); a recall is a claim, once, naming the till that has it; a handheld
 * never recalls; a basket nobody came for is given up with a reason and kept; two waiting baskets never share a code.
 */

const HH = 'device:hh-q1';
const OTHER_HH = 'device:hh-q2';
const AT = '2026-10-24T10:00:00.000Z';
const LINES = [{ productId: 'P-DAL', name: 'Toor dal 1kg', barcode: '8901234567890', quantityMinor: 2 }];

const handOver = (existing: readonly QueueBasket[], over: Partial<Parameters<typeof handOverBasket>[1]> = {}) =>
  handOverBasket(existing, { basketId: 'B-1', handheldLane: HH, handedOverBy: 'u-ravi', lines: LINES, handheldTotalMinor: 24_000, at: AT, candidates: ['0042', '0043'], ...over });
const waitingBasket = (code = '0042', basketId = 'B-1', handheldLane = HH): QueueBasket => {
  const out = handOver([], { basketId, handheldLane, candidates: [code] });
  if (!out.handedOver) throw new Error(out.refusedBecause);
  return out.basket;
};

describe('the switches are named so head office governs them as OB-316 says', () => {
  it('two switch names, valid rollout keys; taking money on a handheld is high-impact (the owner approves it), the hand-over is not', () => {
    expect(ROLLOUT_KEY.test(QUEUE_BUSTING_SWITCH)).toBe(true);
    expect(ROLLOUT_KEY.test(MOBILE_POS_PAYMENT_SWITCH)).toBe(true);
    expect(isHighImpactFlag(MOBILE_POS_PAYMENT_SWITCH)).toBe(true);
    expect(isHighImpactFlag(QUEUE_BUSTING_SWITCH)).toBe(false);
  });
});

describe('a hand-over', () => {
  it('parks the lines under the first free code — never a price, only what the till re-rings', () => {
    const out = handOver([]);
    expect(out).toMatchObject({ handedOver: true, again: false, basket: { code: '0042', state: 'waiting', handheldLane: HH, handedOverBy: 'u-ravi', lines: LINES, handheldTotalMinor: 24_000 } });
  });

  it('re-sent after a lost reply (same basket, same handheld, same person) is the SAME hand-over with the SAME code', () => {
    const first = waitingBasket();
    expect(handOver([first], { candidates: ['0099'] })).toMatchObject({ handedOver: true, again: true, basket: { code: '0042' } });
  });

  it('a basket id another handheld or person already used is refused — never merged into theirs', () => {
    const first = waitingBasket();
    expect(handOver([first], { handheldLane: OTHER_HH })).toEqual({ handedOver: false, refusedBecause: 'basket_id_reused' });
    expect(handOver([first], { handedOverBy: 'u-kumar' })).toEqual({ handedOver: false, refusedBecause: 'basket_id_reused' });
  });

  it('two waiting baskets never share a code; a code frees once its basket is recalled', () => {
    const first = waitingBasket('0042');
    const second = handOver([first], { basketId: 'B-2', candidates: ['0042', '0043'] });
    expect(second).toMatchObject({ handedOver: true, basket: { code: '0043' } });
    const recalled = recallQueueBasket([first], { code: '0042', laneId: 'lane-1', by: 'u-asha', at: AT });
    if (!recalled.recalled) throw new Error('not recalled');
    expect(handOver([recalled.basket], { basketId: 'B-3', candidates: ['0042'] })).toMatchObject({ handedOver: true, basket: { code: '0042' } });
  });

  it('no free code among the candidates (or none shaped as four digits) is refused in words, not a guess', () => {
    expect(handOver([waitingBasket('0042')], { basketId: 'B-2', candidates: ['0042', '42', 'abcd'] })).toEqual({ handedOver: false, refusedBecause: 'no_free_code' });
  });

  it('refuses an empty basket, an unreadable line, a missing basket id and a lane that is not a handheld', () => {
    expect(handOver([], { lines: [] })).toEqual({ handedOver: false, refusedBecause: 'empty_basket' });
    expect(handOver([], { lines: 'x' })).toEqual({ handedOver: false, refusedBecause: 'basket_not_readable' });
    expect(handOver([], { lines: [{ ...LINES[0], barcode: '' }] })).toEqual({ handedOver: false, refusedBecause: 'basket_not_readable' });
    expect(handOver([], { lines: [{ ...LINES[0], quantityMinor: 0 }] })).toEqual({ handedOver: false, refusedBecause: 'basket_not_readable' });
    expect(handOver([], { lines: [{ ...LINES[0], quantityMinor: 1.5 }] })).toEqual({ handedOver: false, refusedBecause: 'basket_not_readable' });
    expect(handOver([], { basketId: '  ' })).toEqual({ handedOver: false, refusedBecause: 'basket_id_missing' });
    expect(handOver([], { handheldLane: 'lane-1' })).toEqual({ handedOver: false, refusedBecause: 'not_a_handheld' });
  });

  it('a negative or broken handheld total is kept as 0 — the till\'s own total is the bill', () => {
    expect(handOver([], { handheldTotalMinor: -5 })).toMatchObject({ basket: { handheldTotalMinor: 0 } });
    expect(handOver([], { handheldTotalMinor: 'lots' })).toMatchObject({ basket: { handheldTotalMinor: 0 } });
  });

  it('reads the lines strictly and caps how many one hand-over carries', () => {
    expect(readQueueBasketLines([{ productId: ' P1 ', name: 'x', barcode: ' 123 ', quantityMinor: 3 }])).toEqual({ ok: true, lines: [{ productId: 'P1', name: 'x', barcode: '123', quantityMinor: 3 }] });
    expect(readQueueBasketLines(Array.from({ length: QUEUE_BASKET_MAX_LINES + 1 }, () => LINES[0]))).toEqual({ ok: false, reason: 'too_many_lines' });
    expect(readQueueBasketLines(null)).toEqual({ ok: false, reason: 'basket_not_readable' });
  });
});

describe('a recall at a till', () => {
  it('is a claim, once: the first till gets the lines; every later try is refused naming the till that has it', () => {
    const b = waitingBasket();
    const first = recallQueueBasket([b], { code: '0042', laneId: 'lane-1', by: 'u-asha', at: AT });
    expect(first).toMatchObject({ recalled: true, basket: { state: 'recalled', recalledOnLane: 'lane-1', recalledBy: 'u-asha', lines: LINES } });
    if (!first.recalled) throw new Error('not recalled');
    expect(recallQueueBasket([first.basket], { code: '0042', laneId: 'lane-2', by: 'u-meena', at: AT })).toEqual({ recalled: false, refusedBecause: 'already_recalled', recalledOnLane: 'lane-1' });
  });

  it('a handheld never recalls; a code that is not four digits, an unknown code and a lane-less box are refused', () => {
    const b = waitingBasket();
    expect(recallQueueBasket([b], { code: '0042', laneId: HH, by: 'u-ravi', at: AT })).toEqual({ recalled: false, refusedBecause: 'handheld_cannot_recall' });
    expect(recallQueueBasket([b], { code: '42', laneId: 'lane-1', by: 'u-asha', at: AT })).toEqual({ recalled: false, refusedBecause: 'not_a_queue_code' });
    expect(recallQueueBasket([b], { code: 4242, laneId: 'lane-1', by: 'u-asha', at: AT })).toEqual({ recalled: false, refusedBecause: 'not_a_queue_code' });
    expect(recallQueueBasket([b], { code: '9999', laneId: 'lane-1', by: 'u-asha', at: AT })).toEqual({ recalled: false, refusedBecause: 'no_such_queue_basket' });
    expect(recallQueueBasket([b], { code: '0042', laneId: ' ', by: 'u-asha', at: AT })).toEqual({ recalled: false, refusedBecause: 'no_lane' });
  });

  it('a code re-used by a NEW waiting basket brings up the new one, not the old one already rung', () => {
    const old = recallQueueBasket([waitingBasket()], { code: '0042', laneId: 'lane-1', by: 'u-asha', at: AT });
    if (!old.recalled) throw new Error('not recalled');
    const next = handOver([old.basket], { basketId: 'B-9', candidates: ['0042'] });
    if (!next.handedOver) throw new Error(next.refusedBecause);
    expect(recallQueueBasket([old.basket, next.basket], { code: '0042', laneId: 'lane-1', by: 'u-asha', at: AT })).toMatchObject({ recalled: true, basket: { basketId: 'B-9' } });
  });
});

describe('giving a basket up', () => {
  it('needs a reason and the handheld that handed it over; it stays on the record, never deleted', () => {
    const b = waitingBasket();
    expect(giveUpQueueBasket([b], { code: '0042', handheldLane: HH, by: 'u-ravi', reason: ' ', at: AT })).toEqual({ givenUp: false, refusedBecause: 'reason_required' });
    expect(giveUpQueueBasket([b], { code: '0042', handheldLane: OTHER_HH, by: 'u-x', reason: 'left', at: AT })).toEqual({ givenUp: false, refusedBecause: 'not_this_handheld' });
    expect(giveUpQueueBasket([b], { code: '7777', handheldLane: HH, by: 'u-ravi', reason: 'left', at: AT })).toEqual({ givenUp: false, refusedBecause: 'no_such_queue_basket' });
    const given = giveUpQueueBasket([b], { code: '0042', handheldLane: HH, by: 'u-ravi', reason: ' Customer left ', at: AT });
    expect(given).toMatchObject({ givenUp: true, basket: { state: 'given_up', givenUpBy: 'u-ravi', giveUpReason: 'Customer left', lines: LINES } });
    if (!given.givenUp) throw new Error('not given up');
    expect(giveUpQueueBasket([given.basket], { code: '0042', handheldLane: HH, by: 'u-ravi', reason: 'again', at: AT })).toEqual({ givenUp: false, refusedBecause: 'already_given_up' });
    expect(recallQueueBasket([given.basket], { code: '0042', laneId: 'lane-1', by: 'u-asha', at: AT })).toEqual({ recalled: false, refusedBecause: 'given_up' });
  });

  it('a basket a till already rang cannot be given up', () => {
    const r = recallQueueBasket([waitingBasket()], { code: '0042', laneId: 'lane-1', by: 'u-asha', at: AT });
    if (!r.recalled) throw new Error('not recalled');
    expect(giveUpQueueBasket([r.basket], { code: '0042', handheldLane: HH, by: 'u-ravi', reason: 'left', at: AT })).toEqual({ givenUp: false, refusedBecause: 'already_recalled' });
  });
});

describe('what a handheld sees waiting, and the words', () => {
  it('only its own waiting baskets, oldest first', () => {
    const a = { ...waitingBasket('0001', 'B-A'), handedOverAt: '2026-10-24T10:05:00.000Z' };
    const b = { ...waitingBasket('0002', 'B-B'), handedOverAt: '2026-10-24T10:01:00.000Z' };
    const theirs = waitingBasket('0003', 'B-C', OTHER_HH);
    expect(waitingFrom([a, b, theirs], HH).map((x) => x.code)).toEqual(['0002', '0001']);
  });

  it('every refusal has English and Tamil words', () => {
    for (const reason of ['empty_basket', 'basket_not_readable', 'too_many_lines', 'basket_id_missing', 'basket_id_reused', 'not_a_handheld', 'no_free_code', 'not_a_queue_code', 'no_such_queue_basket', 'already_recalled', 'given_up', 'already_given_up', 'handheld_cannot_recall', 'reason_required', 'not_this_handheld', 'no_lane']) {
      expect(QUEUE_BASKET_WORDS[reason]?.en, reason).toMatch(/\w/);
      expect(QUEUE_BASKET_WORDS[reason]?.ta, reason).toMatch(/[஀-௿]/);
    }
  });
});
