// @sre/partner-sdk — the versioned partner SDK (M36-FR-04 · D14-FR-06 · R8-2). Version 1.0.0 speaks API v1.
//
// Uses only what already exists: the published API (read through its own manifest) and the signed outbound webhooks.
// It never mints a token. See README.md beside this folder.

export {
  SDK_VERSION, API_VERSION, PartnerApiError, createPartnerClient, matchesTemplate,
  type PartnerClient, type PartnerClientOptions, type Intent, type Manifest, type ManifestRoute, type SavedState, type Method,
} from './client';
export { verifyWebhook, type WebhookEnvelope, type WebhookVerdict } from './webhooks';
