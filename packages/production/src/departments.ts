// Production department enablement (M11-FR-04 / roadmap §2.2 / OB-04).
//
// The roadmap's rule here is blunt and worth keeping blunt:
//
//     DO NOT BUILD A MODULE FOR A DEPARTMENT YOU DO NOT HAVE.
//
// A meat-counter screen in a shop with no meat counter is not harmless. It is a
// menu item staff have to learn to ignore, a set of fields on a form that nobody
// fills in, a report with a permanently empty section, and a compliance obligation
// (cold chain, metrology) that the system believes applies and the shop does not.
//
// SRE Hyper Market operates a **cafe** and nothing else (owner, 3 Aug 2026 — OB-04,
// closing AVR-12). So the cafe is defined here and enabled; bakery, deli,
// meat/fish, cut fruit, pharmacy and concession are **not enabled**. They are named
// in the catalogue below only so that a *different tenant* can switch one on — this
// is a commercial multi-tenant product (OB-01), and one shop's answer is never
// hard-coded as everyone's.
//
// Adding a department later is a change record with a target release, never a
// silent gap (OD-02).
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
 * The catalogue of departments a tenant MAY operate. Being listed here is not
 * being enabled — enablement is per-tenant configuration
 * (`SETTINGS.PRODUCTION_DEPARTMENTS`).
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
