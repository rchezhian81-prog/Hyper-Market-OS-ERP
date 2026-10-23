// Types for scripts/lib/push-findings.mjs (OB-331) — the CI findings push, tested from TypeScript.

export declare const PUSH_PATH: string;

export type PushOutcome = 'sent' | 'already_recorded' | 'refused' | 'unreachable' | 'unreadable';

export interface PushResult {
  readonly sent: number;
  readonly notSent: number;
  readonly why: 'no_key_set' | 'no_register_address' | 'not_https' | null;
  readonly results: readonly { readonly file: string; readonly outcome: PushOutcome; readonly status?: number }[];
}

export declare function pushFindings(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly reports: readonly string[];
  readonly read: (file: string) => Promise<string>;
  readonly fetch: typeof fetch;
  readonly say: (line: string) => void;
}): Promise<PushResult>;
