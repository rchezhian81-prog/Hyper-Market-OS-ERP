// API-11 Integration gateway — connector mapping validation (M32-FR-02, the transport-free half). What
// makes integrations rot is not any single failure but that failures become INVISIBLE: a mapping that
// drops an unrecognised field looks like a clean run, right up until a tax code has not reached the
// accounts package for a quarter. So a mapping is VALIDATED before it is trusted: an unmapped source
// field is an exception, not a silently dropped field; a lookup that misses is refused rather than
// mapped to blank (an unknown ledger code mapped to nothing produces a journal that posts and is
// wrong); and a destination-required field the mapping produced nothing for is named. The rule is the
// pure `applyMapping` in `packages/integration`.
//
// NOTE: this is the mapping half of the connector. The actual DELIVERY — the retry/back-off/dead-letter
// drain against a real destination — is a worker + transport concern (`drainConnector` takes an injected
// transport), not a cloud-API endpoint; it stays with the edge/worker that owns the network path.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { applyMapping, type Mapping, type FieldRule } from '../../../packages/integration/src/index';

export type { Mapping } from '../../../packages/integration/src/index';

const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strArray = (v: unknown): readonly string[] | undefined =>
  v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** Read one field rule, refusing anything that is not exactly a copy, a constant or a lookup. */
function readRule(v: unknown): FieldRule | undefined {
  if (!isObj(v)) return undefined;
  if (v['kind'] === 'copy' && isStr(v['from']) && isStr(v['to'])) return { kind: 'copy', from: v['from'] as string, to: v['to'] as string };
  if (v['kind'] === 'constant' && isStr(v['to']) && (typeof v['value'] === 'string' || typeof v['value'] === 'number')) {
    return { kind: 'constant', to: v['to'] as string, value: v['value'] as string | number };
  }
  if (v['kind'] === 'lookup' && isStr(v['from']) && isStr(v['to']) && isObj(v['table'])
    && Object.values(v['table']).every((x) => typeof x === 'string')) {
    return { kind: 'lookup', from: v['from'] as string, to: v['to'] as string, table: v['table'] as Record<string, string> };
  }
  return undefined;
}

export interface ConnectorMappingDeps {
  readonly mapping: (tenantId: string, connectorId: string, version: string) => Promise<Mapping | undefined> | Mapping | undefined;
  readonly recordMapping: (tenantId: string, mapping: Mapping) => Promise<void> | void;
  readonly now: () => string;
}

export function connectorRoutes(deps: ConnectorMappingDeps): readonly Route[] {
  return [
    {
      // Register a connector mapping — the copy/constant/lookup rules and the fields the destination
      // requires. A rule that is not exactly one of the three kinds is refused (a malformed mapping is
      // how a field silently stops being carried).
      api: 'API-11', method: 'POST', path: '/v1/integration/connectors/:connectorId/mappings/:version',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const connectorId = ctx.params['connectorId'] ?? '';
        const version = ctx.params['version'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const required = strArray(b['required']);
        if (!Array.isArray(b['rules']) || required === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_mapping', whatHappened: 'A mapping needs a list of rules and the destination-required fields.', wasItSaved: 'not_saved', nextSafeAction: 'Send { "rules": [...], "required": [...] }. Nothing was registered.' });
        }
        const rules: FieldRule[] = [];
        for (const raw of b['rules']) {
          const rule = readRule(raw);
          if (rule === undefined) {
            throw apiError(400, { code: 'not_readable_as_a_rule', whatHappened: 'Every rule must be exactly a copy ({kind, from, to}), a constant ({kind, to, value}) or a lookup ({kind, from, to, table}).', wasItSaved: 'not_saved', nextSafeAction: 'Correct the rules. Nothing was registered.' });
          }
          rules.push(rule);
        }
        const mapping: Mapping = { connectorId, version, rules, required };
        await deps.recordMapping(ctx.tenantId, mapping);
        return { status: 201, body: { connectorId, version, rules: rules.length, required } };
      },
    },
    {
      // Validate a source record against the registered mapping — BEFORE it is trusted in a live feed.
      // An unmapped field, a lookup miss or a missing required field is named rather than run silently.
      api: 'API-11', method: 'POST', path: '/v1/integration/connectors/:connectorId/mappings/:version/validate',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const connectorId = ctx.params['connectorId'] ?? '';
        const version = ctx.params['version'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const ignore = strArray(b['ignore']);
        if (!isObj(b['source']) || ignore === undefined) {
          throw apiError(400, { code: 'validate_needs_a_source', whatHappened: 'Validation needs a source record (an object) and an optional list of fields to ignore.', wasItSaved: 'not_saved', nextSafeAction: 'Send { "source": {...} }. A validation reads, it never writes.' });
        }
        const mapping = await deps.mapping(ctx.tenantId, connectorId, version);
        if (mapping === undefined) throw notFound(`connector mapping ${connectorId}@${version}`);
        const result = applyMapping({ mapping, source: b['source'] as Record<string, unknown>, ignore });
        return { status: 200, body: result };
      },
    },
    {
      // Read the registered mapping — what the live feed will run under.
      api: 'API-11', method: 'GET', path: '/v1/integration/connectors/:connectorId/mappings/:version',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const connectorId = ctx.params['connectorId'] ?? '';
        const version = ctx.params['version'] ?? '';
        const mapping = await deps.mapping(ctx.tenantId, connectorId, version);
        if (mapping === undefined) throw notFound(`connector mapping ${connectorId}@${version}`);
        return { status: 200, body: mapping };
      },
    },
  ];
}
