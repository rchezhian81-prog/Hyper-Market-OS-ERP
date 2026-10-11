// GT-05 — the operator's load command, whole: the master-data and opening load (load-command.ts), then the phases that
// follow it in the runbook's order, each through the same routes a person uses and each read back:
//
//   1. the OPENING STATE read back (MG-06 · MG-08): stock by location / batch / value, points, stored value, receivables,
//      supplier openings — every figure against the sealed extract;
//   2. the ACCOUNTING OPENINGS (MG-08): the old trial balance recorded by the operator; the books open only when a SECOND
//      finance person signs it off in their own session — this tool never signs; a re-run after the sign-off reconciles
//      the ledger account by account to the old system's printed totals;
//   3. HISTORY (MG-07): documents under their old ids and the files behind them, hash-checked, reconciled per kind to the
//      old system's own report;
//   4. OPEN ORDERS (MG-08): raised by the operator; ISSUED by a second person on their own screen (never by this tool);
//      a re-run after they are issued carries what the old system already received and reads every order back.
//
// Every call is idempotent on the load's own keys, so the command is simply run again — after an interruption, after the
// sign-off, after the orders are issued — and lands only what is missing. It finishes (exit 0) only when everything landed
// and every read-back agrees; anything still waiting on a second person is said by name (exit 1, nothing hidden).
//
// Kept out of the package barrel: the history phase hashes file bytes with node:crypto, and the barrel goes to the browser.

import { bundleFromFiles, type CsvRows } from './load-csv';
import { readBackOpening, type LoadRequest } from './load';
import { runLoadCommand, readManifest, csvRows, type LoadCommandInput, type LoadCommandOutcome, type ExtractFileName } from './load-command';
import { historyFromFiles, openOrdersFromFile, trialBalanceFromFiles } from './phase-csv';
import { planHistoryLoad, executeHistoryLoad, readBackHistory, type ExtractHistory } from './history-load';
import { planOpenOrders, readBackOpenOrders, type ExtractOpenOrder, type OpenOrderStep } from './open-orders';
import { planAccountOpenings, executeAccountOpenings, readBackAccountOpenings, type ExtractTrialBalance } from './account-openings';
import type { TargetKind } from './trial';

export interface FullLoadCommandInput extends LoadCommandInput {
  /** The attachment files' bytes, base64, by file name (the extract's attachments/ folder). */
  readonly attachmentBytes?: Readonly<Record<string, string>>;
}

export interface PhaseSummary {
  readonly phase: 'opening_read_back' | 'account_openings' | 'history' | 'open_orders';
  readonly landed: boolean;
  readonly reconciled: boolean;
  /** What waits on a named second person, in words. */
  readonly waiting: readonly string[];
  readonly differences: number;
}

export interface FullLoadCommandOutcome extends LoadCommandOutcome {
  readonly phases?: readonly PhaseSummary[];
}

