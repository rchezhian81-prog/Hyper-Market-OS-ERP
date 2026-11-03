// Failed jobs (W4 · M35-FR-03 · P-08 · P-03) — a tested, DOM-free session over head office's background-job register
// (services/platform/src/background-jobs.ts), which no screen reached: a job that failed overnight (a settings pack that
// would not build, a report that never ran) was kept on the record with its error, but nobody could see it or send it
// round again without a programmer.
//   • FAILED JOBS — only the jobs whose last run failed, each with what kind of work it is, how often it has run, how often
//     a person has sent it round again, when it last ran and the error it gave (`GET /v1/platform/jobs/failed`). A read;
//   • RETRY — a named person sends ONE failed job round again (`POST /v1/platform/jobs/:jobId/retry`). Head office re-checks
//     that the job really failed and refuses anything else, in its words; the retry is a new fact on the job's history
//     (append-only), never an edit of the failure.
// Reading needs `platform.job.read`; retrying `platform.job.manage`. Head office re-checks each. Every word this page adds
// has a Tamil twin; head office's own sentences stay in English (OB-553).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const FAILED_JOBS_COPY = {
  en: {
    title: 'Failed jobs',
    lead: 'Work the system does by itself in the background — building the settings for the store computers, preparing a report — that failed the last time it ran. Each one stays here, with the error it gave, until it runs again and succeeds. Send a job round again once whatever stopped it has been put right.',
    listH: 'Jobs that failed', none: 'No job has failed. Every background job either ran or is waiting to run.',
    kind: 'kind', runs: 'runs', retries: 'sent round again', lastRun: 'last ran', error: 'error', notRun: 'not run yet',
    retry: 'Run it again', retried: 'Sent round again. It is waiting to run.', asAt: 'as at',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the background jobs.', cannotRetry: 'You can see the failed jobs; sending one round again needs the system administrator\'s permission.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Asking head office…',
  },
  ta: {
    title: 'தோல்வியடைந்த பணிகள்',
    lead: 'அமைப்பு தானாகப் பின்னணியில் செய்யும் வேலைகள் — கடைக் கணினிகளுக்கான அமைப்புகளைத் தயாரித்தல், அறிக்கை தயாரித்தல் — கடைசியாக இயங்கியபோது தோல்வியடைந்தவை. ஒவ்வொன்றும் அதன் பிழையுடன், மீண்டும் இயங்கி வெற்றிபெறும் வரை இங்கே இருக்கும். தடுத்ததைச் சரிசெய்த பிறகு பணியை மீண்டும் அனுப்புங்கள்.',
    listH: 'தோல்வியடைந்த பணிகள்', none: 'எந்தப் பணியும் தோல்வியடையவில்லை. ஒவ்வொரு பின்னணிப் பணியும் இயங்கியது அல்லது இயங்கக் காத்திருக்கிறது.',
    kind: 'வகை', runs: 'இயக்கங்கள்', retries: 'மீண்டும் அனுப்பப்பட்டது', lastRun: 'கடைசியாக இயங்கியது', error: 'பிழை', notRun: 'இன்னும் இயங்கவில்லை',
    retry: 'மீண்டும் இயக்கு', retried: 'மீண்டும் அனுப்பப்பட்டது. இயங்கக் காத்திருக்கிறது.', asAt: 'நேரம்',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு பின்னணிப் பணிகளைப் பார்க்க முடியாது.', cannotRetry: 'தோல்வியடைந்த பணிகளைப் பார்க்கலாம்; மீண்டும் அனுப்ப அமைப்பு நிர்வாகி அனுமதி தேவை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const failedJobsWords = (lang: Lang, key: string): string =>
  (FAILED_JOBS_COPY[lang] as Record<string, string>)[key] ?? (FAILED_JOBS_COPY.en as Record<string, string>)[key] ?? key;
export const failedJobsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => failedJobsWords(lang, k), out);

export interface FailedJobRow {
  readonly jobId: string; readonly kind: string; readonly attempts: number; readonly retries: number;
  readonly lastRunAt?: string; readonly lastError: string;
}
export interface FailedJobs { readonly jobs: readonly FailedJobRow[]; readonly asAt: string }

type Why = 'nobody' | 'cannotRead' | 'cannotRetry';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface FailedJobsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly retry: boolean };
  failed(): Done<FailedJobs>;
  retry(jobId: string): Done<{ readonly retries: number }>;
}

export function createFailedJobsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): FailedJobsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('platform.job.read'), retry: named && held.has('platform.job.manage') };
  const call = makeCaller({ keyPrefix: 'failed-jobs', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'retry') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotRetry') : undefined);
  return {
    may,
    failed: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ jobs?: unknown[]; asAt?: unknown }>('GET', '/v1/platform/jobs/failed');
      if (out.result !== 'ok') return out;
      const jobs = (out.value.jobs ?? []).flatMap((j): FailedJobRow[] => (isObj(j) && typeof j['jobId'] === 'string' ? [{
        jobId: j['jobId'], kind: str(j['kind']), attempts: num(j['attempts']), retries: num(j['retries']),
        ...(typeof j['lastRunAt'] === 'string' ? { lastRunAt: j['lastRunAt'] } : {}), lastError: str(j['lastError']),
      }] : []));
      // The most recent failure first — the one a person is most likely being asked about.
      jobs.sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '') || a.jobId.localeCompare(b.jobId));
      return { result: 'ok', value: { jobs, asAt: str(out.value.asAt) } };
    },
    retry: async (jobId) => {
      const g = gate('retry'); if (g) return g;
      const out = await call<{ retries?: unknown }>('POST', `/v1/platform/jobs/${encodeURIComponent(jobId)}/retry`, {});
      return out.result === 'ok' ? { result: 'ok', value: { retries: num(out.value.retries) } } : out;
    },
  };
}
