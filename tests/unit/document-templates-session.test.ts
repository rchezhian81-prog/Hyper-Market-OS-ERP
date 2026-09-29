import { describe, it, expect } from 'vitest';
import {
  createDocumentTemplatesSession, contentFromForm, linesOf,
  type DocumentTemplatePorts, type DocumentTemplateActPort, type TemplateRegisterData, type TemplateKindData, type TemplateVersionView, type DraftForm,
} from '../../apps/web-erp/src/document-templates-session';

/**
 * **The document-templates session model (M01-FR-02 · API-01 · §28 · P-08) — DOM-free, the rules the shell renders.**
 *
 * The register: a kind with nothing in force is a WARNING (documents print with defaults), never a blank. The
 * versions: newest first, each with its state as a word and an icon; APPROVE offered only on a draft to a person
 * who is NOT its author (§28, with the reason when withheld); PUBLISH only on an approved version. The acts refuse
 * locally what the cloud would refuse — no permission, content that would be a tax error (the engine's own
 * validator), the maker approving, a version in the wrong state — so nothing is sent that would come back refused.
 */

const V = (over: Partial<TemplateVersionView> = {}): TemplateVersionView => ({
  kind: 'receipt', version: 1, state: 'draft',
  content: { header: ['SRE Hyper Market', 'GSTIN: 33ABCDE1234F1Z5'], footer: ['Thank you'], language: 'en_ta', paperFormat: 'thermal-80' },
  note: 'first layout', authoredBy: 'u-owner', authoredAt: '2026-09-28T09:00:00.000Z', ...over,
});
const REGISTER: TemplateRegisterData = {
  kinds: [
    { kind: 'receipt', current: V({ state: 'published', publishedBy: 'u-owner', publishedAt: '2026-09-28T10:00:00.000Z' }), versions: 2 },
    { kind: 'invoice', current: null, versions: 0 },
    { kind: 'purchase_order', current: null, versions: 1 },
    { kind: 'grn', current: null, versions: 0 },
    { kind: 'statement', current: null, versions: 0 },
  ],
  asAt: '2026-09-29T09:00:00.000Z',
};
const KIND: TemplateKindData = {
  kind: 'receipt',
  current: V({ state: 'published', publishedBy: 'u-owner', publishedAt: '2026-09-28T10:00:00.000Z' }),
  versions: [
    V({ version: 1, state: 'superseded', approvedBy: 'u-padmin', publishedBy: 'u-owner', supersededBy: 2 }),
    V({ version: 2, state: 'published', approvedBy: 'u-padmin', publishedBy: 'u-owner' }),
    V({ version: 3, state: 'approved', authoredBy: 'u-padmin', approvedBy: 'u-owner' }),
    V({ version: 4, state: 'draft', authoredBy: 'u-owner' }),
  ],
  asAt: '2026-09-29T09:00:00.000Z',
};

function spyPort() {
  const calls: { op: string; input: unknown }[] = [];
  const port: DocumentTemplateActPort = {
    draft: async (input) => { calls.push({ op: 'draft', input }); return { result: 'drafted', version: V({ version: 5 }) }; },
    approve: async (input) => { calls.push({ op: 'approve', input }); return { result: 'approved', version: V({ version: 4, state: 'approved' }) }; },
    publish: async (input) => { calls.push({ op: 'publish', input }); return { result: 'published', version: V({ version: 3, state: 'published' }), supersededVersion: 2 }; },
  };
  return { calls, port };
}
const session = (userId: string | null = 'u-owner', over: Partial<DocumentTemplatePorts> = {}, port = spyPort()) => ({
  port,
  s: createDocumentTemplatesSession({ userId }, {
    register: () => REGISTER, kind: () => KIND, mayRead: () => true, mayWrite: () => true, actPort: () => port.port, ...over,
  }),
});
const FORM: DraftForm = { header: 'SRE Hyper Market\nGSTIN: 33ABCDE1234F1Z5\n', footer: 'Thank you\n\nReturns within 7 days', terms: '', language: 'en_ta', paperFormat: 'thermal-80', note: ' new footer ' };

