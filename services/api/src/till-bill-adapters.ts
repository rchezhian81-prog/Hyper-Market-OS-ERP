// Till bill and GST package (OB-288 builders · audit-1 P5: A2, A7, A8, A12, A22 · audit-2 P3: M12-FR-01, M12-FR-02,
// M13-FR-02, M14-FR-04, B8, B10, B12) — head office's wiring for it.
//
// Composition: `tillBillSurface(surface, …)` is the one line in `main.ts`. It adds this package's routes to the surface;
// the stores live in `till-bill-stores.ts`, which `adapters.ts` reads with one registration line where the catalogue pack
// assembly needs them. No route here is new permission: each reuses the code its family already gates by.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { cessRateRoutes } from '../../catalogue/src/cess-rates';
import { cessRateStore } from './till-bill-stores';

export function tillBillSurface(surface: Route[], input: { readonly store: EventStore | undefined; readonly now: () => string }): void {
  const { store, now } = input;
  // A7: the compensation-cess schedule per HSN — what the pack carries to the tills, signed.
  surface.push(...cessRateRoutes(store === undefined ? { setCess: () => {}, schedule: () => [] } : cessRateStore({ store, now })));
}
