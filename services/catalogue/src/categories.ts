// Head office's own category list (Wave 4 · SF-06-b · OB-24 "A" · M03-FR-01 · §28 · hard rules #2 #10).
//
// Before, no list existed: every product publish carried its OWN categories in the body, and the product was judged against
// whatever the sender wrote — so two publishes could disagree about what "grocery" is (regulated as food, or not) and both
// pass. Now head office holds the list, and every product is judged against it:
//
//   • DEFINE — a category is { categoryId, name, parentId, regulated?, attributes? }. Its parent must already be on the list
//     (or defined in the same call), a parent chain never loops, and a regulated kind is one the product engine knows. A
//     change to an existing category is a new version (append-only), never an overwrite.
//   • WHO (owner, 9 Oct 2026, OB-24 "A"; roadmap M03-FR-01 "Product user maintains; Owner/Manager approve new category"):
//     a person holding `catalogue.category.approve` (the owner) defines a category directly — their act IS the approval.
//     A person holding only `catalogue.category.propose` (the store manager) needs the owner's approval, given in the
//     owner's own session on head office's engine (kind `category_define`, ADR-0024).
//   • PUBLISH — a product's category is read from this list. A publish body may still carry the categories it expects: each
//     must say exactly what the list says (else `category_differs_from_head_office`, nothing saved); one the list does not
//     hold is defined by that publish only when the publisher may define categories, and the answer says so.
//
// Pure of storage: the list is a port; the API adapter folds `CategoryDefined` events (latest version per id).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { openApproval, type ApprovalPort, NO_APPROVALS } from '../../identity/src/approval-requests';
import type { Category, RegulatedKind, AttributeDefinition } from '../../../packages/product/src/index';

export const REGULATED_KINDS: readonly RegulatedKind[] = Object.freeze(['food', 'packed', 'weighed', 'age_restricted', 'drug', 'hazardous']);
const ATTRIBUTE_TYPES = ['text', 'number', 'boolean', 'enum', 'date'] as const;

/** One version of a category on head office's list. */
export interface StoredCategory extends Category {
  readonly version: number;
  readonly definedBy: string;
  /** The person whose authority made it so — the definer when they hold `catalogue.category.approve`, else the approver. */
  readonly approvedBy: string;
  readonly definedAt: string;
  /** Where it was defined: the category route, a product publish, or a load. */
  readonly source: string;
}

