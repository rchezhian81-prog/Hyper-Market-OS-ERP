// The Today page's two head-office counts (screen gap audit, 31 Oct 2026, Round A · M02-FR-03 · M06 · P-01 · P-08).
//
// The audit found "Approvals waiting: 0" on Today while one waited in the Approvals page, and "Purchase orders open: 0"
// while head office held an open order. Both tiles read only the store computer's signed pack: its approvals are the three
// kinds the store computer relays (a held count, a stock correction, a delivery's held excess), never head office's
// maker-checker inbox where every other second-person approval waits (ADR-0024); and its orders are as of the last pack.
//
// So, when the page is open and head office can be reached, Today ALSO reads, in the signed-in person's own session:
//   • `GET /v1/approvals/requests` — what waits for THIS person to decide (head office scopes it to the kinds they may
//     approve, never their own request, never above their money limit);
//   • `GET /v1/purchase/orders` — the orders head office holds, which it shows only to someone who may read purchase
//     commitments (anyone else is refused, and Today says the role does not see them — never a zero).
// Offline (P-01) nothing changes: the store computer's own figures stay, and each tile says head office could not be
// reached, so its part is not counted. Pure apart from the one injected fetch; it writes nothing.

import type { Tally } from './manager-session';
import { waitingOrderCounts, type WaitingOrderViewer } from '../../../packages/purchasing/src/orders-waiting-to-issue';

/** One Today figure as the store computer sends it (`edge/store-edge/src/screen-data.ts` `TodayFigure`). */
export type TodayFigure =
  | { readonly known: true; readonly value: number; readonly unit?: 'inr'; readonly note?: string }
  | { readonly known: false; readonly why: string };

/** What one live read answered: the figure, head office's refusal (its status), or no connection. */
export type LiveRead<T> =
  | { readonly result: 'read'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number }
  | { readonly result: 'lost_link' };

export interface LiveCounts {
  readonly approvals: LiveRead<{ readonly waitingForMe: number; readonly routedToOwner: number }>;
  /** `awaitingApproval`: every order waiting for its second person; `forViewer` (D-010): those THIS person may issue. */
  readonly purchaseOrders: LiveRead<{ readonly open: number; readonly awaitingApproval: number; readonly forViewer?: number }>;
  /** D-009: the shifts head office's cash office has already signed off (`GET /v1/shifts/over-short`, reviewed rows). */
  readonly signedOffShifts?: LiveRead<readonly string[]>;
}

type Lang = 'en' | 'ta';
type WordKey = 'onBox' | 'atHeadOffice' | 'boxNotGiven' | 'hoUnreachable' | 'hoRefusedApprovals' | 'routedToOwner'
  | 'awaitingSecond' | 'fromHeadOffice' | 'poNotYourRole' | 'poRefused' | 'poAsLastHeard' | 'ordersToIssue';

/** Every word, with its Tamil twin. */
export const TODAY_LIVE_WORDS: Readonly<Record<Lang, Readonly<Record<WordKey, string>>>> = Object.freeze({
  en: {
    onBox: 'on this store computer', atHeadOffice: 'waiting for you at head office',
    boxNotGiven: 'the store computer\'s own list was not given',
    hoUnreachable: 'head office could not be reached, so its approvals are not counted',
    hoRefusedApprovals: 'head office would not show its approvals for your sign-in, so they are not counted',
    routedToOwner: 'above your limit, sent to the owner',
    awaitingSecond: 'waiting for a second person\'s approval', fromHeadOffice: 'from head office, just now',
    poNotYourRole: 'your role does not see purchase orders',
    poRefused: 'head office would not show its purchase orders for your sign-in',
    poAsLastHeard: 'head office could not be reached — as the store computer last heard',
    ordersToIssue: 'purchase order(s) waiting to be issued by a second person — open Approvals',
  },
  ta: {
    onBox: 'இந்தக் கடைக் கணினியில்', atHeadOffice: 'தலைமை அலுவலகத்தில் உங்களுக்காகக் காத்திருக்கின்றன',
    boxNotGiven: 'கடைக் கணினியின் சொந்தப் பட்டியல் கொடுக்கப்படவில்லை',
    hoUnreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே அதன் ஒப்புதல்கள் எண்ணப்படவில்லை',
    hoRefusedApprovals: 'உங்கள் உள்நுழைவுக்குத் தலைமை அலுவலகம் அதன் ஒப்புதல்களைக் காட்டவில்லை, எனவே அவை எண்ணப்படவில்லை',
    routedToOwner: 'உங்கள் வரம்புக்கு மேல், உரிமையாளருக்கு அனுப்பப்பட்டது',
    awaitingSecond: 'இரண்டாவது நபரின் ஒப்புதலுக்குக் காத்திருக்கின்றன', fromHeadOffice: 'தலைமை அலுவலகத்திலிருந்து, இப்போது',
    poNotYourRole: 'உங்கள் பங்கு கொள்முதல் ஆணைகளைப் பார்ப்பதில்லை',
    poRefused: 'உங்கள் உள்நுழைவுக்குத் தலைமை அலுவலகம் அதன் கொள்முதல் ஆணைகளைக் காட்டவில்லை',
    poAsLastHeard: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — கடைக் கணினி கடைசியாகக் கேட்டபடி',
    ordersToIssue: 'இரண்டாவது நபர் வழங்கக் காத்திருக்கும் கொள்முதல் ஆணை(கள்) — ஒப்புதல்கள் பக்கத்தைத் திறக்கவும்',
  },
});

