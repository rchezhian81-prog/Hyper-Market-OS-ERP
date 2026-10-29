// Round 11 · R11-A (independent check of rounds 6–10; decisions OB-504, OB-602) — head office's wiring for the gaps the
// checker found. Kept in its own file: shared files carry only import and spread lines.
//
//   • OB-504 (gap): the direct-delivery (DSD) door judges a packed product's scan by the product master's packed rule — the
//     SAME `productRule` (with the PACKED fact, r7b-receiving-adapters.ts `packagedRule`) every other receiving path reads.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { DsdCheckInDeps } from '../../inventory/src/dsd-checkin';
import { packagedRule } from './r7b-receiving-adapters';

/** OB-504 (round 11): the DSD door's product rule — head office's own master, the one the goods receipt reads. */
export function r11aDsdHooks(input: { readonly store: EventStore; readonly now: () => string }): Pick<DsdCheckInDeps, 'productRule'> {
  return { productRule: packagedRule(input).productRule };
}
