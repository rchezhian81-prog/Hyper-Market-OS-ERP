import { describe, it, expect } from 'vitest';
import {
  buildVerificationReport, signVerificationReport, renderVerificationReport, looksLikeNoReason,
  type DomainFinding, type Acceptance,
} from '../../packages/migration/src/verification-report';
import { VERIFIES, type DataDomain } from '../../packages/migration/src/extraction';

// MG-06, OB-06, QG-07, §34, P-08 — the one page the owner and the CA sign against. Six checks,
// one document, and the refusals are about the document rather than the arithmetic.

const ALL = Object.keys(VERIFIES) as DataDomain[];

const proved = (domain: DataDomain, figureMinor: number): DomainFinding => ({
  domain, verdict: 'proved', figureMinor,
  // Every witness that checked it, not just the first — `ledgers` has three.
  provedBy: VERIFIES[domain],
  whatItCannotProve: 'the evidence shows what arrived, not that nothing was missed',
  ownerAction: 'nothing',
});

const FINDINGS: readonly DomainFinding[] = ALL.map((d, i) => proved(d, 100_000 * (i + 1)));

const OWNER = 'u-owner';

const build = (over: Partial<Parameters<typeof buildVerificationReport>[0]> = {}) =>
  buildVerificationReport({
    reportId: 'VR-2026-04-01', asAt: '2026-03-31', preparedBy: 'u-manager',
    extractionOperator: 'u-operator', findings: FINDINGS, ownerId: OWNER, ...over,
  });

const accept = (domain: DataDomain, over: Partial<Acceptance> = {}): Acceptance => ({
  domain, acceptedBy: OWNER, acceptedOn: '2026-04-01',
  reason: 'the old system is the only record of this and we are carrying it forward knowingly, having discussed it with the CA',
  ...over,
});

describe('a report over some of the domains is the failure the page cannot show', () => {
  it('REFUSES to render until every domain has a finding', () => {
    // Four of twelve renders perfectly: every heading filled, every figure right, and a
    // complete-looking account of a third of the business. The missing eight are missing in the
    // only way nobody checks — they are not on the page to be looked at.
    const r = build({ findings: FINDINGS.slice(0, 4) });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('not_every_domain_covered');
    expect(r.detail).toContain('not on the page to be looked at');
    expect(r.report).toBeUndefined();
  });

  it('names exactly which domains are missing', () => {
    const r = build({ findings: FINDINGS.filter((f) => f.domain !== 'tax' && f.domain !== 'loyalty') });
    expect(r.detail).toContain('loyalty');
    expect(r.detail).toContain('tax');
  });

  it('builds when all twelve are there', () => {
    const r = build();
    expect(r.ok).toBe(true);
    expect(r.report!.findings).toHaveLength(ALL.length);
    expect(r.report!.proved).toBe(ALL.length);
    expect(r.report!.readyToSign).toBe(true);
  });
});

describe('a proof with no stated limit is refused', () => {
  it('REFUSES a domain reported as proved with nothing written about what it does not cover', () => {
    // Every one of these checks has a real limit. A blank does not mean there is none — it means
    // nobody wrote it down, and whoever signs then reads the evidence as covering more than it does.
    const r = build({
      findings: FINDINGS.map((f) => (f.domain === 'sales' ? { ...f, whatItCannotProve: '' } : f)),
    });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('no_limit_stated');
    expect(r.detail).toContain('read by whoever signs as "no limit"');
  });

  it('REFUSES a limit too short to be a sentence', () => {
    expect(build({
      findings: FINDINGS.map((f) => (f.domain === 'tax' ? { ...f, whatItCannotProve: 'none really' } : f)),
    }).refusedBecause).toBe('no_limit_stated');
  });

  it('does not demand a limit from a domain that nothing proved', () => {
    // There is no proof, so there is no limit to state. The gap itself is the finding.
    const r = build({
      findings: FINDINGS.map((f) => (f.domain === 'batches'
        ? { ...f, verdict: 'not_proved' as const, provedBy: undefined, whatItCannotProve: '' } : f)),
      acceptances: [accept('batches')],
    });
    expect(r.ok).toBe(true);
  });
});

