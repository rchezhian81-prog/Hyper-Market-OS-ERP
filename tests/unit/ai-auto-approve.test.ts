// CR-01 OI-12 · OB-712 · P-05 · hard rule 5 — the owner-set auto-approve limits engine (packages/ai/src/auto-approve.ts).
//
// What these tests pin, in the owner's words:
//   • a rule is set by TWO different people (the one who asks, a different one who confirms); an assistant can be neither;
//   • a rule can NEVER be set for a permission change, a refund or a payment to a new payee — nor any kind not on the list;
//   • an assistant's draft inside the limit is approved BY THE RULE, never by the assistant, and the record names the rule
//     and the two people who set it;
//   • anything above the limit, unusual, stale, without evidence, or outside its rule waits for a person, with the reason;
//   • one switch stops all auto-approval at once; it starts stopped, and starting it again is a two-person act;
//   • a change asked against a rule that has since changed is refused, never silently overwrites (hard rule 10).
import { describe, it, expect } from 'vitest';
import {
  AUTO_APPROVE_KINDS, NEVER_AUTO_APPROVE, FORBIDDEN_TOOLS,
  checkChangeRequest, confirmChange, foldAutoApprove, decideDraft,
  type AutoApproveRequest, type AutoApproveConfirmation, type AutoApproveStop, type DraftAct, type AutoApproveState,
} from '../../packages/ai/src/index';

const T0 = '2026-11-14T04:00:00.000Z';
const later = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

const ask = (over: Partial<AutoApproveRequest> = {}): AutoApproveRequest => ({
  requestId: 'req-1', action: 'set_limit', kind: 'reorder_from_approved_supplier', limit: 500_000, basedOnVersion: 0,
  reason: 'small reorders from our regular suppliers', requestedBy: 'u-owner', requestedAt: T0, ...over,
});
const confirmBy = (requestId: string, by: string, at = later(1)): AutoApproveConfirmation => ({ requestId, decision: 'confirmed', by, at });

/** A shop with a reorder rule (₹5,000), a markdown rule (30%), a transfer rule (₹2,000), and auto-approval running. */
function liveState(): AutoApproveState {
  const requests: AutoApproveRequest[] = [
    ask(),
    ask({ requestId: 'req-2', kind: 'markdown_short_dated', limit: 3_000, reason: 'clear short-dated stock' }),
    ask({ requestId: 'req-3', kind: 'stock_transfer', limit: 200_000, reason: 'move stock between our own places' }),
    ask({ requestId: 'req-4', action: 'resume', kind: undefined, limit: undefined, basedOnVersion: 0, reason: 'start auto-approval' }),
  ];
  const confirmations = requests.map((r) => confirmBy(r.requestId, 'u-accountant'));
  return foldAutoApprove({ requests, confirmations, stops: [] });
}

const reorder = (over: Partial<Extract<DraftAct, { kind: 'reorder_from_approved_supplier' }>> = {}): DraftAct => ({
  kind: 'reorder_from_approved_supplier', supplierId: 'sup-synthetic-01', supplierApproved: true, valueMinor: 420_000,
  lines: [{ productId: 'p-rice-5kg', qty: 10 }], ...over,
});
const draft = (act: DraftAct | undefined, over: Record<string, unknown> = {}) => ({
  proposalId: 'a02-x', agent: 'A02' as const, act, evidenceCount: 2, createdAt: later(5), ...over,
});

