// Customer data requests (W3 · M16-FR-03 · M20-FR-04 · DPDP · §28 · hard rule #6) — the staff screen over head office's
// data-rights routes (services/customer/src/data-rights.ts, erasure-execution.ts). A customer could ask for their data or
// ask to be forgotten, but nobody could finish the request without a programmer. Now the desk can, in order:
//   • the QUEUE — `GET /v1/privacy/data-requests` (still to be worked, oldest due first) and the OVERDUE list
//     (`GET …/overdue`): what is late is said first;
//   • RECORD a request a customer made at the desk — `POST /v1/privacy/data-requests/:requestId` { customerRef, kind };
//   • VERIFY who asked — `POST …/verification` { verifiedBy }: nothing is handed over or erased before this;
//   • EXPORT (access, export, correction) — the customer's record and the personal data the shop holds are read from head
//     office (`GET /v1/customers/:ref/profile`, `GET /v1/privacy/pii/:ref`) and handed over through `POST …/fulfilment`
//     { held }; the page then gives the file to save;
//   • ERASURE — what is held and what the law keeps (`GET /v1/privacy/pii/:ref`), the SECOND person's approval
//     (`POST …/erasure-approval`, `privacy.erasure.approve`) and the run by a DIFFERENT person (`POST …/erasure-execution`,
//     `privacy.erasure.execute`, a fresh second-factor sign-in). Head office refuses the same person doing both. What the
//     law keeps (tax invoices, GST records, audit evidence) is never touched, and the sealed record of the erasure stays.
// Erasing a REAL customer's data waits for written legal confirmation (OB-49); until then this runs on demo records.
// Every rule is head office's: this session refuses only the cheap things before a request and never writes on open.
// Head office's own sentences stay in English (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const REQUEST_KINDS = ['access', 'export', 'correction', 'erasure', 'grievance'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const DATA_REQUESTS_COPY = {
  en: {
    title: 'Customer data requests',
    lead: 'When a customer asks to see their data, take a copy of it, correct it, or have it erased. Check who is asking first; nothing is handed over or erased before that. An erasure needs a second person to approve it, and a different person to carry it out. What the law says the shop must keep (tax invoices, GST records, audit records) is kept, and the customer is told why.',
    demoOnly: 'Erasing a real customer\'s data waits for the lawyer\'s written confirmation (OB-49). Until then use demo records only.',
    queueH: 'Requests to work on', overdueH: 'Late — past the date promised to the customer', none: 'No request is waiting.', noneOverdue: 'Nothing is late.',
    recordH: 'Record a request made at the desk', customer: 'Customer code', kind: 'What they asked for', record: 'Record the request',
    kind_access: 'see their data', kind_export: 'a copy of their data', kind_correction: 'correct their data', kind_erasure: 'erase their data', kind_grievance: 'a complaint about their data',
    state_raised: 'not yet checked', state_verified: 'checked', state_fulfilled: 'done', state_partially_fulfilled: 'done (some kept by law)', state_refused: 'refused',
    due: 'answer by', raised: 'asked on', verifiedHow: 'How they proved who they are', verify: 'Mark as checked',
    exportBtn: 'Hand over a copy', exported: 'Handed over. Save the file and give it to the customer.', saveFile: 'Save the file',
    heldH: 'Personal data the shop holds', willErase: 'will be erased', willMinimise: 'name and contact removed, the record kept', willKeep: 'kept by law', records: 'records',
    nothingHeld: 'No personal data is recorded for this customer.', showHeld: 'Show what is held',
    approve: 'Approve the erasure (second person)', approved: 'Approved. A different person must now carry it out.',
    execute: 'Carry out the erasure', executed: 'Erased. The sealed record of the erasure is kept.', statement: 'What to tell the customer',
    requested: 'Recorded. Check who is asking before anything else.', checked: 'Checked.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot work on customer data requests.',
    cannotApprove: 'Your role cannot approve an erasure.', cannotExecute: 'Your role cannot carry out an erasure.',
    needCustomer: 'Type the customer code.', needHow: 'Say how they proved who they are.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'வாடிக்கையாளர் தரவுக் கோரிக்கைகள்',
    lead: 'வாடிக்கையாளர் தங்கள் தரவைப் பார்க்க, நகல் எடுக்க, திருத்த அல்லது அழிக்கக் கேட்கும்போது. முதலில் கேட்பவர் யார் என்று சரிபாருங்கள்; அதற்கு முன் எதுவும் கொடுக்கப்படாது, அழிக்கப்படாது. அழிப்புக்கு இரண்டாவது நபரின் ஒப்புதலும், அதைச் செய்ய வேறொருவரும் தேவை. சட்டப்படி கடை வைத்திருக்க வேண்டியவை (வரி பில்கள், ஜிஎஸ்டி பதிவுகள், தணிக்கைப் பதிவுகள்) வைக்கப்படும்; ஏன் என்று வாடிக்கையாளருக்குச் சொல்லப்படும்.',
    demoOnly: 'உண்மையான வாடிக்கையாளரின் தரவை அழிப்பது வழக்கறிஞரின் எழுத்து உறுதிக்குக் காத்திருக்கிறது (OB-49). அதுவரை மாதிரிப் பதிவுகளை மட்டும் பயன்படுத்துங்கள்.',
    queueH: 'செய்ய வேண்டிய கோரிக்கைகள்', overdueH: 'தாமதம் — வாடிக்கையாளருக்கு உறுதியளித்த தேதி கடந்தது', none: 'எந்தக் கோரிக்கையும் காத்திருக்கவில்லை.', noneOverdue: 'எதுவும் தாமதமில்லை.',
    recordH: 'மேசையில் வந்த கோரிக்கையைப் பதிவு செய்', customer: 'வாடிக்கையாளர் குறியீடு', kind: 'அவர்கள் கேட்டது', record: 'கோரிக்கையைப் பதிவு செய்',
    kind_access: 'தங்கள் தரவைப் பார்க்க', kind_export: 'தங்கள் தரவின் நகல்', kind_correction: 'தங்கள் தரவைத் திருத்த', kind_erasure: 'தங்கள் தரவை அழிக்க', kind_grievance: 'தங்கள் தரவு பற்றிய புகார்',
    state_raised: 'இன்னும் சரிபார்க்கவில்லை', state_verified: 'சரிபார்க்கப்பட்டது', state_fulfilled: 'முடிந்தது', state_partially_fulfilled: 'முடிந்தது (சில சட்டப்படி வைக்கப்பட்டன)', state_refused: 'மறுக்கப்பட்டது',
    due: 'பதில் தேதி', raised: 'கேட்ட நாள்', verifiedHow: 'அவர்கள் யார் என்று எப்படி நிரூபித்தார்கள்', verify: 'சரிபார்த்ததாகக் குறி',
    exportBtn: 'நகலைக் கொடு', exported: 'கொடுக்கப்பட்டது. கோப்பைச் சேமித்து வாடிக்கையாளரிடம் கொடுங்கள்.', saveFile: 'கோப்பைச் சேமி',
    heldH: 'கடை வைத்துள்ள தனிப்பட்ட தரவு', willErase: 'அழிக்கப்படும்', willMinimise: 'பெயரும் தொடர்பும் நீக்கப்படும், பதிவு வைக்கப்படும்', willKeep: 'சட்டப்படி வைக்கப்படும்', records: 'பதிவுகள்',
    nothingHeld: 'இந்த வாடிக்கையாளருக்கு எந்தத் தனிப்பட்ட தரவும் பதிவாகவில்லை.', showHeld: 'வைத்திருப்பதைக் காட்டு',
    approve: 'அழிப்பை ஒப்புக்கொள் (இரண்டாவது நபர்)', approved: 'ஒப்புக்கொள்ளப்பட்டது. இப்போது வேறொருவர் அதைச் செய்ய வேண்டும்.',
    execute: 'அழிப்பைச் செய்', executed: 'அழிக்கப்பட்டது. அழிப்பின் முத்திரையிட்ட பதிவு வைக்கப்பட்டுள்ளது.', statement: 'வாடிக்கையாளரிடம் சொல்ல வேண்டியது',
    requested: 'பதிவு செய்யப்பட்டது. முதலில் கேட்பவர் யார் என்று சரிபாருங்கள்.', checked: 'சரிபார்க்கப்பட்டது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு வாடிக்கையாளர் தரவுக் கோரிக்கைகளைக் கையாள முடியாது.',
    cannotApprove: 'உங்கள் பங்கு அழிப்பை ஒப்புக்கொள்ள முடியாது.', cannotExecute: 'உங்கள் பங்கு அழிப்பைச் செய்ய முடியாது.',
    needCustomer: 'வாடிக்கையாளர் குறியீட்டைத் தட்டச்சு செய்யுங்கள்.', needHow: 'அவர்கள் யார் என்று எப்படி நிரூபித்தார்கள் என்று சொல்லுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const dataRequestsWords = (lang: Lang, key: string): string =>
  (DATA_REQUESTS_COPY[lang] as Record<string, string>)[key] ?? (DATA_REQUESTS_COPY.en as Record<string, string>)[key] ?? key;
export const dataRequestsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => dataRequestsWords(lang, k), out);

