// The body schemas DERIVED from the code (services/platform/src/api-body-derive.ts) for the head-office route table, the
// way the guardrail derives them: one place, so the guardrail and the tests that check the derived schemas against the
// real handlers read exactly the same thing. Test support only (it runs the compiler; ~20 s).
import { fileURLToPath } from 'node:url';
import { deriveBodies, type Derived } from '../../services/platform/src/api-body-derive';
import { buildSurface } from '../../services/api/src/main';
import { KNOWN_EVENT_TYPES } from '../../packages/contracts/src/event';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import type { Route } from '../../services/kernel/src/index';

const at = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const PACK_KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');

/**
 * The head-office route table AS PRODUCTION SERVES IT (M32-FR-01 · D14-FR-06): `startApi` always hands the surface an event
 * store, and ~47 routes (a customer's lists and favourites, the POSH register, the profit-and-loss read, the AI security
 * summaries, ...) are only mounted when there is one. Built without a store, the published contract left them out — so the
 * contract is built WITH one (in memory; nothing is persisted, the route TABLE is the same as on PostgreSQL).
 */
export const servedRoutes = (): readonly Route[] => buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal', store: new InMemoryEventStore() });

/** The route table with NO store — only to prove the published one is a superset of it (the guardrail names what a store adds). */
export const storelessRoutes = (): readonly Route[] => buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal' });

let cached: Derived | undefined;
/** Derive every route's and event's body schema from the sources (cached for the test file). */
export function derivedContract(routes: readonly Route[] = servedRoutes()): Derived {
  cached ??= deriveBodies({
    repoRoot: at('.').replace(/\/$/, ''),
    routeEntry: at('services/api/src/main.ts'),
    // The store computer builds events too (a sale, a return, a day close, a checklist): its sources are read for EVENTS only.
    eventEntries: [at('edge/store-edge/src/main.ts'), at('edge/store-edge/src/index.ts')],
    served: routes.map((r) => ({ method: r.method, path: r.path, handlerSource: r.handler.toString() })),
    eventTypes: KNOWN_EVENT_TYPES,
  });
  return cached;
}
