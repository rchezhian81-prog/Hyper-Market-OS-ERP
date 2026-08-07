// The one page the owner and the CA sign — MG-06, OB-06, QG-07, §34, P-08.
//
// Six checks each produce a verdict and a sentence of advice. Nobody has to read six outputs: this
// gathers them into a single document, in the language of the runbook rather than of the modules,
// and it is the thing that actually gets signed.
//
// Which makes it the most dangerous file in the migration, because **a report is what people
// believe.** Nobody re-derives a figure from the modules once a page exists with a signature on
// it. So the refusals here are about the document rather than the arithmetic:
//
//   • **IT CANNOT BE PRODUCED FROM SOME OF THE DOMAINS.** Render a report over four domains when
//     there are twelve and you get a page that looks complete and covers a third of the business.
//     Every heading is filled in, every figure is right, and the missing eight are missing in the
//     only way nobody checks: they are not there to be looked at. This is exactly the failure
//     `completeness.ts` refuses in a truncated export — internally consistent about a smaller
//     shop — and it is refused the same way, by requiring every domain before anything renders.
//
//   • **IT MUST BE ABLE TO SAY "NOT PROVED", IN THE TABLE.** A report listing only what passed is
//     a report that hides its gaps. An unproved domain gets a row of its own, in the same table,
//     in the same type — not a footnote, not an appendix, not silence (P-08).
//
//   • **WHAT EACH CHECK CANNOT PROVE IS PRINTED.** The fixed `false` on every module —
//     `provesSalesWereComplete`, `provesTaxWasCorrectlyCharged`, `provesTheAccountsAreRight`,
//     `provesTheBalanceWasEarned` — is a limit the signer needs, and a limit that lives only in
//     the source code is a limit nobody signing has ever seen.
//
//   • **AN EXCEPTION IS ACCEPTED ONE AT A TIME, BY NAME, WITH A REASON.** A single tick against
//     "I accept the exceptions above" accepts things nobody read. Each unproved domain needs the
//     owner's own acceptance, naming that domain and saying why — and a reason that says nothing
//     is refused, in the same way `cutover.ts` refuses an explanation that explains nothing.
//
//   • **THE PERSON WHO RAN THE EXTRACTION CANNOT SIGN IT.** The same separation
//     `signControlTotal` already enforces, for the same reason.
//
// Pure and deterministic: no I/O, no clock beyond the dates supplied.

import { VERIFIES, EXTERNAL_SOURCE_NOTE, type DataDomain, type ExternalSource } from './extraction';

export type DomainVerdict =
  /** Checked against outside evidence and it agreed. */
  | 'proved'
  /** Checked, and the evidence disagreed. The differences are listed and owned. */
  | 'proved_with_differences'
  /** The evidence exists and we have not obtained it, or the check has not been run. */
  | 'not_proved'
  /** Nothing outside the old system can check this domain. Stated, never discovered later. */
  | 'no_evidence_exists';

export interface DomainFinding {
  readonly domain: DataDomain;
  readonly verdict: DomainVerdict;
  /** The money figure carried into the opening books, where the domain has one. */
  readonly figureMinor?: number;
  /**
   * The figure in its own units where it is not money — *"41,200 products"*, *"8,900 customers"*.
   *
   * Most domains are not a rupee total, and a table of dashes reads as a broken report rather
   * than as an honest one.
   */
  readonly figureLabel?: string;
  /**
   * Every witness that checked this domain, not just the first.
   *
   * Several domains have more than one — `ledgers` is checked against the bank, the CA's accounts
   * *and* the filed returns — and showing one of three understates the evidence behind a figure
   * somebody is about to sign for.
   */
  readonly provedBy?: readonly ExternalSource[];
  /**
   * What this evidence does **not** show, in plain words.
   *
   * The module's fixed `false`, written out. A limit that lives only in the source code is a limit
   * nobody signing the report has ever seen — so a proved domain that states no limit is refused
   * rather than rendered, because every one of these checks has a real limit and a blank means
   * nobody thought about it.
   */
  readonly whatItCannotProve: string;
  /** The module's own sentence of advice, carried through unchanged. */
  readonly ownerAction: string;
}

export interface Acceptance {
  readonly domain: DataDomain;
  readonly acceptedBy: string;
  readonly acceptedOn: string;
  readonly reason: string;
}

