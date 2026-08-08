// API-11 Integration gateway — certified matrix, adapter registration & health (M32-FR-04). Every
// outside system the shop touches — the accounting package, the payment provider, the GST portal,
// WhatsApp, a delivery partner, a scanner — is an adapter, and the point of a MATRIX rather than a
// config file is that an uncertified combination is REFUSED, not merely undocumented. Two refusals are
// absolute with no override anywhere: a payment adapter that declares it retains anything outside the
// permitted list cannot be registered (hard rule #3), and a credential that is a literal rather than a
// `vault://` reference is refused (hard rule #4 — this catches the ones typed into a screen the repo
// secret-scan never sees). And health is "WHEN DID IT LAST WORK", not "is it configured" — an adapter
// failing quietly for nine days is green on any dashboard that reports configuration, and that is the
// normal way an integration dies. No integration failure may reach the till (`posUnaffected`, #1). The
// rule is the pure `checkDevice` / `registerAdapter` / `integrationHealth` in `packages/integration`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  checkDevice, registerAdapter, integrationHealth,
  type CertifiedEntry, type AdapterCategory, type DeviceKind, type AdapterConfig, type AdapterHeartbeat,
} from '../../../packages/integration/src/index';

export type { CertifiedEntry, AdapterConfig, AdapterHeartbeat } from '../../../packages/integration/src/index';

const CATEGORIES: readonly AdapterCategory[] = ['accounting', 'payment', 'tax_portal', 'messaging', 'logistics', 'hardware'];
const DEVICE_KINDS: readonly DeviceKind[] = ['barcode_scanner', 'receipt_printer', 'label_printer', 'weighing_scale', 'cash_drawer', 'customer_display', 'payment_terminal', 'handheld', 'price_kiosk'];
const ENVIRONMENTS = ['sandbox', 'production'] as const;

const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isDateTime = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
const strArray = (v: unknown): readonly string[] | undefined =>
  v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

export interface IntegrationDeps {
  readonly matrix: (tenantId: string) => Promise<readonly CertifiedEntry[]> | readonly CertifiedEntry[];
  readonly adapters: (tenantId: string) => Promise<readonly AdapterConfig[]> | readonly AdapterConfig[];
  readonly heartbeats: (tenantId: string) => Promise<readonly AdapterHeartbeat[]> | readonly AdapterHeartbeat[];
  readonly recordMatrixEntry: (tenantId: string, entry: CertifiedEntry) => Promise<void> | void;
  readonly recordAdapter: (tenantId: string, config: AdapterConfig) => Promise<void> | void;
  readonly recordHeartbeat: (tenantId: string, heartbeatId: string, heartbeat: AdapterHeartbeat) => Promise<void> | void;
  readonly now: () => string;
}