export interface DataRequestRow {
  readonly requestId: string; readonly customerRef: string; readonly kind: string; readonly state: string;
  readonly raisedAt: string; readonly dueBy: string; readonly verifiedBy?: string;
}
export interface HeldCategory {
  readonly category: string; readonly recordCount: number; readonly state: string; readonly domain?: string;
  readonly retentionBasis?: string; readonly retainUntil?: string; readonly minimisable?: boolean;
  /** What an erasure does with it, as the page says it: erased, minimised (name taken off, record kept), or kept by law. */
  readonly fate: 'erase' | 'minimise' | 'keep' | 'done';
}
export interface QueueView { readonly queue: readonly DataRequestRow[]; readonly overdue: readonly DataRequestRow[] }

type Why = 'nobody' | 'cannotRead' | 'cannotApprove' | 'cannotExecute' | 'needCustomer' | 'needHow';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Head office's statement to the customer — one sentence per category it erased, minimised or kept (with the law). */
const statementOf = (v: unknown): string => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join(' ') : str(v));

const rowOf = (v: unknown): DataRequestRow[] => (isObj(v) && typeof v['requestId'] === 'string'
  ? [{ requestId: v['requestId'], customerRef: str(v['customerRef']), kind: str(v['kind']), state: str(v['state']), raisedAt: str(v['raisedAt']), dueBy: str(v['dueBy']),
    ...(typeof v['verifiedBy'] === 'string' ? { verifiedBy: v['verifiedBy'] } : {}) }]
  : []);