export async function runFullLoadCommand(input: FullLoadCommandInput): Promise<FullLoadCommandOutcome> {
  const main = await runLoadCommand(input);
  if (main.exitCode !== 0) return main;
  const lines = [...main.lines];
  const say = (s: string): void => { lines.push(s); };
  const manifest = readManifest(input.manifest).manifest!;
  const text = (name: ExtractFileName): CsvRows | undefined => (input.files[name] === undefined ? undefined : csvRows(input.files[name]!));

  // ── the phase files, read (every unreadable row named) ──────────────────────────────────────────────
  const problems: string[] = [];
  let history: ExtractHistory | undefined;
  const historyDocs = text('history.csv');
  if (historyDocs !== undefined) {
    const lineRows = text('history-lines.csv');
    const totals = text('history-control-totals.csv');
    const attachments = text('attachments.csv');
    const r = historyFromFiles({ documents: historyDocs, ...(lineRows === undefined ? {} : { lines: lineRows }), ...(totals === undefined ? {} : { controlTotals: totals }), ...(attachments === undefined ? {} : { attachments }), ...(input.attachmentBytes === undefined ? {} : { attachmentBytes: input.attachmentBytes }) });
    problems.push(...r.problems);
    history = r.history;
  }
  let orders: readonly ExtractOpenOrder[] | undefined;
  const orderRows = text('open-orders.csv');
  if (orderRows !== undefined) { const r = openOrdersFromFile(orderRows); problems.push(...r.problems); orders = r.orders; }
  let trialBalance: ExtractTrialBalance | undefined;
  const tbRows = text('trial-balance.csv');
  if (tbRows !== undefined) { const r = trialBalanceFromFiles(tbRows, text('trial-balance-totals.csv')); problems.push(...r.problems); trialBalance = r.trialBalance; }
  const done = (exitCode: 0 | 1 | 2, phases?: readonly PhaseSummary[]): FullLoadCommandOutcome => ({ ...main, exitCode, lines, ...(phases === undefined ? {} : { phases }) });
  if (problems.length > 0) {
    say(`REFUSED — ${problems.length} row(s) in the history / open-order / trial-balance files could not be read (the master data above is unaffected). Fix the file once, re-seal it, and run again:`);
    for (const p of problems) say(`  • ${p}`);
    return done(1);
  }

  // ── plan ──────────────────────────────────────────────────────────────────────────────────────────
  const kind = (input.targetKind ?? 'rehearsal') as TargetKind;
  const req: LoadRequest = {
    target: { targetId: `load-${manifest.loadId}`, tenantId: manifest.tenantId, kind, label: `MIGRATION_TARGET_KIND=${kind}` },
    tenantId: manifest.tenantId, demoTenantIds: input.demoTenantIds, operator: manifest.operator, targetProductCount: 0,
    extractSealed: true, blockingExceptionsOpen: 0, loadId: manifest.loadId, stockLocationId: manifest.stockLocationId,
    receivedOnDate: manifest.receivedOnDate, currency: manifest.currency ?? 'INR',
  };
  const bundle = bundleFromFiles({
    products: text('products.csv')!,
    ...(text('categories.csv') === undefined ? {} : { categories: text('categories.csv')! }),
    ...(text('tax-rates.csv') === undefined ? {} : { taxRates: text('tax-rates.csv')! }),
    ...(text('suppliers.csv') === undefined ? {} : { suppliers: text('suppliers.csv')! }),
    ...(text('customers.csv') === undefined ? {} : { customers: text('customers.csv')! }),
    ...(text('opening-stock.csv') === undefined ? {} : { openingStock: text('opening-stock.csv')! }),
  }).bundle;
  const tbPlan = trialBalance === undefined ? undefined : planAccountOpenings(trialBalance, req);
  const historyPlan = history === undefined ? undefined : planHistoryLoad(history, req);
  // The orders are raised by the operator; the issuing second person acts on their own screen, so no approver is minted here.
  const ordersPlan = orders === undefined ? undefined : planOpenOrders(orders, bundle, { ...req, approver: '(the second person who issues them, on their own screen)' });
  const refused = [tbPlan, historyPlan, ordersPlan].filter((p): p is Extract<typeof p, { ok: false }> => p !== undefined && !p.ok);
  if (refused.length > 0) {
    for (const p of refused) { say(`REFUSED (${p.refusedBecause}) — ${p.detail}`); for (const x of p.problems) say(`  • ${x}`); }
    return done(1);
  }
  if (tbPlan?.ok === true) say(`Phase plan — accounting openings: ${trialBalance!.lines.length} ledger account(s) from the old trial balance, debits ${trialBalance!.oldSystemTotals.debitMinor} paise = credits ${trialBalance!.oldSystemTotals.creditMinor} paise.`);
  if (historyPlan?.ok === true) say(`Phase plan — history: ${history!.documents.length} document(s), ${history!.attachments.length} attachment file(s).`);
  if (ordersPlan?.ok === true) say(`Phase plan — open orders: ${orders!.length} order(s) still open on the old system.`);
  if (input.dryRun) {
    say('DRY RUN — the phases were checked and planned; nothing was sent.');
    return done(0);
  }
  const client = input.client!;
  const phases: PhaseSummary[] = [];

  // ── 1. the opening state, read back ───────────────────────────────────────────────────────────────
  const opening = await readBackOpening(client, bundle, req);
  say(opening.agrees
    ? `Opening state read back: ${opening.lines.length} figure(s) — every one agrees with the sealed extract.`
    : `Opening state read back: ${opening.differences.length} of ${opening.lines.length} figure(s) DIFFER from the sealed extract:`);
  for (const d of opening.differences.slice(0, 50)) say(`  ✗ ${d.domain} ${d.key}: expected ${d.expected}, found ${d.actual ?? 'nothing'}${d.note === undefined ? '' : ` — ${d.note}`}`);
  if (opening.differences.length > 50) say(`  … and ${opening.differences.length - 50} more (see the outcome file).`);
  const payWait = opening.payablesSignedOff ? [] : ['supplier opening balances: a second person signs them off against the creditors\' list'];
  phases.push({ phase: 'opening_read_back', landed: true, reconciled: opening.differences.filter((d) => d.domain !== 'payable').length === 0, waiting: payWait, differences: opening.differences.length });

  // ── 2. accounting openings ─────────────────────────────────────────────────────────────────────────
  if (tbPlan?.ok === true) {
    const rec = await executeAccountOpenings(client, tbPlan);
    if (!rec.ok) {
      say(`  ✗ trial balance not recorded (HTTP ${rec.status})${rec.detail === undefined ? '' : `: ${rec.detail}`}`);
      phases.push({ phase: 'account_openings', landed: false, reconciled: false, waiting: [], differences: 0 });
    } else {
      const rb = await readBackAccountOpenings(client, trialBalance!, req);
      if (!rb.signed) {
        say(`Accounting openings: the trial balance (${trialBalance!.lines.length} accounts) is RECORDED, not yet the books. WAITING — a second finance person (the accountant, the CA or the owner — not ${manifest.operator}) signs it off on their own screen against the old system's printed totals: POST /v1/finance/account-openings/${manifest.loadId}/sign-off. Then run this load again to reconcile the ledger.`);
        phases.push({ phase: 'account_openings', landed: true, reconciled: false, waiting: [`accounting openings: a second finance person signs off load ${manifest.loadId}'s trial balance`], differences: 0 });
      } else {
        say(rb.agrees ? `Accounting openings: signed, posted, and the ledger agrees with the old trial balance account by account (${trialBalance!.lines.length} accounts).` : `Accounting openings: ${rb.differences.length} difference(s) between the ledger and the old trial balance:`);
        for (const d of rb.differences) say(`  ✗ ${d.check} ${d.key}: expected ${d.expected}, ledger ${d.actual ?? 'nothing'}${d.note === undefined ? '' : ` — ${d.note}`}`);
        phases.push({ phase: 'account_openings', landed: true, reconciled: rb.agrees, waiting: [], differences: rb.differences.length });
      }
    }
  }

  // ── 3. history ─────────────────────────────────────────────────────────────────────────────────────
  if (historyPlan?.ok === true) {
    const report = await executeHistoryLoad(client, historyPlan);
    for (const f of report.steps.filter((s) => !s.ok)) say(`  ✗ ${f.what} (HTTP ${f.status})${f.detail === undefined ? '' : `: ${f.detail}`}`);
    const rb = await readBackHistory(client, history!, req);
    say(rb.agrees ? `History: ${report.landed} record(s) landed; every document, attachment and per-kind total agrees with the old system's report.` : `History: ${report.landed} of ${historyPlan.steps.length} landed; ${rb.differences.length} difference(s) against the old system's report:`);
    for (const d of rb.differences.slice(0, 50)) say(`  ✗ ${d.check} ${d.key}: expected ${d.expected}, found ${d.actual ?? 'nothing'}${d.note === undefined ? '' : ` — ${d.note}`}`);
    phases.push({ phase: 'history', landed: report.ok, reconciled: rb.agrees, waiting: [], differences: rb.differences.length });
  }

  // ── 4. open orders ─────────────────────────────────────────────────────────────────────────────────
  if (ordersPlan?.ok === true) {
    const failed = new Set<string>();
    const waitingIssue: string[] = [];
    const post = async (s: OpenOrderStep): Promise<boolean> => {
      const res = await client.request({ method: 'POST', path: s.path, userId: manifest.operator, tenantId: manifest.tenantId, body: s.body, idempotencyKey: s.idempotencyKey });
      if (res.status === 200 || res.status === 201) return true;
      const err = (res.body as { error?: { code?: string; whatHappened?: string } } | undefined)?.error;
      say(`  ✗ open order ${s.poId} — ${s.stage} (HTTP ${res.status})${err === undefined ? '' : `: ${err.code ?? ''}: ${err.whatHappened ?? ''}`}`);
      failed.add(s.poId);
      return false;
    };
    for (const s of ordersPlan.steps.filter((x) => x.stage === 'propose')) await post(s);
    for (const o of orders!) {
      if (failed.has(o.poId)) continue;
      const got = await client.request({ method: 'GET', path: `/v1/purchase/orders/${encodeURIComponent(o.poId)}`, userId: manifest.operator, tenantId: manifest.tenantId });
      const status = ((got.body ?? {}) as { order?: { status?: string } }).order?.status;
      if (status !== 'issued') { waitingIssue.push(o.poId); continue; }
      for (const s of ordersPlan.steps.filter((x) => x.poId === o.poId && x.stage === 'carry_received')) await post(s);
    }
    const waiting = waitingIssue.length === 0 ? [] : [`open orders: a second person who approves purchase orders issues ${waitingIssue.join(', ')} on their own screen`];
    if (waitingIssue.length > 0) say(`Open orders: ${orders!.length - waitingIssue.length - failed.size} issued and carried; WAITING — ${waitingIssue.length} raised and awaiting a second person's approval (POST /v1/purchase/orders/:poId/approval, never by ${manifest.operator}): ${waitingIssue.join(', ')}. Run this load again once they are issued.`);
    let reconciled = false;
    let differences = 0;
    if (waitingIssue.length === 0 && failed.size === 0) {
      const rb = await readBackOpenOrders(client, orders!, req);
      reconciled = rb.agrees;
      differences = rb.differences.length;
      say(rb.agrees ? `Open orders: ${orders!.length} issued, with what already came carried; every order and the stores' open deliveries agree.` : `Open orders: ${rb.differences.length} difference(s):`);
      for (const d of rb.differences) say(`  ✗ ${d.check} ${d.key}: expected ${d.expected}, found ${d.actual ?? 'nothing'}${d.note === undefined ? '' : ` — ${d.note}`}`);
    }
    phases.push({ phase: 'open_orders', landed: failed.size === 0, reconciled, waiting, differences });
  }

  const waiting = phases.flatMap((p) => p.waiting);
  const finished = phases.every((p) => p.landed && (p.reconciled || p.waiting.length > 0)) && waiting.length === 0 && opening.agrees;
  if (finished) {
    say('FINISHED — every phase landed and every read-back agrees. Have the custodians sign the reconciliation (MG-06).');
    return done(0, phases);
  }
  say(`NOT FINISHED — ${waiting.length === 0 ? 'differences above need working through' : `waiting on: ${waiting.join('; ')}`}. Run the same load again afterwards; it lands only what is missing.`);
  return done(1, phases);
}