describe('which acts may ever have a rule', () => {
  it('offers exactly the three kinds of act, each drafted by one named assistant', () => {
    expect(Object.keys(AUTO_APPROVE_KINDS).sort()).toEqual(['markdown_short_dated', 'reorder_from_approved_supplier', 'stock_transfer']);
    expect(AUTO_APPROVE_KINDS.reorder_from_approved_supplier.agent).toBe('A02');
    expect(AUTO_APPROVE_KINDS.markdown_short_dated.agent).toBe('A03');
    expect(AUTO_APPROVE_KINDS.stock_transfer.agent).toBe('A03');
    // Every kind has a Tamil name for the owner's screen.
    for (const k of Object.values(AUTO_APPROVE_KINDS)) expect(k.nameTa.length).toBeGreaterThan(0);
  });

  it('NEVER for a permission change, a refund or a payment to a new payee — a closed list', () => {
    expect([...NEVER_AUTO_APPROVE].sort()).toEqual(['payment_to_new_payee', 'permission_change', 'refund']);
    expect(Object.isFrozen(NEVER_AUTO_APPROVE)).toBe(true);
    for (const kind of NEVER_AUTO_APPROVE) {
      const r = checkChangeRequest(ask({ kind: kind as never }), foldAutoApprove({ requests: [], confirmations: [], stops: [] }));
      expect(r).toMatchObject({ ok: false, code: 'never_auto_approvable' });
    }
  });

  it('refuses a kind that is not on the list (default-deny), and a forbidden tool name used as a kind', () => {
    const empty = foldAutoApprove({ requests: [], confirmations: [], stops: [] });
    expect(checkChangeRequest(ask({ kind: 'price_change' as never }), empty)).toMatchObject({ ok: false, code: 'not_an_auto_approvable_kind' });
    for (const tool of FORBIDDEN_TOOLS) {
      expect(checkChangeRequest(ask({ kind: tool as never }), empty).ok).toBe(false);
    }
  });

  it('a limit must be a whole positive number, and a markdown is at most 100%', () => {
    const empty = foldAutoApprove({ requests: [], confirmations: [], stops: [] });
    for (const limit of [0, -5, 12.5, Number.NaN]) expect(checkChangeRequest(ask({ limit }), empty)).toMatchObject({ ok: false, code: 'limit_not_readable' });
    expect(checkChangeRequest(ask({ kind: 'markdown_short_dated', limit: 10_001 }), empty)).toMatchObject({ ok: false, code: 'limit_not_readable' });
    expect(checkChangeRequest(ask({ reason: '  ' }), empty)).toMatchObject({ ok: false, code: 'reason_needed' });
  });
});

describe('setting or changing a limit is a two-person act', () => {
  it('a request alone changes nothing; a DIFFERENT person confirms it and only then is it the rule', () => {
    const asked = foldAutoApprove({ requests: [ask()], confirmations: [], stops: [] });
    expect(asked.rules).toEqual([]);
    expect(asked.pending.map((p) => p.requestId)).toEqual(['req-1']);
    const done = foldAutoApprove({ requests: [ask()], confirmations: [confirmBy('req-1', 'u-accountant')], stops: [] });
    expect(done.pending).toEqual([]);
    expect(done.rules).toEqual([expect.objectContaining({
      kind: 'reorder_from_approved_supplier', limit: 500_000, version: 1, ruleId: 'reorder_from_approved_supplier-v1',
      askedBy: 'u-owner', confirmedBy: 'u-accountant',
    })]);
  });

  it('the person who asked cannot confirm their own request', () => {
    const st = foldAutoApprove({ requests: [ask()], confirmations: [], stops: [] });
    expect(confirmChange({ request: st.pending[0]!, by: 'u-owner', state: st, agentIdentities: [] })).toMatchObject({ ok: false, code: 'same_person' });
  });

  it('an assistant can never ask for or confirm a limit', () => {
    const st = foldAutoApprove({ requests: [ask()], confirmations: [], stops: [] });
    expect(confirmChange({ request: st.pending[0]!, by: 'agent:A02', state: st, agentIdentities: ['agent:A02'] })).toMatchObject({ ok: false, code: 'agent_cannot_confirm' });
    expect(checkChangeRequest(ask({ requestedBy: 'agent:A02' }), st, ['agent:A02'])).toMatchObject({ ok: false, code: 'agent_cannot_ask' });
  });

  it('a request asked against a rule that has since changed is refused, never overwrites (hard rule 10)', () => {
    // Two requests both asked against version 0; the first is confirmed; the second is now stale.
    const requests = [ask(), ask({ requestId: 'req-b', limit: 900_000 })];
    const st = foldAutoApprove({ requests, confirmations: [confirmBy('req-1', 'u-accountant')], stops: [] });
    const stale = st.pending.find((p) => p.requestId === 'req-b')!;
    expect(confirmChange({ request: stale, by: 'u-accountant', state: st, agentIdentities: [] })).toMatchObject({ ok: false, code: 'rule_changed_since_asked' });
    // And a confirmation that somehow landed anyway is not folded into the rule.
    const forced = foldAutoApprove({ requests, confirmations: [confirmBy('req-1', 'u-accountant'), confirmBy('req-b', 'u-accountant', later(2))], stops: [] });
    expect(forced.rules[0]!.limit).toBe(500_000);
  });

  it('a change raises the version; removing a rule is also two-person and leaves it on record', () => {
    const requests = [ask(), ask({ requestId: 'req-2', limit: 300_000, basedOnVersion: 1 }), ask({ requestId: 'req-3', action: 'remove_limit', limit: undefined, basedOnVersion: 2 })];
    const two = foldAutoApprove({ requests, confirmations: [confirmBy('req-1', 'u-accountant'), confirmBy('req-2', 'u-accountant', later(2))], stops: [] });
    expect(two.rules[0]).toMatchObject({ limit: 300_000, version: 2, ruleId: 'reorder_from_approved_supplier-v2' });
    const gone = foldAutoApprove({ requests, confirmations: [confirmBy('req-1', 'u-accountant'), confirmBy('req-2', 'u-accountant', later(2)), confirmBy('req-3', 'u-accountant', later(3))], stops: [] });
    expect(gone.rules).toEqual([]);
    expect(gone.history.map((h) => h.version)).toEqual([1, 2, 3]);
  });

  it('a refused request is settled and changes nothing', () => {
    const st = foldAutoApprove({ requests: [ask()], confirmations: [{ requestId: 'req-1', decision: 'refused', by: 'u-accountant', at: later(1), reason: 'too high' }], stops: [] });
    expect(st.rules).toEqual([]);
    expect(st.pending).toEqual([]);
    expect(st.history[0]).toMatchObject({ requestId: 'req-1', decision: 'refused' });
  });
});

