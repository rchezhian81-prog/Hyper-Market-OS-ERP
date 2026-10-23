// The CLOSED-DAY EVIDENCE PACK on the day-book screen (M14-FR-04 · P-07 · P-08) — the accountant (or owner) picks a
// trading day, sees each store's close of it (locked, or reopened and not closed again), and downloads the day's sealed
// evidence pack for the CA: one CSV for the spreadsheet and the JSON it was sealed from, both named with the start of the
// seal. A pack of a reopened day downloads too, and says NOT FINAL on the screen and in the file. Reads only.
//
// A DOM-free session model on the shared packages/ui primitives (colour is never the only signal — an icon and a word ride
// with every tone). The shell (`web/day-book.js`) only draws what this hands over and saves the file it is given.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

export type EvidenceCopyKey =
  | 'heading' | 'lead' | 'none' | 'notPermitted' | 'lostLink' | 'refused'
  | 'store' | 'locked' | 'reopened' | 'csvBtn' | 'jsonBtn' | 'ready' | 'notFinal' | 'seal';

export const DAY_EVIDENCE_COPY: BilingualCopy<EvidenceCopyKey> = {
  en: {
    heading: 'Evidence pack for the CA',
    lead: 'Each closed day as head office holds it — sales, takings and refunds by tender, each till\'s cash and over/short, every exception, and every close and reopen with who approved it — sealed with a fingerprint (SHA-256) the CA can re-check. Download it as CSV for the spreadsheet, or JSON.',
    none: 'No store has closed this day yet, so there is no evidence pack for it.',
    notPermitted: 'You do not have permission to read closed days.',
    lostLink: 'No connection to head office — nothing was downloaded. Try again.',
    refused: 'Head office refused the evidence pack — nothing was downloaded.',
    store: 'Store', locked: 'Closed and locked', reopened: 'Reopened — not final',
    csvBtn: 'Download CSV for the CA', jsonBtn: 'Download JSON',
    ready: 'Downloaded', notFinal: 'NOT FINAL — the day was reopened and not closed again; these figures may still change.', seal: 'Seal',
  },
  ta: {
    heading: 'பட்டயக் கணக்காளருக்கான சான்று தொகுப்பு',
    lead: 'தலைமை அலுவலகம் வைத்திருக்கும் ஒவ்வொரு மூடிய நாளும் — விற்பனை, பணவகை வாரியாக வசூல் மற்றும் திருப்பிச் செலுத்தல், ஒவ்வொரு கவுண்டரின் பணமும் கூடுதல்/குறைவும், ஒவ்வொரு விதிவிலக்கும், யார் ஒப்புதல் அளித்தார் என்பதுடன் ஒவ்வொரு மூடல் மற்றும் மீண்டும் திறப்பும் — பட்டயக் கணக்காளர் சரிபார்க்கக்கூடிய கைரேகையுடன் (SHA-256) முத்திரையிடப்பட்டது. விரிதாளுக்கு CSV ஆக, அல்லது JSON ஆகப் பதிவிறக்குங்கள்.',
    none: 'இந்த நாளை இன்னும் எந்தக் கடையும் மூடவில்லை, எனவே சான்று தொகுப்பு இல்லை.',
    notPermitted: 'மூடிய நாட்களைப் படிக்க உங்களுக்கு அனுமதி இல்லை.',
    lostLink: 'தலைமை அலுவலகத்துடன் இணைப்பு இல்லை — எதுவும் பதிவிறக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    refused: 'தலைமை அலுவலகம் சான்று தொகுப்பை மறுத்தது — எதுவும் பதிவிறக்கப்படவில்லை.',
    store: 'கடை', locked: 'மூடப்பட்டு பூட்டப்பட்டது', reopened: 'மீண்டும் திறக்கப்பட்டது — இறுதியல்ல',
    csvBtn: 'பட்டயக் கணக்காளருக்கு CSV பதிவிறக்கு', jsonBtn: 'JSON பதிவிறக்கு',
    ready: 'பதிவிறக்கப்பட்டது', notFinal: 'இறுதியல்ல — நாள் மீண்டும் திறக்கப்பட்டு மீண்டும் மூடப்படவில்லை; இந்த எண்கள் இன்னும் மாறலாம்.', seal: 'முத்திரை',
  },
};

/** One close of a trading day, as `GET /v1/pos/day-close` lists it. */
export interface DayEvidenceCloseRow {
  readonly dayCloseId: string;
  readonly storeId: string;
  readonly tradingDay: string;
  readonly locked: boolean;
  readonly reopened: boolean;
}

/** What head office answers for one pack. */
export interface DayEvidenceReply {
  readonly pack: { readonly final: boolean; readonly contentHash: string };
  readonly csv: string;
  readonly fileName: string;
  readonly said: string;
}

export type ReadResult<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'refused'; readonly status: number } | { readonly kind: 'lost_link' };

export interface DayEvidencePorts {
  /** `till.dayclose.read` — the owner, a store manager for their store, the accountant. */
  mayRead(): boolean;
  closes(): Promise<ReadResult<readonly DayEvidenceCloseRow[]>>;
  pack(dayCloseId: string): Promise<ReadResult<DayEvidenceReply>>;
}

