// The Transfers page (WF-07 · M09-FR-03 · M08-FR-02/03 · §28 · P-08 · hard rules #2 #10) — the session model behind the
// dispatch-and-receipt screen. A THIN client over head office's transfer routes (services/inventory/src/warehouse-transfers.ts):
//   • the register (`GET /v1/warehouse/transfers`) — every transfer with either end in the reader's branches, its state,
//     head office's own cost per line, and an open receipt shortfall valued at the cost the stock left with;
//   • DISPATCH (`POST …/dispatch`, an EMPTY body) — the dispatcher is the approver and must not be the proposer; the stock
//     is head office's own at the source (recalled / held / expired stock and an over-draw are refused there);
//   • RECEIVE (`POST …/receive`) — what the destination COUNTED, line by line; a shortfall is a valued exception, never a
//     quiet adjustment; the dispatcher cannot count it in;
//   • RESOLVE the shortfall (`POST …/shortfall/resolution`) — what turned up (where) and why the rest is gone, by a person
//     who neither dispatched nor counted it; a floor-indent transfer is resolved on its indent.
// No cost, approver or stock figure is ever typed on this screen: cost is head office's (server side). DOM-free and tested.

import type { HeadOfficeHttp, HttpAnswer } from './head-office-http';
import { rupees } from './head-office-http';

export type Lang = 'en' | 'ta';
export interface TransferViewer { readonly userId?: string; readonly permissions: readonly string[] }

export interface TransferLineRecord { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number; readonly uom: string; readonly unitCost?: { readonly minor: number } }
export interface TransferRecord {
  readonly transferId: string; readonly fromLocationId: string; readonly toLocationId: string;
  readonly lines: readonly TransferLineRecord[];
  readonly state: 'proposed' | 'in_transit' | 'received' | string;
  readonly requestedBy: string; readonly approvedBy?: string; readonly receivedBy?: string;
  readonly dispatchedAt?: string; readonly receivedAt?: string;
  /** OB-288 lane 2 · WF-07: a transfer withdrawn before it left — by whom, when and why (a compensating event). */
  readonly cancelledBy?: string; readonly cancelledAt?: string; readonly cancelReason?: string;
  readonly lineCostsMinor?: readonly (number | null)[];
  readonly shortfallResolution?: { readonly resolvedBy: string; readonly reasonCode: string; readonly note: string; readonly lines: readonly { readonly productId: string; readonly missingMinor: number; readonly foundMinor: number; readonly lostMinor: number; readonly lostValueMinor: number }[] };
}
export interface ShortfallLineRecord { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number; readonly valueMinor: number }
export interface TransferRow { readonly transfer: TransferRecord; readonly shortfall: readonly ShortfallLineRecord[]; readonly shortfallOpen: boolean; readonly forIndent: boolean }

export type Refused = { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string };
export type Outcome<T> = ({ readonly result: 'ok' } & T) | Refused | { readonly result: 'lost_link' } | { readonly result: 'invalid'; readonly key: string };

export const RESOLUTION_REASONS = Object.freeze(['damaged', 'expired', 'miscount', 'found', 'theft_suspected', 'other'] as const);