describe('the one switch that stops all auto-approval', () => {
  it('starts STOPPED — nothing is auto-approved until two people start it', () => {
    const st = foldAutoApprove({ requests: [ask()], confirmations: [confirmBy('req-1', 'u-accountant')], stops: [] });
    expect(st.running).toBe(false);
    expect(decideDraft({ draft: draft(reorder()), state: st, aiStopped: false, now: later(6) })).toMatchObject({ outcome: 'waits_for_a_person', because: 'auto_approval_stopped' });
  });

  it('one person stops it at once, with a reason; starting it again needs two people', () => {
    const base = liveState();
    expect(base.running).toBe(true);
    const stop: AutoApproveStop = { stopId: 's-1', by: 'u-manager', at: later(3), reason: 'checking a wrong order' };
    const requests: AutoApproveRequest[] = [
      ask(), ask({ requestId: 'req-4', action: 'resume', kind: undefined, limit: undefined, reason: 'start' }),
    ];
    const confirmations = [confirmBy('req-1', 'u-accountant'), confirmBy('req-4', 'u-accountant')];
    const stopped = foldAutoApprove({ requests, confirmations, stops: [stop] });
    expect(stopped.running).toBe(false);
    expect(stopped.stoppedBy).toMatchObject({ by: 'u-manager', reason: 'checking a wrong order' });
    expect(decideDraft({ draft: draft(reorder(), { createdAt: later(4) }), state: stopped, aiStopped: false, now: later(5) })).toMatchObject({ because: 'auto_approval_stopped' });
    // Started again by two people, after the stop.
    const again = foldAutoApprove({
      requests: [...requests, ask({ requestId: 'req-5', action: 'resume', kind: undefined, limit: undefined, reason: 'checked, all fine', requestedAt: later(10), basedOnVersion: 2 })],
      confirmations: [...confirmations, confirmBy('req-5', 'u-accountant', later(11))], stops: [stop],
    });
    expect(again.running).toBe(true);
  });

  it('the AI kill switch also stops auto-approval', () => {
    expect(decideDraft({ draft: draft(reorder()), state: liveState(), aiStopped: true, now: later(6) })).toMatchObject({ because: 'ai_stopped' });
  });
});

