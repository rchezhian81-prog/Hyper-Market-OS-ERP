import { describe, it, expect } from 'vitest';
import {
  createCatalogueSession, mrpReplacementBody, mrpReplacementDetails, presentAskOutcome, presentUseOutcome, MRP_REPLACEMENT_KIND,
  type CatalogueConfig, type CataloguePorts, type MrpReplacePort,
} from '../../apps/web-erp/src/catalogue-session';
import type { ApprovalAsk, ApprovalRequestView } from '../../apps/web-erp/src/approvals-session';
import { actionDetails, fingerprintOf, APPROVAL_KINDS } from '../../services/identity/src/approval-requests';
import { releaseFromQualityHold, type QualityHold } from '../../packages/quality/src/index';
import { sampleRuleFor } from '../../services/inventory/src/quality-hold';
import { createQualityReleaseQueue } from '../../apps/web-erp/src/quality-release-queue';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import type { ProductRecord } from '../../packages/product/src/index';
import { money } from '../../packages/contracts/src/money';

/**
 * **OB-512 · OB-513 (owner, 28 Oct 2026) — the screen sessions and the release rule.**
 *   OB-512  the Products & prices screen offers to replace only an MRP NOT YET IN FORCE: it asks a second person for
 *           EXACTLY the publish it will send (the engine's own fingerprint), and replaces only on the maker's own APPROVED
 *           request; an MRP in force, an unchanged one or no reason are refused before anything is sent;
 *   OB-513  a held FOOD batch with no recorded sample is not released (the engine and the facilities screen); a non-food
 *           hold may be; the screen says why in English and Tamil.
 */

const TODAY = '2026-10-28';
const DET: ProductRecord = {
  productId: 'p-det', tenantId: 't1', sku: 'SKU-DET', name: 'Synthetic detergent', primaryCategoryId: 'packed', baseUom: 'each', taxClass: '34022010', lifecycle: 'active',
  mrpHistory: [{ value: money(120_00, 'INR'), effectiveFrom: '2026-01-01' }, { value: money(150_00, 'INR'), effectiveFrom: '2026-11-15' }],
};
const CONFIG: CatalogueConfig = { tenantId: 't1', storeId: 'store-1', userId: 'u-owner', currency: 'INR', today: TODAY, marginFloorBps: 2000 };
const INPUT = { productId: 'p-det', effectiveFrom: '2026-11-15', newMrpMinor: 140_00, why: 'the supplier reprinted the pack at ₹140' };

function office(status: ApprovalRequestView['status'] | null) {
  const asks: ApprovalAsk[] = [];
  const posts: { productId: string; body: Record<string, unknown> }[] = [];
  const port: MrpReplacePort = { post: async (productId, body) => { posts.push({ productId, body }); return { saved: true }; } };
  const ports: CataloguePorts = {
    categories: () => [{ categoryId: 'packed', name: 'Packed', parentId: null, regulated: ['packed'] }],
    products: () => [DET], priceEntries: () => [], costOf: () => ({ known: false, why: 'x' }), barcodesInUse: () => [], promotions: () => [], shelfMap: () => null,
    replaceMrp: () => port,
    askApproval: async (ask) => { asks.push(ask); return { result: 'asked', request: { requestId: 'areq-1', kind: ask.kind, label: 'x', subjectRef: ask.subjectRef, valueMinor: ask.valueMinor, details: ask.details, summary: ask.summary, reason: ask.reason, requestedBy: 'u-owner', requestedAt: '2026-10-28T04:00:00Z', status: 'waiting' } }; },
    approvalInbox: async () => ({ result: 'read', inbox: { waitingForMe: [], asAt: null, mine: status === null ? [] : [{
      requestId: 'areq-1', kind: MRP_REPLACEMENT_KIND, label: 'x', subjectRef: 'product:p-det:mrp:2026-11-15', valueMinor: null,
      details: JSON.parse(JSON.stringify(mrpReplacementDetails(DET, INPUT))) as Record<string, unknown>, summary: 's', reason: INPUT.why,
      requestedBy: 'u-owner', requestedAt: '2026-10-28T04:00:00Z', status, ...(status === 'approved' ? { decidedBy: 'u-acct', decisionReason: 'ok' } : {}),
    }] } }),
  };
  return { s: createCatalogueSession(CONFIG, ports), asks, posts };
}

