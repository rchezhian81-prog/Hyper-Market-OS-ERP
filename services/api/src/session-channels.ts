// Wires the support/remote session guard (PA-10 · M33-FR-02/03) to this shop's registers and its token
// revocation list — the SAME list the authenticator reads, so a token the guard revokes is refused everywhere.
// Used by the production composition (main.ts) and the test harness alike, so both run one implementation.

import type { ChannelGuard } from '../../kernel/src/index';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { TokenRevocationList } from '../../identity/src/revocation';
import { sessionChannelGuard } from '../../platform/src/session-channel';
import { supportAccessAdapter, remoteSessionsAdapter } from './adapters';

export function sessionChannelsOf(input: {
  readonly store: EventStore;
  readonly revocations: TokenRevocationList;
  readonly now: () => string;
}): ChannelGuard {
  const support = supportAccessAdapter({ store: input.store, now: input.now });
  const remote = remoteSessionsAdapter({ store: input.store, now: input.now });
  return sessionChannelGuard({
    supportRecords: support.records,
    recordSupportEvent: support.recordEvent,
    remoteSessions: remote.sessions,
    revokeToken: (r) => input.revocations.revoke(r.tenantId, {
      id: `channel-${r.tokenId}`, tenantId: r.tenantId, jti: r.tokenId,
      reason: r.reason, revokedBy: r.revokedBy, revokedAt: r.at,
    }),
    now: input.now,
  });
}