/**
 * Words that fill an acceptance box without accepting anything.
 *
 * The same test `cutover.ts` applies to a difference explanation. A reason has to say what the
 * owner understood and decided, because in two years it is the only record that they did.
 */
const NOT_A_REASON =
  /^(ok(ay)?|fine|approved?|agreed?|accepted?|noted|yes|as discussed|no issue|n\/?a|-+)\.?$/i;

export const looksLikeNoReason = (reason: string): boolean =>
  NOT_A_REASON.test(reason.trim()) || reason.trim().length < 20;

export type ReportRefusal =
  | 'not_every_domain_covered'
  | 'signed_by_whoever_ran_the_extraction'
  | 'exception_not_accepted'
  | 'acceptance_explains_nothing'
  | 'accepted_by_somebody_other_than_the_owner'
  | 'no_limit_stated';

export interface Signature {
  readonly signedBy: string;
  readonly role: 'owner' | 'chartered_accountant';
  readonly signedOn: string;
  readonly statement: string;
}

export interface VerificationReport {
  readonly reportId: string;
  readonly asAt: string;
  readonly preparedBy: string;
  readonly findings: readonly DomainFinding[];
  readonly acceptances: readonly Acceptance[];
  readonly proved: number;
  readonly withDifferences: number;
  readonly notProved: readonly DataDomain[];
  readonly noEvidence: readonly DataDomain[];
  /** Every domain either proved or explicitly accepted by the owner, by name. */
  readonly readyToSign: boolean;
  readonly detail: string;
}

export interface BuildResult {
  readonly ok: boolean;
  readonly report?: VerificationReport;
  readonly refusedBecause?: ReportRefusal;
  readonly detail: string;
}

const ALL_DOMAINS = Object.keys(VERIFIES) as readonly DataDomain[];

/**
 * Build the report, or refuse to.
 *
 * Nothing renders until every domain has a finding. A partial report is the one failure this
 * document can produce all by itself, and it is invisible on the page.
 */
export function buildVerificationReport(input: {
  readonly reportId: string;
  readonly asAt: string;
  readonly preparedBy: string;
  readonly extractionOperator: string;
  readonly findings: readonly DomainFinding[];
  readonly acceptances?: readonly Acceptance[];
  /** Who may accept an exception. Only this person, and never the preparer. */
  readonly ownerId: string;
}): BuildResult {
  const acceptances = input.acceptances ?? [];
  const covered = new Set(input.findings.map((f) => f.domain));
  const missing = ALL_DOMAINS.filter((d) => !covered.has(d));

  if (missing.length > 0) {
    return {
      ok: false,
      refusedBecause: 'not_every_domain_covered',
      detail: `no finding for ${missing.join(', ')}. A report over ${covered.size} of ${ALL_DOMAINS.length} domains would render perfectly — every heading filled, every figure right — and be a complete-looking account of a fraction of the business. The domains that are missing are missing in the only way nobody checks: they are not on the page to be looked at`,
    };
  }

  // Every one of these checks has a real limit. A blank does not mean there is none; it means
  // nobody wrote it down, and the signer then reads the evidence as covering more than it does.
  const silent = input.findings.find((f) =>
    (f.verdict === 'proved' || f.verdict === 'proved_with_differences')
    && f.whatItCannotProve.trim().length < 20);
  if (silent !== undefined) {
    return {
      ok: false,
      refusedBecause: 'no_limit_stated',
      detail: `${silent.domain} is reported as proved with nothing written down about what that proof does not cover. Every one of these checks has a real limit — the bank shows what arrived and not what was sold, a return shows what was declared and not what was correct — and a blank here is read by whoever signs as "no limit"`,
    };
  }

  const needsAcceptance = input.findings
    .filter((f) => f.verdict === 'not_proved' || f.verdict === 'no_evidence_exists')
    .map((f) => f.domain);
  const acceptedFor = new Map(acceptances.map((a) => [a.domain, a]));

  for (const domain of needsAcceptance) {
    const a = acceptedFor.get(domain);
    if (a === undefined) {
      return {
        ok: false,
        refusedBecause: 'exception_not_accepted',
        detail: `${domain} is not proved and the owner has not accepted it. One tick against "I accept the exceptions above" accepts things nobody read — each one is named, and each one is decided on its own`,
      };
    }
    if (a.acceptedBy !== input.ownerId) {
      return {
        ok: false,
        refusedBecause: 'accepted_by_somebody_other_than_the_owner',
        detail: `${domain} was accepted by ${a.acceptedBy}. Carrying a figure into the opening books on the old system's word alone is the owner's decision and nobody else's`,
      };
    }
    if (looksLikeNoReason(a.reason)) {
      return {
        ok: false,
        refusedBecause: 'acceptance_explains_nothing',
        detail: `the acceptance for ${domain} reads "${a.reason.trim()}", which fills the box without accepting anything. In two years this sentence is the only record that the owner understood what was being carried and decided to carry it`,
      };
    }
  }

  if (input.preparedBy === input.extractionOperator) {
    return {
      ok: false,
      refusedBecause: 'signed_by_whoever_ran_the_extraction',
      detail: `${input.preparedBy} ran the extraction and cannot also be the one certifying it. The same separation QG-07 already requires of a control total`,
    };
  }

  const order: Readonly<Record<DomainVerdict, number>> = {
    no_evidence_exists: 0, not_proved: 1, proved_with_differences: 2, proved: 3,
  };
  const findings = [...input.findings].sort((a, b) => order[a.verdict] - order[b.verdict]
    || (a.domain < b.domain ? -1 : 1));

  const proved = findings.filter((f) => f.verdict === 'proved').length;
  const withDifferences = findings.filter((f) => f.verdict === 'proved_with_differences').length;
  const notProved = findings.filter((f) => f.verdict === 'not_proved').map((f) => f.domain);
  const noEvidence = findings.filter((f) => f.verdict === 'no_evidence_exists').map((f) => f.domain);

  return {
    ok: true,
    report: {
      reportId: input.reportId, asAt: input.asAt, preparedBy: input.preparedBy,
      findings, acceptances,
      proved, withDifferences, notProved, noEvidence,
      readyToSign: withDifferences === 0 && notProved.length === 0 && noEvidence.length === 0
        ? true
        : needsAcceptance.every((d) => acceptedFor.has(d)),
      detail: `${proved} of ${ALL_DOMAINS.length} domains proved against outside evidence, ${withDifferences} with differences, ${notProved.length} not proved, ${noEvidence.length} with nothing outside the old system that could check them`,
    },
    detail: `report ${input.reportId} built over all ${ALL_DOMAINS.length} domains`,
  };
}

