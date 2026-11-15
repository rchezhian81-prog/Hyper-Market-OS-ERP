// Types for scripts/lib/store-computer-licence.mjs (`store-computer licence` — CR-01 step 5, OI-10).
import type { Deps } from './store-computer.mjs';

export declare const REQUEST_FILE: 'licence-request.json';
export declare function shopIdentity(deps: Deps, edgeData: string): { tenantId?: string; shopName?: string; gstin?: string };
export declare function licenceCommand(deps: Deps & { now?: () => Date }, o: { load?: string; request?: boolean; out?: string }): Promise<number>;
