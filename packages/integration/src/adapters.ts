// Provider and device adapters (M32-FR-04 / D14 / §33 / §35 / hard rules #1, #3).
//
// The certified matrix. Every outside system the shop touches — Tally, the payment provider,
// the GST portal, WhatsApp, a delivery partner, a barcode scanner, a weighing scale — is an
// adapter here, and the point of a matrix rather than a config file is that **an uncertified
// combination is refused rather than merely undocumented**.
//
// That sounds bureaucratic until you have watched it fail. A shop buys a cheap thermal printer
// on a Sunday, it half-works, receipts come out with the tax lines missing, and it takes three
// weeks to connect the complaint to the hardware. A weighing scale that reports in a different
// unit costs money on every weighed sale until somebody notices.
//
//   • **AN UNCERTIFIED DEVICE IS BLOCKED, AND THE MESSAGE SAYS WHAT TO BUY.** A refusal that
//     does not name a working alternative just gets overridden.
//   • **A PAYMENT ADAPTER STORES A TOKEN OR IT IS REFUSED** (hard rule #3). Not a warning, not
//     a lint rule — configuration that admits it retains a PAN cannot be registered at all,
//     and the provider must be RBI-authorised.
//   • **A PROVIDER OUTAGE QUEUES; IT DOES NOT STOP THE SHOP** (hard rule #1). Cloud adapters
//     hold their traffic. **Lane-critical hardware runs on the LAN** and never has a cloud
//     dependency in the path of a scan.
//   • **HEALTH IS "WHEN DID IT LAST WORK", NOT "IS IT CONFIGURED".** An adapter that has been
//     failing quietly for nine days is the normal way an integration dies.
//
// Pure and deterministic: the clock is injected, no I/O, no card data anywhere.

export type AdapterCategory =
  | 'accounting'
  | 'payment'
  | 'tax_portal'
  | 'messaging'
  | 'logistics'
  | 'hardware';

export type DeviceKind =
  | 'barcode_scanner'
  | 'receipt_printer'
  | 'label_printer'
  | 'weighing_scale'
  | 'cash_drawer'
  | 'customer_display'
  | 'payment_terminal'
  | 'handheld'
  | 'price_kiosk';

export interface CertifiedEntry {
  readonly entryId: string;
  readonly category: AdapterCategory;
  readonly vendor: string;
  readonly model: string;
  /** Firmware or API versions certified. Empty means any. */
  readonly versions: readonly string[];
  readonly deviceKind?: DeviceKind;
  readonly certifiedOn: string;
  readonly notes?: string;
  /** For payments: is this provider RBI-authorised? */
  readonly rbiAuthorised?: boolean;
  /** True when the adapter must run at the store edge, not in the cloud. */
  readonly edgeOnly?: boolean;
}

export type CertificationOutcome = 'certified' | 'not_certified' | 'wrong_version' | 'withdrawn';

export interface DeviceDecision {
  readonly vendor: string;
  readonly model: string;
  readonly allowed: boolean;
  readonly outcome: CertificationOutcome;
  /** What to buy instead. A refusal with no alternative just gets overridden. */
  readonly alternatives: readonly string[];
  readonly detail: string;
}

/**
 * May this device be used?
 *
 * **The refusal names a working alternative**, because a refusal that does not is one somebody
 * overrides on a Sunday when the shop needs a printer. The certified matrix only holds if
 * following it is easier than going around it.
 */
