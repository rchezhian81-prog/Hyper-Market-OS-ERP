// OB-435: the words of the business alerts head office raises to the owners (and the delivery-exception text message to
// the person who staffs its queue), in English and Tamil. The English is word for word what it was before. What a person
// typed (a recall's reason, an approval's own summary, a contract's description, a refusal a machine gave) is kept as
// they wrote it, in both languages; only the frame around it is translated.

import { s, n, l, b, opt, type AlertTemplate } from './alert-text';

const inr = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;
/** "2 hours", "1 hour", "90 minutes" — how the approval-age sweep says a wait. */
const hoursEn = (m: number): string => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);
const hoursTa = (m: number): string => (m % 60 === 0 ? `${m / 60} மணி நேரம்` : `${m} நிமிடம்`);
const SUBJECT_TA: Readonly<Record<string, string>> = { refund: 'பணத் திருப்பம்', purchase_order: 'கொள்முதல் ஆணை', stock_adjustment: 'இருப்புச் சரிசெய்தல்' };
const DOCUMENT_TA: Readonly<Record<string, string>> = { agreement: 'ஒப்பந்தம்', insurance: 'காப்பீடு', licence: 'உரிமம்' };
const SUBSTITUTION_KIND_TA: Readonly<Record<string, string>> = {
  refund_due: 'பணம் திருப்பித் தர வேண்டியது', collect_adjustment: 'வசூல் சரிசெய்தல்', above_cap_charge: 'வரம்புக்கு மேல் கட்டணம்', policy_short_pick: 'கொள்கைப்படி குறைவாக எடுத்தது',
};
const QUEUE_TA: Readonly<Record<string, string>> = {
  fulfilment_supervisor: 'நிறைவேற்றும் மேற்பார்வையாளர்', customer_service_desk: 'வாடிக்கையாளர் சேவை மேசை', finance_recon_queue: 'கணக்குச் சரிபார்ப்பு', duty_manager: 'பணியிலுள்ள மேலாளர்',
};
const LP_KIND_EN: Readonly<Record<string, string>> = { void: 'voided bills', refund: 'refunds', discount: 'discounts', no_sale: 'no-sale drawer opens', cash_variance: 'cash variances' };
const LP_KIND_TA: Readonly<Record<string, string>> = { void: 'ரத்து செய்த பில்கள்', refund: 'பணத் திருப்பங்கள்', discount: 'தள்ளுபடிகள்', no_sale: 'விற்பனையின்றிப் பணப் பெட்டி திறப்புகள்', cash_variance: 'பண வேறுபாடுகள்' };
const rupeesIn = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const BUSINESS_WORDS = {
  // ── M29-FR-03 · OB-288 lane 4: the owner's exception alerts (packages/owner-control/src/alerts-inbox.ts) ─────────
  'owner.exception.discountOne': {
    en: (p) => `${s(p['actor'])} gave a discount of ${n(p['value'])} at ${s(p['branch'])}`,
    ta: (p) => `${s(p['actor'])} ${s(p['branch'])} இல் ${n(p['value'])} தள்ளுபடி கொடுத்தார்`,
    sample: { actor: 'u-cashier-1', value: 50_000, branch: 'store-1' },
  },
  'owner.exception.discountMany': {
    en: (p) => `${s(p['actor'])} gave ${n(p['count'])} large discounts at ${s(p['branch'])}, ${n(p['total'])} in total`,
    ta: (p) => `${s(p['actor'])} ${s(p['branch'])} இல் ${n(p['count'])} பெரிய தள்ளுபடிகள் கொடுத்தார், மொத்தம் ${n(p['total'])}`,
    sample: { actor: 'u-cashier-1', count: 3, branch: 'store-1', total: 150_000 },
  },
  'owner.exception.voids': {
    en: (p) => `${s(p['actor'])} voided ${n(p['count'])} bills at ${s(p['branch'])} worth ${n(p['value'])}`,
    ta: (p) => `${s(p['actor'])} ${s(p['branch'])} இல் ${n(p['value'])} மதிப்புள்ள ${n(p['count'])} பில்களை ரத்து செய்தார்`,
    sample: { actor: 'u-cashier-1', count: 6, branch: 'store-1', value: 90_000 },
  },
  'owner.exception.overrides': {
    en: (p) => `${s(p['actor'])} overrode the price ${n(p['count'])} times at ${s(p['branch'])}`,
    ta: (p) => `${s(p['actor'])} ${s(p['branch'])} இல் ${n(p['count'])} முறை விலையை மாற்றினார்`,
    sample: { actor: 'u-cashier-1', count: 7, branch: 'store-1' },
  },
  'owner.exception.afterHours': {
    en: (p) => `${s(p['actor'])} signed in at ${s(p['branch'])} outside trading hours (${n(p['count'])} time(s))`,
    ta: (p) => `${s(p['actor'])} ${s(p['branch'])} இல் வணிக நேரத்துக்கு வெளியே உள்நுழைந்தார் (${n(p['count'])} முறை)`,
    sample: { actor: 'u-cashier-1', branch: 'store-1', count: 1 },
  },
  'owner.exception.failedSignIn': {
    en: (p) => `${s(p['actor'])} failed to sign in ${n(p['count'])} time(s) at ${s(p['branch'])}${b(p['locked']) ? ' and was locked out' : ''}`,
    ta: (p) => `${s(p['actor'])} ${s(p['branch'])} இல் ${n(p['count'])} முறை உள்நுழையத் தவறினார்${b(p['locked']) ? '; அவரது உள்நுழைவு பூட்டப்பட்டது' : ''}`,
    sample: { actor: 'u-cashier-1', count: 5, branch: 'store-1', locked: true },
  },
  'owner.exception.shortOne': {
    en: (p) => `${s(p['branch'])} till was ${n(p['value'])} short on ${s(p['actor'])}'s shift`,
    ta: (p) => `${s(p['actor'])} இன் ஷிப்டில் ${s(p['branch'])} கல்லாவில் ${n(p['value'])} குறைவாக இருந்தது`,
    sample: { branch: 'store-1', value: 20_000, actor: 'u-cashier-1' },
  },
  'owner.exception.shortMany': {
    en: (p) => `${s(p['actor'])} was short on ${n(p['count'])} shifts at ${s(p['branch'])}, ${n(p['total'])} in total`,
    ta: (p) => `${s(p['actor'])} ${s(p['branch'])} இல் ${n(p['count'])} ஷிப்டுகளில் குறைவாக இருந்தார், மொத்தம் ${n(p['total'])}`,
    sample: { actor: 'u-cashier-1', count: 2, branch: 'store-1', total: 40_000 },
  },
  'owner.exception.detail': {
    en: (p) => `${s(p['headline'])} (trading day ${s(p['day'])}; ${n(p['count'])} record(s): ${l(p['refs']).join(', ')})`,
    ta: (p) => `${s(p['headline'])} (வணிக நாள் ${s(p['day'])}; ${n(p['count'])} பதிவு(கள்): ${l(p['refs']).join(', ')})`,
    sample: { headline: { kind: 'owner.exception.overrides', params: { actor: 'u-cashier-1', count: 7, branch: 'store-1' } }, day: '2026-10-28', count: 7, refs: ['b-1', 'b-2'] },
  },
  'owner.exception.component': {
    en: (p) => `Owner alert — ${s(p['en'])}`,
    ta: (p) => `உரிமையாளர் எச்சரிக்கை — ${s(p['ta'])}`,
    sample: { en: 'Price overrides', ta: 'விலை மாற்றங்கள்' },
  },

  // ── OB-288 lane 2 · M10-FR-01: a recall, to every owner (services/api/src/lane2-recall-adapters.ts) ─────────────
  'recall.alert': {
    en: (p) => {
      const products = l(p['products']); const orders = l(p['orders']);
      return `Batch ${s(p['batchId'])} was recalled by ${s(p['by'])}: ${s(p['reason'])}. ${products.length === 0 ? 'Head office cannot name its product yet, so no till can refuse it — record the batch\'s receipt.' : `Product(s) ${products.join(', ')}: ${s(p['tills'])}.`}${orders.length > 0 ? ` Open purchase orders for it: ${orders.join(', ')}.` : ''}`;
    },
    ta: (p) => {
      const products = l(p['products']); const orders = l(p['orders']);
      return `தொகுதி ${s(p['batchId'])} ஐ ${s(p['by'])} திரும்பப் பெற்றார்: ${s(p['reason'])}. ${products.length === 0 ? 'இதன் பொருளைத் தலைமை அலுவலகத்தால் இன்னும் பெயரிட முடியவில்லை, எனவே எந்தக் கவுண்டரும் இதை மறுக்க முடியாது — தொகுதியின் வரவைப் பதிவு செய்யுங்கள்.' : `பொருள்(கள்) ${products.join(', ')}: ${s(p['tills'])}.`}${orders.length > 0 ? ` இதற்குத் திறந்திருக்கும் கொள்முதல் ஆணைகள்: ${orders.join(', ')}.` : ''}`;
    },
    sample: { batchId: 'B-77', by: 'u-owner-1', reason: 'supplier recall notice', products: ['P-1'], tills: { kind: 'recall.tills.published', params: { version: 12 } }, orders: ['PO-9'] },
  },
  'recall.tills.failed': {
    en: (p) => `it is NOT yet blocked at the tills (${s(p['detail'])}) — publish the catalogue now`,
    ta: (p) => `இது இன்னும் கவுண்டர்களில் தடுக்கப்படவில்லை (${s(p['detail'])}) — இப்போதே விலைப் பட்டியலை வெளியிடுங்கள்`,
    sample: { detail: 'connection reset' },
  },
  'recall.tills.published': {
    en: (p) => `the tills' catalogue v${n(p['version'])} now refuses it`,
    ta: (p) => `கவுண்டர்களின் விலைப் பட்டியல் v${n(p['version'])} இப்போது இதை மறுக்கிறது`,
    sample: { version: 12 },
  },
  'recall.tills.already': { en: () => 'the tills already refuse it', ta: () => 'கவுண்டர்கள் ஏற்கனவே இதை மறுக்கின்றன', sample: {} },
  'recall.tills.notCarried': { en: () => 'no till carries it', ta: () => 'எந்தக் கவுண்டரிலும் இது இல்லை', sample: {} },
  'recall.tills.notBlocked': {
    en: (p) => `it is NOT yet blocked at the tills — ${s(p['detail'])}`,
    ta: (p) => `இது இன்னும் கவுண்டர்களில் தடுக்கப்படவில்லை — ${s(p['detail'])}`,
    sample: { detail: { kind: 'recall.pack.noPack' } },
  },
  'recall.pack.noPack': {
    en: () => 'No catalogue has been published to the tills yet, so no till is selling anything from head office. The first publish will carry this block.',
    ta: () => 'கவுண்டர்களுக்கு இன்னும் எந்த விலைப் பட்டியலும் வெளியிடப்படவில்லை, எனவே எந்தக் கவுண்டரும் தலைமை அலுவலகத்திலிருந்து எதையும் விற்கவில்லை. முதல் வெளியீடு இந்தத் தடையைக் கொண்டு செல்லும்.',
    sample: {},
  },
  'recall.pack.productUnknown': {
    en: () => 'Head office cannot name this batch to a product (no receipt or stock movement carried it), so no till can refuse it. Record the batch\'s receipt; the block follows.',
    ta: () => 'இந்தத் தொகுதியை எந்தப் பொருளுடனும் தலைமை அலுவலகத்தால் இணைக்க முடியவில்லை (எந்த வரவோ இருப்பு நகர்வோ இதைக் கொண்டு வரவில்லை), எனவே எந்தக் கவுண்டரும் இதை மறுக்க முடியாது. தொகுதியின் வரவைப் பதிவு செய்யுங்கள்; தடை தொடரும்.',
    sample: {},
  },
  'recall.pack.notCarried': {
    en: (p) => `No till carries ${l(p['products']).join(', ')} (it is not on catalogue v${n(p['version'])}), so none can sell it.`,
    ta: (p) => `எந்தக் கவுண்டரிலும் ${l(p['products']).join(', ')} இல்லை (விலைப் பட்டியல் v${n(p['version'])} இல் இல்லை), எனவே எதுவும் இதை விற்க முடியாது.`,
    sample: { products: ['P-1'], version: 12 },
  },
  'recall.pack.refused': {
    en: (p) => `The recall pack was refused: ${s(p['detail'])}. Publish the catalogue by hand now.`,
    ta: (p) => `திரும்பப் பெறும் தொகுப்பு மறுக்கப்பட்டது: ${s(p['detail'])}. இப்போதே விலைப் பட்டியலை நீங்களே வெளியிடுங்கள்.`,
    sample: { detail: 'signature check failed' },
  },
  'recall.pack.raced': {
    en: () => 'Three publishes landed while the recall pack was being signed. Publish the catalogue by hand now.',
    ta: () => 'திரும்பப் பெறும் தொகுப்பு கையொப்பமிடப்படும்போது மூன்று வெளியீடுகள் வந்தன. இப்போதே விலைப் பட்டியலை நீங்களே வெளியிடுங்கள்.',
    sample: {},
  },
  'recall.component': {
    en: (p) => `Recall of batch ${s(p['batchId'])}`,
    ta: (p) => `தொகுதி ${s(p['batchId'])} திரும்பப் பெறுதல்`,
    sample: { batchId: 'B-77' },
  },
  'recall.cleared.withdrawn': {
    en: (p) => `the recall was withdrawn as started by mistake: ${s(p['reason'])}`,
    ta: (p) => `தவறாகத் தொடங்கியதால் திரும்பப் பெறுதல் விலக்கிக்கொள்ளப்பட்டது: ${s(p['reason'])}`,
    sample: { reason: 'wrong batch typed' },
  },
  'recall.cleared.closed': {
    en: (p) => `the recall was closed with evidence ${s(p['evidence'])}`.trim(),
    ta: (p) => `திரும்பப் பெறுதல் சான்றுடன் முடிக்கப்பட்டது ${s(p['evidence'])}`.trim(),
    sample: { evidence: 'EV-12' },
  },

  // ── OB-292: an approval waiting too long, to the owners (services/api/src/p1-identity-adapters.ts) ──────────────
  'approval.age': {
    en: (p) => `${s(p['summary'])}${opt(p['valueMinor']) === undefined ? '' : ` (${inr(n(p['valueMinor']))})`}, asked by ${s(p['by'])}, has waited ${hoursEn(n(p['waitedMinutes']))} — longer than the ${hoursEn(n(p['waitMinutes']))} allowed for a ${s(p['subject']).replace('_', ' ')}. It has come to you to decide.`,
    ta: (p) => `${s(p['summary'])}${opt(p['valueMinor']) === undefined ? '' : ` (${inr(n(p['valueMinor']))})`}, ${s(p['by'])} கேட்டது, ${hoursTa(n(p['waitedMinutes']))} காத்திருக்கிறது — ${SUBJECT_TA[s(p['subject'])] ?? s(p['subject'])} ஒன்றுக்கு அனுமதிக்கப்பட்ட நேரம் ${hoursTa(n(p['waitMinutes']))} மட்டுமே. முடிவு செய்ய இது உங்களிடம் வந்துள்ளது.`,
    sample: { summary: { kind: 'approval.summary.po', params: { number: 'PO-12', supplier: 'sup-1' } }, valueMinor: 812_000_00, by: 'u-buyer-1', waitedMinutes: 300, waitMinutes: 240, subject: 'purchase_order' },
  },
  'approval.summary.po': {
    en: (p) => `Purchase order ${s(p['number'])} to ${s(p['supplier'])}`,
    ta: (p) => `${s(p['supplier'])} க்கு கொள்முதல் ஆணை ${s(p['number'])}`,
    sample: { number: 'PO-12', supplier: 'sup-1' },
  },
  'approval.summary.adjustment': {
    en: (p) => `Stock adjustment of ${s(p['product'])} at ${s(p['location'])}`,
    ta: (p) => `${s(p['location'])} இல் ${s(p['product'])} இருப்புச் சரிசெய்தல்`,
    sample: { product: 'P-1', location: 'store-1' },
  },
  'approval.component': {
    en: (p) => `Approval waiting: ${s(p['summary'])}`,
    ta: (p) => `ஒப்புதல் காத்திருக்கிறது: ${s(p['summary'])}`,
    sample: { summary: { kind: 'approval.summary.adjustment', params: { product: 'P-1', location: 'store-1' } } },
  },
  'approval.cleared': { en: () => 'the approval has been decided', ta: () => 'ஒப்புதல் முடிவு செய்யப்பட்டது', sample: {} },

  // ── R3 · A19: a GST return near or past its 3-year bar (packages/finance/src/filing-calendar.ts) ────────────────
  'gst.timeBarred': {
    en: (p) => `${s(p['type'])} ${s(p['period'])} was never filed and is now permanently time-barred (the bar was ${s(p['bar'])}) — it can no longer be filed`,
    ta: (p) => `${s(p['type'])} ${s(p['period'])} ஒருபோதும் தாக்கல் செய்யப்படவில்லை; இப்போது நிரந்தரமாகக் கால வரம்பு கடந்துவிட்டது (வரம்பு ${s(p['bar'])}) — இனி தாக்கல் செய்ய முடியாது`,
    sample: { type: 'GSTR3B', period: '2023-04', bar: '2026-05-20' },
  },
  'gst.nearBar': {
    en: (p) => `${s(p['type'])} ${s(p['period'])} is NOT filed and will be permanently barred on ${s(p['bar'])} — ${n(p['days'])} day(s) left`,
    ta: (p) => `${s(p['type'])} ${s(p['period'])} தாக்கல் செய்யப்படவில்லை; ${s(p['bar'])} அன்று நிரந்தரமாகக் கால வரம்பு கடந்துவிடும் — ${n(p['days'])} நாள்(கள்) மட்டுமே உள்ளன`,
    sample: { type: 'GSTR1', period: '2023-11', bar: '2026-12-11', days: 44 },
  },
  'gst.component': {
    en: (p) => `GST ${s(p['type'])} ${s(p['period'])}`,
    ta: (p) => `GST ${s(p['type'])} ${s(p['period'])} தாக்கல்`,
    sample: { type: 'GSTR1', period: '2023-11' },
  },
  'gst.cleared': { en: () => 'the return is now filed', ta: () => 'அந்தத் தாக்கல் இப்போது செய்யப்பட்டுவிட்டது', sample: {} },

  // ── R4 · C15: a payslip late (packages/payroll/src/payslip-particulars.ts) ──────────────────────────────────────
  'payslip.notIssued': {
    en: (p) => `${s(p['employee'])}'s payslip for ${s(p['period'])} was not issued by the pay date ${s(p['payDate'])}`,
    ta: (p) => `${s(p['employee'])} இன் ${s(p['period'])} சம்பளச் சீட்டு சம்பள நாளான ${s(p['payDate'])} க்குள் வழங்கப்படவில்லை`,
    sample: { employee: 'e-1', period: '2026-09', payDate: '2026-10-07' },
  },
  'payslip.issuedLate': {
    en: (p) => `${s(p['employee'])}'s payslip for ${s(p['period'])} was issued on ${s(p['on'])}, after the pay date ${s(p['payDate'])}`,
    ta: (p) => `${s(p['employee'])} இன் ${s(p['period'])} சம்பளச் சீட்டு சம்பள நாளான ${s(p['payDate'])} க்குப் பிறகு, ${s(p['on'])} அன்று வழங்கப்பட்டது`,
    sample: { employee: 'e-1', period: '2026-09', on: '2026-10-09', payDate: '2026-10-07' },
  },
  'payslip.component': {
    en: (p) => `Payslip ${s(p['period'])} — ${s(p['employee'])}`,
    ta: (p) => `சம்பளச் சீட்டு ${s(p['period'])} — ${s(p['employee'])}`,
    sample: { period: '2026-09', employee: 'e-1' },
  },

  // ── C9: the customer-data volume watch (services/customer/src/data-volume-watch.ts) ─────────────────────────────
  'dpdp.crossed': {
    en: (p) => `${n(p['count'])} customers' personal data on record — at or above the ${n(p['threshold'])} the CA set (version ${n(p['version'])}). Ask the CA and lawyer whether the shop may be notified as a Significant Data Fiduciary (DPDP Act s.10) and whether a data protection impact assessment, an audit and a DPO are needed (Rules 12–13).`,
    ta: (p) => `${n(p['count'])} வாடிக்கையாளர்களின் தனிப்பட்ட தரவு பதிவில் உள்ளது — CA அமைத்த ${n(p['threshold'])} க்கு (பதிப்பு ${n(p['version'])}) சமம் அல்லது அதிகம். கடை "முக்கியத் தரவுப் பொறுப்பாளர்" (Significant Data Fiduciary, DPDP சட்டம் பிரிவு 10) என அறிவிக்கப்படலாமா, தரவுப் பாதுகாப்புத் தாக்க மதிப்பீடு, தணிக்கை, DPO தேவையா (விதிகள் 12–13) என்று CA-விடமும் வழக்கறிஞரிடமும் கேளுங்கள்.`,
    sample: { count: 52_000, threshold: 50_000, version: 2 },
  },
  'dpdp.below': {
    en: (p) => `${n(p['count'])} customers' personal data on record — below the ${n(p['threshold'])} the CA set (version ${n(p['version'])}).`,
    ta: (p) => `${n(p['count'])} வாடிக்கையாளர்களின் தனிப்பட்ட தரவு பதிவில் உள்ளது — CA அமைத்த ${n(p['threshold'])} க்குக் கீழே (பதிப்பு ${n(p['version'])}).`,
    sample: { count: 12_000, threshold: 50_000, version: 2 },
  },
  'dpdp.component': { en: () => 'Customer data volume (DPDP)', ta: () => 'வாடிக்கையாளர் தரவின் அளவு (DPDP)', sample: {} },

  // ── FG-4 · M04-FR-04 / M06-FR-03: display and supplier contracts (packages/purchasing/src/contract-expiry.ts) ──
  'contract.component': {
    en: (p) => `${s(p['register']) === 'display' ? 'Display' : 'Supplier'} contract ${s(p['contractId'])}`,
    ta: (p) => `${s(p['register']) === 'display' ? 'காட்சி' : 'சப்ளையர்'} ஒப்பந்தம் ${s(p['contractId'])}`,
    sample: { register: 'display', contractId: 'DC-3' },
  },
  'contract.expired': {
    en: (p) => {
      const label = `${s(p['register']) === 'display' ? 'Display' : 'Supplier'} contract ${s(p['contractId'])}`;
      return s(p['register']) === 'display'
        ? `${label}${opt(p['what']) === undefined ? '' : ` (${s(p['what'])})`} with ${s(p['supplier'])} ended on ${s(p['endsOn'])}, ${n(p['daysAgo'])} day(s) ago. If the display is still on the floor, the shop is giving the space away. Renew it or take the display down.`
        : `${label} with ${s(p['supplier'])} ended on ${s(p['endsOn'])}, ${n(p['daysAgo'])} day(s) ago. Orders placed since are on no agreed terms. Renew it or stop ordering on it.`;
    },
    ta: (p) => (s(p['register']) === 'display'
      ? `${s(p['supplier'])} உடனான காட்சி ஒப்பந்தம் ${s(p['contractId'])}${opt(p['what']) === undefined ? '' : ` (${s(p['what'])})`} ${s(p['endsOn'])} அன்று, ${n(p['daysAgo'])} நாள்(கள்) முன்பு முடிந்தது. காட்சி இன்னும் தரையில் இருந்தால், கடை அந்த இடத்தை இலவசமாகக் கொடுக்கிறது. அதைப் புதுப்பியுங்கள், அல்லது காட்சியை அகற்றுங்கள்.`
      : `${s(p['supplier'])} உடனான சப்ளையர் ஒப்பந்தம் ${s(p['contractId'])} ${s(p['endsOn'])} அன்று, ${n(p['daysAgo'])} நாள்(கள்) முன்பு முடிந்தது. அதன் பிறகு போட்ட ஆணைகளுக்கு ஒப்புக்கொண்ட நிபந்தனைகள் இல்லை. அதைப் புதுப்பியுங்கள், அல்லது அதன்கீழ் ஆணை போடுவதை நிறுத்துங்கள்.`),
    sample: { register: 'display', contractId: 'DC-3', what: 'end cap at store-1', supplier: 'sup-1', endsOn: '2026-10-20', daysAgo: 8 },
  },
  'contract.expiring': {
    en: (p) => `${s(p['register']) === 'display' ? 'Display' : 'Supplier'} contract ${s(p['contractId'])}${opt(p['what']) === undefined ? '' : ` (${s(p['what'])})`} with ${s(p['supplier'])} ends on ${s(p['endsOn'])} (${n(p['daysLeft'])} day(s) left; you asked to be told ${n(p['warnDays'])} day(s) ahead). Renew it or plan for its end.`,
    ta: (p) => `${s(p['supplier'])} உடனான ${s(p['register']) === 'display' ? 'காட்சி' : 'சப்ளையர்'} ஒப்பந்தம் ${s(p['contractId'])}${opt(p['what']) === undefined ? '' : ` (${s(p['what'])})`} ${s(p['endsOn'])} அன்று முடிகிறது (${n(p['daysLeft'])} நாள்(கள்) உள்ளன; ${n(p['warnDays'])} நாள் முன்பே சொல்லச் சொன்னீர்கள்). அதைப் புதுப்பியுங்கள், அல்லது அது முடிவதற்குத் திட்டமிடுங்கள்.`,
    sample: { register: 'supplier', contractId: 'SC-4', what: null, supplier: 'sup-2', endsOn: '2026-11-07', daysLeft: 10, warnDays: 30 },
  },
  'contract.cleared': {
    en: () => 'the contract was renewed, or is no longer due',
    ta: () => 'ஒப்பந்தம் புதுப்பிக்கப்பட்டது, அல்லது இனி முடிவு நெருங்கவில்லை',
    sample: {},
  },

  // ── round 6 · B7: a weighing scale's Legal Metrology stamp (services/api/src/r6b-quality-scale-adapters.ts) ─────
  'scale.component': {
    en: (p) => `Weighing scale ${s(p['assetId'])} (${s(p['storeId'])})`,
    ta: (p) => `எடைத் தராசு ${s(p['assetId'])} (${s(p['storeId'])})`,
    sample: { assetId: 'SC-1', storeId: 'store-1' },
  },
  'scale.lapsed': {
    en: (p) => `The Legal Metrology stamp of scale ${s(p['assetId'])} (approval ${s(p['approvalNo'])}, ${l(p['lanes']).length === 0 ? 'no till lane' : `lane${l(p['lanes']).length === 1 ? '' : 's'} ${l(p['lanes']).join(', ')}`}) lapsed on ${s(p['dueOn'])} — verification lapsed ${n(p['days'])} day(s) ago — this scale may not be used for trade until it is re-verified. Its lanes sell nothing by weight until it is re-verified and the new certificate is recorded.`,
    ta: (p) => `தராசு ${s(p['assetId'])} இன் சட்ட அளவியல் (Legal Metrology) முத்திரை (ஒப்புதல் ${s(p['approvalNo'])}, ${l(p['lanes']).length === 0 ? 'எந்தக் கவுண்டரிலும் இல்லை' : `கவுண்டர் ${l(p['lanes']).join(', ')}`}) ${s(p['dueOn'])} அன்று காலாவதியானது — சரிபார்ப்பு ${n(p['days'])} நாள்(கள்) முன்பு காலாவதியானது — மீண்டும் சரிபார்க்கும் வரை இந்தத் தராசை வணிகத்துக்குப் பயன்படுத்தக்கூடாது. மீண்டும் சரிபார்த்துப் புதிய சான்றிதழைப் பதிவு செய்யும் வரை அதன் கவுண்டர்கள் எடை போட்டு எதையும் விற்காது.`,
    sample: { assetId: 'SC-1', approvalNo: 'LM-1', lanes: ['lane-1'], dueOn: '2026-10-20', days: 8 },
  },
  'scale.dueSoon': {
    en: (p) => `The Legal Metrology stamp of scale ${s(p['assetId'])} (approval ${s(p['approvalNo'])}, ${l(p['lanes']).length === 0 ? 'no till lane' : `lane${l(p['lanes']).length === 1 ? '' : 's'} ${l(p['lanes']).join(', ')}`}) is valid only until ${s(p['dueOn'])} — verification due in ${n(p['days'])} day(s) — book re-verification before it stops the counter. After that date its lanes stop selling by weight.`,
    ta: (p) => `தராசு ${s(p['assetId'])} இன் சட்ட அளவியல் (Legal Metrology) முத்திரை (ஒப்புதல் ${s(p['approvalNo'])}, ${l(p['lanes']).length === 0 ? 'எந்தக் கவுண்டரிலும் இல்லை' : `கவுண்டர் ${l(p['lanes']).join(', ')}`}) ${s(p['dueOn'])} வரை மட்டுமே செல்லும் — சரிபார்ப்பு ${n(p['days'])} நாளில் வருகிறது — கவுண்டர் நிற்கும் முன் மறு சரிபார்ப்புக்குப் பதிவு செய்யுங்கள். அந்த நாளுக்குப் பிறகு அதன் கவுண்டர்கள் எடை போட்டு விற்பதை நிறுத்தும்.`,
    sample: { assetId: 'SC-1', approvalNo: 'LM-1', lanes: ['lane-1', 'lane-2'], dueOn: '2026-11-07', days: 10 },
  },
  'scale.cleared': {
    en: () => 'the scale was re-stamped, or its stamp is no longer due',
    ta: () => 'தராசுக்குப் புதிய முத்திரை இடப்பட்டது, அல்லது அதன் முத்திரை இனி நெருங்கவில்லை',
    sample: {},
  },

  // ── M27-FR-04: a concession counter's agreement, insurance or licence (packages/concession/src/expiry-alerts.ts) ──
  'concession.component': {
    en: (p) => `Concession ${s(p['name'])}`,
    ta: (p) => `சலுகைக் கவுண்டர் ${s(p['name'])}`,
    sample: { name: 'Fresh Juice Counter' },
  },
  'concession.noInsurance': {
    en: (p) => `${s(p['name'])}: no insurance is on record, so the counter cannot take new sales. Record the insurance date on the contract.`,
    ta: (p) => `${s(p['name'])}: காப்பீடு பதிவில் இல்லை, எனவே அந்தக் கவுண்டர் புதிய விற்பனை எடுக்க முடியாது. ஒப்பந்தத்தில் காப்பீட்டுத் தேதியைப் பதிவு செய்யுங்கள்.`,
    sample: { name: 'Fresh Juice Counter' },
  },
  'concession.lapsed': {
    en: (p) => `${s(p['name'])}: the ${s(p['document'])} ended on ${s(p['on'])}. The counter cannot take new sales until it is renewed.`,
    ta: (p) => `${s(p['name'])}: ${DOCUMENT_TA[s(p['document'])] ?? s(p['document'])} ${s(p['on'])} அன்று முடிந்தது. புதுப்பிக்கும் வரை அந்தக் கவுண்டர் புதிய விற்பனை எடுக்க முடியாது.`,
    sample: { name: 'Fresh Juice Counter', document: 'licence', on: '2026-10-20' },
  },
  'concession.ending': {
    en: (p) => `${s(p['name'])}: the ${s(p['document'])} ends on ${s(p['on'])} (${n(p['days'])} day(s) left). Renew it before then, or the counter stops taking new sales.`,
    ta: (p) => `${s(p['name'])}: ${DOCUMENT_TA[s(p['document'])] ?? s(p['document'])} ${s(p['on'])} அன்று முடிகிறது (${n(p['days'])} நாள்(கள்) உள்ளன). அதற்குள் புதுப்பியுங்கள், இல்லையென்றால் அந்தக் கவுண்டர் புதிய விற்பனை எடுப்பதை நிறுத்தும்.`,
    sample: { name: 'Fresh Juice Counter', document: 'agreement', on: '2026-11-07', days: 10 },
  },

  // ── B2B: a contract ending, a recurring order that could not be made (services/api/src/commercial-desks-adapters.ts)
  'b2b.contract.component': {
    en: (p) => `B2B contract ${s(p['contractId'])}`,
    ta: (p) => `வணிக வாடிக்கையாளர் ஒப்பந்தம் ${s(p['contractId'])}`,
    sample: { contractId: 'BC-1' },
  },
  'b2b.contract.ending': {
    en: (p) => `${s(p['customer'])}'s contract ${s(p['contractId'])} ends on ${s(p['validTo'])} (${n(p['days'])} day(s) left). After that it ${b(p['blocks']) ? 'blocks new quotations and orders' : 'falls back to the shop\'s ordinary prices'} until a renewal is approved.`,
    ta: (p) => `${s(p['customer'])} இன் ஒப்பந்தம் ${s(p['contractId'])} ${s(p['validTo'])} அன்று முடிகிறது (${n(p['days'])} நாள்(கள்) உள்ளன). அதன் பிறகு, புதுப்பித்தல் அனுமதிக்கப்படும் வரை, ${b(p['blocks']) ? 'புதிய விலைப்புள்ளிகளும் ஆணைகளும் தடுக்கப்படும்' : 'கடையின் வழக்கமான விலைகளே பொருந்தும்'}.`,
    sample: { customer: 'cust-b2b-1', contractId: 'BC-1', validTo: '2026-11-04', days: 7, blocks: true },
  },
  'b2b.recurring.component': {
    en: (p) => `B2B recurring order ${s(p['scheduleId'])}`,
    ta: (p) => `வணிக வாடிக்கையாளர் தொடர் ஆணை ${s(p['scheduleId'])}`,
    sample: { scheduleId: 'RS-1' },
  },
  'b2b.recurring.exception': {
    en: (p) => `Recurring order ${s(p['scheduleId'])} for ${s(p['customer'])} could not be made on ${s(p['on'])}: ${s(p['why'])}. Nothing was ordered for that day. Fix the stock or credit, then run the day again from the business-customers page.`,
    ta: (p) => `${s(p['customer'])} க்கான தொடர் ஆணை ${s(p['scheduleId'])} ஐ ${s(p['on'])} அன்று உருவாக்க முடியவில்லை: ${s(p['why'])}. அந்த நாளுக்கு எதுவும் ஆர்டர் செய்யப்படவில்லை. இருப்பையோ கடன் வரம்பையோ சரிசெய்து, வணிக வாடிக்கையாளர்கள் பக்கத்திலிருந்து அந்த நாளை மீண்டும் இயக்குங்கள்.`,
    sample: { scheduleId: 'RS-1', customer: 'cust-b2b-1', on: '2026-10-28', why: 'credit_limit_reached' },
  },

  // ── CERT-In: a report past its six hours (services/api/src/ops-messaging-adapters.ts) ───────────────────────────
  'certIn.component': {
    en: (p) => `CERT-In report — incident ${s(p['incident'])}`,
    ta: (p) => `CERT-In அறிக்கை — நிகழ்வு ${s(p['incident'])}`,
    sample: { incident: 'INC-1' },
  },
  'certIn.overdue': {
    en: (p) => `The CERT-In report for incident ${s(p['incident'])} (${s(p['category'])}) was due by ${s(p['reportBy'])} — six hours from when it was noticed (${s(p['noticedAt'])}). Report it now and record the reference.`,
    ta: (p) => `நிகழ்வு ${s(p['incident'])} (${s(p['category'])}) க்கான CERT-In அறிக்கை ${s(p['reportBy'])} க்குள் அனுப்பப்பட்டிருக்க வேண்டும் — கவனித்த நேரத்திலிருந்து (${s(p['noticedAt'])}) ஆறு மணி நேரம். இப்போதே அறிவித்து, குறிப்பு எண்ணைப் பதிவு செய்யுங்கள்.`,
    sample: { incident: 'INC-1', category: 'phishing', reportBy: '2026-10-28T12:00:00Z', noticedAt: '2026-10-28T06:00:00Z' },
  },

  // ── round 8 · M19-FR-04: a delivery exception past its time limit — a TEXT MESSAGE to the person who staffs it ──
  'delivery.breach': {
    en: (p) => `Delivery exception past its time limit: order ${s(p['orderId'])} line ${s(p['lineId'])} — ${s(p['kind']).replace(/_/g, ' ')}, ${inr(n(p['amountMinor']))} at stake, in the ${s(p['queue']).replace(/_/g, ' ')} queue${opt(p['assignedTo']) === undefined ? ' (nobody has claimed it — you are the duty manager)' : `, held by you (${s(p['assignedTo'])})`}; it was due by ${s(p['dueAt'])}. Open Delivery exceptions to work it.`,
    ta: (p) => `நேர வரம்பு கடந்த டெலிவரி விதிவிலக்கு: ஆர்டர் ${s(p['orderId'])} வரி ${s(p['lineId'])} — ${SUBSTITUTION_KIND_TA[s(p['kind'])] ?? s(p['kind'])}, ${inr(n(p['amountMinor']))} சம்பந்தப்பட்டது, ${QUEUE_TA[s(p['queue'])] ?? s(p['queue'])} வரிசையில்${opt(p['assignedTo']) === undefined ? ' (யாரும் எடுக்கவில்லை — நீங்கள் பணியிலுள்ள மேலாளர்)' : `, உங்களிடம் உள்ளது (${s(p['assignedTo'])})`}; ${s(p['dueAt'])} க்குள் முடிந்திருக்க வேண்டும். அதைச் செய்ய "டெலிவரி விதிவிலக்குகள்" பக்கத்தைத் திறங்கள்.`,
    sample: { orderId: 'O-1', lineId: 'L-1', kind: 'refund_due', amountMinor: 12_000, queue: 'customer_service_desk', assignedTo: null, dueAt: '2026-10-28T10:00:00Z' },
  },

  // ── the owner app's brief: grouped loss-prevention alerts and approvals waiting (apps/owner-app/src/brief.ts) ───
  'owner.brief.group': {
    en: (p) => `${b(p['urgent']) ? 'Urgent: ' : ''}${LP_KIND_EN[s(p['kind'])] ?? s(p['kind'])} over the limit${n(p['totalMinor']) > 0 ? ` — ${rupeesIn(n(p['totalMinor']))} across` : ' —'} ${n(p['transactions'])} transaction${n(p['transactions']) === 1 ? '' : 's'}.`,
    ta: (p) => `${b(p['urgent']) ? 'அவசரம்: ' : ''}வரம்பை மீறிய ${LP_KIND_TA[s(p['kind'])] ?? s(p['kind'])}${n(p['totalMinor']) > 0 ? ` — ${rupeesIn(n(p['totalMinor']))},` : ' —'} ${n(p['transactions'])} பரிவர்த்தனை(கள்).`,
    sample: { urgent: true, kind: 'void', totalMinor: 0, transactions: 3 },
  },
  'owner.brief.approval': {
    en: (p) => `Approval waiting: ${s(p['subject']).replace(/_/g, ' ')} from ${s(p['by'])}${opt(p['valueMinor']) === undefined ? '' : ` for ${rupeesIn(n(p['valueMinor']))}`}.`,
    ta: (p) => `ஒப்புதல் காத்திருக்கிறது: ${s(p['by'])} இடமிருந்து ${SUBJECT_TA[s(p['subject'])] ?? s(p['subject']).replace(/_/g, ' ')}${opt(p['valueMinor']) === undefined ? '' : `, ${rupeesIn(n(p['valueMinor']))}`}.`,
    sample: { subject: 'purchase_order', by: 'u-buyer-1', valueMinor: 812_000_00 },
  },
} as const satisfies Readonly<Record<string, AlertTemplate>>;
