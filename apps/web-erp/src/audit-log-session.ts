// The Audit log page (Round 4c · M34-FR-01/02 · NFR-15 · hard rule #6 · P-08) — a tested, DOM-free session over head
// office's STORED domain audit trail, which no screen read before:
//   • SEARCH — `GET /v1/audit/trail?actorId=&objectType=&objectId=&action=&from=&until=`: who did what, when, where, with the
//     before and after of each change, newest first here (head office keeps the reader to the stores they may see);
//   • CHECK THE CHAIN — `GET /v1/audit/trail/verify`: every record's seal and link checked, EVERY break named (a company-wide
//     act; a store-limited reader is refused by name);
//   • REBUILD ONE THING — `GET /v1/audit/trail/reconstruct?objectType=&objectId=`: an object's state from the evidence alone,
//     with the chain of changes that produced it.
// Reads only: there is no way here — nor anywhere — to change or remove a record. Gated on `audit.retention.read` (the owner,
// the accountant); head office re-checks it. Head office's own words stay in English (OB-553); this page's have Tamil twins.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { tradingDayWindow } from '../../../packages/calendar/src/trading-day';
import { DEFAULT_SHOP_CALENDAR } from '../../../packages/calendar/src/shop-clock';
import { pagedQuery, type RegisterAsk } from './register-paging';

export type Lang = 'en' | 'ta';

