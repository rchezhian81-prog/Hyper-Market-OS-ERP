import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * D-14 (R3, OB-147): "It never auto-adjusts stock." The on-shelf availability rule and its routes hold NO way to move
 * stock: no movement append, no InventoryMoved event, no adjustment decision. A difference found by a count can only be
 * RAISED as a pending request on the existing approval path, which a second person decides.
 */
const FILES = [
  'packages/replenishment/src/on-shelf-availability.ts',
  'services/inventory/src/on-shelf-availability.ts',
];
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('D-14 guardrail: a suspected phantom never moves stock', () => {
  it.each(FILES)('%s has no movement write and no decision', (f) => {
    const code = strip(readFileSync(f, 'utf8'));
    for (const forbidden of ['appendMovement', 'InventoryMoved', 'decideAdjustmentRequest', 'recordDecision', 'checkMovement']) {
      expect(code, `${f} must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the count step raises the request PENDING, never decided', () => {
    const code = strip(readFileSync('services/inventory/src/on-shelf-availability.ts', 'utf8'));
    expect(code).toContain("status: 'pending', decidedBy: null");
    expect(code).not.toMatch(/status:\s*'posted'/);
  });

  it('the adapter wires no movement port into the on-shelf availability deps', () => {
    const src = strip(readFileSync('services/api/src/r3-ops-adapters.ts', 'utf8'));
    const at = src.indexOf('export function onShelfAvailabilityAdapter');
    const block = src.slice(at, src.indexOf('export function', at + 10));
    expect(block).toContain('raiseAdjustmentRequest');
    expect(block).not.toContain('appendMovement');
    expect(block).not.toContain('recordDecision');
  });
});
