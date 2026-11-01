// Opening and closing a branch (Round 4c · M01-FR-04 · §28 · §31 · P-08) — a tested, DOM-free session over head office's
// governed branch lifecycle (services/platform/src/branch-lifecycle.ts), which no screen reached before:
//   • the BRANCHES — `GET /v1/org/nodes` (the org register's branches and their state);
//   • READINESS — `GET /v1/platform/branches/:id/readiness?transition=`: what head office MEASURES at the branch now (stock
//     still held and its value, cash in tills and the safe, open documents and shifts, items the store computer has not
//     sent, unresolved exceptions) and every reason the change is blocked, all at once. Saves nothing;
//   • the CHANGE — open, close for now (with the day it reopens), reopen, or close for good: the person carrying it out asks
//     the OWNER's approval of exactly that change (kind `branch_transition`), the owner approves on the Approvals page, and
//     the change is then sent naming the approval (`POST …/transition`). A reopen needs no approval. Head office measures
//     again and refuses a blocked change by name; a permanent close takes away every grant limited to the branch;
//   • the HISTORY — `GET …/transitions`: every change, who asked, who approved, what it was decided on.
// Readiness and history need `branch.transition.evaluate`; the change `branch.transition.execute` (the owner and the store
// manager); approving is the owner's (`branch.transition.approve`). Head office re-checks each. Head office's own sentences
// stay in English (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const BRANCHES_COPY = {
  en: {
    title: 'Open and close branches',
    lead: 'Open a branch, close it for a while, reopen it, or close it for good. Head office measures what is still at the branch — stock, cash, open papers, sales not yet sent — and names every reason a change cannot happen yet. Every change but a reopen needs the owner\'s approval, never the asker\'s own.',
    listH: 'Branches', none: 'No branch is set up yet (Organisation page).',
    state_draft: 'not open yet', state_open: 'open', state_temporarily_closed: 'closed for now', state_permanently_closed: 'closed for good',
    t_open: 'Open it', t_temporarily_close: 'Close it for now', t_reopen: 'Reopen it', t_permanently_close: 'Close it for good',
    check: 'Check what stands in the way', history: 'Show its history',
    ready: 'Nothing stands in the way except the approval it needs.', readyNoApproval: 'Nothing stands in the way.',
    blockers: 'What stands in the way', measured: 'Measured at the branch',
    stock: 'Stock held', cash: 'Cash in tills and the safe', open: 'Open papers', unsent: 'Sales and records not yet sent', shifts: 'Shifts nobody closed', exceptions: 'Unresolved exceptions',
    reason: 'Why', reopensOn: 'Reopens on (for a close for now)', ask: 'Ask the owner to approve', send: 'Make the change now', asked: 'Asked. When the owner approves it on the Approvals page, press "Make the change now".',
    done: 'Done — the branch is now {state}.', waiting: 'Still waiting for the owner\'s approval.',
    noHistory: 'No change has been made to this branch yet.', by: 'asked by', approvedBy: 'approved by', noApproval: 'no approval needed',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see branch changes.', cannotChange: 'You can see; making a change needs the store manager\'s or owner\'s permission.',
    needReason: 'Say why.', needDate: 'Give the day it reopens (YYYY-MM-DD).',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'கிளைகளைத் திறத்தலும் மூடுதலும்',
    lead: 'ஒரு கிளையைத் திறக்கலாம், சிறிது காலம் மூடலாம், மீண்டும் திறக்கலாம், அல்லது நிரந்தரமாக மூடலாம். கிளையில் இன்னும் உள்ளவற்றைத் — சரக்கு, பணம், திறந்த ஆவணங்கள், இன்னும் அனுப்பப்படாத விற்பனைகள் — தலைமை அலுவலகம் அளந்து, மாற்றம் இன்னும் நடக்க முடியாத ஒவ்வொரு காரணத்தையும் சொல்லும். மீண்டும் திறப்பதைத் தவிர ஒவ்வொரு மாற்றத்துக்கும் உரிமையாளரின் ஒப்புதல் தேவை, கேட்பவருடையது ஒருபோதும் அல்ல.',
    listH: 'கிளைகள்', none: 'இன்னும் எந்தக் கிளையும் அமைக்கப்படவில்லை (அமைப்பு பக்கம்).',
    state_draft: 'இன்னும் திறக்கப்படவில்லை', state_open: 'திறந்துள்ளது', state_temporarily_closed: 'தற்காலிகமாக மூடப்பட்டது', state_permanently_closed: 'நிரந்தரமாக மூடப்பட்டது',
    t_open: 'திற', t_temporarily_close: 'தற்காலிகமாக மூடு', t_reopen: 'மீண்டும் திற', t_permanently_close: 'நிரந்தரமாக மூடு',
    check: 'தடையாக இருப்பதைச் சரிபார்', history: 'அதன் வரலாற்றைக் காட்டு',
    ready: 'தேவையான ஒப்புதலைத் தவிர எதுவும் தடையாக இல்லை.', readyNoApproval: 'எதுவும் தடையாக இல்லை.',
    blockers: 'தடையாக இருப்பவை', measured: 'கிளையில் அளக்கப்பட்டது',
    stock: 'கையிருப்புச் சரக்கு', cash: 'கல்லாக்களிலும் பெட்டகத்திலும் பணம்', open: 'திறந்த ஆவணங்கள்', unsent: 'இன்னும் அனுப்பப்படாத விற்பனைகளும் பதிவுகளும்', shifts: 'யாரும் மூடாத ஷிப்டுகள்', exceptions: 'தீர்க்கப்படாத விதிவிலக்குகள்',
    reason: 'ஏன்', reopensOn: 'மீண்டும் திறக்கும் நாள் (தற்காலிக மூடலுக்கு)', ask: 'உரிமையாளரின் ஒப்புதலைக் கேள்', send: 'இப்போது மாற்றத்தைச் செய்', asked: 'கேட்கப்பட்டது. உரிமையாளர் ஒப்புதல்கள் பக்கத்தில் அனுமதித்ததும், "இப்போது மாற்றத்தைச் செய்" அழுத்துங்கள்.',
    done: 'முடிந்தது — கிளை இப்போது {state}.', waiting: 'இன்னும் உரிமையாளரின் ஒப்புதலுக்காகக் காத்திருக்கிறது.',
    noHistory: 'இந்தக் கிளையில் இன்னும் எந்த மாற்றமும் செய்யப்படவில்லை.', by: 'கேட்டவர்', approvedBy: 'அனுமதித்தவர்', noApproval: 'ஒப்புதல் தேவையில்லை',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு கிளை மாற்றங்களைப் பார்க்க முடியாது.', cannotChange: 'பார்க்கலாம்; மாற்றம் செய்ய கடை மேலாளர் அல்லது உரிமையாளர் அனுமதி தேவை.',
    needReason: 'ஏன் என்று சொல்லுங்கள்.', needDate: 'மீண்டும் திறக்கும் நாளைத் தாருங்கள் (YYYY-MM-DD).',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const branchesWords = (lang: Lang, key: string): string =>
  (BRANCHES_COPY[lang] as Record<string, string>)[key] ?? (BRANCHES_COPY.en as Record<string, string>)[key] ?? key;
export const branchesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => branchesWords(lang, k), out);