export const AUDIT_LOG_COPY = {
  en: {
    title: 'Audit log',
    lead: 'Every recorded change in the shop: who did it, when, where, and what it was before and after. Nothing here can be changed or removed — by anyone, the owner included.',
    searchH: 'Find changes', searchLead: 'Leave a box empty to include everything. Dates are shop days.',
    actor: 'Who (sign-in id)', objectType: 'Kind of thing', objectId: 'Which one (id)', action: 'What was done', from: 'From', until: 'Until', find: 'Find',
    verifyH: 'Check the chain', verifyLead: 'Every record is sealed to the one before it. This checks every seal and names every place the chain does not hold.',
    verify: 'Check every record',
    rebuildH: 'Rebuild one thing from the record', rebuildLead: 'Name a kind and an id (from a row above) to see its state built from the evidence alone, and each change that made it.',
    rebuild: 'Rebuild',
    cWhen: 'When', cChange: 'What changed', cWho: 'Who and where', cRecord: 'The record',
    found: 'changes found', none: 'No recorded change matches.', who: 'by', where: 'at store', headOffice: 'head office', before: 'Before', after: 'After', why: 'Why', approval: 'Approval',
    intact: 'The chain holds: {n} records checked, every seal and link intact.',
    broken: 'The chain does NOT hold: {f} problem(s) in {n} records. Report this to the owner now.',
    hash_mismatch: 'its contents no longer match its seal', broken_link: 'its link to the record before is broken', sequence_gap: 'a record is missing before it',
    record: 'Record', stateNow: 'State from the evidence', changes: 'changes made it', noHistory: 'Nothing recorded about this.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the audit log.',
    needObject: 'Name the kind and the id to rebuild.', badDate: 'Write dates as YYYY-MM-DD.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'தணிக்கைப் பதிவு',
    lead: 'கடையில் பதிவான ஒவ்வொரு மாற்றமும்: யார் செய்தார், எப்போது, எங்கே, முன்பு எப்படி இருந்தது, பின்பு எப்படி. இங்கே எதையும் மாற்றவோ நீக்கவோ முடியாது — உரிமையாளர் உட்பட யாராலும்.',
    searchH: 'மாற்றங்களைத் தேடு', searchLead: 'எல்லாவற்றையும் சேர்க்க பெட்டியைக் காலியாக விடுங்கள். தேதிகள் கடை நாட்கள்.',
    actor: 'யார் (உள்நுழைவு அடையாளம்)', objectType: 'எந்த வகை', objectId: 'எது (அடையாளம்)', action: 'என்ன செய்யப்பட்டது', from: 'முதல்', until: 'வரை', find: 'தேடு',
    verifyH: 'சங்கிலியைச் சரிபார்', verifyLead: 'ஒவ்வொரு பதிவும் முந்தையதுடன் முத்திரையிடப்பட்டுள்ளது. இது ஒவ்வொரு முத்திரையையும் சரிபார்த்து, சங்கிலி உடையும் ஒவ்வொரு இடத்தையும் சொல்லும்.',
    verify: 'ஒவ்வொரு பதிவையும் சரிபார்',
    rebuildH: 'பதிவிலிருந்து ஒன்றை மீண்டும் உருவாக்கு', rebuildLead: 'ஒரு வகையையும் அடையாளத்தையும் (மேலே உள்ள வரிசையிலிருந்து) குறிப்பிட்டு, சான்றிலிருந்து மட்டும் அதன் நிலையையும் அதை உருவாக்கிய மாற்றங்களையும் பாருங்கள்.',
    rebuild: 'மீண்டும் உருவாக்கு',
    cWhen: 'எப்போது', cChange: 'என்ன மாறியது', cWho: 'யார், எங்கே', cRecord: 'பதிவு',
    found: 'மாற்றங்கள் கிடைத்தன', none: 'பொருந்தும் பதிவான மாற்றம் இல்லை.', who: 'செய்தவர்', where: 'கடை', headOffice: 'தலைமை அலுவலகம்', before: 'முன்பு', after: 'பின்பு', why: 'ஏன்', approval: 'ஒப்புதல்',
    intact: 'சங்கிலி சரியாக உள்ளது: {n} பதிவுகள் சரிபார்க்கப்பட்டன, ஒவ்வொரு முத்திரையும் இணைப்பும் சரி.',
    broken: 'சங்கிலி சரியாக இல்லை: {n} பதிவுகளில் {f} சிக்கல்(கள்). இதை இப்போதே உரிமையாளரிடம் சொல்லுங்கள்.',
    hash_mismatch: 'அதன் உள்ளடக்கம் முத்திரையுடன் பொருந்தவில்லை', broken_link: 'முந்தைய பதிவுடனான இணைப்பு உடைந்துள்ளது', sequence_gap: 'அதற்கு முன் ஒரு பதிவு காணவில்லை',
    record: 'பதிவு', stateNow: 'சான்றிலிருந்து நிலை', changes: 'மாற்றங்கள் இதை உருவாக்கின', noHistory: 'இதைப் பற்றி எதுவும் பதிவாகவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு தணிக்கைப் பதிவைப் படிக்க முடியாது.',
    needObject: 'மீண்டும் உருவாக்க வகையையும் அடையாளத்தையும் குறிப்பிடுங்கள்.', badDate: 'தேதிகளை YYYY-MM-DD என எழுதுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const auditLogWords = (lang: Lang, key: string): string =>
  (AUDIT_LOG_COPY[lang] as Record<string, string>)[key] ?? (AUDIT_LOG_COPY.en as Record<string, string>)[key] ?? key;
export const auditLogOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => auditLogWords(lang, k), out);

/** One sealed record, as the page shows it. */
export interface AuditRow {
  readonly sequence: number; readonly at: string; readonly actorId: string; readonly action: string;
  readonly objectType: string; readonly objectId: string; readonly branchId: string | null;
  readonly before: Readonly<Record<string, string>> | null; readonly after: Readonly<Record<string, string>> | null;
  readonly reason?: string; readonly approvalId?: string;
}
export interface AuditSearch { readonly actorId?: string; readonly objectType?: string; readonly objectId?: string; readonly action?: string; readonly from?: string; readonly until?: string }
export interface ChainCheck { readonly intact: boolean; readonly recordsChecked: number; readonly findings: readonly { readonly sequence: number; readonly reason: string; readonly detail: string }[] }
export interface Rebuilt { readonly state: Readonly<Record<string, string>> | null; readonly history: readonly AuditRow[] }

type Why = 'nobody' | 'cannotRead' | 'needObject' | 'badDate';
type Done<T> = Promise<Outcome<T, Why>>;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const stateOf = (v: unknown): Readonly<Record<string, string>> | null =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => isStr(e[1]))) : null;

/** A record head office sent, kept only when it is readable. */
export function auditRowOf(raw: unknown): AuditRow | undefined {
  if (!isObj(raw) || typeof raw['sequence'] !== 'number' || !isStr(raw['at']) || !isStr(raw['actorId']) || !isStr(raw['action']) || !isStr(raw['objectType']) || !isStr(raw['objectId'])) return undefined;
  const origin = isObj(raw['origin']) ? raw['origin'] : {};
  return {
    sequence: raw['sequence'], at: raw['at'], actorId: raw['actorId'], action: raw['action'], objectType: raw['objectType'], objectId: raw['objectId'],
    branchId: isStr(origin['branchId']) ? origin['branchId'] : null, before: stateOf(raw['before']), after: stateOf(raw['after']),
    ...(isStr(raw['reason']) ? { reason: raw['reason'] } : {}), ...(isStr(raw['approvalId']) ? { approvalId: raw['approvalId'] } : {}),
  };
}