const WORDS: Readonly<Record<Lang, Readonly<Record<string, string>>>> = Object.freeze({
  en: {
    title: 'Transfers', lede: 'Send an approved transfer, count it in at the other end, and settle anything that did not arrive. Head office values the stock at its own cost — nothing is priced here.',
    registerH: 'Transfers', registerLede: 'Newest first: waiting to be sent, on the road, and received. A shortfall stays open until a person settles it.', empty: 'No transfers yet.',
    proposed: 'Waiting to be sent', in_transit: 'On the road — not sellable yet', received: 'Received', shortOpen: 'Shortfall open', shortSettled: 'Shortfall settled', onIndent: 'Floor indent — settled on the indent',
    from: 'from', to: 'to', proposedBy: 'proposed by', sentBy: 'sent and approved by', countedBy: 'counted in by', costEach: 'head office cost', costUnknown: 'head office holds no cost',
    dispatch: 'Send it (I approve this transfer)', dispatchNote: 'You approve it by sending it; the person who proposed it cannot.',
    receiveH: 'Count it in', receiveNote: 'Write what actually arrived. Anything missing becomes a valued shortfall.', receive: 'Record what arrived', sent: 'sent',
    resolveH: 'Settle the shortfall', resolveNote: 'Say what turned up and where, and why the rest is gone. You must be neither the sender nor the counter.', resolve: 'Settle it',
    missing: 'missing', worth: 'worth', foundQty: 'Turned up', foundAt: 'Found at', destination: 'the receiving place', source: 'the sending place', reasonCode: 'Why the rest is gone', note: 'What was done to look for it',
    damaged: 'Damaged', expired: 'Expired', miscount: 'Miscount', found: 'Found', theft_suspected: 'Theft suspected', other: 'Other',
    lost: 'lost', settledBy: 'settled by',
    saved: 'Done — head office recorded it.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing is known to have changed.',
    needCounts: 'Write each arrived quantity as a whole number (0 if none arrived).', needResolution: 'Choose why, write what was done (a few words), and whole numbers for what turned up.',
    colTransfer: 'Transfer', colRoute: 'From → to', colLines: 'Lines', colState: 'Where it stands', view: 'Look at it', close: 'Close', linesH: 'Lines', shortH: 'Shortfall', arrived: 'Arrived',
    cannotRead: 'Your role cannot read transfers.', nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', reading: 'Reading from head office…',
    cancelled: 'Cancelled before it left — nothing moved', cancelH: 'Cancel it', cancelNote: 'Only before it leaves. The proposal stays on the record with your name and reason; nothing moves.',
    cancelReason: 'Why it is being cancelled', cancel: 'Cancel this transfer', needCancelReason: 'Say why it is being cancelled (a few words).', cancelledBy: 'cancelled by',
  },
  ta: {
    title: 'இடமாற்றங்கள்', lede: 'ஒப்புதலான இடமாற்றத்தை அனுப்புங்கள், மறுமுனையில் எண்ணி வரவு வையுங்கள், வராதவற்றைத் தீர்த்து வையுங்கள். தலைமை அலுவலகம் தன் சொந்த விலையில் சரக்கை மதிப்பிடும் — இங்கே விலை எதுவும் உள்ளிடப்படாது.',
    registerH: 'இடமாற்றங்கள்', registerLede: 'புதியவை முதலில்: அனுப்பக் காத்திருப்பவை, வழியில் உள்ளவை, வந்தவை. குறைபாடு ஒருவர் தீர்க்கும் வரை திறந்திருக்கும்.', empty: 'இன்னும் இடமாற்றங்கள் இல்லை.',
    proposed: 'அனுப்பக் காத்திருக்கிறது', in_transit: 'வழியில் — இன்னும் விற்க முடியாது', received: 'வந்து சேர்ந்தது', shortOpen: 'குறைபாடு திறந்துள்ளது', shortSettled: 'குறைபாடு தீர்க்கப்பட்டது', onIndent: 'தளக் கோரிக்கை — கோரிக்கையிலேயே தீர்க்கப்படும்',
    from: 'இருந்து', to: 'க்கு', proposedBy: 'முன்மொழிந்தவர்', sentBy: 'அனுப்பி ஒப்புதல் தந்தவர்', countedBy: 'எண்ணி வரவு வைத்தவர்', costEach: 'தலைமை அலுவலக விலை', costUnknown: 'தலைமை அலுவலகத்திடம் விலை இல்லை',
    dispatch: 'அனுப்பு (இந்த இடமாற்றத்துக்கு நான் ஒப்புதல் தருகிறேன்)', dispatchNote: 'அனுப்புவதன் மூலம் நீங்கள் ஒப்புதல் தருகிறீர்கள்; முன்மொழிந்தவர் தர முடியாது.',
    receiveH: 'எண்ணி வரவு வை', receiveNote: 'உண்மையில் வந்ததை எழுதுங்கள். காணாதவை மதிப்பிடப்பட்ட குறைபாடாகும்.', receive: 'வந்ததைப் பதிவு செய்', sent: 'அனுப்பியது',
    resolveH: 'குறைபாட்டைத் தீர்', resolveNote: 'என்ன கிடைத்தது, எங்கே, மீதி ஏன் போனது என்று சொல்லுங்கள். நீங்கள் அனுப்பியவரோ எண்ணியவரோ ஆக இருக்கக்கூடாது.', resolve: 'தீர்த்து வை',
    missing: 'காணவில்லை', worth: 'மதிப்பு', foundQty: 'கிடைத்தது', foundAt: 'கிடைத்த இடம்', destination: 'பெறும் இடம்', source: 'அனுப்பும் இடம்', reasonCode: 'மீதி ஏன் போனது', note: 'தேட என்ன செய்யப்பட்டது',
    damaged: 'சேதம்', expired: 'காலாவதி', miscount: 'தவறான எண்ணிக்கை', found: 'கண்டுபிடிக்கப்பட்டது', theft_suspected: 'திருட்டு சந்தேகம்', other: 'மற்றவை',
    lost: 'இழப்பு', settledBy: 'தீர்த்தவர்',
    saved: 'முடிந்தது — தலைமை அலுவலகம் பதிவு செய்தது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாறியதாகத் தெரியவில்லை.',
    needCounts: 'வந்த ஒவ்வொரு அளவையும் முழு எண்ணாக எழுதுங்கள் (எதுவும் வரவில்லையெனில் 0).', needResolution: 'காரணத்தைத் தேர்ந்தெடுங்கள், என்ன செய்யப்பட்டது என்று எழுதுங்கள், கிடைத்தவற்றை முழு எண்ணாக எழுதுங்கள்.',
    colTransfer: 'இடமாற்றம்', colRoute: 'எங்கிருந்து → எங்கே', colLines: 'வரிகள்', colState: 'நிலை', view: 'பார்', close: 'மூடு', linesH: 'வரிகள்', shortH: 'குறைபாடு', arrived: 'வந்தது',
    cannotRead: 'உங்கள் பங்கால் இடமாற்றங்களைப் படிக்க முடியாது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    cancelled: 'புறப்படும் முன் ரத்து செய்யப்பட்டது — எதுவும் நகரவில்லை', cancelH: 'ரத்து செய்', cancelNote: 'புறப்படும் முன் மட்டும். முன்மொழிவு உங்கள் பெயர் மற்றும் காரணத்துடன் பதிவில் இருக்கும்; எதுவும் நகராது.',
    cancelReason: 'ஏன் ரத்து செய்யப்படுகிறது', cancel: 'இந்த இடமாற்றத்தை ரத்து செய்', needCancelReason: 'ஏன் ரத்து செய்யப்படுகிறது என்று சொல்லுங்கள் (சில வார்த்தைகள்).', cancelledBy: 'ரத்து செய்தவர்',
  },
});

