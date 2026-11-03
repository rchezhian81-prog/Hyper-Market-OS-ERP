import { describe, it, expect } from 'vitest';
import {
  createGstReturnsSession, recommendedAction, GST_RETURNS_COPY, COPY_KEYS, commandActionsFor,
  type GstReturnsPorts, type ReturnRow, type HeadOfficeCall, type HeadOfficeAnswer,
} from '../../apps/web-erp/src/gst-returns-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **GST returns — the filing-status operator view (item 3, the 4th UI domain).**
 *
 * The screen shows every GSTR-1 filing period with the ones needing attention first — a portal rejection
 * (failed) or an unresolved outcome (unknown) — each with a status that is never a bare colour and, in plain
 * language, the next step. It is read-gated the same way the server is, and it files nothing (a stuck return
 * is surfaced for a person, never resolved silently — hard rule #10).
 *
 * W5 (route audit rows 161–167 · API-09 · M23 · §28 · §31): Approve used to queue a `GstReturnActionRequested` command the
 * sync agent has no route for, so it never reached head office. The list is now read live and every act goes straight to
 * head office's maker-checker routes once (the key kept while an answer is lost).
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
  mayApprove: () => true,
  maySubmit: () => true,
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

// ── W5 (route audit rows 161–167): every act goes straight to head office, once ───────────────────────────────

/** A pretend head office holding the submissions, that records every call (method, path, body, key). */
function fakeHeadOffice(initial: Record<string, Record<string, unknown>>) {
  const subs = new Map<string, Record<string, unknown>>(Object.entries(initial).map(([p, v]) => [p, { period: p, ...v }]));
  const calls: { method: string; path: string; body?: unknown; key?: string }[] = [];
  const seenKeys = new Map<string, HeadOfficeAnswer>();
  let lose = 0;
  const ho: HeadOfficeCall = async (method, path, body, key) => {
    calls.push({ method, path, ...(body !== undefined ? { body } : {}), ...(key !== undefined ? { key } : {}) });
    if (method === 'GET' && path === '/v1/finance/gstr1/submissions') return { kind: 'ok', status: 200, body: { submissions: [...subs.values()].map((s) => ({ period: s['period'], state: s['state'] })) } };
    const one = /^\/v1\/finance\/gstr1\/submission\/(\d{6})$/.exec(path);
    if (method === 'GET' && one) return { kind: 'ok', status: 200, body: subs.get(one[1]!) };
    const g3b = /^\/v1\/finance\/gstr3b\/(\d{6})$/.exec(path);
    if (method === 'GET' && g3b) return { kind: 'ok', status: 200, body: { gstr1PreviewDigest: `digest-${g3b[1]}` } };
    const act = /^\/v1\/finance\/gstr1\/submission\/(\d{6})\/(approve|cancel|reconcile|preview)$/.exec(path);
    if (method === 'POST' && act) {
      if (lose > 0) { lose -= 1; return { kind: 'lost' }; } // the answer is lost (the act may or may not have landed)
      if (key !== undefined && seenKeys.has(key)) return seenKeys.get(key)!; // the kernel answers a key once
      const period = act[1]!; const verb = act[2]!;
      const s = subs.get(period) ?? { period };
      const next: Record<string, unknown> = verb === 'approve' ? { ...s, state: 'approved', approvedBy: 'u-fin' } : verb === 'cancel' ? { ...s, state: 'cancelled' }
        : verb === 'preview' ? { period, state: 'previewed', previewedBy: 'u-fin', returnDigest: (body as { returnDigest: string }).returnDigest }
          : { ...s, state: (body as { resolvedState: string }).resolvedState };
      subs.set(period, next);
      const answer: HeadOfficeAnswer = { kind: 'ok', status: 200, body: { period, current: next } };
      if (key !== undefined) seenKeys.set(key, answer);
      return answer;
    }
    return { kind: 'refused', status: 404, code: 'not_found', whatHappened: 'no such route', nextSafeAction: '' };
  };
  return { ho, calls, subs, loseNext: (n = 1) => { lose = n; }, posts: () => calls.filter((c) => c.method === 'POST') };
}

let keySeq = 0;
const live = (initial: Record<string, Record<string, unknown>>, over: Partial<GstReturnsPorts> = {}, userId: string | null = 'u-fin') => {
  const fake = fakeHeadOffice(initial);
  const s = createGstReturnsSession({ userId }, ports({ headOffice: fake.ho, newKey: () => `k-${++keySeq}`, mayPrepare: () => true, ...over }));
  return { s, fake };
};

describe('commandActionsFor — exactly the acts head office allows in each state', () => {
  it('prepared: approve or withdraw; approved: file (switched off) or withdraw; unknown: reconcile; nothing elsewhere', () => {
    expect(commandActionsFor('previewed')).toEqual(['approve', 'cancel']);
    expect(commandActionsFor('approved')).toEqual(['submit', 'cancel']);
    expect(commandActionsFor('unknown')).toEqual(['reconcile']);
    for (const s of ['failed', 'submitting', 'filed', 'cancelled'] as const) expect(commandActionsFor(s)).toEqual([]);
  });
});

describe('load — the filing list is read LIVE from head office (route audit rows 164–165)', () => {
  it('reads the list and each period, with who prepared and approved it', async () => {
    const { s } = live({ '052026': { state: 'previewed', previewedBy: 'u-maker', detail: 'awaiting approval' } }, { rows: () => [] });
    expect(s.view('en').source).toBe('none');
    await s.load();
    const v = s.view('en');
    expect(v.source).toBe('head_office');
    expect(v.rows.map((r) => [r.period, r.preparedBy])).toEqual([['052026', 'u-maker']]);
  });

  it('with head office out of reach, the box copy is shown as NOT live and nothing can be acted on (§31)', async () => {
    const s = createGstReturnsSession({ userId: 'u-fin' }, ports({ headOffice: async () => ({ kind: 'lost' }) }));
    await s.load();
    const v = s.view('en');
    expect(v.source).toBe('box');
    expect(v.liveProblem).toBe(GST_RETURNS_COPY.en.liveLost);
    const prepared = v.rows.find((r) => r.period === '032026')!;
    expect(prepared.actions.every((a) => !a.enabled)).toBe(true);
    expect(await s.act({ period: '032026', action: 'approve' })).toEqual({ ok: false, reason: 'not_live' });
  });

  it('says how many requests an earlier version left unsent on this computer — never sent, never dropped', () => {
    const s = createGstReturnsSession({ userId: 'u-fin' }, ports({ unsentEarlier: () => 2 }));
    expect(s.view('en').unsentEarlier).toBe(`2 ${GST_RETURNS_COPY.en.unsentEarlier}`);
  });
});

describe('act — straight to head office\'s maker-checker routes, exactly once (route audit rows 161, 163, 166, 167)', () => {
  it('approve POSTs to …/approve under the person\'s session and reads the list again', async () => {
    const { s, fake } = live({ '032026': { state: 'previewed', previewedBy: 'u-maker' } });
    await s.load();
    const res = await s.act({ period: '032026', action: 'approve' });
    expect(res).toEqual({ ok: true, action: 'approve', period: '032026', state: 'approved' });
    expect(fake.posts()).toEqual([{ method: 'POST', path: '/v1/finance/gstr1/submission/032026/approve', body: {}, key: `k-${keySeq}` }]);
    expect(s.view('en').rows[0]!.status.label).toBe(GST_RETURNS_COPY.en.stApproved);
    expect(s.resultWords('en', res)).toBe('Approved: 032026');
  });

  it('a lost answer keeps the key: pressing again is the SAME act, so head office does it once', async () => {
    const { s, fake } = live({ '032026': { state: 'previewed', previewedBy: 'u-maker' } });
    await s.load();
    fake.loseNext();
    expect(await s.act({ period: '032026', action: 'approve' })).toEqual({ ok: false, reason: 'lost' });
    const approve = s.view('en').rows[0]!.actions.find((a) => a.action === 'approve')!;
    expect(approve.note).toBe(GST_RETURNS_COPY.en.lostRetry);
    expect(approve.enabled).toBe(true);
    await s.act({ period: '032026', action: 'approve' });
    const [first, second] = fake.posts();
    expect(second!.key).toBe(first!.key);
  });

  it('a second click while the first is on its way sends nothing', async () => {
    const { s, fake } = live({ '032026': { state: 'previewed', previewedBy: 'u-maker' } });
    await s.load();
    const [a, b] = await Promise.all([s.act({ period: '032026', action: 'approve' }), s.act({ period: '032026', action: 'approve' })]);
    expect([a.ok, b]).toEqual([true, { ok: false, reason: 'already_sending' }]);
    expect(fake.posts()).toHaveLength(1);
  });

  it('the MAKER cannot approve their own return — refused here, nothing sent (maker ≠ checker, §28)', async () => {
    const { s, fake } = live({ '032026': { state: 'previewed', previewedBy: 'u-fin' } });
    await s.load();
    expect(s.view('en').rows[0]!.actions.find((a) => a.action === 'approve')).toMatchObject({ enabled: false, note: GST_RETURNS_COPY.en.youPrepared });
    expect(await s.act({ period: '032026', action: 'approve' })).toEqual({ ok: false, reason: 'self_approval' });
    expect(fake.posts()).toEqual([]);
  });

  it('withdraw needs a reason; reconcile needs what the portal shows and the evidence', async () => {
    const { s, fake } = live({ '032026': { state: 'previewed', previewedBy: 'u-maker' }, '072026': { state: 'unknown' } });
    await s.load();
    expect(await s.act({ period: '032026', action: 'cancel', reason: '  ' })).toEqual({ ok: false, reason: 'needs_reason' });
    expect(await s.act({ period: '072026', action: 'reconcile', note: 'seen' })).toEqual({ ok: false, reason: 'needs_evidence' });
    expect(fake.posts()).toEqual([]);
    expect((await s.act({ period: '032026', action: 'cancel', reason: 'figures wrong' })).ok).toBe(true);
    expect((await s.act({ period: '072026', action: 'reconcile', resolvedState: 'filed', note: 'ARN on the portal', arn: 'AA330526123' })).ok).toBe(true);
    expect(fake.posts().map((c) => [c.path, c.body])).toEqual([
      ['/v1/finance/gstr1/submission/032026/cancel', { reason: 'figures wrong' }],
      ['/v1/finance/gstr1/submission/072026/reconcile', { resolvedState: 'filed', note: 'ARN on the portal', arn: 'AA330526123' }],
    ]);
  });

  it('filing to the portal is switched off: shown, never enabled, never sent', async () => {
    const { s, fake } = live({ '052026': { state: 'approved', previewedBy: 'u-maker', approvedBy: 'u-checker' } });
    await s.load();
    expect(s.view('en').rows[0]!.actions.find((a) => a.action === 'submit')).toMatchObject({ enabled: false, note: GST_RETURNS_COPY.en.filingOff });
    expect(await s.act({ period: '052026', action: 'submit' })).toEqual({ ok: false, reason: 'filing_off' });
    expect(fake.posts()).toEqual([]);
  });

  it('a stuck or filed return is never advanced by a button (rule #10)', async () => {
    const { s } = live({ '042026': { state: 'filed', arn: 'ARN' }, '062026': { state: 'failed' } });
    await s.load();
    expect(await s.act({ period: '042026', action: 'approve' })).toEqual({ ok: false, reason: 'not_actionable' });
    expect(await s.act({ period: '062026', action: 'reconcile', resolvedState: 'filed', note: 'x' })).toEqual({ ok: false, reason: 'not_actionable' });
    expect(await s.act({ period: '999999', action: 'approve' })).toEqual({ ok: false, reason: 'unknown_period' });
  });

  it('refuses without the role or a named person', async () => {
    const noRole = live({ '032026': { state: 'previewed', previewedBy: 'u-maker' } }, { mayApprove: () => false });
    await noRole.s.load();
    expect(await noRole.s.act({ period: '032026', action: 'approve' })).toEqual({ ok: false, reason: 'not_permitted' });
    const nobody = live({ '032026': { state: 'previewed', previewedBy: 'u-maker' } }, {}, null);
    await nobody.s.load();
    expect(await nobody.s.act({ period: '032026', action: 'approve' })).toEqual({ ok: false, reason: 'not_permitted' });
  });
});

describe('prepare — the maker records head office\'s OWN digest of the month (route audit row 166)', () => {
  it('reads gstr1PreviewDigest from GSTR-3B and POSTs it to …/preview', async () => {
    const { s, fake } = live({});
    await s.load();
    const res = await s.prepare('052026');
    expect(res).toEqual({ ok: true, action: 'preview', period: '052026', state: 'previewed' });
    expect(fake.posts().map((c) => [c.path, c.body])).toEqual([['/v1/finance/gstr1/submission/052026/preview', { returnDigest: 'digest-052026' }]]);
    expect(s.view('en').rows.map((r) => r.period)).toEqual(['052026']);
  });

  it('refuses a malformed month or a person who may not prepare, before anything is sent', async () => {
    const { s, fake } = live({}, { mayPrepare: () => false });
    expect(await s.prepare('13-2026')).toEqual({ ok: false, reason: 'bad_period' });
    expect(await s.prepare('052026')).toEqual({ ok: false, reason: 'not_permitted' });
    expect(fake.calls).toEqual([]);
  });
});

describe('the copy is complete in both languages', () => {
  it('has an English AND a Tamil word for every key the screen uses (packages/ui bilingualGaps)', () => {
    const gaps = bilingualGaps(GST_RETURNS_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
