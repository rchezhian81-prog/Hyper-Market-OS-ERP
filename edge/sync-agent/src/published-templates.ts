// The PUBLISHED document templates, pulled by the store box (M01-FR-02 · §31 · P-01 · P-08 · hard rule #4).
//
// Head office drafts, a second person approves, and a version is PUBLISHED (`services/platform/src/
// document-templates.ts`). The receipt a lane prints must carry that header and footer — the store name,
// the GSTIN, the returns terms — and it must carry them with the cable out, so the words cannot be fetched
// at print time. They travel the way the catalogue and the migration register do: an INBOUND pull on the
// box's sync loop, taken only when it is this shop's and not older than what is held, laid into the lane's
// pack, persisted so a reboot keeps it.
//
// Shaped like `migration-feed.ts`: a `PublishedTemplatesSource` fetches `GET /v1/org/document-templates/
// published`, and `pullPublishedTemplates` decides — without a network — whether the box takes what came
// back. The reader is defensive: a body that is not a set of templates is "could not get it", never a
// blank header on the next bill (P-08). Nothing here invents a template: a shop with none published prints
// with the pack defaults it always had, and the version stamp is simply absent.

import { DOCUMENT_KINDS, TEMPLATE_LANGUAGES, type DocumentKind, type DocumentTemplateContent } from '../../../packages/org/src/document-templates';

/** One kind's version in force, exactly as the cloud publishes it — content and version, nothing about people. */
export interface PublishedTemplate {
  readonly kind: DocumentKind;
  readonly version: number;
  readonly content: DocumentTemplateContent;
  readonly publishedAt: string;
}

/** `GET /v1/org/document-templates/published` — every kind's version in force, with the cloud's clock on it. */
export interface PublishedTemplatesFeed {
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly templates: readonly PublishedTemplate[];
}

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isLines = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((l) => typeof l === 'string');

function readContent(raw: unknown): DocumentTemplateContent | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if (!isLines(c['header']) || !isLines(c['footer'])) return undefined;
  if (!(TEMPLATE_LANGUAGES as readonly string[]).includes(c['language'] as string)) return undefined;
  if (c['terms'] !== undefined && !isLines(c['terms'])) return undefined;
  if (c['paperFormat'] !== undefined && typeof c['paperFormat'] !== 'string') return undefined;
  return {
    header: [...c['header']], footer: [...c['footer']], language: c['language'] as DocumentTemplateContent['language'],
    ...(c['terms'] === undefined ? {} : { terms: [...(c['terms'] as readonly string[])] }),
    ...(c['paperFormat'] === undefined ? {} : { paperFormat: c['paperFormat'] as string }),
  };
}

function readTemplate(raw: unknown): PublishedTemplate | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  if (!(DOCUMENT_KINDS as readonly string[]).includes(t['kind'] as string)) return undefined;
  if (typeof t['version'] !== 'number' || !Number.isInteger(t['version']) || t['version'] <= 0) return undefined;
  const content = readContent(t['content']);
  if (content === undefined || !isIso(t['publishedAt'])) return undefined;
  return { kind: t['kind'] as DocumentKind, version: t['version'], content, publishedAt: t['publishedAt'] };
}

/** What the box accepts as a set of published templates; `undefined` for anything it cannot interpret. */
export function readPublishedTemplatesFeed(raw: unknown): PublishedTemplatesFeed | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  if (typeof f['tenantId'] !== 'string' || f['tenantId'] === '' || !isIso(f['generatedAt'])) return undefined;
  if (!Array.isArray(f['templates'])) return undefined;
  const templates: PublishedTemplate[] = [];
  const seen = new Set<string>();
  for (const item of f['templates']) {
    const t = readTemplate(item);
    if (t === undefined || seen.has(t.kind)) return undefined; // one version in force per kind, or it is not a feed
    seen.add(t.kind);
    templates.push(t);
  }
  return { tenantId: f['tenantId'], generatedAt: f['generatedAt'], templates };
}

export type PublishedTemplatesFetch =
  | { readonly status: 'fetched'; readonly feed: PublishedTemplatesFeed }
  /** Offline, timed out, a 5xx, a 403 (the box's login lacks the read), a body that is not a feed — keep what is held. */
  | { readonly status: 'unreachable'; readonly reason: string };

export interface PublishedTemplatesSource {
  fetch(): Promise<PublishedTemplatesFetch>;
}

export interface HttpPublishedTemplatesSourceOptions {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  readonly timeoutMs?: number;
  /** Injected so the source stays testable without a network. */
  readonly fetch: typeof globalThis.fetch;
}

