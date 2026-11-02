// OB-572 "B" (owner, 31 Oct 2026, in writing): office decisions on the hosted copy no longer need "may sell" — each office
// page's work is held to its OWN permission, as the handhelds already are (Round 3). On the box's OFFICE door (the hosted
// front marks it `X-Sre-Door: office` and names the person), the box takes office work only, holds the day close and
// reopen to their own permission, and judges every office item against the word head office re-checks on that record:
// an item the person may not do is refused by name, the rest go on. A store box trusts neither header; the till's door and
// the handheld door are unchanged.

import { describe, it, expect, afterEach } from 'vitest';
import { startLaneServer, type LaneServer, type LaneDeviceRelayHandler, type LaneOperatorPort } from '../../edge/store-edge/src/lane-server';
import { OFFICE_DOOR, OFFICE_WORK_AUTHORITY, judgeOfficeItems, inSentOrder } from '../../edge/store-edge/src/office-door';
import { RELAYABLE_DEVICE_EVENTS } from '../../packages/sync/src/device-relay';
import { SUBJECT_AUTHORITY } from '../../services/identity/src/approval-decisions';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import type { EdgeNode } from '../../edge/store-edge/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

const stubNode = (): EdgeNode => ({
  pack: () => undefined,
  commit: async (id) => ({ committed: true, saleId: id } as never),
  commitReturn: async (id) => ({ committed: true, returnId: id } as never),
  commitCompletion: async (_kind, id) => ({ committed: true, completionId: id } as never),
  commitConcessionTag: async (id) => ({ committed: true, saleId: id, laneMessage: 'saved' } as never),
  lookupSale: async () => undefined,
  takePack: () => ({ accepted: true, staffMessage: '' }),
});

const rolePerms = (id: string): readonly string[] => ROLE_CATALOGUE.find((r) => r.id === id)!.permissions;
/** The box's role register, as its pack says — real roles, none of which may sell at the till. */
const PERMS: Record<string, readonly string[]> = {
  'u-owner': rolePerms('owner'),
  'u-acc': rolePerms('accountant'),
  'u-buyer': rolePerms('purchase_user'),
  'u-recv': rolePerms('receiver_qc'),
  'u-cashier': rolePerms('cashier'),
};
const operators = (trust: boolean): LaneOperatorPort => ({
  laneId: 'lane-1', trustForwardedUser: trust,
  signIn: async () => ({ signedIn: false } as never), signInVerified: async () => ({ signedIn: false } as never),
  check: () => ({ ok: false, refusedBecause: 'not_signed_in', laneMessage: 'no' } as never), signOut: async () => false,
});
const item = (type: string, payload: Record<string, unknown> = {}) => {
  const key = `k-${type}-${Math.random()}`;
  return { key, event: makeEvent({ id: key, type, occurredAt: '2026-11-01T09:00:00.000Z', idempotencyKey: key, source: 'manager', payload }) };
};

describe('each kind of office work names the permission head office re-checks', () => {
  it('every record an office page may hand to the box is judged; an approval by its subject\'s own authority', () => {
    const office = Object.entries(RELAYABLE_DEVICE_EVENTS).filter(([, v]) => v.surfaces.includes('manager')).map(([k]) => k).sort();
    expect(Object.keys(OFFICE_WORK_AUTHORITY).sort()).toEqual(office);
    for (const [subject, word] of Object.entries(SUBJECT_AUTHORITY)) expect(OFFICE_WORK_AUTHORITY['ApprovalDecided']!({ subjectType: subject })).toBe(word);
    expect(OFFICE_WORK_AUTHORITY['ApprovalDecided']!({ subjectType: 'unknown_thing' })).toBeUndefined();
    // Every word is one some role holds — no office work is shut to everybody.
    const held = new Set(ROLE_CATALOGUE.flatMap((r) => r.permissions));
    for (const [type, needs] of Object.entries(OFFICE_WORK_AUTHORITY)) {
      const w = needs({ subjectType: 'purchase_order' });
      expect(w !== undefined && held.has(w), `${type} → ${w}`).toBe(true);
    }
  });

  it('a batch is split item by item: what the person may do goes on, the rest is refused by name, in the order sent', () => {
    const bill = item('SupplierInvoiceCaptured');
    const po = item('ApprovalDecided', { subjectType: 'purchase_order' });
    const odd = item('SomethingElse');
    const judged = judgeOfficeItems([bill, po, odd], 'u-buyer', PERMS['u-buyer']!);
    expect(judged.allowed).toEqual([]);
    expect(judged.refused.map((a) => a.key)).toEqual([bill.key, po.key, odd.key]);
    expect(judged.refused[0]!.reason).toBe(`u-buyer may not do this (SupplierInvoiceCaptured needs purchase.invoice.capture, which their role here does not give). Nothing was taken; the owner or the store manager can do it.`);
    const owner = judgeOfficeItems([bill, po], 'u-owner', PERMS['u-owner']!);
    expect(owner.allowed).toEqual([bill, po]);
    expect(inSentOrder([bill, po, odd], [{ key: po.key, status: 'accepted' }], [{ key: bill.key, status: 'refused' }, { key: odd.key, status: 'refused' }]).map((a) => a.key)).toEqual([bill.key, po.key, odd.key]);
  });
});

