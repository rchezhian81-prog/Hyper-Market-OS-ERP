import { describe, it, expect } from 'vitest';
import {
  createGstReturnsSession, recommendedAction, GST_RETURNS_COPY, COPY_KEYS,
  type GstReturnsPorts, type ReturnRow,
} from '../../apps/web-erp/src/gst-returns-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **GST returns — the filing-status operator view (item 3, the 4th UI domain).**
 *
 * The screen shows every GSTR-1 filing period with the ones needing attention first — a portal rejection
 * (failed) or an unresolved outcome (unknown) — each with a status that is never a bare colour and, in plain
 * language, the next step. It is read-gated the same way the server is, and it files nothing (a stuck return
 * is surfaced for a person, never resolved silently — hard rule #10).
 */

const ROWS: ReturnRow[] = [
  { period: '042026', state: 'filed', arn: 'ARN-042026' },
  { period: '052026', state: 'approved', previewedBy: 'u-maker', approvedBy: 'u-checker' },
  { period: '062026', state: 'failed', detail: 'rejected (validation)' },
  { period: '072026', state: 'unknown', detail: 'no clear answer from the portal' },
  { period: '032026', state: 'previewed', previewedBy: 'u-maker' },
];

const ports = (over: Partial<GstReturnsPorts> = {}): GstReturnsPorts => ({
  rows: () => ROWS,
  mayRead: () => true,
  ...over,
});

const session = (over: Partial<GstReturnsPorts> = {}, userId: string | null = 'u-fin') =>
  createGstReturnsSession({ userId }, ports(over));

describe('recommendedAction', () => {
  it('maps each lifecycle state to the operator’s next step', () => {
    expect(recommendedAction('previewed')).toBe('approve');   // a second person must approve (maker ≠ checker)
    expect(recommendedAction('approved')).toBe('file');
    expect(recommendedAction('submitting')).toBe('wait');
    expect(recommendedAction('failed')).toBe('refile');
    expect(recommendedAction('unknown')).toBe('reconcile');   // never assumed filed (rule #10)
    expect(recommendedAction('filed')).toBe('none');
    expect(recommendedAction('cancelled')).toBe('none');
  });
});

describe('view', () => {
  it('puts the exceptions first (failed + unknown), then the rest by most-recent period', () => {
    const v = session().view('en');
    expect(v.total).toBe(5);
    expect(v.attentionCount).toBe(2); // failed + unknown
    // The two exceptions lead; within them, the most recent period (07) before (06).
    expect(v.rows.slice(0, 2).map((r) => r.period)).toEqual(['072026', '062026']);
    // The settled/in-progress ones follow, most-recent-period first (05 approved, 04 filed, 03 previewed).
    expect(v.rows.slice(2).map((r) => r.period)).toEqual(['052026', '042026', '032026']);
    // Every status carries a non-empty word + icon (never a bare colour) and a known tone.
    for (const r of v.rows) {
      expect(r.status.label.length).toBeGreaterThan(0);
      expect(r.status.icon.trim().length).toBeGreaterThan(0);
      expect(['ok', 'degraded', 'error', 'idle']).toContain(r.status.tone);
    }
  });

  it('a filed return reads as done (ok, no attention) and carries its portal reference', () => {
    const filed = session().view('en').rows.find((r) => r.period === '042026');
    expect(filed?.status.tone).toBe('ok');
    expect(filed?.needsAttention).toBe(false);
    expect(filed?.action).toBe('none');
    expect(filed?.arn).toBe('ARN-042026');
  });

  it('a rejected return reads as an exception that must be corrected and re-filed', () => {
    const failed = session().view('en').rows.find((r) => r.period === '062026');
    expect(failed?.status.tone).toBe('error');
    expect(failed?.needsAttention).toBe(true);
    expect(failed?.action).toBe('refile');
  });

  it('an unknown outcome reads as attention and says reconcile — never “filed” by assumption (rule #10)', () => {
    const unknown = session().view('en').rows.find((r) => r.period === '072026');
    expect(unknown?.needsAttention).toBe(true);
    expect(unknown?.action).toBe('reconcile');
  });

  it('surfaces who prepared and who approved a return, when the box knows', () => {
    const approved = session().view('en').rows.find((r) => r.period === '052026');
    expect(approved?.preparedBy).toBe('u-maker');
    expect(approved?.approvedByName).toBe('u-checker');
  });

  it('refuses the whole queue when the user may not read it — no periods leak', () => {
    const v = session({ mayRead: () => false }).view('en');
    expect(v.rows).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.screenState.tone).toBe('error');
  });

  it('shows an empty state (not an error) when no filing period has been started', () => {
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
    const en = session().view('en').rows.find((r) => r.period === '062026')?.status.label;
    const ta = session().view('ta').rows.find((r) => r.period === '062026')?.status.label;
    expect(en).toBeTruthy();
    expect(ta).toBeTruthy();
    expect(ta).not.toBe(en);
  });
});

describe('the copy is complete in both languages', () => {
  it('has an English AND a Tamil word for every key the screen uses (packages/ui bilingualGaps)', () => {
    const gaps = bilingualGaps(GST_RETURNS_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
