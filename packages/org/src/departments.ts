// Departments own product categories (M01-FR-01 "a report filtered to one department returns only that department's
// data" · M02-FR-02 department scope · §28 "Department Manager — assigned departments"). Pure: no storage.
//
// A department is an org node (kind `department`). It owns a set of product categories; a category's sub-categories belong
// to the same department. A category belongs to ONE department at most — two owners would count its sales twice in the
// department reports and give two managers authority over one shelf. A category no department owns belongs to none: a
// department-limited person may not act on it, and a department report never includes it (it is listed as unowned).

export interface DepartmentCategories {
  readonly departmentId: string;
  readonly categoryIds: readonly string[];
}

/** Which department owns a category — its own link, else the nearest ancestor's; undefined when none does. */
export function departmentOfCategory(
  links: readonly DepartmentCategories[],
  parentOf: (categoryId: string) => string | null | undefined,
  categoryId: string | null | undefined,
): string | undefined {
  const owner = new Map<string, string>();
  for (const l of links) for (const c of l.categoryIds) owner.set(c, l.departmentId);
  const seen = new Set<string>();
  let at: string | null | undefined = categoryId;
  while (at !== null && at !== undefined && !seen.has(at)) {
    const d = owner.get(at);
    if (d !== undefined) return d;
    seen.add(at);
    at = parentOf(at);
  }
  return undefined;
}

/** Categories another department already owns — a link that would give one category two owners. */
export function categoriesOwnedElsewhere(links: readonly DepartmentCategories[], departmentId: string, categoryIds: readonly string[]): readonly { readonly categoryId: string; readonly ownedBy: string }[] {
  const out: { categoryId: string; ownedBy: string }[] = [];
  for (const c of [...new Set(categoryIds)].sort()) {
    const other = links.find((l) => l.departmentId !== departmentId && l.categoryIds.includes(c));
    if (other !== undefined) out.push({ categoryId: c, ownedBy: other.departmentId });
  }
  return out;
}

/** Is an act on something in `departmentId` within `scope`? Something owned by no department is outside every limited scope. */
export function withinDepartmentScope(scope: readonly string[] | 'all', departmentId: string | undefined): boolean {
  if (scope === 'all') return true;
  return departmentId !== undefined && scope.includes(departmentId);
}