const nonNegInt = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const qtyMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) for (const [k, n] of Object.entries(v as Record<string, unknown>)) out[k] = nonNegInt(n);
  return out;
};

/**
 * The orders still open, as head office's list hands them over: one waiting for its second person (proposed), or an
 * issued one with a line not yet fully received or cancelled. A received, cancelled or unreadable order is not open.
 */
export function openOrdersOf(orders: unknown): { readonly open: number; readonly awaitingApproval: number } {
  let open = 0; let awaitingApproval = 0;
  for (const raw of Array.isArray(orders) ? orders : []) {
    if (raw === null || typeof raw !== 'object') continue;
    const po = raw as Record<string, unknown>;
    if (po['status'] === 'proposed') { open += 1; awaitingApproval += 1; continue; }
    if (po['status'] !== 'issued') continue;
    const received = qtyMap(po['receivedByProduct']);
    const cancelled = qtyMap(po['cancelledByProduct']);
    const ordered: Record<string, number> = {};
    for (const line of Array.isArray(po['lines']) ? po['lines'] as unknown[] : []) {
      if (line === null || typeof line !== 'object') continue;
      const l = line as Record<string, unknown>;
      if (typeof l['productId'] === 'string') ordered[l['productId']] = (ordered[l['productId']] ?? 0) + nonNegInt(l['orderedQty']);
    }
    if (Object.entries(ordered).some(([p, q]) => q > (received[p] ?? 0) + (cancelled[p] ?? 0))) open += 1;
  }
  return { open, awaitingApproval };
}

/**
 * Read both counts from head office in the caller's own session (GETs — read only). `viewer` (D-010): who is looking and
 * what they hold, so the orders THEY may issue are counted as theirs to clear; absent, none is (never assumed).
 */
export async function readLiveCounts(fetchFn: typeof fetch | undefined, viewer?: WaitingOrderViewer): Promise<LiveCounts> {
  const get = async <T>(path: string, shape: (body: Record<string, unknown>) => T): Promise<LiveRead<T>> => {
    if (fetchFn === undefined) return { result: 'lost_link' };
    try {
      const res = await fetchFn(path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
      // Only a sign-in head office would not serve (401 / 403) is a refusal; any other failure (no head office on this
      // origin, a fault, a timeout) means head office was not reached, and the store computer's figures stand.
      if (res.status === 401 || res.status === 403) return { result: 'refused', status: res.status };
      if (res.status >= 400) return { result: 'lost_link' };
      const body = (await res.json()) as unknown;
      return { result: 'read', value: shape(body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}) };
    } catch {
      return { result: 'lost_link' };
    }
  };
  const [approvals, purchaseOrders, signedOffShifts] = await Promise.all([
    get('/v1/approvals/requests', (b) => ({ waitingForMe: Array.isArray(b['waitingForMe']) ? b['waitingForMe'].length : 0, routedToOwner: nonNegInt(b['routedToOwnerAboveYourLimit']) })),
    get('/v1/purchase/orders', (b) => ({ ...openOrdersOf(b['orders']), forViewer: viewer === undefined ? 0 : waitingOrderCounts(b, viewer).forViewer })),
    get('/v1/shifts/over-short', (b) => signedOffShiftsOf(b['overShort'])),
  ]);
  return { approvals, purchaseOrders, signedOffShifts };
}

/** D-009: the shifts head office's over/short list says are signed off (reviewed), from its body as it hands it over. */
export function signedOffShiftsOf(rows: unknown): readonly string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (r['reviewed'] === true && typeof r['shiftId'] === 'string') out.push(r['shiftId']);
  }
  return out;
}

/** The store computer's "closed over or short today" figure as it sends it (`TodayFigure` with its `drawers`, D-009). */
export type OverShortTodayFigure =
  | { readonly known: true; readonly value: number; readonly note?: string; readonly noteTa?: string; readonly drawers?: readonly { readonly shiftId: string; readonly words: string; readonly wordsTa: string }[] }
  | { readonly known: false; readonly why: string; readonly whyTa?: string };

const OVER_SHORT_TAIL = {
  en: ' — closed today on this store computer; signing off is on the Cash over/short page',
  ta: ' — இன்று இந்தக் கடைக் கணினியில் மூடப்பட்டது; கையொப்பம் கூடுதல்/குறைவு பக்கத்தில்',
} as const;

/**
 * D-009: Today's "drawer(s) closed over or short today" leaves out every drawer head office says is already signed off on
 * Cash over/short. When head office could not be read (or refused), or the store computer did not list its drawers, the
 * store computer's own figure stands unchanged — a drawer is never dropped on a guess (P-08). Pure.
 */
