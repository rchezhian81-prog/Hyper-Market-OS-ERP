import { describe, it, expect } from 'vitest';
import {
  approvalRequestRoutes, APPROVAL_KINDS,
  type ApprovalDecision, type ApprovalRequest, type NamedPerson, type ApprovalRequestDeps,
} from '../../services/identity/src/approval-requests';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * **OB-420 (owner, 27 Oct 2026, in writing — option B).** The approvals engine restricts a kind to ONE named person when
 * the kind says so (`decidedOnlyBy`): a `floor_device_review` (OB-407) is seen as decidable and decided only by the
 * security reviewer named NOW (OB-330), judged at decision time — never by everyone else who may read the risk register.
 * Anyone else is refused by name, nothing recorded; with nobody named nobody may decide it, and the asker is told (P-08).
 * Every other kind is untouched.
 */

const NOW = '2026-10-27T10:00:00.000Z';
const T = 't-sre';
const PEOPLE: Record<string, readonly string[]> = {
  'u-it': ['platform.flag.write'],
  'u-owner': ['compliance.risk.read', 'platform.config.approve', 'platform.flag.write'],
  'u-mgr': ['compliance.risk.read'],
  'u-siva': ['identity.self.read', 'compliance.risk.read'],
  'u-kala': ['identity.self.read', 'compliance.risk.read'],
  'u-norole': ['identity.self.read'],
};

