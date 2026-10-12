import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSubscription, PUBLIC_ADDRESS, type Raw } from '../support/outbound-partner';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { httpsOutboundTransport, outboundTransportFromEnv } from '../../services/platform/src/https-outbound-transport';
import { verifyOutboundSignature } from '../../services/platform/src/outbound-webhooks';
import { nonPublicAddressReason } from '../../services/platform/src/public-destination';

/**
 * **D14 / M32 round 12 — the production outbound webhook transport: HTTPS to exactly the vetted address.**
 *
 * Against a local TLS server whose certificate is made at run time for a synthetic partner name (nothing secret is in
 * the repo; no partner is live):
 *   • it dials ONLY the address it is handed — the partner's name never resolves anywhere, and it still delivers — with
 *     SNI and the certificate check on the partner's NAME and the Host header the URL's host;
 *   • a certificate for another name, or one nobody trusts, is not sent to; no vetted address → nothing is sent;
 *   • a redirect is never followed — its status is the answer; a huge reply is read only up to the cap; a server that
 *     never finishes the handshake, or never answers, is given up on in time; nothing secret reaches its log line;
 *   • CONNECTED, on the real API (in memory, and with DATABASE_URL on real PostgreSQL): a partner subscription made by
 *     two people delivers a signed sale through this transport (verified by the partner), the replayed drain sends
 *     nothing twice, and a partner that redirects is dead-lettered with the 3xx recorded and its target never reached;
 *   • the SSRF guard refuses NAT64 local-use 64:ff9b:1::/48; the transport is composed only when configured.
 */

const PARTNER = 'hooks.partner-h.example.test';
const SECRET_NAME = 'partner-h-signing';
const SECRET = ['https', 'transport', 'secret', 'built', 'at', 'run', 'time'].join('-').padEnd(40, 'x');
const OWNER = 'u-owner'; const CHECKER = 'u-setup-checker';