describe('OB-512 — the Products & prices screen replaces an MRP not yet in force', () => {
  it('asks for EXACTLY the publish it will send — the head office engine\'s own fingerprint of that body', async () => {
    const sent = JSON.parse(JSON.stringify(mrpReplacementBody(DET, INPUT, 'areq-1'))) as Record<string, unknown>;
    expect(fingerprintOf(actionDetails(sent, { productId: 'p-det' }))).toBe(fingerprintOf(mrpReplacementDetails(DET, INPUT)));
    expect(sent).toMatchObject({ mrpReplacement: { effectiveFrom: '2026-11-15', reason: INPUT.why }, approvalId: 'areq-1' });
    expect((sent['product'] as ProductRecord).mrpHistory).toEqual([{ value: money(120_00, 'INR'), effectiveFrom: '2026-01-01' }, { value: money(140_00, 'INR'), effectiveFrom: '2026-11-15' }]);
    expect(APPROVAL_KINDS[MRP_REPLACEMENT_KIND]).toMatchObject({ makerPermission: 'catalogue.pack.publish', checkerPermission: 'catalogue.tax.approve' });
  });

  it('offers only the MRPs not yet in force; refuses one in force, an unchanged one, no reason — nothing asked', async () => {
    const { s, asks } = office(null);
    expect(s.mrpsNotYetInForce('p-det')).toEqual([{ effectiveFrom: '2026-11-15', mrpMinor: 150_00 }]);
    expect(await s.askMrpReplacement('en', { ...INPUT, effectiveFrom: '2026-01-01' })).toMatchObject({ kind: 'refused', code: 'mrp_already_in_force' });
    expect(await s.askMrpReplacement('en', { ...INPUT, newMrpMinor: 150_00 })).toMatchObject({ kind: 'refused', code: 'mrp_same' });
    expect(await s.askMrpReplacement('en', { ...INPUT, effectiveFrom: '2026-12-01' })).toMatchObject({ kind: 'refused', code: 'no_mrp_to_replace' });
    expect(await s.askMrpReplacement('en', { ...INPUT, why: 'typo' })).toEqual({ kind: 'needs_why' });
    expect(asks).toEqual([]);
    const refusedWords = presentAskOutcome('ta', 'mrp', { kind: 'refused', code: 'mrp_already_in_force', whatHappened: '' }).label;
    expect(refusedWords).toContain('ஏற்கனவே நடைமுறையில் உள்ளது');
  });

  it('asks; while waiting nothing is sent; once APPROVED it replaces naming the approval — in English and Tamil', async () => {
    const asked = office(null);
    const out = await asked.s.askMrpReplacement('en', INPUT);
    expect(out.kind).toBe('asked');
    expect(asked.asks[0]).toMatchObject({ kind: 'mrp_replacement', subjectRef: 'product:p-det:mrp:2026-11-15', valueMinor: null, reason: INPUT.why });
    expect(asked.asks[0]!.summary).toContain('₹150.00 → ₹140.00');
    expect(presentAskOutcome('en', 'mrp', out).label).toContain('the accountant or the owner');

    const waiting = office('waiting');
    const w = await waiting.s.replaceMrpWithApproval(INPUT);
    expect(w).toEqual({ kind: 'waiting' });
    expect(waiting.posts).toEqual([]);
    expect(presentUseOutcome('ta', 'mrp', w).label).toContain('கணக்காளர் அல்லது உரிமையாளர்');

    const approved = office('approved');
    const done = await approved.s.replaceMrpWithApproval(INPUT);
    expect(done).toMatchObject({ kind: 'done', approvedBy: 'u-acct' });
    expect(approved.posts).toEqual([{ productId: 'p-det', body: mrpReplacementBody(DET, INPUT, 'areq-1') }]);
    expect(presentUseOutcome('en', 'mrp', done, '₹140.00').label).toContain('MRP replaced: ₹140.00');
    // A different figure than the one approved is "changed", and nothing is sent.
    const changed = office('approved');
    expect((await changed.s.replaceMrpWithApproval({ ...INPUT, newMrpMinor: 145_00 })).kind).toBe('changed');
    expect(changed.posts).toEqual([]);
  });
});

