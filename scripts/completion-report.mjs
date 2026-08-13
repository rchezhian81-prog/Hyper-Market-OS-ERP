#!/usr/bin/env node
// Product completion report (owner reporting model). Computes ONE reproducible completion percentage from
// a fixed weighted-maturity ledger — no estimates, no judgement ranges. See docs/COMPLETION-MODEL.md for
// the model, the weights, the denominator governance and the definition of each of the six scores.
//
//   Product completion % = Σ(maturity weight of every controlling requirement) ÷ total controlling requirements
//
// Run: `pnpm run completion` (or `node scripts/completion-report.mjs [--json]`). Reproducible: same ledger →
// same numbers. The ledger is docs/completion-status.json; the weights are fixed here and there.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = join(ROOT, 'docs', 'completion-status.json');

// The fixed maturity weights (owner-mandated). EXTERNALLY_BLOCKED is NOT a weight — a blocked requirement
// retains its achieved technical maturity weight and its blocker is reported separately (see the model doc).
export const WEIGHTS = Object.freeze({
  NOT_STARTED: 0,
  ENGINE_ONLY: 20,
  PARTIALLY_WIRED: 40,
  WIRED: 60,
  INTEGRATION_TESTED: 75,
  E2E_VERIFIED: 85,
  UAT_VERIFIED: 95,
  PRODUCTION_VERIFIED: 100,
});

// The maturity ladder, low → high, for "at least" threshold scores.
export const LADDER = Object.freeze([
  'NOT_STARTED', 'ENGINE_ONLY', 'PARTIALLY_WIRED', 'WIRED',
  'INTEGRATION_TESTED', 'E2E_VERIFIED', 'UAT_VERIFIED', 'PRODUCTION_VERIFIED',
]);

const rank = (label) => LADDER.indexOf(label);
const round1 = (n) => Math.round(n * 10) / 10;

/** Compute the full report from a ledger object. Pure — the guardrail test calls this directly. */
export function computeReport(ledger) {
  const items = ledger.items ?? [];
  const denominator = items.length;
  if (denominator === 0) throw new Error('completion ledger has no items');

  // Validate every label up front — an unknown label is a ledger error, not a silent zero.
  for (const it of items) {
    if (!(it.label in WEIGHTS)) throw new Error(`item ${it.id}: unknown maturity label "${it.label}"`);
    if (rank(it.label) === -1) throw new Error(`item ${it.id}: label "${it.label}" is not on the ladder`);
  }

  const weightedPoints = items.reduce((s, it) => s + WEIGHTS[it.label], 0);
  const maxPoints = denominator * 100;

  // Exact counts per maturity category.
  const counts = Object.fromEntries(LADDER.map((l) => [l, 0]));
  for (const it of items) counts[it.label] += 1;

  const atLeast = (label) => items.filter((it) => rank(it.label) >= rank(label)).length;
  const pctAtLeast = (label) => round1((atLeast(label) / denominator) * 100);

  // The six separate scores — all reproducible threshold views of the same ledger (see the model doc).
  const scores = {
    requirementsDesign: round1((items.filter((it) => it.label !== 'NOT_STARTED').length / denominator) * 100),
    technicalImplementation: round1((weightedPoints / maxPoints) * 100), // the weighted headline
    wiredAndIntegrated: pctAtLeast('WIRED'),
    e2eVerification: pctAtLeast('E2E_VERIFIED'),
    uatReadiness: pctAtLeast('UAT_VERIFIED'),
    productionReadiness: pctAtLeast('PRODUCTION_VERIFIED'),
  };

  const productCompletionPct = round1((weightedPoints / maxPoints) * 100);

  const blocked = items.filter((it) => typeof it.externalBlocker === 'string' && it.externalBlocker.trim() !== '')
    .map((it) => ({ id: it.id, retainedLabel: it.label, blocker: it.externalBlocker }));

  return { denominator, weightedPoints, maxPoints, productCompletionPct, counts, scores, blocked };
}

function fmtPct(n) {
  return `${n.toFixed(1)}%`;
}

function main() {
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  const report = computeReport(ledger);
  const prev = ledger.baseline?.previousProductCompletionPct ?? report.productCompletionPct;
  const delta = round1(report.productCompletionPct - prev);

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ ...report, previousProductCompletionPct: prev, change: delta, baseline: ledger.baseline }, null, 2) + '\n');
    return;
  }

  const L = [];
  L.push('SRE Retail OS — Product Completion Report');
  L.push('==========================================');
  L.push(`Baseline: ${ledger.baseline?.version ?? '?'} (${ledger.baseline?.date ?? '?'})`);
  L.push(`Denominator (total controlling requirements): ${report.denominator}`);
  L.push(`  source: ${ledger.baseline?.denominatorSource ?? '(see docs/COMPLETION-MODEL.md)'}`);
  L.push(`Numerator (weighted maturity points): ${report.weightedPoints} of ${report.maxPoints}`);
  L.push('');
  L.push(`PRODUCT COMPLETION: ${fmtPct(report.productCompletionPct)}   (previous ${fmtPct(prev)}, change ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts)`);
  L.push('');
  L.push('Six separate scores:');
  L.push(`  1. Requirements / design completeness : ${fmtPct(report.scores.requirementsDesign)}`);
  L.push(`  2. Technical implementation           : ${fmtPct(report.scores.technicalImplementation)}  (= product completion, the weighted headline)`);
  L.push(`  3. Wired-and-integrated               : ${fmtPct(report.scores.wiredAndIntegrated)}  (% of requirements at ≥ WIRED)`);
  L.push(`  4. E2E verification                   : ${fmtPct(report.scores.e2eVerification)}  (% at ≥ E2E_VERIFIED)`);
  L.push(`  5. UAT readiness                      : ${fmtPct(report.scores.uatReadiness)}  (% at ≥ UAT_VERIFIED)`);
  L.push(`  6. Production readiness               : ${fmtPct(report.scores.productionReadiness)}  (% PRODUCTION_VERIFIED)`);
  L.push('');
  L.push('Exact counts per maturity category:');
  for (const label of LADDER) L.push(`  ${label.padEnd(20)} ${report.counts[label]}`);
  L.push('');
  L.push(`Externally blocked (technical score retained, blocker shown separately): ${report.blocked.length}`);
  for (const b of report.blocked) L.push(`  ${b.id} [${b.retainedLabel}] — ${b.blocker}`);
  process.stdout.write(L.join('\n') + '\n');
}

// Only run when invoked directly (not when imported by the guardrail test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