describe('the register and the versions, as the screen shows them', () => {
  it('a kind with nothing in force is a WARNING (degraded, with a word and an icon); one in force is ok and names the version', () => {
    const v = session().s.view('en');
    const receipt = v.kinds.find((k) => k.kind === 'receipt')!;
    const invoice = v.kinds.find((k) => k.kind === 'invoice')!;
    expect(receipt.status.tone).toBe('ok');
    expect(receipt.status.label).toBe('v1 in force');
    expect(receipt.kindLabel).toBe('Receipt');
    expect(invoice.status.tone).toBe('degraded');
    expect(invoice.status.label).toContain('print with the defaults');
    for (const k of v.kinds) { expect(k.status.icon.trim().length).toBeGreaterThan(0); expect(k.status.label.length).toBeGreaterThan(0); }
    expect(session().s.view('ta').kinds[0]!.kindLabel).toBe('ரசீது');
  });

  it('versions newest first, each state a word + icon; in force = ok, approved = degraded (an act is pending), draft / superseded = idle', () => {
    const v = session().s.view('en');
    expect(v.chosenKind).toBe('receipt');
    expect(v.versions.map((x) => [x.version, x.state, x.status.tone])).toEqual([[4, 'draft', 'idle'], [3, 'approved', 'degraded'], [2, 'published', 'ok'], [1, 'superseded', 'idle']]);
    expect(v.versions[3]!.status.label).toContain('Superseded by v2');
    expect(v.inForce?.version).toBe(2);
    expect(v.versions[0]!.languageLabel).toBe('English and Tamil');
    expect(v.versions[0]!.paperFormat).toBe('thermal-80');
  });

  it('APPROVE is offered on a draft only to a person who is NOT its author — the maker is told why (§28); PUBLISH only on an approved version', () => {
    const maker = session('u-owner').s.view('en');
    const draft = maker.versions.find((x) => x.version === 4)!;
    expect(draft.mayApprove).toBe(false);
    expect(draft.approveWithheldWhy).toContain('different person');
    const second = session('u-padmin').s.view('en');
    expect(second.versions.find((x) => x.version === 4)!.mayApprove).toBe(true);
    expect(second.versions.find((x) => x.version === 4)!.approveWithheldWhy).toBeNull();
    expect(second.versions.map((x) => [x.version, x.mayPublish])).toEqual([[4, false], [3, true], [2, false], [1, false]]);
    // No write permission: no act is offered anywhere, and the form is withheld.
    const reader = session('u-mgr', { mayWrite: () => false }).s.view('en');
    expect(reader.mayWrite).toBe(false);
    expect(reader.versions.every((x) => !x.mayApprove && !x.mayPublish && x.approveWithheldWhy === null)).toBe(true);
  });

  it('no read permission is an error state with nothing shown; nothing read yet is an empty state; the box not told who is looking is said', () => {
    const denied = session('u-x', { mayRead: () => false }).s.view('en');
    expect(denied.screenState.tone).toBe('error');
    expect(denied.kinds).toEqual([]);
    expect(denied.versions).toEqual([]);
    const unread = session('u-owner', { register: () => null, kind: () => null }).s.view('en');
    expect(unread.screenState.label).toContain('not been read yet');
    expect(unread.kindOptions.map((o) => o.kind)).toEqual(['receipt', 'invoice', 'purchase_order', 'grn', 'statement']);
    expect(session(null).s.view('en').nobodyNamed).toBe(true);
  });
});

