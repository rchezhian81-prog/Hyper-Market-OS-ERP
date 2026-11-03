import { describe, it, expect } from 'vitest';
import {
  createReceiptDecisionsSession, pendingDecisionsOf, receiptDecisionOutcomeWords, RECEIPT_DECISIONS_COPY, receiptDecisionWords,
} from '../../apps/web-erp/src/goods-receipt-session';

// M07-FR-03 · WF-04 (W4 · SP-6 · §28) — the Goods receipts page's decisions: a held line is put on sale, sent back or claimed,
// and a held excess accepted or refused, by a SECOND person with a reason, over head office's own routes. The person who
// received the delivery is offered nothing (and head office refuses them too — its words are shown).

const receipt = (over: Record<string, unknown> = {}) => ({
  grnId: 'grn-1', warehouseId: 'br-1', receivedBy: 'u-recv', heldMinor: 0,
  captured: { lines: [
    { lineId: 'L1', productId: 'RICE', quarantinedMinor: 0, rejectedMinor: 0, uom: 'ea' },
    { lineId: 'L2', productId: 'OIL', quarantinedMinor: 2, rejectedMinor: 0, uom: 'ea' },
    { lineId: 'L3', productId: 'DAL', quarantinedMinor: 0, rejectedMinor: 1, uom: 'ea' },
  ] },
  ...over,
});
const recorder = (status = 200, answer: unknown = {}) => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    return new Response(JSON.stringify(answer), { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};
const BOSS = { userId: 'u-boss', permissions: ['inventory.availability.read', 'inventory.adjustment.approve', 'inventory.movement.append'] };

describe('what a delivery waits for (M07-FR-03)', () => {
  it('lists each held line not yet decided — a refused one can only go back or be claimed — and a held excess', () => {
    const [g] = pendingDecisionsOf({ receipts: [receipt({ heldMinor: 3 }), receipt({ grnId: 'grn-clean', captured: { lines: [] } })] }, 'u-boss');
    expect(g).toMatchObject({ grnId: 'grn-1', receivedByYou: false, heldExcessMinor: 3, refusedExcessAwaitingReturn: false });
    expect(g!.lines.map((l) => [l.lineId, l.mayAccept])).toEqual([['L2', true], ['L3', false]]);
  });

  it('drops a line already disposed of, and offers a refused excess as "gone back" until it is recorded', () => {
    const list = pendingDecisionsOf({ receipts: [receipt({ heldMinor: 3, excessDecision: { decision: 'rejected' }, dispositions: [{ lineId: 'L2' }, { lineId: 'L3' }] })] }, 'u-boss');
    expect(list).toEqual([expect.objectContaining({ lines: [], heldExcessMinor: 0, refusedExcessAwaitingReturn: true })]);
    expect(pendingDecisionsOf({ receipts: [receipt({ heldMinor: 3, excessDecision: { decision: 'rejected' }, excessReturn: {}, dispositions: [{ lineId: 'L2' }, { lineId: 'L3' }] })] }, 'u-boss')).toEqual([]);
  });

  it('marks a delivery the viewer received as theirs — no decision is theirs to make (§28)', () => {
    expect(pendingDecisionsOf({ receipts: [receipt()] }, 'u-recv')[0]?.receivedByYou).toBe(true);
  });
});

describe('the decisions go to head office\'s own routes, each with its reason (M07-FR-03 · WF-04)', () => {
  it('disposes of a line, decides and returns an excess', async () => {
    const r = recorder();
    const s = createReceiptDecisionsSession({ viewer: BOSS, fetch: r.fetch });
    await s.disposeLine('grn-1', 'L2', 'return', ' tins dented ');
    await s.decideExcess('grn-1', 'rejected', 'not ordered');
    await s.excessReturned('grn-1', 'collected by the lorry');
    await s.pending();
    expect(r.calls).toEqual([
      { method: 'POST', url: '/v1/inventory/goods-receipt/grn-1/lines/L2/disposition', body: { disposition: 'return', reason: 'tins dented' } },
      { method: 'POST', url: '/v1/inventory/goods-receipt/grn-1/excess/decide', body: { decision: 'rejected', reason: 'not ordered' } },
      { method: 'POST', url: '/v1/inventory/goods-receipt/grn-1/excess/returned', body: { reason: 'collected by the lorry' } },
      { method: 'GET', url: '/v1/inventory/goods-receipt' },
    ]);
  });

  it('asks a reason, and refuses a role without the decision right, before calling head office', async () => {
    const r = recorder();
    expect(await createReceiptDecisionsSession({ viewer: BOSS, fetch: r.fetch }).disposeLine('grn-1', 'L2', 'claim', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    const cashier = createReceiptDecisionsSession({ viewer: { userId: 'u-cash', permissions: ['inventory.availability.read'] }, fetch: r.fetch });
    expect(cashier.may).toEqual({ decide: false, recordReturn: false });
    expect(await cashier.decideExcess('grn-1', 'approved', 'ok')).toEqual({ result: 'invalid', why: 'cannotDecide' });
    expect(await createReceiptDecisionsSession({ viewer: undefined, fetch: r.fetch }).pending()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(r.calls).toEqual([]);
  });

  it('shows head office\'s refusal of a self-decision in its own words', async () => {
    const r = recorder(422, { error: { code: 'self_approval', whatHappened: 'u-recv received this delivery; a different person must dispose of it.' } });
    const out = await createReceiptDecisionsSession({ viewer: { ...BOSS, userId: 'u-recv' }, fetch: r.fetch }).disposeLine('grn-1', 'L2', 'accept', 'looks fine');
    expect(receiptDecisionOutcomeWords('en', out, 'decided')).toBe('Head office refused: u-recv received this delivery; a different person must dispose of it.');
  });

  it('speaks English and Tamil for every word', () => {
    for (const k of Object.keys(RECEIPT_DECISIONS_COPY.en)) expect(receiptDecisionWords('ta', k), k).not.toBe(receiptDecisionWords('en', k));
  });
});