describe('an unproved domain is a row in the table, not a footnote', () => {
  const withGap: readonly DomainFinding[] = FINDINGS.map((f) => (f.domain === 'batches'
    ? { ...f, verdict: 'not_proved' as const, provedBy: undefined, ownerAction: 'book the physical count' }
    : f));

  it('REFUSES to build until the owner has accepted it, one at a time and by name', () => {
    // A single tick against "I accept the exceptions above" accepts things nobody read.
    const r = build({ findings: withGap });
    expect(r.refusedBecause).toBe('exception_not_accepted');
    expect(r.detail).toContain('each one is decided on its own');
  });

  it('REFUSES an acceptance from anybody but the owner', () => {
    const r = build({ findings: withGap, acceptances: [accept('batches', { acceptedBy: 'u-manager' })] });
    expect(r.refusedBecause).toBe('accepted_by_somebody_other_than_the_owner');
    expect(r.detail).toContain("the owner's decision and nobody else's");
  });

  it('REFUSES a reason that fills the box without accepting anything', () => {
    for (const reason of ['ok', 'Approved', 'agreed', 'as discussed', 'noted', 'n/a', '-']) {
      expect(looksLikeNoReason(reason)).toBe(true);
    }
    const r = build({ findings: withGap, acceptances: [accept('batches', { reason: 'approved' })] });
    expect(r.refusedBecause).toBe('acceptance_explains_nothing');
    // In two years this sentence is the only record that the owner understood what was carried.
    expect(r.detail).toContain('the only record that the owner understood');
  });

  it('accepts a reason that actually says something', () => {
    expect(looksLikeNoReason(accept('batches').reason)).toBe(false);
    const r = build({ findings: withGap, acceptances: [accept('batches')] });
    expect(r.ok).toBe(true);
    expect(r.report!.notProved).toEqual(['batches']);
    expect(r.report!.readyToSign).toBe(true);
  });

  it('sorts the worst verdicts to the top, so the gaps are read first', () => {
    const mixed: readonly DomainFinding[] = FINDINGS.map((f) => (f.domain === 'batches'
      ? { ...f, verdict: 'not_proved' as const }
      : f.domain === 'ledgers' ? { ...f, verdict: 'no_evidence_exists' as const }
        : f.domain === 'sales' ? { ...f, verdict: 'proved_with_differences' as const } : f));
    const r = build({
      findings: mixed,
      acceptances: [accept('batches'), accept('ledgers')],
    });
    expect(r.report!.findings[0]?.domain).toBe('ledgers');   // nothing can check it
    expect(r.report!.findings[1]?.domain).toBe('batches');   // not proved
    expect(r.report!.findings[2]?.domain).toBe('sales');     // proved, with differences
  });
});

describe('who may prepare and who may sign', () => {
  it('REFUSES a report certified by whoever ran the extraction', () => {
    const r = build({ preparedBy: 'u-operator' });
    expect(r.refusedBecause).toBe('signed_by_whoever_ran_the_extraction');
    expect(r.detail).toContain('QG-07');
  });

  const report = build().report!;

  it('REFUSES a signature from whoever ran the extraction', () => {
    const s = signVerificationReport({
      report, signedBy: 'u-operator', role: 'owner', extractionOperator: 'u-operator',
      statement: 'I have read the figures and the limits above and accept them', now: '2026-04-02',
    });
    expect(s.ok).toBe(false);
    expect(s.refusedBecause).toBe('signer_ran_the_extraction');
  });

  it('REFUSES a statement that records a tick rather than a check', () => {
    const s = signVerificationReport({
      report, signedBy: OWNER, role: 'owner', extractionOperator: 'u-operator',
      statement: 'approved', now: '2026-04-02',
    });
    expect(s.refusedBecause).toBe('statement_explains_nothing');
    expect(s.detail).toContain('records that a box was ticked');
  });

  it('REFUSES to sign a report that is not ready', () => {
    const notReady = {
      ...report,
      readyToSign: false,
      notProved: ['batches' as DataDomain],
    };
    const s = signVerificationReport({
      report: notReady, signedBy: OWNER, role: 'owner', extractionOperator: 'u-operator',
      statement: 'I have read the figures and the limits above and accept them', now: '2026-04-02',
    });
    expect(s.refusedBecause).toBe('report_not_ready');
  });

  it('accumulates signatures and never replaces one', () => {
    // A signature belongs to the figures that were on the page when it was given.
    const first = signVerificationReport({
      report, signedBy: OWNER, role: 'owner', extractionOperator: 'u-operator',
      statement: 'I have read the figures and the limits above and accept them', now: '2026-04-02',
    });
    expect(first.ok).toBe(true);

    const second = signVerificationReport({
      report, signatures: first.signatures, signedBy: 'ca-krishnamurthy',
      role: 'chartered_accountant', extractionOperator: 'u-operator',
      statement: 'agreed to the signed accounts and the filed returns for the period', now: '2026-04-03',
    });
    expect(second.signatures).toHaveLength(2);
    expect(second.signatures[0]?.signedBy).toBe(OWNER);
  });
});

