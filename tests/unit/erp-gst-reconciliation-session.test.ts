import { describe, it, expect } from 'vitest';
import {
  createGstReconciliationSession, recommendedAction, GST_RECON_COPY, COPY_KEYS,
  type GstReconciliationPorts, type QueueRow,
} from '../../apps/web-erp/src/gst-reconciliation-session';
import { bilingualGaps } from '../../packages/ui/src/index';

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

const ports = (over: Partial<GstReconciliationPorts> = {}): GstReconciliationPorts => ({
  rows: () => ROWS,
  mayRead: () => true,
  mayAct: () => true,
  ...over,
});

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

describe('the copy is complete in both languages', () => {
  it('has an English AND a Tamil word for every key the screen uses (packages/ui bilingualGaps)', () => {
    const gaps = bilingualGaps(GST_RECON_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
