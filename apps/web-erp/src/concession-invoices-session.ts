// Concession invoices (Round 4d · M27-FR-03 "issue invoices and reconcile") — a tested, DOM-free session for the Concessions
// page's invoice part, over head office's routes (services/finance/src/concession-invoices.ts):
//   • the GST the CA set for concession charges (`GET /v1/concession/gst-treatment`) — "not set" until the CA sets it;
//   • PREVIEW (`GET …/invoice-preview`) — what the period's invoice would say, nothing written, no number taken;
//   • ASK — the maker asks a SECOND person to approve exactly that invoice and total (`POST /v1/approvals/requests`, kind
//     `concession_invoice`); ISSUE — once approved, the maker issues it naming the approval (`POST …/invoices/:invoiceId`):
//     the number comes from the gap-free series and the settlement posts to the books in the same act;
//   • the INVOICES issued and the reconcile check against the ledger (`GET …/invoices`).
// Amounts are typed in rupees and sent as paise. Reading needs `concession.charge.read`; asking and issuing
// `concession.contract.manage` — head office re-checks each, and the checker is never the maker. Every word has Tamil.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { paiseOf, rupees } from './concession-session';

export type Lang = 'en' | 'ta';

export const CONCESSION_INVOICES_COPY = {
  en: {
    invoicesH: 'Invoices to the concessionaire', invoicesLead: 'The shop\'s invoice for a period: the contract\'s rent or revenue share and utilities, with the GST the CA set; it nets what our tills collected for them and states the deposit (never netted). One person makes it, another approves it; the number comes from the year\'s series and the settlement goes into the books.',
    gstH: 'GST on concession charges', gstNotSet: 'Not set — the CA decides the GST on rent, revenue share and utilities; until then no invoice can be written.', gstSet: 'Set by', within: 'within the state (CGST + SGST)', across: 'across states (IGST)',
    rent: 'Rent', revenue_share: 'Revenue share', utilities: 'Utilities', taxable: 'before GST', gst: 'GST', total: 'Invoice total', collected: 'Our tills held for them', net: 'Net payable to them', theyOwe: 'They owe the shop', deposit: 'Deposit held (not netted)',
    setGstH: 'Set the GST the CA confirmed', rentPct: 'On rent (%)', sharePct: 'On revenue share (%)', utilitiesPct: 'On utilities (%)', supply: 'Supply', note: 'The CA\'s note', saveGst: 'Save the GST treatment', gstSaved: 'GST treatment saved as version', needPercent: 'Type each rate as a percentage, e.g. 18.',
    preview: 'Preview the invoice', ask: 'Ask for approval', issue: 'Issue the approved invoice', asked: 'Asked. A different person approves it on the Approvals page; then issue it here.', issued: 'Issued', noApproved: 'No approved invoice is waiting to be issued.',
    listH: 'Invoices issued', none: 'No invoice issued for this counter yet.', ledgerAgrees: 'in the books, figure for figure', ledgerDiffers: 'the books do not match this invoice', madeBy: 'made by', approvedBy: 'approved by', period: 'period',
    notReconciled: 'The tills and the counter do not agree for this period — settle the difference before invoicing.',
    cannotConfigure: 'Setting the GST needs the accountant\'s permission.', nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see concession invoices.', cannotManage: 'You can see the invoices; making one needs the concession manager\'s permission.', needPick: 'Choose the counter first.', needWindow: 'Give the period: from and to.', needMoney: 'Type the amount in rupees, e.g. 2,00,000.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or issued.',
  },
  ta: {
    invoicesH: 'சலுகையாளருக்கான விலைப்பட்டியல்கள்', invoicesLead: 'ஒரு காலத்திற்கான கடையின் விலைப்பட்டியல்: ஒப்பந்தத்தின் வாடகை அல்லது வருவாய்ப் பங்கு மற்றும் பயன்பாட்டுக் கட்டணம், CA அமைத்த ஜிஎஸ்டியுடன்; நம் கல்லாக்கள் அவர்களுக்காக வசூலித்ததைக் கழிக்கிறது, வைப்புத் தொகையைக் குறிப்பிடுகிறது (கழிக்கப்படாது). ஒருவர் உருவாக்குகிறார், மற்றொருவர் ஒப்புதல் அளிக்கிறார்; எண் ஆண்டின் வரிசையிலிருந்து வருகிறது, தீர்வு கணக்கில் பதியப்படுகிறது.',
    gstH: 'சலுகைக் கட்டணங்களுக்கான ஜிஎஸ்டி', gstNotSet: 'அமைக்கப்படவில்லை — வாடகை, வருவாய்ப் பங்கு, பயன்பாட்டுக் கட்டணத்திற்கான ஜிஎஸ்டியை CA முடிவு செய்கிறார்; அதுவரை விலைப்பட்டியல் எழுத முடியாது.', gstSet: 'அமைத்தவர்', within: 'மாநிலத்திற்குள் (CGST + SGST)', across: 'மாநிலங்களுக்கு இடையே (IGST)',
    rent: 'வாடகை', revenue_share: 'வருவாய்ப் பங்கு', utilities: 'பயன்பாட்டுக் கட்டணம்', taxable: 'ஜிஎஸ்டிக்கு முன்', gst: 'ஜிஎஸ்டி', total: 'விலைப்பட்டியல் மொத்தம்', collected: 'நம் கல்லாக்கள் அவர்களுக்காக வைத்திருந்தது', net: 'அவர்களுக்குச் செலுத்த வேண்டிய நிகரம்', theyOwe: 'அவர்கள் கடைக்குச் செலுத்த வேண்டியது', deposit: 'வைத்திருக்கும் வைப்புத் தொகை (கழிக்கப்படாது)',
    setGstH: 'CA உறுதிப்படுத்திய ஜிஎஸ்டியை அமை', rentPct: 'வாடகைக்கு (%)', sharePct: 'வருவாய்ப் பங்குக்கு (%)', utilitiesPct: 'பயன்பாட்டுக் கட்டணத்திற்கு (%)', supply: 'விநியோகம்', note: 'CA குறிப்பு', saveGst: 'ஜிஎஸ்டி முறையைச் சேமி', gstSaved: 'ஜிஎஸ்டி முறை சேமிக்கப்பட்ட பதிப்பு', needPercent: 'ஒவ்வொரு விகிதத்தையும் சதவீதமாகத் தட்டச்சு செய்யுங்கள், எ.கா. 18.',
    preview: 'விலைப்பட்டியலை முன்னோட்டமிடு', ask: 'ஒப்புதல் கேள்', issue: 'ஒப்புதல் பெற்ற விலைப்பட்டியலை வெளியிடு', asked: 'கேட்கப்பட்டது. வேறொருவர் அனுமதிகள் பக்கத்தில் ஒப்புதல் அளிப்பார்; பின்னர் இங்கே வெளியிடுங்கள்.', issued: 'வெளியிடப்பட்டது', noApproved: 'வெளியிடக் காத்திருக்கும் ஒப்புதல் பெற்ற விலைப்பட்டியல் இல்லை.',
    listH: 'வெளியிட்ட விலைப்பட்டியல்கள்', none: 'இந்தக் கவுண்டருக்கு இன்னும் விலைப்பட்டியல் வெளியிடப்படவில்லை.', ledgerAgrees: 'கணக்கில் அப்படியே உள்ளது', ledgerDiffers: 'கணக்கு இந்த விலைப்பட்டியலுடன் பொருந்தவில்லை', madeBy: 'உருவாக்கியவர்', approvedBy: 'ஒப்புதல் அளித்தவர்', period: 'காலம்',
    notReconciled: 'இந்தக் காலத்திற்குக் கல்லாக்களும் கவுண்டரும் ஒத்துப்போகவில்லை — விலைப்பட்டியலுக்கு முன் வேறுபாட்டைத் தீர்க்கவும்.',
    cannotConfigure: 'ஜிஎஸ்டியை அமைக்க கணக்காளர் அனுமதி தேவை.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு சலுகை விலைப்பட்டியல்களைப் பார்க்க முடியாது.', cannotManage: 'விலைப்பட்டியல்களைப் பார்க்கலாம்; உருவாக்க சலுகை மேலாளர் அனுமதி தேவை.', needPick: 'முதலில் கவுண்டரைத் தேர்ந்தெடுங்கள்.', needWindow: 'காலத்தைக் கொடுங்கள்: முதல் மற்றும் வரை.', needMoney: 'தொகையை ரூபாயில் தட்டச்சு செய்யுங்கள், எ.கா. 2,00,000.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, வெளியிடப்படவில்லை.',
  },
} as const;

