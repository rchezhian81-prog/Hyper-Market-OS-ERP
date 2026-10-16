// C7 (v2.1 addendum · M02/M34/M35 · DPDP Act 2023 s.8(5)) — reasonable security safeguards, made checkable.
//
// Two promises, each turned into a check that can fail:
//
//   1. **Every personal-data field is encrypted or masked.** The shop declares, field by field, where personal data is
//      held and how it is protected: SEALED under the person's own key in the ledger (ADR-0025, crypto-shredding),
//      MASKED wherever it is shown, never kept at all (read for one request and gone), or held by the identity server
//      and not by this system. A field declared "sealed" that the sealing policy does not actually seal is a FALSE
//      claim and is a finding; a field with no protection is a finding. The check is only as good as the declaration,
//      so the guardrail (`tests/guardrails/personal-data-is-sealed-or-masked.test.ts`) holds the declaration to the
//      code: every personal-data-shaped field in the source must be declared.
//
//   2. **Security logs are kept at least one year.** Sign-in events (the identity server's), administrator events, and
//      the system's own tamper-evident audit trail: each must be switched on, and kept ≥ 365 days (or with no expiry at
//      all). A log that is off or expires sooner is a finding.
//
// Both are pure: the declaration, the policy and the log settings are passed in.

/** How a personal-data field is protected. */
export type PiiProtection =
  /** Written encrypted under the subject's own data key (ADR-0025); erasure destroys the key. */
  | 'sealed_per_subject'
  /** Kept, but every place it is shown masks it (only the last few characters, never the whole). */
  | 'masked_on_read'
  /** Read for one request and never written anywhere (a computed check, a generated file handed back). */
  | 'not_kept'
  /** Held by the identity server, which this system only reads from a signed token; never written here. */
  | 'held_by_identity_server'
  /** Not a person's data at all (the shop's own phone number on its receipt). */
  | 'not_personal'
  /** No protection. Always a finding. */
  | 'unprotected';

export interface PiiFieldDeclaration {
  /** The source file the field is declared in, repository-relative. */
  readonly file: string;
  readonly field: string;
  /** Whose data it is. */
  readonly whose: 'customer' | 'staff' | 'supplier_contact' | 'user' | 'shop';
  readonly protection: PiiProtection;
  /**
   * For `sealed_per_subject`: the event type whose policy seals it. For `masked_on_read`: the masking function. For the
   * rest: one line saying why — the evidence a reviewer checks.
   */
  readonly evidence: string;
  /** For `unprotected` only: the open owner decision it waits on — an unprotected field is never silent. */
  readonly awaitingDecision?: string;
}

/** The sealing policy as the check reads it: event type → the fields its rules seal. */
export type SealedFieldsByEvent = Readonly<Record<string, readonly { readonly fields: readonly string[] }[]>>;

export type PiiSafeguardFlag = 'unprotected' | 'claimed_sealed_but_not_sealed' | 'masked_without_a_masker';

export interface PiiSafeguardFinding {
  readonly flag: PiiSafeguardFlag;
  readonly file: string;
  readonly field: string;
  readonly detail: string;
}

export interface PiiSafeguardReport {
  readonly compliant: boolean;
  readonly declared: number;
  readonly byProtection: Readonly<Record<PiiProtection, number>>;
  readonly findings: readonly PiiSafeguardFinding[];
  readonly detail: string;
}

/**
 * Assess the declaration against the sealing policy and the maskers that exist. `maskers` is the set of masking
 * function names actually exported by the code (the guardrail passes them from the real modules).
 */
