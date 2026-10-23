// API-02 the product master's APPROVED substitutes (M03-FR-04 "… substitutes …" · OB-288 P2). One list per product, in
// the order a picker should try them, set by a person with catalogue authority and versioned (a change is a new version,
// hard rule #2). Served to the picker (the store's own staff, through `catalogue.pack.read`) and to the customer app
// (`catalogue.substitutes.read`, held by the storefront login) — the app shows only the shop's own list, names and all.
// The rules are the tested `substituteProblems` in `@sre/product`: no controlled item, nothing unsellable, nothing twice.
//
//   POST /v1/catalogue/products/:productId/substitutes   { substitutes: [productId…], reason } — an empty list clears it
//   GET  /v1/catalogue/products/:productId/substitutes   the list in force and its history (staff)
//   GET  /v1/storefront/products/:productId/substitutes  the list in force, as the app shows it (customer)

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { substituteProblems, currentSubstitutes, canSell, type ProductRecord, type SubstituteList } from '../../../packages/product/src/index';

export interface SubstituteDeps {
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]>;
  readonly lists: (tenantId: string, productId: string) => Promise<readonly SubstituteList[]>;
  readonly recordList: (tenantId: string, list: SubstituteList) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function substituteRoutes(deps: SubstituteDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/:productId/substitutes',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const raw = b['substitutes'];
        if (productId === '' || !Array.isArray(raw) || !raw.every(isStr) || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_substitute_list',
            whatHappened: 'A substitute list needs the product in the path and { substitutes: [productId, …] (in the order to try them; [] clears it), reason }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the list and why. Nothing was saved.',
          });
        }
        const substitutes = (raw as string[]).map((s) => s.trim());
        const products = await deps.products(ctx.tenantId);
        const byId = new Map(products.map((p) => [p.productId, p] as const));
        const { problems, warnings } = substituteProblems({ productId, substitutes, product: (id) => byId.get(id) });
        if (problems.length > 0) {
          if (problems[0]!.refusal === 'product_unknown') throw notFound(`product ${productId}`);
          throw apiError(422, {
            code: problems[0]!.refusal,
            whatHappened: `The substitutes for ${productId} cannot be set: ${problems.map((p) => p.detail).join('; ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Take those products off the list and send it again. Nothing was saved.',
          });
        }
        const standing = currentSubstitutes(await deps.lists(ctx.tenantId, productId), productId);
        if (standing !== undefined && standing.substitutes.join('\u001f') === substitutes.join('\u001f')) {
          return { status: 200, body: { list: standing, warnings, unchanged: true } };
        }
        const list: SubstituteList = {
          productId, version: (standing?.version ?? 0) + 1, substitutes, reason: (b['reason'] as string).trim(), setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordList(ctx.tenantId, list);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'catalogue.substitutes.set', objectType: 'product', objectId: productId, at: list.setAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: standing === undefined ? null : { version: String(standing.version), substitutes: standing.substitutes.join(',') },
          after: { version: String(list.version), substitutes: substitutes.join(',') },
          reason: list.reason, correlationId: `substitutes:${productId}:v${list.version}`,
        });
        return { status: 201, body: { list, warnings } };
      },
    },
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products/:productId/substitutes',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const history = [...(await deps.lists(ctx.tenantId, productId))].sort((a, b) => a.version - b.version);
        const list = currentSubstitutes(history, productId);
        // Said, never an empty list passed off as a decision: "none set" differs from "set to none".
        return { status: 200, body: { productId, list: list ?? null, set: list !== undefined, history } };
      },
    },
    {
      // The app's view: the shop's list in force, each with its name, keeping only what can be sold right now.
      api: 'API-02', method: 'GET', path: '/v1/storefront/products/:productId/substitutes',
      permission: 'catalogue.substitutes.read',
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const list = currentSubstitutes(await deps.lists(ctx.tenantId, productId), productId);
        const byId = new Map((await deps.products(ctx.tenantId)).map((p) => [p.productId, p] as const));
        if (!byId.has(productId)) throw notFound(`product ${productId}`);
        const shown = (list?.substitutes ?? []).map((id) => byId.get(id)).filter((p): p is ProductRecord => p !== undefined && canSell(p))
          .map((p) => ({ productId: p.productId, name: p.name, ...(p.appContent?.nameTa === undefined ? {} : { nameTa: p.appContent.nameTa }) }));
        return { status: 200, body: { productId, substitutes: shown, set: list !== undefined } };
      },
    },
  ];
}
