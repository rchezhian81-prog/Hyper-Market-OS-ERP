// Wave 3 (security, people and operations) — the browser wiring for the office pages this wave adds, kept in one file so the
// shared bundle entry (browser-entry.ts) carries one import and one call. Each page's tested session is attached to its own
// window global from the viewer the front door injected (identity only). Nothing is read or written here.

import { createEmergencyAccessSession, emergencyWords, emergencyOutcomeWords } from './emergency-access-session';
import { createSafetyIncidentsSession, safetyWords, safetyOutcomeWords, INCIDENT_KINDS, INCIDENT_SEVERITIES } from './safety-incidents-session';
import { createOpsAlertsSession, opsAlertsWords, opsAlertsOutcomeWords, ALERT_LEVELS } from './ops-alerts-session';
import { createDocumentRetentionSession, retentionWords, retentionOutcomeWords } from './document-retention-session';
import { createSalesCommissionSession, commissionWords, commissionOutcomeWords, percentOf, rupeesOf } from './sales-commission-session';
import { shopMomentOf } from './findings-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** The store the box named for a page (its own store, from its signed pack), when it named one. */
const storeOf = (raw: unknown): { storeId?: string } => {
  const id = raw !== null && typeof raw === 'object' ? (raw as { storeId?: unknown }).storeId : undefined;
  return typeof id === 'string' && id.trim() !== '' ? { storeId: id.trim() } : {};
};

export function wireW3SecOps(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['emergencyAccessData'] !== undefined) {
    win['emergencyAccess'] = { session: createEmergencyAccessSession({ viewer: viewerIdentity(win['emergencyAccessData']) }), words: emergencyWords, outcomeWords: emergencyOutcomeWords, moment: shopMomentOf };
  }
  if (win['safetyIncidentsData'] !== undefined) {
    win['safetyIncidents'] = {
      session: createSafetyIncidentsSession({ viewer: viewerIdentity(win['safetyIncidentsData']) }), words: safetyWords, outcomeWords: safetyOutcomeWords,
      kinds: INCIDENT_KINDS, severities: INCIDENT_SEVERITIES, moment: shopMomentOf, ...storeOf(win['safetyIncidentsData']),
    };
  }
  if (win['opsAlertsData'] !== undefined) {
    win['opsAlerts'] = { session: createOpsAlertsSession({ viewer: viewerIdentity(win['opsAlertsData']) }), words: opsAlertsWords, outcomeWords: opsAlertsOutcomeWords, levels: ALERT_LEVELS, moment: shopMomentOf };
  }
  if (win['documentRetentionData'] !== undefined) {
    win['documentRetention'] = { session: createDocumentRetentionSession({ viewer: viewerIdentity(win['documentRetentionData']) }), words: retentionWords, outcomeWords: retentionOutcomeWords };
  }
  if (win['salesCommissionData'] !== undefined) {
    win['salesCommission'] = { session: createSalesCommissionSession({ viewer: viewerIdentity(win['salesCommissionData']) }), words: commissionWords, outcomeWords: commissionOutcomeWords, percent: percentOf, rupees: rupeesOf, moment: shopMomentOf };
  }
}
