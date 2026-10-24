// The browser wiring for the loss-prevention, workforce, facilities and adoption pages (OB-288 LP/workforce package).
// Kept in its own file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each page's tested
// session is attached to `window` under the name its page script reads, from the data the store computer (or head office)
// injected for it. Nothing is read or written here: every call is a person's click on the page (or, for a box queue, a
// pass of the device → store-computer relay over what a person saved).

import { openDeviceOutbox, guardedStore } from '../../../packages/sync/src/device-outbox';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { createLpSignalsSession, lpSignalsWords, rupees as lpRupees, percent as lpPercent, sourceWords, policyWords } from './lp-signals-session';
import { createRelatedPartiesSession, relatedPartiesWords, relatedPartiesOutcomeWords } from './related-parties-session';
import { createAdoptionSession, adoptionWords, adoptionOutcomeWords, rupees as adoptionRupees, hoursOf } from './adoption-session';
import { createHelpSession, helpWords, helpOutcomeWords, type HelpData } from './help-session';
import { createAppointmentLettersSession, lettersWords, lettersOutcomeWords } from './appointment-letters-session';
import { createFacilitiesOfficeSession, createEquipmentReadingQueue, facilitiesOfficeWords, facilitiesOfficeOutcomeWords, degrees, type HeldEquipment } from './facilities-office-session';
import { createWriteOffQueue, createWriteOffDecideSession, writeOffQueueWords, writeOffQueueOutcomeWords } from './write-off-queue-session';
import { createRelabelSession, relabelWords, relabelOutcomeWords } from './relabel-session';
import { openBoxQueueRelay } from './lpw-box-queue';

type DeviceStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void };
type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };
type Win = Record<string, unknown> & { laneWriteBase?: string };

/** One durable device queue per page and store, in this browser's own storage (a storage problem is kept, visible). */
export function openLpwOutbox(page: string, storeId: string, storage?: DeviceStorage, onProblem: (why: string) => void = () => undefined): SyncOutbox {
  const store = storage ?? (globalThis as { localStorage?: DeviceStorage }).localStorage;
  return openDeviceOutbox(guardedStore(`sre.${page}.outbox.${storeId}`, store, onProblem), onProblem);
}

const rec = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

export function wireLpWorkforcePages(win: Win, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  const problem = (why: string): void => { win['lpwStorageProblem'] = why; };
  const now = (): string => new Date().toISOString();

  // Investigations — "From the shop's own records" (M15-FR-02/03).
  if (win['lossPreventionInboxData'] !== undefined) {
    win['lpSignals'] = { session: createLpSignalsSession({ viewer: viewerIdentity(win['lossPreventionInboxData']) }), words: lpSignalsWords, rupees: lpRupees, percent: lpPercent, sourceWords, policyWords };
  }
  // Related parties and staff buying (M15-FR-03 · OB-301).
  if (win['relatedPartiesData'] !== undefined) {
    win['relatedParties'] = { session: createRelatedPartiesSession({ viewer: viewerIdentity(win['relatedPartiesData']) }), words: relatedPartiesWords, outcomeWords: relatedPartiesOutcomeWords };
  }
  // Training and adoption (QG-09 · M25-FR-01/03 · D11-FR-04 · OB-317 · OB-320).
  if (win['adoptionData'] !== undefined) {
    win['adoption'] = { session: createAdoptionSession({ viewer: viewerIdentity(win['adoptionData']) }), words: adoptionWords, outcomeWords: adoptionOutcomeWords, rupees: adoptionRupees, hoursOf };
  }
  // Help and procedures (M25-FR-04 · D11-FR-06): offline on the store computer, live at head office.
  const helpData = rec(win['helpData']);
  if (helpData !== undefined) {
    const viewer = viewerIdentity(helpData);
    const storeId = str(helpData['storeId']);
    const onBox = win.laneWriteBase !== undefined && 'library' in helpData && storeId !== undefined;
    const outbox = onBox ? openLpwOutbox('help', storeId!, undefined, problem) : undefined;
    const data: HelpData = { ...(viewer?.userId === undefined ? {} : { userId: viewer.userId }), permissions: viewer?.permissions ?? [], ...(storeId === undefined ? {} : { storeId }), ...('library' in helpData ? { library: helpData['library'] as HelpData['library'] } : {}) };
    const session = createHelpSession({ data, onBox, ...(outbox === undefined ? {} : { outbox }) });
    const relay = session.queue !== undefined && outbox !== undefined ? openBoxQueueRelay(win.laneWriteBase, session.queue, outbox) : undefined;
    win['help'] = { session, words: helpWords, outcomeWords: helpOutcomeWords, ...(relay === undefined ? {} : { relay }) };
  }
  // Appointment letters (C17 · OB-323).
  if (win['appointmentLettersData'] !== undefined) {
    win['appointmentLetters'] = { session: createAppointmentLettersSession({ viewer: viewerIdentity(win['appointmentLettersData']) }), words: lettersWords, outcomeWords: lettersOutcomeWords };
  }
  // Facilities — the office read (M26-FR-01/02/04) and the manual readings through the store computer (M26-FR-02).
  const fac = rec(win['facilitiesData']);
  if (fac !== undefined) {
    const viewer = viewerIdentity(fac);
    const storeId = str(fac['storeId']);
    win['facilitiesOffice'] = { session: createFacilitiesOfficeSession({ viewer }), words: facilitiesOfficeWords, outcomeWords: facilitiesOfficeOutcomeWords, rupees: lpRupees, degrees, ...(storeId === undefined ? {} : { storeId }) };
    if (win.laneWriteBase !== undefined && storeId !== undefined && 'equipment' in fac) {
      const outbox = openLpwOutbox('facilities-readings', storeId, undefined, problem);
      const q = createEquipmentReadingQueue({ userId: viewer?.userId ?? null, storeId, permissions: viewer?.permissions ?? [], now }, (fac['equipment'] ?? null) as HeldEquipment | null, outbox);
      win['equipmentReadingQueue'] = q;
      const relay = openBoxQueueRelay(win.laneWriteBase, q.queue, outbox);
      if (relay !== undefined) win['equipmentReadingRelay'] = relay;
    }
  }
  // Write-off capture — a loss saved with the line down (M28-FR-01), and the captures waiting for a second person.
  const wo = rec(win['writeOffCaptureData']);
  if (wo !== undefined) {
    const viewer = viewerIdentity({ permissions: [], ...wo });
    const storeId = str(wo['storeId']);
    win['writeOffDecide'] = { session: createWriteOffDecideSession({ viewer }), words: writeOffQueueWords, outcomeWords: writeOffQueueOutcomeWords };
    if (win.laneWriteBase !== undefined && storeId !== undefined) {
      const outbox = openLpwOutbox('write-off-captures', storeId, undefined, problem);
      const q = createWriteOffQueue({ userId: viewer?.userId ?? null, storeId, permissions: viewer?.permissions ?? [], now }, outbox);
      win['writeOffQueue'] = q;
      const relay = openBoxQueueRelay(win.laneWriteBase, q.queue, outbox);
      if (relay !== undefined) win['writeOffQueueRelay'] = relay;
    }
  }
  // Store tasks — the relabel tasks a price change raises (D11-FR-03).
  if (win['storeOpsData'] !== undefined) {
    win['relabel'] = { session: createRelabelSession({ viewer: viewerIdentity(win['storeOpsData']) }), words: relabelWords, outcomeWords: relabelOutcomeWords };
  }
}