export type SignRefusal =
  | 'report_not_ready'
  | 'signer_ran_the_extraction'
  | 'statement_explains_nothing';

export interface SignResult {
  readonly ok: boolean;
  readonly signatures: readonly Signature[];
  readonly refusedBecause?: SignRefusal;
  readonly detail: string;
}

/**
 * Sign the report.
 *
 * Signatures accumulate; nothing is ever replaced. A report signed and then rebuilt is a **new
 * report with a new id** — the signature belongs to the figures that were on the page when it was
 * given, and moving it to a later version would be signing something nobody read (hard rule #6).
 */
export function signVerificationReport(input: {
  readonly report: VerificationReport;
  readonly signatures?: readonly Signature[];
  readonly signedBy: string;
  readonly role: Signature['role'];
  readonly extractionOperator: string;
  readonly statement: string;
  readonly now: string;
}): SignResult {
  const existing = input.signatures ?? [];

  if (input.signedBy === input.extractionOperator) {
    return {
      ok: false, signatures: existing, refusedBecause: 'signer_ran_the_extraction',
      detail: `${input.signedBy} ran the extraction. Somebody who did not do the work signs that the work is right`,
    };
  }
  if (!input.report.readyToSign) {
    return {
      ok: false, signatures: existing, refusedBecause: 'report_not_ready',
      detail: `${input.report.reportId} has findings that are neither proved nor accepted. ${input.report.detail}`,
    };
  }
  if (looksLikeNoReason(input.statement)) {
    return {
      ok: false, signatures: existing, refusedBecause: 'statement_explains_nothing',
      detail: `"${input.statement.trim()}" records that a box was ticked, not what was checked`,
    };
  }

  return {
    ok: true,
    signatures: [...existing, {
      signedBy: input.signedBy, role: input.role, signedOn: input.now, statement: input.statement,
    }],
    detail: `${input.signedBy} signed ${input.report.reportId} as ${input.role.replace(/_/g, ' ')}`,
  };
}

