import { describe, it, expect } from 'vitest';
import { buildTallyVouchers, validateTallyImport, rupees, paiseOf, escapeXml, remoteIdOf, type TallyJournal } from '../../packages/tally-export/src/index';

// WF-05 "→ AP/Tally" · M23-FR-04: balanced journals become one Tally-importable voucher file, checked by a stand-in for
// Tally's own import. Synthetic figures only.

const LEDGERS = { '5000': 'Purchases', '1400': 'Input CGST', '1401': 'Input SGST', '2100': 'Sundry Creditors' };
const accrual = (id: string, date: string, goods: number, cgst = 0, sgst = 0): TallyJournal => ({
  entryId: id, documentDate: date, narrative: `Payables — supplier sup-kav: accrual ${id}`,
  lines: [
    { accountCode: '5000', debitMinor: goods, creditMinor: 0 },
    ...(cgst > 0 ? [{ accountCode: '1400', debitMinor: cgst, creditMinor: 0 }] : []),
    ...(sgst > 0 ? [{ accountCode: '1401', debitMinor: sgst, creditMinor: 0 }] : []),
    { accountCode: '2100', debitMinor: 0, creditMinor: goods + cgst + sgst },
  ],
});

describe('Tally voucher export (WF-05 · M23-FR-04)', () => {
  it('writes one voucher per balanced journal, in Tally\'s sign convention, to the paisa', () => {
    const out = buildTallyVouchers({ companyName: 'SRE Hyper Market', ledgerNames: LEDGERS, journals: [accrual('payables:accrual:inv-1:1', '2026-10-05', 1_000_05, 2_500, 2_500)] });
    expect(out.complete).toBe(true);
    expect(out.vouchers).toHaveLength(1);
    expect(out.controlTotals).toEqual({ voucherCount: 1, debitMinor: 1_050_05, creditMinor: 1_050_05 });
    expect(out.xml).toContain('<VOUCHER REMOTEID="sre:payables:accrual:inv-1:1" VCHTYPE="Journal" ACTION="Create">');
    expect(out.xml).toContain('<DATE>20261005</DATE>');
    // A debit: deemed positive, negative amount. A credit: not deemed positive, positive amount.
    expect(out.xml).toContain('<LEDGERNAME>Purchases</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1000.05</AMOUNT>');
    expect(out.xml).toContain('<LEDGERNAME>Sundry Creditors</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1050.05</AMOUNT>');
    const check = validateTallyImport(out.xml, out.controlTotals);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.company).toBe('SRE Hyper Market');
    expect(check.vouchers[0]!.entries.reduce((s, e) => s + e.amountMinor, 0)).toBe(0);
  });

  it('never writes a journal that touches an account the accountant has not mapped — it is an exception by name', () => {
    const out = buildTallyVouchers({ companyName: 'SRE', ledgerNames: { '5000': 'Purchases' }, journals: [accrual('j-1', '2026-10-05', 500)] });
    expect(out.complete).toBe(false);
    expect(out.vouchers).toHaveLength(0);
    expect(out.exceptions).toEqual([expect.objectContaining({ entryId: 'j-1', reason: 'ledger_not_mapped', accountCodes: ['2100'] })]);
    expect(out.xml).not.toContain('<VOUCHER');
  });

  it('refuses an unbalanced, undated, un-narrated or repeated journal, and keeps the rest', () => {
    const good = accrual('ok', '2026-10-01', 100);
    const out = buildTallyVouchers({
      companyName: 'SRE', ledgerNames: LEDGERS, journals: [
        good, good,
        { ...accrual('lop', '2026-10-01', 100), lines: [{ accountCode: '5000', debitMinor: 100, creditMinor: 0 }, { accountCode: '2100', debitMinor: 0, creditMinor: 99 }] },
        accrual('when', '2026-02-30', 100),
        { ...accrual('why', '2026-10-01', 100), narrative: '  ' },
      ],
    });
    expect(out.vouchers.map((v) => v.entryId)).toEqual(['ok']);
    expect(out.exceptions.map((e) => [e.entryId, e.reason]).sort()).toEqual([['lop', 'does_not_balance'], ['ok', 'duplicate_entry'], ['when', 'bad_date'], ['why', 'no_narrative']]);
  });

  it('escapes narration and ledger names, and the stand-in reads them back as written', () => {
    const out = buildTallyVouchers({
      companyName: 'S&R <Hyper> "Market"', ledgerNames: { ...LEDGERS, '2100': "Kaveri & Sons 'Creditors'" },
      journals: [{ ...accrual('e-1', '2026-10-09', 250), narrative: 'Bill 12 <rice> & dal' }],
    });
    expect(out.xml).toContain('Bill 12 &lt;rice&gt; &amp; dal');
    const check = validateTallyImport(out.xml, out.controlTotals);
    expect(check.ok).toBe(true);
    expect(check.company).toBe('S&R <Hyper> "Market"');
    expect(check.vouchers[0]!.narration).toBe('Bill 12 <rice> & dal');
    expect(check.vouchers[0]!.entries.map((e) => e.ledgerName)).toContain("Kaveri & Sons 'Creditors'");
  });

  it('the stand-in refuses what Tally would: a tampered sign, an unbalanced voucher, a repeated REMOTEID, a bad date, a raw "&"', () => {
    const out = buildTallyVouchers({ companyName: 'SRE', ledgerNames: LEDGERS, journals: [accrual('a', '2026-10-01', 100), accrual('b', '2026-10-02', 200)] });
    expect(validateTallyImport(out.xml).ok).toBe(true);
    const sign = out.xml.replace('<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1.00</AMOUNT>', '<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-1.00</AMOUNT>');
    expect(validateTallyImport(sign).problems.join(' ')).toContain('disagrees with the sign');
    const lop = out.xml.replace('<AMOUNT>2.00</AMOUNT>', '<AMOUNT>2.01</AMOUNT>');
    expect(validateTallyImport(lop).problems.join(' ')).toContain('do not balance');
    const twice = out.xml.replace('REMOTEID="sre:b"', 'REMOTEID="sre:a"');
    expect(validateTallyImport(twice).problems.join(' ')).toContain('appears twice');
    const date = out.xml.replace('<DATE>20261002</DATE>', '<DATE>20261302</DATE>');
    expect(validateTallyImport(date).problems.join(' ')).toContain('not a calendar date');
    const amp = out.xml.replace('<NARRATION>Payables', '<NARRATION>A & B Payables');
    expect(validateTallyImport(amp).problems.join(' ')).toContain('unescaped "&"');
    expect(validateTallyImport(out.xml, { voucherCount: 2, debitMinor: 300, creditMinor: 301 }).problems.join(' ')).toContain('the export claimed');
    expect(validateTallyImport('<ENVELOPE><HEADER>').ok).toBe(false);
  });

  it('formats paise exactly and reads them back', () => {
    expect(rupees(0)).toBe('0.00');
    expect(rupees(5)).toBe('0.05');
    expect(rupees(-123_456_78)).toBe('-123456.78');
    expect(paiseOf('-123456.78')).toBe(-123_456_78);
    expect(paiseOf('1.5')).toBeUndefined();
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
    expect(remoteIdOf('x')).toBe('sre:x');
  });
});
