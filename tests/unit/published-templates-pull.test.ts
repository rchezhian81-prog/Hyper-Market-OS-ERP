import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  httpPublishedTemplatesSource, pullPublishedTemplates, readPublishedTemplatesFeed, templatesDigest, receiptVersionOf,
  type PublishedTemplatesFeed, type PublishedTemplatesSource, type PublishedTemplatesFetch, type PublishedTemplatesReceiver,
} from '../../edge/sync-agent/src/index';
import { emptyPack, readPack, withPublishedTemplates, type StorePack } from '../../edge/store-edge/src/store-pack';
import { posReceiptTemplate, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { readHeldPublishedTemplates, writeHeldPublishedTemplates } from '../../edge/store-edge/src/published-templates-file';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **The box pulls the PUBLISHED document templates (M01-FR-02 · §31 · P-01 · P-08 · #4).**
 *
 * Units, each without a network: the reader (what counts as a set of templates); the HTTP source ("got them" vs
 * "could not", the token never in a reason); the puller (this shop's, not older, changed or re-confirmed); the
 * store-pack merge (the set is REPLACED by what is in force — a kind no longer published leaves the pack; every
 * other section untouched); the till's receipt-template global (absent = print with defaults, stamp no version);
 * and the disk file a reboot restores from (another shop's or a torn file is ignored, never printed).
 */

const NOW = '2026-09-29T12:00:00.000Z';
const T = 't-sre';
const TOKEN = ['unit', 'templates', 'token'].join('-').padEnd(40, 'z');

const RECEIPT = { header: ['SRE Hyper Market', 'GSTIN: 33ABCDE1234F1Z5'], footer: ['Thank you — please visit again'], language: 'en_ta' as const, paperFormat: 'thermal-80' };
const feed = (over: Partial<PublishedTemplatesFeed> = {}): PublishedTemplatesFeed => ({
  tenantId: T, generatedAt: '2026-09-29T11:00:00.000Z',
  templates: [
    { kind: 'receipt', version: 1, content: RECEIPT, publishedAt: '2026-09-28T09:00:00.000Z' },
    { kind: 'invoice', version: 2, content: { header: ['SRE Hyper Market'], footer: ['E&OE'], terms: ['Payment within 30 days'], language: 'en' }, publishedAt: '2026-09-27T09:00:00.000Z' },
  ],
  ...over,
});

const fetchReturning = (status: number, body: unknown, delayMs = 0): typeof globalThis.fetch =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;

describe('readPublishedTemplatesFeed — what the box accepts as a set of templates', () => {
  it('accepts the cloud\'s shape (including an empty set) and refuses one it cannot interpret', () => {
    expect(readPublishedTemplatesFeed(feed())).toEqual(feed());
    expect(readPublishedTemplatesFeed({ tenantId: T, generatedAt: NOW, templates: [] })).toBeDefined(); // nothing published yet is a valid answer
    expect(readPublishedTemplatesFeed(null)).toBeUndefined();
    expect(readPublishedTemplatesFeed({ generatedAt: NOW, templates: [] })).toBeUndefined();
    expect(readPublishedTemplatesFeed({ tenantId: T, generatedAt: 'soonish', templates: [] })).toBeUndefined();
    expect(readPublishedTemplatesFeed({ tenantId: T, generatedAt: NOW, templates: 'lots' })).toBeUndefined();
    const raw = (templates: unknown): unknown => ({ tenantId: T, generatedAt: NOW, templates });
    expect(readPublishedTemplatesFeed(raw([{ kind: 'poster', version: 1, content: RECEIPT, publishedAt: NOW }]))).toBeUndefined();
    expect(readPublishedTemplatesFeed(raw([{ kind: 'receipt', version: 0, content: RECEIPT, publishedAt: NOW }]))).toBeUndefined();
    expect(readPublishedTemplatesFeed(raw([{ kind: 'receipt', version: 1, content: { ...RECEIPT, header: 'SRE' }, publishedAt: NOW }]))).toBeUndefined();
    expect(readPublishedTemplatesFeed(raw([{ kind: 'receipt', version: 1, content: { ...RECEIPT, language: 'fr' }, publishedAt: NOW }]))).toBeUndefined();
    // Two versions "in force" for one kind is not a set of templates — it is a bug upstream, and the box does not pick one.
    expect(readPublishedTemplatesFeed(feed({ templates: [feed().templates[0]!, { ...feed().templates[0]!, version: 2 }] }))).toBeUndefined();
  });
});

describe('httpPublishedTemplatesSource — GET /v1/org/document-templates/published', () => {
  it('a clean 200 with a set is fetched; the request carries the bearer token and hits the one path', async () => {
    let seen: { url: string; auth: string | undefined } | undefined;
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>)['authorization'] };
      return new Response(JSON.stringify(feed()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const r = await httpPublishedTemplatesSource({ baseUrl: 'https://cloud.example.test/', token: TOKEN, fetch: f }).fetch();
    expect(r.status).toBe('fetched');
    expect(seen).toEqual({ url: 'https://cloud.example.test/v1/org/document-templates/published', auth: `Bearer ${TOKEN}` });
  });

  it('a 403, a 500, a body that is not a set, and a timeout are all "unreachable" — and the reason never carries the token (#4)', async () => {
    for (const [status, body] of [[403, { error: { code: 'forbidden' } }], [500, 'boom'], [200, { tenantId: T, generatedAt: NOW, templates: 'x' }]] as const) {
      const r = await httpPublishedTemplatesSource({ baseUrl: 'https://c.test', token: TOKEN, fetch: fetchReturning(status, body) }).fetch();
      expect(r.status).toBe('unreachable');
      expect((r as { reason: string }).reason).not.toContain(TOKEN);
    }
    const slow = await httpPublishedTemplatesSource({ baseUrl: 'https://c.test', token: TOKEN, fetch: fetchReturning(200, feed(), 500), timeoutMs: 20 }).fetch();
    expect(slow.status).toBe('unreachable');
    expect((slow as { reason: string }).reason).toContain('no answer within 20ms');
  });
});

describe('pullPublishedTemplates — this shop\'s, not older, changed or re-confirmed', () => {
  const receiver = (held?: PublishedTemplatesFeed): PublishedTemplatesReceiver & { taken: { feed: PublishedTemplatesFeed; at: string }[] } => {
    let current = held;
    const taken: { feed: PublishedTemplatesFeed; at: string }[] = [];
    return { tenantId: T, heldTemplates: () => current, takeTemplates: (f, at) => { current = f; taken.push({ feed: f, at }); }, taken };
  };
  const source = (r: PublishedTemplatesFetch): PublishedTemplatesSource => ({ fetch: async () => r });

  it('offline keeps what is held and says so — with the receipt version the lanes are printing with', async () => {
    const r = receiver(feed());
    const out = await pullPublishedTemplates({ source: source({ status: 'unreachable', reason: 'down' }), receiver: r, now: NOW });
    expect(out).toMatchObject({ status: 'offline', receiptVersion: 1, generatedAt: feed().generatedAt, reason: 'down' });
    expect(out.staffMessage).toContain('receipt template v1');
    expect(r.taken).toHaveLength(0);
    const none = await pullPublishedTemplates({ source: source({ status: 'unreachable', reason: 'down' }), receiver: receiver(), now: NOW });
    expect(none).toMatchObject({ status: 'offline', receiptVersion: null, generatedAt: null });
    expect(none.staffMessage).toContain('pack defaults');
  });

  it('another shop\'s set and an OLDER set are seen and not taken', async () => {
    const r = receiver(feed());
    const other = await pullPublishedTemplates({ source: source({ status: 'fetched', feed: feed({ tenantId: 't-other' }) }), receiver: r, now: NOW });
    expect(other).toMatchObject({ status: 'kept', reason: 'tenant mismatch' });
    const older = await pullPublishedTemplates({ source: source({ status: 'fetched', feed: feed({ generatedAt: '2026-09-01T00:00:00.000Z' }) }), receiver: r, now: NOW });
    expect(older).toMatchObject({ status: 'kept', reason: 'older than held' });
    expect(r.taken).toHaveLength(0);
  });

  it('a first or a different set is "updated"; the same content with a newer clock is "unchanged" — both taken', async () => {
    const r = receiver();
    const first = await pullPublishedTemplates({ source: source({ status: 'fetched', feed: feed() }), receiver: r, now: NOW });
    expect(first).toMatchObject({ status: 'updated', receiptVersion: 1 });
    expect(first.staffMessage).toContain('receipts now print with template v1');
    const same = await pullPublishedTemplates({ source: source({ status: 'fetched', feed: feed({ generatedAt: '2026-09-29T11:30:00.000Z' }) }), receiver: r, now: NOW });
    expect(same.status).toBe('unchanged');
    const v2 = feed({ generatedAt: '2026-09-29T11:45:00.000Z', templates: [{ ...feed().templates[0]!, version: 2, content: { ...RECEIPT, footer: ['New footer'] } }] });
    const changed = await pullPublishedTemplates({ source: source({ status: 'fetched', feed: v2 }), receiver: r, now: NOW });
    expect(changed).toMatchObject({ status: 'updated', receiptVersion: 2 });
    expect(r.taken.map((x) => x.at)).toEqual([NOW, NOW, NOW]);
    expect(templatesDigest(feed())).toBe(templatesDigest(feed({ generatedAt: 'x' })));
    expect(receiptVersionOf(feed({ templates: [] }))).toBeNull();
  });
});

describe('withPublishedTemplates — the set in force laid into the pack; nothing else touched', () => {
  const filePack = (): StorePack => readPack({ version: 7, policies: { storeName: 'SRE', currency: 'INR' }, documentTemplates: { generatedAt: '2026-09-01T00:00:00.000Z', receivedAt: '2026-09-01T00:00:00.000Z', templates: [{ kind: 'statement', version: 1, content: RECEIPT, publishedAt: '2026-09-01T00:00:00.000Z' }] } }, NOW);

  it('replaces the whole set with what the cloud says is in force — a kind no longer published leaves the pack', () => {
    const merged = withPublishedTemplates(filePack(), feed(), NOW);
    expect(merged.documentTemplates).toEqual({ known: true, value: { generatedAt: feed().generatedAt, receivedAt: NOW, templates: feed().templates } });
    expect(merged.documentTemplates.known && merged.documentTemplates.value.templates.some((t) => t.kind === 'statement')).toBe(false);
    expect(merged.version).toBe(7);
    expect(merged.policies).toEqual(filePack().policies);
    expect(merged.products.known).toBe(false); // never sent, never invented
    expect(emptyPack().documentTemplates.known).toBe(false);
  });
});

describe('posReceiptTemplate — what the till is told to print with', () => {
  const input = (pack: StorePack): ScreenInput => ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-09-29' });

  it('absent when no set has reached the box, or the set has nothing for receipts — the till prints with defaults and stamps nothing', () => {
    expect(posReceiptTemplate(input(emptyPack()))).toBeUndefined();
    expect(posReceiptTemplate(input(withPublishedTemplates(emptyPack(), feed({ templates: [feed().templates[1]!] }), NOW)))).toBeUndefined();
  });

  it('carries the header, footer, language, paper, the VERSION to stamp, and the age by the CLOUD\'s clock', () => {
    expect(posReceiptTemplate(input(withPublishedTemplates(emptyPack(), feed(), '2026-09-29T11:05:00.000Z')))).toEqual({
      version: 1, header: RECEIPT.header, footer: RECEIPT.footer, language: 'en_ta', paperFormat: 'thermal-80',
      publishedAt: '2026-09-28T09:00:00.000Z', generatedAt: feed().generatedAt, receivedAt: '2026-09-29T11:05:00.000Z', ageHours: 1,
    });
  });
});

describe('the templates on disk — what a reboot restores', () => {
  it('round-trips a taken set; ignores another shop\'s file, a torn file and a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-templates-file-'));
    try {
      expect(await readHeldPublishedTemplates(dir, T)).toBeUndefined();
      await writeHeldPublishedTemplates(dir, { feed: feed(), receivedAt: NOW });
      expect(await readHeldPublishedTemplates(dir, T)).toEqual({ feed: feed(), receivedAt: NOW });
      expect(await readHeldPublishedTemplates(dir, 't-other')).toBeUndefined();
      await writeFile(join(dir, 'document-templates.json'), '{"feed": {"tenantId": "t-sre"', 'utf8');
      expect(await readHeldPublishedTemplates(dir, T)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