export type BranchState = 'draft' | 'open' | 'temporarily_closed' | 'permanently_closed';
export type BranchTransition = 'open' | 'temporarily_close' | 'reopen' | 'permanently_close';
/** The changes a branch in each state may be asked for (the engine refuses any other by name). */
export const NEXT: Readonly<Record<BranchState, readonly BranchTransition[]>> = {
  draft: ['open'], open: ['temporarily_close', 'permanently_close'], temporarily_closed: ['reopen', 'permanently_close'], permanently_closed: [],
};
const STATE_OF: Readonly<Record<string, BranchState>> = { draft: 'draft', active: 'open', suspended: 'temporarily_closed', closed: 'permanently_closed' };

export interface Branch { readonly branchId: string; readonly name: string; readonly state: BranchState }
export interface Readiness {
  readonly allowed: boolean; readonly blockers: readonly { readonly code: string; readonly detail: string }[];
  readonly measured: { readonly stockMinor: number; readonly cashMinor: number; readonly openDocuments: number; readonly unsentSyncItems: number | null; readonly openShifts: number; readonly unresolvedExceptions: number; readonly syncStateUnknown?: string };
}
export interface TransitionRow { readonly transition: string; readonly fromState: string; readonly toState: string; readonly reason: string; readonly requestedBy: string; readonly approvedBy: string | null; readonly at: string }

type Why = 'nobody' | 'cannotRead' | 'cannotChange' | 'needReason' | 'needDate';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const moneyMinor = (v: unknown): number => (isObj(v) ? num(v['minor']) : 0);

/** The body of a change — and so exactly what the owner is asked to approve (head office adds the branch id). */
export function changeBody(transition: BranchTransition, reason: string, reopensOn: string): Record<string, unknown> {
  return { transition, reason: reason.trim(), ...(transition === 'temporarily_close' && reopensOn.trim() !== '' ? { reopensOn: reopensOn.trim() } : {}) };
}

export interface BranchesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly change: boolean };
  branches(): Done<readonly Branch[]>;
  readiness(branchId: string, transition: BranchTransition): Done<Readiness>;
  history(branchId: string): Done<readonly TransitionRow[]>;
  /** Ask the owner to approve exactly this change. A reopen needs none: it is sent straight away. */
  ask(branchId: string, transition: BranchTransition, reason: string, reopensOn: string): Done<{ readonly requestId: string } | { readonly done: BranchState }>;
  /** Send the change with the owner's approval, once approved ('waiting' while it is not). */
  send(branchId: string, transition: BranchTransition, reason: string, reopensOn: string, requestId: string): Done<{ readonly done: BranchState } | { readonly waiting: true }>;
}