export const TRANSFER_WORD_KEYS: readonly string[] = Object.freeze(Object.keys(WORDS.en));
export const text = (lang: Lang, key: string): string => WORDS[lang][key] ?? WORDS.en[key] ?? key;

/** A transfer as the register shows it: state in words, each line with head office's own cost, the shortfall valued. */
export function rowView(lang: Lang, row: TransferRow) {
  const t = row.transfer;
  const lines = t.lines.map((l, i) => {
    // Dispatched: the cost the stock left with (null = unvalued). Proposed: head office's cost at proposal, where 0 means
    // "held no cost" (the route names those lines `costUnknown`) — never shown as ₹0.00.
    const atProposal = l.unitCost?.minor ?? 0;
    const cost = t.lineCostsMinor === undefined ? (atProposal === 0 ? null : atProposal) : (t.lineCostsMinor[i] ?? null);
    return { productId: l.productId, batchId: l.batchId, quantityMinor: l.quantityMinor, uom: l.uom, cost: cost === null ? null : rupees(cost) };
  });
  const flags: string[] = [];
  if (row.forIndent) flags.push(text(lang, 'onIndent'));
  else if (row.shortfallOpen) flags.push(text(lang, 'shortOpen'));
  else if (t.shortfallResolution !== undefined) flags.push(text(lang, 'shortSettled'));
  return {
    transferId: t.transferId, state: t.state, stateWord: text(lang, t.state), flags,
    tone: row.shortfallOpen ? 'error' : t.state === 'received' ? 'ok' : t.state === 'in_transit' ? 'degraded' : 'idle',
    route: `${text(lang, 'from')} ${t.fromLocationId} → ${text(lang, 'to')} ${t.toLocationId}`,
    people: [
      `${text(lang, 'proposedBy')} ${t.requestedBy}`,
      ...(t.approvedBy === undefined ? [] : [`${text(lang, 'sentBy')} ${t.approvedBy}`]),
      ...(t.receivedBy === undefined ? [] : [`${text(lang, 'countedBy')} ${t.receivedBy}`]),
      ...(t.shortfallResolution === undefined ? [] : [`${text(lang, 'settledBy')} ${t.shortfallResolution.resolvedBy} (${text(lang, t.shortfallResolution.reasonCode)})`]),
      ...(t.cancelledBy === undefined ? [] : [`${text(lang, 'cancelledBy')} ${t.cancelledBy}${t.cancelReason === undefined ? '' : ` — "${t.cancelReason}"`}`]),
    ],
    lines,
    shortfall: row.shortfall.map((s) => ({ ...s, worth: rupees(s.valueMinor) })),
    canDispatch: t.state === 'proposed', canReceive: t.state === 'in_transit',
    // WF-07: only before it leaves, and never a floor-indent transfer (that is withdrawn on its indent).
    canCancel: t.state === 'proposed' && !row.forIndent,
    canResolve: t.state === 'received' && row.shortfallOpen && !row.forIndent,
  };
}

