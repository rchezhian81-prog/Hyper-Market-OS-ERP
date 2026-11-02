import { describe, it, expect } from 'vitest';
import { accessReviewOutcomeWords } from '../../apps/web-erp/src/access-review-session';
import { adoptionOutcomeWords } from '../../apps/web-erp/src/adoption-session';
import { approvalRulesOutcomeWords } from '../../apps/web-erp/src/approval-rules-session';
import { competitorOutcomeWords } from '../../apps/web-erp/src/competitor-price-session';
import { concessionOutcomeWords } from '../../apps/web-erp/src/concession-session';
import { helpOutcomeWords } from '../../apps/web-erp/src/help-session';
import { outcomeWords as incidentsOutcomeWords } from '../../apps/web-erp/src/incidents-session';
import { correlationOutcomeWords } from '../../apps/web-erp/src/lp-correlation-session';
import { ownerAlertsOutcomeWords } from '../../apps/web-erp/src/owner-alerts-session';
import { payrollLiveOutcome } from '../../apps/web-erp/src/payroll-live-session';
import { baysOutcomeWords } from '../../apps/web-erp/src/planogram-bays-session';
import { requisitionsOutcomeWords } from '../../apps/web-erp/src/requisitions-session';
import { scaleRuleOutcomeWords } from '../../apps/web-erp/src/scale-label-rules-session';
import { outcomeWords as scalesOutcomeWords } from '../../apps/web-erp/src/scales-session';
import { outcomeWords as storeComputersOutcomeWords } from '../../apps/web-erp/src/store-computers-session';
import { outcomeWords as storeOpsOutcomeWords } from '../../apps/web-erp/src/store-ops-session';
import { scorecardOutcomeWords } from '../../apps/web-erp/src/supplier-scorecard-session';
import { supplierSubmissionsOutcomeWords } from '../../apps/web-erp/src/supplier-submissions-session';

/**
 * **U1 (2 Nov 2026 · UI/UX gap audit G10, the U0-deferred tail · design system §1 rule 5): every office refusal says what
 * happened, that nothing was changed, and the next safe action — on the eighteen sessions that still said only the first.**
 *
 * Before U1 these sessions printed "Head office refused: <its sentence>" and, with no sentence, "Head office refused:
 * status 404" / "Head office answered 404." — a code, with no word on whether anything was saved and nothing to do next.
 * Each now goes through `refusal-words.ts`. Head office's own sentence, when it gave one, is kept word for word.
 */

type Lang = 'en' | 'ta';
type Words = (lang: Lang, out: never) => string | { readonly text: string };
const text = (v: string | { readonly text: string }): string => (typeof v === 'string' ? v : v.text);

/** The refusal as the shared `Outcome` carries it (`result`), and as the finance-close family carries it (`kind`). */
const refusedResult = (whatHappened: string) => ({ result: 'refused', status: 404, code: 'not_found', whatHappened }) as never;
const refusedKind = (whatHappened: string) => ({ kind: 'refused', status: 404, code: 'not_found', whatHappened, nextSafeAction: '' }) as never;

const SESSIONS: ReadonlyArray<readonly [string, Words, (what: string) => never]> = [
  ['access review', accessReviewOutcomeWords as Words, refusedResult],
  ['adoption', adoptionOutcomeWords as Words, refusedResult],
  ['approval rules', approvalRulesOutcomeWords as Words, refusedResult],
  ['competitor prices', competitorOutcomeWords as Words, refusedKind],
  ['concessions', concessionOutcomeWords as Words, refusedResult],
  ['help and procedures', helpOutcomeWords as Words, refusedResult],
  ['incidents', incidentsOutcomeWords as Words, refusedResult],
  ['bought together (LP)', correlationOutcomeWords as Words, refusedResult],
  ['owner alerts', ownerAlertsOutcomeWords as Words, refusedResult],
  ['payroll (live)', payrollLiveOutcome as Words, (what) => ({ result: 'refused', status: 403, code: 'forbidden', whatHappened: what }) as never],
  ['shelf compliance by bay', baysOutcomeWords as Words, refusedResult],
  ['requisitions', requisitionsOutcomeWords as Words, refusedResult],
  ['scale label rules', scaleRuleOutcomeWords as Words, refusedKind],
  ['weighing scales', scalesOutcomeWords as Words, refusedResult],
  ['store computers', storeComputersOutcomeWords as Words, refusedResult],
  ['store operations', storeOpsOutcomeWords as Words, refusedResult],
  ['supplier scorecard', scorecardOutcomeWords as Words, refusedResult],
  ['supplier submissions', supplierSubmissionsOutcomeWords as Words, refusedResult],
];

describe('U1: every office refusal carries the three parts', () => {
  for (const [name, words, refused] of SESSIONS) {
    it(`${name}: no sentence from head office → plain words for the cause, "Nothing was changed.", the next safe action — never a raw code`, () => {
      const en = text(words('en', refused('status 404')));
      expect(en).toMatch(/^Head office refused: /);
      expect(en).toContain('Nothing was changed.');
      expect(en).not.toMatch(/status 404|not_found|forbidden|answered 40\d/);
      expect(en).toMatch(/Ask a person who holds that right\.|Refresh the page and check the number\.$/);
      const ta = text(words('ta', refused('')));
      expect(ta).toMatch(/^தலைமை அலுவலகம் மறுத்தது: /);
      expect(ta).toContain('எதுவும் மாற்றப்படவில்லை.');
      expect(ta).not.toMatch(/[A-Za-z]{4,}/);
    });

    it(`${name}: a sentence head office wrote is kept word for word, with the two parts after it`, () => {
      const en = text(words('en', refused('This record was already decided by Priya at 10:12.')));
      expect(en).toContain('This record was already decided by Priya at 10:12.');
      expect(en).toMatch(/Nothing was changed\. .+/);
    });
  }
});
