import { describe, it, expect } from 'vitest';
import {
  createProductPublishReviewSession, PRODUCT_PUBLISH_REVIEW_COPY, COPY_KEYS,
  type ProductPublishReviewPorts,
} from '../../apps/web-erp/src/product-publish-review-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { buildProductPublishCommand, type ProductPublishPayload } from '../../apps/web-erp/src/catalogue-publish-command';
import { PUBLISH_PERMISSION, type PublishReviewContext } from '../../apps/web-erp/src/product-publish-queue';
import type { PublishDeliveryPort } from '../../apps/web-erp/src/product-publish-delivery';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { ProductRecord, Category } from '../../packages/product/src/index';

/**
 * **Products waiting to publish — the operator screen (ADR-0013 slice 3, M03-FR-01/03).**
 *
 * The screen turns the offline publish outbox into a REVIEWED, RE-VALIDATED delivery step: every queued
 * `ProductPublishRequested` command is classified from the operator's CURRENT context (never the queued
 * snapshot), the ones needing a person are first, and publishing is a SEPARATE explicit action that sends
 * only the ready ones, as the signed-in operator. These tests pin the triage and that nothing auto-publishes.
 */

const GROCERY: Category = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const rec = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  productId: 'p-salt', tenantId: 't1', sku: 'SKU-SALT', name: 'Tata Salt 1kg',
  baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'new', ...over,
});

const queueOf = (records: ProductRecord[]): SyncOutbox<string, ProductPublishPayload> => {
  const ob = new SyncOutbox<string, ProductPublishPayload>();
  records.forEach((r, i) =>
    ob.enqueue(buildProductPublishCommand({
      record: r, categories: [GROCERY], barcodes: [{ code: `bc-${i}`, kind: 'ean' }],
      requestedBy: 'u-owner', at: `2026-08-18T0${i}:00:00.000Z`,
    })));
  return ob;
};

const ctx = (over: Partial<PublishReviewContext> = {}): PublishReviewContext => ({
  userId: 'u-owner', tenantId: 't1', permissions: new Set([PUBLISH_PERMISSION]),
  sessionActive: true, tenantMember: true, ...over,
});

/** A fake operator-session port returning a fixed status per idempotency key (default 201). */
const deliveryPort = (statuses: Record<string, number> = {}, dflt = 201): PublishDeliveryPort & { readonly sent: string[] } => {
  const sent: string[] = [];
  return { sent, post: async (_p: ProductPublishPayload, key: string) => { sent.push(key); return statuses[key] ?? dflt; } };
};

const ports = (over: Partial<ProductPublishReviewPorts> = {}, contextOver: Partial<PublishReviewContext> = {}): ProductPublishReviewPorts => {
  const ob = over.outbox ? over.outbox() : queueOf([rec()]);
  const port = deliveryPort();
  return {
    context: () => ctx(contextOver),
    outbox: () => ob,
    deliveryPort: () => port,
    ...over,
  };
};

const session = (over: Partial<ProductPublishReviewPorts> = {}, userId: string | null = 'u-owner', contextOver: Partial<PublishReviewContext> = {}) =>
  createProductPublishReviewSession({ userId }, ports(over, contextOver));

