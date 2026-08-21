// API-11 Managed secrets, rotation and review (M32-FR-03 · SEC-04 · hard rule #4). The cloud surface for
// the credential lifecycle — and it holds **no secret material at any point**: the routes carry a vault
// REFERENCE (`vault://payments/live#v4`), an owner and some dates, never the key. That is the design of
// `packages/integration/src/secrets`, and this skin keeps the same discipline: nothing here has a field
// that could hold a value.
//
//   • **register** a secret reference (kind, vault ref, owner, what it protects, rotation policy, env);
//   • **rotate** with an OVERLAP — the old version stays valid for a grace period so an edge device that
//     has not synced keeps working; a rotation with no grace is refused (that is `revoke`, deliberately a
//     different action);
//   • **revoke** IMMEDIATELY for a compromise, and **name what will break before it breaks**;
//   • **review** the inventory — findings phrased by what the secret protects, worst first: a revoked
//     secret a live adapter still points at, or a sandbox credential wired into production, are the
//     blocking ones.
//
// The rules are the pure `reviewSecrets`/`rotateSecret`/`revokeSecret` in `@sre/integration` (the
// `services-run-on-their-tested-engine` guardrail). Managing is gated `platform.setup.write`; reading /
// reviewing is `platform.setup.read` (owner-scoped — a secret inventory is not a general read).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  reviewSecrets, rotateSecret, revokeSecret,
  type SecretRef, type SecretKind,
} from '../../../packages/integration/src/index';

export type { SecretRef } from '../../../packages/integration/src/index';

const KINDS: readonly SecretKind[] = ['payment_provider', 'gst_portal', 'messaging_provider', 'logistics_provider', 'accounting_export', 'webhook_signing', 'service_identity'];

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
// A vault REFERENCE, never a raw value — must be a scheme URI (e.g. vault://...), so a plaintext key
// pasted into this field is refused rather than stored (hard rule #4).
const isVaultRef = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9+.-]*:\/\/.+/.test(v);
const isEnv = (v: unknown): v is 'sandbox' | 'production' => v === 'sandbox' || v === 'production';

interface RawRef { readonly adapterId: string; readonly vaultRef: string; readonly environment: 'sandbox' | 'production' }
const isRef = (v: unknown): v is RawRef => isObj(v) && isStr(v['adapterId']) && isStr(v['vaultRef']) && isEnv(v['environment']);

export interface SecretsDeps {
  /** The latest state of one secret reference, or undefined. */
  readonly secret: (tenantId: string, secretId: string) => Promise<SecretRef | undefined> | SecretRef | undefined;
  /** The whole inventory — latest state per secret id. */
  readonly all: (tenantId: string) => Promise<readonly SecretRef[]> | readonly SecretRef[];
  /** Record a secret reference's latest state (registration / rotation / revocation). */
  readonly record: (tenantId: string, secret: SecretRef) => Promise<void> | void;
  readonly now: () => string;
}

