import { describe, it, expect } from 'vitest';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { recallTracePayload, GLOBAL_FOR, SCREENS, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { APP_SHELL } from '../../edge/store-edge/src/screen-server';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

// OB-288 integration follow-up: the Recalls and trace page (M10-FR-03/04) served from the store box. What the box can
// say with the line down is what this store's tills refuse now, from the signed catalogue it holds — never a guess
// (P-08). Synthetic data only.

const NOW = '2026-10-23T06:00:00.000Z';
const KEY = ['recall', 'trace', 'unit', 'signing', 'key'].join('-').padEnd(48, '0');
const snapshot: CatalogueSnapshot = {
  tenantId: 't-sre', version: 4, builtAt: '2026-10-23T05:00:00.000Z',
  products: [
    { productId: 'P-PANEER', sku: 'PANEER', name: 'Paneer 200g', baseUom: 'ea', unitPriceMinor: 9_000, taxBps: 500, status: 'active', recallBlock: true, blockedBatches: ['B-1', 'B-2'] },
    { productId: 'P-CURD', sku: 'CURD', name: 'Curd 400g', baseUom: 'ea', unitPriceMinor: 6_000, taxBps: 500, status: 'active', recallBlock: true, blockedBatches: [] },
    { productId: 'P-RICE', sku: 'RICE', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 7_000, taxBps: 0, status: 'active' },
  ],
  barcodes: [],
};
const signed = (() => {
  const r = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-owner', publishedAt: snapshot.builtAt });
  if (r.pack === undefined) throw new Error(r.detail);
  return r.pack;
})();
const input = (pack: Record<string, unknown>, withCatalogue = true): ScreenInput =>
  ({ pack: readPack({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'S1' }, ...pack }, NOW), now: NOW, tradingDay: '2026-10-23', ...(withCatalogue ? { cataloguePack: signed } : {}) }) as unknown as ScreenInput;
const register = {
  roles: [{ id: 'qc', name: 'Quality', permissions: ['quality.lottrace.read', 'quality.recall.read'] }, { id: 'clerk', name: 'Clerk', permissions: ['stock.count'] }],
  roleAssignments: [{ userId: 'u-qc', roleId: 'qc', branchScope: 'all' }],
};

describe('the store box serves the Recalls and trace page', () => {
  it('is a box screen, read from the web-erp page, under its own global', () => {
    expect(SCREENS).toContain('recall-trace');
    expect(APP_SHELL['recall-trace']).toEqual({ dir: 'web-erp', file: 'recall-trace.html' });
    expect(GLOBAL_FOR['recall-trace']).toBe('recallTraceData');
  });

  it('says nothing when the box has not been told who is on the quality screen', () => {
    expect(recallTracePayload(input({}))).toBeNull();
  });

  it('lists what the tills refuse now: the named batches, or every batch when none is named — from the signed catalogue, with its version', () => {
    const p = recallTracePayload(input({ expiryPolicy: { nearExpiryDays: 2, userId: 'u-qc' }, ...register }))!;
    expect(p).toMatchObject({ userId: 'u-qc', storeId: 'S1' });
    expect([...(p['permissions'] as string[])].sort()).toEqual(['quality.lottrace.read', 'quality.recall.read']);
    expect(p['tillBlocks']).toEqual({
      packVersion: 4, builtAt: '2026-10-23T05:00:00.000Z',
      products: [{ productId: 'P-PANEER', name: 'Paneer 200g', batches: ['B-1', 'B-2'] }, { productId: 'P-CURD', name: 'Curd 400g', batches: null }],
    });
  });

  it('with no catalogue held, says it does not know (null) — never an empty "the tills refuse nothing"', () => {
    const p = recallTracePayload(input({ expiryPolicy: { nearExpiryDays: 2, userId: 'u-qc' }, ...register }, false))!;
    expect(p['tillBlocks']).toBeNull();
  });

  it('with no role register on the box, leaves the permissions out rather than claiming the person holds none', () => {
    const p = recallTracePayload(input({ expiryPolicy: { nearExpiryDays: 2, userId: 'u-qc' } }))!;
    expect('permissions' in p).toBe(false);
    expect(p['userId']).toBe('u-qc');
  });
});