describe('the page the owner actually reads', () => {
  const report = build().report!;

  it('puts every figure, verdict and witness in one table', () => {
    const page = renderVerificationReport(report);
    for (const d of ALL) expect(page).toContain(`| ${d} |`);
    expect(page).toContain('Opening figures — what proved each one');
    expect(page).toContain('Every domain was checked against a record kept outside the old system');
  });

  it('formats money in Indian grouping, so twelve lakh does not read as four hundred thousand', () => {
    const page = renderVerificationReport(build({
      findings: FINDINGS.map((f) => (f.domain === 'stock' ? { ...f, figureMinor: 120_000_000 } : f)),
    }).report!);
    expect(page).toContain('₹12,00,000.00');
  });

  it('prints what the proofs do NOT show, in the body and not an appendix', () => {
    const page = renderVerificationReport(report);
    expect(page).toContain('## What these proofs do NOT show');
    expect(page).toContain('Read this part');
    // A limit that lives only in the source code is a limit nobody signing has ever seen.
    expect(page).toContain('not that nothing was missed');
  });

  it('says plainly, in the body, how many could not be proved', () => {
    const gapped = build({
      findings: FINDINGS.map((f) => (f.domain === 'batches' ? { ...f, verdict: 'not_proved' as const } : f)),
      acceptances: [accept('batches')],
    }).report!;
    const page = renderVerificationReport(gapped);
    expect(page).toContain('**1 of 12 could not be proved.**');
    expect(page).toContain('a report that lists only what passed is a report that hides its gaps');
    expect(page).toContain('**NOT PROVED**');
  });

  it('shows each accepted exception with who accepted it and why', () => {
    const gapped = build({
      findings: FINDINGS.map((f) => (f.domain === 'batches' ? { ...f, verdict: 'not_proved' as const } : f)),
      acceptances: [accept('batches')],
    }).report!;
    const page = renderVerificationReport(gapped);
    expect(page).toContain('## Exceptions the owner has accepted');
    expect(page).toContain("on the old system's word alone");
    expect(page).toContain('having discussed it with the CA');
  });

  it('says it is unsigned when it is, rather than leaving the section blank', () => {
    expect(renderVerificationReport(report)).toContain('_Unsigned._');
    const signed = signVerificationReport({
      report, signedBy: OWNER, role: 'owner', extractionOperator: 'u-operator',
      statement: 'I have read the figures and the limits above and accept them', now: '2026-04-02',
    });
    const page = renderVerificationReport(report, signed.signatures);
    expect(page).not.toContain('_Unsigned._');
    expect(page).toContain('**u-owner** (owner), 2026-04-02');
  });

  it('explains why each witness is independent, in the reader\'s own language', () => {
    const page = renderVerificationReport(report);
    expect(page).toContain('### Why each of these records is worth believing');
    expect(page).toContain('the only truth about stock that exists anywhere');
    // Names a reader can read, not identifiers.
    expect(page).toContain('filed GST return');
    expect(page).not.toContain('filed_gst_return');
    expect(page).not.toContain('ca_prepared_accounts');
  });

  it('shows EVERY witness for a domain that has more than one', () => {
    // `ledgers` is checked against the bank, the CA's accounts and the filed returns. Printing
    // one of the three understates the evidence behind a figure somebody is about to sign for.
    const page = renderVerificationReport(report);
    const row = page.split('\n').find((l) => l.startsWith('| ledgers |'))!;
    expect(row).toContain('bank statement');
    expect(row).toContain("CA's prepared accounts");
    expect(row).toContain('filed GST return');
  });

  it('shows a count where the domain is not a money figure', () => {
    // Most domains are not a rupee total, and a table of dashes reads as a broken report.
    const counted = build({
      findings: FINDINGS.map((f) => (f.domain === 'products'
        ? { ...f, figureMinor: undefined, figureLabel: '41,200 products' } : f)),
    }).report!;
    const page = renderVerificationReport(counted);
    expect(page).toContain('| products | 41,200 products |');
  });
});
