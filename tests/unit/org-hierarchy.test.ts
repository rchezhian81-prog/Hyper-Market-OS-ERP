import { describe, it, expect } from 'vitest';
import {
  validateGstin,
  gstStateCode,
  GstRegister,
  validateNode,
  canActivate,
  descendantsOf,
  ancestryOf,
  gstinFor,
  DuplicateGstinError,
  InvalidGstinError,
  HierarchyError,
  type GstRegistration,
  type OrgNode,
} from '../../packages/org/src/index';

// M01-FR-01 — the skeleton the whole system hangs on. Get it wrong and the symptoms
// appear everywhere: GST filed against the wrong registration, a manager seeing
// another branch's takings, a report that double-counts a warehouse.

const GSTIN_A = '33AABCS1429B1Z1'; // Tamil Nadu
const GSTIN_B = '33AAACT2727Q1Z3';
const GSTIN_OTHER_STATE = '29AAGCB7383J1Z4'; // Karnataka

const REGISTRATIONS: GstRegistration[] = [
  { gstin: GSTIN_A, companyId: 'co-1', stateCode: '33', legalName: 'SRE Hyper Market Pvt Ltd' },
  { gstin: GSTIN_B, companyId: 'co-2', stateCode: '33', legalName: 'SRE Wholesale LLP' },
];

const NODES: OrgNode[] = [
  { nodeId: 'co-1', tenantId: 't1', kind: 'company', name: 'SRE Hyper Market Pvt Ltd', parentId: null, status: 'active' },
  { nodeId: 'co-2', tenantId: 't1', kind: 'company', name: 'SRE Wholesale LLP', parentId: null, status: 'active' },
  { nodeId: 'br-1', tenantId: 't1', kind: 'branch', name: 'Main store', parentId: 'co-1', companyId: 'co-1', gstin: GSTIN_A, status: 'active' },
  { nodeId: 'wh-1', tenantId: 't1', kind: 'warehouse', name: 'Back warehouse', parentId: 'br-1', companyId: 'co-1', status: 'active' },
  { nodeId: 'dp-1', tenantId: 't1', kind: 'department', name: 'Fresh', parentId: 'br-1', status: 'active' },
  { nodeId: 'dp-2', tenantId: 't1', kind: 'department', name: 'Grocery', parentId: 'br-1', status: 'active' },
];

function register(): GstRegister {
  return new GstRegister(REGISTRATIONS);
}

describe('validateGstin — catch the typo when it is typed, not at the return', () => {
  it('accepts a well-formed GSTIN and normalises it', () => {
    expect(validateGstin(` ${GSTIN_A.toLowerCase()} `)).toBe(GSTIN_A);
    expect(gstStateCode(GSTIN_A)).toBe('33');
    expect(gstStateCode(GSTIN_OTHER_STATE)).toBe('29');
  });

  it('rejects the wrong length and the wrong shape with a clear reason', () => {
    expect(() => validateGstin('33AABCS1429B1Z')).toThrow(/15 characters/);
    expect(() => validateGstin('AABCS1429B1Z133')).toThrow(/GSTIN pattern/);
  });

  it('rejects a single mistyped digit through the check character', () => {
    // Same GSTIN with one digit changed — shape still valid, checksum is not.
    const mistyped = `33AABCS1429B1Z${GSTIN_A[14] === '1' ? '2' : '1'}`;
    expect(() => validateGstin(mistyped)).toThrow(InvalidGstinError);
    expect(() => validateGstin(mistyped)).toThrow(/mistyped/);
  });
});

describe('GstRegister — one GSTIN, one registration', () => {
  it('rejects a duplicate GSTIN and names who already holds it (acceptance)', () => {
    const gst = register();
    try {
      gst.add({ gstin: GSTIN_A, companyId: 'co-3', stateCode: '33', legalName: 'Someone Else' });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateGstinError);
      expect((error as Error).message).toContain('SRE Hyper Market Pvt Ltd');
      expect((error as Error).message).toContain('typo');
    }
  });

  it('finds a registration and lists a company’s registrations', () => {
    const gst = register();
    expect(gst.find(GSTIN_A.toLowerCase())?.legalName).toBe('SRE Hyper Market Pvt Ltd');
    expect(gst.forCompany('co-1')).toHaveLength(1);
    expect(gst.find('33AABCS9999B1Z9')).toBeUndefined();
  });

  it('refuses to register an invalid GSTIN at all', () => {
    expect(() =>
      register().add({ gstin: 'NOTAGSTIN', companyId: 'co-1', stateCode: '33', legalName: 'X' }),
    ).toThrow(InvalidGstinError);
  });
});

