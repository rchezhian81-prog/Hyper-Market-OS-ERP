// Production department enablement (M11-FR-04 / roadmap §2.2 / OB-04 / OB-05).
//
// The roadmap says: do not build a module for a department you do not have. That
// rule governs **what a tenant is shown**, not **what the product contains**
// (OB-05) — and the distinction matters in both directions:
//
//   • A meat-counter screen in a shop with no meat counter is not harmless. It is a
//     menu item staff learn to ignore, a form nobody fills in, a report with a
//     permanently empty section, and a compliance obligation (cold chain,
//     metrology) the system believes applies and the shop does not.
//
//   • But this is a commercial multi-tenant product (OB-01). A tenant that runs a
//     butcher's counter must not be told to wait for a release. So EVERY department
//     the roadmap names is BUILT — cafe, bakery, deli, meat/fish, central kitchen —
//     with the full weighed-output path (catch-weight costing, scale labels), and
//     each tenant ENABLES only its own.
//
// SRE Hyper Market enables the cafe (OB-04, closing AVR-12). That configures SRE;
// it does not trim the build. Enabling a department later is configuration, and
// adding a *new kind* of department is a change record with a target release,
// never a silent gap (OD-02).
//
// Pure and deterministic: no clock, no I/O.

/** What a production department needs from the rest of the system. */
export interface ProductionDepartment {
  readonly departmentId: string;
  readonly label: string;
  /** Output is food, so allergen and FSSAI rules apply (M03-FR-03, M34-FR-03). */
  readonly foodSafety: boolean;
  /** Output is packed or weighed, so Legal Metrology label fields apply (§9.3). */
  readonly legalMetrology: boolean;
  /** Output must be held at temperature — drives cold-chain checks (M10). */
  readonly coldChain: boolean;
  /**
   * Output is sold by weight with a scale label carrying an embedded weight or
   * price barcode (M03-FR-02). A cafe sells by the cup and the piece, not the kilo.
   */
  readonly weighedOutput: boolean;
}

/**
 * Every production department the product supports, fully built. Being listed here
 * is not being enabled — enablement is per-tenant configuration
 * (`SETTINGS.PRODUCTION_DEPARTMENTS`), and a tenant only ever sees its own.
 */
export const DEPARTMENT_CATALOGUE: Readonly<Record<string, ProductionDepartment>> = {
  cafe: {
    departmentId: 'cafe',
    label: 'Cafe',
    foodSafety: true,
    legalMetrology: true, // a packed sandwich still needs its net quantity declared
    coldChain: true, // milk and chilled ready-to-eat items
    weighedOutput: false, // sold by the cup and the piece
  },
  bakery: {
    departmentId: 'bakery',
    label: 'Bakery',
    foodSafety: true,
    legalMetrology: true,
    coldChain: false,
    weighedOutput: true,
  },
  deli: {
    departmentId: 'deli',
    label: 'Deli counter',
    foodSafety: true,
    legalMetrology: true,
    coldChain: true,
    weighedOutput: true,
  },
  meat_fish: {
    departmentId: 'meat_fish',
    label: 'Meat and fish',
    foodSafety: true,
    legalMetrology: true,
    coldChain: true,
    weighedOutput: true,
  },
  kitchen: {
    departmentId: 'kitchen',
    label: 'Central kitchen',
    foodSafety: true,
    legalMetrology: true,
    coldChain: true,
    weighedOutput: true,
  },
};

export class DepartmentNotOperatedError extends Error {
  constructor(
    public readonly departmentId: string,
    public readonly enabled: readonly string[],
  ) {
    super(
      `This store does not operate a "${departmentId}" department (it operates: ${
        enabled.length === 0 ? 'none' : enabled.join(', ')
      }) — a module is never built or enabled for a department the store does not have`,
    );
    this.name = 'DepartmentNotOperatedError';
  }
}

export class UnknownDepartmentError extends Error {
  constructor(public readonly departmentId: string) {
    super(`"${departmentId}" is not a production department this product knows how to run`);
    this.name = 'UnknownDepartmentError';
  }
}

/** Resolve a department the tenant has actually switched on. */
export function requireDepartment(
  departmentId: string,
  enabled: readonly string[],
): ProductionDepartment {
  const department = DEPARTMENT_CATALOGUE[departmentId];
  if (!department) {
    throw new UnknownDepartmentError(departmentId);
  }
  if (!enabled.includes(departmentId)) {
    throw new DepartmentNotOperatedError(departmentId, enabled);
  }
  return department;
}

/** The departments a tenant operates, resolved from its setting. */
export function operatedDepartments(enabled: readonly string[]): readonly ProductionDepartment[] {
  return enabled.map((id) => {
    const department = DEPARTMENT_CATALOGUE[id];
    if (!department) throw new UnknownDepartmentError(id);
    return department;
  });
}
