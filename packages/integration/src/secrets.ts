// Managed secrets, rotation and usage monitoring (M32-FR-03 / SEC-04 / §19.1 / hard rule #4).
//
// **No secret ever exists in this module.** That is not a stylistic choice, it is the design:
// the types carry a *reference* to a value in a managed vault, and there is no field, no
// parameter and no return value anywhere here that could hold the value itself. A test reads
// the module's own exports and asserts that nothing named `value`, `plaintext` or `reveal`
// exists.
//
// The reason is the shape of every credential leak that has ever happened. Nobody commits a
// secret on purpose. They add a `password` field "temporarily", log a config object while
// debugging, or paste a working curl into an issue. Once a secret *can* be held in a variable,
// it will eventually be held in a log line — and a log line is copied into a ticket, a
// screenshot, a chat.
//
//   • **THE VAULT REFERENCE IS THE ONLY THING THAT TRAVELS.** `vault://payments/live#v4`,
//     never the key.
//   • **ROTATION OVERLAPS; REVOCATION DOES NOT.** A rotation leaves the old version valid for
//     a grace period, because a hard cut breaks every edge device that has not synced. A
//     **compromise** revokes immediately and accepts the breakage — that is the difference
//     between housekeeping and an incident.
//   • **AN UNROTATED SECRET IS REPORTED BY WHAT IT PROTECTS**, like an expired AMC in M26.
//     "Secret 14 is 400 days old" is ignored; "the live payment key has not been rotated in
//     400 days" is not.
//   • **UNUSUAL USAGE IS SURFACED, NEVER AUTO-BLOCKED.** Revoking a credential automatically
//     on a traffic spike is how a shop's payment integration dies during a sale.
//
// Pure and deterministic: the clock is injected, no I/O, and no secret material at any point.

export type SecretKind =
  | 'payment_provider'
  | 'gst_portal'
  | 'messaging_provider'
  | 'logistics_provider'
  | 'accounting_export'
  | 'webhook_signing'
  | 'service_identity';

export type SecretState = 'active' | 'rotating' | 'superseded' | 'revoked';

/**
 * A secret as this system ever sees one: a **reference**, an owner and some dates.
 * There is no field on this interface that could hold the value, by design.
 */
export interface SecretRef {
  readonly secretId: string;
  readonly tenantId?: string;
  readonly kind: SecretKind;
  /** e.g. "vault://payments/live#v4". The pointer, never the key. */
  readonly vaultRef: string;
  readonly version: number;
  readonly state: SecretState;
  readonly createdOn: string;
  /** Named person accountable for it. An unowned secret is nobody's job to rotate. */
  readonly owner: string;
  /** What stops working if this is wrong — the sentence that gets it rotated. */
  readonly protects: string;
  readonly lastRotatedOn?: string;
  readonly revokedOn?: string;
  /** Rotation interval in days. Per kind, per tenant policy. */
  readonly rotateEveryDays: number;
  readonly environment: 'sandbox' | 'production';
}

export type SecretFinding =
  | 'overdue_rotation'
  | 'rotation_due_soon'
  | 'no_owner'
  | 'never_rotated'
  | 'revoked_still_referenced'
  | 'sandbox_in_production';

export interface SecretIssue {
  readonly secretId: string;
  readonly kind: SecretKind;
  readonly finding: SecretFinding;
  readonly owner: string;
  readonly daysOverdue?: number;
  readonly blocking: boolean;
  readonly detail: string;
}

export interface SecretReview {
  readonly asAt: string;
  readonly reviewed: number;
  readonly issues: readonly SecretIssue[];
  readonly detail: string;
}

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * Review the secret inventory.
 *
 * Every finding is phrased **by what the secret protects**, the same discipline as an expired
 * AMC in M26: *"secret 14 is 400 days old"* gets scrolled past, and *"the live payment key has
 * not been rotated in 400 days"* does not.
 *
 * A **revoked secret still referenced by a live adapter** is the blocking one. That is not
 * hygiene — it is an integration that will fail at the worst moment, silently, because
 * everybody believes the rotation was completed.
 */