const enc = encodeURIComponent;
const refusedOrLost = (a: HttpAnswer): Refused | { readonly result: 'lost_link' } => (a.result === 'lost_link' ? a : { result: 'refused', status: a.status, code: a.result === 'refused' ? a.code : 'unreadable_answer', whatHappened: a.result === 'refused' ? a.whatHappened : '' });
const whole = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

export function createTransfersSession(viewer: TransferViewer | undefined, http: HeadOfficeHttp) {
  const perms = new Set(viewer?.permissions ?? []);
  const nobody = viewer === undefined;
  const may = { read: perms.has('inventory.availability.read'), move: perms.has('inventory.movement.append'), resolve: perms.has('inventory.adjustment.approve') };
  const post = async (path: string, body: unknown): Promise<Outcome<{ readonly body: unknown }>> => {
    if (nobody) return { result: 'invalid', key: 'nobody' };
    const a = await http.post(path, body);
    return a.result === 'ok' ? { result: 'ok', body: a.body } : refusedOrLost(a);
  };
  return {
    nobody, userId: viewer?.userId ?? null, may, text, rowView, rupees,
    async list(): Promise<Outcome<{ readonly rows: readonly TransferRow[] }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      const a = await http.get('/v1/warehouse/transfers');
      if (a.result !== 'ok') return refusedOrLost(a);
      const rows = (a.body as { transfers?: unknown }).transfers;
      return { result: 'ok', rows: Array.isArray(rows) ? (rows as TransferRow[]) : [] };
    },
    /** Send it: an EMPTY body — the approver is the signed-in person and the stock is head office's. */
    dispatch: (transferId: string) => post(`/v1/warehouse/transfers/${enc(transferId)}/dispatch`, {}),
    /** WF-07: withdraw it before it leaves, with a reason a person can read later (head office refuses it after dispatch). */
    async cancel(transferId: string, reason: string): Promise<Outcome<{ readonly body: unknown }>> {
      if (reason.trim().length < 4) return { result: 'invalid', key: 'needCancelReason' };
      return post(`/v1/warehouse/transfers/${enc(transferId)}/cancel`, { reason: reason.trim() });
    },
    /** What arrived, per line (index-aligned with the transfer's lines). */
    async receive(transfer: TransferRecord, arrivedText: readonly string[]): Promise<Outcome<{ readonly body: unknown }>> {
      const counted: { productId: string; batchId: string | null; quantityMinor: number }[] = [];
      for (const [i, l] of transfer.lines.entries()) {
        const q = whole(arrivedText[i] ?? '');
        if (q === undefined) return { result: 'invalid', key: 'needCounts' };
        counted.push({ productId: l.productId, batchId: l.batchId, quantityMinor: q });
      }
      return post(`/v1/warehouse/transfers/${enc(transfer.transferId)}/receive`, { counted });
    },
    /** Settle the shortfall: per shortfall line what turned up (and where), plus why and what was done. */
    async resolve(row: TransferRow, input: { readonly reasonCode: string; readonly note: string; readonly found: readonly { readonly text: string; readonly at: 'destination' | 'source' }[] }): Promise<Outcome<{ readonly body: unknown }>> {
      if (!(RESOLUTION_REASONS as readonly string[]).includes(input.reasonCode) || input.note.trim().length < 4) return { result: 'invalid', key: 'needResolution' };
      const lines: { productId: string; batchId: string | null; foundMinor: number; foundAtLocationId?: string }[] = [];
      for (const [i, s] of row.shortfall.entries()) {
        const f = input.found[i];
        const q = whole(f?.text === undefined || f.text.trim() === '' ? '0' : f.text);
        if (q === undefined) return { result: 'invalid', key: 'needResolution' };
        if (q > 0) lines.push({ productId: s.productId, batchId: s.batchId, foundMinor: q, ...(f?.at === 'source' ? { foundAtLocationId: row.transfer.fromLocationId } : {}) });
      }
      return post(`/v1/warehouse/transfers/${enc(row.transfer.transferId)}/shortfall/resolution`, { reasonCode: input.reasonCode, note: input.note.trim(), lines });
    },
    say(lang: Lang, out: Outcome<unknown>, good = 'saved'): { readonly tone: 'good' | 'err'; readonly words: string } {
      if (out.result === 'ok') return { tone: 'good', words: text(lang, good) };
      if (out.result === 'lost_link') return { tone: 'err', words: text(lang, 'unreachable') };
      if (out.result === 'invalid') return { tone: 'err', words: text(lang, out.key) };
      return { tone: 'err', words: `${text(lang, 'refused')} ${out.whatHappened === '' ? out.code : out.whatHappened}` };
    },
  };
}

export type TransfersSession = ReturnType<typeof createTransfersSession>;
