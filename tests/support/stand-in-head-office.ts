// A STAND-IN HEAD OFFICE API for the store computer's head-office sign-in tests (OB-388 · ADR-0029).
//
// It believes a bearer token exactly as head office does — the product's own `verifyToken`, RS256 against the identity
// server's key, pinned to the issuer, our audience and the one shop — and refuses a revoked person (a leaver, "sign me out
// everywhere") with 401, as head office's revocation list does. It records every call with WHOSE token it carried (or that
// it carried the store computer's machine credential, or nothing), so a test can prove each page's call went as the
// person. It answers the Month-end page's first read, and the company report's two; anything else is a plain 404.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { verifyToken } from '../../services/identity/src/token';

export interface HeadOfficeCall {
  readonly method: string;
  readonly path: string;
  /** The person head office believed from the token; 'machine' for the store computer's own credential; null for none or a refused one. */
  readonly as: string | null;
  readonly cookie: boolean;
  readonly body: string;
}

export interface StandInHeadOffice {
  readonly base: string;
  readonly calls: HeadOfficeCall[];
  readonly revoked: Set<string>;
  stop(): Promise<void>;
}

export async function startStandInHeadOffice(input: {
  readonly issuer: string; readonly publicKey: KeyObject; readonly tenantId: string; readonly machineToken?: string; readonly audience?: string;
}): Promise<StandInHeadOffice> {
  const calls: HeadOfficeCall[] = [];
  const revoked = new Set<string>();
  const policy = {
    algorithm: 'RS256' as const, secret: '', keyring: { get: () => input.publicKey }, subjectClaim: 'sre_user_id',
    issuer: input.issuer, audience: input.audience ?? 'sre-retail-os-api', tenantId: input.tenantId, maxLifetimeSeconds: 2_678_400,
  };
  const json = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'ho=should-never-reach-the-browser; Path=/' }).end(JSON.stringify(body)); };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const auth = String(req.headers['authorization'] ?? '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      let as: string | null = null;
      if (input.machineToken !== undefined && token === input.machineToken) as = 'machine';
      else if (token !== '') {
        const v = verifyToken(token, policy, Date.now());
        if (v.ok && v.principal !== undefined) as = v.principal.userId;
      }
      const path = (req.url ?? '/').split('?')[0]!;
      calls.push({ method: req.method ?? 'GET', path, as, cookie: req.headers['cookie'] !== undefined, body: Buffer.concat(parts).toString('utf8') });
      if (as === null || as === 'machine' || revoked.has(as)) { json(res, 401, { error: { code: 'unauthenticated', whatHappened: 'Head office does not know who this is.' } }); return; }
      if (req.method === 'GET' && path === '/v1/finance/payment-exceptions') {
        json(res, 200, { exceptions: [], open: 0, openMinor: { card: 0, upi: 0 }, owedToCustomersMinor: 0, flagged: [], asAt: new Date().toISOString() });
        return;
      }
      if (req.method === 'GET' && path === '/v1/catalogue/products') { json(res, 200, { products: [] }); return; }
      if (req.method === 'GET' && path === '/v1/org/nodes') {
        json(res, 200, { nodes: [
          { nodeId: 'C-TEST', kind: 'company', name: 'Test Company', parentId: null, status: 'active' },
          { nodeId: 'B-TEST', kind: 'branch', name: 'Test Branch', parentId: 'C-TEST', companyId: 'C-TEST', status: 'active' },
        ] });
        return;
      }
      if (req.method === 'GET' && path === '/v1/consolidation') {
        json(res, 200, { measures: { grossMinor: 123_400 }, freshness: { state: 'fresh' }, missingBranches: [], withheldByScope: [], reconciles: true, contributors: [{ branchId: 'B-TEST', measures: { grossMinor: 123_400, netMinor: 111_000 }, lastRefreshAt: new Date().toISOString() }] });
        return;
      }
      if (req.method === 'POST' && path === '/v1/echo') { json(res, 200, { youAre: as, idempotencyKey: req.headers['idempotency-key'] ?? null, got: Buffer.concat(parts).toString('utf8') }); return; }
      json(res, 404, { error: { code: 'not_found', whatHappened: 'No such route at the stand-in head office.' } });
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(); }); });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, revoked,
    stop: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
