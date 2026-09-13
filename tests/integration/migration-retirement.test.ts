import { describe, it, expect } from 'vitest';
import type { HttpResponse } from '../../services/kernel/src/index';
import { apiHarness } from '../support/api-harness';

/**
 * **MG-12 legacy-system retirement, through the REAL authenticated pipeline (API-12).**
 *
 * The day after a successful cutover, somebody suggests switching the old system off. This gate answers
 * "may the legacy SYSTEM be retired?" and names every blocker at once: retention is a DATE in the future
 * (run from the data, not confidence), the restore must have been demonstrated, the cutover must be
 * accepted, and no open assessment may still need the records. Retiring the system NEVER deletes the
 * data — the archive stays read-only (hard rule #6). Synthetic data; the harness target is 'rehearsal'.
 */

const T = 't-sre';
const OWNER = 'u-owner';
const bodyOf = (res: HttpResponse) => (typeof res.body === 'string' ? JSON.parse(res.body) : res.body);

async function seeded() {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  return h;
}
const post = (h: Awaited<ReturnType<typeof seeded>>, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path: '/v1/migration/retirement/assessment', userId, tenantId: T, idempotencyKey: key, body });

// An archive whose retention has long elapsed (latest record 2015, 8-year retention → 2023), with a
// verified restore. On its own this is retirable — the other blockers come from the request.
const archive = (over: Record<string, unknown> = {}) => ({
  archiveId: 'A1', tenantId: T, sourceId: 'old-erp', digest: 'sha:abc', rowCount: 500000,
  archivedAt: '2026-01-01T00:00:00Z', retentionYears: 8,
  earliestRecordDate: '2009-04-01', latestRecordDate: '2015-03-31',
  readOnly: true, restoreVerifiedAt: '2026-02-01T00:00:00Z', ...over,
});

describe('MG-12 legacy-system retirement over the real authenticated surface', () => {
  it('allows retirement when retention has elapsed, the restore is verified, cutover accepted, nothing open — and never deletes data', async () => {
    const h = await seeded();
    const res = await post(h, OWNER, 'r1', { archive: archive(), cutoverAccepted: true, openAssessments: 0 });
    expect(res.status).toBe(200);
    const a = bodyOf(res);
    expect(a.mayRetireSystem).toBe(true);
    expect(a.blockedBy).toEqual([]);
    expect(a.dataIsNeverDeleted).toBe(true);
  });

  it('names EVERY blocker at once, not just the first', async () => {
    const h = await seeded();
    // Retention not elapsed (latest 2024 + 8y = 2032), restore never verified, cutover not accepted, an open assessment.
    const res = await post(h, OWNER, 'r1', {
      archive: archive({ latestRecordDate: '2024-03-31', restoreVerifiedAt: undefined }),
      cutoverAccepted: false, openAssessments: 2,
    });
    expect(res.status).toBe(200);
    const a = bodyOf(res);
    expect(a.mayRetireSystem).toBe(false);
    expect([...a.blockedBy].sort()).toEqual(['cutover_not_accepted', 'open_assessment', 'restore_never_verified', 'retention_not_elapsed'].sort());
    expect(a.dataIsNeverDeleted).toBe(true); // still never deletes the data
  });

  it('refuses a malformed check and an archive that is not read-only', async () => {
    const h = await seeded();
    expect((await post(h, OWNER, 'r1', { archive: archive(), cutoverAccepted: 'yes', openAssessments: 0 })).status).toBe(400);
    expect((await post(h, OWNER, 'r2', { archive: archive({ readOnly: false }), cutoverAccepted: true, openAssessments: 0 })).status).toBe(400);
    expect((await post(h, OWNER, 'r3', { archive: archive(), cutoverAccepted: true, openAssessments: -1 })).status).toBe(400);
  });

  it('is authorized — a role without migration authority cannot run the retirement check', async () => {
    const h = await seeded();
    await h.provisionRole(T, 'u-sm', 'store_manager');
    expect((await post(h, 'u-sm', 'r1', { archive: archive(), cutoverAccepted: true, openAssessments: 0 })).status).toBe(403);
  });
});
