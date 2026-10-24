// Consent records in and out, in the shape a DPDP consent manager keeps them (C8 · OB-324 · DPDP Act 2023 s.6(7)–(9) ·
// DPDP Rules 2025 Rule 4 and the First Schedule · P-06 · P-08 · hard rules #2 and #10).
//
// OB-324 (owner, 23 Oct 2026, in writing): build C8 — a consent export and import in the consent-manager format of the
// DPDP Rules.
//
// What the Rules fix, and what they do not. The First Schedule (Part B) says a consent manager keeps, for each data
// principal, a record of the consents GIVEN, DENIED or WITHDRAWN, the NOTICES that preceded or accompanied each request,
// and any SHARING with a transferee data fiduciary; gives the principal access to it; makes it available in a
// MACHINE-READABLE form; and keeps it at least SEVEN YEARS. The Rules do not publish a file layout. So this file's layout
// carries exactly those items, versioned (`sre-dpdp-consent-record/1`), and says plainly what this shop's ledger does not
// record (the notice's own text; sharing with another fiduciary) instead of leaving a blank that looks like "none".
//
//   • EXPORT is a read of the append-only consent ledger: one record per fact, in order, with a checksum over them.
//     A refusal on a principal's first ask is "denied"; a refusal after a grant is "withdrawn".
//   • IMPORT takes a consent manager's records for this shop and judges each against the ledger:
//       – a DENIAL or WITHDRAWAL is always recorded (the most restrictive answer applies at once — withdrawing is as
//         easy as giving, s.6(4));
//       – a GRANT is recorded only when it is newer than everything the shop holds for that purpose and channel; a grant
//         OLDER than a withdrawal the shop holds is NOT applied — it becomes a visible exception for a person (hard rule
//         #10: never a silent last-write-wins), and a grant the shop already reflects is counted, not repeated;
//       – the same consent-manager record sent twice is one fact (idempotent on its artefact id).
//
// Pure and deterministic: no clock, no I/O.

export const CONSENT_RECORD_FORMAT = 'sre-dpdp-consent-record/1';
export const CONSENT_RECORD_BASIS =
  'Digital Personal Data Protection Rules, 2025 — Rule 4 and the First Schedule, Part B: a record of consents given, denied or withdrawn and the notices behind them, available to the data principal in machine-readable form, kept at least seven years.';
/** The Rules' minimum retention for a consent manager's record (First Schedule, Part B). */
export const CONSENT_RECORD_MINIMUM_YEARS = 7;

export const CONSENT_PURPOSES = ['transactional', 'marketing', 'profiling', 'third_party', 'ai_personalisation'] as const;
export const CONSENT_CHANNELS = ['whatsapp', 'sms', 'email', 'push', 'post'] as const;
export type CmPurpose = (typeof CONSENT_PURPOSES)[number];
export type CmChannel = (typeof CONSENT_CHANNELS)[number];
export type CmAction = 'given' | 'denied' | 'withdrawn';

/** One fact on the shop's consent ledger, as the export reads it. */
export interface LedgerConsent {
  readonly eventId: string;
  readonly customerId: string;
  readonly purpose: string;
  readonly channel: string;
  readonly given: boolean;
  readonly recordedAt: string;
  readonly evidence: string;
}

export interface ConsentManagerRecord {
  readonly artefactId: string;
  readonly dataPrincipalRef: string;
  readonly purpose: CmPurpose;
  readonly channel: CmChannel;
  readonly action: CmAction;
  readonly at: string;
  /** How it was captured (the shop's ledger keeps this, not the notice's full text). */
  readonly evidence: string;
  /** The notice behind it, when known; null = not on record (said, never invented). */
  readonly noticeReference: string | null;
  /** Where the fact came from: this shop, or the consent manager it was imported from. */
  readonly capturedVia: string;
}

