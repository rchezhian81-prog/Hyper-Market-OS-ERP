import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PRODUCT_PUBLISH_REVIEW_COPY, COPY_KEYS, createProductPublishReviewSession,
  type ProductPublishReviewPorts,
} from '../../apps/web-erp/src/product-publish-review-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { buildProductPublishCommand, type ProductPublishPayload } from '../../apps/web-erp/src/catalogue-publish-command';
import { PUBLISH_PERMISSION, type PublishReviewContext } from '../../apps/web-erp/src/product-publish-queue';
import type { PublishDeliveryPort } from '../../apps/web-erp/src/product-publish-delivery';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { ProductRecord, Category } from '../../packages/product/src/index';

/**
 * **The products-to-publish review screen is usable, bilingual, and never publishes on its own (ADR-0013).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session — and pins the two things THIS screen
 * exists to guarantee: an item the operator cannot currently publish reads as ATTENTION (routed), and the
 * Publish action runs ONLY from an explicit click, never on load (ADR-0013 controls 6, 8 — no auto-publish).
 */

const GROCERY: Category = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const rec = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  productId: 'p-salt', tenantId: 't1', sku: 'SKU-SALT', name: 'Tata Salt 1kg',
  baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'new', ...over,
});
const queueOne = (): SyncOutbox<string, ProductPublishPayload> => {
  const ob = new SyncOutbox<string, ProductPublishPayload>();
  ob.enqueue(buildProductPublishCommand({ record: rec(), categories: [GROCERY], barcodes: ['bc-0'], requestedBy: 'u-owner', at: '2026-08-18T06:00:00.000Z' }));
  return ob;
};
const ctx = (over: Partial<PublishReviewContext> = {}): PublishReviewContext => ({
  userId: 'u-owner', tenantId: 't1', permissions: new Set([PUBLISH_PERMISSION]), sessionActive: true, tenantMember: true, ...over,
});
const noopPort: PublishDeliveryPort = { post: async () => 201 };
const session = (context: PublishReviewContext, outbox = queueOne()) => {
  const ports: ProductPublishReviewPorts = { context: () => context, outbox: () => outbox, deliveryPort: () => noopPort };
  return createProductPublishReviewSession({ userId: 'u-owner' }, ports);
};

describe('the products-to-publish copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(PRODUCT_PUBLISH_REVIEW_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...PRODUCT_PUBLISH_REVIEW_COPY.en }, ta: { ...PRODUCT_PUBLISH_REVIEW_COPY.ta, stReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('stReady');
  });
});

describe('an item the operator cannot publish now reads as attention, not as ready (ADR-0013)', () => {
  it('a stale/absent grant routes it (attention); a live authorised session is ready (no attention)', () => {
    const routed = session(ctx({ permissions: new Set() })).view('en').rows[0];
    expect(routed?.state).toBe('approval_required');
    expect(routed?.needsAttention).toBe(true);
    expect(routed?.status.tone).toBe('degraded');

    const ready = session(ctx()).view('en').rows[0];
    expect(ready?.state).toBe('ready');
    expect(ready?.needsAttention).toBe(false);
  });

  it('every rendered status carries a word and an icon — never colour alone', () => {
    for (const row of session(ctx()).view('en').rows) {
      expect(row.status.label.length).toBeGreaterThan(0);
      expect(row.status.icon.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the view defers to the model, uses no browser dialogs, and never auto-publishes', () => {
  const RAW = readFileSync('apps/web-erp/web/product-publish-review.js', 'utf8');
  // Strip line comments so a comment that names an API is not counted as a call (the codebase's own idiom).
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what may publish', () => {
    expect(VIEW).toMatch(/window\.productPublishReviewSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('publishes ONLY from an explicit click — session.deliver is never called at load (no auto-publish)', () => {
    // There is exactly ONE call to deliver(), and it sits AFTER the click-handler registration — so it runs
    // only when a person presses Publish, never during the top-level boot (which calls paint() before this).
    const deliverCalls = (VIEW.match(/session\.deliver\s*\(/g) ?? []).length;
    expect(deliverCalls, 'deliver() is called more than once — one of them may auto-publish').toBe(1);
    const clickIdx = VIEW.indexOf("el('deliver').addEventListener('click'");
    const deliverIdx = VIEW.indexOf('session.deliver(');
    expect(clickIdx, 'no click handler registered for the deliver button').toBeGreaterThan(-1);
    expect(deliverIdx, 'deliver() is called before/outside the click handler (would auto-publish)').toBeGreaterThan(clickIdx);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/product-publish-review.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
