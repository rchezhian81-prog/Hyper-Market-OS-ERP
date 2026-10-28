// R8-A · head office's answer to "may MY app still start new work?" (OB-521 · M33-FR-02 · D12-FR-03 · A-10 · P-08).
// Import and registration lines only in `main.ts`.
//
// The phone apps that talk to head office (the customer app — its orders go to head office's storefront) learn the app
// version policy from head office itself, as the person signed in on the phone: `GET /v1/me/app-version-policy`. It is
// the SAME stored policy the store pack carries to the store computer (services/platform/src/version-policy.ts) — the
// version numbers only, nothing about any other person or device. `policy: null` when none has been set: nothing is being
// enforced, and it says so (never a guessed rule). Any signed-in person may read it (`identity.self.read`: the rule their
// own app is judged by); setting or withdrawing a version stays `platform.device.manage` on the existing routes.
//
// Reads only. Nothing here changes a version (P-05).

import type { Route } from '../../kernel/src/index';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { versionPolicyAdapter } from './adapters';

export const APP_VERSION_POLICY_PATH = '/v1/me/app-version-policy';

export function appVersionPolicyRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string }): readonly Route[] {
  const policyOf = input.store === undefined ? async () => undefined : versionPolicyAdapter({ store: input.store, now: input.now }).policy;
  return [
    {
      api: 'API-10', method: 'GET', path: APP_VERSION_POLICY_PATH,
      permission: 'identity.self.read',
      handler: async (ctx) => {
        const policy = await policyOf(ctx.tenantId);
        return { status: 200, body: { policy: policy ?? null, asAt: input.now() } };
      },
    },
  ];
}