export function createBranchesSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): BranchesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('branch.transition.evaluate'), change: named && held.has('branch.transition.execute') };
  const call = makeCaller({ keyPrefix: 'branch', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'change') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotChange') : undefined);
  const enc = encodeURIComponent;
  const check = (transition: BranchTransition, reason: string, reopensOn: string) =>
    reason.trim() === '' ? no('needReason') : transition === 'temporarily_close' && !/^\d{4}-\d{2}-\d{2}$/.test(reopensOn.trim()) ? no('needDate') : undefined;
  const execute = async (branchId: string, body: Record<string, unknown>): Done<{ readonly done: BranchState }> => {
    const out = await call<{ transition?: { toState?: unknown } }>('POST', `/v1/platform/branches/${enc(branchId)}/transition`, body);
    if (out.result !== 'ok') return out;
    const to = str(out.value.transition?.toState) as BranchState;
    return { result: 'ok', value: { done: to } };
  };
  return {
    may,
    branches: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ nodes?: unknown[] }>('GET', '/v1/org/nodes');
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: (out.value.nodes ?? []).flatMap((n): Branch[] => (isObj(n) && n['kind'] === 'branch' && typeof n['nodeId'] === 'string'
        ? [{ branchId: n['nodeId'], name: str(n['name']) || n['nodeId'], state: STATE_OF[str(n['status'])] ?? 'draft' }] : [])).sort((a, b) => a.name.localeCompare(b.name)) };
    },
    readiness: async (branchId, transition) => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ allowed?: unknown; blockers?: unknown[]; readiness?: Record<string, unknown> }>('GET', `/v1/platform/branches/${enc(branchId)}/readiness?transition=${enc(transition)}`);
      if (out.result !== 'ok') return out;
      const r = out.value.readiness ?? {};
      return { result: 'ok', value: {
        allowed: out.value.allowed === true,
        blockers: (out.value.blockers ?? []).flatMap((b) => (isObj(b) ? [{ code: str(b['code']), detail: str(b['detail']) }] : [])),
        measured: { stockMinor: moneyMinor(r['stockValue']), cashMinor: moneyMinor(r['cashBalance']), openDocuments: num(r['openDocuments']),
          unsentSyncItems: typeof r['syncStateUnknown'] === 'string' ? null : num(r['unsentSyncItems']), openShifts: num(r['openShifts']), unresolvedExceptions: num(r['unresolvedExceptions']),
          ...(typeof r['syncStateUnknown'] === 'string' ? { syncStateUnknown: r['syncStateUnknown'] } : {}) },
      } };
    },
    history: async (branchId) => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ transitions?: unknown[] }>('GET', `/v1/platform/branches/${enc(branchId)}/transitions`);
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: (out.value.transitions ?? []).flatMap((t): TransitionRow[] => (isObj(t)
        ? [{ transition: str(t['transition']), fromState: str(t['fromState']), toState: str(t['toState']), reason: str(t['reason']), requestedBy: str(t['requestedBy']), approvedBy: typeof t['approvedBy'] === 'string' ? t['approvedBy'] : null, at: str(t['at']) }] : [])).reverse() };
    },
    ask: async (branchId, transition, reason, reopensOn) => {
      const g = gate('change') ?? check(transition, reason, reopensOn); if (g) return g;
      const body = changeBody(transition, reason, reopensOn);
      if (transition === 'reopen') return execute(branchId, body);
      const out = await call<{ requestId?: unknown }>('POST', '/v1/approvals/requests', { kind: 'branch_transition', subjectRef: branchId, details: { ...body, branchId }, valueMinor: null, summary: `${transition.replace('_', ' ')} branch ${branchId}`, reason: reason.trim() });
      if (out.result !== 'ok') return out;
      return typeof out.value.requestId === 'string' ? { result: 'ok', value: { requestId: out.value.requestId } } : { result: 'lost_link' };
    },
    send: async (branchId, transition, reason, reopensOn, requestId) => {
      const g = gate('change') ?? check(transition, reason, reopensOn); if (g) return g;
      const mine = await call<{ mine?: unknown[] }>('GET', '/v1/approvals/requests');
      if (mine.result !== 'ok') return mine;
      const status = (mine.value.mine ?? []).find((r) => isObj(r) && r['requestId'] === requestId);
      if (!isObj(status) || status['status'] === 'waiting') return { result: 'ok', value: { waiting: true } };
      return execute(branchId, { ...changeBody(transition, reason, reopensOn), approvalId: requestId });
    },
  };
}
