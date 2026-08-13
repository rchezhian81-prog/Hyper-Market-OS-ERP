// Type declarations for the completion-report script, so the integrity guardrail can import it under tsc.

export type MaturityLabel =
  | 'NOT_STARTED' | 'ENGINE_ONLY' | 'PARTIALLY_WIRED' | 'WIRED'
  | 'INTEGRATION_TESTED' | 'E2E_VERIFIED' | 'UAT_VERIFIED' | 'PRODUCTION_VERIFIED';

export declare const WEIGHTS: Readonly<Record<MaturityLabel, number>>;
export declare const LADDER: readonly MaturityLabel[];

export interface CompletionReport {
  readonly denominator: number;
  readonly weightedPoints: number;
  readonly maxPoints: number;
  readonly productCompletionPct: number;
  readonly counts: Readonly<Record<MaturityLabel, number>>;
  readonly scores: {
    readonly requirementsDesign: number;
    readonly technicalImplementation: number;
    readonly wiredAndIntegrated: number;
    readonly e2eVerification: number;
    readonly uatReadiness: number;
    readonly productionReadiness: number;
  };
  readonly blocked: readonly { readonly id: string; readonly retainedLabel: MaturityLabel; readonly blocker: string }[];
}

export declare function computeReport(ledger: {
  readonly items: readonly { readonly id: string; readonly label: MaturityLabel; readonly externalBlocker?: string; readonly evidence?: string }[];
  readonly baseline?: unknown;
}): CompletionReport;
