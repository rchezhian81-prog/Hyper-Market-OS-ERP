import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { createProductionQueue, openBoxLabelPort, productionRunKey } from '../../apps/web-erp/src/production-queue';
import { createProductionTasksSession, PRODUCTION_TASKS_COPY } from '../../apps/web-erp/src/production-tasks-session';
import { PRODUCTION_COPY } from '../../apps/web-erp/src/production-session';

// OB-288 lane 2 · P2 — the production screen's durable queue through the store computer (M11-FR-01/02/03 · §31): a run, a
// weigh and a release are SAVED on this device (once per id) and carried by the box; the label is the box's own; every
// state is said in words; nothing is saved in nobody's name; English and Tamil for every new word.

const NOW = '2026-10-23T07:00:00.000Z';
const queueOf = (userId: string | null = 'u-cook', storeId: string | null = 'S1') => {
  const outbox = new SyncOutbox();
  let n = 0;
  return { outbox, q: createProductionQueue({ userId, storeId, now: () => NOW, freshId: (p) => `${p}-${++n}` }, outbox) };
};

describe('the production queue (device → store computer → head office)', () => {
  it('saves a run once per run id in the cook\'s name, a release decision once, and a weigh with grams only', async () => {
    const { outbox, q } = queueOf();
    const run = { runId: 'run-1', recipeId: 'r-cake', batches: 2, actualOutputMinor: 2, outputBatchId: 'B-1', locationId: 'S1-KITCHEN' };
    expect(await q.runPort().post(run)).toEqual({ result: 'done', value: { runId: 'run-1' } });
    expect(await q.runPort().post(run)).toEqual({ result: 'done', value: { runId: 'run-1' } });
    expect(outbox.all().map((i) => i.key)).toEqual([productionRunKey('run-1')]);
    expect(outbox.all()[0]!.event).toMatchObject({ type: 'ProductionRunCaptured', idempotencyKey: 'run:run-1', payload: { ...run, storeId: 'S1', producedBy: 'u-cook', at: NOW, source: 'production-screen' } });
    expect(await q.releasePort().post({ runId: 'run-1', qcPassed: false, notes: 'underbaked' })).toBe('saved');
    expect(await q.releasePort().post({ runId: 'run-1', qcPassed: true })).toBe('saved'); // the first decision stands on this device
    expect(outbox.all().filter((i) => i.event.type === 'ProductionReleaseDecided').map((i) => (i.event.payload as { qcPassed: boolean }).qcPassed)).toEqual([false]);
    expect(q.recordWeighed({ departmentId: 'meat_fish', inputProductId: 'CHICKEN', inputGrams: '2000', outputProductId: 'CUTS', outputGrams: '1500', byproductProductId: 'BONE', byproductGrams: '400' })).toEqual({ outcome: 'saved', runId: 'weigh-1' });
    expect(outbox.all().at(-1)!.event.payload).toMatchObject({ inputs: [{ productId: 'CHICKEN', weightGrams: 2000 }], outputs: [{ productId: 'CUTS', weightGrams: 1500 }, { productId: 'BONE', weightGrams: 400, isByproduct: true }], weighedBy: 'u-cook' });
    expect(JSON.stringify(outbox.all().at(-1)!.event.payload)).not.toContain('cost');
  });

  it('refuses a weigh that cannot be right, and anything in nobody\'s name or for no store', async () => {
    const { q } = queueOf();
    const w = { departmentId: 'meat_fish', inputProductId: 'CHICKEN', inputGrams: '1000', outputProductId: 'CUTS', outputGrams: '900' };
    expect(q.recordWeighed({ ...w, outputGrams: '1001' }).outcome).toBe('more_out_than_in');
    expect(q.recordWeighed({ ...w, inputGrams: '1.5' }).outcome).toBe('bad_weight');
    expect(q.recordWeighed({ ...w, departmentId: '' }).outcome).toBe('missing');
    expect(queueOf(null).q.recordWeighed(w).outcome).toBe('nobody');
    expect(queueOf('u-cook', null).q.recordWeighed(w).outcome).toBe('no_store');
    expect((await queueOf(null).q.runPort().post({ runId: 'r', recipeId: 'x', batches: 1, actualOutputMinor: 1, outputBatchId: 'b', locationId: 'k' })).result).toBe('refused');
    expect(await queueOf(null).q.releasePort().post({ runId: 'r', qcPassed: true })).toBe('refused');
  });

  it('lists what was saved with where each piece is — "posted" and "refused" only on the box\'s word, with its reason', async () => {
    const { outbox, q } = queueOf();
    await q.runPort().post({ runId: 'run-1', recipeId: 'r-cake', batches: 1, actualOutputMinor: 1, outputBatchId: 'B-1', locationId: 'K' });
    await q.releasePort().post({ runId: 'run-0', qcPassed: true });
    expect(q.savedWork().map((w) => w.state)).toEqual(['saved_here', 'saved_here']);
    for (const i of outbox.all()) outbox.acknowledge(i.key);
    expect(q.handedKeys()).toEqual(['run:run-1', 'release:run-0']);
    q.noteBoxStatus([{ key: 'run:run-1', state: 'posted', attempts: 1 }, { key: 'release:run-0', state: 'refused', attempts: 1, reason: 'releaser_lacks_authority' }]);
    expect(q.savedWork()).toEqual([
      expect.objectContaining({ kind: 'release', id: 'run-0', state: 'refused', reason: 'releaser_lacks_authority' }),
      expect.objectContaining({ kind: 'run', id: 'run-1', state: 'posted' }),
    ]);
  });

  it('asks the box for the counter label and hands back its lines, or its refusal in its words', async () => {
    const answers = [
      new Response(JSON.stringify({ ok: true, lines: ['Plum cake', 'Batch B-1'] }), { status: 200 }),
      new Response(JSON.stringify({ ok: false, refusedBecause: 'incomplete_label', detail: 'needs an allergen declaration' }), { status: 422 }),
    ];
    const sent: unknown[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return answers.shift()!; }) as unknown as typeof fetch;
    const port = openBoxLabelPort(fetchFn);
    expect(await port.post({ runId: 'run-1', netQuantity: '1', packerDetails: 'SRE', allergens: [], weightGrams: 450 })).toEqual({ result: 'done', value: { lines: ['Plum cake', 'Batch B-1'] } });
    expect(sent[0]).toEqual({ runId: 'run-1', netQuantity: '1', packerDetails: 'SRE', allergens: [], weightGrams: 450 });
    expect(await port.post({ runId: 'run-1', netQuantity: '1', packerDetails: 'SRE' })).toEqual({ result: 'refused', reason: 'needs an allergen declaration' });
    expect(await openBoxLabelPort(undefined).post({ runId: 'r', netQuantity: '', packerDetails: '' })).toEqual({ result: 'lost_link' });
  });
});

