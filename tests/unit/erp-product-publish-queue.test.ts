import { describe, it, expect } from 'vitest';
import {
  classifyPublishItem, summarizePublishQueue,
  PUBLISH_PERMISSION,
  type QueuedPublishItem, type PublishReviewContext,
} from '../../apps/web-erp/src/product-publish-queue';

// ADR-0013: the signed-in operator delivers a queued product publish, as themselves. The review queue is
// re-evaluated from the operator's CURRENT context every time — never the permissions captured when the item
// was queued. These tests pin the refusals that make that safe.

const item = (over: Partial<QueuedPublishItem> = {}): QueuedPublishItem => ({
  key: 'k1', tenantId: 't1', createdBy: 'u-owner', createdAt: '2026-08-18T06:00:00.000Z',
  outboxState: 'pending', clientValid: true, ...over,
});

const ctx = (over: Partial<PublishReviewContext> = {}): PublishReviewContext => ({
  userId: 'u-owner', tenantId: 't1', permissions: new Set([PUBLISH_PERMISSION]),
  sessionActive: true, tenantMember: true, ...over,
});

describe('product-publish review queue (ADR-0013)', () => {
  it('a compliant item, an authorised current session, is ready to publish', () => {
    expect(classifyPublishItem(item(), ctx())).toBe('ready');
  });

  it('terminal outbox states win: acknowledged → published, dead-letter → permanently_refused', () => {
    expect(classifyPublishItem(item({ outboxState: 'acknowledged' }), ctx())).toBe('published');
    expect(classifyPublishItem(item({ outboxState: 'dead_letter' }), ctx())).toBe('permanently_refused');
  });

  it('never trusts a stale grant: no current publish permission → routed, not published', () => {
    expect(classifyPublishItem(item(), ctx({ permissions: new Set() }))).toBe('approval_required');
    expect(classifyPublishItem(item(), ctx({ sessionActive: false }))).toBe('approval_required');
  });

  it('refuses a cross-tenant item outright — never delivered under the wrong tenant', () => {
    expect(classifyPublishItem(item({ tenantId: 't2' }), ctx())).toBe('permanently_refused');
    expect(classifyPublishItem(item(), ctx({ tenantMember: false }))).toBe('permanently_refused');
  });

  it('routes an item whose original creator has since lost the authority / left', () => {
    expect(classifyPublishItem(item({ createdBy: 'u-left' }), ctx({ revokedCreators: new Set(['u-left']) })))
      .toBe('approval_required');
  });

  it('surfaces a conflict rather than last-write-wins; flags a client-invalid item', () => {
    expect(classifyPublishItem(item({ conflict: true }), ctx())).toBe('conflict');
    expect(classifyPublishItem(item({ clientValid: false }), ctx())).toBe('validation_failed');
  });

  it('requires a fresh re-auth for a sensitive item or a bulk publish', () => {
    expect(classifyPublishItem(item({ sensitive: true }), ctx())).toBe('approval_required'); // no MFA age
    expect(classifyPublishItem(item({ sensitive: true }), ctx({ mfaFreshSeconds: 300 }))).toBe('approval_required'); // stale
    expect(classifyPublishItem(item({ sensitive: true }), ctx({ mfaFreshSeconds: 30 }))).toBe('ready'); // fresh
    expect(classifyPublishItem(item(), ctx({ bulk: true }))).toBe('approval_required'); // bulk needs fresh MFA
    expect(classifyPublishItem(item(), ctx({ bulk: true, mfaFreshSeconds: 30 }))).toBe('ready');
  });

  it('summarizes the queue into counts + the ready set, and nothing else is publishable', () => {
    const items = [
      item({ key: 'a' }),                                  // ready
      item({ key: 'b', tenantId: 't2' }),                  // permanently_refused (cross-tenant)
      item({ key: 'c', clientValid: false }),              // validation_failed
      item({ key: 'd', outboxState: 'acknowledged' }),     // published
      item({ key: 'e', conflict: true }),                  // conflict
    ];
    const s = summarizePublishQueue(items, ctx());
    expect(s.counts).toMatchObject({ ready: 1, permanently_refused: 1, validation_failed: 1, published: 1, conflict: 1 });
    expect(s.readyKeys).toEqual(['a']); // only the ready one may be delivered
  });
});
