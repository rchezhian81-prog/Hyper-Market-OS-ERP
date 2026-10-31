import { describe, it, expect } from 'vitest';
import { readLiveCounts, todayLiveFigures, openOrdersOf, TODAY_LIVE_WORDS, type LiveCounts } from '../../apps/web-erp/src/today-live-counts';

/**
 * **Screen gap audit (31 Oct 2026) Round A — Today counts the approvals waiting for the signed-in person at head office
 * and head office's open purchase orders (M02-FR-03 · M06 · P-01 · P-08).**
 *
 * Before: "Approvals waiting 0" while an approval waited on the Approvals page, and "Purchase orders open 0" while head
 * office held an open order — Today read only the store computer's pack. Now Today also reads, in the person's own
 * session, `GET /v1/approvals/requests` (head office scopes it: only what this person may decide, never their own) and
 * `GET /v1/purchase/orders` (refused to a role that may not read purchase commitments). Offline the store computer's own
 * figures stay, and say head office was not reached — never a zero dressed as a count.
 */
const BOX = {
  approvalsWaiting: { known: true as const, count: 2 },
  approvalsIcanClear: { known: true as const, count: 1 },
  purchaseOrdersOpen: { known: true as const, value: 0, note: 'of 0 on the box, still awaiting goods' },
};
const reply = (status: number, body: unknown): Response => ({ status, json: async () => body }) as unknown as Response;

describe('open orders, as head office lists them', () => {
  it('a proposed order waits for its second person; an issued one is open while a line is short; received or cancelled is not', () => {
    expect(openOrdersOf([
      { poId: 'P1', status: 'proposed', lines: [{ productId: 'RICE', orderedQty: 10 }] },
      { poId: 'P2', status: 'issued', lines: [{ productId: 'RICE', orderedQty: 10 }], receivedByProduct: { RICE: 4 }, cancelledByProduct: {} },
      { poId: 'P3', status: 'issued', lines: [{ productId: 'OIL', orderedQty: 5 }], receivedByProduct: { OIL: 3 }, cancelledByProduct: { OIL: 2 } },
      { poId: 'P4', status: 'issued', lines: [{ productId: 'DAL', orderedQty: 5 }], receivedByProduct: { DAL: 5 } },
      null, 'junk',
    ])).toEqual({ open: 2, awaitingApproval: 1 });
  });
});

describe('the two reads, in the person\'s own session', () => {
  it('reads what waits for them and the orders; a refusal is kept as a refusal, a dead line as no connection', async () => {
    const seen: string[] = [];
    const counts = await readLiveCounts((async (url: string) => {
      seen.push(url);
      return url === '/v1/approvals/requests'
        ? reply(200, { waitingForMe: [{ requestId: 'a1' }], mine: [], routedToOwnerAboveYourLimit: 1 })
        : reply(403, { error: { code: 'forbidden' } });
    }) as unknown as typeof fetch);
    expect(seen.sort()).toEqual(['/v1/approvals/requests', '/v1/purchase/orders']);
    expect(counts).toEqual({ approvals: { result: 'read', value: { waitingForMe: 1, routedToOwner: 1 } }, purchaseOrders: { result: 'refused', status: 403 } });
    const offline = await readLiveCounts((async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(offline).toEqual({ approvals: { result: 'lost_link' }, purchaseOrders: { result: 'lost_link' } });
    // No head office behind this origin (404) or a fault (502) is "not reached", never a refusal or a zero.
    const absent = await readLiveCounts((async (url: string) => reply(url.includes('approvals') ? 404 : 502, {})) as unknown as typeof fetch);
    expect(absent).toEqual({ approvals: { result: 'lost_link' }, purchaseOrders: { result: 'lost_link' } });
  });
});

describe('the Today figures', () => {
  const live: LiveCounts = {
    approvals: { result: 'read', value: { waitingForMe: 1, routedToOwner: 0 } },
    purchaseOrders: { result: 'read', value: { open: 1, awaitingApproval: 1 } },
  };

  it('one approval waiting at head office is counted (never 0): the store computer\'s two plus head office\'s one', () => {
    const f = todayLiveFigures(BOX, live, 'en');
    expect(f.approvalsWaiting).toMatchObject({ known: true, count: 3 });
    expect(f.approvalsWaiting.note).toBe(`2 ${TODAY_LIVE_WORDS.en.onBox} · 1 ${TODAY_LIVE_WORDS.en.atHeadOffice}`);
    expect(f.headOffice).toEqual({ known: true, count: 1 });
    expect(f.approvalsIcanClear).toEqual({ known: true, count: 2 });
  });

  it('an open order at head office is counted (never 0), and says one waits for its second person', () => {
    const f = todayLiveFigures(BOX, live, 'en');
    expect(f.purchaseOrdersOpen).toMatchObject({ known: true, value: 1 });
    expect((f.purchaseOrdersOpen as { note: string }).note).toMatch(/^1 waiting for a second person's approval/);
  });

  it('a role head office will not show orders to: "your role does not see purchase orders" — not known, never 0', () => {
    const f = todayLiveFigures(BOX, { ...live, purchaseOrders: { result: 'refused', status: 403 } }, 'en');
    expect(f.purchaseOrdersOpen).toEqual({ known: false, why: TODAY_LIVE_WORDS.en.poNotYourRole });
  });

  it('offline (P-01): the store computer\'s own figures stay, each saying head office was not reached', () => {
    const f = todayLiveFigures(BOX, { approvals: { result: 'lost_link' }, purchaseOrders: { result: 'lost_link' } }, 'en');
    expect(f.approvalsWaiting).toMatchObject({ known: true, count: 2 });
    expect(f.approvalsWaiting.note).toMatch(/head office could not be reached, so its approvals are not counted/);
    expect(f.headOffice).toBeNull();
    expect(f.purchaseOrdersOpen).toMatchObject({ known: true, value: 0 });
    expect((f.purchaseOrdersOpen as { note: string }).note).toMatch(/as the store computer last heard$/);
  });

  it('a store computer never given its approvals still counts head office\'s, and says its own list was not given', () => {
    const f = todayLiveFigures({ ...BOX, approvalsWaiting: { known: false, why: 'not told' }, approvalsIcanClear: { known: false, why: 'not told' } }, live, 'en');
    expect(f.approvalsWaiting).toMatchObject({ known: true, count: 1 });
    expect(f.approvalsWaiting.note).toMatch(/the store computer's own list was not given/);
  });

  it('every word has its Tamil twin, and the figures follow the reader\'s language', () => {
    for (const k of Object.keys(TODAY_LIVE_WORDS.en) as (keyof typeof TODAY_LIVE_WORDS.en)[]) {
      expect(TODAY_LIVE_WORDS.ta[k], k).toMatch(/[஀-௿]/);
    }
    expect(todayLiveFigures(BOX, live, 'ta').approvalsWaiting.note).toContain(TODAY_LIVE_WORDS.ta.atHeadOffice);
  });
});
