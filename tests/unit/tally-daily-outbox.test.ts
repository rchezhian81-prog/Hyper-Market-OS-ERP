import { describe, it, expect } from 'vitest';
import { buildDailyTallyFile, familyOf, gstAccountsOf, validateTallyImport, type GlJournal } from '../../packages/tally-export/src/index';
import { runTallyOutbox, foldOutbox, postingsToQueue, deadLetteredInPeriod, isDue, type TallyOutboxDeps, type TallyOutboxFact, type TallyDayFile } from '../../services/finance/src/tally-outbox';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

// OB-293 · M23-FR-04: the daily Tally file (every family of journal, voucher type the accountant's, GST shown on its own)
// and the stored outbox engine — queue once, wait for the ledger names, reject straight to the dead letter, retry a store
// that could not take the file with backoff, dead-letter after the attempt budget, never drop anything. Synthetic only.

const j = (entryId: string, day: string, lines: [string, number, number][], tag: Partial<GlJournal> = {}): GlJournal => ({
  entryId, period: day.slice(0, 7), documentDate: day, narrative: `Journal ${entryId} for the shop`,
  lines: lines.map(([accountCode, debitMinor, creditMinor]) => ({ accountCode, debitMinor, creditMinor })), ...tag,
});

describe('the daily Tally file (OB-293)', () => {
  const GST = gstAccountsOf(DEFAULT_RETAIL_POSTING_MAP);
  it('reads the GST accounts from the accountant\'s posting map (tax components), never from a name', () => {
    expect(GST).toEqual(expect.arrayContaining(['gst_output_cgst', 'gst_output_sgst', 'gst_output', 'gst_input_cgst', 'gst_input_sgst', 'gst_input_igst']));
    expect(GST).not.toContain('sales_revenue');
    expect(gstAccountsOf(undefined)).toEqual([]);
  });

  it('puts every journal in one family from its own tag or id', () => {
    const d = '2026-10-01';
    expect(familyOf(j('a', d, [], { dayBook: { kind: 'sale' } }))).toBe('sales');
    expect(familyOf(j('a', d, [], { dayBook: { kind: 'sale_return' } }))).toBe('returns');
    expect(familyOf(j('a', d, [], { dayBook: { kind: 'tender:cash' } }))).toBe('cash');
    expect(familyOf(j('a', d, [], { dayBook: { kind: 'refund:cash' } }))).toBe('returns');
    expect(familyOf(j('a', d, [], { dayBook: { kind: 'tender:upi' } }))).toBe('bank');
    expect(familyOf(j('a', d, [], { dayBook: { kind: 'tender:store_credit' } }))).toBe('stored_value');
    expect(familyOf(j('a', d, [], { dayBook: { kind: 'loyalty:earn' } }))).toBe('loyalty');
    expect(familyOf(j('daybook:2026-10-01:tender:card:1', d, []))).toBe('bank');
    expect(familyOf(j('a', d, [], { payables: { kind: 'supplier_payment' } }))).toBe('payables');
    expect(familyOf(j('a', d, [], { supplierAdvance: {} }))).toBe('payables');
    expect(familyOf(j('a', d, [], { b2b: {} }))).toBe('receivables');
    expect(familyOf(j('a', d, [], { stockPeriod: {} }))).toBe('stock');
    expect(familyOf(j('stock-adjustment:count:1', d, []))).toBe('stock');
    expect(familyOf(j('a', d, [], { fixedAsset: {} }))).toBe('fixed_assets');
    expect(familyOf(j('a', d, [], { rebateAccrual: {} }))).toBe('supplier_income');
    expect(familyOf(j('migration-delta:x', d, []))).toBe('opening');
    expect(familyOf(j('gst-setoff', d, [['gst_output_cgst', 100, 0], ['gst_input_cgst', 0, 100]]), GST)).toBe('gst');
    expect(familyOf(j('manual-1', d, [['shop_expenses', 1, 0], ['cash_in_hand', 0, 1]]), GST)).toBe('general');
  });

  it('builds one importable day file: voucher types by family, control totals per family, the GST summary', () => {
    const d = '2026-10-02';
    const names = Object.fromEntries(['sales_clearing', 'sales_revenue', 'gst_output_cgst', 'gst_output_sgst', 'cash_in_hand', 'shop_expenses'].map((a) => [a, `Tally ${a}`]));
    const file = buildDailyTallyFile({
      day: d, sequence: 1, companyName: 'SRE (synthetic)', ledgerNames: names, voucherTypes: { sales: 'Sales', cash: 'Receipt' }, gstAccounts: GST,
      journals: [
        j('sale-1', d, [['sales_clearing', 11_800, 0], ['sales_revenue', 0, 10_000], ['gst_output_cgst', 0, 900], ['gst_output_sgst', 0, 900]], { dayBook: { kind: 'sale' } }),
        j('cash-1', d, [['cash_in_hand', 11_800, 0], ['sales_clearing', 0, 11_800]], { dayBook: { kind: 'tender:cash' } }),
        j('exp-1', d, [['shop_expenses', 500, 0], ['cash_in_hand', 0, 500]]),
      ],
    });
    expect(file.importable).toBe(true);
    expect(file.fileName).toBe('sre-tally-2026-10-02-01.xml');
    expect(file.byFamily).toEqual([
      { family: 'sales', vouchers: 1, debitMinor: 11_800, creditMinor: 11_800 },
      { family: 'cash', vouchers: 1, debitMinor: 11_800, creditMinor: 11_800 },
      { family: 'general', vouchers: 1, debitMinor: 500, creditMinor: 500 },
    ]);
    expect(file.gst).toEqual([{ accountCode: 'gst_output_cgst', debitMinor: 0, creditMinor: 900 }, { accountCode: 'gst_output_sgst', debitMinor: 0, creditMinor: 900 }]);
    expect(file.export.xml).toContain('VCHTYPE="Sales"');
    expect(file.export.xml).toContain('VCHTYPE="Receipt"');
    expect(file.export.xml).toContain('VCHTYPE="Journal"');
    expect(validateTallyImport(file.export.xml, file.export.controlTotals).ok).toBe(true);
    // An unnamed ledger keeps the journal OUT and the file is not importable — a part of a day never passes as a day.
    const part = buildDailyTallyFile({ day: d, sequence: 1, companyName: 'SRE', ledgerNames: { cash_in_hand: 'Cash' }, journals: [j('exp-1', d, [['shop_expenses', 500, 0], ['cash_in_hand', 0, 500]])] });
    expect(part.importable).toBe(false);
    expect(part.export.exceptions[0]!.reason).toBe('ledger_not_mapped');
  });
});

