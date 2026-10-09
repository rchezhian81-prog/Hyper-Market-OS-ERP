import { describe, it, expect } from 'vitest';
import { bootPos, ReceiptNumberRefusedError, type ReceiptNumberAnswer } from '../../apps/pos/src/browser-entry';

// Receipt numbering on the till (audit PF-04 · M01-FR-02). The till used to count its own numbers in the browser's memory
// — a reload started again at 0001, a second tab counted separately, and without a range a timestamp was minted. Now it
// ASKS its store computer for each number (the box's own register is proved against a real box in
// tests/integration/receipt-numbers-come-from-the-box.test.ts). Here: the till takes what the box gives, mints nothing
// itself, and stops when the box gives none.

const answering = (answers: ReceiptNumberAnswer[]) => {
  const keys: string[] = [];
  return { keys, port: async (requestKey: string): Promise<ReceiptNumberAnswer> => { keys.push(requestKey); return answers.shift() ?? { issued: false, refusedBecause: 'receipt_numbers_used_up', laneMessage: 'used up' }; } };
};

describe('the till takes its receipt numbers from the store computer (audit PF-04)', () => {
  it('each number is the box\'s, asked under a fresh request key; what the box said rides along', async () => {
    const box = answering([
      { issued: true, receiptNumber: 'R-L1-0001', remaining: 99, runningLow: false, source: 'published' },
      { issued: true, receiptNumber: 'R-L1-0002', remaining: 3, runningLow: true, source: 'published', laneMessage: 'This till has 3 receipt number(s) left.' },
    ]);
    const lane = bootPos({ laneId: 'L1', receiptNumbers: box.port });
    expect(lane.receiptsRemaining()).toBeUndefined();
    expect(await lane.nextReceipt()).toBe('R-L1-0001');
    expect(lane.receiptNotice()).toBeUndefined();
    expect(await lane.nextReceipt()).toBe('R-L1-0002');
    expect(lane.receiptsRemaining()).toBe(3);
    expect(lane.receiptNotice()).toMatch(/3 receipt number/);
    expect(new Set(box.keys).size).toBe(2);
  });

  it('when the box gives no number the till stops — it never mints one of its own', async () => {
    const lane = bootPos({ receiptNumbers: answering([]).port });
    await expect(lane.nextReceipt()).rejects.toBeInstanceOf(ReceiptNumberRefusedError);
    await expect(lane.nextReceipt()).rejects.toMatchObject({ refusedBecause: 'receipt_numbers_used_up' });
  });

  it('a till whose store computer cannot be reached gives no number (and invents none)', async () => {
    const lane = bootPos({ lanePort: 1 });
    await expect(lane.nextReceipt()).rejects.toMatchObject({ refusedBecause: 'lane_unreachable', laneMessage: expect.stringMatching(/Do not take money/) });
  });
});
