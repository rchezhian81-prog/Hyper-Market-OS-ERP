import { describe, it, expect } from 'vitest';
import { readPack, emptyPack, type StorePack } from '../../edge/store-edge/src/store-pack';
import { warehouseSupervisorPayload } from '../../edge/store-edge/src/screen-data';
import { bootWarehouseSupervisor, type SupervisorData } from '../../apps/web-erp/src/warehouse-supervisor-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **The Web ERP warehouse supervisor is fed from the same authoritative data the handheld reads
 * (M09 / OA-9).** This is the supervisory half of the dual-interface warehouse: the box serves the
 * `warehouse` section (bins, contents, recalls) and the supervisor session presents bin configuration,
 * stock visibility, occupancy and the exception queue — reusing `packages/warehouse` (`binOccupancy`),
 * never a second copy of the rules. It holds the box's one rule: contents the box was never sent are
 * NOT KNOWN, not an empty (healthy) warehouse.
 */

const NOW = '2026-08-08T12:00:00.000Z';

const CLOUD_PACK = {
  version: 4,
  warehouse: {
    assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
    bins: [
      { binId: 'B-PICK', storeId: 'store-1', capacityMinor: 100, pickable: true },
      { binId: 'B-SMALL', storeId: 'store-1', capacityMinor: 10, pickable: true },
      { binId: 'B-HOLD', storeId: 'store-1', capacityMinor: 100, pickable: false, zone: 'quarantine' },
    ],
    contents: {
      'B-PICK|P1|': 40,        // healthy
      'B-PICK|P2|B-RECALL': 5, // recalled stock in a pickable bin → exception
      'B-SMALL|P3|': 25,       // over its capacity of 10 → exception
      'B-HOLD|P4|': -3,        // negative → exception
    },
    recalledBatchIds: ['B-RECALL'],
  },
};

const screenInput = (pack: StorePack) => ({
  pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-08-08',
});

describe('the warehouse supervisor screen is fed from the authoritative warehouse data (M09 / OA-9)', () => {
  it('shows bin configuration with occupancy, and stock visibility, from the served contents', () => {
    const payload = warehouseSupervisorPayload(screenInput(readPack(CLOUD_PACK, NOW)));
    expect(payload).not.toBeNull();
    const s = bootWarehouseSupervisor(payload as unknown as SupervisorData)!;
    expect(s).not.toBeNull();

    const pick = s.bins().find((b) => b.binId === 'B-PICK')!;
    expect(pick).toMatchObject({ capacityMinor: 100, usedMinor: 45, freeMinor: 55, pctFull: 45 });

    const stock = s.stock();
    expect(stock.known).toBe(true);
    if (!stock.known) return;
    expect(stock.rows.find((r) => r.binId === 'B-PICK' && r.productId === 'P1')?.quantityMinor).toBe(40);
  });

  it('surfaces the exception queue: negative bin, over-capacity, and recalled stock in a pickable bin', () => {
    const payload = warehouseSupervisorPayload(screenInput(readPack(CLOUD_PACK, NOW)));
    const s = bootWarehouseSupervisor(payload as unknown as SupervisorData)!;

    const ex = s.exceptions();
    expect(ex.known).toBe(true);
    if (!ex.known) return;
    const kinds = ex.rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['negative_stock', 'over_capacity', 'recalled_in_pickable_bin']);
    expect(ex.rows.find((r) => r.kind === 'over_capacity')?.binId).toBe('B-SMALL');
    expect(ex.rows.find((r) => r.kind === 'recalled_in_pickable_bin')?.productId).toBe('P2');
  });

  it('answers NOT KNOWN for stock and exceptions when the box sent bins but no contents', () => {
    // A supervisor with the bin map but not the contents must not be shown a healthy, empty warehouse.
    const pack = readPack({ version: 4, warehouse: {
      assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
      bins: [{ binId: 'B-PICK', storeId: 'store-1', capacityMinor: 100, pickable: true }],
    } }, NOW);
    const s = bootWarehouseSupervisor(warehouseSupervisorPayload(screenInput(pack)) as unknown as SupervisorData)!;

    expect(s.bins()[0]).toMatchObject({ binId: 'B-PICK', usedMinor: null, freeMinor: null }); // config known, fill not
    expect(s.stock().known).toBe(false);
    expect(s.exceptions().known).toBe(false);
  });

  it('serves NOTHING when the box was never told about warehouse work at all', () => {
    expect(warehouseSupervisorPayload(screenInput(readPack({ version: 4 }, NOW)))).toBeNull();
    expect(warehouseSupervisorPayload(screenInput(emptyPack()))).toBeNull();
    expect(bootWarehouseSupervisor(undefined)).toBeNull();
  });
});