export function reviewSecrets(input: {
  readonly secrets: readonly SecretRef[];
  /** Vault refs a live adapter is currently configured with. */
  readonly referencedBy?: readonly { readonly adapterId: string; readonly vaultRef: string; readonly environment: 'sandbox' | 'production' }[];
  /** Days before the due date at which rotation is flagged. Default 14. */
  readonly warnWithinDays?: number;
  readonly asAt: string;
}): SecretReview {
  const warn = input.warnWithinDays ?? 14;
  const references = input.referencedBy ?? [];
  const issues: SecretIssue[] = [];

  for (const s of input.secrets) {
    const base = { secretId: s.secretId, kind: s.kind, owner: s.owner };

    if (s.owner.trim() === '') {
      issues.push({
        ...base,
        finding: 'no_owner',
        blocking: false,
        detail: `the ${s.kind.replace(/_/g, ' ')} secret protecting ${s.protects} has nobody's name against it — an unowned secret is nobody's job to rotate`,
      });
    }

    if (s.state === 'revoked') {
      const live = references.filter((r) => r.vaultRef === s.vaultRef);
      if (live.length > 0) {
        issues.push({
          ...base,
          finding: 'revoked_still_referenced',
          blocking: true,
          detail: `${s.vaultRef} is REVOKED and ${live.map((r) => r.adapterId).join(', ')} still point at it — ${s.protects} will fail at the worst moment while everybody believes the rotation was finished`,
        });
      }
      continue;
    }

    const since = s.lastRotatedOn ?? s.createdOn;
    const age = daysBetween(since, input.asAt);
    if (s.lastRotatedOn === undefined && age > s.rotateEveryDays) {
      issues.push({
        ...base,
        finding: 'never_rotated',
        daysOverdue: age - s.rotateEveryDays,
        blocking: false,
        detail: `the key protecting ${s.protects} has NEVER been rotated in ${age} day(s)`,
      });
    } else if (age > s.rotateEveryDays) {
      issues.push({
        ...base,
        finding: 'overdue_rotation',
        daysOverdue: age - s.rotateEveryDays,
        blocking: false,
        detail: `the key protecting ${s.protects} has not been rotated in ${age} day(s) against a ${s.rotateEveryDays}-day policy`,
      });
    } else if (s.rotateEveryDays - age <= warn) {
      issues.push({
        ...base,
        finding: 'rotation_due_soon',
        blocking: false,
        detail: `the key protecting ${s.protects} is due for rotation in ${s.rotateEveryDays - age} day(s)`,
      });
    }
  }

  // A sandbox credential wired into a production adapter (hard rule #7, again).
  for (const s of input.secrets.filter((x) => x.environment === 'sandbox')) {
    const inProduction = references.filter((r) => r.vaultRef === s.vaultRef && r.environment === 'production');
    if (inProduction.length > 0) {
      issues.push({
        secretId: s.secretId,
        kind: s.kind,
        owner: s.owner,
        finding: 'sandbox_in_production',
        blocking: true,
        detail: `${inProduction.map((r) => r.adapterId).join(', ')} run in PRODUCTION against a sandbox credential — ${s.protects} is not doing what anybody thinks it is`,
      });
    }
  }

  const blocking = issues.filter((i) => i.blocking);
  const order: Record<SecretFinding, number> = {
    revoked_still_referenced: 0, sandbox_in_production: 1, never_rotated: 2,
    overdue_rotation: 3, no_owner: 4, rotation_due_soon: 5,
  };

  return {
    asAt: input.asAt,
    reviewed: input.secrets.length,
    issues: issues.sort(
      (a, b) => order[a.finding] - order[b.finding] || (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0) || a.secretId.localeCompare(b.secretId),
    ),
    detail:
      issues.length === 0
        ? `all ${input.secrets.length} secret(s) owned, current and correctly wired`
        : blocking.length > 0
          ? `${blocking.length} secret(s) are wired wrongly and WILL fail: ${blocking.map((i) => i.secretId).join(', ')}; ${issues.length - blocking.length} other finding(s) behind them`
          : `${issues.length} secret(s) need rotating or owning`,
  };
}

