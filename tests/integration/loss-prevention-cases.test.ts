import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Loss-prevention investigation cases (M15-FR-04, API-05) end to end through the real API. A case is
// opened from a raised signal (never from a bare suspicion) and cannot be investigated by its subject;
// evidence is APPEND-ONLY and SEALED into a chain of custody; a case cannot close without an outcome and
// a note; a PROVEN outcome needs someone other than the investigator (§28), evidence on file and a
// verifying chain; and closed outcomes feed the rule-feedback loop that retires a rule that is always
// unfounded. (Tamper DETECTION of a corrupted seal is unit-covered in tests/unit/lp-cases.test.ts; here
// the chain is proven to persist and re-verify intact across the event store.)

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const open = (h: ApiHarness, t: string, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/loss-prevention/cases/${id}`, userId: u, tenantId: t, idempotencyKey: key ?? `open-${id}`, body });
const addEv = (h: ApiHarness, t: string, u: string, id: string, evId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/loss-prevention/cases/${id}/evidence/${evId}`, userId: u, tenantId: t, idempotencyKey: key ?? `ev-${id}-${evId}`, body });
const close = (h: ApiHarness, t: string, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/loss-prevention/cases/${id}/close`, userId: u, tenantId: t, idempotencyKey: key ?? `close-${id}-${u}`, body });
const getCase = (h: ApiHarness, t: string, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/loss-prevention/cases/${id}`, userId: u, tenantId: t });
const feedback = (h: ApiHarness, t: string, u: string) =>
  h.request({ method: 'GET', path: `/v1/loss-prevention/rule-feedback`, userId: u, tenantId: t });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const CASE = { raisedFromRef: 'voidabuse:till-1', subjectRef: 'staff-9', summary: 'repeated post-void refunds', valueMinor: 50_000, assignedTo: 'u-mgr' };
const EV = { kind: 'transaction_record', ref: 'txn-123', description: 'the voided line', collectedBy: 'u-mgr', collectedFrom: 'till-1 journal' };

interface CaseBody { state: string; outcome?: string; evidence: unknown[]; chain: { intact: boolean } }

describe('loss-prevention cases: raised-from-a-signal, sealed evidence, second-signer proven, rule feedback (M15-FR-04)', () => {
  it('opens from a raised signal, refuses self-investigation and a duplicate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await open(h, A, 'u-owner', 'c1', CASE)).status).toBe(201);
    // The subject cannot investigate their own case.
    expect(codeOf(await open(h, A, 'u-owner', 'c2', { ...CASE, assignedTo: 'staff-9' }))).toBe('case_refused');
    // A case must come from a raised reference.
    expect((await open(h, A, 'u-owner', 'c3', { ...CASE, raisedFromRef: '' })).status).toBe(400);
    // Open-once.
    expect(codeOf(await open(h, A, 'u-owner', 'c1', CASE, 'open-c1-again'))).toBe('case_already_open');
  });

  it('keeps evidence append-only and sealed, with a chain of custody that verifies', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await open(h, A, 'u-owner', 'c1', CASE);

    const e1 = await addEv(h, A, 'u-owner', 'c1', 'e1', EV);
    expect(e1.status).toBe(201);
    expect((e1.body as { seal: string }).seal).toBeTruthy();
    expect((await addEv(h, A, 'u-owner', 'c1', 'e2', { ...EV, kind: 'cctv_reference', ref: 'clip-7' })).status).toBe(201);

    const got = (await getCase(h, A, 'u-owner', 'c1')).body as CaseBody;
    expect(got.evidence).toHaveLength(2);
    expect(got.chain.intact).toBe(true);   // the persisted seal chain re-verifies

    // Evidence with no chain of custody is refused at the door (a missing required field).
    expect((await addEv(h, A, 'u-owner', 'c1', 'e3', { ...EV, collectedFrom: '' })).status).toBe(400);
    // The same evidence id twice is refused by the engine (a fresh transport key so it reaches the handler).
    expect(codeOf(await addEv(h, A, 'u-owner', 'c1', 'e1', EV, 'ev-c1-e1-again'))).toBe('evidence_refused');
  });

  it('cannot close without an outcome note; proven needs a second signer and evidence; unfounded is first-class', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    await open(h, A, 'u-mgr', 'c1', CASE);           // assigned to u-mgr
    await addEv(h, A, 'u-mgr', 'c1', 'e1', EV);

    // A note is required.
    expect((await close(h, A, 'u-owner', 'c1', { outcome: 'proven' })).status).toBe(400);
    // The investigator cannot sign off their own PROVEN case (§28).
    expect(codeOf(await close(h, A, 'u-mgr', 'c1', { outcome: 'proven', note: 'caught on camera' }))).toBe('close_refused');
    // Someone else may.
    expect((await close(h, A, 'u-owner', 'c1', { outcome: 'proven', note: 'caught on camera' })).status).toBe(200);

    // Unfounded is a first-class outcome and needs no second signer or evidence.
    await open(h, A, 'u-mgr', 'c2', CASE);
    const un = await close(h, A, 'u-mgr', 'c2', { outcome: 'unfounded', note: 'the till roll explains it' });
    expect(un.status).toBe(200);
    expect((un.body as { outcome: string }).outcome).toBe('unfounded');
  });

  it('feeds the rule loop: a rule whose every case is unfounded is recommended for retirement', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Five cases all raised by the same rule, all closed unfounded — the rule is spending attention.
    for (let i = 1; i <= 5; i += 1) {
      const id = `c-noise-${i}`;
      await open(h, A, 'u-owner', id, { ...CASE, raisedFromRef: `noisyrule:till-${i}` });
      await close(h, A, 'u-owner', id, { outcome: 'unfounded', note: 'nothing in it' });
    }
    const adj = (await feedback(h, A, 'u-owner')).body as { adjustments: { ruleRef: string; action: string }[] };
    const noisy = adj.adjustments.find((a) => a.ruleRef === 'noisyrule');
    expect(noisy?.action).toBe('retire');
  });

  it('is authorized (manage vs read) and per-tenant', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // manages and reads
    await h.provisionRole(A, 'u-acct', 'accountant');     // reads only
    await h.provisionRole(A, 'u-cash', 'cashier');        // neither
    await open(h, A, 'u-mgr', 'c1', CASE);

    expect((await open(h, A, 'u-cash', 'c-x', CASE)).status).toBe(403);
    expect((await open(h, A, 'u-acct', 'c-y', CASE)).status).toBe(403);   // accountant may not manage
    expect((await getCase(h, A, 'u-acct', 'c1')).status).toBe(200);        // but may read
    expect((await getCase(h, A, 'u-cash', 'c1')).status).toBe(403);
    expect((await getCase(h, A, 'u-owner', 'ghost')).status).toBe(404);

    await h.seedOwner(B, 'u-owner-b');
    expect((await getCase(h, B, 'u-owner-b', 'c1')).status).toBe(404);
  });
});