export interface ConsentRecordDocument {
  readonly format: typeof CONSENT_RECORD_FORMAT;
  readonly basis: string;
  readonly dataFiduciary: { readonly tenantId: string; readonly name: string };
  /** Present on an IMPORT: who sent it. */
  readonly consentManager?: { readonly id: string; readonly name: string };
  readonly scope: 'whole_shop' | { readonly dataPrincipalRef: string };
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly keepForAtLeastYears: number;
  readonly records: readonly ConsentManagerRecord[];
  readonly counts: { readonly records: number; readonly dataPrincipals: number; readonly given: number; readonly denied: number; readonly withdrawn: number };
  readonly notRecorded: readonly string[];
}

/** The evidence text an imported fact is recorded with — and how the export knows a fact came from a consent manager. */
export const importEvidence = (cmId: string, artefactId: string, notice: string | null): string =>
  `consent manager ${cmId} artefact ${artefactId}${notice === null ? '' : ` notice ${notice}`}`;
const IMPORTED = /^consent manager (\S+) artefact (\S+)(?: notice (\S+))?$/;

const order = (a: LedgerConsent, b: LedgerConsent): number => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0);

/** Build the export document from the ledger (one principal, or the whole shop). */
export function buildConsentExport(input: {
  readonly tenantId: string;
  readonly fiduciaryName: string;
  readonly ledger: readonly LedgerConsent[];
  readonly dataPrincipalRef?: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
}): ConsentRecordDocument {
  const facts = input.ledger.filter((f) => input.dataPrincipalRef === undefined || f.customerId === input.dataPrincipalRef);
  // Ledger order within each principal/purpose/channel (stable on equal times: the ledger's append order).
  const grouped = new Map<string, LedgerConsent[]>();
  for (const f of facts) {
    const k = `${f.customerId}\u0000${f.purpose}\u0000${f.channel}`;
    grouped.set(k, [...(grouped.get(k) ?? []), f]);
  }
  const records: ConsentManagerRecord[] = [];
  for (const list of grouped.values()) {
    let everGiven = false;
    for (const f of [...list].sort(order)) {
      const m = IMPORTED.exec(f.evidence);
      records.push({
        artefactId: m?.[2] ?? `sre:${f.eventId}`,
        dataPrincipalRef: f.customerId,
        purpose: f.purpose as CmPurpose,
        channel: f.channel as CmChannel,
        action: f.given ? 'given' : everGiven ? 'withdrawn' : 'denied',
        at: f.recordedAt,
        evidence: f.evidence,
        noticeReference: m?.[3] ?? null,
        capturedVia: m === null ? 'this shop' : `consent manager ${m[1]}`,
      });
      if (f.given) everGiven = true;
    }
  }
  records.sort((a, b) => a.dataPrincipalRef.localeCompare(b.dataPrincipalRef) || a.at.localeCompare(b.at) || a.purpose.localeCompare(b.purpose) || a.channel.localeCompare(b.channel));
  return {
    format: CONSENT_RECORD_FORMAT, basis: CONSENT_RECORD_BASIS,
    dataFiduciary: { tenantId: input.tenantId, name: input.fiduciaryName },
    scope: input.dataPrincipalRef === undefined ? 'whole_shop' : { dataPrincipalRef: input.dataPrincipalRef },
    generatedAt: input.generatedAt, generatedBy: input.generatedBy, keepForAtLeastYears: CONSENT_RECORD_MINIMUM_YEARS,
    records,
    counts: {
      records: records.length, dataPrincipals: new Set(records.map((r) => r.dataPrincipalRef)).size,
      given: records.filter((r) => r.action === 'given').length, denied: records.filter((r) => r.action === 'denied').length,
      withdrawn: records.filter((r) => r.action === 'withdrawn').length,
    },
    notRecorded: [
      'the full text of each notice: the shop\'s ledger records how each consent was captured; a notice reference is given only when a consent manager sent one',
      'sharing with a transferee data fiduciary: the consent ledger does not record it',
    ],
  };
}

export type ImportRefusal = 'not_a_consent_record_document' | 'no_consent_manager_named' | 'wrong_shop' | 'bad_record';

