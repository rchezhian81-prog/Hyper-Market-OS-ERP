// Configuration, checked at boot — SEC-04, hard rule #4, §19, ADR-0002.
//
// **A service with a missing or placeholder secret does not start.** It does not warn, it does not
// substitute a default, and it does not carry on with a reduced feature set. A system that boots
// with a default signing key is a system that runs in production with a default signing key, and
// the log line saying so scrolled past three months ago.
//
// Two more rules, both about the same thing — that a deployment problem must be discovered by the
// person deploying rather than by a customer:
//
//   • **Everything is checked at boot, not on first use.** A setting read the first time somebody
//     tries to publish a catalogue is a setting that is wrong at nine on a Friday.
//   • **Every problem is named at once.** A boot that reports one missing variable per attempt
//     produces five deploys, and by the third the person is guessing.
//
// And the placeholder check matters more than it looks. `.env.example` ships with
// `REPLACE_WITH_A_GENERATED_VALUE`, which is exactly what gets copied and forgotten — so the
// values that appear in the example file are refused by name.

import { PAYMENT_DATA_REGION_KEY, PAYMENT_BACKUP_REGION_KEY, indiaRegionProblem } from './data-residency';

export type ConfigProblem =
  | 'missing'
  | 'still_the_placeholder'
  | 'too_short_to_be_a_secret'
  | 'not_a_number'
  | 'not_one_of_the_allowed_values'
  | 'refused_by_policy';

export interface ConfigFinding {
  readonly key: string;
  readonly problem: ConfigProblem;
  readonly detail: string;
}

export interface ConfigResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly problems: readonly ConfigFinding[];
  readonly detail: string;
}

/**
 * Values that appear in `.env.example` and must never appear in a running system.
 *
 * The example file is what gets copied. Refusing these by name is the difference between a
 * deployment that fails in ten seconds and one that signs catalogue packs with a placeholder.
 */
const PLACEHOLDERS = [
  'CHANGEME', 'changeme', 'password', 'secret', 'your-secret-here', 'xxx', 'TODO',
];

/**
 * The convention the example file uses, matched as a prefix rather than by exact value.
 *
 * The list above started as exact strings, and the guardrail that reads `.env.example` caught the
 * consequence the first time a new placeholder was added: `REPLACE_WITH_YOUR_IDENTITY_PROVIDER_URL`
 * was not `REPLACE_WITH_A_GENERATED_VALUE`, so it sailed through — a deployment would have believed
 * tokens from an issuer literally called that. Matching the prefix means the next placeholder
 * somebody writes is covered before they think to add it here.
 */
const PLACEHOLDER_PREFIX = 'replace_with';

const isPlaceholder = (value: string): boolean => {
  const v = value.trim().toLowerCase();
  return v.startsWith(PLACEHOLDER_PREFIX) || PLACEHOLDERS.some((p) => v === p.toLowerCase());
};

export interface Spec {
  readonly key: string;
  /** A secret is length-checked and never echoed anywhere, including in an error. */
  readonly secret?: boolean;
  readonly minLength?: number;
  readonly numeric?: boolean;
  readonly oneOf?: readonly string[];
  readonly optional?: boolean;
  readonly fallback?: string;
  /**
   * A policy the value must meet beyond its shape (e.g. C12: payment data stays in India). Returns why the value is
   * refused, or `undefined` when it is acceptable. Never used on a secret — its words may repeat the value.
   */
  readonly check?: (raw: string) => string | undefined;
}

/**
 * Read and check the environment, or refuse to start.
 *
 * The returned map is only populated when every check passed. A partly-valid configuration is not
 * a thing this returns, because a caller holding one will use the good half and discover the rest
 * later, which is the failure this function exists to prevent.
 */
