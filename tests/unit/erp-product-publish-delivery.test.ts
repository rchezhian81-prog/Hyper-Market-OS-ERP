import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { buildProductPublishCommand } from '../../apps/web-erp/src/catalogue-publish-command';
import {
  deliverReadyPublishes, deliverOnePublish, classifyPublishResponse,
  type PublishDeliveryPort, type PublishHttp,
} from '../../apps/web-erp/src/product-publish-delivery';
import { PUBLISH_PERMISSION, type PublishReviewContext } from '../../apps/web-erp/src/product-publish-queue';
import type { ProductPublishPayload, ProductPublishBarcode } from '../../apps/web-erp/src/catalogue-publish-command';
import type { ProductRecord, Category, BarcodeKind } from '../../packages/product/src/index';

// ADR-0013 slice 2: deliver the READY product-publishes, as the signed-in operator, to the idempotent cloud
// route — transitioning the durable outbox honestly on each result, and never sending anything the review
// did not clear.

const GROCERY: Category = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const salt = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  productId: 'p-salt', tenantId: 't1', sku: 'SKU-SALT', name: 'Tata Salt 1kg',
  baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'new', ...over,
});

const outboxWith = (records: ProductRecord[]): SyncOutbox<string, ProductPublishPayload> => {
  const ob = new SyncOutbox<string, ProductPublishPayload>();
  records.forEach((r, i) =>
    ob.enqueue(buildProductPublishCommand({ record: r, categories: [GROCERY], barcodes: [{ code: `bc-${i}`, kind: 'ean' }], requestedBy: 'u-owner', at: '2026-08-18T06:00:00.000Z' })));
  return ob;
};

const ctx = (over: Partial<PublishReviewContext> = {}): PublishReviewContext => ({
  userId: 'u-owner', tenantId: 't1', permissions: new Set([PUBLISH_PERMISSION]),
  sessionActive: true, tenantMember: true, ...over,
});

/** A fake operator-session port that returns a fixed status per idempotency key (or a default). */
const port = (statuses: Record<string, number> = {}, dflt = 201): PublishDeliveryPort & { readonly sent: string[] } => {
  const sent: string[] = [];
  return {
    sent,
    post: async (_payload: ProductPublishPayload, key: string) => { sent.push(key); return statuses[key] ?? dflt; },
  };
};

describe('product-publish delivery (ADR-0013)', () => {
  it('delivers a ready item (201) and acknowledges it in the outbox', async () => {
    const ob = outboxWith([salt()]);
    const p = port();
    const report = await deliverReadyPublishes(ob, ctx(), p);
    expect(report.delivered).toHaveLength(1);
    expect(ob.pending()).toHaveLength(0); // acknowledged
    expect(p.sent).toHaveLength(1);
  });

  it('dead-letters a 409 — a real conflict (sku/barcode already taken), never an idempotent replay', async () => {
    // The kernel returns the first response's cached status for a replay, so a 409 that reaches here is
    // always a genuine one-of-a-kind clash a person must resolve — not "already had it".
    const ob = outboxWith([salt()]);
    const key = ob.pending()[0]!.key;
    const report = await deliverReadyPublishes(ob, ctx(), port({ [key]: 409 }));
    expect(report.refused).toEqual([key]);
    expect(ob.find(key)?.state).toBe('dead_letter');
  });

  it('holds a retryable failure (503) — stays pending, attempt counted, nothing lost', async () => {
    const ob = outboxWith([salt()]);
    const key = ob.pending()[0]!.key;
    const report = await deliverReadyPublishes(ob, ctx(), port({ [key]: 503 }));
    expect(report.held).toEqual([key]);
    expect(ob.find(key)?.state).toBe('pending');
    expect(ob.find(key)?.attempts).toBe(1);
  });

  it('dead-letters a permanent refusal (403) — visible for a person, never dropped', async () => {
    const ob = outboxWith([salt()]);
    const key = ob.pending()[0]!.key;
    const report = await deliverReadyPublishes(ob, ctx(), port({ [key]: 403 }));
    expect(report.refused).toEqual([key]);
    expect(ob.find(key)?.state).toBe('dead_letter');
    expect(ob.deadLetters()).toHaveLength(1);
  });

  it('delivers ONLY what the review cleared: a no-permission operator sends nothing', async () => {
    const ob = outboxWith([salt()]);
    const p = port();
    const report = await deliverReadyPublishes(ob, ctx({ permissions: new Set() }), p);
    expect(report.delivered).toHaveLength(0);
    expect(report.skipped).toHaveLength(1); // approval_required — not sent
    expect(p.sent).toHaveLength(0); // never posted
    expect(ob.pending()).toHaveLength(1); // untouched
  });

  it('classifies statuses: 2xx accepted, transient retryable, and a 409/4xx a real conflict → rejected', () => {
    expect(classifyPublishResponse(201)).toBe('accepted');
    expect(classifyPublishResponse(409)).toBe('rejected'); // sku_already_in_use / barcode_already_assigned
    expect(classifyPublishResponse(0)).toBe('retryable'); // network/timeout
    expect(classifyPublishResponse(429)).toBe('retryable');
    expect(classifyPublishResponse(503)).toBe('retryable');
    expect(classifyPublishResponse(400)).toBe('rejected');
    expect(classifyPublishResponse(403)).toBe('rejected');
  });
});

