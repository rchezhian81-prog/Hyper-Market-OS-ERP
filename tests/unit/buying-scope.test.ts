import { describe, it, expect } from 'vitest';
import { judgeBuyingScope, localLimitFromRoles, LOCAL_PO_LIMIT_DEFAULTS, BUYING_SCOPES } from '../../packages/purchasing/src/index';

// M06-FR-04 · OB-289 (D-6 "Both, per order") · OB-290 (D-3 local limits): the buying-scope engine. Pure.

const base = { named: undefined, raiserCompanyWide: true, destination: 'store' as const, valueMinor: 1_000, localLimitMinor: undefined };

describe('buying scope per purchase order (M06-FR-04 · OB-289)', () => {
  it('has exactly the three scopes the owner chose', () => {
    expect([...BUYING_SCOPES]).toEqual(['central_via_warehouse', 'central_direct_to_store', 'local']);
  });

  it('derives the scope from who buys and where it goes, and says it was derived', () => {
    expect(judgeBuyingScope(base)).toEqual({ ok: true, scope: 'central_direct_to_store', source: 'derived' });
    expect(judgeBuyingScope({ ...base, destination: 'central_warehouse' })).toEqual({ ok: true, scope: 'central_via_warehouse', source: 'derived' });
    expect(judgeBuyingScope({ ...base, raiserCompanyWide: false, localLimitMinor: 5_000 })).toEqual({ ok: true, scope: 'local', source: 'derived' });
  });

  it('refuses a central order from a store-scoped person, and each scope at the wrong destination', () => {
    expect(judgeBuyingScope({ ...base, named: 'central_direct_to_store', raiserCompanyWide: false })).toMatchObject({ ok: false, refusal: 'central_buying_is_head_offices' });
    expect(judgeBuyingScope({ ...base, named: 'central_via_warehouse' })).toMatchObject({ ok: false, refusal: 'central_via_warehouse_needs_a_warehouse' });
    expect(judgeBuyingScope({ ...base, named: 'local', destination: 'central_warehouse', localLimitMinor: null })).toMatchObject({ ok: false, refusal: 'scope_delivers_to_a_store' });
    expect(judgeBuyingScope({ ...base, named: 'zonal' })).toMatchObject({ ok: false, refusal: 'unknown_buying_scope' });
  });

  it('caps a local order at the raiser\'s limit — never unlimited by default when no limit is known', () => {
    expect(judgeBuyingScope({ ...base, named: 'local', localLimitMinor: 2_500_000, valueMinor: 2_500_000 }).ok).toBe(true);
    expect(judgeBuyingScope({ ...base, named: 'local', localLimitMinor: 2_500_000, valueMinor: 2_500_001 })).toMatchObject({ ok: false, refusal: 'local_limit_exceeded' });
    expect(judgeBuyingScope({ ...base, named: 'local', localLimitMinor: null, valueMinor: 99_999_999 }).ok).toBe(true);
    expect(judgeBuyingScope({ ...base, named: 'local', localLimitMinor: undefined })).toMatchObject({ ok: false, refusal: 'local_limit_unknown' });
  });
});

describe('the local PO limit from the roles held (OB-290 config default, the seam package P1 replaces)', () => {
  it('holds exactly the owner\'s numbers: store manager ₹25,000, owner unlimited', () => {
    expect(LOCAL_PO_LIMIT_DEFAULTS).toEqual({ owner: null, store_manager: 2_500_000 });
    expect(localLimitFromRoles(['store_manager'])).toBe(2_500_000);
    expect(localLimitFromRoles(['store_manager', 'owner'])).toBeNull();
    expect(localLimitFromRoles(['cashier'])).toBeUndefined();
    expect(localLimitFromRoles([])).toBeUndefined();
    expect(localLimitFromRoles(['a', 'b'], { a: 100, b: 300 })).toBe(300);
  });
});
