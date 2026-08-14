import { describe, it, expect } from 'vitest';
import {
  createGstReconciliationSession, recommendedAction, GST_RECON_COPY, COPY_KEYS,
  portalActionsFor, portalCommandKey, buildPortalCommand, GST_PORTAL_ACTION_EVENT,
  type GstReconciliationPorts, type QueueRow, type GstPortalActionPayload,
} from '../../apps/web-erp/src/gst-reconciliation-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **GST e-invoice / e-way-bill reconciliation — the operator triage view (item 3 inc2).**
 *
 * The screen works the item-2 queue: the ones needing attention first, each with a status that is never a
 * bare colour, and — in plain language — what to do and whether this person may do it. It never changes a
 * document (a mismatch is surfaced, not auto-corrected), and it is read-gated + action-gated the same way
 * the server is.
 */

const ROWS: QueueRow[] = [
  { documentType: 'e_invoice', id: 'INV-done', category: 'registered', number: 'IRN-1' },
  { documentType: 'e_way_bill', id: 'MV-stuck', category: 'unknown' },
  { documentType: 'e_invoice', id: 'INV-rej', category: 'rejected', detail: 'bad GSTIN' },
  { documentType: 'e_invoice', id: 'INV-mm', category: 'mismatch', number: 'IRN-2', mismatch: { observedState: 'rejected', note: 'portal now rejects it' } },
];

const ports = (over: Partial<GstReconciliationPorts> = {}): GstReconciliationPorts => {
  const box = new SyncOutbox();
  return {
    rows: () => ROWS,
    mayRead: () => true,
    mayAct: () => true,
    outbox: () => box,
    ...over,
  };
};

const session = (over: Partial<GstReconciliationPorts> = {}, userId: string | null = 'u-fin') =>
  createGstReconciliationSession({ userId }, ports(over));

describe('recommendedAction', () => {
  it('maps each category to what the operator should do', () => {
    expect(recommendedAction('unknown')).toBe('poll');       // acknowledgement recovery
    expect(recommendedAction('rejected')).toBe('reissue');
    expect(recommendedAction('error')).toBe('investigate');
    expect(recommendedAction('mismatch')).toBe('investigate'); // never auto-corrected (rule #10)
    expect(recommendedAction('processing')).toBe('wait');
    expect(recommendedAction('registered')).toBe('none');
    expect(recommendedAction('generated')).toBe('none');
    expect(recommendedAction('cancelled')).toBe('none');
  });
});

describe('view', () => {
  it('puts the ones needing attention first and presents a colour-plus-word-plus-icon status', () => {
    const v = session().view('en');
    expect(v.total).toBe(4);
    expect(v.attentionCount).toBe(3); // unknown + rejected + mismatch
    // Attention rows lead; the done one is last.
    expect(v.rows.map((r) => r.id).slice(0, 3).sort()).toEqual(['INV-mm', 'INV-rej', 'MV-stuck']);
    expect(v.rows[v.rows.length - 1]?.id).toBe('INV-done');
    // Every status carries a non-empty label + icon (never a bare colour) and a tone.
    for (const r of v.rows) {
      expect(r.status.label.length).toBeGreaterThan(0);
      expect(r.status.icon.trim().length).toBeGreaterThan(0);
      expect(['ok', 'degraded', 'error', 'idle']).toContain(r.status.tone);
    }
  });

  it('surfaces a mismatch as investigate + a note, and never as a done row', () => {
    const mm = session().view('en').rows.find((r) => r.id === 'INV-mm');
    expect(mm?.action).toBe('investigate');
    expect(mm?.needsAttention).toBe(true);
    expect(mm?.mismatchNote).toBeTruthy();
    expect(mm?.status.tone).toBe('error');
  });

  it('gates the portal actions: a reader who cannot act sees the poll row flagged "needs the role"', () => {
    const v = session({ mayAct: () => false }).view('en');
    const stuck = v.rows.find((r) => r.id === 'MV-stuck'); // recommended action: poll (touches the portal)
    expect(stuck?.permitted).toBe(false);
    expect(stuck?.permissionNote).toBeTruthy();
    expect(v.mayAct).toBe(false);
    // A non-portal action (reissue is downstream, not a portal call here) is not gated.
    expect(v.rows.find((r) => r.id === 'INV-rej')?.permitted).toBe(true);
  });

  it('refuses the whole queue when the user may not read it — no rows leak', () => {
    const v = session({ mayRead: () => false }).view('en');
    expect(v.rows).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.screenState.tone).toBe('error');
  });

  it('shows an empty state (not an error) when there is simply nothing in the queue', () => {
    const v = session({ rows: () => [] }).view('en');
    expect(v.total).toBe(0);
    expect(v.attentionCount).toBe(0);
    expect(v.screenState.tone).toBe('idle'); // empty is idle, not error
  });

  it('flags nobody-named when the box was not told who is looking', () => {
    expect(session({}, null).view('en').nobodyNamed).toBe(true);
    expect(session({}, 'u-fin').view('en').nobodyNamed).toBe(false);
  });

  it('renders in Tamil too — the status label changes with the language', () => {
    const en = session().view('en').rows.find((r) => r.id === 'MV-stuck')?.status.label;
    const ta = session().view('ta').rows.find((r) => r.id === 'MV-stuck')?.status.label;
    expect(en).toBeTruthy();
    expect(ta).toBeTruthy();
    expect(ta).not.toBe(en);
  });
});

