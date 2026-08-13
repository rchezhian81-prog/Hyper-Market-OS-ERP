// GST government-portal switch — the feature flag + kill switch that keeps the LIVE (non-sandbox)
// e-invoice (IRP) and e-way-bill portal integrations OFF by default and killable instantly (owner
// directive §2/§6). The directive is explicit: the module stays disabled by default until credentials and
// CA/legal confirmation are in place, and must be killable.
//
// Two independent controls, and the safe default is "not live":
//   • `enabled` — the tenant has switched the live integration on. Default (absent) is FALSE: off until
//     the certified-GSP credentials and the CA/legal sign-off are in place.
//   • `killed` — an emergency stop that OVERRIDES `enabled`. Even an enabled integration is refused while
//     the kill switch is set — instantly, without touching the network.
//
// The SANDBOX routes are exempt and never consult this: they contact no portal and their output is
// non-fileable, so a store can always exercise the loop in practice mode regardless of the switch.
//
// This is the DECISION. Where the two flags are stored is the deployment's concern — per-tenant versioned
// config already exists (M01-FR-03). Pure and deterministic: controls in, verdict out.

export type GstPortalChannel = 'e_invoice' | 'e_way_bill';

export interface GstPortalControls {
  /** The tenant has enabled the live portal integration. Absent = not enabled (the safe default). */
  readonly enabled?: boolean;
  /** Emergency kill switch — overrides `enabled` when set. Absent = not killed. */
  readonly killed?: boolean;
}

export type GstPortalGateReason = 'live' | 'not_enabled' | 'killed';

export interface GstPortalGate {
  readonly channel: GstPortalChannel;
  readonly canGoLive: boolean;
  readonly reason: GstPortalGateReason;
  /** Plain-English reason a person (or an operator runbook) can act on. */
  readonly detail: string;
}

const label = (channel: GstPortalChannel): string => (channel === 'e_way_bill' ? 'e-way-bill' : 'e-invoicing');

/**
 * May the LIVE portal integration be used for this channel, given the tenant's controls? The kill switch
 * beats `enabled`; absent flags mean not-enabled. The sandbox never calls this — it is always allowed.
 * Pure.
 */
export function assessGstPortalGate(
  controls: GstPortalControls = {},
  channel: GstPortalChannel = 'e_invoice',
): GstPortalGate {
  const name = label(channel);
  if (controls.killed === true) {
    return { channel, canGoLive: false, reason: 'killed', detail: `the ${name} kill switch is ON — live portal calls are stopped; use the sandbox, or clear the kill switch once the cause is resolved` };
  }
  if (controls.enabled !== true) {
    return { channel, canGoLive: false, reason: 'not_enabled', detail: `live ${name} is not enabled for this store — turn it on (with certified-GSP credentials and CA/legal sign-off) before any real portal call` };
  }
  return { channel, canGoLive: true, reason: 'live', detail: `live ${name} is enabled and not killed` };
}

/** Throw-style guard for a caller that must not proceed to a live portal call when the gate is closed. */
export class GstPortalDisabledError extends Error {
  constructor(public readonly gate: GstPortalGate) {
    super(gate.detail);
    this.name = 'GstPortalDisabledError';
  }
}

/** Assert the live gate is open, or throw `GstPortalDisabledError`. Returns the gate for convenience. */
export function requireGstPortalLive(
  controls: GstPortalControls = {},
  channel: GstPortalChannel = 'e_invoice',
): GstPortalGate {
  const gate = assessGstPortalGate(controls, channel);
  if (!gate.canGoLive) throw new GstPortalDisabledError(gate);
  return gate;
}