function stub(withRegister = true) {
  const requests = new Map<string, ApprovalRequest>();
  const decisions = new Map<string, ApprovalDecision>();
  const versions = new Map<string, number>();
  const lookups: string[] = [];
  let reviewer: NamedPerson | undefined;
  const deps: ApprovalRequestDeps = {
    recordRequest: (_t, r) => { requests.set(r.requestId, r); },
    recordDecision: (_t, d, expected) => {
      if ((versions.get(d.requestId) ?? 0) !== expected) throw new Error('conflict');
      decisions.set(d.requestId, d); versions.set(d.requestId, expected + 1);
    },
    approvalState: (_t, id) => {
      const request = requests.get(id);
      return request === undefined ? undefined : { request, ...(decisions.has(id) ? { decision: decisions.get(id)! } : {}) };
    },
    approvalVersion: (_t, id) => versions.get(id) ?? 0,
    allRequests: () => [...requests.values()].map((request) => ({ request, ...(decisions.has(request.requestId) ? { decision: decisions.get(request.requestId)! } : {}) })),
    permissionsOfUser: (_t, u) => PEOPLE[u],
    ...(withRegister ? { namedDeciderOf: async (_t: string, role: string) => { lookups.push(role); return reviewer; } } : {}),
    now: () => NOW,
  };
  const routes = approvalRequestRoutes(deps);
  return { routes, decisions, lookups, name: (p: NamedPerson | undefined) => { reviewer = p; } };
}
const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: T, userId: 'u-it', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
interface Thrown { readonly status: number; readonly body: { readonly code: string; readonly whatHappened: string; readonly wasItSaved: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected a refusal');
}
const reviewAsk = { kind: 'floor_device_review', subjectRef: 'rollout:cctv:B1', details: { branchId: 'B1', enabled: true, reason: 'trial', key: 'cctv' }, summary: 'cctv on in B1', reason: 'trial' };
const ask = async (routes: readonly Route[], body: unknown = reviewAsk, userId = 'u-it') => {
  const r = await route(routes, 'POST', '/v1/approvals/requests').handler(ctx({ body, userId }));
  return r.body as { requestId: string; decider?: unknown };
};
const decideAs = (routes: readonly Route[], requestId: string, userId: string, decision = 'approved') =>
  route(routes, 'POST', '/v1/approvals/requests/:requestId/decide').handler(ctx({ body: { decision, reason: 'checked' }, userId, params: { requestId } }));
const inbox = async (routes: readonly Route[], userId: string) =>
  (await route(routes, 'GET', '/v1/approvals/requests').handler(ctx({ userId }))).body as { waitingForMe: { requestId: string }[]; mine: { requestId: string; decider?: unknown; status: string }[] };
const waitingFor = async (routes: readonly Route[], userId: string) => (await inbox(routes, userId)).waitingForMe.map((r) => r.requestId);

const SIVA = { userId: 'u-siva', displayName: 'Mr Sivakumar' };
const KALA = { userId: 'u-kala', displayName: 'Mrs Kala' };

describe('the kind says who alone decides it', () => {
  it('floor_device_review is decided only by the named security reviewer; no other kind is', () => {
    expect(APPROVAL_KINDS['floor_device_review']?.decidedOnlyBy).toBe('security_reviewer');
    expect(Object.values(APPROVAL_KINDS).filter((k) => k.decidedOnlyBy !== undefined).map((k) => k.kind)).toEqual(['floor_device_review']);
  });
});

describe('who sees a floor-device review as theirs to decide (GET /v1/approvals/requests)', () => {
  it('only the reviewer named now — never the owner or a manager who may read the risk register', async () => {
    const s = stub(); s.name(SIVA);
    const { requestId } = await ask(s.routes);
    expect(await waitingFor(s.routes, 'u-siva')).toEqual([requestId]);
    for (const who of ['u-owner', 'u-mgr', 'u-kala', 'u-it']) expect(await waitingFor(s.routes, who), who).toEqual([]);
  });

  it('follows the register: re-named → the new reviewer sees it, the old one no longer does', async () => {
    const s = stub(); s.name(SIVA);
    const { requestId } = await ask(s.routes);
    s.name(KALA);
    expect(await waitingFor(s.routes, 'u-siva')).toEqual([]);
    expect(await waitingFor(s.routes, 'u-kala')).toEqual([requestId]);
  });

  it('the named reviewer still needs the kind\'s checker permission (least privilege)', async () => {
    const s = stub(); s.name({ userId: 'u-norole', displayName: 'No role' });
    const { requestId } = await ask(s.routes);
    expect(await waitingFor(s.routes, 'u-norole')).toEqual([]);
    expect((await thrown(() => decideAs(s.routes, requestId, 'u-norole'))).body.code).toBe('not_permitted_for_this_approval');
  });

  it('the asker always sees their own request and who decides it; with nobody named, nobody sees it and the asker is told', async () => {
    const s = stub();
    const asked = await ask(s.routes);
    expect(asked.decider).toMatchObject({ role: 'security_reviewer', named: false, whatToDo: expect.stringContaining('No security reviewer is named') });
    for (const who of ['u-owner', 'u-mgr', 'u-siva', 'u-kala']) expect(await waitingFor(s.routes, who), who).toEqual([]);
    const mine = (await inbox(s.routes, 'u-it')).mine;
    expect(mine).toEqual([expect.objectContaining({ requestId: asked.requestId, status: 'waiting', decider: expect.objectContaining({ named: false }) })]);
    s.name(SIVA);
    expect((await inbox(s.routes, 'u-it')).mine[0]?.decider).toEqual({ role: 'security_reviewer', named: true, userId: 'u-siva', displayName: 'Mr Sivakumar' });
    expect((await ask(s.routes)).decider).toMatchObject({ named: true, userId: 'u-siva' });
  });

  it('a bare engine with no register wired decides it for nobody (fails closed, never open to all)', async () => {
    const s = stub(false);
    const { requestId } = await ask(s.routes);
    expect(await waitingFor(s.routes, 'u-mgr')).toEqual([]);
    expect((await thrown(() => decideAs(s.routes, requestId, 'u-mgr'))).body.code).toBe('name_the_security_reviewer_first');
  });

  it('other kinds are untouched: a flag_change is decided by any holder of its permission, and reads the register never', async () => {
    const s = stub(); s.name(SIVA);
    const asked = await ask(s.routes, { ...reviewAsk, kind: 'flag_change' });
    expect(asked.decider).toBeUndefined();
    expect(await waitingFor(s.routes, 'u-owner')).toEqual([asked.requestId]);
    s.lookups.length = 0;
    expect((await decideAs(s.routes, asked.requestId, 'u-owner')).status).toBe(201);
    expect(s.lookups).toEqual([]);
  });
});

describe('who may decide a floor-device review (POST …/decide) — judged at decision time', () => {
  it('anyone but the named reviewer is refused by name, nothing recorded; the reviewer decides', async () => {
    const s = stub(); s.name(SIVA);
    const { requestId } = await ask(s.routes);
    for (const who of ['u-mgr', 'u-owner', 'u-kala']) {
      for (const d of ['approved', 'rejected']) {
        const e = await thrown(() => decideAs(s.routes, requestId, who, d));
        expect([e.status, e.body.code, e.body.wasItSaved], who).toEqual([403, 'only_the_named_security_reviewer_decides', 'not_saved']);
        expect(e.body.whatHappened).toContain('Mr Sivakumar');
      }
    }
    expect(s.decisions.size).toBe(0);
    const ok = await decideAs(s.routes, requestId, 'u-siva');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ decision: 'approved', decidedBy: 'u-siva' });
    // The reviewer resending the same decision is answered as before.
    expect((await decideAs(s.routes, requestId, 'u-siva')).body).toMatchObject({ alreadyDecided: true });
    // Someone else trying it after it was decided is still refused by name, never told who-decided-what first.
    expect((await thrown(() => decideAs(s.routes, requestId, 'u-mgr'))).body.code).toBe('only_the_named_security_reviewer_decides');
  });

  it('re-named before the decision → the new reviewer decides, the old one is refused', async () => {
    const s = stub(); s.name(SIVA);
    const { requestId } = await ask(s.routes);
    s.name(KALA);
    expect((await thrown(() => decideAs(s.routes, requestId, 'u-siva'))).body.code).toBe('only_the_named_security_reviewer_decides');
    expect((await decideAs(s.routes, requestId, 'u-kala')).body).toMatchObject({ decidedBy: 'u-kala' });
  });

  it('with nobody named, nobody may decide it — refused by name (422), nothing recorded', async () => {
    const s = stub();
    const { requestId } = await ask(s.routes);
    for (const who of ['u-siva', 'u-owner', 'u-mgr']) {
      const e = await thrown(() => decideAs(s.routes, requestId, who));
      expect([e.status, e.body.code, e.body.wasItSaved]).toEqual([422, 'name_the_security_reviewer_first', 'not_saved']);
    }
    expect(s.decisions.size).toBe(0);
  });
});
