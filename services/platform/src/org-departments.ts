// Departments own product categories, and a report filtered to a department returns only that department's data
// (M01-FR-01 acceptance · M02-FR-02 department scope · §28 · P-08).
//
// Before this the org `department` node was never used: a report's "department" meant a category id
// (`services/reporting/src/basket-affinity.ts`). Now a department node OWNS categories (and with them their
// sub-categories); which department owns what is a structural fact, changed only with the owner's approval through the
// maker-checker engine (kind `org_structure_change`), recorded append-only. A category belongs to one department at most.
//
// The department report reads sales of the products in the department's categories for one trading day — never another
// department's, never a product no department owns (those are counted as unowned, so the sum of the departments is
// visibly not the whole shop rather than quietly short). A department-limited reader reads only their own departments.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, scopeOf } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { departmentOfCategory, categoriesOwnedElsewhere, withinDepartmentScope, type DepartmentCategories } from '../../../packages/org/src/departments';
import type { OrgNode } from '../../../packages/org/src/index';
import { actionDetails, openApproval, type ApprovalPort } from '../../identity/src/approval-requests';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

export const ORG_STRUCTURE_KIND = 'org_structure_change';

export interface DepartmentLinkRecord extends DepartmentCategories {
  readonly reason: string;
  readonly by: string;
  readonly approvedBy: string;
  readonly approvalId: string;
  readonly at: string;
}

/** One sale line as the department report reads it. */
export interface DepartmentSaleLine {
  readonly saleId: string;
  readonly locationId: string;
  readonly tradingDay: string;
  readonly productId: string;
  readonly quantityMinor: number;
  readonly lineTotalMinor: number;
}