export function checkDevice(input: {
  readonly vendor: string;
  readonly model: string;
  readonly firmware?: string;
  readonly deviceKind: DeviceKind;
  readonly matrix: readonly CertifiedEntry[];
  readonly withdrawn?: readonly string[];
}): DeviceDecision {
  const forKind = input.matrix.filter((e) => e.category === 'hardware' && e.deviceKind === input.deviceKind);
  const alternatives = forKind
    .filter((e) => !(input.withdrawn ?? []).includes(e.entryId))
    .map((e) => `${e.vendor} ${e.model}`)
    .sort();

  const base = { vendor: input.vendor, model: input.model, alternatives };
  const entry = forKind.find(
    (e) => e.vendor.toLowerCase() === input.vendor.toLowerCase() && e.model.toLowerCase() === input.model.toLowerCase(),
  );

  if (entry === undefined) {
    return {
      ...base,
      allowed: false,
      outcome: 'not_certified',
      detail: `${input.vendor} ${input.model} is not on the certified matrix for a ${input.deviceKind.replace(/_/g, ' ')}. ${alternatives.length === 0 ? 'Nothing is certified for this yet' : `Certified: ${alternatives.join(', ')}`}`,
    };
  }
  if ((input.withdrawn ?? []).includes(entry.entryId)) {
    return {
      ...base,
      allowed: false,
      outcome: 'withdrawn',
      detail: `${input.vendor} ${input.model} was certified and has been withdrawn${entry.notes === undefined ? '' : ` — ${entry.notes}`}. ${alternatives.length === 0 ? '' : `Use ${alternatives.join(' or ')}`}`,
    };
  }
  if (entry.versions.length > 0 && input.firmware !== undefined && !entry.versions.includes(input.firmware)) {
    return {
      ...base,
      allowed: false,
      outcome: 'wrong_version',
      detail: `${input.vendor} ${input.model} is certified on firmware ${entry.versions.join(', ')} and this unit reports ${input.firmware} — update it rather than replace it`,
    };
  }

  return {
    ...base,
    allowed: true,
    outcome: 'certified',
    detail: `${input.vendor} ${input.model} certified ${entry.certifiedOn}${entry.edgeOnly === true ? ' — runs at the store edge, no cloud in the path of a scan' : ''}`,
  };
}

export interface AdapterConfig {
  readonly adapterId: string;
  readonly tenantId: string;
  readonly category: AdapterCategory;
  readonly vendor: string;
  readonly environment: 'sandbox' | 'production';
  /** Vault reference. NEVER a credential. */
  readonly credentialRef: string;
  /**
   * Payments only: what the adapter retains after a transaction, declared by name.
   *
   * Checked against an **allowlist**, not a blocklist. A blocklist of forbidden card
   * fields only refuses the ones somebody thought to write down; an allowlist refuses
   * everything nobody has explicitly permitted, including whatever a provider invents
   * next year.
   */
  readonly retains?: readonly string[];
  readonly enabled: boolean;
  /** Queue traffic during an outage rather than failing the caller (hard rule #1). */
  readonly queueOnOutage?: boolean;
}

export type AdapterRegistrationOutcome =
  | 'registered'
  | 'stores_card_data'
  | 'provider_not_authorised'
  | 'credential_inline'
  | 'not_certified'
  | 'sandbox_credential_in_production';

export interface AdapterRegistration {
  readonly adapterId: string;
  readonly registered: boolean;
  readonly outcome: AdapterRegistrationOutcome;
  readonly detail: string;
}

/**
 * The **only** things a payment adapter may keep (hard rule #3). Anything a configuration
 * declares that is not on this list is refused — including whatever a provider invents next
 * year, which is exactly what a blocklist of known-bad field names would miss.
 */
export const PERMITTED_PAYMENT_RETENTION: readonly string[] = [
  'provider_token',
  'last4',
  'auth_code',
  'transaction_ref',
  'issuing_bank',
  'network_name',
];

/** A credential that is a literal rather than a vault pointer (hard rule #4). */
function looksInline(ref: string): boolean {
  return !/^vault:\/\//.test(ref.trim());
}

/**
 * Register an adapter.
 *
 * Two refusals here are absolute and have no override anywhere in the codebase:
 *
 * **A payment adapter whose configuration declares it retains anything outside
 * `PERMITTED_PAYMENT_RETENTION` cannot be registered.** Not warned about, not flagged for
 * review — refused (hard rule #3). An allowlist rather than a list of forbidden field names,
 * so a provider that invents a new one next year is refused too. And the provider must be
 * RBI-authorised, because tokenisation from an unauthorised gateway is somebody else's promise
 * about the customer's card.
 *
 * **A credential that is a literal rather than a `vault://` pointer is refused** (hard rule
 * #4). The secret-scan guardrail catches these in the repository; this catches the ones typed
 * into a configuration screen at runtime, which the scanner never sees.
 */
