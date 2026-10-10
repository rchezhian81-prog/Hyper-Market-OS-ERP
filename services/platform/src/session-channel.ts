// Binding support and remote sessions to the sign-in that uses them (M33-FR-02/03 · SEC-11 · PA-10).
//
// The support-access lifecycle (support-access-lifecycle.ts) and the remote-session register (remote-sessions.ts)
// already RECORD who was given access, for what, until when, and who cut a session off. On their own they bound
// nothing: a support engineer's sign-in kept working after the owner ended the session, after its time box ran
// out, and for permissions the owner never granted. This is the missing link, consulted by the kernel on EVERY
// request whose signed token names a session (`support_session_id` / `remote_session_id`):
//
//   • the session must exist in THIS shop's register, and belong to the person signed in;
//   • it must be live NOW — a support session not ended and inside its time box; a remote session not terminated;
//   • a support session reaches only the scopes the OWNER granted (each scope names a permission). The role check
//     still runs afterwards, so a grant can narrow what the person may do, never widen it;
//   • when a support session is found past its time box, it is ENDED in the register (at its expiry moment) and
//     the token is REVOKED, so the expiry is a recorded fact and the token is dead everywhere, not only here. A
//     terminated remote session or an early-ended support session revokes the token the same way.
//
// Registers are read, never rebuilt. Append-only (hard rules #2/#6); nothing here commits business value (#5).

import type { ChannelGuard, ChannelVerdict, Principal } from '../../kernel/src/index';
import type { SupportAccessRecord, SupportAccessEvent } from './support-access-lifecycle';
import type { RemoteSession } from './remote-sessions';
import { supportSessionActive } from '../../../packages/platform-admin/src/support-access';

/**
 * Permissions a support session reaches whatever its scopes: reading one's own identity, and recording what the
 * session did on the lifecycle (the record that makes it accountable). Neither moves money, stock or privilege.
 */
export const SUPPORT_CHANNEL_ALWAYS: readonly string[] = ['identity.self.read', 'platform.support.request'];

/** Why a token was revoked by the guard — matches the identity ledger's revocation reasons. */
export interface ChannelRevocation {
  readonly tenantId: string;
  readonly tokenId: string;
  readonly reason: 'admin_revoked' | 'security';
  readonly revokedBy: string;
  readonly at: string;
}

export interface SessionChannelDeps {
  /** The support-access register, projected from its append-only log. */
  readonly supportRecords: (tenantId: string) => Promise<readonly SupportAccessRecord[]> | readonly SupportAccessRecord[];
  /** Append to the support-access log (used to record an expiry as an end). Idempotent on the key. */
  readonly recordSupportEvent: (tenantId: string, event: SupportAccessEvent, key: string) => Promise<void> | void;
  /** The remote-session register, projected from its append-only log. */
  readonly remoteSessions: (tenantId: string) => Promise<readonly RemoteSession[]> | readonly RemoteSession[];
  /** Revoke one token by id (the same list the authenticator reads). Optional: absent, refusal still holds. */
  readonly revokeToken?: (revocation: ChannelRevocation) => Promise<void> | void;
  readonly now: () => string;
}

const refuse = (code: string, why: string): ChannelVerdict => ({ ok: false, code, why });

export function sessionChannelGuard(deps: SessionChannelDeps): ChannelGuard {
  const revoke = async (p: Principal, reason: ChannelRevocation['reason'], revokedBy: string, at: string): Promise<void> => {
    if (p.tokenId === undefined || deps.revokeToken === undefined) return;
    await deps.revokeToken({ tenantId: p.tenantId, tokenId: p.tokenId, reason, revokedBy, at });
  };

  return async (principal, permission) => {
    const channel = principal.channel;
    if (channel === undefined) return { ok: true };
    const now = deps.now();

    if (channel.kind === 'support') {
      const rec = (await deps.supportRecords(principal.tenantId)).find((r) => r.requestId === channel.sessionId);
      const session = rec?.session;
      if (session === undefined) {
        return refuse('unknown_session_channel', `There is no owner-approved support session '${channel.sessionId}' in this shop.`);
      }
      if (session.requesterId !== principal.userId || session.tenantId !== principal.tenantId) {
        return refuse('session_channel_not_yours', `Support session '${channel.sessionId}' was granted to someone else.`);
      }
      if (!supportSessionActive(session, now)) {
        if (session.endedAt === undefined) {
          // Past its time box with nobody having ended it: record the expiry as the end, at the moment it expired.
          await deps.recordSupportEvent(principal.tenantId, { kind: 'ended', sessionId: session.sessionId, at: session.expiresAt }, `expired-${session.sessionId}`);
          await revoke(principal, 'security', `support-session-expiry:${session.sessionId}`, now);
          return refuse('session_channel_not_active', `Support session '${channel.sessionId}' expired at ${session.expiresAt}; its access has ended.`);
        }
        await revoke(principal, 'admin_revoked', `support-session-ended:${session.sessionId}`, now);
        return refuse('session_channel_not_active', `Support session '${channel.sessionId}' was ended at ${session.endedAt}; its access has ended.`);
      }
      if (!session.scopes.includes(permission) && !SUPPORT_CHANNEL_ALWAYS.includes(permission)) {
        return refuse('outside_session_grant', `Support session '${channel.sessionId}' was granted ${session.scopes.join(', ')} — not ${permission}.`);
      }
      return { ok: true };
    }

    const remote = (await deps.remoteSessions(principal.tenantId)).find((s) => s.sessionId === channel.sessionId);
    if (remote === undefined) {
      return refuse('unknown_session_channel', `There is no remote session '${channel.sessionId}' in this shop.`);
    }
    if (remote.userId !== principal.userId) {
      return refuse('session_channel_not_yours', `Remote session '${channel.sessionId}' belongs to someone else.`);
    }
    if (!remote.active) {
      await revoke(principal, 'admin_revoked', remote.terminatedBy ?? `remote-session-terminated:${remote.sessionId}`, now);
      return refuse('session_channel_not_active', `Remote session '${channel.sessionId}' was terminated${remote.terminatedAt === undefined ? '' : ` at ${remote.terminatedAt}`}${remote.terminatedReason === undefined ? '' : ` (${remote.terminatedReason})`}.`);
    }
    return { ok: true };
  };
}
