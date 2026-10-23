// API-02 the category report with variants rolled up (M03-FR-01 "… brand, manufacturer, variants …" · OB-288 P2).
// `GET /v1/catalogue/reports/variants?categoryId=` — every product in the category (and the categories beneath it on head
// office's own list), each variant rolled up under its parent, with the brand and the manufacturer, and a count per
// manufacturer; a manufacturer nobody recorded is "not recorded", never blank. An unknown category is a 404 (an unknown
// category is not an empty one). Without `categoryId`: the whole master. The fold is the tested `rollUpVariants`.

import type { Route } from '../../kernel/src/index';
import { notFound } from '../../kernel/src/index';
import { rollUpVariants, type ProductRecord, type Category } from '../../../packages/product/src/index';

export interface VariantReportDeps {
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]>;
  readonly categories: (tenantId: string) => Promise<readonly Category[]>;
  readonly now: () => string;
}

export function variantReportRoutes(deps: VariantReportDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/reports/variants',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const all = await deps.products(ctx.tenantId);
        const categoryId = ctx.query['categoryId'];
        let inCategory = all;
        let included: readonly string[] | null = null;
        if (categoryId !== undefined && categoryId !== '') {
          const categories = await deps.categories(ctx.tenantId);
          if (!categories.some((c) => c.categoryId === categoryId)) throw notFound(`category ${categoryId}`);
          const within = new Set<string>([categoryId]);
          for (let grew = true; grew;) {
            grew = false;
            for (const c of categories) if (c.parentId !== null && within.has(c.parentId) && !within.has(c.categoryId)) { within.add(c.categoryId); grew = true; }
          }
          inCategory = all.filter((p) => p.primaryCategoryId !== null && within.has(p.primaryCategoryId));
          included = [...within].sort();
        }
        const rollup = rollUpVariants(inCategory, all);
        return {
          status: 200,
          body: {
            ...rollup, categoryId: categoryId ?? null, categoriesIncluded: included,
            byManufacturer: rollup.byManufacturer.map((m) => ({ ...m, manufacturer: m.manufacturer ?? 'not recorded', recorded: m.manufacturer !== null })),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
