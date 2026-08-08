// API-11 Integration gateway — inbound signed webhooks (M32-FR-01 / §30 / §35). An unsigned webhook is
// an unauthenticated POST from the internet that changes money, and a correctly signed one replayed six
// hours later is the same thing with extra steps — so a delivery is verified on its SIGNATURE (the
// timestamp is inside it, which is what makes a replay detectable), its AGE, and its tenant. A BAD
// SIGNATURE is a security event; a DUPLICATE delivery id is a provider retry when our acknowledgement
// was lost and is deliberately NOT treated as an attack, because calling every retry an attack trains
// people to ignore the alerts. The rule is the pure `verifyWebhook` in `packages/integration`.
//
// NOTE: the internet-facing edge that terminates TLS and forwards the raw delivery is a deployment step;
// this is the internal verification surface, and the signature — not the caller's token — is what
// actually authenticates the provider. The signing key is an HMAC secret resolved from a vault ref (#4).

import { createHmac } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { verifyWebhook, type WebhookEnvelope } from '../../../packages/integration/src/index';
import type { Hasher } from '../../../packages/audit/src/audit-trail';

/** The keyed hasher the signature is computed with — HMAC-SHA256 over the material, hex. The secret is
 *  resolved from a vault ref at the composition root; it never appears in a payload or a log (#4). */
export function webhookHasher(secret: string): Hasher {
  return (material: string) => createHmac('sha256', secret).update(material).digest('hex');
}

/** A provider's webhook configuration — which vault-held key signs it, and how stale a delivery may be. */
export interface WebhookConfig {
  readonly provider: string;
  readonly signingKeyRef: string;
  readonly maxAgeSeconds?: number;
}

const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isDateTime = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
const isVaultRef = (s: unknown): s is string => typeof s === 'string' && /^vault:\/\//.test(s.trim());
const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export interface WebhookDeps {
  readonly config: (tenantId: string, provider: string) => Promise<WebhookConfig | undefined> | WebhookConfig | undefined;
  readonly seenDeliveryIds: (tenantId: string, provider: string) => Promise<readonly string[]> | readonly string[];
  readonly recordConfig: (tenantId: string, config: WebhookConfig) => Promise<void> | void;
  readonly recordDelivery: (tenantId: string, provider: string, envelope: WebhookEnvelope) => Promise<void> | void;
  readonly hasher: Hasher;
  readonly now: () => string;
}

export function webhookRoutes(deps: WebhookDeps): readonly Route[] {
  return [
    {
      // Register a provider's webhook — the vault-held signing key and how stale a delivery may be.
      api: 'API-11', method: 'POST', path: '/v1/integration/webhooks/:provider',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const provider = ctx.params['provider'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isVaultRef(b['signingKeyRef']) || (b['maxAgeSeconds'] !== undefined && !isPosInt(b['maxAgeSeconds']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_webhook',
            whatHappened: 'A webhook needs a vault:// signingKeyRef (never a literal key, hard rule #4) and an optional maxAgeSeconds.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "signingKeyRef": "vault://…" }. Nothing was configured.',
          });
        }
        const config: WebhookConfig = {
          provider, signingKeyRef: b['signingKeyRef'] as string,
          ...(isPosInt(b['maxAgeSeconds']) ? { maxAgeSeconds: b['maxAgeSeconds'] } : {}),
        };
        await deps.recordConfig(ctx.tenantId, config);
        return { status: 201, body: { provider, signingKeyRef: config.signingKeyRef } };
      },
    },
    {
      // Receive a delivery. Verified on signature (timestamp inside it), age and tenant. A bad signature
      // is a 401 security event; a stale one a 422; a duplicate a 200 provider-retry ack, NOT an attack.
      api: 'API-11', method: 'POST', path: '/v1/integration/webhooks/:provider/deliveries/:deliveryId',
      permission: 'integration.webhook.receive', idempotent: true,
      handler: async (ctx) => {
        const provider = ctx.params['provider'] ?? '';
        const deliveryId = ctx.params['deliveryId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['event']) || !isStr(b['tenantId']) || !isDateTime(b['sentAt']) || !isStr(b['signature'])) {
          throw apiError(400, { code: 'not_readable_as_a_delivery', whatHappened: 'A delivery needs an event, the tenantId it names, a sentAt timestamp and a signature.', wasItSaved: 'not_saved', nextSafeAction: 'Send the delivery fields. Nothing was accepted.' });
        }
        const config = await deps.config(ctx.tenantId, provider);
        if (config === undefined) throw notFound(`webhook provider ${provider}`);

        const envelope: WebhookEnvelope = {
          deliveryId, event: b['event'] as string, tenantId: b['tenantId'] as string,
          payload: b['payload'], sentAt: b['sentAt'] as string, signature: b['signature'] as string,
        };
        const check = verifyWebhook({
          envelope, tenantId: ctx.tenantId, signingKeyRef: config.signingKeyRef,
          seenDeliveryIds: await deps.seenDeliveryIds(ctx.tenantId, provider),
          hasher: deps.hasher, at: deps.now(),
          ...(config.maxAgeSeconds !== undefined ? { maxAgeSeconds: config.maxAgeSeconds } : {}),
        });

        if (check.verdict === 'bad_signature' || check.verdict === 'wrong_tenant') {
          throw apiError(401, { code: check.verdict, whatHappened: check.detail, wasItSaved: 'not_saved', nextSafeAction: 'The delivery was refused and recorded as a security event. Nothing was processed.' });
        }
        if (check.verdict === 'too_old') {
          throw apiError(422, { code: 'too_old', whatHappened: check.detail, wasItSaved: 'not_saved', nextSafeAction: 'The delivery is stale — a valid signature replayed later is a captured delivery. Nothing was processed.' });
        }
        if (check.verdict === 'replayed') {
          // A provider retry after a lost acknowledgement. Acknowledge idempotently; do not reprocess.
          return { status: 200, body: { deliveryId, verdict: 'replayed', accepted: false, detail: check.detail } };
        }
        await deps.recordDelivery(ctx.tenantId, provider, envelope);
        return { status: 200, body: { deliveryId, verdict: 'valid', accepted: true, event: envelope.event } };
      },
    },
    {
      // The delivery ids already processed for a provider — the ledger a replay is checked against.
      api: 'API-11', method: 'GET', path: '/v1/integration/webhooks/:provider/deliveries',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const provider = ctx.params['provider'] ?? '';
        if (await deps.config(ctx.tenantId, provider) === undefined) throw notFound(`webhook provider ${provider}`);
        const seen = await deps.seenDeliveryIds(ctx.tenantId, provider);
        return { status: 200, body: { provider, processed: seen, count: seen.length } };
      },
    },
  ];
}