describe('the form becomes content the cloud would accept — or is refused HERE first', () => {
  it('lines: one per non-empty row, trailing spaces trimmed; terms only when given; paper only for a receipt', () => {
    expect(linesOf('a  \n\n b\r\nc\n')).toEqual(['a', ' b', 'c']);
    expect(contentFromForm('receipt', FORM)).toEqual({ header: ['SRE Hyper Market', 'GSTIN: 33ABCDE1234F1Z5'], footer: ['Thank you', 'Returns within 7 days'], language: 'en_ta', paperFormat: 'thermal-80' });
    expect(contentFromForm('invoice', { ...FORM, terms: 'Pay in 30 days' })).toEqual({ header: ['SRE Hyper Market', 'GSTIN: 33ABCDE1234F1Z5'], footer: ['Thank you', 'Returns within 7 days'], language: 'en_ta', terms: ['Pay in 30 days'] });
  });

  it('a draft with a malformed GSTIN or no store name is refused before any POST — the problems named, the port never called', async () => {
    const { s, port } = session();
    const bad = await s.draft('receipt', { ...FORM, header: 'SRE Hyper Market\nGSTIN: 33ABC' });
    expect(bad.result).toBe('content_invalid');
    expect((bad as unknown as { problems: string[] }).problems.join(' ')).toContain('GSTIN');
    const nameless = await s.draft('receipt', { ...FORM, header: '' });
    expect((nameless as unknown as { problems: string[] }).problems.join(' ')).toContain('store');
    expect(port.calls).toEqual([]);
  });

  it('a good draft goes to the port with the content and the trimmed note; an unknown kind or no permission is refused locally', async () => {
    const { s, port } = session();
    expect((await s.draft('receipt', FORM)).result).toBe('drafted');
    expect(port.calls).toEqual([{ op: 'draft', input: { kind: 'receipt', content: contentFromForm('receipt', FORM), note: 'new footer' } }]);
    expect((await s.draft('poster', FORM)).result).toBe('refused');
    expect((await session('u-owner', { mayWrite: () => false }).s.draft('receipt', FORM)).result).toBe('refused');
  });
});

describe('approve and publish refuse locally what the cloud would refuse', () => {
  it('approve: the maker is refused (§28); a non-draft is a state conflict; a second person on a draft goes to the port', async () => {
    const maker = session('u-owner');
    expect(await maker.s.approve('receipt', 4)).toEqual({ result: 'maker_cannot_approve' });
    expect(await maker.s.approve('receipt', 3)).toEqual({ result: 'state_conflict', code: 'not_a_draft' });
    expect(maker.port.calls).toEqual([]);
    const second = session('u-padmin');
    expect((await second.s.approve('receipt', 4)).result).toBe('approved');
    expect(second.port.calls).toEqual([{ op: 'approve', input: { kind: 'receipt', version: 4 } }]);
    // A version the screen has not read is left to the cloud to judge.
    expect((await second.s.approve('receipt', 99)).result).toBe('approved');
  });

  it('publish: a draft is not approved, an in-force version is already published; an approved version goes to the port', async () => {
    const { s, port } = session('u-owner');
    expect(await s.publish('receipt', 4)).toEqual({ result: 'state_conflict', code: 'not_approved' });
    expect(await s.publish('receipt', 2)).toEqual({ result: 'state_conflict', code: 'already_published' });
    expect(await s.publish('receipt', 3)).toMatchObject({ result: 'published', supersededVersion: 2 });
    expect(port.calls).toEqual([{ op: 'publish', input: { kind: 'receipt', version: 3 } }]);
    expect((await session('u-owner', { mayWrite: () => false }).s.publish('receipt', 3)).result).toBe('refused');
  });

  it('presents every outcome as a tone, an icon and words — in both languages', () => {
    const { s } = session();
    expect(s.presentActResult('en', { result: 'drafted', version: V({ version: 5 }) })).toMatchObject({ tone: 'ok', icon: '✓' });
    expect(s.presentActResult('en', { result: 'drafted', version: V({ version: 5 }) }).label).toContain('version 5');
    expect(s.presentActResult('en', { result: 'published', version: V({ version: 3 }), supersededVersion: 2 }).label).toContain('superseded version 2');
    expect(s.presentActResult('en', { result: 'content_invalid', problems: ['a', 'b'] })).toMatchObject({ tone: 'error', icon: '✕' });
    expect(s.presentActResult('en', { result: 'maker_cannot_approve' }).label).toContain('cannot approve');
    expect(s.presentActResult('en', { result: 'state_conflict', code: 'not_approved' }).label).toContain('not_approved');
    expect(s.presentActResult('en', { result: 'lost_link' })).toMatchObject({ tone: 'degraded', icon: '⚠' });
    expect(s.presentActResult('en', { result: 'refused' })).toMatchObject({ tone: 'error' });
    expect(s.presentActResult('ta', { result: 'lost_link' }).label).toContain('இணைப்பு இல்லை');
  });
});
