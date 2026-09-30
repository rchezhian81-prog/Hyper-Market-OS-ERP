import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  DEVICE_ITEM_STATES, DEVICE_OUTBOX_PATH, DEVICE_OUTBOX_STATUS_PATH, RELAYABLE_DEVICE_EVENTS, HANDHELD_SOURCES,
  deviceItemReason, deviceItemState, isHandheldSource, isRelayable, readRelayBatch, readRelayItem, relayableItems,
} from '../../packages/sync/src/device-relay';
import { boxStatus, drainToBox, type FetchLike } from '../../packages/sync/src/device-drain';

/**
 * **The ONE device → store-computer contract and drain every screen and handheld shares (SP-2a · F11 · §31 ·
 * hard rules #6/#10).**
 *
 * The audit's F11: the manager's decisions lived in a `new SyncOutbox()` and nothing drained any device queue.
 * This is the shared leg that ends that, proven at the seam where a device's queue meets the box's answer:
 *   • the contract reads strictly (a malformed item is a refusal with its reason, never a repair);
 *   • the drain settles each item from the box's per-item answer — accepted/duplicate → handed, refused →
 *     dead-lettered with the reason, not_saved/no answer → kept and counted, link down → everything kept, nothing
 *     dead-lettered (a device offline for a day loses nothing);
 *   • a retry after a lost reply lands on `duplicate` and is the same fact as `accepted` — one effect;
 *   • only allow-listed types for the source are ever sent;
 *   • the five state words derive from the device's item and the box's word, and "posted" is never claimed on
 *     the device's own say-so.
 */

const AT = '2026-09-30T10:00:00.000Z';
const decided = (id: string) => makeEvent({
  id: `approval-decision-${id}`, type: 'ApprovalDecided', occurredAt: AT, idempotencyKey: `approval-decision-${id}`,
  source: 'web-erp/manager', payload: { id, status: 'approved' },
});
// A type nobody reviewed for the device route: a sale never travels this way (the till has its own path).
const other = (id: string) => makeEvent({
  id: `x-${id}`, type: 'SaleCommitted', occurredAt: AT, idempotencyKey: `x-${id}`, source: 'web-erp/manager', payload: { saleId: id },
});

type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };
function fakeBox(answer: (call: Call) => { status: number; body: unknown } | 'down'): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init: { method: init.method, headers: { ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) } };
    calls.push(call);
    const a = answer(call);
    if (a === 'down') throw new Error('ECONNREFUSED');
    return { status: a.status, json: async () => a.body };
  };
  return { fetch, calls };
}

