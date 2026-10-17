import { describe, it, expect } from 'vitest';
import { buildSurface } from '../../services/api/src/main';
import { PERSONAL_DATA_ADAPTER_CATEGORIES } from '../../services/api/src/r2-data-adapters';
import { checkProcessorRegister } from '../../packages/customer/src/processor-register';
import type { AdapterCategory } from '../../packages/integration/src/adapters';

// C6 (v2.1 addendum · M16/M32 · DPDP s.8(2)) — the NEVER claim: a vendor never processes the shop's personal data without
// a register entry and nobody being told.
//   • the register's check is served by the running API, behind the privacy authority;
//   • every integration category is decided: it either carries personal data (and its vendors are checked) or it is
//     hardware. A new category added to the adapter registry fails here until someone decides which it is;
//   • the check never passes a vendor it has no entry for.

/** Every adapter category the registry knows — written here so a new one fails this file until it is decided. */
const ALL_CATEGORIES: readonly AdapterCategory[] = ['accounting', 'payment', 'tax_portal', 'messaging', 'logistics', 'hardware'];
const NOT_PERSONAL_DATA: readonly AdapterCategory[] = ['hardware'];

describe('guardrail: personal data is never processed without a registered contract (C6)', () => {
  it('the API serves the register and its check, behind the privacy authority', () => {
    const routes = buildSurface({ signingKey: ['sre', 'guard', 'pack', 'key'].join('-').padEnd(48, '0'), migrationTargetKind: 'rehearsal' });
    const mine = routes.filter((r) => r.path === '/v1/privacy/processor-contracts');
    expect(mine.map((r) => `${r.method} ${r.permission}`).sort()).toEqual(['GET privacy.request.manage', 'POST privacy.request.manage']);
  });

  it('every integration category is decided: personal-data categories are checked, the rest is hardware', () => {
    expect([...PERSONAL_DATA_ADAPTER_CATEGORIES, ...NOT_PERSONAL_DATA].sort()).toEqual([...ALL_CATEGORIES].sort());
  });

  it('a vendor with no entry is always flagged — whatever it is called, however it was seen', () => {
    for (const seenIn of ['integration-adapter:x', 'erasure-notice:y']) {
      const r = checkProcessorRegister({ entries: [], activities: [{ vendorName: 'Anyone', seenIn, dataCategories: [] }], asOf: '2026-10-16' });
      expect(r.compliant).toBe(false);
      expect(r.findings.map((f) => f.flag)).toEqual(['processing_without_a_register_entry']);
    }
  });
});