/** Reach the real endpoint. `GET /v1/org/document-templates/published` returns the tenant's versions in force. */
export function httpPublishedTemplatesSource(options: HttpPublishedTemplatesSourceOptions): PublishedTemplatesSource {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    fetch: async (): Promise<PublishedTemplatesFetch> => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        const response = await options.fetch(`${base}/v1/org/document-templates/published`, {
          method: 'GET',
          headers: { authorization: `Bearer ${options.token}` },
          signal: controller.signal,
        });
        // The status, never the body: a body can echo the request (#4).
        if (response.status < 200 || response.status >= 300) {
          return { status: 'unreachable', reason: `the cloud answered ${response.status} for the published templates` };
        }
        const feed = readPublishedTemplatesFeed(await response.json() as unknown);
        if (feed === undefined) return { status: 'unreachable', reason: 'the cloud returned something that is not a set of published templates' };
        return { status: 'fetched', feed };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          status: 'unreachable',
          reason: aborted
            ? `no answer within ${timeoutMs}ms — the lanes keep the templates this box holds`
            : 'could not reach the cloud — the lanes keep the templates this box holds',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The minimal view of the box the puller drives — structurally satisfied by the composition root. */
export interface PublishedTemplatesReceiver {
  readonly tenantId: string;
  /** The templates this box holds now, or undefined if it has never taken any. */
  heldTemplates(): PublishedTemplatesFeed | undefined;
  /** Take `feed` as the templates the lanes print with from now on. Called for a newer AND for a re-confirmed one. */
  takeTemplates(feed: PublishedTemplatesFeed, receivedAt: string): void;
}

export type PublishedTemplatesPullStatus =
  /** Different templates were taken — a new version in force somewhere. The lanes now print with them. */
  | 'updated'
  /** The cloud re-confirmed what the box already holds (same content, newer clock). Taken, quietly. */
  | 'unchanged'
  /** A feed was seen and not taken — another shop's, or generated before the one held. */
  | 'kept'
  /** The cloud could not be reached — held templates kept, will try again next pass. */
  | 'offline';

export interface PublishedTemplatesPullOutcome {
  readonly status: PublishedTemplatesPullStatus;
  /** The cloud clock of the templates the box holds after this pull; null if it holds none. */
  readonly generatedAt: string | null;
  /** The receipt template version in force on this box after the pull, or null when none is published. */
  readonly receiptVersion: number | null;
  readonly staffMessage: string;
  /** Only for `offline` and `kept`: why. Never contains the token (#4). */
  readonly reason?: string;
}

/** The content of a feed with the clock taken off — what "the same templates" means. */
export function templatesDigest(feed: PublishedTemplatesFeed): string {
  return JSON.stringify([...feed.templates].sort((a, b) => a.kind.localeCompare(b.kind)));
}

export const receiptVersionOf = (feed: PublishedTemplatesFeed | undefined): number | null =>
  feed?.templates.find((t) => t.kind === 'receipt')?.version ?? null;

/**
 * Pull the cloud's published templates and, if they are this shop's and not older than what is held, put
 * the box on them. `now` is injected so the outcome is deterministic.
 */
export async function pullPublishedTemplates(input: {
  readonly source: PublishedTemplatesSource;
  readonly receiver: PublishedTemplatesReceiver;
  readonly now: string;
}): Promise<PublishedTemplatesPullOutcome> {
  const held = input.receiver.heldTemplates();
  const shown = (): { generatedAt: string | null; receiptVersion: number | null } => {
    const h = input.receiver.heldTemplates();
    return { generatedAt: h?.generatedAt ?? null, receiptVersion: receiptVersionOf(h) };
  };
  const asHeld = (): string => {
    const h = input.receiver.heldTemplates();
    if (h === undefined) return 'the lanes print with the pack defaults — no published template has reached this box yet';
    const v = receiptVersionOf(h);
    return v === null
      ? `the lanes print with the pack defaults — nothing published for receipts as of ${h.generatedAt}`
      : `the lanes print with receipt template v${v} (as of ${h.generatedAt})`;
  };

  const result = await input.source.fetch();
  if (result.status === 'unreachable') {
    return { status: 'offline', ...shown(), staffMessage: `Cloud not reachable — ${asHeld()}.`, reason: result.reason };
  }
  const feed = result.feed;
  if (feed.tenantId !== input.receiver.tenantId) {
    return { status: 'kept', ...shown(), staffMessage: `The cloud answered with another shop's templates — ignored; ${asHeld()}.`, reason: 'tenant mismatch' };
  }
  if (held !== undefined && Date.parse(feed.generatedAt) < Date.parse(held.generatedAt)) {
    return { status: 'kept', ...shown(), staffMessage: `The cloud answered with OLDER templates than this box holds — ignored; ${asHeld()}.`, reason: 'older than held' };
  }
  const changed = held === undefined || templatesDigest(held) !== templatesDigest(feed);
  input.receiver.takeTemplates(feed, input.now);
  const v = receiptVersionOf(feed);
  return {
    status: changed ? 'updated' : 'unchanged',
    ...shown(),
    staffMessage: changed
      ? `Document templates updated from the cloud (as of ${feed.generatedAt}, ${feed.templates.length} kind(s) in force${v === null ? ', no receipt template published' : `; receipts now print with template v${v}`}).`
      : `Document templates re-confirmed by the cloud (as of ${feed.generatedAt}).`,
  };
}
