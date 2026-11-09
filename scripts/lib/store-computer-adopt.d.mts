// Types for scripts/lib/store-computer-adopt.mjs (moving a Docker copy onto Windows services — CR-01 step 2c, OI-08).
import type { Deps, Layout } from './store-computer.mjs';

export declare const ADOPTED_MARKER: 'adopted-from-docker.json';
export declare function adoptedMarkerPath(platform: string, dataRoot: string): string;
export declare function dockerCopyToMove(deps: Deps, L: Partial<Layout> | undefined): boolean;
export declare function adoptDockerCopy(deps: Deps, opts: { pgBin?: string; serviceHost?: string }): Promise<number>;
