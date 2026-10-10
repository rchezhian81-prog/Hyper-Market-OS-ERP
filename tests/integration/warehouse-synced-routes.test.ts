import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { WAREHOUSE_SYNC_FLAGS } from '../../services/inventory/src/warehouse-synced';

/**
 * **The warehouse handheld's scans become head office's facts — re-judged there, with the worker re-verified (SP-3a ·
 * F11 handheld half · M09-FR-01 · M07-FR-01 · M08-FR-01 · §28 · hard rules #2/#4/#10, API-04).**
 *
 * The store box relays what the handheld applied under its sync credential. A put-away or a pick is re-run through the
 * SAME bin engine as the direct route against head office's bins — its refusal (an unknown bin, a draw the bin cannot
 * cover) is 422, the same command again is 200 and the bin moves once; the MOVER is re-verified from their grants and a
 * breach is a flag, never a silent apply. A receiving scan appends ONE `received` movement at the store so on-hand rises;
 * damaged or quarantined stock is recorded and held out of stock, said as a flag; scans read back per GRN. Synthetic.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-09-30T10:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const movement = (commandId: string, over: Record<string, unknown> = {}, command: Record<string, unknown> = {}) => ({
  commandId,
  command: {
    commandId, kind: 'put_away', storeId: 'store-1', productId: 'p-rice', batchId: null, quantityMinor: 10, uom: 'EA',
    fromBinId: null, toBinId: 'BIN-A', movedBy: 'u-worker', at: AT, ...command,
  },
  movements: [], movedBy: 'u-worker', ...over,
});
const scan = (commandId: string, over: Record<string, unknown> = {}) => ({
  commandId, grnId: 'grn-1', productId: 'p-rice', batchId: null, quantityMinor: 12, uom: 'EA', source: 'po', poId: 'po-1',
  state: 'on_hand', expiry: null, receivedBy: 'u-worker', storeId: 'store-1', at: AT, ...over,
});

const relayMove = (h: ApiHarness, body: Record<string, unknown>, key: string, opts: { user?: string; tenant?: string; id?: string } = {}) =>
  h.request({ method: 'POST', path: `/v1/warehouse/movements/${opts.id ?? String(body['commandId'])}/synced`, userId: opts.user ?? 'u-box', tenantId: opts.tenant ?? A, idempotencyKey: key, body });
const relayScan = (h: ApiHarness, body: Record<string, unknown>, key: string, opts: { user?: string; tenant?: string; id?: string } = {}) =>
  h.request({ method: 'POST', path: `/v1/inventory/receiving-scans/${opts.id ?? String(body['commandId'])}/synced`, userId: opts.user ?? 'u-box', tenantId: opts.tenant ?? A, idempotencyKey: key, body });
const bin = async (h: ApiHarness, binId: string) => (await h.request({ method: 'GET', path: `/v1/warehouse/bins/${binId}`, userId: 'u-owner', tenantId: A })).body as { occupancyMinor: number; held: { key: string; quantityMinor: number }[] };
const onHand = async (h: ApiHarness, productId: string, locationId: string): Promise<number> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId } })).body as { rows: { locationId: string; onHandMinor: number }[] })
    .rows.filter((r) => r.locationId === locationId).reduce((s, r) => s + r.onHandMinor, 0);
const scansOf = async (h: ApiHarness, grnId: string) => (await h.request({ method: 'GET', path: '/v1/inventory/receiving-scans', userId: 'u-owner', tenantId: A, query: { grnId } })).body as { count: number; receivedMinor: number; scans: { commandId: string; onHandMovementId: string | null; governanceFlags: string[]; relayedBy: string }[] };

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-worker', 'store_manager'); // holds inventory.movement.append — may move and receive stock
  await h.provisionRole(A, 'u-box', 'store_computer');          // the store box's sync identity
  await h.provisionRole(A, 'u-cust', 'customer');        // no inventory authority
  for (const [binId, capacity] of [['BIN-A', 1000], ['BIN-B', 50]] as const) {
    expect((await h.request({ method: 'POST', path: `/v1/warehouse/bins/${binId}`, userId: 'u-owner', tenantId: A, idempotencyKey: `bin-${binId}`, body: { storeId: 'store-1', capacityMinor: capacity, pickable: true, zone: 'ambient' } })).status).toBe(201);
  }
  return h;
}

describe('a put-away or pick relayed from the handheld re-runs the bin engine at head office', () => {
  it('applies a put-away once — the bin holds it, the same command again is 200, a re-keyed retry too — with the mover re-verified', async () => {
    const h = await seeded();
    const res = await relayMove(h, movement('mv-1'), 'k-mv-1');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ commandId: 'mv-1', outcome: 'moved', accepted: true, movements: 1, flags: [] });
    expect(await bin(h, 'BIN-A')).toMatchObject({ occupancyMinor: 10, held: [{ key: 'BIN-A|p-rice|', quantityMinor: 10 }] });

    const replay = await relayMove(h, movement('mv-1'), 'k-mv-1');
    expect(replay.status).toBeGreaterThanOrEqual(200);
    expect(replay.status).toBeLessThan(300);
    const rekeyed = await relayMove(h, movement('mv-1'), 'k-mv-1-again');
    expect(rekeyed.status).toBe(200);
    expect(rekeyed.body).toMatchObject({ commandId: 'mv-1', alreadyApplied: true, accepted: false });
    expect((await bin(h, 'BIN-A')).occupancyMinor).toBe(10); // once

    // A pick out of the bin the put-away filled.
    const pick = await relayMove(h, movement('pk-1', { orderRef: 'ORD-7', lineId: 'pl-1' }, { kind: 'pick', fromBinId: 'BIN-A', toBinId: null, quantityMinor: 4, reason: 'ORD-7/pl-1' }), 'k-pk-1');
    expect(pick.status).toBe(202);
    expect((await bin(h, 'BIN-A')).occupancyMinor).toBe(6);
  });

  it('refuses what head office\'s bins refuse — an unknown bin, a draw the bin cannot cover, an overflow — as 422 with the engine\'s outcome, nothing moved', async () => {
    const h = await seeded();
    const unknown = await relayMove(h, movement('mv-2', {}, { toBinId: 'BIN-Z' }), 'k-mv-2');
    expect(unknown.status).toBe(422);
    expect(codeOf(unknown)).toBe('movement_unknown_bin');
    const overdraw = await relayMove(h, movement('pk-2', {}, { kind: 'pick', fromBinId: 'BIN-A', toBinId: null, quantityMinor: 5 }), 'k-pk-2');
    expect(overdraw.status).toBe(422);
    expect(codeOf(overdraw)).toBe('movement_insufficient_in_bin');
    const overflow = await relayMove(h, movement('mv-3', {}, { toBinId: 'BIN-B', quantityMinor: 60 }), 'k-mv-3');
    expect(overflow.status).toBe(422);
    expect(codeOf(overflow)).toBe('movement_bin_full');
    expect((await bin(h, 'BIN-A')).occupancyMinor).toBe(0);
    expect((await bin(h, 'BIN-B')).occupancyMinor).toBe(0);
  });

  it('flags — never silently trusts — a mover without the authority or one head office does not know', async () => {
    const h = await seeded();
    const lacks = await relayMove(h, movement('mv-4', { movedBy: 'u-cust' }, { movedBy: 'u-cust' }), 'k-mv-4');
    expect(lacks.status).toBe(202);
    expect((lacks.body as { flags: string[] }).flags).toEqual(['mover_lacks_authority']);
    const unknown = await relayMove(h, movement('mv-5', { movedBy: 'u-nobody' }, { movedBy: 'u-nobody' }), 'k-mv-5');
    expect((unknown.body as { flags: string[] }).flags).toEqual(['mover_unknown']);
    for (const f of [lacks, unknown].flatMap((r) => (r.body as { flags: string[] }).flags)) expect(WAREHOUSE_SYNC_FLAGS).toContain(f);
    // Flagged, but applied — the stock IS in the bin; the flag is for a person.
    expect((await bin(h, 'BIN-A')).occupancyMinor).toBe(20);
  });

  it('refuses a payload it cannot read, a command id that does not match the path, a caller without the sync permission, and another tenant', async () => {
    const h = await seeded();
    const malformed = await relayMove(h, { commandId: 'mv-6', movedBy: 'u-worker' }, 'k-mv-6');
    expect(malformed.status).toBe(400);
    expect(codeOf(malformed)).toBe('not_readable_as_a_relayed_movement');
    expect((await relayMove(h, movement('mv-7'), 'k-mv-7', { id: 'mv-8' })).status).toBe(400);
    expect((await relayMove(h, movement('mv-9', {}, { kind: 'teleport' }), 'k-mv-9')).status).toBe(400);
    expect((await relayMove(h, movement('mv-10'), 'k-mv-10', { user: 'u-cust' })).status).toBe(403);
    expect((await relayMove(h, movement('mv-11'), 'k-mv-11', { tenant: B })).status).toBe(403);
    expect((await bin(h, 'BIN-A')).occupancyMinor).toBe(0);
  });
});

describe('a receiving scan relayed from the handheld raises the store\'s on-hand once, and is kept on the GRN\'s scan register', () => {
  it('good stock: one `received` movement at the store, the scan on the register, read back per GRN; the same scan again is 200 and stock does not double', async () => {
    const h = await seeded();
    expect(await onHand(h, 'p-rice', 'store-1')).toBe(0);
    const res = await relayScan(h, scan('recv-1'), 'k-recv-1');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ commandId: 'recv-1', grnId: 'grn-1', recorded: true, onHand: true, flags: [] });
    expect(await onHand(h, 'p-rice', 'store-1')).toBe(12);

    const replay = await relayScan(h, scan('recv-1'), 'k-recv-1');
    expect(replay.status).toBeGreaterThanOrEqual(200);
    expect(replay.status).toBeLessThan(300);
    const rekeyed = await relayScan(h, scan('recv-1'), 'k-recv-1-again');
    expect(rekeyed.status).toBe(200);
    expect(rekeyed.body).toMatchObject({ commandId: 'recv-1', alreadyRecorded: true, onHand: true });
    expect(await onHand(h, 'p-rice', 'store-1')).toBe(12);

    await relayScan(h, scan('recv-2', { quantityMinor: 3 }), 'k-recv-2');
    const reg = await scansOf(h, 'grn-1');
    expect(reg.count).toBe(2);
    expect(reg.receivedMinor).toBe(15);
    expect(reg.scans.map((s) => [s.commandId, s.onHandMovementId, s.relayedBy])).toEqual([['recv-1', 'recv:grn-1:recv-1', 'u-box'], ['recv-2', 'recv:grn-1:recv-2', 'u-box']]);
    expect(await onHand(h, 'p-rice', 'store-1')).toBe(15);
  });

  it('damaged, quarantined or expired stock is recorded and HELD out of stock — said as a flag, never counted as on-hand', async () => {
    const h = await seeded();
    for (const [id, state] of [['recv-d', 'damaged'], ['recv-q', 'quarantine'], ['recv-x', 'expired']] as const) {
      const res = await relayScan(h, scan(id, { state }), `k-${id}`);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ recorded: true, onHand: false, flags: ['held_out_of_stock'] });
    }
    expect(await onHand(h, 'p-rice', 'store-1')).toBe(0);
    const reg = await scansOf(h, 'grn-1');
    expect(reg.count).toBe(3);
    expect(reg.receivedMinor).toBe(0);
    expect(reg.scans.every((s) => s.onHandMovementId === null && s.governanceFlags.includes('held_out_of_stock'))).toBe(true);
  });

  it('re-verifies the RECEIVER from their grants — flags, never a silent trust — and refuses what it cannot read or who may not relay', async () => {
    const h = await seeded();
    const lacks = await relayScan(h, scan('recv-3', { receivedBy: 'u-cust' }), 'k-recv-3');
    expect(lacks.status).toBe(202);
    expect((lacks.body as { flags: string[] }).flags).toEqual(['receiver_lacks_authority']);
    const unknown = await relayScan(h, scan('recv-4', { receivedBy: 'u-nobody' }), 'k-recv-4');
    expect((unknown.body as { flags: string[] }).flags).toEqual(['receiver_unknown']);
    expect(await onHand(h, 'p-rice', 'store-1')).toBe(24); // flagged, but the goods ARE in the building

    const malformed = await relayScan(h, { commandId: 'recv-5', grnId: 'grn-1' }, 'k-recv-5');
    expect(malformed.status).toBe(400);
    expect(codeOf(malformed)).toBe('not_readable_as_a_receiving_scan');
    expect((await relayScan(h, scan('recv-6'), 'k-recv-6', { id: 'recv-7' })).status).toBe(400);
    expect((await relayScan(h, scan('recv-8'), 'k-recv-8', { user: 'u-cust' })).status).toBe(403);
    expect((await relayScan(h, scan('recv-9'), 'k-recv-9', { tenant: B })).status).toBe(403);
    expect((await h.request({ method: 'GET', path: '/v1/inventory/receiving-scans', userId: 'u-owner', tenantId: A })).status).toBe(400);
  });
});