/** An outbox over memory, with a file store that can be told to fail. */
function memoryOutbox(opts: { names?: boolean; failStores?: number; journals: GlJournal[] }) {
  const facts: TallyOutboxFact[] = [];
  const keys = new Set<string>();
  const files: TallyDayFile[] = [];
  let failures = opts.failStores ?? 0;
  let clock = Date.parse('2026-10-10T06:00:00.000Z');
  const raised: string[] = [];
  const deps: TallyOutboxDeps = {
    journals: () => opts.journals,
    ledgerNames: () => (opts.names === false ? undefined : { companyName: 'SRE', names: { a: 'A', b: 'B' }, version: 1, setBy: 'u', setAt: 'x' }),
    postingMap: () => undefined,
    facts: () => facts,
    record: (_t, f, key) => { if (!keys.has(key)) { keys.add(key); facts.push(f); } },
    files: () => files,
    storeFile: (_t, f) => { if (failures > 0) { failures -= 1; throw new Error('disk full'); } files.push(f); },
    raiseDeadLetter: (_t, p) => { raised.push(p.postingId); },
    shopDayOf: (iso) => iso.slice(0, 10),
    now: () => new Date(clock).toISOString(),
  };
  return { deps, facts, files, raised, advance: (seconds: number) => { clock += seconds * 1000; } };
}