export function integrationRoutes(deps: IntegrationDeps): readonly Route[] {
  return [
    {
      // Add a certified matrix entry — the product's statement that this vendor/model/version is fit.
      api: 'API-11', method: 'POST', path: '/v1/integration/matrix/:entryId',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const entryId = ctx.params['entryId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const versions = strArray(b['versions']);
        if (!CATEGORIES.includes(b['category'] as AdapterCategory) || !isStr(b['vendor']) || !isStr(b['model'])
          || versions === undefined || !isDate(b['certifiedOn'])
          || (b['deviceKind'] !== undefined && !DEVICE_KINDS.includes(b['deviceKind'] as DeviceKind))
          || (b['rbiAuthorised'] !== undefined && typeof b['rbiAuthorised'] !== 'boolean')
          || (b['edgeOnly'] !== undefined && typeof b['edgeOnly'] !== 'boolean')) {
          throw apiError(400, {
            code: 'not_readable_as_a_matrix_entry',
            whatHappened: 'A certified entry needs a category, a vendor, a model, the certified versions (a list, empty means any) and a certified date; deviceKind, rbiAuthorised and edgeOnly are optional.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the entry fields. Nothing was certified.',
          });
        }
        const entry: CertifiedEntry = {
          entryId, category: b['category'] as AdapterCategory, vendor: b['vendor'] as string, model: b['model'] as string,
          versions, certifiedOn: b['certifiedOn'] as string,
          ...(DEVICE_KINDS.includes(b['deviceKind'] as DeviceKind) ? { deviceKind: b['deviceKind'] as DeviceKind } : {}),
          ...(typeof b['rbiAuthorised'] === 'boolean' ? { rbiAuthorised: b['rbiAuthorised'] } : {}),
          ...(typeof b['edgeOnly'] === 'boolean' ? { edgeOnly: b['edgeOnly'] } : {}),
          ...(isStr(b['notes']) ? { notes: b['notes'] } : {}),
        };
        await deps.recordMatrixEntry(ctx.tenantId, entry);
        return { status: 201, body: { entryId, category: entry.category, vendor: entry.vendor, model: entry.model } };
      },
    },
    {
      // Register an adapter. A payment adapter retaining anything off the permitted list, or a literal
      // credential, is REFUSED (422) — no override anywhere. Only a registered config is stored.
      api: 'API-11', method: 'POST', path: '/v1/integration/adapters/:adapterId',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const adapterId = ctx.params['adapterId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const retains = strArray(b['retains']);
        if (!CATEGORIES.includes(b['category'] as AdapterCategory) || !isStr(b['vendor']) || !isStr(b['credentialRef'])
          || !(ENVIRONMENTS as readonly string[]).includes(b['environment'] as string) || typeof b['enabled'] !== 'boolean'
          || retains === undefined
          || (b['queueOnOutage'] !== undefined && typeof b['queueOnOutage'] !== 'boolean')) {
          throw apiError(400, { code: 'not_readable_as_an_adapter', whatHappened: 'An adapter needs a category, a vendor, a vault credentialRef, an environment (sandbox/production) and an enabled flag; retains (payments) and queueOnOutage are optional.', wasItSaved: 'not_saved', nextSafeAction: 'Send the adapter fields. Nothing was registered.' });
        }
        const environment = b['environment'] as 'sandbox' | 'production';
        const config: AdapterConfig = {
          adapterId, tenantId: ctx.tenantId, category: b['category'] as AdapterCategory, vendor: b['vendor'] as string,
          environment, credentialRef: b['credentialRef'] as string, enabled: b['enabled'] as boolean,
          ...(retains.length > 0 ? { retains } : {}),
          ...(typeof b['queueOnOutage'] === 'boolean' ? { queueOnOutage: b['queueOnOutage'] } : {}),
        };
        const result = registerAdapter({ config, matrix: await deps.matrix(ctx.tenantId), environment });
        if (!result.registered) {
          throw apiError(422, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The adapter was not registered. A payment adapter may keep only a provider token and its like, its provider must be RBI-authorised, and every credential is a vault:// reference.',
          });
        }
        await deps.recordAdapter(ctx.tenantId, config);
        return { status: 201, body: { adapterId, category: config.category, environment, registered: true } };
      },
    },
    {
      // Record an adapter heartbeat — a success or a failure with the time it happened. Health is
      // computed from these, from when it last actually WORKED.
      api: 'API-11', method: 'POST', path: '/v1/integration/adapters/:adapterId/heartbeats/:heartbeatId',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const adapterId = ctx.params['adapterId'] ?? '';
        const heartbeatId = ctx.params['heartbeatId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['ok'] !== 'boolean' || !isDateTime(b['at']) || (b['detail'] !== undefined && !isStr(b['detail']))) {
          throw apiError(400, { code: 'not_readable_as_a_heartbeat', whatHappened: 'A heartbeat needs ok (true/false) and a timestamp.', wasItSaved: 'not_saved', nextSafeAction: 'Send { "ok": true|false, "at": "<timestamp>" }. Nothing was recorded.' });
        }
        const heartbeat: AdapterHeartbeat = {
          adapterId, at: b['at'] as string, ok: b['ok'] as boolean,
          ...(isStr(b['detail']) ? { detail: b['detail'] } : {}),
        };
        await deps.recordHeartbeat(ctx.tenantId, heartbeatId, heartbeat);
        return { status: 201, body: { adapterId, heartbeatId, ok: heartbeat.ok, at: heartbeat.at } };
      },
    },
    {
      // May this device be used? A refusal NAMES a working alternative, because one that does not is
      // overridden on a Sunday when the shop needs a printer.
      api: 'API-11', method: 'GET', path: '/v1/integration/devices/check',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const vendor = ctx.query['vendor'];
        const model = ctx.query['model'];
        const deviceKind = ctx.query['deviceKind'];
        if (!isStr(vendor) || !isStr(model) || !DEVICE_KINDS.includes(deviceKind as DeviceKind)) {
          throw apiError(400, { code: 'device_check_needs_vendor_model_kind', whatHappened: 'A device check needs ?vendor=, ?model= and ?deviceKind=.', wasItSaved: 'not_saved', nextSafeAction: 'Send all three. A check reads, it never writes.' });
        }
        const decision = checkDevice({
          vendor, model, deviceKind: deviceKind as DeviceKind, matrix: await deps.matrix(ctx.tenantId),
          ...(isStr(ctx.query['firmware']) ? { firmware: ctx.query['firmware'] } : {}),
        });
        return { status: 200, body: decision };
      },
    },
    {
      // The integration health picture — every adapter by WHEN IT LAST WORKED, worst first, and the
      // till unaffected either way (`posUnaffected` typed true — no integration failure reaches a sale).
      api: 'API-11', method: 'GET', path: '/v1/integration/health',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const report = integrationHealth({
          tenantId: ctx.tenantId, configs: await deps.adapters(ctx.tenantId), heartbeats: await deps.heartbeats(ctx.tenantId), at: deps.now(),
        });
        return { status: 200, body: report };
      },
    },
  ];
}