export interface CategoryRegisterDeps {
  /** The latest version of every category on the list. */
  readonly categories: (tenantId: string) => Promise<readonly StoredCategory[]> | readonly StoredCategory[];
  /** Append new versions (one atomic save for a batch). */
  readonly define: (tenantId: string, records: readonly StoredCategory[]) => Promise<void> | void;
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly approvals?: ApprovalPort;
  readonly now: () => string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Read one category off a request, or say why it cannot be read. */
export function readCategory(v: unknown): Category | string {
  if (!isObj(v) || !isStr(v['categoryId']) || !isStr(v['name'])) return 'a category needs { categoryId, name, parentId }';
  const parentId = v['parentId'] === undefined || v['parentId'] === null || v['parentId'] === '' ? null : v['parentId'];
  if (parentId !== null && !isStr(parentId)) return `category "${String(v['categoryId'])}": parentId must be a category id or null`;
  const regulated = v['regulated'];
  if (regulated !== undefined && !(Array.isArray(regulated) && regulated.every((r) => (REGULATED_KINDS as readonly unknown[]).includes(r)))) {
    return `category "${v['categoryId']}": regulated must be a list drawn from ${REGULATED_KINDS.join(', ')}`;
  }
  const attributes = v['attributes'];
  if (attributes !== undefined && !(Array.isArray(attributes) && attributes.every((a) => isObj(a) && isStr(a['key']) && isStr(a['label']) && (ATTRIBUTE_TYPES as readonly unknown[]).includes(a['type'])))) {
    return `category "${v['categoryId']}": each attribute needs { key, label, type } with type one of ${ATTRIBUTE_TYPES.join(', ')}`;
  }
  return {
    categoryId: (v['categoryId'] as string).trim(), name: (v['name'] as string).trim(), parentId: parentId === null ? null : (parentId as string).trim(),
    ...(regulated === undefined ? {} : { regulated: [...new Set(regulated as RegulatedKind[])].sort() }),
    ...(attributes === undefined ? {} : { attributes: attributes as AttributeDefinition[] }),
  };
}

/** The part of a category that defines it — what two definitions must agree on. */
const shapeOf = (c: Category): string => JSON.stringify({
  name: c.name, parentId: c.parentId, regulated: [...(c.regulated ?? [])].sort(), attributes: c.attributes ?? [],
});
export const sameCategory = (a: Category, b: Category): boolean => shapeOf(a) === shapeOf(b);

/** Engine shape (no bookkeeping) — what the product engine judges against. */
export const engineCategory = (c: StoredCategory | Category): Category => ({
  categoryId: c.categoryId, name: c.name, parentId: c.parentId,
  ...(c.regulated === undefined ? {} : { regulated: c.regulated }),
  ...(c.attributes === undefined ? {} : { attributes: c.attributes }),
});

/** Every parent exists (on the list or in the batch) and no chain loops. Returns the problems, by category. */
export function structuralProblems(all: readonly Category[]): string[] {
  const byId = new Map(all.map((c) => [c.categoryId, c] as const));
  const problems: string[] = [];
  for (const c of all) {
    if (c.parentId !== null && !byId.has(c.parentId)) problems.push(`category "${c.categoryId}": its parent "${c.parentId}" is not on head office's list`);
    const seen = new Set<string>([c.categoryId]);
    let p = c.parentId;
    while (p !== null && byId.has(p)) {
      if (seen.has(p)) { problems.push(`category "${c.categoryId}": its parents loop back to "${p}"`); break; }
      seen.add(p);
      p = byId.get(p)!.parentId;
    }
  }
  return problems;
}

const mayDefine = async (deps: Pick<CategoryRegisterDeps, 'permissionsOfUser'>, tenantId: string, userId: string): Promise<boolean> =>
  ((await deps.permissionsOfUser(tenantId, userId)) ?? []).includes('catalogue.category.approve');

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

/**
 * What a product publish judges against: head office's list, after settling the categories the body EXPECTS. Each expected
 * category the list holds must match it exactly; one it does not hold is defined here only when the publisher may define
 * categories (their act is the approval), else refused. Returns the full list (engine shape) and the ids it defined.
 */
export async function settlePublishCategories(
  deps: CategoryRegisterDeps, ctx: Pick<RequestContext, 'tenantId' | 'userId'>, expected: unknown,
): Promise<{ readonly categories: readonly Category[]; readonly defined: readonly string[] }> {
  const held = await deps.categories(ctx.tenantId);
  const byId = new Map(held.map((c) => [c.categoryId, c] as const));
  const toDefine: Category[] = [];
  if (expected !== undefined) {
    if (!Array.isArray(expected)) throw refuse(400, 'not_readable_as_a_category', 'categories[] must be a list of { categoryId, name, parentId }.', 'Send the list, or leave it out — head office reads its own.');
    for (const raw of expected) {
      const c = readCategory(raw);
      if (typeof c === 'string') throw refuse(400, 'not_readable_as_a_category', `${c}.`, 'Correct it, or leave categories[] out — head office reads its own list. Nothing was saved.');
      const have = byId.get(c.categoryId);
      if (have !== undefined) {
        if (!sameCategory(have, c)) {
          throw refuse(409, 'category_differs_from_head_office', `Category "${c.categoryId}" on head office's list is "${have.name}" (parent ${have.parentId ?? 'none'}, regulated ${(have.regulated ?? []).join('/') || 'none'}); this publish describes it differently. A category means one thing.`, 'Publish against the category as head office holds it, or change the category itself first (that change is approved). Nothing was saved.');
        }
      } else if (!toDefine.some((d) => d.categoryId === c.categoryId)) {
        toDefine.push(c);
      }
    }
  }
  if (toDefine.length > 0) {
    if (!(await mayDefine(deps, ctx.tenantId, ctx.userId))) {
      throw refuse(422, 'unknown_category', `Head office's list has no category ${toDefine.map((c) => `"${c.categoryId}"`).join(', ')}, and a new category is approved by the owner (M03-FR-01).`, 'Propose the category (POST /v1/catalogue/categories/:categoryId) and have the owner approve it, then publish. Nothing was saved.');
    }
    const problems = structuralProblems([...held, ...toDefine]);
    if (problems.length > 0) throw refuse(422, 'category_structure_invalid', `${problems.join('; ')}.`, 'Define the parent first. Nothing was saved.');
    const at = deps.now();
    await deps.define(ctx.tenantId, toDefine.map((c) => ({ ...c, version: 1, definedBy: ctx.userId, approvedBy: ctx.userId, definedAt: at, source: 'product-publish' })));
  }
  return { categories: [...held.map(engineCategory), ...toDefine], defined: toDefine.map((c) => c.categoryId) };
}

export function categoryRoutes(deps: CategoryRegisterDeps): readonly Route[] {
  return [
    {
      // DEFINE (or change) one category. The owner defines directly; a manager needs the owner's approval (kind
      // category_define, for exactly this definition).
      api: 'API-02', method: 'POST', path: '/v1/catalogue/categories/:categoryId',
      permission: 'catalogue.category.propose', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const c = readCategory({ ...b, categoryId: ctx.params['categoryId'] });
        if (typeof c === 'string') throw refuse(400, 'not_readable_as_a_category', `${c}.`, 'Send { name, parentId, regulated?, attributes? }. Nothing was saved.');
        const held = await deps.categories(ctx.tenantId);
        const existing = held.find((h) => h.categoryId === c.categoryId);
        if (existing !== undefined && sameCategory(existing, c)) return { status: 200, body: { category: existing, changed: false } };
        const problems = structuralProblems([...held.filter((h) => h.categoryId !== c.categoryId), c]);
        if (problems.length > 0) throw refuse(422, 'category_structure_invalid', `${problems.join('; ')}.`, 'Define the parent first, or choose a parent that does not sit under this category. Nothing was saved.');
        let approvedBy = ctx.userId;
        if (!(await mayDefine(deps, ctx.tenantId, ctx.userId))) {
          if (!isStr(b['approvalId'])) {
            throw refuse(422, 'no_approval', `A ${existing === undefined ? 'new category' : 'change to a category'} is approved by the owner (M03-FR-01).`, 'Ask for approval (kind category_define, subject the category id, details the definition); once the owner approves, send the approvalId.');
          }
          const opened = await openApproval(deps.approvals ?? NO_APPROVALS, {
            tenantId: ctx.tenantId, approvalId: (b['approvalId'] as string).trim(), kind: 'category_define', subjectRef: c.categoryId,
            details: engineCategory(c), valueMinor: null, maker: ctx.userId, usedBy: `category-${c.categoryId}-v${(existing?.version ?? 0) + 1}`, now: deps.now(),
          });
          await opened.spend();
          approvedBy = opened.decision.decidedBy;
        }
        const record: StoredCategory = { ...c, version: (existing?.version ?? 0) + 1, definedBy: ctx.userId, approvedBy, definedAt: deps.now(), source: 'category-route' };
        await deps.define(ctx.tenantId, [record]);
        return { status: existing === undefined ? 201 : 200, body: { category: record, changed: true } };
      },
    },
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/categories',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const categories = [...await deps.categories(ctx.tenantId)].sort((a, b) => a.categoryId.localeCompare(b.categoryId));
        return { status: 200, body: { categories, count: categories.length } };
      },
    },
  ];
}