let dir: string;
let cert: string;
let server: Server;
let port: number;
let silent: TcpServer;
let silentPort: number;
const seen: { path: string; host: string | undefined; sni: string | false | null; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
const held: Socket[] = [];

beforeAll(async () => {
  // A self-signed certificate for the synthetic partner name, made now and thrown away after (no key in the repo).
  dir = mkdtempSync(join(tmpdir(), 'sre-https-out-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', `/CN=${PARTNER}`, '-addext', `subjectAltName=DNS:${PARTNER}`], { stdio: 'ignore' });
  cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  server = createHttpsServer({ key: readFileSync(join(dir, 'k.pem')), cert }, (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      seen.push({ path: req.url ?? '', host: req.headers.host, sni: (req.socket as TLSSocket).servername, body, headers: req.headers });
      if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: `https://${PARTNER}:${port}/landed` }); res.end(); return; }
      if (req.url === '/huge') {
        // A reply that never ends: only a reader that stops at its cap gets the status before the total timeout.
        res.writeHead(200);
        const more = (): void => { if (!res.destroyed && !res.writableEnded) res.write(Buffer.alloc(64 * 1024, 120), () => setImmediate(more)); };
        res.on('close', () => { /* the reader hung up */ });
        more();
        return;
      }
      if (req.url === '/slow') { held.push(req.socket); return; } // never answers
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  // A server that accepts the connection and never speaks TLS.
  silent = createTcpServer((s) => { held.push(s); });
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  silentPort = (silent.address() as { port: number }).port;
});
afterAll(async () => {
  for (const s of held) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => silent.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const LOOP = [127, 0, 0, 1].join('.');
const hits = (path: string): number => seen.filter((s) => s.path === path).length;

describe('D14 round 12 — the HTTPS transport itself, against a local TLS server', () => {
  it('dials only the vetted address, by the partner\'s name; refuses the wrong certificate, a missing address; never follows; caps; times out; logs nothing secret', async () => {
    const said: string[] = [];
    const t = httpsOutboundTransport({ ca: cert, connectTimeoutMs: 400, totalTimeoutMs: 800, maxResponseBytes: 1_024, say: (l) => said.push(l) });
    const signature = `v1=${'ab'.repeat(32)}`;
    const headers = { 'content-type': 'application/json', 'x-sre-webhook-signature': signature };
    const body = JSON.stringify({ hello: 'partner' });

    // Delivered to the pinned address; the partner's name resolves nowhere, so no lookup could have happened.
    expect(await t.send({ url: `https://${PARTNER}:${port}/in?token=q`, headers, body, address: LOOP })).toEqual({ status: 200 });
    const got = seen.at(-1)!;
    expect(got).toMatchObject({ path: '/in?token=q', host: `${PARTNER}:${port}`, sni: PARTNER, body });
    expect(got.headers['x-sre-webhook-signature']).toBe(signature);

    // A redirect is never followed — its status is the answer, and its target is never reached.
    expect(await t.send({ url: `https://${PARTNER}:${port}/redirect`, headers, body, address: LOOP })).toEqual({ status: 302 });
    expect(hits('/redirect')).toBe(1);
    expect(hits('/landed')).toBe(0);

    // An endless reply is read only up to the cap — the status is known, the rest dropped, well inside the total timeout.
    const before = Date.now();
    expect(await t.send({ url: `https://${PARTNER}:${port}/huge`, headers, body, address: LOOP })).toEqual({ status: 200 });
    expect(Date.now() - before).toBeLessThan(800);

    // The certificate must be the partner's NAME: another name pinned to the same address is not sent to.
    const sentBefore = seen.length;
    await expect(t.send({ url: `https://impostor.example.test:${port}/in`, headers, body, address: LOOP })).rejects.toThrow();
    // …nor a certificate nobody trusts (no extra authority given).
    await expect(httpsOutboundTransport({ connectTimeoutMs: 400, totalTimeoutMs: 800 }).send({ url: `https://${PARTNER}:${port}/in`, headers, body, address: LOOP })).rejects.toThrow();
    expect(seen.length).toBe(sentBefore);

    // No vetted address (or a name instead of one): nothing is sent — the transport never looks a name up itself.
    await expect(t.send({ url: `https://${PARTNER}:${port}/in`, headers, body })).rejects.toThrow(/no vetted address/);
    await expect(t.send({ url: `https://${PARTNER}:${port}/in`, headers, body, address: PARTNER })).rejects.toThrow(/no vetted address/);
    await expect(t.send({ url: `http://${PARTNER}:${port}/in`, headers, body, address: LOOP })).rejects.toThrow(/only a plain https/);
    expect(seen.length).toBe(sentBefore);

    // A server that never finishes the TLS handshake, and one that never answers: each given up on in time.
    const t0 = Date.now();
    await expect(t.send({ url: `https://${PARTNER}:${silentPort}/in`, headers, body, address: LOOP })).rejects.toThrow(/no secure connection within 400 ms/);
    await expect(t.send({ url: `https://${PARTNER}:${port}/slow`, headers, body, address: LOOP })).rejects.toThrow(/no complete answer within 800 ms/);
    expect(Date.now() - t0).toBeLessThan(3_000);

    // Its log says host, address, status and time — never the signature, the body, the path or the query.
    expect(said.length).toBeGreaterThanOrEqual(5);
    for (const line of said) {
      expect(line).not.toContain(signature);
      expect(line).not.toContain('partner"');
      expect(line).not.toContain('token=q');
      expect(line).not.toContain('/in');
    }
    expect(said[0]).toMatch(new RegExp(`^POST to ${PARTNER.replace(/\./g, '\\.')} at ${LOOP.replace(/\./g, '\\.')} → 200 in \\d+ ms$`));
  }, 30_000);

  it('NAT64 local-use 64:ff9b:1::/48 is not public; the transport is composed only when configured', () => {
    expect(nonPublicAddressReason('64:ff9b:1::a00:1')).toMatch(/NAT64 local-use/);
    expect(nonPublicAddressReason('64:ff9b:1:abcd::1')).toMatch(/NAT64 local-use/);
    expect(nonPublicAddressReason(`64:ff9b::${PUBLIC_ADDRESS}`)).toBeUndefined(); // the well-known prefix, public IPv4 inside
    expect(outboundTransportFromEnv({})).toBeUndefined();
    expect(outboundTransportFromEnv({ OUTBOUND_WEBHOOK_TRANSPORT: 'yes' })).toBeUndefined();
    expect(outboundTransportFromEnv({ OUTBOUND_WEBHOOK_TRANSPORT: 'https' })?.name).toBe('https');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const migrations = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(migrations, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; store: () => Partial<Parameters<typeof apiHarness>[0]> }[] = [{ name: 'the in-memory event store', store: () => ({}) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', store: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });

describe.each(backings)('D14 round 12 — a partner subscription delivers through the HTTPS transport — on $name', ({ store }) => {
  it('delivers a signed sale to the vetted address, once; a redirecting partner is dead-lettered with its 3xx', async () => {
    // The guard sees the partner at a synthetic PUBLIC address; the test dials its local TLS server for that address.
    const transport = {
      ...httpsOutboundTransport({ ca: cert, connectTimeoutMs: 1_000, totalTimeoutMs: 3_000, dialForTest: (address, p) => ({ host: address === PUBLIC_ADDRESS ? LOOP : '192.0.2.1', port: p }) }),
      resolve: async () => [PUBLIC_ADDRESS],
    };
    const h: ApiHarness = apiHarness({ ...store(), outboundTransport: transport, outboundSecrets: new Map([[SECRET_NAME, SECRET]]) });
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, CHECKER, 'platform_admin');
    const raw: Raw = (method, path, user, body, key, query) => h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
    const drain = async () => { const r = await raw('POST', '/v1/integration/outbound-deliveries/drain', OWNER, {}, `drain-${randomUUID()}`); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; };
    const base = { partnerId: 'partner-h', eventTypes: ['SaleCommitted'], signingKeyRef: `vault://${SECRET_NAME}`, maxAttempts: 3 };
    const good = { ...base, url: `https://${PARTNER}:${port}/in-${T}` };
    const bounce = { ...base, url: `https://${PARTNER}:${port}/redirect-${T}` };
    for (const [id, body] of [['SUB-H', good], ['SUB-R', bounce]] as const) {
      const made = await raw('POST', `/v1/integration/outbound-webhooks/${id}`, OWNER, await approvedSubscription(raw, OWNER, CHECKER, id, body), `make-${id}`);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
    }
    await new Promise((r) => setTimeout(r, 5));
    const day = new Date().toISOString();
    expect((await raw('POST', '/v1/sales', OWNER, {
      saleId: `HTTPS-${T}`, receiptNumber: 'R-H1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: day.slice(0, 10), committedAt: day,
      totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
    }, 'sale-h1')).status).toBe(202);

    await drain();
    // The partner received ONE signed message on its own name, and the signature verifies with the shared secret.
    const mine = seen.filter((s) => s.path === `/in-${T}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ host: `${PARTNER}:${port}`, sni: PARTNER });
    expect(verifyOutboundSignature({ secret: SECRET, timestamp: String(mine[0]!.headers['x-sre-webhook-timestamp']), body: mine[0]!.body, signature: String(mine[0]!.headers['x-sre-webhook-signature']), nowMs: Date.now() })).toEqual({ ok: true });
    expect(JSON.parse(mine[0]!.body)).toMatchObject({ type: 'SaleCommitted', data: { saleId: `HTTPS-${T}` } });
    const recon = (await raw('GET', '/v1/integration/outbound-webhooks/SUB-H/reconciliation', OWNER)).body as { messages: { status: string; lastStatus: number | null }[] };
    expect(recon.messages.map((m) => [m.status, m.lastStatus])).toEqual([['delivered', 200]]);

    // The redirecting partner: dead-lettered at once with its 302 recorded; the redirect's target was never reached.
    const dead = (await raw('GET', '/v1/integration/outbound-webhooks/SUB-R/dead-letters', OWNER)).body as { deadLetters: { lastStatus: number; attempts: number; detail: string }[] };
    expect(dead.deadLetters).toHaveLength(1);
    expect(dead.deadLetters[0]).toMatchObject({ lastStatus: 302, attempts: 1 });
    expect(dead.deadLetters[0]!.detail).toMatch(/redirect \(302\) — a redirect is never followed/);
    expect(hits('/landed')).toBe(0);

    // The drain again: nothing is sent twice.
    await drain();
    expect(seen.filter((s) => s.path === `/in-${T}`)).toHaveLength(1);
    expect(seen.filter((s) => s.path === `/redirect-${T}`)).toHaveLength(1);
  }, 60_000);
});