/** "key: value · key: value" — a state in one line (blank when there is none). */
export const stateWords = (s: Readonly<Record<string, string>> | null): string => (s === null ? '—' : Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(' · '));

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface AuditLogSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  search(q: AuditSearch): Done<readonly AuditRow[]>;
  /** U7 (OB-725): ONE page of the trail, the page's boxes kept, the register's search and sort done by head office. */
  page(q: AuditSearch, ask: RegisterAsk): Done<{ readonly rows: readonly AuditRow[]; readonly total: number }>;
  verify(): Done<ChainCheck>;
  rebuild(objectType: string, objectId: string): Done<Rebuilt>;
}

export function createAuditLogSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): AuditLogSession {
  const named = input.viewer?.userId !== undefined;
  const read = named && (input.viewer?.permissions ?? []).includes('audit.retention.read');
  const call = makeCaller({ keyPrefix: 'audit', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const gate = (): { result: 'invalid'; why: Why } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !read ? { result: 'invalid', why: 'cannotRead' } : undefined);
  /** The page's own boxes as head office's query — or 'badDate' when a day is not a date. */
  const boxes = (q: AuditSearch): URLSearchParams | 'badDate' => {
    const params = new URLSearchParams();
    for (const k of ['actorId', 'objectType', 'objectId', 'action'] as const) { const v = q[k]?.trim() ?? ''; if (v !== '') params.set(k, v); }
    for (const k of ['from', 'until'] as const) {
      const v = q[k]?.trim() ?? '';
      if (v === '') continue;
      if (!DAY.test(v)) return 'badDate';
      // A shop day is the shop's (Asia/Kolkata), not the UTC day: "from 31 Oct" starts at the shop's midnight and "until
      // 31 Oct" runs up to (not including) the next one — the trail's `until` is exclusive (U7, 13 Nov 2026).
      const day = tradingDayWindow(v, DEFAULT_SHOP_CALENDAR);
      params.set(k, k === 'from' ? day.from : day.to);
    }
    return params;
  };
  return {
    may: { named, read },
    search: async (q) => {
      const g = gate(); if (g) return g;
      const params = boxes(q);
      if (params === 'badDate') return { result: 'invalid', why: 'badDate' };
      const qs = params.toString();
      const out = await call<{ matches?: unknown[] }>('GET', `/v1/audit/trail${qs === '' ? '' : `?${qs}`}`);
      if (out.result !== 'ok') return out;
      const rows = (out.value.matches ?? []).map(auditRowOf).filter((r): r is AuditRow => r !== undefined).sort((a, b) => b.sequence - a.sequence);
      return { result: 'ok', value: rows };
    },
    page: async (q, ask) => {
      const g = gate(); if (g) return g;
      const params = boxes(q);
      if (params === 'badDate') return { result: 'invalid', why: 'badDate' };
      // With no column chosen the newest record comes first, as this page always showed it.
      const paged = pagedQuery(ask.sort === null ? { ...ask, sort: 'at', dir: 'desc' } : ask, { at: 'sequence', change: 'action', who: 'actorId' });
      const qs = [params.toString(), paged].filter((x) => x !== '').join('&');
      const out = await call<{ matches?: unknown[]; paging?: { total?: unknown } }>('GET', `/v1/audit/trail?${qs}`);
      if (out.result !== 'ok') return out;
      const total = out.value.paging?.total;
      if (typeof total !== 'number') return { result: 'lost_link' };
      return { result: 'ok', value: { rows: (out.value.matches ?? []).map(auditRowOf).filter((r): r is AuditRow => r !== undefined), total } };
    },
    verify: async () => {
      const g = gate(); if (g) return g;
      const out = await call<{ intact?: unknown; recordsChecked?: unknown; findings?: unknown[] }>('GET', '/v1/audit/trail/verify');
      if (out.result !== 'ok') return out;
      const findings = (out.value.findings ?? []).flatMap((f) => (isObj(f) && typeof f['sequence'] === 'number' && isStr(f['reason']) ? [{ sequence: f['sequence'], reason: f['reason'], detail: isStr(f['detail']) ? f['detail'] : '' }] : []));
      return { result: 'ok', value: { intact: out.value.intact === true && findings.length === 0, recordsChecked: typeof out.value.recordsChecked === 'number' ? out.value.recordsChecked : 0, findings } };
    },
    rebuild: async (objectType, objectId) => {
      const g = gate(); if (g) return g;
      if (objectType.trim() === '' || objectId.trim() === '') return { result: 'invalid', why: 'needObject' };
      const out = await call<{ state?: unknown; history?: unknown[] }>('GET', `/v1/audit/trail/reconstruct?objectType=${encodeURIComponent(objectType.trim())}&objectId=${encodeURIComponent(objectId.trim())}`);
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { state: stateOf(out.value.state), history: (out.value.history ?? []).map(auditRowOf).filter((r): r is AuditRow => r !== undefined) } };
    },
  };
}
