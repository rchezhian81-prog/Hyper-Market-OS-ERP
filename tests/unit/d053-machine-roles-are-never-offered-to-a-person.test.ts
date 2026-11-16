import { describe, it, expect } from 'vitest';
import { isMachineRole, usersWords } from '../../apps/web-erp/src/users-session';
import { MACHINE_ROLE_IDS } from '../../services/identity/src/separation-of-duties';
import { MACHINE_ONLY_ROLES } from '../../services/identity/src/machine-identities';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **D-053 (OB-800 THE PLAN, daily-work walkthrough): Users & roles offered six machine roles ("Message provider relay
 * (machine)", "CI findings push (machine)", …) beside the roles a person holds.** `isMachineRole` — the page's rule for
 * leaving them out — names every role head office itself treats as a machine's, and no role a person is given.
 */

describe('D-053 — the machine roles are left out of the roles a person can be given', () => {
  const catalogue = ROLE_CATALOGUE as readonly { readonly id: string; readonly name: string }[];

  it('every role head office treats as a machine\'s is a machine role here', () => {
    for (const id of new Set([...MACHINE_ROLE_IDS, ...MACHINE_ONLY_ROLES])) {
      const r = catalogue.find((x) => x.id === id);
      expect(r, `${id} is in the role catalogue`).toBeDefined();
      expect(isMachineRole(r!), id).toBe(true);
    }
  });

  it('the people\'s roles are not', () => {
    for (const id of ['owner', 'store_manager', 'cashier', 'accountant', 'purchase_user', 'receiver_qc', 'warehouse_user', 'picker', 'delivery_driver']) {
      const r = catalogue.find((x) => x.id === id);
      if (r === undefined) continue;
      expect(isMachineRole(r), id).toBe(false);
    }
    expect(catalogue.filter((r) => !isMachineRole(r)).length).toBeGreaterThan(10);
  });

  it('the stores box says to choose, in English and Tamil — never "ids, comma between"', () => {
    expect(usersWords('en', 'stores')).not.toMatch(/ids, comma/);
    expect(usersWords('ta', 'stores')).toMatch(/தேர்வு/);
    expect(usersWords('en', 'added')).toMatch(/give them a role below, then set their till PIN/);
  });
});
