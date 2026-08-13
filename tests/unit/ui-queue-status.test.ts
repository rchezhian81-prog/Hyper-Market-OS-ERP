import { describe, it, expect } from 'vitest';
import { presentQueueCategory, isQueueException, QUEUE_CATEGORIES, type QueueCategory } from '../../packages/ui/src/index';

// The shared reconciliation queue-category presentation (item 3 inc1), over the operator vocabulary the
// e-invoice + e-way-bill registers emit (item 2). The exception set is unknown + error + rejected + mismatch;
// mismatch (the inc4 additive flag) is an attention state in its own right, never folded into "registered".

describe('presentQueueCategory', () => {
  it('presents the done categories calmly and the exception categories as errors/attention', () => {
    const face = (c: QueueCategory) => presentQueueCategory({ category: c, label: c });
    expect(face('registered').tone).toBe('ok');
    expect(face('generated').tone).toBe('ok');
    expect(face('processing').tone).toBe('idle');
    expect(face('cancelled').tone).toBe('idle');
    expect(face('unknown').tone).toBe('degraded');
    expect(face('error').tone).toBe('error');
    expect(face('rejected').tone).toBe('error');
    expect(face('mismatch').tone).toBe('error');
  });

  it('carries the caller words + a shape icon, and refuses a blank label', () => {
    const p = presentQueueCategory({ category: 'mismatch', label: 'Portal disagrees', announcement: 'A re-query disagreed with the stored number' });
    expect(p.label).toBe('Portal disagrees');
    expect(p.icon.trim().length).toBeGreaterThan(0);
    expect(p.announcement).toBe('A re-query disagreed with the stored number');
    expect(() => presentQueueCategory({ category: 'registered', label: '' })).toThrow();
  });
});

describe('isQueueException', () => {
  it('is exactly the reconciliation exception set — unknown + error + rejected + mismatch', () => {
    const exceptions = QUEUE_CATEGORIES.filter(isQueueException).sort();
    expect(exceptions).toEqual(['error', 'mismatch', 'rejected', 'unknown']);
    // The done / in-flight / deliberate categories never pull for attention.
    expect(['registered', 'generated', 'processing', 'cancelled'].every((c) => !isQueueException(c as QueueCategory))).toBe(true);
    // presentQueueCategory agrees with isQueueException for every category.
    for (const c of QUEUE_CATEGORIES) {
      expect(presentQueueCategory({ category: c, label: c }).needsAttention).toBe(isQueueException(c));
    }
  });
});
