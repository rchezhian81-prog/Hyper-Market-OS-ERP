import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createApprovalsSession, presentRequestStatus,
  type ApprovalsPorts, type ApprovalInboxView, type ApprovalRequestView, type ApprovalNames,
} from '../../apps/web-erp/src/approvals-session';
import { actionOf } from '../../services/api/src/approved-stock-change-applies';
import type { ApprovalState } from '../../services/identity/src/approval-requests';

// OB-808 A (owner, 16 Nov 2026) · D-013: approving a write-off writes it off at once, in the asker's name. The Approvals
// page says what was written off — the item and place by name — instead of "the person who asked can now go ahead", and
// says plainly when head office could not make it (P-08). Only requests asked through the governed routes are applied.

const NAMES: ApprovalNames = {
  product: (id) => (id === 'OIL' ? 'Sunflower Oil 1 L' : undefined),
  place: (id) => (id === 'wh-1' ? 'The back store' : undefined),
};
const waiting: ApprovalRequestView = {
  requestId: 'areq-oil', kind: 'stock_write_off', label: 'Write off stock (a material loss)', subjectRef: 'wo-oil', valueMinor: 90_000,
  details: { productId: 'OIL', locationId: 'wh-1', qty: 6, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 90_000, evidenceRef: 'photo-1', writeOffId: 'wo-oil' },
  summary: 'Write off 6 pouches of Sunflower Oil', reason: 'torn', requestedBy: 'u-back', requestedAt: '2026-11-16T04:00:00.000Z', status: 'waiting',
};
const inbox: ApprovalInboxView = { waitingForMe: [waiting], mine: [], asAt: '2026-11-16T04:05:00.000Z' };
const ports = (over: Partial<ApprovalsPorts> = {}): ApprovalsPorts => ({
  inbox: () => inbox, mayUse: () => true, names: () => NAMES,
  decide: async (i) => ({ result: 'decided', decision: i.decision, decidedBy: 'u-mgr', stockChange: { applied: true, kind: 'stock_write_off', productId: 'OIL', locationId: 'wh-1', qty: 6, uom: 'ea' } }),
  ...over,
});

describe('OB-808 A — the approver is told the loss was written off, by name', () => {
  it('says "Written off: 6 of Sunflower Oil 1 L from The back store" — never "the person who asked can now go ahead"', async () => {
    const s = createApprovalsSession({ userId: 'u-mgr' }, ports());
    const o = await s.decide('areq-oil', 'approved', 'the pouches are torn');
    const said = s.presentDecideOutcome('en', o);
    expect(said.label).toBe('Written off: 6 of Sunflower Oil 1 L from The back store.');
    expect(said.label).not.toMatch(/go ahead/);
    expect(s.presentDecideOutcome('ta', o).label).toMatch(/[஀-௿]/);
  });

  it('a loss head office could not make is said, as an error, with head office\'s words (P-08)', async () => {
    const s = createApprovalsSession({ userId: 'u-mgr' }, ports({
      decide: async (i) => ({ result: 'decided', decision: i.decision, decidedBy: 'u-mgr', stockChange: { applied: false, kind: 'stock_write_off', productId: 'OIL', locationId: 'wh-1', qty: 6, uom: 'ea', reason: 'Oil is being counted at the back store.' } }),
    }));
    const said = s.presentDecideOutcome('en', await s.decide('areq-oil', 'approved', 'torn pouches'));
    expect(said.label).toBe('Approved, but head office could NOT make it — nothing was written off: Oil is being counted at the back store.');
    expect(said.needsAttention).toBe(true);
  });

  it('a rejection is still just "rejected"', async () => {
    const s = createApprovalsSession({ userId: 'u-mgr' }, ports({ decide: async (i) => ({ result: 'decided', decision: i.decision, decidedBy: 'u-mgr' }) }));
    expect(s.presentDecideOutcome('en', await s.decide('areq-oil', 'rejected', 'they are fine')).label).not.toMatch(/Written off/);
  });

  it('the asker\'s own list says it was written off — or why not', () => {
    const done = presentRequestStatus('en', { ...waiting, status: 'used', decidedBy: 'u-mgr', stockChange: { applied: true, kind: 'stock_write_off', productId: 'OIL', locationId: 'wh-1', qty: 6, uom: 'ea' } }, false, NAMES);
    expect(done.label).toBe('Approved by u-mgr and written off: 6 of Sunflower Oil 1 L from The back store.');
    const notDone = presentRequestStatus('en', { ...waiting, status: 'approved', decidedBy: 'u-mgr', stockChange: { applied: false, kind: 'stock_write_off', productId: 'OIL', locationId: 'wh-1', qty: 6, uom: 'ea', reason: 'not your store' } }, false, NAMES);
    expect(notDone.label).toBe('Approved by u-mgr, but head office could NOT make it — nothing changed: not your store');
    expect(notDone.tone).toBe('error');
  });
});