describe('OB-513 — a held food batch needs a recorded sample before release', () => {
  const hold: QualityHold = { batchId: 'B-1', productId: 'p-curd', status: 'held', reason: 'warm chiller', heldAt: '2026-10-28T01:00:00Z', heldBy: 'u-owner' };
  const sample = { sampleId: 's1', batchId: 'B-1', takenBy: 'u-qc', takenAt: '2026-10-28T02:00:00Z', test: 'smell', result: 'pass' as const };

  it('the engine: required and none recorded → sample_required; with a passed sample → released; not required → released without', () => {
    expect(releaseFromQualityHold({ hold, samples: [], releasedBy: 'u-qc', at: '2026-10-28T03:00:00Z', sampleRequired: 'food: a sample first' })).toMatchObject({ released: false, outcome: 'sample_required', detail: 'food: a sample first' });
    expect(releaseFromQualityHold({ hold, samples: [sample], releasedBy: 'u-qc', at: '2026-10-28T03:00:00Z', sampleRequired: 'x' }).released).toBe(true);
    expect(releaseFromQualityHold({ hold, samples: [], releasedBy: 'u-qc', at: '2026-10-28T03:00:00Z' }).released).toBe(true);
  });

  it('head office\'s rule: food → required; not food → not; cannot tell → required (said); no lookup wired → not', async () => {
    expect(await sampleRuleFor({ isFood: () => true }, 't', hold)).toMatchObject({ required: true, because: 'food' });
    expect(await sampleRuleFor({ isFood: () => false }, 't', hold)).toMatchObject({ required: false, because: 'not_food' });
    expect(await sampleRuleFor({ isFood: () => undefined }, 't', hold)).toMatchObject({ required: true, because: 'food_not_known' });
    expect(await sampleRuleFor({}, 't', hold)).toMatchObject({ required: false });
  });

  it('the facilities screen: says why, does not offer the release, and refuses it — in English and Tamil', () => {
    const held = { asAt: '2026-10-28T03:00:00Z', ageMinutes: 1, holds: [
      { batchId: 'B-1', productId: 'p-curd', reason: 'warm chiller', heldAt: hold.heldAt, samples: [], sampleRule: { required: true, because: 'food' as const } },
      { batchId: 'B-2', productId: 'p-det', reason: 'damp cartons', heldAt: hold.heldAt, samples: [], sampleRule: { required: false, because: 'not_food' as const } },
    ] };
    const q = createQualityReleaseQueue({ userId: 'u-qc', storeId: 'S1', permissions: ['quality.hold.release'], now: () => '2026-10-28T03:00:00Z' }, held, new SyncOutbox());
    const en = q.view('en').rows;
    expect(en[0]).toMatchObject({ canRelease: false, sampleRuleWords: expect.stringContaining('Food item'), blockedWords: expect.stringContaining('No sample is recorded yet') });
    expect(en[1]).toMatchObject({ canRelease: true, sampleRuleWords: expect.stringContaining('Not a food item') });
    expect(q.view('ta').rows[0]!.sampleRuleWords).toContain('உணவுப் பொருள்');
    expect(q.release('en', { batchId: 'B-1', notes: 'looked fine' })).toMatchObject({ ok: false, code: 'sample_required' });
    expect(q.release('en', { batchId: 'B-2', notes: 'cartons dried, contents fine' })).toEqual({ ok: true });
  });
});