describe('the supervisor decides the §28 approvals the floor raises, and queues them for sync', () => {
  const withApprovals = {
    version: 4,
    warehouse: {
      assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
      bins: [{ binId: 'B-PICK', storeId: 'store-1', capacityMinor: 100, pickable: true }],
      supervisor: { userId: 'u-super', branchScope: 'all', authorityLimitMinor: 1_000_00, currency: 'INR' },
      approvals: [
        { id: 'ap-1', subjectType: 'stock_adjustment', subjectRef: 'adj-1', requestedBy: 'u-wh', valueMinor: 500_00, currency: 'INR' },
        { id: 'ap-own', subjectType: 'count_variance', subjectRef: 'cnt-9', requestedBy: 'u-super', valueMinor: 200_00, currency: 'INR' },
      ],
    },
  };

  const supervisor = () =>
    bootWarehouseSupervisor(warehouseSupervisorPayload(screenInput(readPack(withApprovals, NOW))) as unknown as SupervisorData)!;

  it('shows the queue, marking the supervisor’s own request not actionable (§28)', () => {
    const q = supervisor().approvalQueue();
    expect(q.known).toBe(true);
    if (!q.known) return;
    expect(q.rows.find((r) => r.request.id === 'ap-1')?.actionable).toBe(true);
    const own = q.rows.find((r) => r.request.id === 'ap-own');
    expect(own?.actionable).toBe(false);
    expect(own?.blockedReason).toBe('own_request');
  });

  it('approves a floor request with a reason code and queues the decision', () => {
    const s = supervisor();
    const outbox = new SyncOutbox();
    const out = s.decide({ requestId: 'ap-1', decision: 'approved', reasonCode: 'checked_the_stock', decidedAt: NOW }, outbox);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.request).toMatchObject({ id: 'ap-1', status: 'approved', decidedBy: 'u-super', reason: 'checked_the_stock' });
    expect(outbox.pending().map((i) => i.event.type)).toEqual(['WarehouseApprovalDecided']);
  });

  it('refuses the supervisor deciding their own request (§28) and queues nothing', () => {
    const s = supervisor();
    const outbox = new SyncOutbox();
    const out = s.decide({ requestId: 'ap-own', decision: 'approved', reasonCode: 'within_policy', decidedAt: NOW }, outbox);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toBe('self_approval_forbidden');
    expect(outbox.unsentCount()).toBe(0);
  });

  it('refuses an invented reason code, and an unknown request', () => {
    const s = supervisor();
    const outbox = new SyncOutbox();
    expect((s.decide({ requestId: 'ap-1', decision: 'approved', reasonCode: 'because_i_said_so', decidedAt: NOW }, outbox) as { refusal: string }).refusal).toBe('unknown_reason_code');
    expect((s.decide({ requestId: 'ghost', decision: 'approved', reasonCode: 'within_policy', decidedAt: NOW }, outbox) as { refusal: string }).refusal).toBe('request_not_found');
    expect(outbox.unsentCount()).toBe(0);
  });

  it('answers the queue NOT KNOWN when the box sent no approvals or no supervisor identity', () => {
    const noAppr = bootWarehouseSupervisor(warehouseSupervisorPayload(screenInput(readPack({ version: 4, warehouse: {
      assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
      bins: [{ binId: 'B-PICK', storeId: 'store-1', capacityMinor: 100, pickable: true }],
    } }, NOW))) as unknown as SupervisorData)!;
    expect(noAppr.approvalQueue().known).toBe(false);
    expect(noAppr.decide({ requestId: 'x', decision: 'approved', reasonCode: 'within_policy', decidedAt: NOW }, new SyncOutbox())).toMatchObject({ ok: false, refusal: 'not_configured' });
  });
});
