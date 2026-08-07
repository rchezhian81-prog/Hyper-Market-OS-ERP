import { describe, it, expect } from 'vitest';
import { editorFor, parseDraft, SetupEditController } from '../../apps/web-erp/src/setup-editing';

// The store-setup editing logic: it parses what a person types into the setting's real type, applies
// the SAME validation the engine and API enforce, and runs each field through a save state machine
// that refuses a second submit in flight and surfaces conflicts (M33-FR-01).

describe('parseDraft', () => {
  it('parses a number and rejects a non-number or an out-of-range one', () => {
    expect(parseDraft('tax.default_bps', '1800')).toEqual({ ok: true, value: 1800 });
    expect(parseDraft('tax.default_bps', 'abc').ok).toBe(false);
    expect(parseDraft('tax.default_bps', '999999').ok).toBe(false); // engine range rule flows through
  });

  it('parses a list from commas or newlines, and enforces "at least one language"', () => {
    expect(parseDraft('locale.languages', 'en, ta')).toEqual({ ok: true, value: ['en', 'ta'] });
    expect(parseDraft('locale.languages', '').ok).toBe(false);
  });

  it('uppercases a currency and rejects a non-code', () => {
    expect(parseDraft('locale.currency', 'inr')).toEqual({ ok: true, value: 'INR' });
    expect(parseDraft('locale.currency', 'rupees').ok).toBe(false);
  });

  it('validates a time and a paper-format choice', () => {
    expect(parseDraft('trading_day.cutoff', '22:00')).toEqual({ ok: true, value: '22:00' });
    expect(parseDraft('trading_day.cutoff', '25:00').ok).toBe(false);
    expect(parseDraft('receipt.paper_format', 'thermal-80')).toEqual({ ok: true, value: 'thermal-80' });
    expect(parseDraft('receipt.paper_format', 'thermal-999').ok).toBe(false);
  });

  it('coerces a toggle from a boolean or its text', () => {
    expect(parseDraft('pos.licence_hours.enabled', true)).toEqual({ ok: true, value: true });
    expect(parseDraft('pos.licence_hours.enabled', 'false')).toEqual({ ok: true, value: false });
  });

  it('offers options for a select field and defaults unknown keys to text', () => {
    expect(editorFor('receipt.paper_format').kind).toBe('select');
    expect(editorFor('receipt.paper_format').options?.map((o) => o.id)).toContain('thermal-80');
    expect(editorFor('unknown.key').kind).toBe('text');
  });
});

describe('SetupEditController', () => {
  const seeded = (): SetupEditController => {
    const c = new SetupEditController();
    c.seed('tax.default_bps', 0);
    return c;
  };

  it('tracks dirty and inline validation, and warns of unsaved changes', () => {
    const c = seeded();
    expect(c.hasUnsavedChanges()).toBe(false);
    c.edit('tax.default_bps', 'abc');
    expect(c.state('tax.default_bps').dirty).toBe(true);
    expect(c.state('tax.default_bps').error).not.toBeNull();
    expect(c.hasUnsavedChanges()).toBe(true);
  });

  it('refuses to save nothing, an invalid draft, or a second time while in flight', () => {
    const c = seeded();
    expect(c.beginSave('tax.default_bps')).toEqual({ ok: false, reason: 'not_dirty' });
    c.edit('tax.default_bps', '999999');
    expect(c.beginSave('tax.default_bps').ok).toBe(false); // invalid
    c.edit('tax.default_bps', '1800');
    expect(c.beginSave('tax.default_bps')).toEqual({ ok: true, value: 1800, ifVersion: 0 });
    // A second click while the first is in flight is refused — no duplicate submission.
    expect(c.beginSave('tax.default_bps')).toEqual({ ok: false, reason: 'in_flight' });
  });

  it('confirms a save: not dirty, version bumped', () => {
    const c = seeded();
    c.edit('tax.default_bps', '1800');
    c.beginSave('tax.default_bps');
    const s = c.onResult('tax.default_bps', { kind: 'saved', version: 1 });
    expect(s.status).toBe('saved');
    expect(s.dirty).toBe(false);
    expect(s.version).toBe(1);
    expect(c.hasUnsavedChanges()).toBe(false);
  });

  it('surfaces a conflict, keeps the draft, and re-enables on retry', () => {
    const c = seeded();
    c.edit('tax.default_bps', '1800');
    c.beginSave('tax.default_bps');
    const s = c.onResult('tax.default_bps', { kind: 'conflict', currentVersion: 3 });
    expect(s.status).toBe('conflict');
    expect(s.conflictVersion).toBe(3);
    expect(s.draft).toBe('1800');
    expect(c.retry('tax.default_bps').status).toBe('idle');
  });

  it('marks an offline save queued — accepted, and no longer counted as unsaved', () => {
    const c = seeded();
    c.edit('tax.default_bps', '1800');
    c.beginSave('tax.default_bps');
    c.onResult('tax.default_bps', { kind: 'queued' });
    expect(c.state('tax.default_bps').status).toBe('queued');
    expect(c.hasUnsavedChanges()).toBe(false);
  });

  it('reports a failure with its message and recovers on retry', () => {
    const c = seeded();
    c.edit('tax.default_bps', '1800');
    c.beginSave('tax.default_bps');
    const s = c.onResult('tax.default_bps', { kind: 'failed', message: 'the store computer did not answer' });
    expect(s.status).toBe('failed');
    expect(s.message).toContain('did not answer');
    expect(c.retry('tax.default_bps').status).toBe('idle');
  });
});
