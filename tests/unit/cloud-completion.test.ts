import { describe, it, expect } from 'vitest';
import {
  toCloudChecklist, toCloudTaskCompletion, checklistIdOf, taskIdOf,
} from '../../edge/store-edge/src/cloud-completion';

// M25-FR-02 · §31 · P-01/P-08. The translator between the store box's on-disk checklist/task completion record
// and the cloud synced-completion contract. It is pure, TOLERANT of a record already in the cloud shape, and
// INVENTS nothing — a field it cannot read is left empty/absent for the cloud to raise, never guessed.

describe('toCloudChecklist maps the box record onto exactly what the synced route reads', () => {
  it('carries the id, kind, items and signer, preserving the item flags', () => {
    const cloud = toCloudChecklist({
      checklistId: 'CL1', kind: 'closing', signedBy: 'Meena', branchId: 'b1', forDate: '2026-09-14',
      submittedAt: '2026-09-14T21:00:00.000Z', // a box-only field the cloud does not read — dropped, not forwarded
      items: [{ itemId: 'safe', description: 'Cash in the safe', done: true, blocking: true, doneBy: 'Meena' }],
    });
    expect(cloud).toMatchObject({ checklistId: 'CL1', kind: 'closing', signedBy: 'Meena', branchId: 'b1', forDate: '2026-09-14' });
    expect(cloud.items).toEqual([{ itemId: 'safe', description: 'Cash in the safe', done: true, blocking: true, doneBy: 'Meena' }]);
  });

  it('carries optional fields only when present — an unsigned checklist has no signedBy (not an empty one)', () => {
    const cloud = toCloudChecklist({ checklistId: 'CL2', kind: 'opening', items: [] });
    expect('signedBy' in cloud).toBe(false);
    expect('branchId' in cloud).toBe(false);
    expect(cloud.items).toEqual([]);
  });

  it('invents nothing from garbage: absent/typeless fields become empty, items default to not-done/not-blocking', () => {
    const cloud = toCloudChecklist({ checklistId: 'CL3', items: [{ itemId: 'x' }, 'nonsense', null] });
    expect(cloud.kind).toBe('');
    expect(cloud.items).toEqual([
      { itemId: 'x', description: '', done: false, blocking: false },
      { itemId: '', description: '', done: false, blocking: false },
      { itemId: '', description: '', done: false, blocking: false },
    ]);
  });

  it('tolerates a bare `id`, and a non-object record yields an empty (never a throw)', () => {
    expect(toCloudChecklist({ id: 'CL4', kind: 'handover', items: [] }).checklistId).toBe('CL4');
    expect(toCloudChecklist(null).checklistId).toBe('');
    expect(toCloudChecklist('nope').items).toEqual([]);
  });
});

describe('toCloudTaskCompletion maps the box record onto what the synced complete route reads', () => {
  it('carries taskId + doneBy, and doneAt only when present', () => {
    expect(toCloudTaskCompletion({ taskId: 'T1', doneBy: 'Ravi', doneAt: '2026-09-14T21:05:00.000Z' }))
      .toEqual({ taskId: 'T1', doneBy: 'Ravi', doneAt: '2026-09-14T21:05:00.000Z' });
    const noAt = toCloudTaskCompletion({ taskId: 'T2', doneBy: 'Ravi' });
    expect(noAt).toEqual({ taskId: 'T2', doneBy: 'Ravi' });
    expect('doneAt' in noAt).toBe(false);
  });

  it('invents nothing: an unreadable doneBy becomes empty for the cloud to raise', () => {
    expect(toCloudTaskCompletion({ taskId: 'T3' }).doneBy).toBe('');
    expect(toCloudTaskCompletion({ id: 'T4', doneBy: 'x' }).taskId).toBe('T4');
  });
});

describe('the id extractors read the record\'s identity, tolerating a bare id', () => {
  it('reads checklistId / taskId, falling back to id, undefined when neither is present', () => {
    expect(checklistIdOf({ checklistId: 'CL1' })).toBe('CL1');
    expect(checklistIdOf({ id: 'CL2' })).toBe('CL2');
    expect(checklistIdOf({})).toBeUndefined();
    expect(taskIdOf({ taskId: 'T1' })).toBe('T1');
    expect(taskIdOf({ id: 'T2' })).toBe('T2');
    expect(taskIdOf(null)).toBeUndefined();
  });
});
