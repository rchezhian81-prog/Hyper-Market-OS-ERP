import { describe, it, expect } from 'vitest';
import { todayFigures, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { emptyPack, known, readPack, type StorePack } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/index';
import { claimDisputeAlertPlan, claimDisputeCounts, claimDisputes, claimDisputeAlertIdOf, type ClaimDisputeResolution, type SupplierRaisedClaim } from '../../services/purchase/src/supplier-claims';

/**
 * **U7 · OB-727 (owner, in writing: B) — a disputed (rejected) supplier claim is counted on the Today page, and its alert
 * is planned once per open exception and cleared when it is settled (M24-FR-02 alt · P-03 · P-08).**
 *
 *   • the store computer's Today figure "Disputed supplier claims open" is the pack's count, with how many are overdue in
 *     its note — in English and in Tamil (U3 · OB-699);
 *   • a box head office has not told says "not known" WITH the reason, in both languages — never a zero;
 *   • the counts are the register's own fold (open, and of those overdue after the shop day they were raised on);
 *   • the alert plan raises one per open dispute that has no open alert, never a second; a settled one is cleared.
 */

const DAY = '2026-11-13';
const input = (pack: StorePack): ScreenInput =>
  ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: `${DAY}T09:00:00.000Z`, tradingDay: DAY }) as unknown as ScreenInput;
const bare = (): StorePack => emptyPack('this test pulled nothing');

describe('the Today figure', () => {
  it('reads the pack\'s count, with the overdue ones in its note, in English and Tamil', () => {
    const pack = { ...bare(), supplierClaimDisputes: known({ open: 3, overdue: 1 }) } as StorePack;
    expect(todayFigures(input(pack))['supplierClaimDisputes']).toEqual({
      known: true, value: 3,
      note: '1 overdue — settle them on Supplier claims',
      noteTa: '1 தாமதமானவை — விநியோகஸ்தர் உரிமைக்கோரல்கள் பக்கத்தில் தீர்க்கவும்',
    });
    expect(todayFigures(input({ ...bare(), supplierClaimDisputes: known({ open: 0, overdue: 0 }) } as StorePack))['supplierClaimDisputes']).toMatchObject({ known: true, value: 0, note: 'none overdue' });
  });

  it('a box head office has not told says so, with the reason — never a zero', () => {
    expect(todayFigures(input(bare()))['supplierClaimDisputes']).toEqual({
      known: false, why: 'the store computer has not been given the disputed supplier claims',
      whyTa: 'கடைக் கணினிக்கு சர்ச்சைக்குரிய விநியோகஸ்தர் உரிமைக்கோரல்கள் வழங்கப்படவில்லை',
    });
  });

  it('the pack section is read from what head office signed', () => {
    const pack = readPack({ version: 1, supplierClaimDisputes: { open: 2, overdue: 0 } }, `${DAY}T09:00:00Z`);
    expect(pack.supplierClaimDisputes).toEqual({ known: true, value: { open: 2, overdue: 0 } });
  });
});

const claim = (id: string, state: SupplierRaisedClaim['state'], decidedAt: string): SupplierRaisedClaim =>
  ({ supplierId: 's-1', submissionId: id, claimMinor: 2_000, why: 'bill short-paid', state, decidedBy: 'u-buyer', decidedAt, receivedAt: decidedAt, reason: 'paid in full', submittedBy: 'u-sup' }) as unknown as SupplierRaisedClaim;
const settled = (id: string): ClaimDisputeResolution =>
  ({ exceptionId: `DSP-${id}`, supplierId: 's-1', submissionId: id, outcome: 'supplier_withdrew', reason: 'saw the payment', by: 'u-buyer', at: `${DAY}T10:00:00Z` });
const dayOf = (iso: string): string => iso.slice(0, 10); // the test's own calendar: the moments below are shop dates already

describe('the counts and the alert plan', () => {
  const claims = [claim('c-old', 'rejected', '2026-11-10T05:00:00Z'), claim('c-new', 'rejected', `${DAY}T05:00:00Z`), claim('c-done', 'rejected', '2026-11-01T05:00:00Z'), claim('c-ok', 'accepted', '2026-11-01T05:00:00Z')];
  const disputes = claimDisputes(claims, [settled('c-done')], dayOf, DAY);

  it('open counts the unsettled rejected claims; overdue those past the shop day they were raised on', () => {
    expect(claimDisputeCounts(disputes)).toEqual({ open: 2, overdue: 1 });
  });

  it('raises one alert per open dispute with none open, never a second; clears the settled one\'s', () => {
    const first = claimDisputeAlertPlan(disputes, []);
    expect(first.raise.map((d) => d.exceptionId).sort()).toEqual(['DSP-c-new', 'DSP-c-old']);
    expect(first.clear).toEqual([]);
    // Both alerts now open, and an old one for the dispute settled since: nothing raised twice, the settled one cleared.
    const open = [claimDisputeAlertIdOf('DSP-c-old'), claimDisputeAlertIdOf('DSP-c-new'), claimDisputeAlertIdOf('DSP-c-done'), 'tally-dead-letter:x'];
    const second = claimDisputeAlertPlan(disputes, open);
    expect(second.raise).toEqual([]);
    expect(second.clear).toEqual(['supplier-claim-dispute:DSP-c-done']); // never another kind of alert
  });
});
