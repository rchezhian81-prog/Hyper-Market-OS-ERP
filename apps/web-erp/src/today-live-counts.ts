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
  readonly purchaseOrders: LiveRead<{ readonly open: number; readonly awaitingApproval: number }>;
}

type Lang = 'en' | 'ta';
type WordKey = 'onBox' | 'atHeadOffice' | 'boxNotGiven' | 'hoUnreachable' | 'hoRefusedApprovals' | 'routedToOwner'
  | 'awaitingSecond' | 'fromHeadOffice' | 'poNotYourRole' | 'poRefused' | 'poAsLastHeard';

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

/** Read both counts from head office in the caller's own session (two GETs — read only). */
export async function readLiveCounts(fetchFn: typeof fetch | undefined): Promise<LiveCounts> {
  const get = async <T>(path: string, shape: (body: Record<string, unknown>) => T): Promise<LiveRead<T>> => {
    if (fetchFn === undefined) return { result: 'lost_link' };
    try {
      const res = await fetchFn(path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (res.status >= 400) return { result: 'refused', status: res.status };
      const body = (await res.json()) as unknown;
      return { result: 'read', value: shape(body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}) };
    } catch {
      return { result: 'lost_link' };
    }
  };
  const [approvals, purchaseOrders] = await Promise.all([
    get('/v1/approvals/requests', (b) => ({ waitingForMe: Array.isArray(b['waitingForMe']) ? b['waitingForMe'].length : 0, routedToOwner: nonNegInt(b['routedToOwnerAboveYourLimit']) })),
    get('/v1/purchase/orders', (b) => openOrdersOf(b['orders'])),
  ]);
  return { approvals, purchaseOrders };
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
  if (live.approvals.result === 'read') {
    const n = live.approvals.value.waitingForMe;
    const routed = live.approvals.value.routedToOwner;
    const tail = `${n} ${w.atHeadOffice}${routed > 0 ? ` · ${routed} ${w.routedToOwner}` : ''}`;
    headOffice = { known: true, count: n };
    approvalsWaiting = box.approvalsWaiting.known
      ? { known: true, count: box.approvalsWaiting.count + n, note: `${box.approvalsWaiting.count} ${w.onBox} · ${tail}` }
      : { known: true, count: n, note: `${tail} · ${w.boxNotGiven}` };
    approvalsIcanClear = box.approvalsIcanClear.known ? { known: true, count: box.approvalsIcanClear.count + n } : { known: true, count: n };
  } else {
    const why = live.approvals.result === 'lost_link' ? w.hoUnreachable : w.hoRefusedApprovals;
    approvalsWaiting = box.approvalsWaiting.known ? { known: true, count: box.approvalsWaiting.count, note: `${box.approvalsWaiting.count} ${w.onBox} · ${why}` } : box.approvalsWaiting;
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