export function secretsRoutes(deps: SecretsDeps): readonly Route[] {
  return [
    {
      // Review the inventory. Body: { referencedBy?, warnWithinDays?, asAt? }. Findings phrased by what
      // each secret protects, worst first; a revoked-still-referenced or a sandbox-in-production blocks.
      // Registered BEFORE the `/:secretId` route so this static path is matched first, not as secretId.
      api: 'API-11', method: 'POST', path: '/v1/integration/secrets/review',
      permission: 'platform.setup.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const refs = b['referencedBy'];
        if (refs !== undefined && (!Array.isArray(refs) || !refs.every(isRef))) {
          throw apiError(400, {
            code: 'not_readable_as_a_review',
            whatHappened: 'A review takes an optional referencedBy[] of { adapterId, vaultRef, environment } and an optional warnWithinDays.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the live adapter references (or none). A review reads, it never writes.',
          });
        }
        const review = reviewSecrets({
          secrets: await deps.all(ctx.tenantId),
          ...(Array.isArray(refs) ? { referencedBy: refs as RawRef[] } : {}),
          ...(isPosInt(b['warnWithinDays']) ? { warnWithinDays: b['warnWithinDays'] } : {}),
          asAt: isStr(b['asAt']) ? (b['asAt'] as string).slice(0, 10) : deps.now().slice(0, 10),
        });
        return { status: 200, body: review };
      },
    },
    {
      // Register a secret REFERENCE. Body: { kind, vaultRef, owner, protects, rotateEveryDays,
      // environment, version? }. No value — a raw key in vaultRef is refused (it must be a scheme URI).
      api: 'API-11', method: 'POST', path: '/v1/integration/secrets/:secretId',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const secretId = (ctx.params['secretId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (secretId === '' || typeof b['kind'] !== 'string' || !KINDS.includes(b['kind'] as SecretKind)
          || !isVaultRef(b['vaultRef']) || !isStr(b['owner']) || !isStr(b['protects'])
          || !isPosInt(b['rotateEveryDays']) || !isEnv(b['environment'])
          || (b['version'] !== undefined && !isPosInt(b['version']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_secret_reference',
            whatHappened: `A secret reference needs { kind (${KINDS.join('|')}), vaultRef (a scheme URI like vault://…, NEVER the key), owner, protects, rotateEveryDays (>0), environment (sandbox|production) }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the vault REFERENCE and its policy — never a secret value.',
          });
        }
        const secret: SecretRef = {
          secretId, tenantId: ctx.tenantId, kind: b['kind'] as SecretKind, vaultRef: b['vaultRef'] as string,
          version: isPosInt(b['version']) ? b['version'] : 1, state: 'active', createdOn: deps.now().slice(0, 10),
          owner: b['owner'] as string, protects: b['protects'] as string,
          rotateEveryDays: b['rotateEveryDays'] as number, environment: b['environment'] as 'sandbox' | 'production',
          ...(isStr(b['lastRotatedOn']) ? { lastRotatedOn: b['lastRotatedOn'] as string } : {}),
        };
        await deps.record(ctx.tenantId, secret);
        return { status: 201, body: { secretId, kind: secret.kind, version: secret.version, state: secret.state } };
      },
    },
    {
      // Rotate WITH an overlap. Body: { newVaultRef, graceDays (>0), rotatedBy? }. The previous version
      // stays valid until the grace ends; a no-grace rotation is refused (use revocation for a compromise).
      api: 'API-11', method: 'POST', path: '/v1/integration/secrets/:secretId/rotation',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const secretId = (ctx.params['secretId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isVaultRef(b['newVaultRef']) || typeof b['graceDays'] !== 'number' || !Number.isSafeInteger(b['graceDays'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_rotation',
            whatHappened: 'A rotation needs { newVaultRef (a scheme URI), graceDays } — the previous version stays valid for graceDays so unsynced edge devices keep working.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the new vault reference and a positive graceDays. A hard cut is a revocation.',
          });
        }
        const current = await deps.secret(ctx.tenantId, secretId);
        if (current === undefined) throw notFound(`secret ${secretId}`);
        const result = rotateSecret({
          secret: current, newVaultRef: b['newVaultRef'] as string,
          rotatedBy: isStr(b['rotatedBy']) ? b['rotatedBy'] as string : ctx.userId,
          graceDays: b['graceDays'] as number, at: deps.now(),
        });
        if (!result.rotated || result.next === undefined) {
          throw apiError(409, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: result.outcome === 'no_grace_on_rotation'
              ? 'A rotation must overlap. If this is a compromise, revoke it instead and accept the breakage.'
              : 'Resolve the reason above and try again. Nothing was changed.',
          });
        }
        await deps.record(ctx.tenantId, result.next);
        return { status: 200, body: result };
      },
    },
    {
      // Revoke IMMEDIATELY (a compromise) — no overlap, and it NAMES what will break before it happens.
      // Body: { reason, revokedBy?, referencedBy?: [{ adapterId, vaultRef, environment }] }.
      api: 'API-11', method: 'POST', path: '/v1/integration/secrets/:secretId/revocation',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const secretId = (ctx.params['secretId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const refs = b['referencedBy'];
        if (!isStr(b['reason']) || (refs !== undefined && (!Array.isArray(refs) || !refs.every(isRef)))) {
          throw apiError(400, {
            code: 'not_readable_as_a_revocation',
            whatHappened: 'A revocation needs { reason } and an optional referencedBy[] of { adapterId, vaultRef, environment } so what breaks can be named.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the reason (and the live adapter references if known).',
          });
        }
        const current = await deps.secret(ctx.tenantId, secretId);
        if (current === undefined) throw notFound(`secret ${secretId}`);
        const result = revokeSecret({
          secret: current, reason: b['reason'] as string,
          revokedBy: isStr(b['revokedBy']) ? b['revokedBy'] as string : ctx.userId,
          ...(Array.isArray(refs) ? { referencedBy: refs as RawRef[] } : {}),
          at: deps.now(),
        });
        await deps.record(ctx.tenantId, result.revoked);
        return { status: 200, body: result };
      },
    },
    {
      // The secret inventory — latest state per secret (references only, never values).
      api: 'API-11', method: 'GET', path: '/v1/integration/secrets',
      permission: 'platform.setup.read',
      handler: async (ctx) => {
        const secrets = await deps.all(ctx.tenantId);
        return { status: 200, body: { secrets, count: secrets.length } };
      },
    },
  ];
}
