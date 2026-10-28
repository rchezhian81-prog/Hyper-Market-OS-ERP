// The test ports for the REAL customer sign-in service (services/identity/src/customer-sign-in.ts · M20-FR-01 · ADR-0031).
//
// Production composes that service with no SMS provider and no signer (none is chosen). A test puts in:
//   • the recording SMS transport (`createOtpSimulator`) — it keeps the code it "sent", so the test reads it like a
//     customer reads an SMS;
//   • a signer backed by the local TEST identity provider (it mints — which is why it lives here, in tests/support, where
//     the `no-test-idp-in-production` guardrail keeps it out of production).
// And `mountCustomerSignIn` hands an e2e's Node server the real handler for `/auth/otp/*`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCustomerSignInHandler, CUSTOMER_STEP_UP_POLICY, type CustomerSessionSigner, type CustomerSignInDeps } from '../../services/identity/src/customer-sign-in';
import { createOtpSimulator, type OtpSimulator } from './otp-simulator';
import type { LocalIdp } from './local-idp';
import { normaliseMobile } from '../../packages/loyalty/src/index';

/** A signer over the local test IdP: each number gets one stable subject; `onSignIn` may grant it the customer role. */
export function testCustomerSigner(input: {
  readonly idp: Pick<LocalIdp, 'issue'>;
  readonly subjectFor: (phoneNumber: string) => string;
  readonly ttlSeconds?: number;
  readonly onSignIn?: (subject: string) => Promise<void> | void;
}): CustomerSessionSigner & { readonly signedIn: string[] } {
  const signedIn: string[] = [];
  const ttl = input.ttlSeconds ?? 900;
  return {
    name: 'local test identity provider',
    signedIn,
    signIn: async ({ tenantId, phoneNumber, amr, authTimeMs }) => {
      const subject = input.subjectFor(phoneNumber);
      await input.onSignIn?.(subject);
      signedIn.push(subject);
      const authTimeFromNowSeconds = Math.round((authTimeMs - Date.now()) / 1000);
      return { subject, token: input.idp.issue({ sub: subject, tenantId, amr: [...amr], ttlSeconds: ttl, authTimeFromNowSeconds }), expiresAtMs: Date.now() + ttl * 1000 };
    },
  };
}

export interface MountedCustomerSignIn {
  readonly sms: OtpSimulator;
  readonly audit: Record<string, unknown>[];
  /** Answers the request when it is a `/auth/otp/*` one (true); otherwise leaves it alone (false). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

/** The real customer sign-in handler, mounted on an e2e's own server at `/auth/otp/*`. */
export function mountCustomerSignIn(input: Omit<CustomerSignInDeps, 'sender' | 'audit' | 'now' | 'stepUp' | 'origin'> & {
  readonly signer: CustomerSessionSigner;
  readonly origin?: string;
}): MountedCustomerSignIn {
  const recorded = createOtpSimulator();
  // The service keeps the number as the 10 digits; a test may ask for it as it typed it (`+91 …`).
  const sms: OtpSimulator = { ...recorded, codeFor: (p) => recorded.codeFor(normaliseMobile(p) ?? p) };
  const audit: Record<string, unknown>[] = [];
  let origin = input.origin;
  const handler = createCustomerSignInHandler({
    ...input, sender: recorded, stepUp: CUSTOMER_STEP_UP_POLICY, now: () => Date.now(), audit: (l) => { audit.push(l); },
    // The e2e server learns its own port only once listening; the origin is read from the first request's Host.
    get origin() { return origin ?? 'http://127.0.0.1'; },
  } as CustomerSignInDeps);
  return {
    sms, audit,
    handle: async (req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (!path.startsWith('/auth/otp/')) return false;
      origin ??= `http://${req.headers.host ?? '127.0.0.1'}`;
      const body = await new Promise<string>((resolve) => { let d = ''; req.on('data', (c) => { d += String(c); }); req.on('end', () => resolve(d)); });
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const out = await handler({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body, ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }) });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
      return true;
    },
  };
}
