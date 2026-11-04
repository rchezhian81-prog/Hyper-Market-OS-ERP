// W5 (people, payroll and HR registers) — the browser wiring for the sections this wave adds to existing pages, kept in one
// file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each section's tested session is
// attached to its own window global from the viewer the front door injected for that page (identity only). Nothing is
// read or written here.

import { createPayrollStatutorySession, createPayrollLegalSession, payrollStatutoryWords, payrollStatutoryOutcomeWords, statutoryRupees } from './payroll-statutory-session';
import { createWorkingTimeSession, workingTimeWords, workingTimeOutcomeWords, WT_LIMIT_KEYS, WT_LEAVE_TYPES, WT_LEAVE_KINDS } from './working-time-session';
import { shopMomentOf } from './findings-session';
import { createPoshRegisterSession, poshRegisterWords, poshRegisterOutcomeWords, POSH_STEP_OUTCOMES } from './posh-register-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** The pages that carry a working-time section: Settings (limits and leave), Staff (leave and registers), Staff schedule. */
const WORKING_TIME_PAGES = ['settingsData', 'staffData', 'scheduleData'] as const;

export function wireW5People(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  // C15 · C16 · C19 (OB-209: compute and show only): the statutory pay checks on the Payroll page.
  if (win['payrollData'] !== undefined) {
    win['payrollStatutory'] = { session: createPayrollStatutorySession({ viewer: viewerIdentity(win['payrollData']) }), words: payrollStatutoryWords, outcomeWords: payrollStatutoryOutcomeWords, rupees: statutoryRupees };
  }
  // OB-684 · C15 · C16 · C19: the separate "Payroll legal figures" page — the CA's legal figures alone, never anyone's pay.
  if (win['payrollLegalData'] !== undefined) {
    win['payrollLegal'] = { session: createPayrollLegalSession({ viewer: viewerIdentity(win['payrollLegalData']) }), words: payrollStatutoryWords, outcomeWords: payrollStatutoryOutcomeWords, rupees: statutoryRupees };
  }
  // C18 · OB-142: working-time limits, leave, the statutory registers, the roster check and publication, service standards
  // and labour cost — one tested session, each page drawing the sections it carries.
  for (const g of WORKING_TIME_PAGES) {
    if (win[g] !== undefined) {
      win['workingTime'] = {
        session: createWorkingTimeSession({ viewer: viewerIdentity(win[g]) }), words: workingTimeWords, outcomeWords: workingTimeOutcomeWords,
        limitKeys: WT_LIMIT_KEYS, leaveTypes: WT_LEAVE_TYPES, leaveKinds: WT_LEAVE_KINDS,
      };
      break;
    }
  }
  // C20 · OB-157: the committee's confidential complaints register, on the committee's own page.
  if (win['poshCommitteeData'] !== undefined) {
    win['poshRegister'] = { session: createPoshRegisterSession({ viewer: viewerIdentity(win['poshCommitteeData']) }), words: poshRegisterWords, outcomeWords: poshRegisterOutcomeWords, outcomes: POSH_STEP_OUTCOMES, moment: shopMomentOf };
  }
}
