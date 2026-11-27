// The API's side of the store PC's sealed office calls — audit C-1 · ADR-0033 amendment 3 (see
// packages/identity/src/office-call-seal.ts). A bearer credential starting `sre-office-call.` is checked against the
// request it arrived with; anything else goes to the ordinary sign-in authenticator unchanged. With no privilege-seal key
// configured (head office in the cloud, or a store PC set up before step 4a) an office-call seal is never believed.

import type { AuthenticationContext, Principal } from '../../kernel/src/pipeline';
import { OFFICE_CALL_AMR, OFFICE_CALL_PREFIX, OfficeCallNonces, checkOfficeCall, officeCallKey, type OfficeCallRefusal } from '../../../packages/identity/src/office-call-seal';
import type { TokenRevocationList } from './revocation';

/** Refusals of a seal whose MAC verified with this store PC's key (checked before any of these). */
const SEALED_BUT_REFUSED: ReadonlySet<OfficeCallRefusal> = new Set<OfficeCallRefusal>(['not_this_request', 'stale', 'in_the_future', 'used_before']);

type Auth = (token: string, request?: AuthenticationContext) => Promise<Principal | undefined> | Principal | undefined;

export function withOfficeCalls(input: {
  /** `privilegeSealKey(BOX_PRIVILEGE_SEAL_KEY)`, or undefined when this API holds none. */
  readonly privilegeKey: Buffer | undefined;
  readonly fallback: Auth;
  /** A person whose sign-ins were revoked ("sign me out everywhere", a leaver) is refused here too. */
  readonly revocations?: TokenRevocationList;
  readonly onRefusal?: (detail: string) => void;
  readonly now?: () => number;
}): Auth {
  const key = input.privilegeKey === undefined ? undefined : officeCallKey(input.privilegeKey);
  const nonces = new OfficeCallNonces();
  const now = input.now ?? (() => Date.now());
  return async (token, request) => {
    if (!token.startsWith(OFFICE_CALL_PREFIX)) return input.fallback(token, request);
    if (key === undefined || request === undefined) {
      input.onRefusal?.('office-call seal offered, but this API holds no privilege-seal key');
      request?.onRefused?.({ signatureVerified: false, reason: 'no_privilege_seal_key' });
      return undefined;
    }
    const verdict = checkOfficeCall(key, token, request, now(), nonces);
    if (!verdict.ok) {
      input.onRefusal?.(`office-call seal refused: ${verdict.detail}`);
      // Audit 27 Nov item 1: a seal this store PC's key made — only too old, used before or for another request — is not a
      // guess, so the sign-in lockout does not count it. A seal that does not match, or cannot be read, does count.
      request.onRefused?.({ signatureVerified: SEALED_BUT_REFUSED.has(verdict.refusedBecause), reason: verdict.refusedBecause });
      return undefined;
    }
    const c = verdict.claims;
    if (input.revocations !== undefined) {
      const decision = await input.revocations.isRevoked(c.tenantId, { sub: c.userId, iat: c.signedInAt });
      if (decision.revoked) {
        input.onRefusal?.(`office-call refused: ${decision.because ?? 'revoked'}`);
        request.onRefused?.({ signatureVerified: true, reason: 'revoked' });
        return undefined;
      }
    }
    // OB-840 · ADR-0035: a call the store PC's remote door carried keeps the relay sign-in's methods and its remote mark, so
    // what it records (an approval decision) says it came remotely. Every in-store call is a PIN sign-in, as before.
    if (c.via === 'remote') return { tenantId: c.tenantId, userId: c.userId, branchId: c.branchId, authTime: c.signedInAt, amr: c.amr ?? [], via: 'remote' };
    return { tenantId: c.tenantId, userId: c.userId, branchId: c.branchId, authTime: c.signedInAt, amr: OFFICE_CALL_AMR };
  };
}