describe('the stored outbox engine (OB-293 · M23-FR-04)', () => {
  const ok = (id: string, day: string) => j(id, day, [['a', 100, 0], ['b', 0, 100]]);
  it('queues each ENDED day once; a late journal is the day\'s next file; today waits', () => {
    const existing = postingsToQueue({ journals: [ok('x1', '2026-10-01'), ok('x2', '2026-10-01'), ok('t', '2026-10-10')], existing: [], today: '2026-10-10', at: 'now' });
    expect(existing.map((p) => [p.postingId, p.journalIds])).toEqual([['tally-day:2026-10-01:1', ['x1', 'x2']]]);
    expect(postingsToQueue({ journals: [ok('x1', '2026-10-01'), ok('x2', '2026-10-01')], existing, today: '2026-10-10', at: 'now' })).toEqual([]);
    const late = postingsToQueue({ journals: [ok('x1', '2026-10-01'), ok('x3', '2026-10-01')], existing, today: '2026-10-10', at: 'now' });
    expect(late.map((p) => p.postingId)).toEqual(['tally-day:2026-10-01:2']);
    expect(late[0]!.idempotencyKey).not.toBe(existing[0]!.idempotencyKey);
  });

  it('waits (no attempt) while the ledger names are not set', async () => {
    const m = memoryOutbox({ names: false, journals: [ok('x1', '2026-10-01')] });
    const pass = await runTallyOutbox(m.deps, 't', 'w');
    expect(pass.waitingFor).toBe('ledger_names');
    expect(foldOutbox(m.facts)[0]).toMatchObject({ state: 'queued', attempts: 0 });
  });

  it('retries a store that could not take the file with computed backoff, then dead-letters after five attempts — kept, raised, counted', async () => {
    const m = memoryOutbox({ failStores: 99, journals: [ok('x1', '2026-10-01')] });
    await runTallyOutbox(m.deps, 't', 'w');
    let p = foldOutbox(m.facts)[0]!;
    expect(p).toMatchObject({ state: 'queued', attempts: 1 });
    expect(p.lastFailure).toMatch(/disk full/);
    // Not due again until the backoff (30 s after the first attempt) has passed.
    const early = await runTallyOutbox(m.deps, 't', 'w');
    expect(early.notYetDue).toEqual([p.postingId]);
    expect(isDue(p, m.deps.now())).toBe(false);
    for (const wait of [30, 60, 120, 240]) { m.advance(wait); await runTallyOutbox(m.deps, 't', 'w'); }
    p = foldOutbox(m.facts)[0]!;
    expect(p).toMatchObject({ state: 'dead_lettered', attempts: 5 });
    expect(m.raised).toEqual([p.postingId]);
    expect(deadLetteredInPeriod(foldOutbox(m.facts), '2026-10')).toBe(1);
    // Nothing was dropped, and a later pass never takes a dead-lettered day back.
    m.advance(3600);
    await runTallyOutbox(m.deps, 't', 'w');
    expect(foldOutbox(m.facts)[0]!.state).toBe('dead_lettered');
  });

  it('a store that recovers within the budget makes the file ready', async () => {
    const m = memoryOutbox({ failStores: 1, journals: [ok('x1', '2026-10-01')] });
    await runTallyOutbox(m.deps, 't', 'w');
    m.advance(30);
    const pass = await runTallyOutbox(m.deps, 't', 'w');
    expect(pass.posted).toEqual(['tally-day:2026-10-01:1']);
    expect(m.files).toHaveLength(1);
    expect(foldOutbox(m.facts)[0]).toMatchObject({ state: 'posted', attempts: 2, voucherRef: m.files[0]!.sha256 });
  });

  it('a journal that cannot be written is a rejection — straight to the dead letter, no retries burned', async () => {
    const m = memoryOutbox({ journals: [j('bad', '2026-10-01', [['a', 100, 0], ['zz', 0, 100]])] });
    const pass = await runTallyOutbox(m.deps, 't', 'w');
    expect(pass.deadLettered).toEqual(['tally-day:2026-10-01:1']);
    expect(foldOutbox(m.facts)[0]).toMatchObject({ state: 'dead_lettered', attempts: 1 });
    expect(foldOutbox(m.facts)[0]!.lastFailure).toMatch(/rejected by Tally: .*zz/);
  });
});
