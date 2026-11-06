// W5 (compliance, risk, EPR and audit registers) — the browser wiring for the sections and the page this wave adds, kept in
// one file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each tested session is attached to
// its own window global from the viewer the front door injected (identity only). Nothing is read or written here.
//   • EPR registers page (`eprData`) → `window.eprRecords` — the records a person keeps (OB-212);
//   • Licences, controls and findings page (`complianceRegistersData`) → `window.complianceRegisters` (M34-FR-03/04, OB-331);
//   • Audit log page (`auditLogData`) → `window.legalHolds` — holds, the keeping plan, the evidence pack (M34-FR-01/02).

import { createEprRecordsSession, eprRecordsWords, eprRecordsOutcomeWords, EPR_SETTING_PATHS, PLASTIC_CATEGORIES, TAKE_BACK_KINDS, gramsOfMg } from './epr-records-session';
import { createComplianceRegistersSession, complianceWords, complianceOutcomeWords, OBLIGATION_KINDS, INCIDENT_SEVERITIES, FINDING_SEVERITIES, PERSON_FINDING_SOURCES } from './compliance-registers-session';
import { createLegalHoldsSession, legalHoldsWords, legalHoldsOutcomeWords } from './legal-holds-session';
import { shopMomentOf } from './findings-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireW5Compliance(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['eprData'] !== undefined) {
    win['eprRecords'] = {
      session: createEprRecordsSession({ viewer: viewerIdentity(win['eprData']) }), words: eprRecordsWords, outcomeWords: eprRecordsOutcomeWords,
      settings: Object.keys(EPR_SETTING_PATHS), categories: PLASTIC_CATEGORIES, kinds: TAKE_BACK_KINDS, grams: gramsOfMg,
    };
  }
  if (win['complianceRegistersData'] !== undefined) {
    win['complianceRegisters'] = {
      session: createComplianceRegistersSession({ viewer: viewerIdentity(win['complianceRegistersData']) }), words: complianceWords, outcomeWords: complianceOutcomeWords,
      kinds: OBLIGATION_KINDS, incidentSeverities: INCIDENT_SEVERITIES, findingSeverities: FINDING_SEVERITIES, findingSources: PERSON_FINDING_SOURCES, moment: shopMomentOf,
    };
  }
  if (win['auditLogData'] !== undefined) {
    win['legalHolds'] = { session: createLegalHoldsSession({ viewer: viewerIdentity(win['auditLogData']) }), words: legalHoldsWords, outcomeWords: legalHoldsOutcomeWords, moment: shopMomentOf };
  }
}
