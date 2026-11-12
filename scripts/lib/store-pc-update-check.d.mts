// Types for scripts/lib/store-pc-update-check.mjs (the store PC learns of a newer release — CR-01 step 3b).
import type { Deps } from './store-computer.mjs';

export declare const UPDATE_REPO: string;
export declare const LATEST_RELEASE_URL: string;
export declare const UPDATE_KEY_FILE: 'update-key';
export declare const UPDATE_STATE_FILE: 'update-check.json';
export declare const PUBLIC_KEY_FILE: 'release-signing.pub';
export declare const KEY_SHAPE: RegExp;

export interface UpdateCheckState {
  kind: 'sre-store-pc-update-check-v1';
  checkedAt: string;
  running: string | null;
  withKey: boolean;
  state: 'up-to-date' | 'available' | 'not-installable' | 'could-not-check';
  latest: string | null;
  tag?: string | null;
  commit?: string;
  sha256?: string;
  said: string;
}

type Where = { dataRoot?: string; statusDir?: string };
export declare function keptKey(deps: Deps, L: Where): string | undefined;
export declare function checkForUpdate(deps: Deps, L: Where): Promise<{ code: number; state: UpdateCheckState }>;
export declare function checkUpdateCommand(deps: Deps, L: Where): Promise<number>;
export declare function updateKeyCommand(deps: Deps, L: Where, opts?: { remove?: boolean }): Promise<number>;
export declare const AUTO_CHECK_HOURS: number;
export declare function checkIfDue(deps: Deps, L: Where, hours?: number): Promise<'not-due' | 'checked' | 'failed'>;
