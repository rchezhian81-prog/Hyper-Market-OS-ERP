// Config version history and rollback (M33-FR-01 · M01-FR-03) — "every setting/flag change is versioned and
// reversible", exposed on the cloud API.
//
// The versioned config engine (`packages/persistence/src/config-store.ts`) already keeps every setting change
// as an append-only version (author, reason, effective date) and can restore a prior value as a NEW version —
// the intervening versions are kept, never deleted (hard rule #2/#6). Setup answers write through it (each
// setting key is a config key). What was missing was the read/rollback surface:
//
//   • VIEW the full version history of a setting — who changed it, to what, when, and why.
//   • ROLL BACK to a prior version — which restores that version's value as a new, audited version (never a
//     destructive edit). A rollback restores a value that was already validated when it was first set, so it
//     is safe by construction; a version that does not exist is refused (404).
//
// Reads are gated `platform.setup.read`; the rollback `platform.setup.write`. No AI writes anything (#5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { ConfigVersionNotFoundError, type ConfigVersionStore } from '../../../packages/persistence/src/config-store';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export interface ConfigHistoryDeps {
  readonly versions: ConfigVersionStore;
  readonly now: () => string;
}

export function configHistoryRoutes(deps: ConfigHistoryDeps): readonly Route[] {
  return [
    {
      // The current value + version of a setting. `null` when the key has never been set (not-set is
      // reported as not-set, never an empty all-clear — P-08).
      api: 'API-11', method: 'GET', path: '/v1/platform/config/:key',
      permission: 'platform.setup.read',
      handler: async (ctx) => {
        const key = ctx.params['key'] ?? '';
        const current = await deps.versions.current(ctx.tenantId, key);
        return { status: 200, body: { key, current: current ?? null } };
      },
    },
    {
      // The FULL version history of a setting, oldest first — the audit trail behind "versioned and
      // reversible". An unknown key is an empty history, not an error.
      api: 'API-11', method: 'GET', path: '/v1/platform/config/:key/history',
      permission: 'platform.setup.read',
      handler: async (ctx) => {
        const key = ctx.params['key'] ?? '';
        const versions = await deps.versions.history(ctx.tenantId, key);
        return { status: 200, body: { key, versions } };
      },
    },
    {
      // ROLL BACK a setting to a prior version — restores that version's value as a NEW, audited version
      // (append-only; the history is never rewritten). A version that does not exist is refused (404).
      api: 'API-11', method: 'POST', path: '/v1/platform/config/:key/rollback',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const key = ctx.params['key'] ?? '';
        const b = ctx.body;
        const toVersion = isObj(b) ? b['toVersion'] : undefined;
        if (typeof toVersion !== 'number' || !Number.isInteger(toVersion) || toVersion < 1 || !isObj(b) || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_rollback',
            whatHappened: 'A config rollback needs { toVersion (a whole version number ≥ 1), reason }.',
            wasItSaved: 'not_saved',
            nextSafeAction: `Check the version against GET /v1/platform/config/${key}/history, then say which to restore and why.`,
          });
        }
        try {
          const restored = await deps.versions.rollback(ctx.tenantId, key, toVersion, ctx.userId, (b['reason'] as string).trim(), deps.now());
          return { status: 200, body: { key, restored } };
        } catch (e) {
          if (e instanceof ConfigVersionNotFoundError) {
            throw apiError(404, {
              code: 'config_version_not_found',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: `Roll back to a version that exists — see GET /v1/platform/config/${key}/history.`,
            });
          }
          throw e;
        }
      },
    },
  ];
}
