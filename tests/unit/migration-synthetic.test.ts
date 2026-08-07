import { describe, it, expect } from 'vitest';
import { generateLegacyDataset, datasetChecksum } from '../../packages/migration/src/synthetic';

// The fixture the whole rehearsal stands on. If the generator is not deterministic, every
// reconciliation figure below it becomes approximate, and an approximate migration test is a
// migration test that passes.

describe('the same seed gives the same dataset, on every machine and every run', () => {
  it('produces an identical checksum twice', () => {
    expect(datasetChecksum(generateLegacyDataset())).toBe(datasetChecksum(generateLegacyDataset()));
  });

  it('produces a DIFFERENT dataset for a different seed', () => {
    expect(datasetChecksum(generateLegacyDataset({ seed: 1 }))).not.toBe(datasetChecksum(generateLegacyDataset({ seed: 2 })));
  });

  it('changes the checksum when a single row is dropped — a truncated extract is visible', () => {
    const d = generateLegacyDataset();
    const truncated = { ...d, stock: d.stock.slice(0, -1) };
    expect(datasetChecksum(truncated)).not.toBe(datasetChecksum(d));
  });

  it('changes the checksum when one value moves by a paisa', () => {
    const d = generateLegacyDataset();
    const first = d.documents[0]!;
    const nudged = { ...d, documents: [{ ...first, totalMinor: first.totalMinor + 1 }, ...d.documents.slice(1)] };
    expect(datasetChecksum(nudged)).not.toBe(datasetChecksum(d));
  });
});

describe('the damage is real, counted, and identified', () => {
  const d = generateLegacyDataset();

  it('plants all ten kinds of fault', () => {
    for (const [kind, count] of Object.entries(d.plantedFaults)) {
      expect(count, `${kind} was never planted`).toBeGreaterThan(0);
    }
    expect(Object.keys(d.plantedFaults)).toHaveLength(10);
  });

  it('keeps the count and the id list in step — they cannot drift', () => {
    for (const [kind, count] of Object.entries(d.plantedFaults)) {
      expect(d.plantedIds[kind as keyof typeof d.plantedIds]).toHaveLength(count);
    }
  });

  it('generates base product names that are DISTINCT — so every duplicate is a planted one', () => {
    // Without this the generator's own name collisions would be indistinguishable from the
    // faults, and a duplicate detector could not be measured at all.
    const originals = d.products.filter((p) => !d.plantedIds.duplicate_products.includes(p.legacyId));
    expect(new Set(originals.map((p) => p.name.trim().toLowerCase())).size).toBe(originals.length);
  });

  it('really does contain negative stock, shared barcodes and orphan lines', () => {
    expect(d.stock.some((s) => s.qty < 0)).toBe(true);

    const barcodes = d.products.map((p) => p.barcode).filter((b): b is string => b !== undefined);
    expect(new Set(barcodes).size).toBeLessThan(barcodes.length);

    const documentIds = new Set(d.documents.map((x) => x.legacyId));
    expect(d.lines.some((l) => !documentIds.has(l.legacyDocumentId))).toBe(true);
  });

  it('produces a genuinely CLEAN dataset when asked — the control for the whole rehearsal', () => {
    const clean = generateLegacyDataset({ withFaults: false });
    expect(Object.values(clean.plantedFaults).every((c) => c === 0)).toBe(true);
    expect(clean.stock.every((s) => s.qty >= 0)).toBe(true);

    const documentIds = new Set(clean.documents.map((x) => x.legacyId));
    expect(clean.lines.every((l) => documentIds.has(l.legacyDocumentId))).toBe(true);

    const barcodes = clean.products.map((p) => p.barcode).filter((b): b is string => b !== undefined);
    expect(new Set(barcodes).size).toBe(barcodes.length);
  });

  it('scales to the volume asked for, so a full-volume trial is a real one', () => {
    const big = generateLegacyDataset({ products: 2_000, documents: 5_000, customers: 1_500 });
    expect(big.products.length).toBeGreaterThanOrEqual(2_000);
    expect(big.documents).toHaveLength(5_000);
    expect(big.lines.length).toBeGreaterThan(5_000);
  });
});
