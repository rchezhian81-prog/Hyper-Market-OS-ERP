// Round 4c (people and administration) — the browser wiring for the office pages this round adds, kept in one file so the
// shared bundle entry (browser-entry.ts) carries one import and one call. Each page's tested session is attached to its own
// window global from the viewer the front door injected (identity only). Nothing is read or written here.

import { createAuditLogSession, auditLogWords, auditLogOutcomeWords, stateWords } from './audit-log-session';
import { createStaffSession, staffWords, staffOutcomeWords } from './staff-session';
import { createSettingsSession, settingsWords, settingsOutcomeWords, valueWords } from './settings-session';
import { createPoshCommitteeSession, poshCommitteeWords, poshCommitteeOutcomeWords } from './posh-committee-session';
import { createBranchesSession, branchesWords, branchesOutcomeWords, NEXT } from './branches-session';
import { createDncSession, dncWords, dncOutcomeWords, DNC_CHANNELS, DNC_SOURCES } from './do-not-contact-session';
import { createCertInCapacitySession, certInWords, certInOutcomeWords, CAPACITY_MEASURE_KEYS } from './cert-in-capacity-session';
import { shopMomentOf } from './findings-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** The store the box named for a page (its own store, from its signed pack), when it named one. */
const storeOf = (raw: unknown): { storeId?: string } => {
  const id = raw !== null && typeof raw === 'object' ? (raw as { storeId?: unknown }).storeId : undefined;
  return typeof id === 'string' && id.trim() !== '' ? { storeId: id.trim() } : {};
};

export function wireRound4c(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['auditLogData'] !== undefined) {
    win['auditLog'] = { session: createAuditLogSession({ viewer: viewerIdentity(win['auditLogData']) }), words: auditLogWords, outcomeWords: auditLogOutcomeWords, stateWords, moment: shopMomentOf };
  }
  if (win['settingsData'] !== undefined) {
    win['settings'] = { session: createSettingsSession({ viewer: viewerIdentity(win['settingsData']) }), words: settingsWords, outcomeWords: settingsOutcomeWords, valueWords };
  }
  if (win['poshCommitteeData'] !== undefined) {
    win['poshCommittee'] = { session: createPoshCommitteeSession({ viewer: viewerIdentity(win['poshCommitteeData']) }), words: poshCommitteeWords, outcomeWords: poshCommitteeOutcomeWords, moment: shopMomentOf };
  }
  if (win['branchesData'] !== undefined) {
    win['branches'] = {
      session: createBranchesSession({ viewer: viewerIdentity(win['branchesData']) }), words: branchesWords, outcomeWords: branchesOutcomeWords, next: NEXT, moment: shopMomentOf,
      rupees: (minor: number): string => `₹${(minor / 100).toFixed(2)}`,
    };
  }
  if (win['doNotContactData'] !== undefined) {
    win['doNotContact'] = { session: createDncSession({ viewer: viewerIdentity(win['doNotContactData']) }), words: dncWords, outcomeWords: dncOutcomeWords, channels: DNC_CHANNELS, sources: DNC_SOURCES, moment: shopMomentOf };
  }
  if (win['certInData'] !== undefined) {
    win['certIn'] = { session: createCertInCapacitySession({ viewer: viewerIdentity(win['certInData']) }), words: certInWords, outcomeWords: certInOutcomeWords, measures: CAPACITY_MEASURE_KEYS, moment: shopMomentOf };
  }
  if (win['staffData'] !== undefined) {
    win['staff'] = { session: createStaffSession({ viewer: viewerIdentity(win['staffData']) }), words: staffWords, outcomeWords: staffOutcomeWords, ...storeOf(win['staffData']) };
  }
}
