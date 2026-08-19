import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { buildProductPublishCommand } from '../../apps/web-erp/src/catalogue-publish-command';
import {
  deliverReadyPublishes, classifyPublishResponse,
  type PublishDeliveryPort,
} from '../../apps/web-erp/src/product-publish-delivery';
import { PUBLISH_PERMISSION, type PublishReviewContext } from '../../apps/web-erp/src/product-publish-queue';
import type { ProductPublishPayload } from '../../apps/web-erp/src/catalogue-publish-command';
import type { ProductRecord, Category } from '../../packages/product/src/index';

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
    ob.enqueue(buildProductPublishCommand({ record: r, categories: [GROCERY], barcodes: [`bc-${i}`], requestedBy: 'u-owner', at: '2026-08-18T06:00:00.000Z' })));
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

  it('treats a 409 from the idempotent route as delivered, not a duplicate', async () => {
    const ob = outboxWith([salt()]);
    const key = ob.pending()[0]!.key;
    const report = await deliverReadyPublishes(ob, ctx(), port({ [key]: 409 }));
    expect(report.delivered).toEqual([key]);
    expect(ob.find(key)?.state).toBe('acknowledged');
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

  it('classifies statuses the same way the edge transport does', () => {
    expect(classifyPublishResponse(201)).toBe('accepted');
    expect(classifyPublishResponse(409)).toBe('accepted');
    expect(classifyPublishResponse(0)).toBe('retryable'); // network/timeout
    expect(classifyPublishResponse(429)).toBe('retryable');
    expect(classifyPublishResponse(503)).toBe('retryable');
    expect(classifyPublishResponse(400)).toBe('rejected');
    expect(classifyPublishResponse(403)).toBe('rejected');
  });
});