describe('a draft is decided by the rule — or waits for a person, with the reason', () => {
  it('inside the limit: approved BY THE RULE, naming the rule and the two people who set it — never the assistant', () => {
    const d = decideDraft({ draft: draft(reorder()), state: liveState(), aiStopped: false, now: later(6) });
    expect(d).toMatchObject({
      outcome: 'auto_approved', ruleId: 'reorder_from_approved_supplier-v1', limit: 500_000, measured: 420_000,
      ruleSetBy: { askedBy: 'u-owner', confirmedBy: 'u-accountant' }, draftedBy: 'A02',
    });
    expect(d.outcome === 'auto_approved' && d.approvedBy).toBe('rule:reorder_from_approved_supplier-v1');
    expect(JSON.stringify(d)).not.toMatch(/"approvedBy":"A02"/);
  });

  it('exactly AT the limit is inside it; one paisa over waits', () => {
    expect(decideDraft({ draft: draft(reorder({ valueMinor: 500_000 })), state: liveState(), aiStopped: false, now: later(6) }).outcome).toBe('auto_approved');
    expect(decideDraft({ draft: draft(reorder({ valueMinor: 500_001 })), state: liveState(), aiStopped: false, now: later(6) })).toMatchObject({ outcome: 'waits_for_a_person', because: 'over_the_limit' });
  });

  it('unusual waits: a supplier not approved, nothing to order, a markdown on stock that is not short-dated, a transfer to the same place', () => {
    const s = liveState();
    const at = later(6);
    expect(decideDraft({ draft: draft(reorder({ supplierApproved: false })), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'unusual' });
    expect(decideDraft({ draft: draft(reorder({ valueMinor: 0 })), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'unusual' });
    expect(decideDraft({ draft: draft(reorder({ lines: [] })), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'unusual' });
    const md = (daysToExpiry: number, percentOffBps = 2_000): DraftAct => ({ kind: 'markdown_short_dated', productId: 'p-milk', batchId: 'b-1', percentOffBps, daysToExpiry });
    expect(decideDraft({ draft: draft(md(3), { agent: 'A03' }), state: s, aiStopped: false, now: at }).outcome).toBe('auto_approved');
    expect(decideDraft({ draft: draft(md(20), { agent: 'A03' }), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'unusual' });
    expect(decideDraft({ draft: draft(md(0), { agent: 'A03' }), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'unusual' });
    expect(decideDraft({ draft: draft(md(3, 5_000), { agent: 'A03' }), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'over_the_limit' });
    const tr = (to: string): DraftAct => ({ kind: 'stock_transfer', productId: 'p-oil', fromLocationId: 'store-1', toLocationId: to, qty: 6, valueMinor: 150_000 });
    expect(decideDraft({ draft: draft(tr('store-2'), { agent: 'A03' }), state: s, aiStopped: false, now: at }).outcome).toBe('auto_approved');
    expect(decideDraft({ draft: draft(tr('store-1'), { agent: 'A03' }), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'unusual' });
  });

  it('outside its rule waits: no rule for the kind, the wrong assistant, no evidence, a stale draft, no exact act', () => {
    const s = liveState();
    const at = later(6);
    const noRule = foldAutoApprove({ requests: [ask({ requestId: 'r', action: 'resume', kind: undefined, limit: undefined })], confirmations: [confirmBy('r', 'u-accountant')], stops: [] });
    expect(decideDraft({ draft: draft(reorder()), state: noRule, aiStopped: false, now: at })).toMatchObject({ because: 'no_rule_for_this_kind' });
    expect(decideDraft({ draft: draft(reorder(), { agent: 'A03' }), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'not_this_assistants_kind' });
    expect(decideDraft({ draft: draft(reorder(), { evidenceCount: 0 }), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'no_evidence' });
    expect(decideDraft({ draft: draft(reorder()), state: s, aiStopped: false, now: later(5 + 61) })).toMatchObject({ because: 'stale_draft' });
    expect(decideDraft({ draft: draft(undefined), state: s, aiStopped: false, now: at })).toMatchObject({ because: 'no_exact_act' });
  });

  it('a draft for a refund, a permission change or a payment to a new payee ALWAYS waits — whatever rules exist', () => {
    for (const kind of NEVER_AUTO_APPROVE) {
      const d = decideDraft({ draft: draft({ kind } as unknown as DraftAct), state: liveState(), aiStopped: false, now: later(6) });
      expect(d).toMatchObject({ outcome: 'waits_for_a_person', because: 'never_auto_approvable' });
    }
  });

  it('every reason a draft waits is said in plain words', () => {
    const d = decideDraft({ draft: draft(reorder({ valueMinor: 900_000 })), state: liveState(), aiStopped: false, now: later(6) });
    expect(d.outcome === 'waits_for_a_person' && d.detail).toMatch(/₹9,000\.00 is above the ₹5,000\.00 limit/);
  });

  it('is deterministic: the same draft and rules give the same answer every time', () => {
    const a = decideDraft({ draft: draft(reorder()), state: liveState(), aiStopped: false, now: later(6) });
    const b = decideDraft({ draft: draft(reorder()), state: liveState(), aiStopped: false, now: later(6) });
    expect(a).toEqual(b);
  });
});
