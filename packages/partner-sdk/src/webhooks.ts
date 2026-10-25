// Receiving SRE's signed webhooks (M36-FR-04 · M32-FR-01 · §30.1 "signed webhooks with replay protection" · D14-FR-06).
//
// Head office delivers each subscribed business event to the partner's https endpoint with three headers:
//   x-sre-webhook-id         the message id — the partner's idempotency key (the same event is always the same id)
//   x-sre-webhook-timestamp  when it was signed
//   x-sre-webhook-signature  v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
// and `x-sre-api-version: v1`. This is the partner's side of that contract: verify the signature over the EXACT bytes
// received, refuse a stale timestamp (a replay), refuse another API major, and hand back the typed envelope. The secret
// is the partner's own copy of the subscription's signing secret — never sent anywhere by this code.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { API_VERSION } from './client';

export interface WebhookEnvelope<T = unknown> {
  readonly id: string;
  readonly apiVersion: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly data: T;
}

export type WebhookVerdict<T = unknown> =
  | { readonly ok: true; readonly messageId: string; readonly event: WebhookEnvelope<T> }
  | { readonly ok: false; readonly reason: 'missing_headers' | 'bad_signature' | 'stale' | 'wrong_api_version' | 'not_an_event' | 'id_mismatch' };

const header = (headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined => {
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name);
  return hit?.[1];
};

/**
 * Verify one delivery. `rawBody` must be the body exactly as received (verify before parsing). `toleranceSeconds`
 * (default 300) bounds how old a signed timestamp may be: an older one is a replay and is refused.
 */
export function verifyWebhook<T = unknown>(input: {
  readonly secret: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
  readonly nowMs: number;
  readonly toleranceSeconds?: number;
}): WebhookVerdict<T> {
  const id = header(input.headers, 'x-sre-webhook-id');
  const ts = header(input.headers, 'x-sre-webhook-timestamp');
  const sig = header(input.headers, 'x-sre-webhook-signature');
  const version = header(input.headers, 'x-sre-api-version');
  if (id === undefined || ts === undefined || sig === undefined || version === undefined) return { ok: false, reason: 'missing_headers' };
  const expected = Buffer.from(`v1=${createHmac('sha256', input.secret).update(`${ts}.${input.rawBody}`).digest('hex')}`);
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  const age = Math.abs(input.nowMs - Date.parse(ts)) / 1000;
  if (!Number.isFinite(age) || age > (input.toleranceSeconds ?? 300)) return { ok: false, reason: 'stale' };
  if (version !== API_VERSION) return { ok: false, reason: 'wrong_api_version' };
  let event: WebhookEnvelope<T>;
  try { event = JSON.parse(input.rawBody) as WebhookEnvelope<T>; } catch { return { ok: false, reason: 'not_an_event' }; }
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string' || typeof event.id !== 'string') return { ok: false, reason: 'not_an_event' };
  if (event.apiVersion !== API_VERSION) return { ok: false, reason: 'wrong_api_version' };
  if (event.id !== id) return { ok: false, reason: 'id_mismatch' };
  return { ok: true, messageId: id, event };
}