export function overShortStillOpen(box: OverShortTodayFigure, live: LiveCounts | null): OverShortTodayFigure {
  if (!box.known || box.drawers === undefined || live === null || live.signedOffShifts?.result !== 'read') return box;
  const signed = new Set(live.signedOffShifts.value);
  const open = box.drawers.filter((d) => !signed.has(d.shiftId));
  if (open.length === box.drawers.length) return box;
  return {
    known: true, value: open.length, drawers: open,
    ...(open.length === 0 ? {} : {
      note: `${open.map((d) => d.words).join('; ')}${OVER_SHORT_TAIL.en}`,
      noteTa: `${open.map((d) => d.wordsTa).join('; ')}${OVER_SHORT_TAIL.ta}`,
    }),
  };
}

/** The figures Today shows once head office answered (or did not): each tile's number and its plain note. */
export interface TodayLiveFigures {
  /** Everything waiting: the store computer's own plus what waits for this person at head office. */
  readonly approvalsWaiting: Tally & { readonly note?: string };
  /** What this person can clear: the store computer's clearable plus head office's (all of which are theirs to decide). */
  readonly approvalsIcanClear: Tally;
  /** What waits for this person at head office alone — decided on the Approvals page. Null when head office did not answer. */
  readonly headOffice: Tally | null;
  readonly purchaseOrdersOpen: TodayFigure;
}

/** Combine the store computer's figures with what head office answered, in the reader's language. Pure. */
export function todayLiveFigures(
  box: { readonly approvalsWaiting: Tally; readonly approvalsIcanClear: Tally; readonly purchaseOrdersOpen: TodayFigure },
  live: LiveCounts,
  lang: Lang,
): TodayLiveFigures {
  const w = TODAY_LIVE_WORDS[lang];
  const boxPo = box.purchaseOrdersOpen;
  let approvalsWaiting: TodayLiveFigures['approvalsWaiting'];
  let approvalsIcanClear: Tally = box.approvalsIcanClear;
  let headOffice: Tally | null = null;
  // D-010: an order waiting for its second person IS an approval waiting — counted here, and as this person's to clear
  // when they may issue it (one they did not raise). Unread orders add nothing (the purchase-orders tile says why).
  const orders = live.purchaseOrders.result === 'read' ? live.purchaseOrders.value : null;
  const ordersWaiting = orders?.awaitingApproval ?? 0;
  const ordersForMe = orders?.forViewer ?? 0;
  const ordersTail = ordersWaiting > 0 ? ` · ${ordersWaiting} ${w.ordersToIssue}` : '';
  if (live.approvals.result === 'read') {
    const n = live.approvals.value.waitingForMe;
    const routed = live.approvals.value.routedToOwner;
    const tail = `${n} ${w.atHeadOffice}${routed > 0 ? ` · ${routed} ${w.routedToOwner}` : ''}${ordersTail}`;
    headOffice = { known: true, count: n + ordersForMe };
    approvalsWaiting = box.approvalsWaiting.known
      ? { known: true, count: box.approvalsWaiting.count + n + ordersWaiting, note: `${box.approvalsWaiting.count} ${w.onBox} · ${tail}` }
      : { known: true, count: n + ordersWaiting, note: `${tail} · ${w.boxNotGiven}` };
    approvalsIcanClear = box.approvalsIcanClear.known ? { known: true, count: box.approvalsIcanClear.count + n + ordersForMe } : { known: true, count: n + ordersForMe };
  } else {
    const why = live.approvals.result === 'lost_link' ? w.hoUnreachable : w.hoRefusedApprovals;
    approvalsWaiting = box.approvalsWaiting.known
      ? { known: true, count: box.approvalsWaiting.count + ordersWaiting, note: `${box.approvalsWaiting.count} ${w.onBox} · ${why}${ordersTail}` }
      : box.approvalsWaiting;
    if (ordersForMe > 0) {
      headOffice = { known: true, count: ordersForMe };
      if (box.approvalsIcanClear.known) approvalsIcanClear = { known: true, count: box.approvalsIcanClear.count + ordersForMe };
    }
  }
  let purchaseOrdersOpen: TodayFigure;
  if (live.purchaseOrders.result === 'read') {
    const { open, awaitingApproval } = live.purchaseOrders.value;
    purchaseOrdersOpen = { known: true, value: open, note: `${awaitingApproval > 0 ? `${awaitingApproval} ${w.awaitingSecond} · ` : ''}${w.fromHeadOffice}` };
  } else if (live.purchaseOrders.result === 'refused') {
    purchaseOrdersOpen = { known: false, why: live.purchaseOrders.status === 403 ? w.poNotYourRole : w.poRefused };
  } else {
    purchaseOrdersOpen = boxPo.known ? { ...boxPo, note: `${boxPo.note === undefined ? '' : `${boxPo.note} · `}${w.poAsLastHeard}` } : boxPo;
  }
  return { approvalsWaiting, approvalsIcanClear, headOffice, purchaseOrdersOpen };
}