export function loadConfig(
  specs: readonly Spec[],
  env: Readonly<Record<string, string | undefined>>,
): ConfigResult<Readonly<Record<string, string>>> {
  const problems: ConfigFinding[] = [];
  const value: Record<string, string> = {};

  for (const spec of specs) {
    const raw = env[spec.key] ?? spec.fallback;

    if (raw === undefined || raw.trim() === '') {
      if (spec.optional === true) continue;
      problems.push({
        key: spec.key, problem: 'missing',
        detail: `${spec.key} is not set. Nothing starts without it`,
      });
      continue;
    }

    if (isPlaceholder(raw)) {
      problems.push({
        key: spec.key, problem: 'still_the_placeholder',
        detail: `${spec.key} still holds the value from .env.example. That file is what gets copied and forgotten, so the example values are refused by name`,
      });
      continue;
    }

    if (spec.secret === true && raw.length < (spec.minLength ?? 32)) {
      problems.push({
        key: spec.key, problem: 'too_short_to_be_a_secret',
        // The value itself is never in the message, here or anywhere else (#4).
        detail: `${spec.key} is ${raw.length} characters and needs at least ${spec.minLength ?? 32}. A short secret is a secret in name only`,
      });
      continue;
    }

    if (spec.numeric === true && !Number.isFinite(Number(raw))) {
      problems.push({
        key: spec.key, problem: 'not_a_number',
        detail: `${spec.key} should be a number`,
      });
      continue;
    }

    if (spec.oneOf !== undefined && !spec.oneOf.includes(raw)) {
      problems.push({
        key: spec.key, problem: 'not_one_of_the_allowed_values',
        detail: `${spec.key} is "${raw}"; it must be one of ${spec.oneOf.join(', ')}`,
      });
      continue;
    }

    const refused = spec.secret === true ? undefined : spec.check?.(raw);
    if (refused !== undefined) {
      problems.push({ key: spec.key, problem: 'refused_by_policy', detail: refused });
      continue;
    }

    value[spec.key] = raw;
  }

  return problems.length === 0
    ? { ok: true, value, problems: [], detail: `${specs.length} setting(s) checked, all present and usable` }
    : {
      ok: false,
      problems,
      // Every problem at once. One per restart produces five deploys and a guessing game.
      detail: `this service will not start until ${problems.length} configuration problem(s) are fixed:\n${problems.map((p) => `  • ${p.detail}`).join('\n')}`,
    };
}

