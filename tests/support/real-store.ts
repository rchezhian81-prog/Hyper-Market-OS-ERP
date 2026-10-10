// The REAL cloud for a connected store run (SP-9): the production API assembly (`startApi`, the same code the container
// runs) on an ephemeral port, over a real PostgreSQL, as the non-superuser application role row-level security insists
// on — plus the small set of calls a connected suite needs around it: a token for a named person, an authenticated
// request, and a role grant made the way the product makes one (two people, one of whom holds what is granted).
//
// Synthetic data only (hard rule #7): the tenant id, the people and the products are invented here. Nothing in this file
// mints a token for production — the identity provider is the TEST one (`tests/support/api-harness.ts`), whose secret and
// issuer are handed to the API as its configuration exactly as a deployment's identity provider would be.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startApi, type RunningApi, type ApiProviders } from '../../services/api/src/main';
import type { NotificationWorker } from '../../services/customer/src/notification-worker';
import type { OpsAlertWorker } from '../../services/platform/src/ops-alert-worker';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { seedInitialAdmins } from '../../services/api/src/access';
import { OWNER_ROLE_ID, STORE_MANAGER_ROLE_ID } from '../../services/api/src/roles';
import { TEST_IDP } from './api-harness';
import { ensureAppRole, asRole } from './db-app-role';

/** The application role the connected suites run the API as — created once per database, never a superuser. */
export const CONNECTED_APP_ROLE = 'sre_app_connected';

export interface RealCloudRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  /** Whose token the request carries. */
  readonly userId: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export interface RealCloudReply {
  readonly status: number;
  readonly body: unknown;
}

export interface RealCloud {
  readonly baseUrl: string;
  readonly port: number;
  readonly tenantId: string;
  readonly owner: string;
  readonly packSigningKey: string;
  /** A signed token for `userId` in this tenant — what a signed-in person (or the store box) presents. */
  token(userId: string): string;
  request(input: RealCloudRequest): Promise<RealCloudReply>;
  /**
   * Grant `roleId` to `userId` the way the product does: REQUESTED by one signed-in person (`u-hr`, the second initial
   * admin) and APPROVED by another who already holds every permission the role carries (the owner) — two acts.
   */
  grant(userId: string, roleId: string, requestedBy?: string): Promise<void>;
  /** Everything the API printed — the boot lines, the structured request log, every refusal. */
  readonly said: readonly string[];
  /** PA-08: the notification sender the API started on its own timer (only when a provider was handed in). */
  readonly notificationWorker?: NotificationWorker;
  /** PA-12: the ops-alert worker the API started on its own timer. */
  readonly opsAlertWorker?: OpsAlertWorker;
  stop(): Promise<void>;
}

export interface RealCloudInput {
  /** The platform connection (a superuser is fine here: it runs the migrations and creates the application role). */
  readonly databaseUrl: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly packSigningKey: string;
  /** PA-08: outbound providers handed to `startApi` exactly as a deployment would (tests: the recording adapter). */
  readonly providers?: ApiProviders;
}

/**
 * Migrate the database, make sure the application role exists, and start the production API assembly as that role on an
 * ephemeral port, with the test identity provider's policy as its token configuration and the genesis owner seeded.
 */
/** The second initial admin: the person who may ASK for roles; the owner approves (Wave 2b · PA-03). */
const REQUESTER = 'u-hr';

export async function startRealCloud(input: RealCloudInput): Promise<RealCloud> {
  const platform = new Pool({ connectionString: input.databaseUrl, max: 2, options: '-c app.tenant_id=*' });
  try {
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(platform), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    await ensureAppRole(platform, CONNECTED_APP_ROLE);
    // The initial admin SET (Wave 2b · PA-03): a role grant is two people's acts, so a shop starts with two — the owner
    // and an HR / store-manager who may REQUEST roles — laid down once by the operator, exactly as
    // `scripts/bootstrap-tenant.ts --admin` does. The API's own genesis step below then finds the tenant bootstrapped.
    await seedInitialAdmins(new SqlEventStore(pgPoolClient(platform)), input.tenantId,
      [{ userId: input.owner, roleId: OWNER_ROLE_ID }, { userId: REQUESTER, roleId: STORE_MANAGER_ROLE_ID }], 'tests/real-store', new Date().toISOString());
  } finally {
    await platform.end();
  }

  const said: string[] = [];
  const say = (text: string): void => { said.push(text.replace(/\n$/, '')); };
  const policy = TEST_IDP.policy();
  const running: RunningApi | undefined = await startApi({
    DATABASE_URL: asRole(input.databaseUrl, CONNECTED_APP_ROLE),
    PACK_SIGNING_KEY: input.packSigningKey,
    IDP_SIGNING_KEY: policy.secret,
    IDP_ISSUER: policy.issuer,
    IDP_AUDIENCE: policy.audience,
    PORT: '0',
    NODE_ENV: 'test',
    MIGRATION_TARGET_KIND: 'rehearsal',
    BOOTSTRAP_OWNER_TENANT_ID: input.tenantId,
    BOOTSTRAP_OWNER_USER_ID: input.owner,
  }, say, say, input.providers ?? {});
  if (running === undefined) throw new Error(`the real API refused to start:\n${said.join('\n')}`);

  const baseUrl = `http://127.0.0.1:${running.port}`;
  const token = (userId: string): string => TEST_IDP.issue({ sub: userId, tenantId: input.tenantId });
  const request = async (r: RealCloudRequest): Promise<RealCloudReply> => {
    const response = await fetch(`${baseUrl}${r.path}`, {
      method: r.method,
      headers: {
        authorization: `Bearer ${token(r.userId)}`,
        ...(r.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(r.idempotencyKey === undefined ? {} : { 'idempotency-key': r.idempotencyKey }),
      },
      ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = text === '' ? null : JSON.parse(text); } catch { /* not JSON — hand the text back as it came */ }
    return { status: response.status, body };
  };

  return {
    baseUrl,
    port: running.port,
    tenantId: input.tenantId,
    owner: input.owner,
    packSigningKey: input.packSigningKey,
    said,
    ...(running.notificationWorker === undefined ? {} : { notificationWorker: running.notificationWorker }),
    ...(running.opsAlertWorker === undefined ? {} : { opsAlertWorker: running.opsAlertWorker }),
    token,
    request,
    grant: async (userId, roleId, requestedBy = REQUESTER) => {
      // Two acts (Wave 2b · PA-03): the requester asks under their own sign-in, the owner approves under theirs.
      const grantId = `grant-${userId}-${roleId}`;
      const asked = await request({
        method: 'POST', path: '/v1/identity/grants', userId: requestedBy, idempotencyKey: `${grantId}-ask`,
        body: { grantId, userId, roleId, branchScope: 'all', reason: 'the practice cast' },
      });
      if (asked.status !== 202) throw new Error(`requesting ${roleId} for ${userId} failed: ${asked.status} ${JSON.stringify(asked.body)}`);
      const reply = await request({ method: 'POST', path: `/v1/identity/grants/${grantId}/approve`, userId: input.owner, idempotencyKey: `${grantId}-approve`, body: {} });
      if (reply.status !== 201) throw new Error(`granting ${roleId} to ${userId} failed: ${reply.status} ${JSON.stringify(reply.body)}`);
    },
    stop: () => running.stop(),
  };
}