/**
 * What an erasure will do with one held category — the same rule head office's planner applies (`planErasure`): a holding
 * the law keeps (a retention basis) is kept, or minimised when it may be; anything else is erased. Shown BEFORE anyone
 * approves, so the second person approves knowing what will go and what will stay.
 */
export function fateOf(c: { readonly state: string; readonly retentionBasis?: string; readonly minimisable?: boolean }): HeldCategory['fate'] {
  if (c.state !== 'held') return 'done';
  if (c.retentionBasis === undefined) return 'erase';
  return c.minimisable === true ? 'minimise' : 'keep';
}

export interface DataRequestsSession {
  readonly may: { readonly named: boolean; readonly manage: boolean; readonly approve: boolean; readonly execute: boolean };
  queue(): Done<QueueView>;
  raise(customerRef: string, kind: string): Done<{ readonly requestId: string; readonly dueBy: string }>;
  verify(requestId: string, how: string): Done<{ readonly state: string }>;
  held(customerRef: string): Done<{ readonly categories: readonly HeldCategory[] }>;
  /** Read the record and the personal data held, hand it over through head office, and return the file's contents. */
  exportFor(request: DataRequestRow): Done<{ readonly fileName: string; readonly contents: string }>;
  approve(requestId: string): Done<{ readonly approvedBy: string }>;
  execute(requestId: string): Done<{ readonly state: string; readonly customerStatement: string }>;
}