export interface OrgDepartmentDeps {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  readonly nodes: (tenantId: string) => Promise<readonly OrgNode[]>;
  /** Every link recorded, in append order (the latest per department stands). */
  readonly links: (tenantId: string) => Promise<readonly DepartmentLinkRecord[]>;
  readonly recordLink: (tenantId: string, link: DepartmentLinkRecord) => Promise<void>;
  /** The category list: id → parent (null at the top). */
  readonly categories: (tenantId: string) => Promise<ReadonlyMap<string, string | null>>;
  /** Product → its primary category (null/absent when it has none). */
  readonly productCategories: (tenantId: string) => Promise<ReadonlyMap<string, string | null>>;
  readonly productNames?: (tenantId: string) => Promise<ReadonlyMap<string, string>>;
  readonly saleLines: (tenantId: string, tradingDay: string) => Promise<readonly DepartmentSaleLine[]>;
  /** Where the reader may read by department (M02-FR-02): 'all', or their departments. */
  readonly departmentScopeOf: (tenantId: string, userId: string, permission: string) => Promise<readonly string[] | 'all'>;
  readonly approvals: ApprovalPort;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The latest link per department. */
export function currentLinks(records: readonly DepartmentLinkRecord[]): readonly DepartmentLinkRecord[] {
  const out = new Map<string, DepartmentLinkRecord>();
  for (const r of records) out.set(r.departmentId, r);
  return [...out.values()].filter((r) => r.categoryIds.length > 0);
}

export function orgDepartmentRoutes(deps: OrgDepartmentDeps): readonly Route[] {
  const departmentNodes = async (tenantId: string) => (await deps.nodes(tenantId)).filter((n) => n.kind === 'department');
  return [
    {
      api: 'API-01', method: 'GET', path: '/v1/org/departments',
      permission: 'org.branch.read',
      handler: async (ctx) => {
        const [nodes, links, categories] = await Promise.all([departmentNodes(ctx.tenantId), deps.links(ctx.tenantId), deps.categories(ctx.tenantId)]);
        const live = currentLinks(links);
        const parentOf = (c: string) => categories.get(c) ?? null;
        const unowned = [...categories.keys()].filter((c) => departmentOfCategory(live, parentOf, c) === undefined).sort();
        return {
          status: 200,
          body: {
            departments: nodes.map((n) => ({ departmentId: n.nodeId, name: n.name, parentId: n.parentId, status: n.status, categoryIds: live.find((l) => l.departmentId === n.nodeId)?.categoryIds ?? [] })),
            unownedCategories: unowned,
          },
        };
      },
    },
    {
      // Say which categories a department owns. Body: { categoryIds, reason, approvalId } — a structural change, approved by
      // the owner (kind org_structure_change, subjectRef department:<id>). Replaces the department's list (a new version).
      api: 'API-01', method: 'POST', path: '/v1/org/departments/:departmentId/categories',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const departmentId = (ctx.params['departmentId'] ?? '').trim();
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        const categoryIds = Array.isArray(b['categoryIds']) && b['categoryIds'].every(isStr) ? [...new Set((b['categoryIds'] as string[]).map((c) => c.trim()))].sort() : undefined;
        if (categoryIds === undefined || !isStr(b['reason']) || !isStr(b['approvalId'])) {
          throw apiError(400, {
            code: 'not_readable_as_department_categories',
            whatHappened: 'A department\'s categories are { categoryIds (the list it owns; [] for none), reason, approvalId }.',
            wasItSaved: 'not_saved',
            nextSafeAction: `Ask for the owner's approval first (POST /v1/approvals/requests, kind ${ORG_STRUCTURE_KIND}, subjectRef department:${departmentId}). Nothing was changed.`,
          });
        }
        const node = (await departmentNodes(ctx.tenantId)).find((n) => n.nodeId === departmentId);
        if (node === undefined) throw notFound(`department ${departmentId} (an org node of kind department)`);
        const categories = await deps.categories(ctx.tenantId);
        const unknown = categoryIds.filter((c) => !categories.has(c));
        if (unknown.length > 0) throw apiError(422, { code: 'unknown_category', whatHappened: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not on the category list.`, wasItSaved: 'not_saved', nextSafeAction: 'Name categories from the catalogue. Nothing was changed.' });
        const elsewhere = categoriesOwnedElsewhere(currentLinks(await deps.links(ctx.tenantId)), departmentId, categoryIds);
        if (elsewhere.length > 0) {
          throw apiError(409, {
            code: 'category_owned_by_another_department',
            whatHappened: elsewhere.map((e) => `${e.categoryId} belongs to ${e.ownedBy}`).join('; ') + ' — a category belongs to one department, or its sales would count twice.',
            wasItSaved: 'not_saved', nextSafeAction: 'Take it off the other department first (also with the owner\'s approval). Nothing was changed.',
          });
        }
        const approval = await openApproval(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: (b['approvalId'] as string).trim(), kind: ORG_STRUCTURE_KIND, subjectRef: `department:${departmentId}`,
          details: actionDetails(ctx.body, { departmentId }), valueMinor: null, maker: ctx.userId, usedBy: `department-categories:${departmentId}`, now: deps.now(),
        });
        await approval.spend();
        const before = currentLinks(await deps.links(ctx.tenantId)).find((l) => l.departmentId === departmentId);
        const record: DepartmentLinkRecord = {
          departmentId, categoryIds, reason: (b['reason'] as string).trim().slice(0, 300), by: ctx.userId,
          approvedBy: approval.decision.decidedBy, approvalId: approval.decision.requestId, at: deps.now(),
        };
        await deps.recordLink(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'org.department.categories', objectType: 'org_node', objectId: departmentId, at: record.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { categoryIds: (before?.categoryIds ?? []).join(',') }, after: { categoryIds: categoryIds.join(','), approvedBy: record.approvedBy },
          reason: record.reason, approvalId: record.approvalId, correlationId: `department:${departmentId}`,
        });
        return { status: 201, body: record };
      },
    },
    {
      // One department's sales for a trading day (?day=YYYY-MM-DD, default today): only its own products, within the
      // reader's branches; what no department owns is counted separately, never folded in.
      api: 'API-10', method: 'GET', path: '/v1/org/departments/:departmentId/report',
      permission: 'reporting.report.read',
      handler: async (ctx) => {
        const departmentId = (ctx.params['departmentId'] ?? '').trim();
        const day = ctx.query['day'] ?? await shopToday(deps, ctx.tenantId);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw apiError(400, { code: 'not_readable_as_a_day', whatHappened: `"${day}" is not a trading day (YYYY-MM-DD).`, wasItSaved: 'not_saved', nextSafeAction: 'Send ?day=YYYY-MM-DD.' });
        const node = (await departmentNodes(ctx.tenantId)).find((n) => n.nodeId === departmentId);
        if (node === undefined) throw notFound(`department ${departmentId}`);
        const mine = await deps.departmentScopeOf(ctx.tenantId, ctx.userId, 'reporting.report.read');
        if (!withinDepartmentScope(mine, departmentId)) {
          throw apiError(403, {
            code: 'outside_your_department_scope',
            whatHappened: `This account's authority does not reach department "${departmentId}".`,
            wasItSaved: 'not_saved', nextSafeAction: 'Read the departments your role covers. Nothing was changed.',
          });
        }
        const [links, categories, productCats, lines, names] = await Promise.all([
          deps.links(ctx.tenantId), deps.categories(ctx.tenantId), deps.productCategories(ctx.tenantId), deps.saleLines(ctx.tenantId, day),
          deps.productNames?.(ctx.tenantId) ?? Promise.resolve(new Map<string, string>()),
        ]);
        const live = currentLinks(links);
        const parentOf = (c: string) => categories.get(c) ?? null;
        const branches = scopeOf(ctx);
        const inBranches = lines.filter((l) => branches === 'all' || branches.includes(l.locationId));
        const byProduct = new Map<string, { quantityMinor: number; valueMinor: number; sales: Set<string> }>();
        let unownedValueMinor = 0;
        for (const l of inBranches) {
          const d = departmentOfCategory(live, parentOf, productCats.get(l.productId) ?? null);
          if (d === undefined) { unownedValueMinor += l.lineTotalMinor; continue; }
          if (d !== departmentId) continue;
          const row = byProduct.get(l.productId) ?? { quantityMinor: 0, valueMinor: 0, sales: new Set<string>() };
          row.quantityMinor += l.quantityMinor; row.valueMinor += l.lineTotalMinor; row.sales.add(l.saleId);
          byProduct.set(l.productId, row);
        }
        const products = [...byProduct.entries()].map(([productId, r]) => ({ productId, name: names.get(productId) ?? null, quantityMinor: r.quantityMinor, valueMinor: r.valueMinor, bills: r.sales.size }))
          .sort((a, b) => b.valueMinor - a.valueMinor || (a.productId < b.productId ? -1 : 1));
        return {
          status: 200,
          body: {
            departmentId, name: node.name, tradingDay: day, categoryIds: live.find((l) => l.departmentId === departmentId)?.categoryIds ?? [],
            products, totalValueMinor: products.reduce((s, p) => s + p.valueMinor, 0),
            branches, unownedValueMinor,
            ...(live.find((l) => l.departmentId === departmentId) === undefined ? { note: 'This department owns no categories yet, so nothing is counted to it.' } : {}),
          },
        };
      },
    },
  ];
}
