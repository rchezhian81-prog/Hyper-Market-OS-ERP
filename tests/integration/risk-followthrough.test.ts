import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Incident / remediation / control-health / attestation, end to end (M34-FR-04 follow-on, compliance API).
// The registers exist to answer three questions the moment something goes wrong: WHICH control was supposed
// to stop this (incident → control), WHAT are we doing and WHO owns it (incident → remediation), and DID
// ANYONE check the control works (control → attestation). Every link is mandatory — a register whose links
// are optional degrades into a list nobody reads. Control-health folds all four together: has it failed, is
// the fix late, has anyone checked it lately. Gated compliance.risk.manage (write) / .read (reports).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const control = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/compliance/controls/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `ctl-${id}`, body });
const incident = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/compliance/incidents/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `inc-${id}`, body });
const remediation = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/compliance/remediations/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `rem-${id}`, body });
const attest = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/compliance/attestations/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `att-${id}`, body });
const health = (h: ApiHarness, u: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/compliance/controls/health', userId: u, tenantId: A, ...(query ? { query } : {}) });
const overdue = (h: ApiHarness, u: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/compliance/remediations/overdue', userId: u, tenantId: A, ...(query ? { query } : {}) });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type HealthRow = { controlId: string; incidentCount: number; overdueRemediations: number; needsAttestation: boolean; lastAttestedAt?: string };
const rowFor = (res: { body: unknown }, controlId: string): HealthRow | undefined =>
  (res.body as { health: HealthRow[] }).health.find((r) => r.controlId === controlId);

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // compliance.risk.manage + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('compliance follow-through: incident → remediation → attestation → control health (M34-FR-04)', () => {
  it('folds a failed-and-fixed-late-and-freshly-checked control, and survives a restart', async () => {
    const h = await cast();
    expect((await control(h, 'u-mgr', 'c-sod', { title: 'segregation of duties on refunds', implements: 'SEC-03', ownerUserId: 'u-sec' })).status).toBe(201);
    // An incident the control failed to stop.
    expect((await incident(h, 'u-mgr', 'i-1', { title: 'cashier approved own refund', severity: 'sev2', occurredAt: '2026-08-01T09:00:00Z', detectedAt: '2026-08-02T09:00:00Z', controlId: 'c-sod' })).status).toBe(201);
    // A remediation due 10 Aug and not done → overdue as of 24 Aug.
    expect((await remediation(h, 'u-mgr', 'rem-1', { incidentId: 'i-1', action: 'enforce four-eyes on refunds', ownerUserId: 'u-dev', dueOn: '2026-08-10' })).status).toBe(201);
    // Someone actually checked the control on 20 Aug — a fresh, dated attestation in their own name.
    const att = await attest(h, 'u-mgr', 'att-1', { controlId: 'c-sod', statement: 'reviewed the week\'s refund approvals', attestedAt: '2026-08-20T10:00:00Z' });
    expect(att.status).toBe(201);
    expect(att.body).toMatchObject({ controlId: 'c-sod', attestedBy: 'u-mgr', attestedAt: '2026-08-20T10:00:00Z' }); // own name (§28)

    const hres = await health(h, 'u-owner', { asOf: '2026-08-24', validDays: '90' });
    expect(hres.status).toBe(200);
    const row = rowFor(hres, 'c-sod');
    expect(row).toMatchObject({ incidentCount: 1, overdueRemediations: 1, needsAttestation: false });
    expect(row?.lastAttestedAt).toBe('2026-08-20T10:00:00Z');

    // The follow-through report names the late fix.
    const od = await overdue(h, 'u-owner', { asOf: '2026-08-24' });
    expect((od.body as { count: number; overdue: { remediationId: string }[] }).count).toBe(1);
    expect((od.body as { overdue: { remediationId: string }[] }).overdue[0]?.remediationId).toBe('rem-1');

    // All of it is event-sourced — the health fold is identical after a cold restart.
    const restarted = apiHarness({ store: h.store });
    expect(rowFor(await health(restarted, 'u-owner', { asOf: '2026-08-24', validDays: '90' }), 'c-sod'))
      .toMatchObject({ incidentCount: 1, overdueRemediations: 1, needsAttestation: false });
  });

  it('insists on every link — an incident, a remediation and an attestation that point at nothing are all refused', async () => {
    const h = await cast();
    await control(h, 'u-mgr', 'c-x', { title: 'a control', implements: 'P-04', ownerUserId: 'u-sec' });

    // Incident naming a control nobody registered.
    expect(codeOf(await incident(h, 'u-mgr', 'i-ghost', { title: 'x', severity: 'sev1', occurredAt: '2026-08-01T00:00:00Z', detectedAt: '2026-08-01T00:00:00Z', controlId: 'c-nope' }))).toBe('incident_links_to_no_control');
    // Remediation naming an incident nobody logged.
    expect(codeOf(await remediation(h, 'u-mgr', 'r-ghost', { incidentId: 'i-nope', action: 'a', ownerUserId: 'u-dev', dueOn: '2026-08-10' }))).toBe('remediation_links_to_no_incident');
    // Attestation naming a control nobody registered.
    expect(codeOf(await attest(h, 'u-mgr', 'a-ghost', { controlId: 'c-nope', statement: 'checked' }))).toBe('attestation_links_to_no_control');

    // A remediation with no owner is a wish — the tested engine says so (not a structural 400).
    await incident(h, 'u-mgr', 'i-2', { title: 'y', severity: 'sev3', occurredAt: '2026-08-01T00:00:00Z', detectedAt: '2026-08-01T00:00:00Z', controlId: 'c-x' });
    expect(codeOf(await remediation(h, 'u-mgr', 'r-noowner', { incidentId: 'i-2', action: 'a', ownerUserId: '   ', dueOn: '2026-08-10' }))).toBe('remediation_needs_owner_and_date');
  });

  it('reports an untested control as needing attestation, and a stale one too, and excludes a completed remediation', async () => {
    const h = await cast();
    // A control nobody has ever attested.
    await control(h, 'u-mgr', 'c-backup', { title: 'nightly backup verification', implements: 'QG-08', ownerUserId: 'u-ops' });
    // A control last checked long ago.
    await control(h, 'u-mgr', 'c-fire', { title: 'fire-exit inspection', implements: 'facilities', ownerUserId: 'u-fac' });
    await attest(h, 'u-mgr', 'att-old', { controlId: 'c-fire', statement: 'inspected', attestedAt: '2026-01-05T10:00:00Z' });

    const hres = await health(h, 'u-owner', { asOf: '2026-08-24', validDays: '90' });
    expect(rowFor(hres, 'c-backup')).toMatchObject({ needsAttestation: true }); // never attested
    expect(rowFor(hres, 'c-backup')?.lastAttestedAt).toBeUndefined();
    expect(rowFor(hres, 'c-fire')).toMatchObject({ needsAttestation: true });    // attested, but stale (Jan vs May cutoff)

    // A completed remediation is not overdue, even past its due date.
    await incident(h, 'u-mgr', 'i-3', { title: 'z', severity: 'sev2', occurredAt: '2026-07-01T00:00:00Z', detectedAt: '2026-07-01T00:00:00Z', controlId: 'c-backup' });
    await remediation(h, 'u-mgr', 'rem-done', { incidentId: 'i-3', action: 'fixed', ownerUserId: 'u-ops', dueOn: '2026-07-15', completedAt: '2026-07-14T00:00:00Z' });
    const od = await overdue(h, 'u-owner', { asOf: '2026-08-24' });
    expect((od.body as { count: number }).count).toBe(0);
  });

  it('is gated — a cashier can neither record nor read the registers', async () => {
    const h = await cast();
    expect((await control(h, 'u-cash', 'c-1', { title: 'x', implements: 'P', ownerUserId: 'u-sec' })).status).toBe(403);
    expect((await incident(h, 'u-cash', 'i-1', { title: 'x', severity: 'sev1', occurredAt: '2026-08-01T00:00:00Z', detectedAt: '2026-08-01T00:00:00Z', controlId: 'c-1' })).status).toBe(403);
    expect((await attest(h, 'u-cash', 'a-1', { controlId: 'c-1', statement: 's' })).status).toBe(403);
    expect((await health(h, 'u-cash')).status).toBe(403);
    expect((await overdue(h, 'u-cash')).status).toBe(403);
  });
});
