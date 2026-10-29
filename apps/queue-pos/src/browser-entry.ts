// The queue till's browser entry (D04-FR-05 · OB-288 Pkg 6b) — the bundler's input (`node scripts/build-app.mjs queue-pos`).
//
// It boots the TILL'S OWN session (`apps/pos` `bootPos`) for this handheld's lane, from what the store computer served with
// the page over its device socket: the signed pack (prices, offers, bundles, tobacco, liquor, BIS and expiry gates), the
// lane (`device:<id>`), the shop's cut-off and switches. Every write goes back to that store computer, same origin, through
// the queue till's door (`/queue-pos/lane/…`) — never the phone's own loopback, never head office (hard rule #1).
//
// The person signs in on the box's own queue-till page (staff ID + till PIN, ADR-0020); the session is an HttpOnly cookie
// this page never sees. The model is told who they are only once the box has said so (`resumeAtTill`).

import { attachShopDay } from '../../../packages/calendar/src/shop-day'; // OB-607
import './serve-as-queue-till';
import { bootPos, serveLaneFrom } from '../../pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import type { PosLane, PosReceiptTemplate } from '../../pos/src/browser-entry';
import { createQueueSession, httpQueueBaskets, type QueueSession } from './queue-session';

/** The session placeholder the till's ports carry: the door uses the device's own cookie instead, never this. */
const COOKIE_SESSION = 'device-cookie';

export interface QueueWindow {
  posLane?: PosLane;
  posCatalogue?: CatalogueSnapshot;
  posReceiptTemplate?: PosReceiptTemplate;
  queuePos?: { readonly laneId: string; readonly boxLaneId: string | null; readonly payments: boolean; readonly signedIn?: { readonly userId: string; readonly displayName: string; readonly expiresAt: string } };
  queueSession?: QueueTillSession;
}

export type QueueTillSession = QueueSession<ReturnType<typeof bootPos>> & { readonly ready: Promise<boolean> };

/**
 * Boot the queue till for the page the store computer served. `base` is where its door answers — the same origin
 * (`/queue-pos`) on the handheld; a test driving the model from Node names the device socket in full.
 */
export function bootQueuePos(w: QueueWindow, options: { readonly base?: string } = {}): QueueTillSession {
  const base = options.base ?? '/queue-pos';
  serveLaneFrom(base);
  const lane = w.posLane;
  const till = bootPos({
    catalogue: w.posCatalogue,
    ...(lane?.laneId === undefined || lane.laneId === null || lane.laneId === '' ? {} : { laneId: lane.laneId }),
    ...(lane === undefined ? {} : { tradingDayCutoff: lane.tradingDayCutoff }),
    ...(Array.isArray(lane?.soldHuids) ? { soldHuids: lane.soldHuids } : {}),
    ...(lane?.guestSalesOnly?.on === true ? { guestSalesOnly: true } : {}),
    ...(lane?.mirrorPilot?.on === true ? { mirrorPilot: true } : {}),
    ...(lane?.realTrading?.on === true ? { realTrading: true, taxInvoice: lane.taxInvoice ?? null } : {}),
    ...(typeof lane?.billPaper === 'string' ? { billPaper: lane.billPaper } : {}),
    ...(lane?.fssaiLicence === undefined || lane.fssaiLicence === null ? {} : { fssaiLicence: lane.fssaiLicence }),
    ...(typeof lane?.shopState === 'string' && lane.shopState !== '' ? { shopState: lane.shopState } : {}),
    ...(w.posReceiptTemplate === undefined ? {} : { receiptTemplate: w.posReceiptTemplate }),
    // OB-521 (R8-A): the queue till judges its OWN build by the store computer's signed pack, like a fixed till (OB-501):
    // the basket on screen is finished; a new basket is not started on a withdrawn or too-old build.
    ...(lane?.appVersionPolicy === undefined ? {} : { appVersionPolicy: lane.appVersionPolicy }),
    clientKind: 'queue_till',
  });
  const session = createQueueSession(till, httpQueueBaskets(base), { payments: w.queuePos?.payments === true });
  // Ask the box whether the person it signed in on this handheld is still live, and name them in the model if so.
  const ready = till.resumeAtTill(COOKIE_SESSION);
  return Object.assign(session, { ready });
}

const browserWindow = (globalThis as { window?: QueueWindow }).window;
if (browserWindow !== undefined) browserWindow.queueSession = bootQueuePos(browserWindow);

// OB-607: this page's shop's day as `window.sreShopDay` — the dates AND times of day it shows are the shop's clock, in the
// zone the store computer served from its signed pack (`window.shopTimeZone`; no network call), never this device's.
attachShopDay((globalThis as { window?: unknown }).window);