export interface PresentedCloseRow {
  readonly dayCloseId: string;
  readonly storeLabel: string;
  readonly status: StatusPresentation;
}

export interface DayEvidenceFile {
  readonly fileName: string;
  readonly mime: string;
  readonly content: string;
}

export interface DayEvidenceSession {
  text(lang: Lang, key: EvidenceCopyKey): string;
  /** The closes of `tradingDay`, presented, or one status saying why there are none. */
  rows(lang: Lang, tradingDay: string): Promise<{ readonly rows: readonly PresentedCloseRow[]; readonly status: StatusPresentation | null }>;
  /** The pack of one close as a file to save, and the line to show beside it. */
  download(lang: Lang, dayCloseId: string, format: 'csv' | 'json'): Promise<{ readonly file: DayEvidenceFile | null; readonly status: StatusPresentation }>;
}

export function createDayEvidenceSession(ports: DayEvidencePorts): DayEvidenceSession {
  const text = (lang: Lang, key: EvidenceCopyKey): string => translator(DAY_EVIDENCE_COPY, lang)(key);
  const failed = (lang: Lang, r: { readonly kind: 'refused' | 'lost_link' }): StatusPresentation => (r.kind === 'lost_link'
    ? presentStatus({ tone: 'degraded', icon: '⚠', label: text(lang, 'lostLink'), needsAttention: true })
    : presentStatus({ tone: 'error', icon: '✕', label: text(lang, 'refused'), needsAttention: true }));
  return {
    text,
    rows: async (lang, tradingDay) => {
      if (!ports.mayRead()) return { rows: [], status: presentStatus({ tone: 'error', icon: '✕', label: text(lang, 'notPermitted'), needsAttention: true }) };
      const r = await ports.closes();
      if (r.kind !== 'ok') return { rows: [], status: failed(lang, r) };
      const rows = r.value.filter((c) => c.tradingDay === tradingDay).sort((a, b) => a.storeId.localeCompare(b.storeId) || a.dayCloseId.localeCompare(b.dayCloseId))
        .map((c): PresentedCloseRow => ({
          dayCloseId: c.dayCloseId, storeLabel: `${text(lang, 'store')} ${c.storeId} · ${c.dayCloseId}`,
          status: c.locked
            ? presentStatus({ tone: 'ok', icon: '✓', label: text(lang, 'locked'), needsAttention: false })
            : presentStatus({ tone: 'degraded', icon: '⚠', label: text(lang, 'reopened'), needsAttention: true }),
        }));
      return { rows, status: rows.length > 0 ? null : presentStatus({ tone: 'idle', icon: '○', label: text(lang, 'none'), needsAttention: false }) };
    },
    download: async (lang, dayCloseId, format) => {
      if (!ports.mayRead()) return { file: null, status: presentStatus({ tone: 'error', icon: '✕', label: text(lang, 'notPermitted'), needsAttention: true }) };
      const r = await ports.pack(dayCloseId);
      if (r.kind !== 'ok') return { file: null, status: failed(lang, r) };
      const { pack, csv, fileName } = r.value;
      const file: DayEvidenceFile = format === 'csv'
        ? { fileName: `${fileName}.csv`, mime: 'text/csv;charset=utf-8', content: csv }
        : { fileName: `${fileName}.json`, mime: 'application/json', content: `${JSON.stringify(pack, null, 2)}\n` };
      const label = `${text(lang, 'ready')}: ${file.fileName} · ${text(lang, 'seal')} ${pack.contentHash.slice(0, 12)}…${pack.final ? '' : ` · ${text(lang, 'notFinal')}`}`;
      return { file, status: presentStatus({ tone: pack.final ? 'ok' : 'degraded', icon: pack.final ? '✓' : '⚠', label, needsAttention: !pack.final }) };
    },
  };
}

/** Head office's live reads, in the viewer's own session (`credentials: 'same-origin'`); a network failure is a lost link. */
export function openDayEvidencePorts(permissions: readonly string[] | undefined, fetchFn: typeof fetch | undefined = (globalThis as { fetch?: typeof fetch }).fetch): DayEvidencePorts {
  const get = async <T>(path: string): Promise<ReadResult<T>> => {
    if (fetchFn === undefined) return { kind: 'lost_link' };
    try {
      const res = await fetchFn(path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (res.status >= 400) return { kind: 'refused', status: res.status };
      return { kind: 'ok', value: (await res.json()) as T };
    } catch {
      return { kind: 'lost_link' };
    }
  };
  const held = new Set(permissions ?? []);
  return {
    mayRead: () => held.has('till.dayclose.read'),
    closes: async () => {
      const r = await get<{ dayCloses?: readonly DayEvidenceCloseRow[] }>('/v1/pos/day-close');
      return r.kind === 'ok' ? { kind: 'ok', value: Array.isArray(r.value.dayCloses) ? r.value.dayCloses : [] } : r;
    },
    pack: (dayCloseId) => get<DayEvidenceReply>(`/v1/pos/day-close/${encodeURIComponent(dayCloseId)}/evidence-pack`),
  };
}
