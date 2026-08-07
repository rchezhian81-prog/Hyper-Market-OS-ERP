// Organisational hierarchy (M01-FR-01) — the structure every transaction,
// permission and report is scoped to.
//
// This is the skeleton the rest of the system hangs on. Get it wrong and the
// symptoms appear everywhere at once: GST filed against the wrong registration, a
// manager able to see another branch's takings, a report that quietly double-counts
// a warehouse. So the structure is validated as a whole, not node by node:
//
//   company → GST registration → branch/store → warehouse → department
//
// Rules that hold whatever a tenant configures:
//   • a GSTIN is unique and format-valid — a duplicate is rejected with the holder
//     named, because the second entry is usually a typo of the first;
//   • every store belongs to exactly one company and exactly one GST registration
//     (that is what makes the tax attribution unambiguous);
//   • a department belongs to one store;
//   • a branch cannot be ACTIVATED without a parent company and a GST registration.
//     It can be created and saved incomplete — an incomplete hierarchy is a draft.
//
// The 15-character Indian GSTIN is checked properly, including its checksum, so a
// mistyped digit is caught when it is entered rather than at the first return.
//
// Pure and deterministic: no clock, no I/O.

export type OrgNodeKind = 'company' | 'branch' | 'warehouse' | 'department';
export type OrgNodeStatus = 'draft' | 'active' | 'suspended' | 'closed';

export interface GstRegistration {
  readonly gstin: string;
  readonly companyId: string;
  /** State code the registration belongs to, e.g. "33" for Tamil Nadu. */
  readonly stateCode: string;
  readonly legalName: string;
}

export interface OrgNode {
  readonly nodeId: string;
  readonly tenantId: string;
  readonly kind: OrgNodeKind;
  readonly name: string;
  /** Null only for a company — everything else has a parent. */
  readonly parentId: string | null;
  /** Required for a branch or warehouse: which company it trades under. */
  readonly companyId?: string;
  /** Required to activate a branch: which registration its sales are filed under. */
  readonly gstin?: string;
  readonly status: OrgNodeStatus;
}

export class DuplicateGstinError extends Error {
  constructor(
    public readonly gstin: string,
    public readonly heldBy: string,
  ) {
    super(
      `GSTIN ${gstin} is already registered to "${heldBy}" — a second entry is almost always a typo of the first`,
    );
    this.name = 'DuplicateGstinError';
  }
}

export class InvalidGstinError extends Error {
  constructor(
    public readonly gstin: string,
    public readonly why: string,
  ) {
    super(`GSTIN "${gstin}" is not valid: ${why}`);
    this.name = 'InvalidGstinError';
  }
}

export class HierarchyError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly why: string,
  ) {
    super(`"${nodeId}" cannot sit in the hierarchy: ${why}`);
    this.name = 'HierarchyError';
  }
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Validate a 15-character Indian GSTIN, checksum included. A mistyped digit is
 * caught the moment it is entered, not at the first return — which is the whole
 * value of validating a checksum rather than only a shape.
 */
export function validateGstin(gstin: string): string {
  const value = gstin.trim().toUpperCase();
  if (value.length !== 15) {
    throw new InvalidGstinError(gstin, `it must be 15 characters, this is ${value.length}`);
  }
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/.test(value)) {
    throw new InvalidGstinError(
      gstin,
      'it does not follow the GSTIN pattern (2 digits state, 10-character PAN, entity code, Z, check character)',
    );
  }
  // Checksum: weight alternating 1,2 across the first 14 characters, sum the digits
  // of each product in base 36, and the check character completes the multiple of 36.
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const code = GSTIN_CHARS.indexOf(value[i] ?? '');
    const product = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const expected = GSTIN_CHARS[(36 - (sum % 36)) % 36];
  if (value[14] !== expected) {
    throw new InvalidGstinError(gstin, 'the check character does not match — a digit is mistyped');
  }
  return value;
}

/** The GST state code a registration belongs to — the first two digits. */
export function gstStateCode(gstin: string): string {
  return validateGstin(gstin).slice(0, 2);
}

/**
 * The register of GST registrations. Refuses a duplicate GSTIN, naming who already
 * holds it (M01-FR-01 acceptance).
 */
export class GstRegister {
  private readonly byGstin = new Map<string, GstRegistration>();

  constructor(existing: readonly GstRegistration[] = []) {
    for (const registration of existing) this.add(registration);
  }

  add(registration: GstRegistration): GstRegistration {
    const gstin = validateGstin(registration.gstin);
    const held = this.byGstin.get(gstin);
    if (held) {
      // One GSTIN, one registration — whoever is claiming it second.
      throw new DuplicateGstinError(gstin, held.legalName);
    }
    const stored = { ...registration, gstin, stateCode: gstin.slice(0, 2) };
    this.byGstin.set(gstin, stored);
    return stored;
  }

  find(gstin: string): GstRegistration | undefined {
    return this.byGstin.get(gstin.trim().toUpperCase());
  }