describe('the contract reads strictly and refuses with a reason', () => {
  it('accepts a well-formed item whose key is the event\'s own idempotency key', () => {
    const e = decided('a1');
    const read = readRelayItem({ key: e.idempotencyKey, event: e });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.item.event).toEqual(e);
  });

  it.each([
    ['not an object', 'an item must be an object'],
    [{ event: decided('a1') }, 'needs a non-empty key'],
    [{ key: 'k' }, 'needs an event object'],
    [{ key: 'k', event: { ...decided('a1'), type: '' } }, 'has no type'],
    [{ key: 'k', event: { ...decided('a1'), version: 0 } }, 'has no version'],
    [{ key: 'k', event: decided('a1') }, 'must be the event\'s own idempotency key'],
  ])('refuses %j with the reason', (raw, reason) => {
    const read = readRelayItem(raw);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain(reason);
  });

  it('reads the envelope: a source and a list, nothing else assumed', () => {
    expect(readRelayBatch({ source: 'manager', items: [] })).toEqual({ ok: true, source: 'manager', items: [] });
    expect(readRelayBatch({ items: [] }).ok).toBe(false);
    expect(readRelayBatch({ source: 'manager' }).ok).toBe(false);
    expect(readRelayBatch(null).ok).toBe(false);
  });

  it('allow-lists by type AND source — a type nobody reviewed cannot ride the store\'s credential', () => {
    expect(RELAYABLE_DEVICE_EVENTS['ApprovalDecided']?.surfaces).toEqual(['manager']);
    // SP-7a: a supplier invoice captured on the buyer's screen rides as the ERP surface the box serves — never a handheld's.
    expect(RELAYABLE_DEVICE_EVENTS['SupplierInvoiceCaptured']?.surfaces).toEqual(['manager']);
    expect(isRelayable('SupplierInvoiceCaptured', 'warehouse')).toBe(false);
    expect(isRelayable('ApprovalDecided', 'manager')).toBe(true);
    expect(isRelayable('ApprovalDecided', 'picker')).toBe(false);
    // SP-2b: the manager's receipts and blind counts ride the same route; a sale never does.
    expect(RELAYABLE_DEVICE_EVENTS['GoodsReceived']?.surfaces).toEqual(['manager']);
    expect(RELAYABLE_DEVICE_EVENTS['FloorIndentRequested']?.surfaces).toEqual(['manager']);
    expect(RELAYABLE_DEVICE_EVENTS['FloorIndentReceived']?.surfaces).toEqual(['manager']);
    expect(RELAYABLE_DEVICE_EVENTS['StockCounted']?.surfaces).toEqual(['manager', 'warehouse']);
    expect(RELAYABLE_DEVICE_EVENTS['AdjustmentRequested']?.surfaces).toEqual(['warehouse']);
    expect(isRelayable('GoodsReceived', 'manager')).toBe(true);
    expect(isRelayable('StockCounted', 'manager')).toBe(true);
    expect(isRelayable('StockCounted', 'warehouse')).toBe(true); // W2 (SP-3b): the handheld's bin count rides the same type
    expect(isRelayable('AdjustmentRequested', 'manager')).toBe(false); // a request is raised at the racking, not at the desk
    expect(isRelayable('SaleCommitted', 'manager')).toBe(false);
    // SP-3a: the warehouse handheld's scans ride the device socket as the `warehouse` surface — and only that surface.
    expect(RELAYABLE_DEVICE_EVENTS['WarehouseMovementApplied']?.surfaces).toEqual(['warehouse']);
    expect(RELAYABLE_DEVICE_EVENTS['ReceivingScanned']?.surfaces).toEqual(['warehouse']);
    // SP-6b: the delivery's completion rides behind its scans — the warehouse handheld's alone, never the desk's.
    expect(RELAYABLE_DEVICE_EVENTS['ReceivingCompleted']?.surfaces).toEqual(['warehouse']);
    expect(isRelayable('ReceivingCompleted', 'manager')).toBe(false);
    expect(isRelayable('WarehouseMovementApplied', 'manager')).toBe(false);
    expect(isRelayable('ReceivingScanned', 'picker')).toBe(false);
    // A handheld may claim only a handheld surface on the device socket; `manager` is never one.
    expect([...HANDHELD_SOURCES]).toEqual(['warehouse', 'picker', 'driver']);
    expect(isHandheldSource('warehouse')).toBe(true);
    expect(isHandheldSource('manager')).toBe(false);
    const outbox = new SyncOutbox();
    outbox.enqueue(decided('a1'));
    outbox.enqueue(other('g1'));
    expect(relayableItems(outbox.pending(), 'manager').map((i) => i.key)).toEqual(['approval-decision-a1']);
  });

  it('names the routes once, for the device and the box alike', () => {
    expect(DEVICE_OUTBOX_PATH).toBe('/lane/outbox');
    expect(DEVICE_OUTBOX_STATUS_PATH).toBe('/lane/outbox/status');
  });
});

describe('the five state words a person sees', () => {
  it('lists exactly the owner\'s five, in order', () => {
    expect([...DEVICE_ITEM_STATES]).toEqual(['saved_here', 'retrying', 'handed_to_box', 'posted', 'refused']);
  });

  it('derives each from the device item and the box\'s word — never "posted" on the device\'s own say-so', () => {
    const outbox = new SyncOutbox();
    const item = outbox.enqueue(decided('a1'));
    expect(deviceItemState(item)).toBe('saved_here');
    outbox.recordFailure(item.key);
    expect(deviceItemState(outbox.find(item.key)!)).toBe('retrying');
    outbox.acknowledge(item.key);
    const handed = outbox.find(item.key)!;
    expect(deviceItemState(handed)).toBe('handed_to_box');
    expect(deviceItemState(handed, { key: item.key, state: 'pending', attempts: 2 })).toBe('handed_to_box');
    expect(deviceItemState(handed, { key: item.key, state: 'posted', attempts: 0 })).toBe('posted');
    expect(deviceItemState(handed, { key: item.key, state: 'refused', attempts: 1, reason: 'conflict: …' })).toBe('refused');
    expect(deviceItemReason(handed, { key: item.key, state: 'refused', attempts: 1, reason: 'conflict: …' })).toBe('conflict: …');
    const dead = new SyncOutbox();
    const d = dead.enqueue(decided('a2'));
    dead.deadLetter(d.key, 'refused by the store computer: not a record this box relays');
    expect(deviceItemState(dead.find(d.key)!)).toBe('refused');
    expect(deviceItemReason(dead.find(d.key)!)).toContain('not a record this box relays');
  });
});

