# @sre/partner-sdk 1.0.0 (API v1)

The partner SDK for SRE Retail OS (M36-FR-04). It uses only the API and the signed webhooks that already exist. It never makes a token.

## What a partner gets

1. **A sandbox tenant and a credential.** SRE's administrator issues both, out of band. A sandbox credential reaches only the sandbox (hard rule #7).
2. **A client** that knows the published surface. It reads `GET /v1/platform/api-manifest` once. Anything not listed there is refused on the partner's own machine, and nothing is sent.
3. **Writes as intents.** You make an intent once, when your system decides to act. It keeps the same `Idempotency-Key` on every retry, so a timeout followed by a resend is still one effect. Only endpoints the manifest marks idempotent can be sent.
4. **Webhook verification.** `verifyWebhook` checks `x-sre-webhook-signature` (`v1=` HMAC-SHA256 of `"<timestamp>.<body>"`). It refuses a stale timestamp (a replay), refuses another API version, and returns the typed envelope. The message id is your idempotency key.
5. **Reconciliation.** `reconcile(subscriptionId, from)` returns everything head office sent since a time, so you can compare it with what you received.

```ts
import { createPartnerClient, verifyWebhook } from '@sre/partner-sdk';

const sre = createPartnerClient({ baseUrl: 'https://api.example.test', accessToken: () => myCredential.token });
const intent = sre.intend('POST', '/v1/platform/devices/till-9/register', { branchId: 'S1', kind: 'pos_lane', label: 'Lane 9' });
await saveToMyOutbox(intent);   // keep it: resend the SAME intent until it is answered
await sre.send(intent);
```

## Errors

A refusal arrives as `PartnerApiError`, with the API's own words: `code`, `whatHappened`, `wasItSaved` (`saved` / `not_saved` / `unknown`) and `nextSafeAction`. A refusal the SDK makes before sending anything has `status` 0 and `wasItSaved: not_saved`.

## Versions

- The SDK version follows semver. API v1 changes only by adding things (P-06).
- A released endpoint or event is removed only after a dated deprecation of at least 180 days. `tests/guardrails/an-upgrade-never-breaks-a-live-shop.test.ts` checks this against `docs/api/released-contract.json`.
- The machine-readable contracts are `docs/api/openapi.json` (endpoints) and `docs/api/asyncapi.json` (events and webhooks).