describe('the production tasks session on the store computer', () => {
  it('prints from the box without a typed name or price, checks a typed weight, offers the weigh form, and says "saved" not "recorded"', async () => {
    const { q } = queueOf();
    const posted: unknown[] = [];
    const session = createProductionTasksSession({ userId: 'u-cook', defaultLocationId: 'S1-KITCHEN' }, {
      mayCommit: () => true, mayLabel: () => true, commitPort: () => q.runPort(),
      labelPort: () => ({ post: async (input) => { posted.push(input); return { result: 'done', value: { lines: ['ok'] } }; } }),
      runs: () => [], queued: () => true, labelFromBox: () => true, weighPort: () => ({ record: (i) => q.recordWeighed(i) }), savedWork: () => q.savedWork(),
    });
    const v = session.view('en');
    expect([v.labelFromBox, v.canWeigh]).toEqual([true, true]);
    expect((await session.printLabel({ runId: 'run-9', productName: '', netQuantity: '1', packerDetails: 'SRE', price: '', allergens: 'none', weightGrams: '0' })).outcome).toBe('bad_weight');
    expect(await session.printLabel({ runId: 'run-9', productName: '', netQuantity: '1', packerDetails: 'SRE', price: '', allergens: 'none', weightGrams: '450' })).toEqual({ outcome: 'printed', lines: ['ok'] });
    expect(posted).toEqual([{ runId: 'run-9', netQuantity: '1', packerDetails: 'SRE', allergens: [], weightGrams: 450 }]);
    const o = await session.recordRun({ recipeId: 'r-cake', batches: '1', actualOutput: '1', batchId: 'B', locationId: 'S1-KITCHEN' });
    expect(session.presentRun('en', o).label).toContain('Run saved on this screen');
    expect(session.presentWeighed('ta', session.recordWeighed({ departmentId: 'd', inputProductId: 'a', inputGrams: '10', outputProductId: 'b', outputGrams: '20' })).label).toContain('மீண்டும் எடையிடுங்கள்');
    expect(session.view('ta').saved[0]).toMatchObject({ kindWord: 'உற்பத்தி', stateWord: 'இந்தத் திரையில் சேமிக்கப்பட்டது', icon: '•' });
  });

  it('every new word has its Tamil twin', () => {
    for (const copy of [PRODUCTION_TASKS_COPY, PRODUCTION_COPY]) {
      expect(Object.keys(copy.ta).sort()).toEqual(Object.keys(copy.en).sort());
      for (const [k, v] of Object.entries(copy.ta)) expect(v, k).not.toBe('');
    }
  });
});
