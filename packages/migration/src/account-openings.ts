// GT-05 · MG-08 "accounting openings" · §17.1 "Finance/GST/Tally — accounts/opening … trial balance/control accounts" — the
// general-ledger OPENING load: the old system's trial balance at the opening date, one balance per ledger account (mapped to
// this system's account codes under the approved MG-03 mapping), carried into the books through the finance posting path.
//
//   • plan     — the guards every phase shares (never production, never the demo tenant, a named operator, a sealed extract),
//                every unusable line named up front (an account twice, a debit AND a credit, debits ≠ credits), and the one
//                call that RECORDS the trial balance (`POST /v1/finance/account-openings/:loadId`).
//   • execute  — runs it as the operator. Recording does NOT post: the books open only when a SECOND finance person signs it
//                off in their own session against the old system's printed totals (`…/sign-off`) — never by this tool.
//   • read back — reads what the LEDGER now holds per account and reconciles it, account by account and in total, to the old
//                system's trial balance (the figures from its own report, not recomputed from the file).

import { assertNonProduction } from './trial';
import type { LoadClient, LoadRequest, ReadBackClient } from './load';

export interface ExtractTrialBalanceLine {
  readonly accountCode: string;
  readonly accountName: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface ExtractTrialBalance {
  readonly lines: readonly ExtractTrialBalanceLine[];
  /** The totals PRINTED on the old system's trial balance — what the sign-off and the read-back reconcile to. */
  readonly oldSystemTotals: { readonly debitMinor: number; readonly creditMinor: number; readonly accountCount: number };
}

export type AccountOpeningsRequest = Pick<LoadRequest, 'target' | 'tenantId' | 'demoTenantIds' | 'operator' | 'extractSealed' | 'loadId' | 'receivedOnDate'>;

export type AccountOpeningsPlan =
  | { readonly ok: true; readonly loadId: string; readonly tenantId: string; readonly operator: string; readonly path: string; readonly body: unknown; readonly idempotencyKey: string }
  | { readonly ok: false; readonly refusedBecause: 'production_target' | 'demo_tenant' | 'tenant_mismatch' | 'no_operator' | 'extract_not_sealed' | 'malformed_rows'; readonly detail: string; readonly problems: readonly string[] };

const isId = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isMinor = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function planAccountOpenings(tb: ExtractTrialBalance, req: AccountOpeningsRequest): AccountOpeningsPlan {
  const assertion = assertNonProduction(req.target);
  if (!assertion.permitted) return { ok: false, refusedBecause: 'production_target', detail: assertion.detail, problems: [] };
  if (req.demoTenantIds.includes(req.tenantId)) return { ok: false, refusedBecause: 'demo_tenant', detail: `tenant "${req.tenantId}" is a demo tenant — real books never open in it (G4)`, problems: [] };
  if (req.tenantId !== req.target.tenantId) return { ok: false, refusedBecause: 'tenant_mismatch', detail: `the load names tenant "${req.tenantId}" but the target is for "${req.target.tenantId}"`, problems: [] };
  if (req.operator.trim() === '') return { ok: false, refusedBecause: 'no_operator', detail: 'opening the books needs a named person', problems: [] };
  if (!req.extractSealed) return { ok: false, refusedBecause: 'extract_not_sealed', detail: 'the extract has not been sealed and verified (MG-02)', problems: [] };
  const problems: string[] = [];
  const seen = new Set<string>();
  tb.lines.forEach((l, i) => {
    const at = `trial balance row ${i + 1} (${String(l.accountCode)})`;
    if (!isId(l.accountCode)) problems.push(`${at}: the account code is required`);
    else if (seen.has(l.accountCode)) problems.push(`${at}: the account appears twice — one balance per account`);
    else seen.add(l.accountCode);
    if (!isId(l.accountName)) problems.push(`${at}: the account name is required`);
    if (!isMinor(l.debitMinor) || !isMinor(l.creditMinor)) problems.push(`${at}: debit and credit must be whole non-negative paise`);
    else if (l.debitMinor > 0 && l.creditMinor > 0) problems.push(`${at}: a balance is a debit OR a credit, not both`);
  });
  if (tb.lines.length === 0) problems.push('the trial balance has no lines');
  if (problems.length === 0) {
    const dr = tb.lines.reduce((s, l) => s + l.debitMinor, 0);
    const cr = tb.lines.reduce((s, l) => s + l.creditMinor, 0);
    if (dr !== cr) problems.push(`debits ${dr} and credits ${cr} differ by ${dr - cr} paise — the trial balance does not balance`);
    if (dr !== tb.oldSystemTotals.debitMinor || cr !== tb.oldSystemTotals.creditMinor || tb.lines.length !== tb.oldSystemTotals.accountCount) {
      problems.push(`the file holds ${tb.lines.length} account(s), debits ${dr}, credits ${cr}; the old system's printed trial balance says ${tb.oldSystemTotals.accountCount} account(s), debits ${tb.oldSystemTotals.debitMinor}, credits ${tb.oldSystemTotals.creditMinor} — the extract is not the whole trial balance`);
    }
  }
  if (problems.length > 0) return { ok: false, refusedBecause: 'malformed_rows', detail: `${problems.length} trial-balance problem(s) — fix the file once, then plan again`, problems };
  return {
    ok: true, loadId: req.loadId, tenantId: req.tenantId, operator: req.operator,
    path: `/v1/finance/account-openings/${encodeURIComponent(req.loadId)}`,
    body: { openingDate: req.receivedOnDate, lines: tb.lines },
    idempotencyKey: `${req.loadId}-account-openings`,
  };
}

export interface AccountOpeningsReport { readonly ok: boolean; readonly status: number; readonly signed: boolean; readonly detail?: string }

/** Record the trial balance as the operator. It is NOT posted until a second finance person signs it off. */
export async function executeAccountOpenings(client: LoadClient, plan: Extract<AccountOpeningsPlan, { ok: true }>): Promise<AccountOpeningsReport> {
  const res = await client.request({ method: 'POST', path: plan.path, userId: plan.operator, tenantId: plan.tenantId, body: plan.body, idempotencyKey: plan.idempotencyKey });
  const ok = res.status === 200 || res.status === 201;
  const body = (res.body ?? {}) as { signed?: boolean; error?: { code?: string; whatHappened?: string } };
  return { ok, status: res.status, signed: body.signed === true, ...(ok || body.error === undefined ? {} : { detail: `${body.error.code ?? ''}: ${body.error.whatHappened ?? ''}` }) };
}

export interface AccountOpeningCheckLine {
  readonly check: 'signed' | 'account' | 'total_debit' | 'total_credit' | 'account_count' | 'opening_clearing';
  readonly key: string;
  readonly expected: number | string;
  readonly actual: number | string | null;
  readonly agrees: boolean;
  readonly note?: string;
}

/**
 * Read the LEDGER back and reconcile it to the old system's trial balance: signed by someone other than the operator, each
 * account's balance as the ledger holds it, debits / credits / account count against the old system's printed totals, and
 * the opening clearing account (when the ledger has one) at nothing. Uses the server's per-account ledger figures, never its
 * own verdict.
 */
export async function readBackAccountOpenings(client: ReadBackClient, tb: ExtractTrialBalance, req: Pick<LoadRequest, 'tenantId' | 'operator' | 'loadId'>): Promise<{ readonly lines: readonly AccountOpeningCheckLine[]; readonly differences: readonly AccountOpeningCheckLine[]; readonly agrees: boolean; readonly signed: boolean }> {
  const res = await client.request({ method: 'GET', path: `/v1/finance/account-openings/${encodeURIComponent(req.loadId)}`, userId: req.operator, tenantId: req.tenantId });
  const body = (res.body ?? {}) as { signOff?: { signedBy?: string } | null; openings?: { recordedBy?: string }; ledger?: { accountCode: string; debitMinor: number; creditMinor: number }[]; checks?: { check: string; actual: number | null }[] };
  const lines: AccountOpeningCheckLine[] = [];
  const signedBy = res.status === 200 ? body.signOff?.signedBy : undefined;
  lines.push({ check: 'signed', key: req.loadId, expected: 'signed by a second finance person', actual: signedBy ?? null,
    agrees: signedBy !== undefined && signedBy !== body.openings?.recordedBy,
    ...(signedBy === undefined ? { note: res.status === 200 ? 'recorded, awaiting the second finance person\'s sign-off — not yet the books' : `not readable (${res.status})` } : {}) });
  const ledger = new Map((body.ledger ?? []).map((l) => [l.accountCode, l] as const));
  for (const l of tb.lines) {
    const got = ledger.get(l.accountCode);
    const expected = l.debitMinor - l.creditMinor;
    const actual = got === undefined ? null : got.debitMinor - got.creditMinor;
    lines.push({ check: 'account', key: `${l.accountCode} ${l.accountName}`, expected, actual, agrees: actual === expected || (expected === 0 && actual === null) });
  }
  for (const code of ledger.keys()) if (!tb.lines.some((l) => l.accountCode === code)) lines.push({ check: 'account', key: code, expected: 0, actual: (ledger.get(code)!.debitMinor - ledger.get(code)!.creditMinor), agrees: false, note: 'in the ledger, not on the old trial balance' });
  const dr = [...ledger.values()].reduce((s, l) => s + l.debitMinor, 0);
  const cr = [...ledger.values()].reduce((s, l) => s + l.creditMinor, 0);
  lines.push({ check: 'total_debit', key: 'debits', expected: tb.oldSystemTotals.debitMinor, actual: dr, agrees: dr === tb.oldSystemTotals.debitMinor });
  lines.push({ check: 'total_credit', key: 'credits', expected: tb.oldSystemTotals.creditMinor, actual: cr, agrees: cr === tb.oldSystemTotals.creditMinor });
  const nonZero = tb.lines.filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0).length;
  lines.push({ check: 'account_count', key: 'accounts with a balance', expected: nonZero, actual: ledger.size, agrees: ledger.size === nonZero });
  const clearing = (body.checks ?? []).find((c) => c.check === 'opening_clearing');
  if (clearing !== undefined) lines.push({ check: 'opening_clearing', key: 'opening_balances', expected: 0, actual: clearing.actual, agrees: clearing.actual === 0, ...(clearing.actual === 0 ? {} : { note: 'the sub-ledger openings and the trial balance\'s control figure do not agree, or one is not posted yet' }) });
  const differences = lines.filter((l) => !l.agrees);
  return { lines, differences, agrees: differences.length === 0, signed: signedBy !== undefined };
}