describe('view — classification and triage', () => {
  it('shows a compliant item in an authorised current session as ready, with a word + icon status', () => {
    const v = session().view('en');
    expect(v.total).toBe(1);
    expect(v.rows[0]!.state).toBe('ready');
    expect(v.rows[0]!.deliverable).toBe(true);
    expect(v.readyCount).toBe(1);
    expect(v.rows[0]!.status.label.length).toBeGreaterThan(0);
    expect(v.rows[0]!.status.icon.trim().length).toBeGreaterThan(0);
  });

  it('never trusts a stale grant — an operator without the publish permission sees it routed, not ready', () => {
    const v = session({}, 'u-owner', { permissions: new Set() }).view('en');
    expect(v.rows[0]!.state).toBe('approval_required');
    expect(v.rows[0]!.deliverable).toBe(false);
    expect(v.readyCount).toBe(0);
    expect(v.attentionCount).toBe(1);
    expect(v.rows[0]!.detail.length).toBeGreaterThan(0); // tells the operator what to do
  });

  it('puts the ones needing a person first, then oldest-queued first', () => {
    const ob = queueOf([rec({ productId: 'p-a' }), rec({ productId: 'p-b' }), rec({ productId: 'p-c' })]);
    // Dead-letter the middle one so it is a permanently_refused (attention) item.
    const midKey = ob.pending()[1]!.key;
    ob.deadLetter(midKey, 'refused for the test');
    const v = session({ outbox: () => ob }).view('en');
    expect(v.total).toBe(3);
    // the refused one needs attention → first; the two ready ones follow in queue order
    expect(v.rows[0]!.state).toBe('permanently_refused');
    expect(v.rows[0]!.needsAttention).toBe(true);
    expect(v.rows.slice(1).every((r) => r.state === 'ready')).toBe(true);
  });

  it('refuses to review a queue for a screen that was not told who is using it (no shared logins)', () => {
    const v = session({}, null).view('en');
    expect(v.rows).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.nobodyNamed).toBe(true);
    expect(v.screenState.tone).toBe('idle'); // locked, not an error — sign in and it works
  });

  it('shows an empty state when nothing is waiting', () => {
    const v = session({ outbox: () => new SyncOutbox<string, ProductPublishPayload>() }).view('en');
    expect(v.total).toBe(0);
    expect(v.screenState.tone).toBe('idle');
  });

  it('renders in Tamil too — the status label changes with the language', () => {
    const s = session();
    expect(s.view('ta').rows[0]!.status.label).not.toBe(s.view('en').rows[0]!.status.label);
  });
});

describe('deliver — the explicit publish action', () => {
  it('sends only the ready items, as the operator, and acknowledges them (no auto-publish before the call)', async () => {
    const ob = queueOf([rec()]);
    const port = deliveryPort();
    const s = createProductPublishReviewSession({ userId: 'u-owner' }, {
      context: () => ctx(), outbox: () => ob, deliveryPort: () => port,
    });
    // Nothing is sent merely by viewing.
    s.view('en');
    expect(port.sent).toHaveLength(0);
    // Only on the explicit action.
    const report = await s.deliver();
    expect(report.delivered).toHaveLength(1);
    expect(port.sent).toHaveLength(1);
    expect(ob.pending()).toHaveLength(0); // acknowledged
  });

  it('delivers nothing an operator is not cleared for — a no-permission session sends zero', async () => {
    const ob = queueOf([rec()]);
    const port = deliveryPort();
    const s = createProductPublishReviewSession({ userId: 'u-owner' }, {
      context: () => ctx({ permissions: new Set() }), outbox: () => ob, deliveryPort: () => port,
    });
    const report = await s.deliver();
    expect(report.delivered).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(port.sent).toHaveLength(0);
    expect(ob.pending()).toHaveLength(1); // untouched
  });

  it('presents a delivery result as one glanceable status — ok all-sent, error on a refusal', () => {
    const s = session();
    const ok = s.presentDeliveryReport('en', { delivered: ['a', 'b'], held: [], refused: [], skipped: [] });
    expect(ok.tone).toBe('ok');
    const bad = s.presentDeliveryReport('en', { delivered: [], held: [], refused: ['a'], skipped: [] });
    expect(bad.tone).toBe('error');
    const slow = s.presentDeliveryReport('en', { delivered: [], held: ['a'], refused: [], skipped: [] });
    expect(slow.tone).toBe('degraded');
  });
});

describe('the copy is complete in both languages', () => {
  it('has an English AND a Tamil word for every key (bilingualGaps)', () => {
    const gaps = bilingualGaps(PRODUCT_PUBLISH_REVIEW_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