export type RotationOutcome = 'rotated' | 'no_grace_on_rotation' | 'not_active' | 'same_ref';

export interface RotationResult {
  readonly secretId: string;
  readonly rotated: boolean;
  readonly outcome: RotationOutcome;
  /** The new version. The OLD one stays valid until the grace period ends. */
  readonly next?: SecretRef;
  readonly previous?: SecretRef;
  readonly oldValidUntil?: string;
  readonly detail: string;
}

/**
 * Rotate a secret — **with an overlap**.
 *
 * A hard cut is the version of rotation that takes a shop offline: an edge device that has not
 * synced is still presenting the previous key, and every one of them fails at once. So the old
 * version stays valid for a grace period and is marked `superseded` rather than revoked, which
 * is why rotation and revocation are **different functions** in this module rather than one
 * function with a flag.
 */
export function rotateSecret(input: {
  readonly secret: SecretRef;
  readonly newVaultRef: string;
  readonly rotatedBy: string;
  /** Days the previous version stays valid. Must be > 0 — a hard cut is `revokeSecret`. */
  readonly graceDays: number;
  readonly at: string;
}): RotationResult {
  const s = input.secret;

  if (s.state !== 'active' && s.state !== 'rotating') {
    return { secretId: s.secretId, rotated: false, outcome: 'not_active', detail: `this secret is ${s.state}` };
  }
  if (input.newVaultRef === s.vaultRef) {
    return { secretId: s.secretId, rotated: false, outcome: 'same_ref', detail: 'a rotation must point at a new vault version' };
  }
  if (input.graceDays <= 0) {
    return {
      secretId: s.secretId,
      rotated: false,
      outcome: 'no_grace_on_rotation',
      detail: 'a rotation with no overlap fails every edge device that has not synced — if this is a compromise, revoke it and accept the breakage deliberately',
    };
  }

  const oldValidUntil = new Date(Date.parse(input.at) + input.graceDays * DAY_MS).toISOString().slice(0, 10);

  return {
    secretId: s.secretId,
    rotated: true,
    outcome: 'rotated',
    oldValidUntil,
    previous: { ...s, state: 'superseded' },
    next: {
      ...s,
      vaultRef: input.newVaultRef,
      version: s.version + 1,
      state: 'active',
      lastRotatedOn: input.at.slice(0, 10),
    },
    detail: `rotated by ${input.rotatedBy} to version ${s.version + 1}; the previous version stays valid until ${oldValidUntil} so edge devices that have not synced keep working`,
  };
}

export interface RevocationResult {
  readonly secretId: string;
  readonly revoked: SecretRef;
  /** Adapters that will stop working the moment this takes effect. Named, before it happens. */
  readonly breaks: readonly string[];
  readonly detail: string;
}

/**
 * Revoke a secret **immediately**, with no overlap.
 *
 * This is the compromise path, and it deliberately does not soften. What it does instead is
 * **name what will break before it breaks** — which is the difference between a controlled
 * incident and a morning of people wondering why payments stopped.
 */
export function revokeSecret(input: {
  readonly secret: SecretRef;
  readonly reason: string;
  readonly revokedBy: string;
  readonly referencedBy?: readonly { readonly adapterId: string; readonly vaultRef: string }[];
  readonly at: string;
}): RevocationResult {
  const breaks = (input.referencedBy ?? [])
    .filter((r) => r.vaultRef === input.secret.vaultRef)
    .map((r) => r.adapterId)
    .sort();

  return {
    secretId: input.secret.secretId,
    revoked: { ...input.secret, state: 'revoked', revokedOn: input.at.slice(0, 10) },
    breaks,
    detail:
      breaks.length === 0
        ? `revoked by ${input.revokedBy}: ${input.reason}. Nothing is currently pointing at it`
        : `revoked by ${input.revokedBy}: ${input.reason}. ${breaks.join(', ')} STOP WORKING NOW — that is the cost of a compromise, and it is better paid knowingly`,
  };
}

