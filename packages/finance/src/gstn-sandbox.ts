// A deterministic SANDBOX GSTN return-filing provider (owner directive item 1). The submission-safety
// engine (gstr1-submission.ts) defines the lifecycle; this is the in-repo implementation of the portal
// itself, so the whole preview → approve → submit → acknowledge loop can be driven end to end WITHOUT a
// live, credentialed GSTN connection. Production points the same `GstnReturnProvider` port at a certified
// GSP whose credentials come from a vault (hard rule #4); a live filing additionally needs the portal
// switched on (portal-switch kill-switch) and CA/legal confirmation.
//
// Two disciplines, because a fake that lies is worse than no fake:
//   • **Its output is unmistakably a sandbox.** The acknowledgement reference (ARN) is prefixed `SANDBOX-`
//     and is a hash of the return's identity, never a reference the government issued — it can never be
//     mistaken for a real filing.
//   • **It is deterministic and pure.** The ARN is `sha256(gstin|period|type|digest)`, so the same return
//     always yields the same ARN (idempotency + duplicate detection are real); no clock, no randomness.

import { createHash } from 'node:crypto';
import { classifyGstnError, type GstnErrorClass } from './gstr1-submission';

export interface GstnReturnRequest {
  /** The supplier's own GSTIN. */
  readonly gstin: string;
  /** The filing period, MMYYYY. */
  readonly period: string;
  readonly returnType: 'GSTR1';
  /** The digest of the exact figures being filed (what the maker previewed and the checker approved). */
  readonly returnDigest: string;
}

export type GstnSubmitStatus = 'acknowledged' | 'failed' | 'unknown';

export interface GstnSubmitResult {
  readonly status: GstnSubmitStatus;
  /** Present when acknowledged — the portal reference (ARN). Sandbox ARNs are `SANDBOX-`-prefixed. */
  readonly arn?: string;
  /** Present when failed — the raw portal error code. */
  readonly errorCode?: string;
  /** Present when failed — the classified recovery class. */
  readonly errorClass?: GstnErrorClass;
  readonly detail: string;
}

/**
 * The provider-neutral GSTN return-filing port. A real certified-GSP connector and this sandbox implement
 * the SAME shape, so the route handling (acknowledge / mark failed / mark unknown, never fabricating an ARN)
 * is identical whichever is plugged in.
 */
export interface GstnReturnProvider {
  submit(request: GstnReturnRequest): GstnSubmitResult | Promise<GstnSubmitResult>;
}

/** A synchronous, deterministic sandbox provider — callers can read the answer directly (no `await`). */
export interface SandboxGstnProvider extends GstnReturnProvider {
  submit(request: GstnReturnRequest): GstnSubmitResult;
}

export interface SandboxGstnOptions {
  /**
   * Force every call to this outcome — for exercising the failed (rejection) and unknown (timeout/outage)
   * paths a real portal produces. Omit for the natural behaviour (acknowledge, then duplicate on a repeat).
   */
  readonly forceOutcome?: GstnSubmitStatus;
  /** The raw error code returned when `forceOutcome === 'failed'` (classified via `classifyGstnError`). */
  readonly failCode?: string;
  /** The reason surfaced when `forceOutcome === 'unknown'` (a simulated timeout/outage). */
  readonly unknownReason?: string;
}

/** The idempotency basis the portal keys a return on: supplier GSTIN + type + period. */
export function sandboxReturnKey(request: GstnReturnRequest): string {
  return `${request.gstin}|${request.returnType}|${request.period}`;
}

/** The deterministic, unmistakably-sandbox ARN for a return — `SANDBOX-` + sha256 slice (never a real ARN). */
export function sandboxArn(request: GstnReturnRequest): string {
  const h = createHash('sha256').update(`${sandboxReturnKey(request)}|${request.returnDigest}`).digest('hex');
  return `SANDBOX-${h.slice(0, 15).toUpperCase()}`;
}

/**
 * A provider-neutral sandbox GSTN portal. `submit` returns a deterministic result: the first filing of a
 * (gstin, period) return is `acknowledged` with a hash-derived `SANDBOX-` ARN; a repeat of the SAME return
 * is `failed` with a `DUPLICATE_RETURN` code (the portal's real duplicate rejection — the engine also
 * prevents this upstream). `forceOutcome` overrides everything to exercise the failed/unknown branches.
 * Stateful only in remembering which returns it has seen — which is what makes duplicate detection real.
 * Never contacts a network.
 */
export function sandboxGstnProvider(options: SandboxGstnOptions = {}): SandboxGstnProvider {
  const seen = new Set<string>();
  return {
    submit(request: GstnReturnRequest): GstnSubmitResult {
      if (options.forceOutcome === 'unknown') {
        return { status: 'unknown', detail: options.unknownReason ?? 'sandbox: simulated portal timeout — the outcome is UNKNOWN until reconciled' };
      }
      if (options.forceOutcome === 'failed') {
        const code = options.failCode ?? 'RET_VALIDATION_ERROR';
        return { status: 'failed', errorCode: code, errorClass: classifyGstnError(code), detail: `sandbox: simulated portal rejection (${code})` };
      }
      const key = sandboxReturnKey(request);
      if (seen.has(key)) {
        return { status: 'failed', errorCode: 'DUPLICATE_RETURN', errorClass: classifyGstnError('DUPLICATE_RETURN'), detail: 'sandbox: this return is already filed for the period — reconcile, do not re-file' };
      }
      seen.add(key);
      return { status: 'acknowledged', arn: sandboxArn(request), detail: `sandbox: acknowledged (non-fileable reference ${sandboxArn(request)})` };
    },
  };
}