  forCompany(companyId: string): readonly GstRegistration[] {
    return [...this.byGstin.values()].filter((r) => r.companyId === companyId);
  }
}

const ALLOWED_PARENT: Readonly<Record<OrgNodeKind, readonly OrgNodeKind[]>> = {
  company: [],
  branch: ['company'],
  warehouse: ['company', 'branch'],
  department: ['branch', 'warehouse'],
};

export interface HierarchyIssue {
  readonly nodeId: string;
  readonly severity: 'blocks_activation' | 'advisory';
  readonly message: string;
}

/**
 * Check a node in the context of the whole structure. Like the product master, an
 * incomplete node is a legitimate DRAFT — this reports what would stop it being
 * ACTIVATED rather than refusing to record it.
 */
export function validateNode(
  node: OrgNode,
  nodes: readonly OrgNode[],
  gstRegister: GstRegister,
): readonly HierarchyIssue[] {
  const issues: HierarchyIssue[] = [];

  if (node.kind === 'company') {
    if (node.parentId !== null) {
      throw new HierarchyError(node.nodeId, 'a company is the top of the structure and has no parent');
    }
  } else {
    if (node.parentId === null) {
      throw new HierarchyError(node.nodeId, `a ${node.kind} must have a parent`);
    }
    const parent = nodes.find((n) => n.nodeId === node.parentId);
    if (!parent) {
      throw new HierarchyError(node.nodeId, `its parent "${node.parentId}" does not exist`);
    }
    if (!ALLOWED_PARENT[node.kind].includes(parent.kind)) {
      throw new HierarchyError(
        node.nodeId,
        `a ${node.kind} cannot sit under a ${parent.kind} (allowed: ${ALLOWED_PARENT[node.kind].join(', ')})`,
      );
    }
    if (parent.tenantId !== node.tenantId) {
      // Cross-tenant structure is a critical defect, not a configuration option.
      throw new HierarchyError(node.nodeId, 'its parent belongs to a different tenant');
    }
  }

  if (node.kind === 'branch' || node.kind === 'warehouse') {
    if (node.companyId === undefined || node.companyId.trim() === '') {
      issues.push({
        nodeId: node.nodeId,
        severity: 'blocks_activation',
        message: `a ${node.kind} must trade under exactly one company`,
      });
    } else if (!nodes.some((n) => n.nodeId === node.companyId && n.kind === 'company')) {
      throw new HierarchyError(node.nodeId, `company "${node.companyId}" does not exist`);
    }
  }

  if (node.kind === 'branch') {
    // The acceptance test: no branch without a company and a GST registration.
    if (node.gstin === undefined || node.gstin.trim() === '') {
      issues.push({
        nodeId: node.nodeId,
        severity: 'blocks_activation',
        message: 'a branch cannot trade without a GST registration — its sales would be unattributable',
      });
    } else {
      const registration = gstRegister.find(node.gstin);
      if (!registration) {
        issues.push({
          nodeId: node.nodeId,
          severity: 'blocks_activation',
          message: `GSTIN ${node.gstin} is not registered to any company here`,
        });
      } else if (node.companyId !== undefined && registration.companyId !== node.companyId) {
        issues.push({
          nodeId: node.nodeId,
          severity: 'blocks_activation',
          message: `GSTIN ${node.gstin} belongs to a different company — the tax attribution would be wrong`,
        });
      }
    }
  }

  return issues;
}

/** True when a node meets every condition for activation. */
export function canActivate(
  node: OrgNode,
  nodes: readonly OrgNode[],
  gstRegister: GstRegister,
): boolean {
  return !validateNode(node, nodes, gstRegister).some((i) => i.severity === 'blocks_activation');
}

/** Every descendant of a node — the scope a report or a permission covers. */
export function descendantsOf(nodeId: string, nodes: readonly OrgNode[]): readonly OrgNode[] {
  const out: OrgNode[] = [];
  const queue = [nodeId];
  const seen = new Set<string>([nodeId]);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const node of nodes) {
      if (node.parentId === current && !seen.has(node.nodeId)) {
        seen.add(node.nodeId);
        out.push(node);
        queue.push(node.nodeId);
      }
    }
  }
  return out;
}

/** The chain from a node up to its company — how a transaction is attributed. */
export function ancestryOf(nodeId: string, nodes: readonly OrgNode[]): readonly OrgNode[] {
  const chain: OrgNode[] = [];
  const seen = new Set<string>();
  let current = nodes.find((n) => n.nodeId === nodeId);
  while (current !== undefined && !seen.has(current.nodeId)) {
    seen.add(current.nodeId);
    chain.push(current);
    current = current.parentId === null ? undefined : nodes.find((n) => n.nodeId === current?.parentId);
  }
  return chain;
}

/** Which GSTIN a transaction at this node is filed under (M01-FR-01). */
export function gstinFor(nodeId: string, nodes: readonly OrgNode[]): string | undefined {
  return ancestryOf(nodeId, nodes).find((n) => n.gstin !== undefined)?.gstin;
}