export interface UsageWindow {
  readonly identityId: string;
  readonly api: string;
  readonly calls: number;
  readonly errors: number;
  readonly onDate: string;
}

export type UsageSignal = 'spike' | 'error_surge' | 'silent' | 'new_caller';

export interface UsageFinding {
  readonly identityId: string;
  readonly api: string;
  readonly signal: UsageSignal;
  /** Reported for a person to look at. NEVER auto-blocked. */
  readonly actionTaken: false;
  readonly detail: string;
}

/**
 * Surface unusual API usage.
 *
 * **Nothing here blocks anything** — `actionTaken` is typed as the literal `false`. Revoking a
 * credential automatically on a traffic spike is how a shop's payment integration dies in the
 * middle of a sale, and the spike is usually a promotion.
 *
 * `silent` matters as much as `spike`: an integration that stopped calling is an integration
 * that broke, and nobody reports the alert that never fires.
 */
export function findUsageSignals(input: {
  readonly current: readonly UsageWindow[];
  readonly baseline: readonly UsageWindow[];
  /** Multiple of baseline that counts as a spike, in basis points. Default 30,000 (3×). */
  readonly spikeBps?: number;
  /** Error share that counts as a surge, in basis points. Default 1,000 (10%). */
  readonly errorBps?: number;
}): readonly UsageFinding[] {
  const spike = input.spikeBps ?? 30_000;
  const errorLimit = input.errorBps ?? 1_000;
  const findings: UsageFinding[] = [];

  const key = (w: UsageWindow): string => `${w.identityId}|${w.api}`;
  const baseline = new Map<string, number>();
  for (const w of input.baseline) baseline.set(key(w), (baseline.get(key(w)) ?? 0) + w.calls);

  const current = new Map<string, { calls: number; errors: number }>();
  for (const w of input.current) {
    const seen = current.get(key(w)) ?? { calls: 0, errors: 0 };
    current.set(key(w), { calls: seen.calls + w.calls, errors: seen.errors + w.errors });
  }

  for (const [k, now] of [...current].sort(([a], [b]) => a.localeCompare(b))) {
    const [identityId = '', api = ''] = k.split('|');
    const before = baseline.get(k);

    if (before === undefined) {
      findings.push({
        identityId, api, signal: 'new_caller', actionTaken: false,
        detail: `${identityId} started calling ${api} — ${now.calls} call(s) where there was no history. Worth knowing who turned it on`,
      });
    } else if (before > 0 && Number((BigInt(now.calls) * 10_000n) / BigInt(before)) > spike) {
      findings.push({
        identityId, api, signal: 'spike', actionTaken: false,
        detail: `${identityId} called ${api} ${now.calls} times against a ${before} baseline — usually a promotion, occasionally a loop. Reported, NOT blocked: revoking on a spike kills a payment integration mid-sale`,
      });
    }

    if (now.calls > 0 && Number((BigInt(now.errors) * 10_000n) / BigInt(now.calls)) > errorLimit) {
      findings.push({
        identityId, api, signal: 'error_surge', actionTaken: false,
        detail: `${now.errors} of ${now.calls} calls to ${api} failed — something at one end changed`,
      });
    }
  }

  for (const [k, before] of [...baseline].sort(([a], [b]) => a.localeCompare(b))) {
    if (before > 0 && !current.has(k)) {
      const [identityId = '', api = ''] = k.split('|');
      findings.push({
        identityId, api, signal: 'silent', actionTaken: false,
        detail: `${identityId} used to call ${api} ${before} times and has now stopped — an integration that went quiet is an integration that broke, and nobody reports the alert that never fires`,
      });
    }
  }

  return findings;
}
