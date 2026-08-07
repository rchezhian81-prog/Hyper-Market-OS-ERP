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

export type ConfigProblem =
  | 'missing'
  | 'still_the_placeholder'
  | 'too_short_to_be_a_secret'
  | 'not_a_number'
  | 'not_one_of_the_allowed_values';

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
  { key: 'PORT', numeric: true, fallback: '8081' },
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
   * The loopback port the six screens are served from. Optional for the same reason the lane port
   * is: a till does not need to serve the owner's brief, and not opening a socket beats opening
   * one nobody uses.
   */
  { key: 'EDGE_SCREEN_PORT', numeric: true, optional: true },
  /** Where `apps/` lives on this box, so the screens can be served from disk. */
  { key: 'EDGE_APPS_DIR', optional: true },
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
