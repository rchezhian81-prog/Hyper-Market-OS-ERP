import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import {
  queueProductPublish, buildProductPublishCommand, productPublishKey,
  PRODUCT_PUBLISH_EVENT, type ProductPublishPayload,
} from '../../apps/web-erp/src/catalogue-publish-command';
import type { ProductRecord, Category } from '../../packages/product/src/index';

// The catalogue screen's Save produces a durable, deduplicated command to publish a product to the cloud —
// but ONLY a product that would validate, and never a second copy of the same content.

const GROCERY: Category = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const FOOD: Category = { categoryId: 'food', name: 'Food', parentId: null, regulated: ['food'] };

const salt = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  productId: 'p-salt', tenantId: 't', sku: 'SKU-SALT', name: 'Tata Salt 1kg',
  baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft', ...over,
});

const outbox = () => new SyncOutbox();
const AT = '2026-08-18T06:00:00.000Z';

describe('catalogue screen publish → outbox command (M03-FR-01/03)', () => {
  it('queues a durable command for a compliant product, with the record promoted draft → new', () => {
    const ob = outbox();
    const res = queueProductPublish(ob, { product: salt(), categories: [GROCERY], barcodes: ['8901058000108'], requestedBy: 'u-owner', at: AT });
    expect(res.ok).toBe(true);
    expect(ob.unsentCount()).toBe(1);
    const item = ob.pending()[0]!;
    expect(item.event.type).toBe(PRODUCT_PUBLISH_EVENT);
    const payload = item.event.payload as ProductPublishPayload;
    expect(payload.product.lifecycle).toBe('new'); // promoted on publish, as the cloud will store it
    expect(payload.barcodes).toEqual(['8901058000108']);
    expect(payload.requestedBy).toBe('u-owner');
  });

  it('refuses to queue a product that would not validate — nothing is queued, every reason named', () => {
    const ob = outbox();
    // No HSN/tax class.
    const noHsn = queueProductPublish(ob, { product: salt({ taxClass: null }), categories: [GROCERY], requestedBy: 'u-owner', at: AT });
    expect(noHsn.ok).toBe(false);
    if (!noHsn.ok) { expect(noHsn.refusal).toBe('not_finished'); expect(noHsn.missing.length).toBeGreaterThan(0); }
    // A food item with no allergen declaration.
    const food = queueProductPublish(ob, { product: salt({ productId: 'p-bread', primaryCategoryId: 'food', taxClass: '1905', name: 'Bread' }), categories: [FOOD], requestedBy: 'u-owner', at: AT });
    expect(food.ok).toBe(false);
    // An orphan category.
    const orphan = queueProductPublish(ob, { product: salt({ primaryCategoryId: 'nope' }), categories: [GROCERY], requestedBy: 'u-owner', at: AT });
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.refusal).toBe('unknown_category');
    expect(ob.unsentCount()).toBe(0); // nothing invalid ever sits in the outbox
  });

  it('collapses a double-click to one command, but an edit is a distinct command', () => {
    const ob = outbox();
    queueProductPublish(ob, { product: salt(), categories: [GROCERY], barcodes: ['111'], requestedBy: 'u-owner', at: AT });
    const again = queueProductPublish(ob, { product: salt(), categories: [GROCERY], barcodes: ['111'], requestedBy: 'u-owner', at: AT });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.refusal).toBe('already_queued');
    expect(ob.unsentCount()).toBe(1); // still one

    // A genuine edit (a new name) is different content → a distinct, legitimate command.
    queueProductPublish(ob, { product: salt({ name: 'Tata Salt 1kg (new pack)' }), categories: [GROCERY], barcodes: ['111'], requestedBy: 'u-owner', at: AT });
    expect(ob.unsentCount()).toBe(2);
  });

  it('the dedupe key is content-stable regardless of field order, and barcode order does not matter', () => {
    const a = productPublishKey(salt({ lifecycle: 'new' }), ['a', 'b']);
    const b = productPublishKey({ ...salt({ lifecycle: 'new' }) }, ['b', 'a']); // reordered barcodes
    expect(a).toBe(b);
    const c = buildProductPublishCommand({ record: salt({ lifecycle: 'new' }), categories: [GROCERY], barcodes: ['a', 'b'], requestedBy: 'u', at: AT });
    expect(c.idempotencyKey).toBe(a);
  });
});