describe('drainToBox settles each item from the box\'s per-item answer', () => {
  it('sends only relayable pending items, in order, as one batch to /lane/outbox', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(decided('a1'));
    outbox.enqueue(other('g1'));
    outbox.enqueue(decided('a2'));
    const box = fakeBox(() => ({ status: 200, body: { acks: [{ key: 'approval-decision-a1', status: 'accepted' }, { key: 'approval-decision-a2', status: 'duplicate' }] } }));
    const result = await drainToBox({ outbox, boxBase: 'http://127.0.0.1:9', source: 'manager', fetch: box.fetch });
    expect(result).toEqual({ attempted: 2, handed: 2, refused: 0, failed: 0, offline: false });
    expect(box.calls).toHaveLength(1);
    expect(box.calls[0]?.url).toBe('http://127.0.0.1:9/lane/outbox');
    expect(box.calls[0]?.init.method).toBe('POST');
    expect(box.calls[0]?.init.headers['content-type']).toBe('application/json');
    const sent = JSON.parse(box.calls[0]!.init.body!) as { source: string; items: { key: string }[] };
    expect(sent.source).toBe('manager');
    expect(sent.items.map((i) => i.key)).toEqual(['approval-decision-a1', 'approval-decision-a2']);
    // accepted AND duplicate both mean "the box has it": acknowledged on the device (one effect, §31.1).
    expect(outbox.find('approval-decision-a1')?.state).toBe('acknowledged');
    expect(outbox.find('approval-decision-a2')?.state).toBe('acknowledged');
    // The non-relayable item was neither sent nor touched.
    expect(outbox.find('x-g1')?.state).toBe('pending');
  });

  it('dead-letters a refused item WITH the box\'s reason, and keeps a not_saved or unanswered one for another try', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(decided('a1'));
    outbox.enqueue(decided('a2'));
    outbox.enqueue(decided('a3'));
    const box = fakeBox(() => ({ status: 200, body: { acks: [
      { key: 'approval-decision-a1', status: 'refused', reason: 'ApprovalDecided is not a record this box relays for manager' },
      { key: 'approval-decision-a2', status: 'not_saved', reason: 'no room left' },
    ] } }));
    const result = await drainToBox({ outbox, boxBase: 'http://127.0.0.1:9', source: 'manager', fetch: box.fetch });
    expect(result).toEqual({ attempted: 3, handed: 0, refused: 1, failed: 2, offline: false });
    expect(outbox.find('approval-decision-a1')?.state).toBe('dead_letter');
    expect(outbox.find('approval-decision-a1')?.reason).toMatch(/^refused by the store computer: .*not a record this box relays/);
    expect(outbox.find('approval-decision-a2')).toMatchObject({ state: 'pending', attempts: 1 });
    expect(outbox.find('approval-decision-a3')).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('a box that cannot be reached keeps EVERYTHING and dead-letters NOTHING — a link failure is not a refusal', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(decided('a1'));
    outbox.enqueue(decided('a2'));
    const box = fakeBox(() => 'down');
    const result = await drainToBox({ outbox, boxBase: 'http://127.0.0.1:9', source: 'manager', fetch: box.fetch });
    expect(result).toEqual({ attempted: 2, handed: 0, refused: 0, failed: 2, offline: true });
    expect(outbox.pending()).toHaveLength(2);
    expect(outbox.deadLetters()).toHaveLength(0);
    expect(outbox.find('approval-decision-a1')?.attempts).toBe(1);
  });

  it('a box that declines the whole batch (400/403/415/500) is a failed attempt on every item, never a verdict', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(decided('a1'));
    const box = fakeBox(() => ({ status: 415, body: { acks: [], reason: 'application/json only' } }));
    const result = await drainToBox({ outbox, boxBase: 'http://127.0.0.1:9', source: 'manager', fetch: box.fetch });
    expect(result).toEqual({ attempted: 1, handed: 0, refused: 0, failed: 1, offline: false });
    expect(outbox.find('approval-decision-a1')).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('the lost-reply case: the box took it, the reply was lost, the retry hears duplicate — handed once, one effect', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(decided('a1'));
    const taken = new Set<string>();
    let dropReply = true;
    const box = fakeBox((call) => {
      const sent = JSON.parse(call.init.body!) as { items: { key: string }[] };
      const acks = sent.items.map((i) => ({ key: i.key, status: taken.has(i.key) ? 'duplicate' : 'accepted' }));
      for (const i of sent.items) taken.add(i.key);
      if (dropReply) { dropReply = false; return 'down'; }
      return { status: 200, body: { acks } };
    });
    const first = await drainToBox({ outbox, boxBase: 'http://127.0.0.1:9', source: 'manager', fetch: box.fetch });
    expect(first.offline).toBe(true);
    expect(outbox.find('approval-decision-a1')).toMatchObject({ state: 'pending', attempts: 1 });
    const second = await drainToBox({ outbox, boxBase: 'http://127.0.0.1:9', source: 'manager', fetch: box.fetch });
    expect(second).toEqual({ attempted: 1, handed: 1, refused: 0, failed: 0, offline: false });
    expect(outbox.find('approval-decision-a1')?.state).toBe('acknowledged');
    expect(taken.size).toBe(1);
  });

  it('bounds a pass to `limit` items and sends nothing when nothing is pending', async () => {
    const outbox = new SyncOutbox();
    for (let i = 0; i < 5; i += 1) outbox.enqueue(decided(`a${i}`));
    const box = fakeBox((call) => ({ status: 200, body: { acks: (JSON.parse(call.init.body!) as { items: { key: string }[] }).items.map((i) => ({ key: i.key, status: 'accepted' })) } }));
    expect((await drainToBox({ outbox, boxBase: 'http://127.0.0.1:9', source: 'manager', fetch: box.fetch, limit: 2 })).handed).toBe(2);
    expect(outbox.pending()).toHaveLength(3);
    const empty = new SyncOutbox();
    const quiet = fakeBox(() => ({ status: 200, body: { acks: [] } }));
    expect(await drainToBox({ outbox: empty, boxBase: 'http://127.0.0.1:9', source: 'manager', fetch: quiet.fetch })).toEqual({ attempted: 0, handed: 0, refused: 0, failed: 0, offline: false });
    expect(quiet.calls).toHaveLength(0);
  });
});