describe('the box\'s office door on the hosted copy', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); });
  const taken: string[][] = [];
  const relay: LaneDeviceRelayHandler = async (batch) => {
    taken.push(batch.items.map((r) => (r as { event: { type: string } }).event.type));
    return { acks: batch.items.map((r) => ({ key: (r as { key: string }).key, status: 'accepted' as const })) };
  };
  const closes: string[] = [];
  const start = async (trust = true): Promise<string> => {
    taken.splice(0); closes.splice(0);
    const s = await startLaneServer({
      node: stubNode(), port: 0, relayDeviceEvents: relay, operators: operators(trust), forwardedPermissionsOf: (u) => PERMS[u] ?? null,
      closeDay: async (r) => { closes.push(r.closedBy ?? '(nobody named)'); return { closed: false, blockedBecause: 'test' } as never; },
    });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };
  const door = (user?: string): Record<string, string> => ({ 'x-sre-door': OFFICE_DOOR, ...(user === undefined ? {} : { 'x-sre-user': user }) });
  const post = async (base: string, path: string, body: unknown, headers: Record<string, string>) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('the owner, the accountant and a buyer — none of whom may sell — each hand over their OWN page\'s decisions', async () => {
    const base = await start();
    const po = item('ApprovalDecided', { subjectType: 'purchase_order', decidedBy: 'u-owner' });
    expect((await post(base, '/lane/outbox', { source: 'manager', items: [po] }, door('u-owner'))).body['acks']).toEqual([{ key: po.key, status: 'accepted' }]);
    const bill = item('SupplierInvoiceCaptured', { capturedBy: 'u-acc' });
    const refund = item('ApprovalDecided', { subjectType: 'refund' });
    const acc = await post(base, '/lane/outbox', { source: 'manager', items: [bill, refund] }, door('u-acc'));
    expect(acc.status).toBe(200);
    // OB-617: the accountant matches bills but does not enter them — judged per item; the refund approval is theirs only if
    // their role gives pos.return.approve.
    expect(PERMS['u-acc']!.includes('purchase.invoice.capture')).toBe(false);
    const accAcks = acc.body['acks'] as { key: string; status: string }[];
    expect(accAcks.find((a) => a.key === bill.key)?.status).toBe('refused');
    expect(accAcks.find((a) => a.key === refund.key)?.status).toBe(PERMS['u-acc']!.includes('pos.return.approve') ? 'accepted' : 'refused');
    const count = item('StockCounted', { counterId: 'u-recv' });
    expect((await post(base, '/lane/outbox', { source: 'manager', items: [count] }, door('u-recv'))).body['acks']).toEqual([{ key: count.key, status: 'accepted' }]);
    expect(taken.flat()).toContain('StockCounted');
  });

  it('never wider: an item the person may not do is refused by name and never reaches the box\'s relay; the rest still go', async () => {
    const base = await start();
    const count = item('StockCounted');
    const release = item('QualityHoldReleaseDecided');
    const r = await post(base, '/lane/outbox', { source: 'manager', items: [release, count] }, door('u-recv'));
    expect(r.status).toBe(200);
    const acks = r.body['acks'] as { key: string; status: string; reason?: string }[];
    expect(acks.map((a) => [a.key, a.status])).toEqual([[release.key, 'refused'], [count.key, 'accepted']]);
    expect(acks[0]!.reason).toContain('needs quality.hold.release');
    expect(taken).toEqual([['StockCounted']]);
    // A cashier's office decision is refused, item by item; nothing reaches the relay.
    const cash = await post(base, '/lane/outbox', { source: 'manager', items: [item('ApprovalDecided', { subjectType: 'purchase_order' })] }, door('u-cashier'));
    expect((cash.body['acks'] as { status: string }[])[0]!.status).toBe('refused');
    expect(taken).toHaveLength(1);
  });

  it('nobody named, handheld work, or a till route on the office door is refused before anything is read', async () => {
    const base = await start();
    const nobody = await post(base, '/lane/outbox', { source: 'manager', items: [item('StockCounted')] }, door());
    expect([nobody.status, nobody.body['refusedBecause']]).toEqual([401, 'nobody_signed_in']);
    const handheld = await post(base, '/lane/outbox', { source: 'picker', items: [item('PickLineResolved')] }, door('u-owner'));
    expect([handheld.status, handheld.body['refusedBecause']]).toEqual([403, 'not_office_work']);
    const sale = await post(base, '/lane/sales', { saleId: 's-1' }, door('u-owner'));
    expect([sale.status, sale.body['refusedBecause']]).toEqual([403, 'not_office_work']);
    expect(taken).toEqual([]);
  });

  it('the day close asks its own permission on the office door — the owner may; a buyer may not', async () => {
    const base = await start();
    const buyer = await post(base, '/lane/day-close', { dayCloseId: 'dc-1', closedBy: 'u-buyer' }, door('u-buyer'));
    expect([buyer.status, buyer.body['refusedBecause']]).toEqual([403, 'lacks_permission']);
    expect(String(buyer.body['reason'])).toContain('till.dayclose.read');
    expect(closes).toEqual([]);
    const owner = await post(base, '/lane/day-close', { dayCloseId: 'dc-2', closedBy: 'u-owner' }, door('u-owner'));
    expect(owner.status).not.toBe(403);
  });

  it('a store box trusts neither header, and the till\'s door is unchanged', async () => {
    const store = await start(false);
    const r = await post(store, '/lane/outbox', { source: 'manager', items: [item('ApprovalDecided', { subjectType: 'purchase_order' })] }, door('u-cashier'));
    expect(r.status).toBe(200);
    expect((r.body['acks'] as { status: string }[])[0]!.status).toBe('accepted'); // head office re-checks the decider, as before
    const hosted = await start();
    const till = await post(hosted, '/lane/outbox', { source: 'manager', items: [item('ApprovalDecided', { subjectType: 'purchase_order' })] }, { 'x-sre-user': 'u-cashier' });
    expect(till.status).toBe(200);
  });
});
