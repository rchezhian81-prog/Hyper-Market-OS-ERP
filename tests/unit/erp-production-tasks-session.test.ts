import { describe, it, expect } from 'vitest';
import {
  createProductionTasksSession, PRODUCTION_TASKS_COPY, COPY_KEYS, rupeesToPaise,
  type ProductionTasksPorts, type RunCommitPort, type LabelPort, type RunOutcome, type LabelOutcome,
} from '../../apps/web-erp/src/production-tasks-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * FUL-13 (Batch 2): the production staff's task paths — record a run, print a label — as a DOM-free session over the existing
 * production APIs. Every write is refused before it is sent when a field is missing, a number is not whole, the person has no
 * right or no name; the cloud's word is passed on verbatim; a blank allergen box is "not declared", never "contains none".
 */

const RUNS = [{ runId: 'run-1', outputProductId: 'CAKE', outputBatchId: 'CAKE-1', expiresAt: '2026-10-12T00:00:00.000Z' }];
function ports(over: Partial<ProductionTasksPorts> = {}) {
  const sent: { run: unknown[]; label: unknown[] } = { run: [], label: [] };
  const commit: RunCommitPort = { post: async (i) => { sent.run.push(i); return { result: 'done', value: { runId: i.runId } }; } };
  const label: LabelPort = { post: async (i) => { sent.label.push(i); return { result: 'done', value: { lines: ['Coffee cake', 'Batch: CAKE-1'] } }; } };
  return { sent, ports: { mayCommit: () => true, mayLabel: () => true, commitPort: () => commit, labelPort: () => label, runs: () => RUNS, ...over } as ProductionTasksPorts };
}
const session = (over: Partial<ProductionTasksPorts> = {}, userId: string | null = 'u-chef') => {
  const p = ports(over);
  return { ...p, s: createProductionTasksSession({ userId, defaultLocationId: 'KITCHEN' }, p.ports) };
};
const RUN = { runId: 'run-2', recipeId: 'cake', batches: '2', actualOutput: '2', batchId: 'CAKE-2', locationId: 'KITCHEN' };
const LABEL = { runId: 'run-1', productName: 'Coffee cake', netQuantity: '180 g', packerDetails: 'SRE', price: '120.50', allergens: 'wheat, milk' };

describe('FUL-13 — the production staff\'s task paths', () => {
  it('has no gap in either language', () => {
    expect(bilingualGaps(PRODUCTION_TASKS_COPY, COPY_KEYS)).toEqual({ en: [], ta: [] });
  });

  it('records a run with whole numbers under its run id, and prints a label at exact paise with the allergens as a list', async () => {
    const { s, sent } = session();
    expect(s.view('en')).toMatchObject({ canRecordRun: true, canLabel: true, defaultLocationId: 'KITCHEN', labelRuns: [{ runId: 'run-1', label: 'CAKE · CAKE-1' }] });
    expect(await s.recordRun(RUN)).toEqual({ outcome: 'recorded', runId: 'run-2' });
    expect(sent.run).toEqual([{ runId: 'run-2', recipeId: 'cake', batches: 2, actualOutputMinor: 2, outputBatchId: 'CAKE-2', locationId: 'KITCHEN' }]);
    expect(await s.printLabel(LABEL)).toEqual({ outcome: 'printed', lines: ['Coffee cake', 'Batch: CAKE-1'] });
    expect(sent.label).toEqual([{ runId: 'run-1', productName: 'Coffee cake', netQuantity: '180 g', packerDetails: 'SRE', priceMinor: 12_050, allergens: ['wheat', 'milk'] }]);
  });

  it('a blank allergen box is NOT DECLARED (sent without the field — head office refuses a label that needs it); "none" declares none', async () => {
    const { s, sent } = session();
    await s.printLabel({ ...LABEL, allergens: '  ' });
    await s.printLabel({ ...LABEL, allergens: 'None' });
    expect(sent.label[0]).not.toHaveProperty('allergens');
    expect(sent.label[1]).toMatchObject({ allergens: [] });
  });

  it('refuses before sending: missing fields, numbers that are not whole, no right, nobody named, no link, an unknown batch, a bad price, no name', async () => {
    const runCases: [Partial<ProductionTasksPorts>, string | null, typeof RUN, RunOutcome['outcome']][] = [
      [{}, 'u-chef', { ...RUN, recipeId: ' ' }, 'missing'],
      [{}, 'u-chef', { ...RUN, batches: '2.5' }, 'bad_number'],
      [{}, 'u-chef', { ...RUN, actualOutput: '0' }, 'bad_number'],
      [{ mayCommit: () => false }, 'u-chef', RUN, 'not_permitted'],
      [{}, null, RUN, 'nobody'],
      [{ commitPort: () => null }, 'u-chef', RUN, 'no_link'],
    ];
    for (const [over, user, input, outcome] of runCases) {
      const { s, sent } = session(over, user);
      expect((await s.recordRun(input)).outcome, outcome).toBe(outcome);
      expect(sent.run, outcome).toEqual([]);
      expect(s.presentRun('ta', { outcome } as RunOutcome).label.length).toBeGreaterThan(0);
    }
    const labelCases: [Partial<ProductionTasksPorts>, typeof LABEL, LabelOutcome['outcome']][] = [
      [{}, { ...LABEL, runId: 'run-9' }, 'no_run'],
      [{}, { ...LABEL, productName: '' }, 'missing_name'],
      [{}, { ...LABEL, price: '12.345' }, 'bad_price'],
      [{}, { ...LABEL, price: 'abc' }, 'bad_price'],
      [{ mayLabel: () => false }, LABEL, 'not_permitted'],
      [{ labelPort: () => null }, LABEL, 'no_link'],
    ];
    for (const [over, input, outcome] of labelCases) {
      const { s, sent } = session(over);
      expect((await s.printLabel(input)).outcome, outcome).toBe(outcome);
      expect(sent.label, outcome).toEqual([]);
      expect(s.presentLabel('en', { outcome } as LabelOutcome).label.length).toBeGreaterThan(0);
    }
  });

  it('passes the cloud\'s refusal on verbatim and never claims success; a lost link is said as such', async () => {
    const refused = session({ commitPort: () => ({ post: async () => ({ result: 'refused', reason: 'Only 300 g of FLOUR is on hand' }) }) });
    const o = await refused.s.recordRun(RUN);
    expect(o).toEqual({ outcome: 'refused', reason: 'Only 300 g of FLOUR is on hand' });
    expect(refused.s.presentRun('en', o).label).toContain('Only 300 g of FLOUR');
    const lost = session({ labelPort: () => ({ post: async () => ({ result: 'lost_link' }) }) });
    expect(await lost.s.printLabel(LABEL)).toEqual({ outcome: 'lost_link' });
  });

  it('rupees to paise exactly, never through a float', () => {
    expect(['120', '120.5', '120.50', '0.05', '7'].map(rupeesToPaise)).toEqual([12_000, 12_050, 12_050, 5, 700]);
    expect(['', '1.234', '-3', '1,000'].map(rupeesToPaise)).toEqual([undefined, undefined, undefined, undefined]);
  });
});
