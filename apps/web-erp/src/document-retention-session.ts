// Document retention (W3 · M31-FR-01 · hard rule #6 · §28) — a tested, DOM-free session over head office's retention
// reads and its one disposal act (services/platform/src/documents.ts), which no screen reached: nobody could see which
// documents had come to the end of their keeping time, nor record that one was disposed of, without a programmer.
//   • DOCUMENTS — every issued document with what head office proposes: keep (a legal hold, a statutory record, still inside
//     its keeping time, or no keeping rule at all — silence never means discard) or "may be disposed of"
//     (`GET /v1/documents/retention/documents`). A read; it disposes of nothing;
//   • TEMPLATE VERSIONS — which layout versions could ever go, and which never can because a document was issued under them
//     (`GET /v1/documents/retention/templates`). A read;
//   • DISPOSE — an authorised person records their decision to dispose of ONE proposed document, with a reason
//     (`POST /v1/documents/:documentId/disposal`). Head office re-checks it from the document itself and refuses anything it
//     may not dispose of, in its words. The decision is a fact kept for ever (append-only).
// Reading needs `document.template.read`; disposing `document.retention.dispose` (the owner, the store manager). Head office
// re-checks each. Every word this page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const RETENTION_COPY = {
  en: {
    title: 'Document retention',
    lead: 'Documents the shop has issued, and whether each must still be kept. Tax invoices, credit notes, goods receipts and statements are always kept, as is anything under a legal hold or with no keeping rule. Only a document whose keeping time has ended may be disposed of — you record the decision with a reason, and the record of it is kept for ever.',
    docsH: 'Issued documents', noDocs: 'Head office holds no issued document.', today: 'as of', proposed: 'may be disposed of', disposedCount: 'already disposed',
    keep: 'keep', propose_disposal: 'may be disposed of', reason: 'Why it is being disposed of', dispose: 'Record the disposal',
    templatesH: 'Layout versions', noTemplates: 'No layout version is held.', disposable: 'could be removed', mustKeep: 'must be kept',
    disposed: 'Recorded. The decision is kept for ever.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see document retention.', cannotDispose: 'You can see what is due; recording a disposal needs the manager\'s permission.', needReason: 'Say why.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or recorded.', reading: 'Asking head office…',
  },
  ta: {
    title: 'ஆவணக் காப்புக் காலம்',
    lead: 'கடை வழங்கிய ஆவணங்களும், ஒவ்வொன்றையும் இன்னும் வைத்திருக்க வேண்டுமா என்பதும். வரி விலைப்பட்டியல், கடன் குறிப்பு, சரக்கு வரவுச் சீட்டு, கணக்கு அறிக்கை எப்போதும் வைக்கப்படும்; சட்டத் தடை உள்ளவையும் காப்பு விதி இல்லாதவையும் கூட. காப்புக் காலம் முடிந்த ஆவணத்தை மட்டுமே அகற்றலாம் — காரணத்துடன் முடிவைப் பதிவு செய்கிறீர்கள்; அந்தப் பதிவு எப்போதும் வைக்கப்படும்.',
    docsH: 'வழங்கிய ஆவணங்கள்', noDocs: 'தலைமை அலுவலகத்தில் எந்த ஆவணமும் இல்லை.', today: 'நாள்', proposed: 'அகற்றலாம்', disposedCount: 'ஏற்கனவே அகற்றப்பட்டவை',
    keep: 'வைத்திரு', propose_disposal: 'அகற்றலாம்', reason: 'ஏன் அகற்றப்படுகிறது', dispose: 'அகற்றலைப் பதிவு செய்',
    templatesH: 'வடிவமைப்புப் பதிப்புகள்', noTemplates: 'எந்த வடிவமைப்புப் பதிப்பும் இல்லை.', disposable: 'அகற்றலாம்', mustKeep: 'வைத்திருக்க வேண்டும்',
    disposed: 'பதிவு செய்யப்பட்டது. இந்த முடிவு எப்போதும் வைக்கப்படும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு ஆவணக் காப்புக் காலத்தைப் பார்க்க முடியாது.', cannotDispose: 'உரியவற்றைப் பார்க்கலாம்; அகற்றலைப் பதிவு செய்ய மேலாளர் அனுமதி தேவை.', needReason: 'ஏன் என்று சொல்லுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, பதிவு செய்யப்படவில்லை.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const retentionWords = (lang: Lang, key: string): string =>
  (RETENTION_COPY[lang] as Record<string, string>)[key] ?? (RETENTION_COPY.en as Record<string, string>)[key] ?? key;
export const retentionOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => retentionWords(lang, k), out);

export interface RetentionDocRow { readonly documentId: string; readonly kind: string; readonly action: 'keep' | 'propose_disposal'; readonly reason: string }
export interface RetentionDocs { readonly today: string; readonly proposed: number; readonly disposedCount: number; readonly plan: readonly RetentionDocRow[] }
export interface RetentionTemplateRow { readonly templateId: string; readonly version: number; readonly disposable: boolean; readonly dependentDocuments: number; readonly detail: string }

type Why = 'nobody' | 'cannotRead' | 'cannotDispose' | 'needReason';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export interface DocumentRetentionSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly dispose: boolean };
  documents(): Done<RetentionDocs>;
  templates(): Done<readonly RetentionTemplateRow[]>;
  dispose(documentId: string, reason: string): Done<{ readonly disposed: true }>;
}

export function createDocumentRetentionSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): DocumentRetentionSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('document.template.read'), dispose: named && held.has('document.retention.dispose') };
  const call = makeCaller({ keyPrefix: 'retention', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'dispose') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotDispose') : undefined);
  return {
    may,
    documents: async () => {
      const g = gate('read'); if (g) return g;
      // No ?today=: head office judges by the shop's own day, never the device's.
      const out = await call<{ today?: unknown; proposedForDisposalCount?: unknown; disposedCount?: unknown; plan?: unknown[] }>('GET', '/v1/documents/retention/documents');
      if (out.result !== 'ok') return out;
      const plan = (out.value.plan ?? []).flatMap((p): RetentionDocRow[] => (isObj(p) && typeof p['documentId'] === 'string' && (p['action'] === 'keep' || p['action'] === 'propose_disposal')
        ? [{ documentId: p['documentId'], kind: str(p['kind']), action: p['action'], reason: str(p['reason']) }] : []));
      // What may be disposed of first (control by exception), then what is kept.
      plan.sort((a, b) => Number(b.action === 'propose_disposal') - Number(a.action === 'propose_disposal') || a.documentId.localeCompare(b.documentId));
      return { result: 'ok', value: { today: str(out.value.today), proposed: num(out.value.proposedForDisposalCount), disposedCount: num(out.value.disposedCount), plan } };
    },
    templates: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ decisions?: unknown[] }>('GET', '/v1/documents/retention/templates');
      if (out.result !== 'ok') return out;
      return {
        result: 'ok',
        value: (out.value.decisions ?? []).flatMap((d): RetentionTemplateRow[] => (isObj(d) && typeof d['templateId'] === 'string'
          ? [{ templateId: d['templateId'], version: num(d['version']), disposable: d['disposable'] === true, dependentDocuments: num(d['dependentDocuments']), detail: str(d['detail']) }] : [])),
      };
    },
    dispose: async (documentId, reason) => {
      const g = gate('dispose'); if (g) return g;
      if (reason.trim() === '') return no('needReason');
      const out = await call('POST', `/v1/documents/${encodeURIComponent(documentId)}/disposal`, { reason: reason.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { disposed: true } } : out;
    },
  };
}