export function registerAdapter(input: {
  readonly config: AdapterConfig;
  readonly matrix: readonly CertifiedEntry[];
  readonly environment: 'sandbox' | 'production';
  /** Vault refs known to belong to the sandbox. */
  readonly sandboxRefs?: readonly string[];
}): AdapterRegistration {
  const c = input.config;
  const base = { adapterId: c.adapterId };

  if (looksInline(c.credentialRef)) {
    return {
      ...base,
      registered: false,
      outcome: 'credential_inline',
      detail: 'the credential is a literal rather than a vault:// reference — the secret scanner catches these in the repository, and this catches the ones typed into a configuration screen (hard rule #4)',
    };
  }

  if (c.category === 'payment') {
    const notPermitted = (c.retains ?? [])
      .filter((r) => !PERMITTED_PAYMENT_RETENTION.includes(r))
      .sort();
    if (notPermitted.length > 0) {
      return {
        ...base,
        registered: false,
        outcome: 'stores_card_data',
        detail: `this adapter declares it retains ${notPermitted.join(', ')}, which is not on the permitted list — refused outright, with no override anywhere (hard rule #3). A payment adapter may keep only ${PERMITTED_PAYMENT_RETENTION.join(', ')}`,
      };
    }
    const entry = input.matrix.find(
      (e) => e.category === 'payment' && e.vendor.toLowerCase() === c.vendor.toLowerCase(),
    );
    if (entry === undefined) {
      return { ...base, registered: false, outcome: 'not_certified', detail: `${c.vendor} is not on the certified payment matrix` };
    }
    if (entry.rbiAuthorised !== true) {
      return {
        ...base,
        registered: false,
        outcome: 'provider_not_authorised',
        detail: `${c.vendor} is not recorded as RBI-authorised — tokenisation from an unauthorised gateway is somebody else's promise about card data (§35)`,
      };
    }
  }

  if (input.environment === 'production' && (input.sandboxRefs ?? []).includes(c.credentialRef)) {
    return {
      ...base,
      registered: false,
      outcome: 'sandbox_credential_in_production',
      detail: `${c.credentialRef} is a sandbox credential and this adapter runs in production (hard rule #7)`,
    };
  }

  return {
    ...base,
    registered: true,
    outcome: 'registered',
    detail: `${c.vendor} ${c.category.replace(/_/g, ' ')} adapter registered in ${input.environment}${c.queueOnOutage === true ? ', queueing during an outage rather than failing the caller' : ''}`,
  };
}

export type AdapterHealthState = 'healthy' | 'degraded' | 'failing' | 'silent' | 'disabled';

