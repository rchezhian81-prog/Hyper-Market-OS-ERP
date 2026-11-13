import { describe, it, expect } from 'vitest';
import { todayFigures, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { emptyPack, known, type StorePack } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/index';
import { REPORTS } from '../../packages/reporting/src/index';
import { ROLE_CATALOGUE, ROLES_AWAITING_OWNER_APPROVAL } from '../../services/api/src/roles';
import { SETUP_CATALOGUE, SETTINGS, TenantSettings, setupStatus } from '../../packages/tenant/src/index';
import { ConfigStore } from '../../packages/config/src/index';
import { createSetupSession } from '../../apps/web-erp/src/setup-session';
import { createFinanceSession, type FinanceConfig, type FinancePorts } from '../../apps/web-erp/src/finance-session';
import type { QueuedPosting } from '../../packages/period-close/src/index';
import { buildBrief, type BuildBriefInput } from '../../apps/owner-app/src/index';
import { briefLinesIn } from '../../packages/owner-control/src/scheduled-brief';
import { figure } from '../../services/reporting/src/index';
import { figureNameIn } from '../../services/reporting/src/index';

/**
 * **U3 (OB-699, 7 Nov 2026): the PRODUCT's own words are carried in both languages from their source.** The store
 * computer's Today notes, every report's name and purpose, every figure's name, every role's name, every setup
 * question and setting label, the Finance page's state sentence, and the morning brief's sentence frames (head office's
 * and the owner's phone's) each carry a Tamil reading beside the English one — so a Tamil screen never shows a half
 * screen. A FINDING head office wrote stays English (OB-699 B); nothing here translates a finding.
 */

const TAMIL = /[஀-௿]/;
const DAY = '2026-10-05';
const input = (pack: StorePack, sales: ScreenInput['sales'] = []): ScreenInput =>
  ({ pack, sales, unreadableRecords: 0, outbox: new SyncOutbox(), now: `${DAY}T09:00:00.000Z`, tradingDay: DAY }) as unknown as ScreenInput;

describe('U3 · the store computer\'s Today notes', () => {
  it('a figure the box was not given says why in both languages', () => {
    const figures = todayFigures(input(emptyPack('this test pulled nothing')));
    for (const [key, f] of Object.entries(figures)) {
      if (key === 'salesToday') continue;
      expect(f.known, key).toBe(false);
      if (!f.known) { expect(f.why, key).toMatch(/has not been given/); expect(f.whyTa, key).toMatch(TAMIL); }
    }
    const sales = figures['salesToday']!;
    expect(sales.known && sales.noteTa, 'the takings note').toMatch(TAMIL);
  });

  it('a figure the box computed says its note in both languages', () => {
    const pack: StorePack = {
      ...emptyPack('x'),
      purchaseOrders: known([{ poId: 'po-1', supplierId: 's', lines: [{ productId: 'p', qty: 2 }] }] as never),
      receipts: known([] as never),
      floorIndents: known({ indents: [] } as never),
      countsQueue: known([] as never),
      batches: known([{ batchId: 'b', expiry: '2026-10-07' }] as never),
      expiryPolicy: known({ nearExpiryDays: 7 } as never),
      recalls: known([] as never),
      checklist: known([{ done: false, blocking: true }] as never),
      deliveries: known([] as never),
      supplierClaimDisputes: known({ open: 2, overdue: 1 }), // U7 · OB-727
    };
    const figures = todayFigures(input(pack));
    for (const [key, f] of Object.entries(figures)) {
      expect(f.known, key).toBe(true);
      if (f.known) expect(f.noteTa, `${key}: ${f.note}`).toMatch(TAMIL);
    }
    const checklist = figures['checklistOpen']!;
    expect(checklist.known && checklist.noteTa).toContain('1');
  });
});

describe('U3 · reports, figures and roles', () => {
  it('every report carries its name and the question it answers in Tamil', () => {
    for (const r of REPORTS) {
      expect(r.nameTa, r.id).toMatch(TAMIL);
      expect(r.answersTa, r.id).toMatch(TAMIL);
    }
  });

  it('a figure is named in Tamil through the one table, and an unknown name stays as it is', () => {
    const f = figure({ name: 'Taken', unit: 'minor_currency', asAt: null, now: '2026-10-05T09:00:00.000Z', notAvailableBecause: 'x' });
    expect(figureNameIn('ta', f.name)).toMatch(TAMIL);
    expect(figureNameIn('en', f.name)).toBe('Taken');
    expect(figureNameIn('ta', 'Something nobody named')).toBe('Something nobody named');
  });

  it('every role carries its name in Tamil', () => {
    for (const r of [...ROLE_CATALOGUE, ...ROLES_AWAITING_OWNER_APPROVAL]) expect(r.nameTa, r.id).toMatch(TAMIL);
  });
});

describe('U3 · the setup questions', () => {
  it('every setup question and every setting label is carried in Tamil, through to the screen', () => {
    for (const i of SETUP_CATALOGUE) {
      expect(i.questionTa, i.setting.key).toMatch(TAMIL);
      expect(i.setting.labelTa, i.setting.key).toMatch(TAMIL);
    }
    for (const s of Object.values(SETTINGS)) expect(s.labelTa, s.key).toMatch(TAMIL);
    const status = setupStatus(new TenantSettings(new ConfigStore()), 'acme');
    const session = createSetupSession({ tenantId: 'acme', userId: 'owner-1' }, { status: () => status });
    const h = session.headline();
    expect(h.sentenceTa).toMatch(TAMIL);
    expect(h.blocking[0]?.questionTa).toMatch(TAMIL);
    for (const g of session.groups()) for (const item of g.items) { expect(item.questionTa, item.key).toMatch(TAMIL); expect(item.labelTa, item.key).toMatch(TAMIL); }
  });
});

describe('U3 · the Finance page\'s state sentence', () => {
  const NOW = '2026-08-01T10:00:00.000Z';
  const posting = (over: Partial<QueuedPosting> = {}): QueuedPosting => ({
    postingId: 'P-1', idempotencyKey: 'k-1', period: '2026-07', journalRef: 'SALES-001',
    debitMinor: 100_000_00, creditMinor: 100_000_00, state: 'posted', attempts: 1, queuedAt: '2026-07-31T23:00:00.000Z', ...over,
  });
  const CONFIG: FinanceConfig = { tenantId: 't1', period: '2026-07', userId: 'u-finance', now: NOW, tradingDayCutoff: '02:00', journalPrefixes: { takings: 'SALES', tax: 'GST', refunds: 'REFUND' } };
  const ports = (over: Partial<FinancePorts> = {}): FinancePorts => ({
    ledger: () => ({ takingsMinor: 100_000_00, taxMinor: 5_000_00, refundsMinor: 2_000_00, billCount: 412 }),
    postings: () => [posting()], periodState: () => ({ closed: false }), unsentSyncCount: () => 0, openExceptionCount: () => 0, ...over,
  });

  it('"the shop has not said what it took" is said in both languages, on the month, the pack and the close', () => {
    const s = createFinanceSession(CONFIG, ports({ ledger: () => undefined }));
    expect(s.period().whyNoTotals).toContain('one side of a comparison');
    expect(s.period().whyNoTotalsTa).toMatch(TAMIL);
    const pack = s.evidence();
    expect(pack.signable).toBe(false);
    expect('whyTa' in pack ? pack.whyTa : undefined).toMatch(TAMIL);
    const close = s.close();
    expect(close.ok).toBe(false);
    if (!close.ok) expect(close.detailTa).toMatch(TAMIL);
  });

  it('"nobody is named at this desk" is said in both languages', () => {
    const close = createFinanceSession({ ...CONFIG, userId: null }, ports()).close();
    expect(close.ok).toBe(false);
    if (!close.ok) { expect(close.refusal).toBe('nobody_is_named_at_this_desk'); expect(close.detailTa).toMatch(TAMIL); }
  });
});

describe('U3 · the morning brief\'s sentence frames', () => {
  it('head office prepares the brief\'s lines in both languages at once', () => {
    const both = briefLinesIn({ figures: { salesMinor: 1_000_00, marginMinor: 300_00, baskets: 4, cashBankedMinor: 900_00, lastSyncedAt: '2026-10-05T03:00:00.000Z', now: '2026-10-05T03:01:00.000Z' } as never, attention: [] });
    expect(both.en.join(' ')).toMatch(/Sales/);
    expect(both.ta.join(' ')).toMatch(TAMIL);
    expect(both.en.length).toBe(both.ta.length);
  });

  it('the owner\'s phone composes its attention lines and headline in both languages; a finding\'s words are not translated', () => {
    const brief = buildBrief({
      asOf: '2026-08-02T20:00:00Z', lastSyncedAt: '2026-08-02T19:59:00Z', staleAfterSeconds: 300,
      sales: [{ saleId: 's1', netMinor: 100_00, taxMinor: 18_00, totalMinor: 118_00, cogsMinor: 70_00, units: 3, tender: 'cash', currency: 'INR' }],
      exceptions: [], approvals: [{ id: 'a1', subjectType: 'price_change', subjectRef: 'p1', requestedBy: 'manager-1', valueMinor: 50_000_00 }],
    } as BuildBriefInput);
    expect(brief.headlineTa).toMatch(TAMIL);
    expect(brief.attention[0]?.sentence).toContain('Approval waiting');
    expect(brief.attention[0]?.sentenceTa).toMatch(TAMIL);
    expect(brief.attention[0]?.sentenceTa).toContain('manager-1'); // the name is the name, in either language
    expect(brief.attention[0]?.sentenceTa).toContain('₹50,000.00');
  });
});