// ADR-0013 slice 6: the barcode-assignment leg — delivering ONE command fully means publishing the product
// master AND assigning each of its barcodes, as the operator, collapsed into one status the outbox transitions.

const BC = (code: string, kind: BarcodeKind = 'ean'): ProductPublishBarcode => ({ code, kind });
const payloadWith = (barcodes: ProductPublishBarcode[]): ProductPublishPayload =>
  buildProductPublishCommand({ record: salt(), categories: [GROCERY], barcodes, requestedBy: 'u-owner', at: '2026-08-18T06:00:00.000Z' }).payload;

/** A fake operator-session HTTP that records both legs and returns configured statuses. */
const httpFake = (opts: { product?: number; barcodes?: Record<string, number>; barcodeDflt?: number } = {}) => {
  const published: string[] = [];
  const assigned: { productId: string; code: string; key: string }[] = [];
  const http: PublishHttp = {
    publishProduct: async (_payload, key) => { published.push(key); return opts.product ?? 201; },
    assignBarcode: async (productId, bc, key) => { assigned.push({ productId, code: bc.code, key }); return opts.barcodes?.[bc.code] ?? opts.barcodeDflt ?? 201; },
  };
  return { http, published, assigned };
};

describe('deliverOnePublish — product then barcodes, collapsed to one status', () => {
  it('a product with no barcodes: publishes it, assigns nothing, returns the product status', async () => {
    const f = httpFake();
    expect(await deliverOnePublish(payloadWith([]), 'k', f.http)).toBe(201);
    expect(f.published).toEqual(['k']);
    expect(f.assigned).toHaveLength(0);
  });

  it('a product WITH barcodes: publishes, then assigns each with a key derived from the command key', async () => {
    const f = httpFake();
    const status = await deliverOnePublish(payloadWith([BC('111'), BC('222')]), 'k', f.http);
    expect(status).toBe(201);
    expect(f.assigned.map((a) => a.code)).toEqual(['111', '222']);
    expect(f.assigned.map((a) => a.key)).toEqual(['k|bc|111', 'k|bc|222']); // no retry can double-assign
    expect(f.assigned.every((a) => a.productId === 'p-salt')).toBe(true);
  });

  it('the product must go in first: a retryable product failure holds, and NO barcode is touched', async () => {
    const f = httpFake({ product: 503 });
    expect(await deliverOnePublish(payloadWith([BC('111')]), 'k', f.http)).toBe(503);
    expect(f.assigned).toHaveLength(0); // a barcode names a product that may not exist yet
  });

  it('a real barcode conflict (409) collapses to rejected — the whole command will dead-letter', async () => {
    const f = httpFake({ barcodes: { '222': 409 } });
    const status = await deliverOnePublish(payloadWith([BC('111'), BC('222')]), 'k', f.http);
    expect(classifyPublishResponse(status)).toBe('rejected');
    expect(status).toBe(409);
  });

  it('a transient barcode failure collapses to retryable — the whole command holds and retries', async () => {
    const f = httpFake({ barcodes: { '111': 0 } }); // a lost link on the barcode POST
    const status = await deliverOnePublish(payloadWith([BC('111')]), 'k', f.http);
    expect(classifyPublishResponse(status)).toBe('retryable');
  });
});

describe('deliverReadyPublishes drives the whole leg (product + barcodes) through the outbox', () => {
  const ctxFull = (): PublishReviewContext => ({ userId: 'u-owner', tenantId: 't1', permissions: new Set([PUBLISH_PERMISSION]), sessionActive: true, tenantMember: true });
  const outboxOneWithBarcodes = (barcodes: ProductPublishBarcode[]) => {
    const ob = new SyncOutbox<string, ProductPublishPayload>();
    ob.enqueue(buildProductPublishCommand({ record: salt(), categories: [GROCERY], barcodes, requestedBy: 'u-owner', at: '2026-08-18T06:00:00.000Z' }));
    return ob;
  };

  it('acknowledges a command once its product AND all its barcodes are delivered', async () => {
    const ob = outboxOneWithBarcodes([BC('111'), BC('222')]);
    const f = httpFake();
    const port: PublishDeliveryPort = { post: (payload, key) => deliverOnePublish(payload, key, f.http) };
    const report = await deliverReadyPublishes(ob, ctxFull(), port);
    expect(report.delivered).toHaveLength(1);
    expect(ob.pending()).toHaveLength(0);
    expect(f.assigned.map((a) => a.code)).toEqual(['111', '222']);
  });

  it('dead-letters a command whose barcode conflicts — visible for a person, never dropped', async () => {
    const ob = outboxOneWithBarcodes([BC('111')]);
    const key = ob.pending()[0]!.key;
    const f = httpFake({ barcodes: { '111': 409 } });
    const port: PublishDeliveryPort = { post: (payload, k) => deliverOnePublish(payload, k, f.http) };
    const report = await deliverReadyPublishes(ob, ctxFull(), port);
    expect(report.refused).toEqual([key]);
    expect(ob.find(key)?.state).toBe('dead_letter');
    expect(ob.deadLetters()).toHaveLength(1);
  });
});
