// A message provider's delivery report is the PROVIDER's word — proven, not asserted (PF-10 round 6 · M21-FR-01 ·
// M31-FR-03 · P-04 secure by design · hard rule #4).
//
// The audit found delivery callbacks accepted from any staff session holding a permission, matched on a predictable
// provider reference, with no signature: anyone at a desk could mark a message "delivered" (or "failed") that never
// was. Now a delivery report is believed only when ALL of these hold:
//
//   • a provider is CONFIGURED: the operator sets each provider's callback secret in the API's environment
//     (`DELIVERY_REPORT_SECRET__<PROVIDER>`, e.g. DELIVERY_REPORT_SECRET__ACME_SMS for provider `acme-sms`) — never in
//     the repository, an image or a log. With none, the route refuses (503): nothing is believed;
//   • it arrives through the PROVIDER RELAY — the internet-facing hop's own machine identity (role
//     `message_provider_relay`). A person's session — a cashier's, a manager's, the owner's — is refused, whatever they
//     hold;
//   • its SIGNATURE verifies: HMAC-SHA256, with that provider's secret, over the route path and the canonical body
//     (every field except the signature), compared in constant time;
//   • it is FRESH: its `sentAt` is within five minutes of head office's clock (a captured report replayed later is
//     refused), and a `reportId` already recorded from that provider is acknowledged as a replay, never recorded twice.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { stableStringify } from '../../kernel/src/index';

/** How far a report's `sentAt` may be from head office's clock, either way. */
export const DELIVERY_REPORT_MAX_SKEW_SECONDS = 300;

/** The environment variable prefix an operator sets a provider's callback secret under. */
export const DELIVERY_REPORT_SECRET_PREFIX = 'DELIVERY_REPORT_SECRET__';

/** The shortest secret accepted — a guessable secret is no signature. */
export const DELIVERY_REPORT_MIN_SECRET_LENGTH = 32;

/** Provider → callback secret, read from the API's environment at start. Problems are said, never silently dropped. */
export function deliveryReportSecretsFromEnv(env: Readonly<Record<string, string | undefined>>): { readonly secrets: ReadonlyMap<string, string>; readonly problems: readonly string[] } {
  const secrets = new Map<string, string>();
  const problems: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(DELIVERY_REPORT_SECRET_PREFIX) || v === undefined) continue;
    const provider = k.slice(DELIVERY_REPORT_SECRET_PREFIX.length).toLowerCase().replace(/_/g, '-');
    if (!/^[a-z0-9-]{2,64}$/.test(provider)) { problems.push(`${k}: not a provider name`); continue; }
    if (v.trim().length < DELIVERY_REPORT_MIN_SECRET_LENGTH) { problems.push(`${k}: shorter than ${DELIVERY_REPORT_MIN_SECRET_LENGTH} characters — refused`); continue; }
    secrets.set(provider, v.trim());
  }
  return { secrets, problems };
}

/** What the signature covers: the route path (so a report cannot be replayed onto another message) and the body. */
export function deliveryReportMaterial(path: string, body: Readonly<Record<string, unknown>>): string {
  const signed = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'signature'));
  return `${path}\n${stableStringify(signed)}`;
}

export type ReportCheck =
  | { readonly ok: true; readonly provider: string; readonly reportId: string; readonly sentAt: string }
  | { readonly ok: false; readonly status: 401 | 503; readonly code: string; readonly detail: string };

/** Verify a provider's signed report. Pure over its inputs (the secrets, the clock). */
export function verifyDeliveryReport(input: {
  readonly path: string;
  readonly body: unknown;
  readonly secrets: ReadonlyMap<string, string> | undefined;
  readonly now: string;
}): ReportCheck {
  if (input.secrets === undefined || input.secrets.size === 0) {
    return { ok: false, status: 503, code: 'no_delivery_provider_configured', detail: 'No message provider\'s callback secret is configured here, so no delivery report can be believed. Nothing was recorded' };
  }
  const b = (input.body !== null && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {}) as Record<string, unknown>;
  const provider = b['provider'];
  const signature = b['signature'];
  const sentAt = b['sentAt'];
  const reportId = b['reportId'];
  if (typeof signature !== 'string' || signature === '') {
    return { ok: false, status: 401, code: 'delivery_report_unsigned', detail: 'The report carries no provider signature — a delivery report is the provider\'s word, and an unsigned one is nobody\'s' };
  }
  if (typeof provider !== 'string' || typeof sentAt !== 'string' || Number.isNaN(Date.parse(sentAt)) || typeof reportId !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(reportId)) {
    return { ok: false, status: 401, code: 'delivery_report_not_attributable', detail: 'A signed report names its provider, its reportId and when it was sent (sentAt)' };
  }
  const secret = input.secrets.get(provider);
  if (secret === undefined) {
    return { ok: false, status: 401, code: 'unknown_provider', detail: `No callback secret is configured for provider "${provider}"` };
  }
  const expected = Buffer.from(createHmac('sha256', secret).update(deliveryReportMaterial(input.path, b)).digest('hex'), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  // Length first: timingSafeEqual throws on a length mismatch rather than answering false.
  if (given.length !== expected.length || !timingSafeEqual(expected, given)) {
    return { ok: false, status: 401, code: 'delivery_report_bad_signature', detail: 'The report\'s signature does not verify with the provider\'s secret — it was not sent by the provider, or it was changed on the way' };
  }
  const skew = Math.abs(Date.parse(input.now) - Date.parse(sentAt)) / 1000;
  if (skew > DELIVERY_REPORT_MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, code: 'delivery_report_stale', detail: `The report was sent at ${sentAt}, more than ${DELIVERY_REPORT_MAX_SKEW_SECONDS / 60} minutes from head office's clock — a captured report replayed later is refused` };
  }
  return { ok: true, provider, reportId, sentAt };
}