describe('boxStatus asks the box where handed items have got to', () => {
  it('GETs /lane/outbox/status?keys= and reads only well-formed rows', async () => {
    const box = fakeBox(() => ({ status: 200, body: { items: [
      { key: 'k1', state: 'posted', attempts: 0 },
      { key: 'k2', state: 'refused', attempts: 1, reason: 'conflict: …' },
      { key: 'k3', state: 'somewhere-odd', attempts: 0 },
      { nokey: true },
    ] } }));
    const rows = await boxStatus({ boxBase: 'http://127.0.0.1:9', keys: ['k1', 'k2', 'k3'], fetch: box.fetch });
    expect(box.calls[0]?.url).toBe(`http://127.0.0.1:9/lane/outbox/status?keys=${encodeURIComponent('k1,k2,k3')}`);
    expect(box.calls[0]?.init.method).toBe('GET');
    expect(rows).toEqual([
      { key: 'k1', state: 'posted', attempts: 0 },
      { key: 'k2', state: 'refused', attempts: 1, reason: 'conflict: …' },
    ]);
  });

  it('answers undefined — not "posted", not "refused" — when the box cannot be asked', async () => {
    const down = fakeBox(() => 'down');
    expect(await boxStatus({ boxBase: 'http://127.0.0.1:9', keys: ['k1'], fetch: down.fetch })).toBeUndefined();
    const notFound = fakeBox(() => ({ status: 404, body: {} }));
    expect(await boxStatus({ boxBase: 'http://127.0.0.1:9', keys: ['k1'], fetch: notFound.fetch })).toBeUndefined();
    const quiet = fakeBox(() => ({ status: 200, body: { items: [] } }));
    expect(await boxStatus({ boxBase: 'http://127.0.0.1:9', keys: [], fetch: quiet.fetch })).toEqual([]);
    expect(quiet.calls).toHaveLength(0);
  });
});
