// W5 (platform, access, approvals and data import) — the browser wiring for the sections this wave adds to existing office
// pages, kept in one file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each page's viewer
// (identity only, injected by the front door) builds that page's tested sessions under `window.w5Platform`. Nothing is read
// or written here; `apps/web-erp/web/w5-platform.js` paints whichever sections the page carries.

import * as s from './w5-platform-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] } | undefined;

/** Which page (its window global) carries which sections. */
export const W5_PAGES: Readonly<Record<string, (v: Viewer) => Record<string, unknown>>> = Object.freeze({
  storeComputersData: (viewer) => ({ registers: s.createStoreComputerRegistersSession({ viewer }) }),
  approvalsData: (viewer) => ({ aged: s.createAgedApprovalsSession({ viewer }) }),
  approvalRulesData: (viewer) => ({ ruleHistory: s.createRuleHistorySession({ viewer }) }),
  delegationData: (viewer) => ({ effective: s.createEffectiveAuthoritySession({ viewer }) }),
  usersData: (viewer) => ({ committee: s.createCommitteeChangeSession({ viewer }), caGrant: s.createCaGrantSession({ viewer }), revocations: s.createTokenRevocationSession({ viewer }) }),
  fleetData: (viewer) => ({ fleetControl: s.createFleetControlSession({ viewer }) }),
  rolloutData: (viewer) => ({ licences: s.createLicencesSession({ viewer }) }),
  integrationHealthData: (viewer) => ({ secrets: s.createSecretsSession({ viewer }) }),
  incidentsData: (viewer) => ({ incidentAlert: s.createIncidentAlertSession({ viewer }), serviceRequests: s.createServiceRequestsSession({ viewer }) }),
  adminData: (viewer) => ({ supportReview: s.createSupportReviewSession({ viewer }) }),
  documentTemplatesData: (viewer) => ({ reprint: s.createReprintSession({ viewer }) }),
  ownerAlertsData: (viewer) => ({ scheduleRuns: s.createScheduleRunsSession({ viewer }) }),
  branchCompareData: (viewer) => ({ drillAudits: s.createDrillAuditsSession({ viewer }) }),
  cashOfficeData: (viewer) => ({ legacy: s.createLegacyPlacementSession({ viewer }) }),
  dataIoData: (viewer) => ({ importChecks: s.createImportChecksSession({ viewer }) }),
});

export function wireW5Platform(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer): void {
  const sessions: Record<string, unknown> = {};
  for (const [global, make] of Object.entries(W5_PAGES)) {
    if (win[global] !== undefined) Object.assign(sessions, make(viewerIdentity(win[global])));
  }
  win['w5Platform'] = { sessions, helpers: s };
}