export const concessionInvoicesWords = (lang: Lang, key: string): string =>
  (CONCESSION_INVOICES_COPY[lang] as Record<string, string>)[key] ?? (CONCESSION_INVOICES_COPY.en as Record<string, string>)[key] ?? key;
export const concessionInvoicesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => concessionInvoicesWords(lang, k), out);

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'cannotConfigure' | 'needPick' | 'needWindow' | 'needMoney' | 'noApproved' | 'needPercent';
/** A percentage typed ("18", "2.5") as basis points, or null. */
export const bpsOf = (typed: string): number | null => { const t = typed.trim(); return /^\d{1,3}(\.\d{1,2})?$/.test(t) && Number(t) <= 100 ? Math.round(Number(t) * 100) : null; };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PeriodInput { readonly contractId: string; readonly from: string; readonly to: string; readonly banked: string; readonly metered: string }
export interface ApprovedInvoiceRequest { readonly requestId: string; readonly status: string; readonly kind: string; readonly subjectRef: string; readonly details: Record<string, unknown> }

export interface ConcessionInvoicesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean; readonly configure: boolean };
  /** The accountant / CA records the GST treatment they confirmed (a new version each time). */
  setGst(input: { readonly rent: string; readonly share: string; readonly utilities: string; readonly supply: 'intra_state' | 'inter_state'; readonly note: string }): Promise<Outcome<{ readonly version: number }, Why>>;
  gstTreatment(): Promise<Outcome<{ readonly gstTreatment: { readonly rentBps: number; readonly revenueShareBps: number; readonly utilitiesBps: number; readonly supply: string; readonly setBy: string; readonly setAt: string; readonly version: number } | null }, Why>>;
  preview(p: PeriodInput): Promise<Outcome<Record<string, unknown>, Why>>;
  /** Ask a second person to approve exactly this period's invoice (its total from the preview). */
  ask(p: PeriodInput, invoiceTotalMinor: number): Promise<Outcome<{ readonly invoiceId: string }, Why>>;
  /** The maker's own approved, unused invoice requests for a counter (the Approvals inbox's "mine"). */
  approvedFor(contractId: string): Promise<Outcome<readonly ApprovedInvoiceRequest[], Why>>;
  issue(request: ApprovedInvoiceRequest): Promise<Outcome<{ readonly invoice: Record<string, unknown> }, Why>>;
  invoices(contractId: string): Promise<Outcome<{ readonly invoices: readonly Record<string, unknown>[]; readonly reconcile: readonly { readonly invoiceId: string; readonly agrees: boolean; readonly detail: string }[]; readonly allAgree: boolean }, Why>>;
}