describe('validateNode — an incomplete node is a draft, not a rejection', () => {
  it('activates a branch that has a company and a valid GST registration', () => {
    const branch = NODES[2]!;
    expect(validateNode(branch, NODES, register())).toEqual([]);
    expect(canActivate(branch, NODES, register())).toBe(true);
  });

  it('blocks activating a branch with no GST registration (acceptance)', () => {
    const branch: OrgNode = { ...NODES[2]!, nodeId: 'br-new', gstin: undefined, status: 'draft' };
    const issues = validateNode(branch, [...NODES, branch], register());
    expect(canActivate(branch, [...NODES, branch], register())).toBe(false);
    expect(issues[0]?.message).toContain('unattributable');
  });

  it('blocks activating a branch with no company', () => {
    const branch: OrgNode = { ...NODES[2]!, nodeId: 'br-new', companyId: undefined, status: 'draft' };
    const issues = validateNode(branch, [...NODES, branch], register());
    expect(issues.some((i) => i.message.includes('exactly one company'))).toBe(true);
  });

  it('blocks a branch whose GSTIN belongs to a different company — wrong tax attribution', () => {
    const branch: OrgNode = { ...NODES[2]!, nodeId: 'br-new', gstin: GSTIN_B, status: 'draft' };
    const issues = validateNode(branch, [...NODES, branch], register());
    expect(issues[0]?.message).toContain('belongs to a different company');
  });

  it('blocks a GSTIN that is not registered here at all', () => {
    const branch: OrgNode = { ...NODES[2]!, nodeId: 'br-new', gstin: GSTIN_OTHER_STATE, status: 'draft' };
    const issues = validateNode(branch, [...NODES, branch], register());
    expect(issues[0]?.message).toContain('not registered to any company');
  });

  it('refuses a structurally impossible placement outright', () => {
    const orphan: OrgNode = { nodeId: 'x', tenantId: 't1', kind: 'branch', name: 'X', parentId: null, status: 'draft' };
    expect(() => validateNode(orphan, NODES, register())).toThrow(/must have a parent/);

    const underDepartment: OrgNode = { nodeId: 'y', tenantId: 't1', kind: 'branch', name: 'Y', parentId: 'dp-1', status: 'draft' };
    expect(() => validateNode(underDepartment, [...NODES, underDepartment], register())).toThrow(
      /cannot sit under a department/,
    );

    const companyWithParent: OrgNode = { nodeId: 'z', tenantId: 't1', kind: 'company', name: 'Z', parentId: 'co-1', status: 'draft' };
    expect(() => validateNode(companyWithParent, NODES, register())).toThrow(HierarchyError);

    const missingParent: OrgNode = { nodeId: 'w', tenantId: 't1', kind: 'department', name: 'W', parentId: 'nope', status: 'draft' };
    expect(() => validateNode(missingParent, NODES, register())).toThrow(/does not exist/);
  });

  it('refuses a node whose parent belongs to another tenant (ADR-0003)', () => {
    const crossTenant: OrgNode = { nodeId: 'x', tenantId: 't2', kind: 'department', name: 'X', parentId: 'br-1', status: 'draft' };
    expect(() => validateNode(crossTenant, [...NODES, crossTenant], register())).toThrow(
      /different tenant/,
    );
  });
});

describe('scoping — what a report or a permission actually covers', () => {
  it('returns every descendant of a node, at any depth', () => {
    expect(descendantsOf('co-1', NODES).map((n) => n.nodeId).sort()).toEqual([
      'br-1',
      'dp-1',
      'dp-2',
      'wh-1',
    ]);
    expect(descendantsOf('dp-1', NODES)).toEqual([]);
  });

  it('walks a node up to its company — how a transaction is attributed', () => {
    expect(ancestryOf('dp-1', NODES).map((n) => n.nodeId)).toEqual(['dp-1', 'br-1', 'co-1']);
  });

  it('resolves which GSTIN a department’s sales are filed under', () => {
    expect(gstinFor('dp-1', NODES)).toBe(GSTIN_A);
    expect(gstinFor('wh-1', NODES)).toBe(GSTIN_A);
    expect(gstinFor('co-2', NODES)).toBeUndefined(); // no branch yet
  });

  it('does not loop for ever if the parent links form a cycle', () => {
    const cyclic: OrgNode[] = [
      { nodeId: 'a', tenantId: 't1', kind: 'branch', name: 'A', parentId: 'b', status: 'active' },
      { nodeId: 'b', tenantId: 't1', kind: 'branch', name: 'B', parentId: 'a', status: 'active' },
    ];
    expect(ancestryOf('a', cyclic).map((n) => n.nodeId)).toEqual(['a', 'b']);
    expect(descendantsOf('a', cyclic).map((n) => n.nodeId)).toEqual(['b']);
  });
});
