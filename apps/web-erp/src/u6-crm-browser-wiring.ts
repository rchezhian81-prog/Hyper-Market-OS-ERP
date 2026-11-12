// U6 (UI/UX gap audit §27 CRM rows · M21-FR-03 · M21-FR-04 · M16-FR-02) — the browser wiring for the three CRM office pages
// this round adds: Compensation (raised for a separate approver), Customer satisfaction and Check consent. Each page's tested
// session is attached to its own window global from the viewer the front door injected (identity only). Nothing is read or
// written here.

import { createCompensationSession, compensationWords, compensationOutcomeWords, planCompensation, rupees, COMPENSATION_KINDS } from './compensation-session';
import { createSatisfactionSession, satisfactionWords, satisfactionOutcomeWords } from './satisfaction-session';
import { createConsentCheckSession, consentCheckWords, consentCheckOutcomeWords, matchCustomers, CHECKED_PURPOSES } from './consent-check-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

const CASE_KINDS: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = {
  complaint: { en: 'Complaint', ta: 'புகார்' }, enquiry: { en: 'Enquiry', ta: 'விசாரணை' }, warranty: { en: 'Warranty', ta: 'உத்தரவாதம்' }, lost_and_found: { en: 'Lost and found', ta: 'தொலைந்தது கிடைத்தது' },
};
export const caseKindWords = (lang: 'en' | 'ta', kind: string): string => CASE_KINDS[kind]?.[lang] ?? kind;

export function wireU6Crm(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['compensationData'] !== undefined) {
    win['compensation'] = {
      session: createCompensationSession({ viewer: viewerIdentity(win['compensationData']) }), words: compensationWords, outcomeWords: compensationOutcomeWords,
      plan: planCompensation, rupees, kinds: COMPENSATION_KINDS, caseKind: caseKindWords,
    };
  }
  if (win['satisfactionData'] !== undefined) {
    win['satisfaction'] = { session: createSatisfactionSession({ viewer: viewerIdentity(win['satisfactionData']) }), words: satisfactionWords, outcomeWords: satisfactionOutcomeWords };
  }
  if (win['consentCheckData'] !== undefined) {
    win['consentCheck'] = { session: createConsentCheckSession({ viewer: viewerIdentity(win['consentCheckData']) }), words: consentCheckWords, outcomeWords: consentCheckOutcomeWords, match: matchCustomers, purposes: CHECKED_PURPOSES };
  }
}
