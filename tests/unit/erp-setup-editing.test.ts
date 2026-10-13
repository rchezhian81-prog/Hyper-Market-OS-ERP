import { describe, it, expect } from 'vitest';
import { editorFor, parseDraft, SetupEditController } from '../../apps/web-erp/src/setup-editing';
import { SETUP_CATALOGUE } from '../../packages/tenant/src/index';

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

  it('after a conflict and a reload, the field takes the NEWER version and drops the stale draft — the next save is not a conflict again', () => {
    const c = seeded();
    const v0 = c.state('tax.default_bps').version;
    c.edit('tax.default_bps', '1800');
    c.beginSave('tax.default_bps');
    c.onResult('tax.default_bps', { kind: 'conflict', currentVersion: v0 });
    c.retry('tax.default_bps');
    c.seed('tax.default_bps', v0 + 1); // the reload brought the newer version
    expect(c.state('tax.default_bps')).toMatchObject({ status: 'idle', dirty: false, version: v0 + 1 });
    c.edit('tax.default_bps', '500');
    expect(c.beginSave('tax.default_bps')).toEqual({ ok: true, value: 500, ifVersion: v0 + 1 });
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

describe('OB-78 — the owner sets the early disk-warning line on the store-setup screen', () => {
  it('reads as a whole number of trading hours, refused in the engine\'s words otherwise', () => {
    expect(editorFor('platform.box_disk_warn_hours').kind).toBe('number');
    expect(parseDraft('platform.box_disk_warn_hours', '12')).toEqual({ ok: true, value: 12 });
    expect(parseDraft('platform.box_disk_warn_hours', '0')).toEqual({ ok: false, error: 'Give a whole number of trading hours, from 1 to 720.' });
    expect(parseDraft('platform.box_disk_warn_hours', '2.5').ok).toBe(false);
  });
});

// Round 13: the loyalty settings and the bulk-publish line were missing from a hand-kept editor list, fell through to
// a text box, reached the engine as strings and could never be saved. The editor now comes from the catalogue itself.
describe('every setup setting gets its editor from the catalogue (type and declared range), never from a hand-kept list', () => {
  const numbers = SETUP_CATALOGUE.filter((i) => typeof i.setting.defaultValue === 'number');

  it('every number setting declares its range, and every other setting does not', () => {
    for (const item of SETUP_CATALOGUE) {
      expect({ key: item.setting.key, declared: item.range !== undefined })
        .toEqual({ key: item.setting.key, declared: typeof item.setting.defaultValue === 'number' });
    }
    expect(numbers.map((i) => i.setting.key)).toEqual(expect.arrayContaining([
      'loyalty.points_per_100_inr', 'loyalty.point_value_paise', 'loyalty.till_spend_cap_paise', 'catalogue.bulk_publish_threshold',
    ]));
  });

  it.each(SETUP_CATALOGUE.map((i) => [i.setting.key, i] as const))('%s: the editor matches the setting\'s type', (key, item) => {
    const spec = editorFor(key);
    const d = item.setting.defaultValue;
    if (typeof d === 'number') {
      expect(spec).toMatchObject({ kind: item.range!.whole ? 'number' : 'decimal', min: item.range!.min });
      expect(spec.max).toBe(item.range!.max);
      expect(spec.step).toBe(item.range!.whole ? 1 : undefined);
    } else if (typeof d === 'boolean') expect(spec.kind).toBe('toggle');
    else if (Array.isArray(d)) expect(spec.kind).toBe('list');
    else expect(['text', 'time', 'select', 'currency']).toContain(spec.kind);
  });

  it.each(numbers.map((i) => [i.setting.key, i] as const))('%s: the range the screen shows is exactly the range the engine accepts, and a refusal is the engine\'s own words', (key, item) => {
    const r = item.range!;
    const words = item.validate!(r.min - 1);
    expect(words).not.toBeNull();
    // Typed text becomes a NUMBER (the fault: it stayed a string and the engine refused every save).
    expect(parseDraft(key, String(r.min))).toEqual({ ok: true, value: r.min });
    expect(parseDraft(key, String(r.min - 1))).toEqual({ ok: false, error: words });
    if (r.max !== undefined) {
      expect(parseDraft(key, String(r.max))).toEqual({ ok: true, value: r.max });
      expect(parseDraft(key, String(r.max + 1))).toEqual({ ok: false, error: words });
    }
    if (r.whole) expect(parseDraft(key, String(r.min + 0.5))).toEqual({ ok: false, error: words });
    else expect(parseDraft(key, String(r.min + 0.5))).toEqual({ ok: true, value: r.min + 0.5 });
    // The default itself is inside the declared range — no setting's default changed meaning.
    expect(item.validate!(item.setting.defaultValue)).toBeNull();
  });

  it('the loyalty settings save as numbers through the edit controller', () => {
    const c = new SetupEditController();
    c.seed('loyalty.points_per_100_inr', 0);
    c.edit('loyalty.points_per_100_inr', '2');
    expect(c.beginSave('loyalty.points_per_100_inr')).toEqual({ ok: true, value: 2, ifVersion: 0 });
    c.seed('loyalty.till_spend_cap_paise', 3);
    c.edit('loyalty.till_spend_cap_paise', '75000');
    expect(c.beginSave('loyalty.till_spend_cap_paise')).toEqual({ ok: true, value: 75_000, ifVersion: 3 });
  });
});

describe('OB-90 — the owner sets how far a store computer\'s "I still hold N bills between X and Y" is believed, on the store-setup screen', () => {
  it('reads as whole numbers in range — 0 to 100 extra numbers, 0 to 50 percent — refused in the engine\'s words otherwise', () => {
    expect(editorFor('platform.box_claim_slack_numbers').kind).toBe('number');
    expect(editorFor('platform.box_claim_slack_percent').kind).toBe('number');
    expect(parseDraft('platform.box_claim_slack_numbers', '0')).toEqual({ ok: true, value: 0 });
    expect(parseDraft('platform.box_claim_slack_numbers', '101')).toEqual({ ok: false, error: 'Give a whole number of bill numbers, from 0 to 100.' });
    expect(parseDraft('platform.box_claim_slack_percent', '51')).toEqual({ ok: false, error: 'Give a whole percentage, from 0 to 50.' });
    expect(parseDraft('platform.box_claim_slack_percent', '2.5').ok).toBe(false);
  });
});
