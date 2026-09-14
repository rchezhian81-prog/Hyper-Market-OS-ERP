import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// HR/Workforce DURABLE checklist-completion store (M25-FR-02 follow-on) on the live API. The POST
// /v1/hr/workforce/checklist-assess route is a stateless what-if; this persists a SUBMITTED opening/closing/
// handover checklist (append-only, latest-per-checklistId, hard rule #2/#6) so GET /v1/hr/workforce/checklists
// [/:id/status] reads the STORED checklist and runs the tested assessChecklist — a blocking item outstanding
// stops the shop, an unsigned one is not a record, a signed one with only non-blocking items left is complete
// and carries them into the handover. Writes gated workforce.roster.manage; reads workforce.checklist.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const putChecklist = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/checklists/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const statusOf = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/hr/workforce/checklists/${id}/status`, userId: u, tenantId: A });
const listChecklists = (h: ApiHarness, u: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/checklists', userId: u, tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Item { readonly itemId: string; readonly description: string; readonly done: boolean; readonly blocking: boolean }
interface Assessment { readonly outcome: string; readonly complete: boolean; readonly outstanding: readonly Item[]; readonly blockingOutstanding: readonly Item[] }
interface StatusBody { readonly checklist: { readonly checklistId: string; readonly signedBy?: string }; readonly assessment: Assessment }
interface ListBody { readonly checklists: readonly (StatusBody['checklist'] & { readonly assessment: Assessment })[]; readonly count: number; readonly blocked: number }
const statusBody = (res: { body: unknown }): StatusBody => res.body as StatusBody;
const listBody = (res: { body: unknown }): ListBody => res.body as ListBody;

// A closing checklist: the safe (blocking) and the fridge log (non-blocking).
const closing = (over: { safeDone?: boolean; logDone?: boolean; signedBy?: string; branchId?: string } = {}) => ({
  kind: 'closing' as const,
  items: [
    { itemId: 'safe', description: 'Cash in the safe, counted', done: over.safeDone ?? false, blocking: true },
    { itemId: 'log', description: 'Fridge temperature log filled', done: over.logDone ?? false, blocking: false },
  ],
  ...(over.signedBy !== undefined ? { signedBy: over.signedBy } : {}),
  ...(over.branchId !== undefined ? { branchId: over.branchId } : {}),
});

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // workforce.roster.manage + checklist.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('durable checklist-completion store (M25-FR-02 follow-on)', () => {
  it('a blocking item outstanding stops the shop; an unsigned complete list is not a record; signed + done is complete', async () => {
    const h = await cast();

    // Safe not counted (a blocking item) → the shop cannot close, whatever else is done.
    expect((await putChecklist(h, 'u-mgr', 'CL-1', closing({ safeDone: false, logDone: true, signedBy: 'Meena' }), 'k1')).status).toBe(200);
    let s = statusBody(await statusOf(h, 'u-mgr', 'CL-1'));
    expect(s.assessment.outcome).toBe('blocked_item');
    expect(s.assessment.complete).toBe(false);
    expect(s.assessment.blockingOutstanding.map((i) => i.itemId)).toEqual(['safe']);

    // Everything done but NOBODY signed → a list, not a record (superseding the earlier submission).
    expect((await putChecklist(h, 'u-mgr', 'CL-1', closing({ safeDone: true, logDone: true }), 'k2')).status).toBe(200);
    s = statusBody(await statusOf(h, 'u-mgr', 'CL-1'));
    expect(s.assessment.outcome).toBe('not_signed');
    expect(s.assessment.complete).toBe(false);

    // Signed with everything done → complete.
    expect((await putChecklist(h, 'u-mgr', 'CL-1', closing({ safeDone: true, logDone: true, signedBy: 'Meena' }), 'k3')).status).toBe(200);
    s = statusBody(await statusOf(h, 'u-mgr', 'CL-1'));
    expect(s.assessment.outcome).toBe('complete');
    expect(s.assessment.complete).toBe(true);
    expect(s.checklist.signedBy).toBe('Meena');
  });

  it('a signed checklist with only non-blocking items left is complete and carries them into the handover, and it survives a restart', async () => {
    const h = await cast();
    // Safe counted (blocking done), fridge log NOT filled (non-blocking) → complete but carries the log forward.
    await putChecklist(h, 'u-mgr', 'CL-2', closing({ safeDone: true, logDone: false, signedBy: 'Ravi' }), 'k1');

    const restarted = apiHarness({ store: h.store });
    const s = statusBody(await statusOf(restarted, 'u-owner', 'CL-2'));
    expect(s.assessment.outcome).toBe('incomplete');
    expect(s.assessment.complete).toBe(true); // signed, no blocking item left → the shop may close
    expect(s.assessment.blockingOutstanding).toEqual([]);
    expect(s.assessment.outstanding.map((i) => i.itemId)).toEqual(['log']); // carried, visible, into the handover
  });

  it('the list surfaces the blocked count and filters by branch', async () => {
    const h = await cast();
    await putChecklist(h, 'u-mgr', 'CL-A', closing({ safeDone: false, logDone: true, signedBy: 'Meena', branchId: 'b1' }), 'k1'); // blocked
    await putChecklist(h, 'u-mgr', 'CL-B', closing({ safeDone: true, logDone: true, signedBy: 'Meena', branchId: 'b1' }), 'k2');  // complete
    await putChecklist(h, 'u-mgr', 'CL-C', closing({ safeDone: false, logDone: true, signedBy: 'Ravi', branchId: 'b2' }), 'k3');  // blocked, other branch

    const all = listBody(await listChecklists(h, 'u-mgr'));
    expect(all.count).toBe(3);
    expect(all.blocked).toBe(2);

    const b1 = listBody(await listChecklists(h, 'u-mgr', { branchId: 'b1' }));
    expect(b1.count).toBe(2);
    expect(b1.blocked).toBe(1);
    expect(b1.checklists.every((c) => c.checklistId !== 'CL-C')).toBe(true);
  });

  it('404s for an unknown checklist, gates writes/reads, and refuses a malformed checklist', async () => {
    const h = await cast();
    await putChecklist(h, 'u-mgr', 'CL-1', closing({ safeDone: true, logDone: true, signedBy: 'Meena' }), 'k1');

    expect((await statusOf(h, 'u-mgr', 'GHOST')).status).toBe(404);
    // A cashier can neither submit a checklist nor read one.
    expect((await putChecklist(h, 'u-cash', 'CL-2', closing({ signedBy: 'x' }), 'k2')).status).toBe(403);
    expect((await statusOf(h, 'u-cash', 'CL-1')).status).toBe(403);
    expect((await listChecklists(h, 'u-cash')).status).toBe(403);
    // A malformed checklist (bad kind) is refused, nothing stored.
    expect(codeOf(await putChecklist(h, 'u-mgr', 'CL-bad', { kind: 'midday', items: [] }, 'k3'))).toBe('not_readable_as_a_checklist');
  });
});
