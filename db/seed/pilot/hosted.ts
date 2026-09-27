// Pilot seed — HOSTED client (demo-pilot stand-up, runbook §8). Non-production, synthetic data only.
//
// The appliers in `apply.ts` take an injected `SeedClient`. In tests that is `apiHarness`, in-process.
// On the hosted demo box it is THIS: every business record goes over real HTTP to the live API, as a
// named demo user carrying a token minted with the pilot's test-IdP key — so it passes the same
// authentication, permission, entitlement, step-up and idempotency guards a person's request does.
//
// The three identity hooks (genesis owner, role logins, entitlements) are the one exception, exactly as
// `apply.ts` documents: a brand-new tenant has nobody who could approve a grant, so they are laid down
// the way tenant provisioning seeds its initial admin set — the audited `RoleGranted` /
// `TenantEntitlementSet` events, appended through the event store, with `pilot/seed` provenance and the
// name of the PERSON who ran the seed, so an access review can see them for what they were.
//
// Lives under db/seed — never services/, apps/ or edge/ — so the `no-test-idp-in-production`
// guardrail still proves nothing in the running product can mint a token.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { seedGenesisOwner } from '../../../services/api/src/access';
import { OWNER_ROLE_ID } from '../../../services/api/src/roles';
import { STREAM } from '../../../services/api/src/adapters';
import { LocalIdp } from '../../../tests/support/local-idp';
import type { SeedClient, SeedResponse } from './apply';
import { PILOT_DEMO_TENANT } from './dataset';

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface HostedSeedConfig {
  /** The live API origin, e.g. `http://127.0.0.1:8081` or `https://<demo-host>` (no trailing slash). */
  readonly baseUrl: string;
  /** The pilot test-IdP policy — the SAME values the API is configured to verify with. */
  readonly idp: { readonly secret: string; readonly issuer: string; readonly audience: string };
  /** The pilot database's event store, for the three identity hooks only. */
  readonly store: EventStore;
  /** The person running the seed — recorded as requester/approver on every provisioned grant. */
  readonly operator: string;
  /** The tenant being seeded. Anything but the synthetic demo tenant is refused. */
  readonly tenantId: string;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  /** Waits between rate-limit retries; injectable so a test does not really sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How many times one call is retried when the API says "slow down" (429). Default 5. */
  readonly maxRateLimitRetries?: number;
}

/** Why a hosted seed must not start. Empty = safe to run. */
export function hostedSeedRefusals(config: {
  readonly tenantId: string;
  readonly operator: string;
  readonly migrationTargetKind?: string;
}): string[] {
  const out: string[] = [];
  if (config.tenantId !== PILOT_DEMO_TENANT) {
    out.push(`tenant "${config.tenantId}" is not the synthetic demo tenant "${PILOT_DEMO_TENANT}" — the hosted seed only ever writes demo data`);
  }
  if (config.migrationTargetKind === 'production') {
    out.push('MIGRATION_TARGET_KIND is "production" — the demo seed never runs against a production-marked environment (hard rule #7)');
  }
  if (config.operator.trim() === '') {
    out.push('no operator named — every provisioned login must record the person who ran the seed (no anonymous grants)');
  }
  return out;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A `SeedClient` that drives the LIVE API over HTTP. Refuses to construct for a non-demo tenant. */
export function hostedSeedClient(config: HostedSeedConfig): SeedClient {
  const refusals = hostedSeedRefusals(config);
  if (refusals.length > 0) throw new Error(`hosted seed refused: ${refusals.join('; ')}`);

  const idp = new LocalIdp({ ...config.idp, now: () => (config.now?.() ?? new Date()).getTime() });
  const doFetch: FetchLike = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = config.sleep ?? defaultSleep;
  const maxRetries = config.maxRateLimitRetries ?? 5;
  const nowIso = (): string => (config.now?.() ?? new Date()).toISOString();
  const origin = config.baseUrl.replace(/\/+$/, '');

  const guardTenant = (tenantId: string): void => {
    if (tenantId !== config.tenantId) throw new Error(`hosted seed refused: call for tenant "${tenantId}" outside the seeded demo tenant`);
  };

  const provenance = (at: string) => ({ requestedBy: `pilot-seed:${config.operator}`, approvedBy: `pilot-seed:${config.operator}`, requestedAt: at });

  return {
    async request({ method, path, userId, tenantId, branchId, body, idempotencyKey, query }): Promise<SeedResponse> {
      guardTenant(tenantId);
      const qs = query === undefined ? '' : `?${new URLSearchParams(query as Record<string, string>).toString()}`;
      for (let attempt = 0; ; attempt += 1) {
        // A fresh, short-lived token per call: a slow seed never trips on expiry, and the default
        // fresh MFA-backed auth_time satisfies a step-up route exactly as a real re-auth would.
        const token = idp.issue({ sub: userId, tenantId, ...(branchId === undefined ? {} : { branchId }), ttlSeconds: 300 });
        const res = await doFetch(`${origin}${path}${qs}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (res.status === 429 && attempt < maxRetries) {
          const retryAfter = Number(res.headers.get('retry-after') ?? '1');
          await sleep(Math.max(1, Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
          continue;
        }
        const text = await res.text();
        let parsed: unknown = text;
        try { parsed = text === '' ? undefined : JSON.parse(text); } catch { /* keep the raw text */ }
        return { status: res.status, body: parsed };
      }
    },

    async seedOwner(tenantId, userId) {
      guardTenant(tenantId);
      await seedGenesisOwner(config.store, OWNER_ROLE_ID, tenantId, userId, nowIso());
    },

    async provisionRole(tenantId, userId, roleId) {
      guardTenant(tenantId);
      const at = nowIso();
      await config.store.append(tenantId, STREAM.identity, makeEvent({
        id: `grant-${roleId}-${userId}`,
        type: 'RoleGranted',
        occurredAt: at,
        // Stable key: re-running the seed provisions each login once, never twice.
        idempotencyKey: `grant-${tenantId}-${roleId}-${userId}`,
        source: 'pilot/seed',
        payload: {
          userId, roleId, branchScope: 'all',
          request: { grantId: `${roleId}-${userId}`, userId, roleId, branchScope: 'all', ...provenance(at) },
        },
      }));
    },

    async enableFeature(tenantId, feature) {
      guardTenant(tenantId);
      const at = nowIso();
      await config.store.append(tenantId, STREAM.platform, makeEvent({
        id: `entitlement-${feature}-seed`,
        type: 'TenantEntitlementSet',
        occurredAt: at,
        // Stable key (unlike the live API's time-keyed one): re-seeding does not stack duplicate facts.
        idempotencyKey: `entitlement-${tenantId}-${feature}-pilot-seed`,
        source: 'pilot/seed',
        payload: { feature, enabled: true, at, by: `pilot-seed:${config.operator}` },
      }));
    },
  };
}
