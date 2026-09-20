import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  RETURN_GOVERNANCE_COPY, COPY_KEYS, createReturnGovernanceSession,
  type ReturnGovernancePorts, type ReturnGovernanceData, type FlaggedReturnView,
} from '../../apps/web-erp/src/return-governance-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The refund-exceptions review screen is usable, bilingual, and READ-ONLY (M13-FR-01/03, M17, API-05, P-03, P-08).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the one thing THIS screen must never do: WRITE. A breach here is worked out of band (the money
 * already moved at the lane), so the screen only READS (`GET /v1/pos/return-governance-exceptions`); there is
 * no POST/PUT/PATCH/DELETE anywhere in it.
 */

const flagged = (over: Partial<FlaggedReturnView> & Pick<FlaggedReturnView, 'returnId'>): FlaggedReturnView => ({
  originalSaleId: 'S1', laneId: 'lane-1', processedBy: 'u-lanecash', approvedBy: 'u-mgr', customerRef: 'c-asha',
  reasonCode: 'customer_changed_mind', refundMinor: 5000, refundTender: 'store_credit',
  processedAt: '2026-09-18T10:00:00Z', governanceFlags: ['store_credit_over_cap'], ...over,
});
const data: ReturnGovernanceData = { exceptionCount: 1, totalRefundMinor: 5000, exceptions: [flagged({ returnId: 'RT-1' })] };
const session = (ports: Partial<ReturnGovernancePorts> = {}) =>
  createReturnGovernanceSession({ userId: 'u-owner' }, { exceptions: () => data, mayRead: () => true, ...ports });

describe('the return-governance copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(RETURN_GOVERNANCE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...RETURN_GOVERNANCE_COPY.en }, ta: { ...RETURN_GOVERNANCE_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('an exception reads as attention, never colour alone', () => {
  it('a flagged return is attention (degraded) with a word and an icon, and names what broke', () => {
    const row = session().view('en').exceptions[0]!;
    expect(row.needsAttention).toBe(true);
    expect(row.status.tone).toBe('degraded');
    expect(row.status.label.length).toBeGreaterThan(0);
    expect(row.status.icon.trim().length).toBeGreaterThan(0);
    expect(row.flags.length).toBeGreaterThan(0);
    expect(row.flags[0]!.label.length).toBeGreaterThan(0);
  });

  it('an unpermitted user is shown nothing', () => {
    const v = session({ mayRead: () => false }).view('en');
    expect(v.exceptions).toEqual([]);
    expect(v.screenState.needsAttention).toBe(true);
  });
});

describe('the view defers to the model, uses no browser dialogs, and never writes (read-only)', () => {
  const RAW = readFileSync('apps/web-erp/web/return-governance.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.returnGovernanceSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('is READ-ONLY — no write verb anywhere, and the live read is a GET', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes, `the read-only screen uses a write verb: ${writes.join(', ')}`).toEqual([]);
    // The refresh goes through the injected api, which is the GET fetch — the screen holds no fetch of its own.
    expect(VIEW).toMatch(/window\.returnGovernance\b/);
    expect(VIEW).toMatch(/api\.refresh\(/);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the list', () => {
    const HTML = readFileSync('apps/web-erp/web/return-governance.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
