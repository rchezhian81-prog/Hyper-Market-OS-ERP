// MG-06 (cutover readiness): "who ran the load" is the STORED load record's operator — the person signed in when the
// load was recorded. Tests that sign control totals record a load as that person first, the way the load command does.

import type { ApiHarness } from './api-harness';

/** The smallest valid load record: one staged department, nothing quarantined. */
export const LOAD_RECORD_BODY = Object.freeze({
  sliceDigest: 'digest-test-1',
  department: { categoryId: 'dept-test', name: 'Test department' },
  counts: { 'products.csv': { rows: 1, staged: 1, quarantined: 0 } },
  exceptions: [],
});

/** Record load `loadId` in `tenantId` signed in as `operator`. Returns the response. */
export function recordLoadAs(h: ApiHarness, tenantId: string, operator: string, loadId = 'load-1') {
  return h.request({ method: 'POST', path: `/v1/migration/loads/${loadId}`, userId: operator, tenantId, idempotencyKey: `load-${loadId}-${operator}`, body: LOAD_RECORD_BODY });
}
