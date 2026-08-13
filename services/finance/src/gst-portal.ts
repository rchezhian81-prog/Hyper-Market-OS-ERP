// API-09 GST government-portal switch (owner directive §2/§6) — the decision surface for the feature flag +
// kill switch that keeps the LIVE e-invoice (IRP) and e-way-bill portal integrations OFF by default and
// killable instantly. On the tested `packages/e-invoice` portal-switch engine.
//
//   • `POST /v1/finance/gst-portal/gate` — given the tenant's controls (enabled? killed?) and the channel
//     (e_invoice / e_way_bill), may a LIVE portal call proceed? Returns canGoLive + a plain-English reason.
//
// This is the gate a deployment consults immediately before invoking the real GSP/portal connector (the
// EInvoiceProvider / EwayBillProvider port); the two flags live in per-tenant versioned config (M01-FR-03).
// The SANDBOX routes are exempt — they contact no portal and their output is non-fileable — so practice
// mode is always available regardless of this switch. Stateless; gated `finance.einvoice.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assessGstPortalGate, type GstPortalChannel, type GstPortalControls } from '../../../packages/e-invoice/src/index';

const CHANNELS: readonly GstPortalChannel[] = ['e_invoice', 'e_way_bill'];

export function gstPortalRoutes(): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/gst-portal/gate',
      permission: 'finance.einvoice.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const channel = b['channel'] ?? 'e_invoice';
        if (typeof channel !== 'string' || !CHANNELS.includes(channel as GstPortalChannel)) {
          throw apiError(400, { code: 'gst_portal_bad_channel', whatHappened: `channel must be one of: ${CHANNELS.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send channel: "e_invoice" or "e_way_bill" (or omit it to default to e_invoice).' });
        }
        if ((b['enabled'] !== undefined && typeof b['enabled'] !== 'boolean') || (b['killed'] !== undefined && typeof b['killed'] !== 'boolean')) {
          throw apiError(400, { code: 'gst_portal_bad_controls', whatHappened: 'enabled and killed, if given, must be booleans.', wasItSaved: 'not_saved', nextSafeAction: 'Send the tenant’s controls as { enabled: true/false, killed: true/false }.' });
        }
        const controls: GstPortalControls = {
          ...(typeof b['enabled'] === 'boolean' ? { enabled: b['enabled'] } : {}),
          ...(typeof b['killed'] === 'boolean' ? { killed: b['killed'] } : {}),
        };
        return { status: 200, body: assessGstPortalGate(controls, channel as GstPortalChannel) };
      },
    },
  ];
}