export function createConcessionInvoicesSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly makeId?: (prefix: string) => string }): ConcessionInvoicesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('concession.charge.read'), manage: named && held.has('concession.contract.manage'), configure: named && held.has('finance.posting.configure') };
  const call = makeCaller({ keyPrefix: 'concession-invoices', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const id = input.makeId ?? newId;
  const enc = encodeURIComponent;
  const no = (why: Why): Outcome<never, Why> => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'manage' | 'configure') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : need === 'manage' ? 'cannotManage' : 'cannotConfigure') : undefined);
  /** The issue body for a period (what the route reads; the approval fingerprints exactly this plus the path ids). */
  const bodyOf = (p: PeriodInput): Record<string, unknown> | Why => {
    if (p.contractId === '') return 'needPick';
    if (!DATE.test(p.from) || !DATE.test(p.to)) return 'needWindow';
    const banked = paiseOf(p.banked); const metered = p.metered.trim() === '' ? undefined : paiseOf(p.metered);
    if (banked === null || metered === null) return 'needMoney';
    return { from: p.from, to: p.to, bankedForThemMinor: banked, ...(metered === undefined ? {} : { meteredUtilitiesMinor: metered }) };
  };
  return {
    may,
    gstTreatment: async () => gate('read') ?? call('GET', '/v1/concession/gst-treatment'),
    setGst: async (g) => {
      const x = gate('configure'); if (x) return x;
      const rentBps = bpsOf(g.rent); const revenueShareBps = bpsOf(g.share); const utilitiesBps = bpsOf(g.utilities);
      if (rentBps === null || revenueShareBps === null || utilitiesBps === null) return no('needPercent');
      const out = await call<{ gstTreatment?: { version?: unknown } }>('PUT', '/v1/concession/gst-treatment', { rentBps, revenueShareBps, utilitiesBps, supply: g.supply, ...(g.note.trim() === '' ? {} : { note: g.note.trim() }) });
      return out.result === 'ok' ? { result: 'ok', value: { version: Number(out.value.gstTreatment?.version ?? 0) } } : out;
    },
    preview: async (p) => {
      const g = gate('read'); if (g) return g;
      const b = bodyOf(p); if (typeof b === 'string') return no(b);
      const q = new URLSearchParams(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v)])));
      return call('GET', `/v1/concession/contracts/${enc(p.contractId)}/invoice-preview?${q.toString()}`);
    },
    ask: async (p, invoiceTotalMinor) => {
      const g = gate('manage'); if (g) return g;
      const b = bodyOf(p); if (typeof b === 'string') return no(b);
      const invoiceId = id('CINV');
      const out = await call('POST', '/v1/approvals/requests', {
        kind: 'concession_invoice', subjectRef: `concession-invoice:${invoiceId}`, details: { ...b, contractId: p.contractId, invoiceId }, valueMinor: invoiceTotalMinor,
        summary: `Concession invoice for ${p.contractId}, ${p.from} to ${p.to} — ${rupees(invoiceTotalMinor)}`, reason: 'the period\'s concession invoice and settlement',
      });
      return out.result === 'ok' ? { result: 'ok', value: { invoiceId } } : out;
    },
    approvedFor: async (contractId) => {
      const g = gate('manage'); if (g) return g;
      const r = await call<{ mine?: ApprovedInvoiceRequest[] }>('GET', '/v1/approvals/requests');
      if (r.result !== 'ok') return r;
      return { result: 'ok', value: (r.value.mine ?? []).filter((q) => q.kind === 'concession_invoice' && q.status === 'approved' && q.details['contractId'] === contractId) };
    },
    issue: async (request) => {
      const g = gate('manage'); if (g) return g;
      const { contractId, invoiceId, ...body } = request.details as Record<string, unknown> & { contractId: string; invoiceId: string };
      return call('POST', `/v1/concession/contracts/${enc(contractId)}/invoices/${enc(invoiceId)}`, { ...body, approvalId: request.requestId });
    },
    invoices: async (contractId) => {
      const g = gate('read'); if (g) return g;
      if (contractId === '') return no('needPick');
      return call('GET', `/v1/concession/contracts/${enc(contractId)}/invoices`);
    },
  };
}
