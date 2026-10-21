// Types for scripts/lib/store-computer-windows.mjs (what the store-computer tool asks Windows, read-only — OB-281 to OB-284).
import type { Deps, DoctorRow, Layout } from './store-computer.mjs';

export declare const SCRIPTS: Readonly<{ edition: string; drive: string; admins: string; acl: string }>;
export declare const SYSTEM_SID: 'S-1-5-18';
export declare function powershellPath(env: Record<string, string | undefined> | undefined): string;
export declare function ask(deps: Deps, script: string, vars?: Record<string, string>): string[][] | undefined;
export interface Edition { readonly applies: boolean; readonly known: boolean; readonly server: boolean; readonly productType?: number; readonly caption?: string }
export declare function windowsEdition(deps: Deps): Edition;
export declare function refusedOnServer(deps: Deps, edition?: Edition): boolean;
export declare function driveLetterOf(dir: string | undefined): string | undefined;
export type DriveKindName = 'removable' | 'usb' | 'internal' | 'network' | 'optical' | 'ram' | 'none' | 'unknown';
export declare function driveKind(deps: Deps, letter: string): { kind: DriveKindName; bus?: string; fixed?: boolean };
export declare function backupDriveProblem(deps: Deps, dir: string): string | undefined;
export declare function dataDriveProblem(deps: Deps, letter: string): { problem?: string; note?: string };
export declare function localAdministrators(deps: Deps): { known: false } | { known: true; me: { sid: string; name: string }; members: { sid: string; name: string; kind: 'user' | 'group'; disabled: boolean }[] };
export declare function administratorsRow(deps: Deps): DoctorRow;
export declare function folderReaders(deps: Deps, target: string): { known: false } | { known: true; me: { sid: string; name: string }; others: { sid: string; name: string }[] };
export declare function dataLockRow(deps: Deps, L: Layout, pointer: string | undefined): DoctorRow;
export declare function dockerDiskImage(deps: Deps): { known: true; folder: string; file: string } | { known: false; why: string };
export declare function dockerDiskRow(deps: Deps, dataRoot: string): DoctorRow;
