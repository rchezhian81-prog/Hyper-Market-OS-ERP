import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { backings, openDatabase, closeDatabase, caller } from '../support/r4-lane1';

/**
 * **W5 · M34-FR-03 · M34-FR-04 — the licence register and the control registers can be READ, on the real API (in memory
 * and on real PostgreSQL, with a restart).** Before W5 a licence could be registered, given evidence and closed, and a
 * control, an incident, a remediation and an attestation recorded — but nothing listed them: "keep evidence retrievable"
 * (M34-FR-03) and "links controls ↔ incidents ↔ remediation" (M34-FR-04) had no read. Now:
 *   • GET /v1/compliance/obligations — every licence the reader may see, active first, the closed kept with its reason, each
 *     with its named person and every piece of evidence; a cashier (no `compliance.obligation.read`) is refused;
 *   • GET /v1/compliance/control-register — every control, incident, remediation (the completed one still listed) and
 *     attestation (dated, in the attester's own name); a cashier (no `compliance.risk.read`) is refused.
 * Both survive a restart: they are folded from head office's append-only streams, not held in memory.
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

type Obl = { obligationId: string; status: string; responsible: { name: string }; evidence: { evidenceId: string }[]; closedReason?: string };
type Reg = { controls: { controlId: string }[]; incidents: { incidentId: string; controlId: string }[]; remediations: { remediationId: string; completedAt?: string }[]; attestations: { attestationId: string; attestedBy: string; attestedAt: string }[] };

describe.each(backings())('the licence and control registers are readable — on $name (M34-FR-03 · M34-FR-04)', ({ harness, restart }) => {
  it('lists every licence with its person and evidence, closed ones kept; lists every control with its incidents, remediations and checks', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-till', 'cashier');
    const { req, ok } = caller(() => h, T);

    const person = { userId: 'u-owner', name: 'Owner (test)' };
    await ok(req('POST', '/v1/compliance/obligations/lic-fssai', { kind: 'licence', name: 'FSSAI licence', authority: 'FSSAI', reference: '1002', validFrom: '2026-01-01', expiresOn: '2031-12-31', responsible: person }), 'register FSSAI');
    await ok(req('POST', '/v1/compliance/obligations/cert-scale', { kind: 'calibration', name: 'Scale 2 stamping', authority: 'Legal Metrology', validFrom: '2026-01-01', expiresOn: '2027-01-01', responsible: person }), 'register scale');
    await ok(req('POST', '/v1/compliance/obligations/lic-fssai/evidence', { evidenceId: 'DOC-77', description: 'licence copy' }), 'evidence');
    await ok(req('POST', '/v1/compliance/obligations/cert-scale/close', { reason: 'scale scrapped' }), 'close scale');

    await ok(req('POST', '/v1/compliance/controls/c-backup', { title: 'Backups encrypted', implements: 'P-04', ownerUserId: 'u-owner' }), 'control');
    await ok(req('POST', '/v1/compliance/incidents/i-1', { title: 'Backup left unencrypted', severity: 'sev2', occurredAt: '2026-11-02T17:00:00.000Z', detectedAt: '2026-11-02T17:30:00.000Z', controlId: 'c-backup' }), 'incident');
    await ok(req('POST', '/v1/compliance/remediations/rem-1', { incidentId: 'i-1', action: 'rotate key', ownerUserId: 'u-owner', dueOn: '2026-11-10' }), 'remediation');
    await ok(req('POST', '/v1/compliance/remediations/rem-1', { incidentId: 'i-1', action: 'rotate key', ownerUserId: 'u-owner', dueOn: '2026-11-10', completedAt: '2026-11-03T05:00:00.000Z' }), 'remediation done');
    await ok(req('POST', '/v1/compliance/attestations/a-1', { controlId: 'c-backup', statement: 'restored a backup to a spare disk' }), 'attest');

    h = restart(h);

    const obl = (await ok(req('GET', '/v1/compliance/obligations'), 'list')).body as { obligations: Obl[]; count: number; active: number };
    expect(obl.obligations.map((o) => [o.obligationId, o.status])).toEqual([['lic-fssai', 'active'], ['cert-scale', 'closed']]);
    expect(obl).toMatchObject({ count: 2, active: 1 });
    expect(obl.obligations[0]!.evidence.map((e) => e.evidenceId)).toEqual(['DOC-77']);
    expect(obl.obligations[0]!.responsible.name).toBe('Owner (test)');
    expect(obl.obligations[1]!.closedReason).toBe('scale scrapped');

    const reg = (await ok(req('GET', '/v1/compliance/control-register'), 'register')).body as Reg;
    expect(reg.controls.map((c) => c.controlId)).toEqual(['c-backup']);
    expect(reg.incidents).toEqual([expect.objectContaining({ incidentId: 'i-1', controlId: 'c-backup' })]);
    expect(reg.remediations).toEqual([expect.objectContaining({ remediationId: 'rem-1', completedAt: '2026-11-03T05:00:00.000Z' })]);
    expect(reg.attestations).toEqual([expect.objectContaining({ attestationId: 'a-1', attestedBy: 'u-owner' })]);
    expect(reg.attestations[0]!.attestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect((await req('GET', '/v1/compliance/obligations', undefined, 'u-till')).status).toBe(403);
    expect((await req('GET', '/v1/compliance/control-register', undefined, 'u-till')).status).toBe(403);
  });
});
