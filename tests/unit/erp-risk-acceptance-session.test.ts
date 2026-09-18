import { describe, it, expect } from 'vitest';
import {
  RISK_ACCEPTANCE_COPY, COPY_KEYS, createRiskAcceptanceSession,
  type RiskAcceptancePorts, type BlockedGatesData, type GateBlockView, type AcceptResult,
} from '../../apps/web-erp/src/risk-acceptance-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The risk-acceptance / compliance-gates screen (M34-FR-04 · API-11 · P-03 · §28). It shows every quality gate
// blocked by an open critical risk, each reading as attention (never a bare colour); the one action is to
// ACCEPT a risk with a written rationale (a human write in the accepter's own name) which unblocks its gate. It
// refuses locally before any POST without permission or a rationale — and the server still enforces the
// name+reason rule, which the screen never fabricates.

const block = (over: Partial<GateBlockView> & Pick<GateBlockView, 'gate' | 'riskId'>): GateBlockView => ({
  title: 'Unencrypted backups', severity: 'critical', ownerUserId: 'u-seclead', reason: 'open critical risk on this gate', ...over,
});

const worklist = (blocked: readonly GateBlockView[]): BlockedGatesData => ({ count: blocked.length, blocked });

const session = (
  w: BlockedGatesData,
  ports: Partial<RiskAcceptancePorts> = {},
  userId: string | null = 'u-seclead',
) =>
  createRiskAcceptanceSession({ userId }, {
    worklist: () => w,
    mayRead: () => true,
    mayManage: () => true,
    acceptPort: () => ({ post: async () => 'accepted' as AcceptResult }),
    ...ports,
  });

describe('the risk-acceptance copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(RISK_ACCEPTANCE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...RISK_ACCEPTANCE_COPY.en }, ta: { ...RISK_ACCEPTANCE_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('the view lists blocked gates as attention, with the distinct risks behind them', () => {
  it('presents each blocked gate as attention (degraded, icon+word), keeps worklist order, dedupes the risks', () => {
    const view = session(worklist([
      block({ gate: 'QG-04', riskId: 'RISK-1', title: 'Unencrypted backups' }),
      block({ gate: 'QG-07', riskId: 'RISK-1', title: 'Unencrypted backups' }), // same risk, second gate
      block({ gate: 'QG-09', riskId: 'RISK-2', title: 'No DR drill this quarter' }),
    ])).view('en');

    expect(view.blockedCount).toBe(3);
    expect(view.screenState.tone).not.toBe('error');

    const first = view.blocked[0]!;
    expect(first.gate).toBe('QG-04');                 // worklist order preserved
    expect(first.needsAttention).toBe(true);
    expect(first.status.tone).toBe('degraded');
    expect(first.status.icon.trim()).not.toBe('');    // a shape survives greyscale
    expect(first.severity).toBe('Critical');          // a word, not a colour
    expect(first.status.label.trim()).not.toBe('');

    // Two gate-blocks share RISK-1 → one dropdown entry; RISK-2 → another. Distinct, first-seen order.
    expect(view.risks.map((r) => r.riskId)).toEqual(['RISK-1', 'RISK-2']);
    expect(view.risks[0]!.label).toContain('Unencrypted backups');
  });

  it('an empty worklist is a calm "every gate can pass", not an error', () => {
    const view = session(worklist([])).view('en');
    expect(view.blockedCount).toBe(0);
    expect(view.blocked).toEqual([]);
    expect(view.risks).toEqual([]);
    expect(view.screenState.tone).not.toBe('error');
  });
});

describe('permission and identity gate what the screen offers', () => {
  it('a reader without compliance.risk.read sees nothing and a not-permitted state', () => {
    const view = session(worklist([block({ gate: 'QG-04', riskId: 'RISK-1' })]), { mayRead: () => false }).view('en');
    expect(view.blocked).toEqual([]);
    expect(view.blockedCount).toBe(0);
    expect(view.screenState.tone).toBe('error');
  });

  it('may-manage drives whether the accept action is offered', () => {
    expect(session(worklist([block({ gate: 'QG-04', riskId: 'RISK-1' })]), { mayManage: () => false }).view('en').mayManage).toBe(false);
    expect(session(worklist([block({ gate: 'QG-04', riskId: 'RISK-1' })]), { mayManage: () => true }).view('en').mayManage).toBe(true);
  });

  it('nobody named at the screen is surfaced (an acceptance carries a name)', () => {
    expect(session(worklist([]), {}, null).view('en').nobodyNamed).toBe(true);
    expect(session(worklist([]), {}, 'u-seclead').view('en').nobodyNamed).toBe(false);
  });
});

describe('accepting a risk refuses locally before any POST, then delegates to the port', () => {
  it('refuses without permission, without a rationale, or for an empty risk id — and never POSTs', async () => {
    let posted = 0;
    const s = session(worklist([block({ gate: 'QG-04', riskId: 'RISK-1' })]), {
      mayManage: () => true,
      acceptPort: () => ({ post: async () => { posted += 1; return 'accepted'; } }),
    });
    expect(await s.accept('RISK-1', '   ')).toBe('refused'); // empty rationale
    expect(await s.accept('   ', 'a reason')).toBe('refused'); // empty risk id
    expect(posted).toBe(0);

    const noPerm = session(worklist([block({ gate: 'QG-04', riskId: 'RISK-1' })]), {
      mayManage: () => false,
      acceptPort: () => ({ post: async () => { posted += 1; return 'accepted'; } }),
    });
    expect(await noPerm.accept('RISK-1', 'we will carry it this quarter')).toBe('refused');
    expect(posted).toBe(0);
  });

  it('a valid acceptance (permission + risk + rationale) POSTs the trimmed decision and returns the result', async () => {
    const seen: { riskId: string; rationale: string }[] = [];
    const s = session(worklist([block({ gate: 'QG-04', riskId: 'RISK-1' })]), {
      mayManage: () => true,
      acceptPort: () => ({ post: async (i) => { seen.push(i); return 'accepted'; } }),
    });
    expect(await s.accept('RISK-1', '  compensating control in place; owner sign-off attached  ')).toBe('accepted');
    expect(seen).toEqual([{ riskId: 'RISK-1', rationale: 'compensating control in place; owner sign-off attached' }]);
  });

  it('surfaces the server refusal and a lost link, unchanged', async () => {
    const refused = session(worklist([block({ gate: 'QG-04', riskId: 'RISK-1' })]), {
      acceptPort: () => ({ post: async () => 'refused' as AcceptResult }),
    });
    expect(await refused.accept('RISK-1', 'a reason')).toBe('refused');

    const lost = session(worklist([block({ gate: 'QG-04', riskId: 'RISK-1' })]), {
      acceptPort: () => ({ post: async () => 'lost_link' as AcceptResult }),
    });
    expect(await lost.accept('RISK-1', 'a reason')).toBe('lost_link');
  });
});

describe('result presentation is bilingual and glanceable', () => {
  it('presents each acceptance result as a distinct tone with an icon and words', () => {
    const s = session(worklist([]));
    expect(s.presentAcceptResult('en', 'accepted').tone).toBe('ok');
    expect(s.presentAcceptResult('en', 'lost_link').tone).toBe('degraded');
    expect(s.presentAcceptResult('en', 'refused').tone).toBe('error');
    for (const r of ['accepted', 'lost_link', 'refused'] as const) {
      expect(s.presentAcceptResult('ta', r).icon.trim()).not.toBe('');
      expect(s.presentAcceptResult('ta', r).label.trim()).not.toBe('');
    }
  });
});