export function createDataRequestsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): DataRequestsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, manage: named && held.has('privacy.request.manage'),
    approve: named && held.has('privacy.erasure.approve'), execute: named && held.has('privacy.erasure.execute'),
  };
  const call = makeCaller({ keyPrefix: 'dsr', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'manage' | 'approve' | 'execute') => (!named ? no('nobody') : !may[need] ? no(need === 'manage' ? 'cannotRead' : need === 'approve' ? 'cannotApprove' : 'cannotExecute') : undefined);
  const readHeld = async (customerRef: string): Done<{ readonly categories: readonly HeldCategory[] }> => {
    const out = await call<{ categories?: unknown[] }>('GET', `/v1/privacy/pii/${enc(customerRef)}`);
    if (out.result !== 'ok') return out;
    const categories = (out.value.categories ?? []).flatMap((c): HeldCategory[] => {
      if (!isObj(c) || typeof c['category'] !== 'string') return [];
      const base = {
        category: c['category'], recordCount: typeof c['recordCount'] === 'number' ? c['recordCount'] : 0, state: str(c['state']) || 'held',
        ...(typeof c['domain'] === 'string' ? { domain: c['domain'] } : {}),
        ...(typeof c['retentionBasis'] === 'string' ? { retentionBasis: c['retentionBasis'] } : {}),
        ...(typeof c['retainUntil'] === 'string' ? { retainUntil: c['retainUntil'] } : {}),
        ...(typeof c['minimisable'] === 'boolean' ? { minimisable: c['minimisable'] } : {}),
      };
      return [{ ...base, fate: fateOf(base) }];
    });
    return { result: 'ok', value: { categories } };
  };
  return {
    may,
    queue: async () => {
      const g = gate('manage'); if (g) return g;
      const [q, o] = await Promise.all([
        call<{ queue?: unknown[] }>('GET', '/v1/privacy/data-requests'),
        call<{ overdue?: unknown[] }>('GET', '/v1/privacy/data-requests/overdue'),
      ]);
      if (q.result !== 'ok') return q;
      if (o.result !== 'ok') return o;
      // The overdue read names each late request (with how late); the page shows the request's own row for it.
      const lateIds = new Set((o.value.overdue ?? []).flatMap((x) => (isObj(x) && isObj(x['request']) ? [str(x['request']['requestId'])] : isObj(x) ? [str(x['requestId'])] : [])));
      const queue = (q.value.queue ?? []).flatMap(rowOf);
      return { result: 'ok', value: { queue, overdue: queue.filter((r) => lateIds.has(r.requestId)) } };
    },
    raise: async (customerRef, kind) => {
      const g = gate('manage'); if (g) return g;
      if (customerRef.trim() === '') return no('needCustomer');
      const out = await call<{ requestId?: unknown; dueBy?: unknown }>('POST', `/v1/privacy/data-requests/${enc(newId('dsr'))}`, { customerRef: customerRef.trim(), kind });
      return out.result === 'ok' ? { result: 'ok', value: { requestId: str(out.value.requestId), dueBy: str(out.value.dueBy) } } : out;
    },
    verify: async (requestId, how) => {
      const g = gate('manage'); if (g) return g;
      if (how.trim() === '') return no('needHow');
      const out = await call<{ state?: unknown }>('POST', `/v1/privacy/data-requests/${enc(requestId)}/verification`, { verifiedBy: how.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { state: str(out.value.state) } } : out;
    },
    held: async (customerRef) => gate('manage') ?? readHeld(customerRef),
    exportFor: async (request) => {
      const g = gate('manage'); if (g) return g;
      // What head office holds: the customer's record (every look is recorded) and the personal data located for them.
      // A customer the shop has no bill or case for has no record (head office answers 404): that is "nothing held", said as
      // null in the copy — never a made-up record.
      const profile = await call<Record<string, unknown>>('GET', `/v1/customers/${enc(request.customerRef)}/profile`);
      if (profile.result !== 'ok' && !(profile.result === 'refused' && profile.status === 404)) return profile;
      const customerRecord = profile.result === 'ok' ? profile.value : null;
      const pii = await readHeld(request.customerRef);
      if (pii.result !== 'ok') return pii;
      const out = await call<{ payload?: unknown; detail?: unknown }>('POST', `/v1/privacy/data-requests/${enc(request.requestId)}/fulfilment`, {
        held: { customerRecord, personalDataHeld: pii.value.categories.map((cat) => { const c = { ...cat }; delete (c as { fate?: unknown }).fate; return c; }) },
      });
      if (out.result !== 'ok') return out;
      const contents = JSON.stringify({ requestId: request.requestId, customerRef: request.customerRef, kind: request.kind, data: out.value.payload ?? {} }, null, 2);
      return { result: 'ok', value: { fileName: `data-request-${request.requestId}.json`, contents } };
    },
    approve: async (requestId) => {
      const g = gate('approve'); if (g) return g;
      const out = await call<{ approvedBy?: unknown }>('POST', `/v1/privacy/data-requests/${enc(requestId)}/erasure-approval`, {});
      return out.result === 'ok' ? { result: 'ok', value: { approvedBy: str(out.value.approvedBy) } } : out;
    },
    execute: async (requestId) => {
      const g = gate('execute'); if (g) return g;
      const out = await call<{ state?: unknown; customerStatement?: unknown }>('POST', `/v1/privacy/data-requests/${enc(requestId)}/erasure-execution`, {});
      return out.result === 'ok' ? { result: 'ok', value: { state: str(out.value.state), customerStatement: statementOf(out.value.customerStatement) } } : out;
    },
  };
}
