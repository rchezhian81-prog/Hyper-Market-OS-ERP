// Step-up re-authentication — the API-tier freshness/strength check for sensitive actions
// (SEC-03, M02-FR-01; closes GAP-SEC-06). §28 sensitive operations — a privilege grant, an
// irreversible data erasure — must be backed by a RECENT re-authentication (and, where declared, a
// specific factor such as MFA). Until now that check lived only in the browser session layer, so a
// direct API call could bypass it (GAP-SEC-06). This is the pure decision the kernel pipeline runs
// at the boundary, over evidence taken from the SIGNED token (`auth_time` / `amr`) and nothing the
// caller can assert in the request body.
//
// Pure and deterministic: no I/O, no DOM, the clock is passed in. The pipeline supplies `nowMs`.

/**
 * What a route demands of a recent re-authentication.
 * - `withinSeconds`: the login/re-auth must be no older than this (the "recent" in "recent MFA").
 * - `amr`: authentication methods that must ALL be present (e.g. `['mfa']`). Absent → freshness only.
 */
export interface ReauthRequirement {
  readonly withinSeconds: number;
  readonly amr?: readonly string[];
}

/** The re-auth evidence carried by the signed token: when the person last authenticated, and how. */
export interface ReauthEvidence {
  /** `auth_time` (epoch seconds) — when the person authenticated, distinct from token issuance. */
  readonly authTime?: number;
  /** `amr` — the authentication methods the IdP recorded for that authentication. */
  readonly amr?: readonly string[];
}

/** Why a step-up check failed. Distinct reasons so the audit and the person both know which it was. */
export type ReauthShortfall = 'no_reauth_evidence' | 'reauth_factor_insufficient' | 'reauth_expired';

export interface ReauthDecision {
  readonly ok: boolean;
  readonly shortfall?: ReauthShortfall;
  readonly detail?: string;
}

/**
 * Decide whether the evidence satisfies the requirement, as of `nowMs`.
 *
 * Order is deliberate: **presence, then factor, then freshness.** A missing `auth_time` is "no
 * re-auth at all" (the bypass GAP-SEC-06 is about); a present-but-weak `amr` is "authenticated, but
 * not strongly enough"; a present-and-strong-but-old one is "you did re-auth, but too long ago". Each
 * is refused, and each names its own reason so the refusal is honest rather than a blanket 403.
 *
 * A future `authTime` (clock skew) is treated as fresh, never as an error — the check refuses stale
 * evidence, it does not police clocks.
 */
export function evaluateStepUp(
  requirement: ReauthRequirement,
  evidence: ReauthEvidence,
  nowMs: number,
): ReauthDecision {
  if (evidence.authTime === undefined) {
    return {
      ok: false,
      shortfall: 'no_reauth_evidence',
      detail: 'the sign-in carries no auth_time, so there is no recent re-authentication to rely on',
    };
  }

  if (requirement.amr !== undefined && requirement.amr.length > 0) {
    const have = new Set(evidence.amr ?? []);
    const missing = requirement.amr.filter((method) => !have.has(method));
    if (missing.length > 0) {
      return {
        ok: false,
        shortfall: 'reauth_factor_insufficient',
        detail: `the sign-in is missing required authentication method(s): ${missing.join(', ')}`,
      };
    }
  }

  const ageSeconds = Math.floor(nowMs / 1000) - evidence.authTime;
  if (ageSeconds > requirement.withinSeconds) {
    return {
      ok: false,
      shortfall: 'reauth_expired',
      detail: `the re-authentication is ${ageSeconds}s old and the window for this action is ${requirement.withinSeconds}s`,
    };
  }

  return { ok: true };
}
