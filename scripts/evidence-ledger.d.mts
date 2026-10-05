// Types for scripts/evidence-ledger.mjs, so the guardrail and the unit test import the one implementation.
export const SCOPE_VERSION: string;
export const LEDGER_FILE: string;
export const REGISTER_FILE: string;
export const SCOPE_FILE: string;
export const OUT_MD: string;
export const OUT_JSON: string;
export const KINDS: readonly string[];
export const KIND_TITLES: Readonly<Record<string, string>>;
export const FAMILIES: Readonly<Record<string, readonly string[]>>;
export interface TestInfo { readonly citations: Set<string>; readonly family: string | null; readonly realDb: boolean }
export interface Session { readonly id: string; readonly date: string; readonly covers: Set<string>; readonly device: boolean; readonly deviceText: string; readonly outcome: string }
export type Evidence = Record<string, string[]>;
export interface Verdict { readonly holds: boolean; readonly why: string }
export interface LedgerItem { readonly id: string; readonly label: string; readonly counts: Record<string, number>; readonly files: Evidence; readonly holds: boolean; readonly why: string }
export interface Ledger {
  readonly scopeVersion: string;
  readonly sources: { readonly ledger: string; readonly register: string; readonly scope: string };
  readonly testFiles: number;
  readonly sessions: { readonly total: number; readonly pass: number; readonly onDevice: number };
  readonly labels: Record<string, number>;
  readonly totals: Record<string, number>;
  readonly notHolding: string[];
  readonly items: LedgerItem[];
}
export function citationsOf(text: string): Set<string>;
export function classify(path: string, source: string): { family: string | null; realDb: boolean };
export function namedTests(text: string | undefined, exists?: (p: string) => boolean): Set<string>;
export function scanTests(root?: string): Map<string, TestInfo>;
export function parseRegister(markdown: string): Session[];
export function evidenceFor(item: { id: string; evidence?: string }, tests: Map<string, TestInfo>, sessions: Session[], exists?: (p: string) => boolean): Evidence;
export function labelHolds(label: string, ev: Evidence): Verdict;
export function buildLedger(root?: string): Ledger;
export function renderMarkdown(ledger: Ledger): string;
