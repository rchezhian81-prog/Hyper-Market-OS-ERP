// API-02 own-barcode bundle products (M03-FR-02 "… and bundles" · OB-306 "both" — this is the bundle PRODUCT; the price
// offer "3 together for ₹199" is a `bundle_price` promotion). A bundle is a product of its own — published on the product
// master with its own SKU, barcode, price and HSN — and its DEFINITION here names the components one bundle holds. Selling
// one takes stock off each component (the till and head office's sale intake explode it by the version in force when it
// was sold: `explodeBundleLine`). The rules are the tested `bundleProblems` in `@sre/product`.
//
//   POST /v1/catalogue/bundles/:bundleProductId    { components: [{ productId, quantityMinor }], reason } — a new version
//   GET  /v1/catalogue/bundles/:bundleProductId    the version in force and its history
//   GET  /v1/catalogue/bundles                     every bundle's version in force — what the pack carries to the tills
//
// Versioned and append-only (hard rule #2): a change is a new version; a re-send of the same components is no new version.
// Authoring is `catalogue.pack.publish`; reads `catalogue.pack.read`. Every version is sealed in the audit trail.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { bundleProblems, type BundleComponent, type BundleDefinition, type ProductRecord } from '../../../packages/product/src/index';

export interface BundleDeps {
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]>;
  /** Every version of every bundle definition, oldest first. */
  readonly definitions: (tenantId: string) => Promise<readonly BundleDefinition[]>;
  readonly recordDefinition: (tenantId: string, d: BundleDefinition) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Each bundle's latest version. */
export function currentBundles(history: readonly BundleDefinition[]): readonly BundleDefinition[] {
  const latest = new Map<string, BundleDefinition>();
  for (const d of history) {
    const cur = latest.get(d.bundleProductId);
    if (cur === undefined || d.version > cur.version) latest.set(d.bundleProductId, d);
  }
  return [...latest.values()].sort((a, b) => (a.bundleProductId < b.bundleProductId ? -1 : 1));
}

const sameComponents = (a: readonly BundleComponent[], b: readonly BundleComponent[]): boolean =>
  a.length === b.length && [...a].sort((x, y) => x.productId.localeCompare(y.productId))
    .every((c, i) => { const o = [...b].sort((x, y) => x.productId.localeCompare(y.productId))[i]!; return o.productId === c.productId && o.quantityMinor === c.quantityMinor; });

export function bundleRoutes(deps: BundleDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/bundles',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const bundles = currentBundles(await deps.definitions(ctx.tenantId));
        return { status: 200, body: { bundles, count: bundles.length, asAt: deps.now() } };
      },
    },
    {
      api: 'API-02', method: 'POST', path: '/v1/catalogue/bundles/:bundleProductId',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const bundleProductId = (ctx.params['bundleProductId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const raw = b['components'];
        const readable = Array.isArray(raw) && raw.every((c) => c !== null && typeof c === 'object' && isStr((c as Record<string, unknown>)['productId']) && typeof (c as Record<string, unknown>)['quantityMinor'] === 'number');
        if (bundleProductId === '' || !readable || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_bundle',
            whatHappened: 'A bundle definition needs the bundle product in the path and { components: [{ productId, quantityMinor }], reason } — what one bundle holds, in each component\'s base unit (pieces, grams or millilitres), and why.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the components and a reason. Nothing was saved.',
          });
        }
        const components = (raw as Record<string, unknown>[]).map((c) => ({ productId: (c['productId'] as string).trim(), quantityMinor: c['quantityMinor'] as number }));
        const [products, history] = await Promise.all([deps.products(ctx.tenantId), deps.definitions(ctx.tenantId)]);
        const byId = new Map(products.map((p) => [p.productId, p] as const));
        const current = currentBundles(history);
        const problems = bundleProblems({ bundleProductId, components, product: (id) => byId.get(id), bundles: current });
        if (problems.length > 0) {
          throw apiError(422, {
            code: problems[0]!.refusal,
            whatHappened: `The bundle ${bundleProductId} cannot be defined: ${problems.map((p) => p.detail).join('; ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the components and send again. Nothing was saved.',
          });
        }
        const standing = current.find((d) => d.bundleProductId === bundleProductId);
        if (standing !== undefined && sameComponents(standing.components, components)) {
          return { status: 200, body: { bundle: standing, unchanged: true } };
        }
        const definition: BundleDefinition = {
          bundleProductId, version: (standing?.version ?? 0) + 1, components, reason: (b['reason'] as string).trim(),
          definedBy: ctx.userId, definedAt: deps.now(),
        };
        await deps.recordDefinition(ctx.tenantId, definition);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'catalogue.bundle.define', objectType: 'product', objectId: bundleProductId, at: definition.definedAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: standing === undefined ? null : { version: String(standing.version), components: standing.components.map((c) => `${c.productId}x${c.quantityMinor}`).join(',') },
          after: { version: String(definition.version), components: components.map((c) => `${c.productId}x${c.quantityMinor}`).join(',') },
          reason: definition.reason, correlationId: `bundle:${bundleProductId}:v${definition.version}`,
        });
        return { status: 201, body: { bundle: definition } };
      },
    },
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/bundles/:bundleProductId',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const bundleProductId = (ctx.params['bundleProductId'] ?? '').trim();
        const history = (await deps.definitions(ctx.tenantId)).filter((d) => d.bundleProductId === bundleProductId).sort((a, b) => a.version - b.version);
        if (history.length === 0) throw notFound(`bundle ${bundleProductId}`);
        return { status: 200, body: { bundle: history.at(-1), history } };
      },
    },
  ];
}