/** Read an incoming document. Refuses the whole document on any unreadable record — never half an import. */
export function readConsentImport(raw: unknown, expect: { readonly tenantId: string; readonly now: string }):
  | { readonly ok: true; readonly consentManager: { readonly id: string; readonly name: string }; readonly records: readonly Omit<ConsentManagerRecord, 'evidence' | 'capturedVia'>[] }
  | { readonly ok: false; readonly reason: ImportRefusal; readonly detail: string } {
  const r = raw as Partial<ConsentRecordDocument> | null;
  if (r === null || typeof r !== 'object' || r.format !== CONSENT_RECORD_FORMAT || !Array.isArray(r.records)) {
    return { ok: false, reason: 'not_a_consent_record_document', detail: `this is not a ${CONSENT_RECORD_FORMAT} document` };
  }
  const cm = r.consentManager;
  if (cm === undefined || typeof cm.id !== 'string' || !/^[A-Za-z0-9._:-]{2,64}$/.test(cm.id) || typeof cm.name !== 'string' || cm.name.trim() === '') {
    return { ok: false, reason: 'no_consent_manager_named', detail: 'an import must name the consent manager it came from (its registration id and name)' };
  }
  if (r.dataFiduciary?.tenantId !== expect.tenantId) {
    return { ok: false, reason: 'wrong_shop', detail: 'the document is addressed to another data fiduciary — nothing is imported' };
  }
  const out: Omit<ConsentManagerRecord, 'evidence' | 'capturedVia'>[] = [];
  for (const [i, x] of (r.records as unknown[]).entries()) {
    const v = x as Partial<ConsentManagerRecord> | null;
    const ok = v !== null && typeof v === 'object'
      && typeof v.artefactId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v.artefactId)
      && typeof v.dataPrincipalRef === 'string' && v.dataPrincipalRef.trim() !== ''
      && (CONSENT_PURPOSES as readonly string[]).includes(v.purpose as string)
      && (CONSENT_CHANNELS as readonly string[]).includes(v.channel as string)
      && (v.action === 'given' || v.action === 'denied' || v.action === 'withdrawn')
      && typeof v.at === 'string' && !Number.isNaN(Date.parse(v.at)) && v.at <= expect.now
      && (v.noticeReference === undefined || v.noticeReference === null || (typeof v.noticeReference === 'string' && /^\S{1,128}$/.test(v.noticeReference)));
    if (!ok) return { ok: false, reason: 'bad_record', detail: `record ${i + 1} is not readable (artefactId, dataPrincipalRef, a known purpose and channel, given/denied/withdrawn, and a time not in the future) — nothing is imported` };
    out.push({ artefactId: v.artefactId!, dataPrincipalRef: v.dataPrincipalRef!.trim(), purpose: v.purpose!, channel: v.channel!, action: v.action!, at: new Date(v.at!).toISOString(), noticeReference: v.noticeReference ?? null });
  }
  return { ok: true, consentManager: { id: cm.id, name: cm.name.trim() }, records: out };
}

export type ImportJudgement =
  | { readonly kind: 'apply'; readonly given: boolean }
  | { readonly kind: 'already_reflected' }
  | { readonly kind: 'already_imported' }
  | { readonly kind: 'exception'; readonly detail: string };

/** Judge one imported record against the shop's ledger for that principal (most restrictive; conflicts surfaced). */
export function judgeImport(rec: Omit<ConsentManagerRecord, 'evidence' | 'capturedVia'>, cmId: string, ledger: readonly LedgerConsent[]): ImportJudgement {
  const evidence = importEvidence(cmId, rec.artefactId, rec.noticeReference);
  const mine = ledger.filter((f) => f.customerId === rec.dataPrincipalRef && f.purpose === rec.purpose && f.channel === rec.channel);
  if (mine.some((f) => f.evidence === evidence)) return { kind: 'already_imported' };
  if (rec.action !== 'given') return { kind: 'apply', given: false };
  const latest = [...mine].sort(order).at(-1);
  if (latest === undefined || rec.at > latest.recordedAt) return { kind: 'apply', given: true };
  if (latest.given) return { kind: 'already_reflected' };
  return {
    kind: 'exception',
    detail: `the consent manager says ${rec.dataPrincipalRef} GAVE ${rec.purpose} consent on ${rec.channel} at ${rec.at}, but the shop holds a later withdrawal (${latest.recordedAt}: ${latest.evidence}) — not applied; a person checks with the customer`,
  };
}
