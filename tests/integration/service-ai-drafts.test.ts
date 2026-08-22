import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// AI-drafted service replies, end to end (M21-FR-03 · P-05 / hard rule #5, API-06). An AI drafts, a NAMED
// HUMAN sends: a recorded draft is always unapproved, and approving it — the ONLY way it becomes sendable,
// there is deliberately no send route — is attributed to the logged-in person, never a model. A draft
// must CITE evidence so the approver has something to check it against; an edit is recorded as an edit so
// the shop can see whether the model is helping or generating work. Gated service.case.manage / .read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASE = { kind: 'complaint', customerRef: 'c1', priority: 'normal', summary: 'late delivery', assignedTo: 'u-agent' };

const open = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}`, userId: u, tenantId: A, idempotencyKey: `open-${id}`, body: CASE });
const draft = (h: ApiHarness, u: string, caseId: string, draftId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${caseId}/drafts/${draftId}`, userId: u, tenantId: A, idempotencyKey: key ?? `dr-${draftId}`, body });
const decide = (h: ApiHarness, u: string, caseId: string, draftId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${caseId}/drafts/${draftId}/decision`, userId: u, tenantId: A, idempotencyKey: key ?? `de-${draftId}`, body });
const listDrafts = (h: ApiHarness, u: string, caseId: string) =>
  h.request({ method: 'GET', path: `/v1/service/cases/${caseId}/drafts`, userId: u, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const EV = { text: 'Sorry — your replacement is on its way.', modelRef: 'assistant-v1', evidenceRefs: ['order-123', 'case-note-1'] };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // service.case.manage + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  await open(h, 'u-mgr', 'k1');
  return h;
}

describe('AI drafts a reply, a named human sends it (M21-FR-03 · P-05)', () => {
  it('records an unapproved draft and makes it sendable only when a named human approves it', async () => {
    const h = await cast();
    const rec = await draft(h, 'u-mgr', 'k1', 'd1', EV);
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({ approved: false, evidenceCount: 2 });

    const done = await decide(h, 'u-mgr', 'k1', 'd1', { decision: 'approved' });
    expect(done.status).toBe(201);
    // Sendable, in the approver's name, carrying the drafted text.
    expect(done.body).toMatchObject({ sendable: true, approvedBy: 'u-mgr', text: EV.text });

    const list = (await listDrafts(h, 'u-owner', 'k1')).body as { drafts: { draftId: string; decision: { sendable: boolean; approvedBy: string } | null }[] };
    expect(list.drafts.find((d) => d.draftId === 'd1')?.decision).toMatchObject({ sendable: true, approvedBy: 'u-mgr' });
  });

  it('refuses a draft with no evidence and an empty edit, but takes an edited-and-approved reply', async () => {
    const h = await cast();
    // A draft citing no evidence can be recorded, but not approved — nothing to check it against.
    await draft(h, 'u-mgr', 'k1', 'd-noev', { text: 'trust me', modelRef: 'm', evidenceRefs: [] });
    expect(codeOf(await decide(h, 'u-mgr', 'k1', 'd-noev', { decision: 'approved' }))).toBe('draft_not_approvable');

    // An edit becomes sendable with the human's final words.
    await draft(h, 'u-mgr', 'k1', 'd-edit', EV);
    const edited = await decide(h, 'u-mgr', 'k1', 'd-edit', { decision: 'edited_and_approved', finalText: 'We are very sorry; a replacement ships today.' });
    expect(edited.status).toBe(201);
    expect(edited.body).toMatchObject({ sendable: true, decision: 'edited_and_approved', text: 'We are very sorry; a replacement ships today.' });

    // An empty edit cannot be sent.
    await draft(h, 'u-mgr', 'k1', 'd-empty', EV);
    expect(codeOf(await decide(h, 'u-mgr', 'k1', 'd-empty', { decision: 'edited_and_approved', finalText: '   ' }))).toBe('draft_not_approvable');
  });

  it('records a rejection as a decision (not an error), and lists drafts with their outcomes', async () => {
    const h = await cast();
    await draft(h, 'u-mgr', 'k1', 'd-rej', EV);
    const rej = await decide(h, 'u-mgr', 'k1', 'd-rej', { decision: 'rejected' });
    expect(rej.status).toBe(200); // a human decision, not a failure
    expect(rej.body).toMatchObject({ sendable: false, decision: 'rejected' });

    const list = (await listDrafts(h, 'u-owner', 'k1')).body as { drafts: { draftId: string; decision: { sendable: boolean } | null }[] };
    expect(list.drafts.find((d) => d.draftId === 'd-rej')?.decision).toMatchObject({ sendable: false });
  });

  it('is gated to service-desk staff and 404s an unknown case or draft', async () => {
    const h = await cast();
    expect((await draft(h, 'u-cash', 'k1', 'x', EV)).status).toBe(403);
    expect((await listDrafts(h, 'u-cash', 'k1')).status).toBe(403);
    expect((await draft(h, 'u-mgr', 'ghost', 'x', EV)).status).toBe(404);
    expect((await decide(h, 'u-mgr', 'k1', 'no-such-draft', { decision: 'approved' })).status).toBe(404);
  });
});