// ── item 3 inc-e: wiring poll/verify to an offline outbox command ────────────────────────────────────────

/** A session sharing one outbox with the test, so an enqueue is observable. */
const acting = (over: Partial<GstReconciliationPorts> = {}, userId: string | null = 'u-fin') => {
  const box = new SyncOutbox();
  const s = createGstReconciliationSession({ userId }, ports({ outbox: () => box, ...over }));
  return { s, box };
};
const AT = '2026-08-14T10:00:00.000Z';

describe('portalActionsFor — only the two portal-touching actions, and never on a row a person must handle', () => {
  it('offers poll on a stuck document, verify on a settled one, and NOTHING on mismatch/error/rejected/processing', () => {
    expect(portalActionsFor('unknown')).toEqual(['poll']);
    expect(portalActionsFor('registered')).toEqual(['verify']);
    expect(portalActionsFor('generated')).toEqual(['verify']);
    expect(portalActionsFor('cancelled')).toEqual(['verify']);
    // A disagreement or a bad signature is investigated by a person — never a one-click button (hard rule #10).
    expect(portalActionsFor('mismatch')).toEqual([]);
    expect(portalActionsFor('error')).toEqual([]);
    // Reissue is a separate workflow; an in-flight one is simply waited on.
    expect(portalActionsFor('rejected')).toEqual([]);
    expect(portalActionsFor('processing')).toEqual([]);
  });
});

describe('view — the clickable actions each row offers', () => {
  it('the stuck row offers an enabled poll button; the settled row a verify button', () => {
    const v = session().view('en');
    const stuck = v.rows.find((r) => r.id === 'MV-stuck');
    expect(stuck?.actions.map((a) => a.action)).toEqual(['poll']);
    expect(stuck?.actions[0]?.enabled).toBe(true);
    const done = v.rows.find((r) => r.id === 'INV-done');
    expect(done?.actions.map((a) => a.action)).toEqual(['verify']);
    expect(done?.actions[0]?.enabled).toBe(true);
  });

  it('a mismatch and a rejected row offer NO button — those are handled by a person', () => {
    const v = session().view('en');
    expect(v.rows.find((r) => r.id === 'INV-mm')?.actions).toEqual([]);   // hard rule #10
    expect(v.rows.find((r) => r.id === 'INV-rej')?.actions).toEqual([]);
  });

  it('a reader without the portal role sees the button disabled and told why — never enabled', () => {
    const v = session({ mayAct: () => false }).view('en');
    const stuck = v.rows.find((r) => r.id === 'MV-stuck');
    expect(stuck?.actions[0]?.permitted).toBe(false);
    expect(stuck?.actions[0]?.enabled).toBe(false);
    expect(stuck?.actions[0]?.note).toBeTruthy();
  });
});