export interface AdapterHeartbeat {
  readonly adapterId: string;
  readonly at: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface AdapterHealth {
  readonly adapterId: string;
  readonly category: AdapterCategory;
  readonly state: AdapterHealthState;
  readonly minutesSinceLastSuccess: number | 'never';
  readonly consecutiveFailures: number;
  /** True when the shop keeps trading regardless — hard rule #1. */
  readonly shopKeepsTrading: boolean;
  readonly detail: string;
}

/**
 * Adapter health, computed from **when it last actually worked**.
 *
 * "Configured" is not health. An adapter that has been failing quietly for nine days is
 * configured, enabled and green on any dashboard that reports configuration — and that is the
 * normal way an integration dies: not with an outage, but with a slow slide nobody was
 * measuring.
 *
 * **`shopKeepsTrading` is true for every category except lane-critical hardware.** A Tally
 * outage, a GST portal outage, a WhatsApp outage — none of them may stop a sale (hard rule
 * #1). A dead scanner is a different matter, and it is local.
 */
export function adapterHealth(input: {
  readonly config: AdapterConfig;
  readonly heartbeats: readonly AdapterHeartbeat[];
  /** Minutes without a success before it is treated as silent. Default 60. */
  readonly silentAfterMinutes?: number;
  readonly at: string;
}): AdapterHealth {
  const mine = [...input.heartbeats]
    .filter((h) => h.adapterId === input.config.adapterId)
    .sort((a, b) => a.at.localeCompare(b.at));

  // Every category here keeps the shop trading. A cloud adapter down is a queue getting
  // longer; a card terminal down is a cash sale; a dead scanner is manual entry at that one
  // lane. Nothing in this module reaches the point where a customer cannot be served
  // (hard rule #1).
  const shopKeepsTrading = true;

  const lastSuccess = [...mine].reverse().find((h) => h.ok);
  const minutesSinceLastSuccess =
    lastSuccess === undefined
      ? ('never' as const)
      : Math.max(0, Math.round((Date.parse(input.at) - Date.parse(lastSuccess.at)) / 60_000));

  let consecutiveFailures = 0;
  for (const h of [...mine].reverse()) {
    if (h.ok) break;
    consecutiveFailures += 1;
  }

  const base = {
    adapterId: input.config.adapterId,
    category: input.config.category,
    minutesSinceLastSuccess,
    consecutiveFailures,
    shopKeepsTrading,
  };

  if (!input.config.enabled) {
    return { ...base, state: 'disabled', detail: 'this adapter is switched off' };
  }
  if (mine.length === 0 || minutesSinceLastSuccess === 'never') {
    return {
      ...base,
      state: 'silent',
      detail: `${input.config.vendor} has NEVER reported a success — "configured" is not health, and an adapter nobody measured is how an integration dies quietly`,
    };
  }
  if (minutesSinceLastSuccess > (input.silentAfterMinutes ?? 60)) {
    return {
      ...base,
      state: 'silent',
      detail: `${input.config.vendor} last worked ${minutesSinceLastSuccess} minute(s) ago — it is green on any dashboard that reports configuration and it has not worked since`,
    };
  }
  if (consecutiveFailures >= 3) {
    return {
      ...base,
      state: 'failing',
      detail: `${consecutiveFailures} failures in a row${input.config.queueOnOutage === true ? ' — traffic is queued, and the shop keeps trading' : ''}`,
    };
  }
  if (consecutiveFailures > 0) {
    return { ...base, state: 'degraded', detail: `${consecutiveFailures} recent failure(s), last success ${minutesSinceLastSuccess} minute(s) ago` };
  }

  return { ...base, state: 'healthy', detail: `${input.config.vendor} working, last success ${minutesSinceLastSuccess} minute(s) ago` };
}

export interface IntegrationHealthReport {
  readonly tenantId: string;
  readonly asAt: string;
  readonly adapters: readonly AdapterHealth[];
  /** True in every report this function can produce. Nothing here stops a sale. */
  readonly posUnaffected: true;
  readonly detail: string;
}

/**
 * The integration health picture, for M35's status centre.
 *
 * `posUnaffected` is typed as the literal `true` for the same reason `mayContinueTrading` is
 * in `packages/platform`: **no integration failure may reach the till** (P-01, hard rule #1).
 * A cloud adapter being down is a queue getting longer, not a shop that has stopped selling,
 * and the type makes that a property of the code rather than an intention in a document.
 */
export function integrationHealth(input: {
  readonly tenantId: string;
  readonly configs: readonly AdapterConfig[];
  readonly heartbeats: readonly AdapterHeartbeat[];
  readonly at: string;
}): IntegrationHealthReport {
  const adapters = input.configs
    .filter((c) => c.tenantId === input.tenantId)
    .map((config) => adapterHealth({ config, heartbeats: input.heartbeats, at: input.at }))
    .sort((a, b) => {
      const rank: Record<AdapterHealthState, number> = { silent: 0, failing: 1, degraded: 2, healthy: 3, disabled: 4 };
      return rank[a.state] - rank[b.state] || a.adapterId.localeCompare(b.adapterId);
    });

  const bad = adapters.filter((a) => a.state === 'silent' || a.state === 'failing');

  return {
    tenantId: input.tenantId,
    asAt: input.at,
    adapters,
    posUnaffected: true,
    detail:
      bad.length === 0
        ? `all ${adapters.length} adapter(s) working`
        : `${bad.length} adapter(s) need attention: ${bad.map((a) => a.adapterId).join(', ')} — the till is unaffected either way (hard rule #1)`,
  };
}