/** What the cloud API needs. Nothing here has a usable default, deliberately. */
export const CLOUD_API_CONFIG: readonly Spec[] = [
  { key: 'DATABASE_URL', secret: true, minLength: 20 },
  { key: 'PACK_SIGNING_KEY', secret: true, minLength: 32 },
  // The identity provider's signing key, and who its tokens must claim to be from and for.
  //
  // Required, not optional, and deliberately so: absent, `authenticate` would have to fall back to
  // *something*, and every fallback here is a way in. A deployment with no identity provider
  // configured does not start — which is louder than one that starts and lets everybody in.
  { key: 'IDP_SIGNING_KEY', secret: true, minLength: 32 },
  { key: 'IDP_ISSUER' },
  { key: 'IDP_AUDIENCE' },
  // The longest any token may be valid for, in seconds (GAP-SEC-05). A token whose `exp − iat` exceeds this is
  // refused whatever the issuer wrote, so a leaked token can never outlive the ceiling. Default 31 days — long
  // enough for the store box's 30-day sync token, and the owner may tighten it (a human sign-in from a real IdP
  // is minutes to hours anyway). Never widened silently: it is a setting, read at boot.
  { key: 'IDP_MAX_TOKEN_LIFETIME_SECONDS', numeric: true, fallback: '2678400' },
  // The self-hosted identity server (Keycloak, ADR-0019 · OB-15) — optional while the pilot sign-in retires. When both
  // are set, head office ALSO believes tokens that server signed (RS256), checked against the public keys it publishes
  // at IDP_OIDC_JWKS_URL, issued by exactly IDP_OIDC_ISSUER (the realm's address), for IDP_AUDIENCE. Public keys only:
  // nothing here can sign.
  { key: 'IDP_OIDC_ISSUER', optional: true },
  { key: 'IDP_OIDC_JWKS_URL', optional: true },
  // One realm per shop (OB-15-d · OB-19): the shop the first realm signs for, and every further shop's realm=tenant.
  // With more than one, every realm is pinned to its own shop (services/identity/src/shop-realms.ts).
  { key: 'IDP_OIDC_TENANT_ID', optional: true },
  { key: 'IDP_OIDC_SHOP_REALMS', optional: true },
  // OB-510 · ADR-0031 (amended): each shop's CUSTOMER realm and the one shop it signs for (realm=tenant, comma-separated).
  { key: 'IDP_OIDC_CUSTOMER_REALMS', optional: true },
  // Head office's provisioner at that identity server (OB-15-c): the secret the identity server GENERATED for its
  // `sre-provisioner` client, copied here by the administrator. Optional — absent, people are given sign-ins at the
  // identity server by hand and the product's people route says it is not connected. It may manage users, nothing else.
  { key: 'IDP_PROVISIONER_SECRET', secret: true, optional: true, minLength: 16 },
  // FUL-12 · ADR-0025: the key-encryption key the per-customer data keys are wrapped under. Optional — absent, it is derived
  // from PACK_SIGNING_KEY under its own label (and the API says so at boot). Set it to give personal data its own secret.
  { key: 'PII_KEY_ENCRYPTION_KEY', secret: true, optional: true, minLength: 32 },
  // Round 32 · OB-116 (owner, 14 Oct 2026, "New head-office secret"): the secret the store computers' saved history is sealed
  // under — head office's ALONE. Never given to a store computer (it holds PACK_SIGNING_KEY, so the seal can no longer be
  // worked out from a store computer's settings). Required, like PACK_SIGNING_KEY: the API does not start without it, and
  // refuses one equal to PACK_SIGNING_KEY, PII_KEY_ENCRYPTION_KEY or IDP_SIGNING_KEY (services/api/src/main.ts).
  { key: 'BOX_HISTORY_SEAL_KEY', secret: true, minLength: 32 },
  { key: 'PORT', numeric: true, fallback: '8081' },
  // Verifier r20 HW-2: how long one of the API's own database sessions may sit IDLE inside an open transaction before the
  // database ends it (PostgreSQL `idle_in_transaction_session_timeout`, set on every pooled connection). A transaction left
  // open holds back the bill-number high-water's visibility fence; the API's transactions are short, so one minute is
  // generous. 0 switches it off (never in production).
  { key: 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', numeric: true, fallback: '60000' },
  // C12 (v2.1) · ADR-0002: where head office keeps the shop's payment data (its database and document store), and where
  // off-site copies of it go. India, as ISO 3166 (`IN` or `IN-<state>`) — any other value and the API does not start
  // (`indiaRegionProblem`). The default is India because the policy is India; what a deployment cannot do is say otherwise.
  { key: PAYMENT_DATA_REGION_KEY, fallback: 'IN', check: (raw) => indiaRegionProblem(PAYMENT_DATA_REGION_KEY, raw) },
  { key: PAYMENT_BACKUP_REGION_KEY, optional: true, check: (raw) => indiaRegionProblem(PAYMENT_BACKUP_REGION_KEY, raw) },
  { key: 'NODE_ENV', oneOf: ['development', 'test', 'production'], fallback: 'production' },
  { key: 'MIGRATION_TARGET_KIND', oneOf: ['rehearsal', 'staging', 'local', 'production'], fallback: 'rehearsal' },
  // Genesis owner (optional). A brand-new tenant has nobody who can grant the first role, so — where
  // set — these name the tenant and the user who become its first owner at boot. Optional and
  // idempotent: absent, no genesis is seeded (the tenant simply has no authority until provisioned);
  // present, the owner is established once and never re-widened. The user's identity is an owner
  // decision, which is why it is configuration and not a constant in the code.
  { key: 'BOOTSTRAP_OWNER_TENANT_ID', optional: true },
  { key: 'BOOTSTRAP_OWNER_USER_ID', optional: true },
];

/**
 * What the store edge needs, which is **the point of this list**.
 *
 * There is no cloud URL, no cloud token and no cloud anything in it. The edge starts, holds its
 * pack and sells with no cloud configuration whatsoever — if it needed the cloud to boot, then
 * offline-first would be a claim rather than a property (P-01, hard rule #1). Cloud settings are
 * optional and only the *sync agent* reads them; the sale path never does.
 */
export const STORE_EDGE_CONFIG: readonly Spec[] = [
  { key: 'EDGE_DATA_DIR' },
  { key: 'EDGE_TENANT_ID' },
  { key: 'PACK_SIGNING_KEY', secret: true, minLength: 32 },
  { key: 'EDGE_CAPACITY_BYTES', numeric: true, fallback: '10737418240' },
  /**
   * The loopback port the lane's screen posts sales to. Optional: absent, this edge has no screen
   * attached and does the shop-wide work — which is exactly what the back-office box is (ADR-0004).
   */
  { key: 'EDGE_LANE_PORT', numeric: true, optional: true },
  /**
   * Which LANE this box is (SP-4b · F09). Told to the served till and stamped on every sale that leaves here, so a sale
   * is never filed under a lane that does not exist. Optional for the back-office box, which serves no till; a till box
   * without it refuses to take payment and says why.
   */
  { key: 'EDGE_LANE_ID', optional: true },
  /**
   * PA-06 = DF-3-a (OB-26 "A"): where this box takes its store setup from. `head-office` makes it pull its signed setup from
   * head office for EDGE_STORE_ID (the pack file is then only a first-boot fallback); unset keeps the pack file.
   */
  { key: 'EDGE_STORE_PACK_SOURCE', optional: true },
  /** PA-06 = DF-3-a: which store this box IS, when it takes its setup from head office. */
  { key: 'EDGE_STORE_ID', optional: true },
  /**
   * The loopback port the six screens are served from. Optional for the same reason the lane port
   * is: a till does not need to serve the owner's brief, and not opening a socket beats opening
   * one nobody uses.
   */
  { key: 'EDGE_SCREEN_PORT', numeric: true, optional: true },
  /**
   * The address the screens bind to. Absent = loopback, the shop-PC default. A container on a private
   * compose network with the public proxy in front names it explicitly (ADR-0018); the boot log then says
   * out loud that the screens are reachable beyond loopback, and no host port is ever published for them.
   */
  { key: 'EDGE_SCREEN_HOST', optional: true },
  /**
   * OB-388 · ADR-0029: where head office's sign-in is — the identity server realm's https address. With CLOUD_API_URL, the
   * office pages on this box send each person through their OWN head-office sign-in (password and second step) and carry
   * THEIR session to head office. Absent: the box never answers a page's head-office call (a lost link, said on the page).
   */
  { key: 'EDGE_HEAD_OFFICE_SIGN_IN_ISSUER', optional: true },
  /** OB-388: this product's public client at the identity server (default `sre-web`); PKCE binds each sign-in, no secret. */
  { key: 'EDGE_HEAD_OFFICE_SIGN_IN_CLIENT_ID', optional: true },
  /** OB-388: head office's API name in the tokens (default `sre-retail-os-api`). */
  { key: 'EDGE_HEAD_OFFICE_AUDIENCE', optional: true },
  // The handhelds' DEVICE socket (SP-3a · ADR-0019): the shop-network-facing door the enrolled handhelds hand their work
  // through. Absent → no device socket at all. The host stays loopback unless named — a shop names its LAN address.
  { key: 'EDGE_DEVICE_PORT', numeric: true, optional: true },
  { key: 'EDGE_DEVICE_HOST', optional: true },
  /**
   * OB-422 · ADR-0030: the folder holding the device socket's lock — the store computer's own signing authority (its
   * private key never leaves this folder) and the door's certificate. Absent → `<EDGE_DATA_DIR>-device-tls`, beside the
   * data folder and never inside it, so a backup of the data never carries a private key off the box.
   */
  { key: 'EDGE_DEVICE_TLS_DIR', optional: true },
  /** Where `apps/` lives on this box, so the screens can be served from disk. */
  { key: 'EDGE_APPS_DIR', optional: true },
  /**
   * Run the ERP screens as the person the hosted front's sign-in names (`X-Sre-User`, OB-16). Set to `1` by the PILOT
   * overlay alone, behind its authenticating front; a store box never sets it. Declared here because the loader keeps
   * only declared settings — undeclared, it was silently never read (found 6 Oct 2026, Wave 2b-v).
   */
  { key: 'EDGE_SCREEN_TRUST_FORWARDED_USER', optional: true, oneOf: ['0', '1'] },
  /**
   * Open a till session for the person the hosted front's sign-in names, without a till PIN (ADR-0020 §6). The PILOT
   * overlay alone sets `1`; a store box never does — its cashiers sign in with their own till PIN.
   */
  { key: 'EDGE_LANE_TRUST_FORWARDED_USER', optional: true, oneOf: ['0', '1'] },
  /**
   * OB-252 (owner, 20 Oct 2026, "Guest sales only"): `1` → the tills this box serves take no customer mobile number and no
   * loyalty (the store pack's `policies.guestSalesOnly` can also turn it on). The till shows it whenever it is on.
   */
  { key: 'EDGE_GUEST_SALES_ONLY', optional: true, oneOf: ['0', '1'] },
  /**
   * OB-256 · OB-258 (owner, 20 Oct 2026): `1` → the MIRROR PILOT — the old ERP bills and takes every payment; the tills this
   * box serves record the same lines with the one tender "Paid on old system" (sales and refunds), and nothing else (the
   * store pack's `policies.mirrorPilot` can also turn it on). Needs guest sales only on as well: a box set for the mirror
   * pilot without it refuses to start.
   */
  { key: 'EDGE_MIRROR_PILOT', optional: true, oneOf: ['0', '1'] },
  /**
   * OB-271 (owner, 21 Oct 2026): `1` → REAL TRADING — the new till's bill is the legal GST tax invoice (Rule 46), printed on
   * paper, card/UPI payments carry the machine's approval number (the store pack's `policies.realTrading` can also turn it
   * on). Set by the owner himself only after the mirror pilot passes and his written GO; the installer never writes it.
   * Never together with the mirror pilot: a box set for both refuses to start.
   */
  { key: 'EDGE_REAL_TRADING', optional: true, oneOf: ['0', '1'] },
  /** OB-271: the bill's paper when no published receipt template names one — `thermal-80` (the default) or `thermal-58`. */
  { key: 'EDGE_BILL_PAPER', optional: true, oneOf: ['thermal-80', 'thermal-58'] },
  /**
   * OB-259: `pin` — every screen this box serves but the till asks for the person's own till PIN, and opens only for an
   * office role (edge/store-edge/src/office-sign-in.ts). The installer writes it; absent, the screens open as before.
   */
  { key: 'EDGE_OFFICE_SIGN_IN', optional: true, oneOf: ['pin'] },
  /**
   * The box's till-credentials file (ADR-0020): the PIN verifiers the `till-pin` command writes, owner-only. Absent → the
   * file `till-credentials.json` in the data directory.
   */
  { key: 'EDGE_TILL_CREDENTIALS_FILE', optional: true },
  /**
   * OB-87 "A": the folder OUTSIDE the data directory where the box keeps its bill-number witness log, so a data folder
   * restored from a backup is told apart from a restart. Absent → the folder `<EDGE_DATA_DIR>-witness` beside it. Never
   * inside the data directory, and never part of a backup of it.
   */
  { key: 'EDGE_WITNESS_DIR', optional: true },
  /**
   * Audit row 6 (P-08): the file the store computer's own check (`store-computer status`) writes — backup age, the till's
   * queue, the disk, the containers. Read-only here: the box hands it to the office screens with its sync status, which
   * show its red banner. Absent → no store-computer check is shown (a box that is not the shop's store computer).
   */
  { key: 'EDGE_STORE_COMPUTER_STATUS_FILE', optional: true },
  /**
   * The pack the cloud last sent: products and costs, approvals, today's checklist, the assigned
   * wave and route, slots, and the store's own thresholds.
   *
   * Optional, and its absence is a supported state rather than a fault — a freshly installed box
   * has never been told any of it. What it must never do is *default*: an empty approvals list and
   * an unheard-of approvals list mean opposite things, and the manager's day close turns on which.
   */
  { key: 'EDGE_PACK_FILE', optional: true },
  // Optional, and read by the sync agent only. Absent means "sell, queue, sync later".
  { key: 'CLOUD_API_URL', optional: true },
  { key: 'CLOUD_API_TOKEN', secret: true, minLength: 20, optional: true },
];

export type ProbeState = 'live' | 'not_live' | 'ready' | 'not_ready';

export interface Probes {
  /**
   * Liveness — "is this process broken beyond recovery?" Answers **yes** for a process that is
   * merely cut off from its database, because restarting it will not reconnect the database and
   * a restart loop turns one outage into two.
   */
  readonly live: boolean;
  /** Readiness — "should traffic come here?" No, if a dependency it needs is unreachable. */
  readonly ready: boolean;
  readonly detail: string;
}

/**
 * Liveness and readiness, kept apart.
 *
 * Conflating them is the commonest orchestration mistake there is: a container that cannot reach
 * the database fails its liveness probe, gets killed, comes back, still cannot reach the database,
 * and is killed again — so a database outage becomes a crash loop that hides it.
 */
export function probes(input: {
  readonly started: boolean;
  readonly configValid: boolean;
  readonly dependenciesReachable: boolean;
}): Probes {
  const live = input.started && input.configValid;
  return {
    live,
    ready: live && input.dependenciesReachable,
    detail: !input.configValid ? 'configuration is invalid — restarting will not fix it, and the process should never have started'
      : !input.started ? 'still starting'
        : !input.dependenciesReachable ? 'running, but a dependency is unreachable — take it out of rotation rather than restarting it'
          : 'live and ready',
  };
}
