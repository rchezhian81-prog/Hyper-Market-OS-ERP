import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { CATEGORIES_STREAM } from '../../services/api/src/adapters';
import { catalogueMasterSections } from '../../services/api/src/round-a-pack-sections';
import { readCategory, sameCategory, engineCategory } from '../../services/catalogue/src/categories';
import type { Category } from '../../packages/product/src/product';

/**
 * U7 (OB-726) · OB-699 = B: a category's name is the product's own word, so it is carried in Tamil too. Head office keeps
 * `nameTa` on the category it defines and the signed pack carries it, so the customer app's category list and the office
 * pages read it in Tamil (the app already reads `nameTa` when the pack gives it). A publish body that does not mention the
 * Tamil name still agrees with the register; one that names a different Tamil name differs (a new version, never silent).
 */
const T = 'tenant-u7-cat';
const NOW = '2026-11-13T06:00:00.000Z';

describe('U7 · a category carries its Tamil name', () => {
  it('is read off a request, kept by the engine shape, and compared only when the incoming side names it', () => {
    const read = readCategory({ categoryId: 'dairy', name: 'Dairy', nameTa: ' பால் பொருட்கள் ', parentId: null }) as Category;
    expect(read).toMatchObject({ categoryId: 'dairy', name: 'Dairy', nameTa: 'பால் பொருட்கள்' });
    expect(readCategory({ categoryId: 'dairy', name: 'Dairy', nameTa: 7, parentId: null })).toMatch(/nameTa/);
    expect(engineCategory(read)).toMatchObject({ nameTa: 'பால் பொருட்கள்' });
    const plain = readCategory({ categoryId: 'dairy', name: 'Dairy', parentId: null }) as Category;
    expect(sameCategory(read, plain)).toBe(true); // a publish that does not say the Tamil name agrees
    expect(sameCategory(plain, read)).toBe(false); // naming a Tamil name the register lacks is a change (a new version)
    expect(sameCategory(read, { ...read, nameTa: 'வேறு' })).toBe(false);
  });

  it('rides into the pack\'s category section', async () => {
    const store = new InMemoryEventStore();
    await store.append(T, CATEGORIES_STREAM, makeEvent({ id: 'c-dairy', type: 'CategoryDefined', occurredAt: NOW, idempotencyKey: 'c-dairy', source: 'test', payload: { categoryId: 'dairy', name: 'Dairy', nameTa: 'பால் பொருட்கள்', parentId: null, version: 1, definedBy: 'u', approvedBy: 'u', definedAt: NOW, source: 'test' } }));
    await store.append(T, CATEGORIES_STREAM, makeEvent({ id: 'c-bev', type: 'CategoryDefined', occurredAt: NOW, idempotencyKey: 'c-bev', source: 'test', payload: { categoryId: 'beverages', name: 'Beverages', parentId: null, version: 1, definedBy: 'u', approvedBy: 'u', definedAt: NOW, source: 'test' } }));
    const out = await catalogueMasterSections({ store, now: () => NOW }, T, []);
    expect(out.categories).toEqual([
      { categoryId: 'beverages', name: 'Beverages', parentId: null },
      { categoryId: 'dairy', name: 'Dairy', nameTa: 'பால் பொருட்கள்', parentId: null },
    ]);
  });
});