describe('requestAction — commits an offline command, never a network call', () => {
  it('enqueues a well-formed, PII-free command for a stuck document and marks the row requested', () => {
    const { s, box } = acting();
    const res = s.requestAction({ documentType: 'e_way_bill', id: 'MV-stuck', action: 'poll', at: AT });
    expect(res.ok).toBe(true);
    expect(box.unsentCount()).toBe(1);
    const item = box.pending()[0]!;
    expect(item.event.type).toBe(GST_PORTAL_ACTION_EVENT);
    expect(item.event.source).toBe('web-erp/gst-reconciliation');
    const payload = item.event.payload as GstPortalActionPayload;
    expect(payload).toEqual({ documentType: 'e_way_bill', id: 'MV-stuck', action: 'poll', requestedBy: 'u-fin', observedCategory: 'unknown' });
    expect(item.event.idempotencyKey).toBe(portalCommandKey('e_way_bill', 'MV-stuck', 'poll', 'unknown'));
    // The very same session now shows the row as requested/pending, disabled against a second click.
    const action = s.view('en').rows.find((r) => r.id === 'MV-stuck')?.actions[0];
    expect(action?.queued).toBe('pending');
    expect(action?.enabled).toBe(false);
  });

  it('is idempotent — a double click collapses to ONE command', () => {
    const { s, box } = acting();
    const a = s.requestAction({ documentType: 'e_way_bill', id: 'MV-stuck', action: 'poll', at: AT });
    const b = s.requestAction({ documentType: 'e_way_bill', id: 'MV-stuck', action: 'poll', at: AT });
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, reason: 'already_queued' });
    expect(box.unsentCount()).toBe(1);
  });

  it('refuses to act on a mismatch or an error row — a person investigates, it is never auto-corrected (rule #10)', () => {
    const { s, box } = acting();
    expect(s.requestAction({ documentType: 'e_invoice', id: 'INV-mm', action: 'verify', at: AT })).toEqual({ ok: false, reason: 'not_actionable' });
    expect(s.requestAction({ documentType: 'e_invoice', id: 'INV-mm', action: 'poll', at: AT })).toEqual({ ok: false, reason: 'not_actionable' });
    expect(box.unsentCount()).toBe(0); // nothing queued for a row a person must handle
  });

  it('refuses without the portal role, without a named operator, and for an unknown row — and queues nothing', () => {
    const noRole = acting({ mayAct: () => false });
    expect(noRole.s.requestAction({ documentType: 'e_way_bill', id: 'MV-stuck', action: 'poll', at: AT })).toEqual({ ok: false, reason: 'not_permitted' });
    expect(noRole.box.unsentCount()).toBe(0);

    const nobody = acting({}, null);
    expect(nobody.s.requestAction({ documentType: 'e_way_bill', id: 'MV-stuck', action: 'poll', at: AT })).toEqual({ ok: false, reason: 'not_permitted' });
    expect(nobody.box.unsentCount()).toBe(0);

    const { s } = acting();
    expect(s.requestAction({ documentType: 'e_invoice', id: 'NOPE', action: 'verify', at: AT })).toEqual({ ok: false, reason: 'unknown_row' });
  });

  it('a re-request after the portal has moved the document to a new state is a DISTINCT command', () => {
    // Same document + action but a different observed category ⇒ a different dedupe key, so it is legitimately
    // re-actable once the state has moved (it does not collapse into the earlier request).
    expect(portalCommandKey('e_invoice', 'INV-1', 'verify', 'registered'))
      .not.toBe(portalCommandKey('e_invoice', 'INV-1', 'verify', 'cancelled'));
  });

  it('buildPortalCommand uses its idempotency key as the event id, so a duplicate can only collapse', () => {
    const cmd = buildPortalCommand({ documentType: 'e_invoice', id: 'INV-1', action: 'verify', observedCategory: 'registered', requestedBy: 'u-fin', at: AT });
    expect(cmd.id).toBe(cmd.idempotencyKey);
    expect(cmd.occurredAt).toBe(AT);
  });
});

describe('the copy is complete in both languages', () => {
  it('has an English AND a Tamil word for every key the screen uses (packages/ui bilingualGaps)', () => {
    const gaps = bilingualGaps(GST_RECON_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