const money = (minor?: number): string => {
  if (minor === undefined) return '—';
  const s = Math.abs(minor % 100).toString().padStart(2, '0');
  const whole = Math.trunc(Math.abs(minor) / 100).toString();
  // Indian grouping: last three, then pairs. 4,12,000 is twelve lakh, not four hundred thousand.
  const head = whole.slice(0, -3);
  const tail = whole.slice(-3);
  const grouped = head === '' ? tail : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
  return `${minor < 0 ? '-' : ''}₹${grouped}.${s}`;
};

/** `filed_gst_return` → "filed GST return". The reader is not reading identifiers. */
const readable = (source: ExternalSource): string =>
  source.replace(/_/g, ' ').replace(/\bgst\b/gi, 'GST').replace(/\bca\b/gi, "CA's");

const VERDICT_WORDS: Readonly<Record<DomainVerdict, string>> = {
  proved: '**Proved**',
  proved_with_differences: '**Proved, with differences**',
  not_proved: '**NOT PROVED**',
  no_evidence_exists: '**NOTHING CAN CHECK IT**',
};

/**
 * Render the report as the page the owner actually reads.
 *
 * Written for somebody who is not a programmer: what the figure is, what proved it, what that
 * proof does *not* cover, and what to do. The limits are in the table, not in an appendix.
 */
export function renderVerificationReport(
  report: VerificationReport,
  signatures: readonly Signature[] = [],
): string {
  const rows = report.findings.map((f) => {
    const source = f.provedBy === undefined || f.provedBy.length === 0
      ? '—' : f.provedBy.map(readable).join(', ');
    const figure = f.figureMinor !== undefined ? money(f.figureMinor) : f.figureLabel ?? '—';
    return `| ${f.domain} | ${figure} | ${VERDICT_WORDS[f.verdict]} | ${source} |`;
  });

  const limits = report.findings
    .filter((f) => f.whatItCannotProve.trim() !== '')
    .map((f) => `- **${f.domain}** — ${f.whatItCannotProve}`);

  const actions = report.findings
    .filter((f) => f.verdict !== 'proved')
    .map((f) => `- **${f.domain}** — ${f.ownerAction}`);

  const accepted = report.acceptances.map((a) =>
    `- **${a.domain}** — accepted by ${a.acceptedBy} on ${a.acceptedOn}: *"${a.reason}"*`);

  return [
    `# Opening figures — what proved each one`,
    ``,
    `**Report ${report.reportId}** · position as at **${report.asAt}** · prepared by ${report.preparedBy}`,
    ``,
    `Every figure below is going into the opening books. This page says what proved each one, and`,
    `what that proof does not cover. Nothing here rests on the old system's own word unless it says`,
    `so in the table.`,
    ``,
    `## The figures`,
    ``,
    `| What | Figure | Verdict | Proved against |`,
    `| --- | ---: | --- | --- |`,
    ...rows,
    ``,
    report.notProved.length === 0 && report.noEvidence.length === 0
      ? `Every domain was checked against a record kept outside the old system.`
      : `**${report.notProved.length + report.noEvidence.length} of ${report.findings.length} could not be proved.** They are in the table above, in the same type as the rest, because a report that lists only what passed is a report that hides its gaps.`,
    ``,
    `## What these proofs do NOT show`,
    ``,
    `Read this part. Each check has a real limit, and none of them is a formality.`,
    ``,
    ...limits,
    ``,
    ...(actions.length > 0 ? [`## What needs doing`, ``, ...actions, ``] : []),
    ...(accepted.length > 0
      ? [
        `## Exceptions the owner has accepted`,
        ``,
        `Each of these is a figure carried into the opening books **on the old system's word alone.**`,
        `Each was accepted on its own, by name, with a reason.`,
        ``,
        ...accepted,
        ``,
      ]
      : []),
    `## Signatures`,
    ``,
    signatures.length === 0
      ? `_Unsigned._ Whoever ran the extraction may not sign this.`
      : signatures.map((s) => `- **${s.signedBy}** (${s.role.replace(/_/g, ' ')}), ${s.signedOn} — *"${s.statement}"*`).join('\n'),
    ``,
    `---`,
    ``,
    `### Why each of these records is worth believing`,
    ``,
    ...[...new Set(report.findings.flatMap((f) => f.provedBy ?? []))].sort()
      .map((s) => `- **${readable(s)}** — ${EXTERNAL_SOURCE_NOTE[s]}`),
    ``,
    `_The full procedure is in \`docs/runbooks/legacy-self-extraction.md\`._`,
    ``,
  ].join('\n');
}
