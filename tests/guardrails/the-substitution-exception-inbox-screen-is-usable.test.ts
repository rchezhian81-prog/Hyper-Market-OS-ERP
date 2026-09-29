import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SUB_EXCEPTION_INBOX_COPY, COPY_KEYS, createSubExceptionInboxSession,
  type SubExceptionInboxPorts, type SubExceptionWorklistData, type SubExceptionView,
} from '../../apps/web-erp/src/substitution-exception-inbox-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The delivery-substitution exception inbox is usable, bilingual, and governed (M19-FR-01, Item 2, API-07, §28).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: a BREACHED SLA reads as an ERROR and an open exception
 * as ATTENTION; the only writes are CLAIM / RELEASE / RESOLVE that run ONLY on an explicit click (never on
 * load — hard rule #6, the exception's history is append-only); a resolve without a reason and the words is
 * refused before any POST; and the worklist read stays a GET.
 */

const view = (over: Partial<SubExceptionView> & Pick<SubExceptionView, 'exceptionId'>): SubExceptionView => ({
  orderId: 'ord-77', lineId: 'line-2', kind: 'refund_due', amountMinor: 12500, detail: 'refund due', owner: 'finance_recon_queue', state: 'open',
  reasonCode: 'SUB-REFUND-DUE', raisedAt: '2026-09-29T08:00:00Z', sla: { ageMinutes: 45, dueAt: '2026-09-29T10:00:00Z', breached: false }, ...over,
});
const worklist: SubExceptionWorklistData = {
  exceptions: [view({ exceptionId: 'E-open' }), view({ exceptionId: 'E-breached', state: 'in_progress', assignedTo: 'u-desk', sla: { ageMinutes: 200, dueAt: '2026-09-29T09:00:00Z', breached: true } })],
  count: 2, atRiskMinor: 25000, open: { count: 2, atRiskMinor: 25000, breached: 1 },
  queues: { fulfilment_supervisor: 0, customer_service_desk: 0, finance_recon_queue: 2, duty_manager: 0 },
};
const session = (ports: Partial<SubExceptionInboxPorts> = {}) =>
  createSubExceptionInboxSession({ userId: 'u-desk' }, {
    worklist: () => worklist, mayRead: () => true, mayWork: () => true, actionPort: () => ({ post: async () => 'done' }), ...ports,
  });

describe('the delivery-exceptions inbox copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(SUB_EXCEPTION_INBOX_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...SUB_EXCEPTION_INBOX_COPY.en }, ta: { ...SUB_EXCEPTION_INBOX_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('an open exception reads as attention and a breached SLA as an error, never colour alone', () => {
  it('open → degraded with a word and an icon; breached → error with a word and an icon', () => {
    const v = session().view('en');
    const open = v.rows.find((r) => r.exceptionId === 'E-open')!;
    const breached = v.rows.find((r) => r.exceptionId === 'E-breached')!;
    expect(open.status.tone).toBe('degraded');
    expect(breached.status.tone).toBe('error');
    for (const r of [open, breached]) {
      expect(r.needsAttention).toBe(true);
      expect(r.status.label.length).toBeGreaterThan(0);
      expect(r.status.icon.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('an unpermitted user is offered no act, and a resolve without a record is refused before any POST', () => {
  it('the view withholds every offer without order.exception.work, and the model refuses even if called', async () => {
    const noPerm = session({ mayWork: () => false });
    expect(noPerm.view('en').mayWork).toBe(false);
    expect(noPerm.view('en').rows.every((r) => r.offer === 'none')).toBe(true);
    expect(await noPerm.claim('E-open')).toBe('refused');
    expect(await noPerm.resolve('E-breached', 'REFUNDED', 'refunded to the card')).toBe('refused');
    // A resolve with no reason code, or no words, is refused locally too — a resolution with no reason is not a record.
    expect(await session().resolve('E-breached', '', 'refunded')).toBe('refused');
    expect(await session().resolve('E-breached', 'REFUNDED', '   ')).toBe('refused');
    // A permitted queue member with both reaches the port (which records it), as does a claim on an OPEN row.
    expect(await session().resolve('E-breached', 'REFUNDED', 'refunded to the card, customer told')).toBe('done');
    expect(await session().claim('E-open')).toBe('done');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/substitution-exceptions.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt (the record is a text input, not a browser dialog)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.substitutionExceptionInboxSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('acts ONLY from an explicit click — claim / release / resolve never run at load (hard rule #6, history kept)', () => {
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    for (const call of ['session.claim(', 'session.release(', 'session.resolve(']) {
      const callIdx = VIEW.indexOf(call);
      expect(callIdx, `${call} is not present`).toBeGreaterThan(-1);
      expect(callIdx, `${call} runs before/outside a click handler (would write on load)`).toBeGreaterThan(clickIdx);
    }
    // The only writes are the act POSTs — no other verb, and the worklist read stays a GET.
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes.every((m) => m.includes('POST')), 'the screen uses a write verb other than POST').toBe(true);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the lists', () => {
    const HTML = readFileSync('apps/web-erp/web/substitution-exceptions.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="worker"[^>]*aria-label=/);
  });
});
