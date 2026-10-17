import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerAndCommitteeRefusal, COMMITTEE_ROLE_ID, OWNER_ROLE } from '../../services/identity/src/committee-membership';
import { seedInitialAdmins } from '../../services/api/src/access';
import { INTERNAL_COMMITTEE_ROLE_ID, OWNER_ROLE_ID, ROLE_CATALOGUE } from '../../services/api/src/roles';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

// R2 C20 · owner decision OB-165 "A": the owner may add or remove Internal Committee members (that role only), but never
// holds the role himself — the rule every grant path applies, and the shape of the roles that makes OB-157 hold.

describe('OB-165: the owner role and the Internal Committee role never meet on one person', () => {
  it('the rule refuses the pair in either order and nothing else', () => {
    expect(OWNER_ROLE).toBe(OWNER_ROLE_ID);
    expect(COMMITTEE_ROLE_ID).toBe(INTERNAL_COMMITTEE_ROLE_ID);
    expect(ownerAndCommitteeRefusal(['owner', 'internal_committee'])).toContain('OB-165');
    expect(ownerAndCommitteeRefusal(['internal_committee', 'cashier', 'owner'])).toBeDefined();
    expect(ownerAndCommitteeRefusal(['internal_committee', 'cashier'])).toBeUndefined();
    expect(ownerAndCommitteeRefusal(['owner', 'store_manager'])).toBeUndefined();
  });

  it('the operator\'s initial admin set may not lay the owner down on the committee', async () => {
    await expect(seedInitialAdmins(new InMemoryEventStore(), randomUUID(), [{ userId: 'u-o', roleId: 'owner' }, { userId: 'u-o', roleId: 'internal_committee' }], 'u-tech', '2026-10-16T00:00:00.000Z'))
      .rejects.toThrow(/OB-165/);
  });

  it('the owner may manage membership, may read the counts-only report, and holds no permission to read or record a complaint (OB-157)', () => {
    const owner = ROLE_CATALOGUE.find((r) => r.id === OWNER_ROLE_ID)!;
    expect(owner.permissions).toEqual(expect.arrayContaining(['posh.committee.manage', 'posh.report.read', 'posh.report.file']));
    expect(owner.permissions.filter((p) => p.startsWith('posh.complaint.'))).toEqual([]);
    // Only the committee holds the complaint permissions; only the owner holds the membership one.
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes('posh.complaint.read')).map((r) => r.id)).toEqual([INTERNAL_COMMITTEE_ROLE_ID]);
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes('posh.committee.manage')).map((r) => r.id)).toEqual([OWNER_ROLE_ID]);
  });
});