describe('OB-808 A — which approved requests head office applies itself', () => {
  const state = (over: Partial<ApprovalState['request']>): ApprovalState => ({
    request: {
      requestId: 'areq-1', kind: 'stock_write_off', subjectRef: 'wo-1', valueMinor: 90_000, fingerprint: 'x', summary: 's', reason: 'r',
      requestedBy: 'u-back', requestedAt: '2026-11-16T04:00:00.000Z',
      details: { productId: 'OIL', locationId: 'wh-1', qty: 6, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 90_000, writeOffId: 'wo-1' },
      ...over,
    },
    decision: { requestId: 'areq-1', decision: 'approved', decidedBy: 'u-mgr', reason: 'ok', decidedAt: '2026-11-16T04:05:00.000Z', expiresAt: null },
  } as ApprovalState);

  it('a write-off asked through the write-off route: exactly its own details, naming the approval, under its own id', () => {
    const a = actionOf(state({}))!;
    expect(a.path).toBe('/v1/inventory/write-off/:writeOffId');
    expect(a.params).toEqual({ writeOffId: 'wo-1' });
    expect(a.body).toEqual({ productId: 'OIL', locationId: 'wh-1', qty: 6, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 90_000, approvalId: 'areq-1' });
  });
  it('an upward correction asked through the movements route', () => {
    const a = actionOf(state({ kind: 'stock_adjustment_up', subjectRef: 'mv-1', details: { movementId: 'mv-1', kind: 'adjusted', productId: 'OIL', locationId: 'wh-1', qty: 2, uom: 'ea', quantityMinor: 2, enteredBy: 'u-back' } }))!;
    expect(a.path).toBe('/v1/inventory/movements');
    expect(a.body['approvalId']).toBe('areq-1');
  });
  it('a held returned unit\'s write-off (applied by its own decision) and a request whose id does not match are left alone', () => {
    expect(actionOf(state({ subjectRef: 'held-1', details: { heldId: 'h-1', decisionId: 'd-1' } }))).toBeUndefined();
    expect(actionOf(state({ subjectRef: 'wo-OTHER' }))).toBeUndefined();
  });
});

describe('OB-808 A — the wiring', () => {
  it('main.ts composes it after the catalogue-change wrap, so it wraps the finished decide route', () => {
    const main = readFileSync('services/api/src/main.ts', 'utf8');
    const cat = main.indexOf('catalogueChangeSurface(surface');
    const ob808 = main.indexOf('approvedStockChangeSurface(surface');
    expect(cat).toBeGreaterThan(0);
    expect(ob808).toBeGreaterThan(cat);
  });
  it('the old "go ahead — once" is no longer what an approved write-off says', () => {
    const src = readFileSync('apps/web-erp/src/approvals-session.ts', 'utf8');
    expect(src).toMatch(/decidedWrittenOff: 'Written off: \{what\}\.'/);
  });
});