export function assessPiiSafeguards(input: {
  readonly declarations: readonly PiiFieldDeclaration[];
  readonly sealingPolicy: SealedFieldsByEvent;
  readonly maskers: readonly string[];
}): PiiSafeguardReport {
  const findings: PiiSafeguardFinding[] = [];
  const by: Record<PiiProtection, number> = {
    sealed_per_subject: 0, masked_on_read: 0, not_kept: 0, held_by_identity_server: 0, not_personal: 0, unprotected: 0,
  };
  for (const d of input.declarations) {
    by[d.protection] += 1;
    if (d.protection === 'unprotected') {
      findings.push({
        flag: 'unprotected', file: d.file, field: d.field,
        detail: `${d.field} in ${d.file} (${d.whose}) is personal data kept with no encryption or masking${d.awaitingDecision === undefined ? '' : ` — waiting on ${d.awaitingDecision}`}`,
      });
    } else if (d.protection === 'sealed_per_subject') {
      const sealed = (input.sealingPolicy[d.evidence] ?? []).some((r) => r.fields.includes(d.field));
      if (!sealed) {
        findings.push({
          flag: 'claimed_sealed_but_not_sealed', file: d.file, field: d.field,
          detail: `${d.field} in ${d.file} is declared sealed under ${d.evidence}, but the sealing policy does not seal it there — the claim is false`,
        });
      }
    } else if (d.protection === 'masked_on_read' && !input.maskers.includes(d.evidence)) {
      findings.push({
        flag: 'masked_without_a_masker', file: d.file, field: d.field,
        detail: `${d.field} in ${d.file} is declared masked by ${d.evidence}, which is not a masking function the code exports`,
      });
    }
  }
  const compliant = findings.length === 0;
  return {
    compliant,
    declared: input.declarations.length,
    byProtection: by,
    findings,
    detail: compliant
      ? `${input.declarations.length} personal-data field(s) declared; every one is sealed, masked, never kept, or held by the identity server`
      : `${findings.length} personal-data field(s) are not protected as declared`,
  };
}

/** One year, the floor the addendum sets for security logs (C7). */
export const SECURITY_LOG_MINIMUM_DAYS = 365;

/** A security log and how it is kept. */
export interface SecurityLogSource {
  readonly logId: string;
  readonly kind: 'sign_in_events' | 'admin_events' | 'audit_trail';
  readonly enabled: boolean;
  /** Days kept; `'forever'` for a log nothing ever expires. */
  readonly retentionDays: number | 'forever';
}

export interface SecurityLogFinding {
  readonly logId: string;
  readonly flag: 'not_enabled' | 'kept_less_than_a_year';
  readonly detail: string;
}

/** Assess the security logs: each on, and kept ≥ 1 year. A sign-in log and an audit trail must both exist. */
export function assessSecurityLogRetention(sources: readonly SecurityLogSource[]): {
  readonly compliant: boolean;
  readonly findings: readonly SecurityLogFinding[];
  readonly detail: string;
} {
  const findings: SecurityLogFinding[] = [];
  for (const s of sources) {
    if (!s.enabled) {
      findings.push({ logId: s.logId, flag: 'not_enabled', detail: `${s.logId} (${s.kind.replace(/_/g, ' ')}) is switched off — nothing is being kept` });
      continue;
    }
    if (s.retentionDays !== 'forever' && !(s.retentionDays >= SECURITY_LOG_MINIMUM_DAYS)) {
      findings.push({ logId: s.logId, flag: 'kept_less_than_a_year', detail: `${s.logId} keeps ${s.retentionDays} day(s); security logs are kept at least ${SECURITY_LOG_MINIMUM_DAYS}` });
    }
  }
  const kinds = new Set(sources.filter((s) => s.enabled).map((s) => s.kind));
  for (const k of ['sign_in_events', 'audit_trail'] as const) {
    if (!kinds.has(k)) findings.push({ logId: k, flag: 'not_enabled', detail: `no ${k.replace(/_/g, ' ')} log is kept at all` });
  }
  return {
    compliant: findings.length === 0,
    findings,
    detail: findings.length === 0
      ? `${sources.length} security log(s): every one on and kept at least ${SECURITY_LOG_MINIMUM_DAYS} days`
      : findings.map((f) => f.detail).join('; '),
  };
}

/**
 * Read an identity-server realm file (Keycloak's realm representation) for its sign-in and administrator event logs.
 * `eventsExpiration` is in seconds; absent means the server keeps events with no expiry.
 */
export function realmSecurityLogs(realmName: string, realm: Readonly<Record<string, unknown>>): readonly SecurityLogSource[] {
  const expiry = realm['eventsExpiration'];
  const days: number | 'forever' = typeof expiry === 'number' ? Math.floor(expiry / 86_400) : 'forever';
  return [
    { logId: `${realmName}:sign-in-events`, kind: 'sign_in_events', enabled: realm['eventsEnabled'] === true, retentionDays: days },
    // Administrator events carry no expiry in the realm representation: kept until removed by an administrator.
    { logId: `${realmName}:admin-events`, kind: 'admin_events', enabled: realm['adminEventsEnabled'] === true, retentionDays: 'forever' },
  ];
}
