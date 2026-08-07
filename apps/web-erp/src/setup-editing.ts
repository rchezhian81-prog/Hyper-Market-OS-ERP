// Store-setup inline editing — the logic (M33-FR-01 / M01-FR-02/03 / ADR-0003 §4).
//
// Editing a setting from the setup page is a small state machine, and — as everywhere in this
// codebase — the machine lives here, tested, not in the browser view. It turns what a person types
// into the setting's real type, validates it with the SAME rules the engine and API enforce (so the
// screen never lets through what the server would refuse), and tracks each field through
// idle → saving → saved / queued / failed / conflict, refusing a second submit while one is in
// flight and carrying the version so a stale save cannot clobber a newer one.
//
// The async save itself (the API call, offline queueing) is the browser's job and is injected as a
// port, so this module is pure and deterministic.

import {
  setupItem, InvalidSetupAnswerError,
} from '../../../packages/tenant/src/index';
import { PAPER_FORMATS } from '../../../packages/receipt/src/index';

/** How a setting is edited on the page. */
export type EditorKind = 'number' | 'decimal' | 'time' | 'toggle' | 'list' | 'select' | 'currency' | 'text';

export interface EditorOption {
  readonly id: string;
  readonly label: string;
}

export interface EditorSpec {
  readonly kind: EditorKind;
  readonly options?: readonly EditorOption[];
}

/** Which input each setting uses. Anything unlisted is plain text (still engine-validated on save). */
const KINDS: Readonly<Record<string, EditorSpec>> = {
  'tax.default_bps': { kind: 'number' },
  'trading_day.cutoff': { kind: 'time' },
  'receipt.paper_format': { kind: 'select', options: PAPER_FORMATS.map((f) => ({ id: f.id, label: f.label })) },
  'locale.languages': { kind: 'list' },
  'locale.currency': { kind: 'currency' },
  'production.departments': { kind: 'list' },
  'picking.zone_order': { kind: 'list' },
  'delivery.radius_km': { kind: 'decimal' },
  'pos.age_restricted.minimum_age': { kind: 'number' },
  'pos.licence_hours.enabled': { kind: 'toggle' },
  'merchandising.shelf_count_stale_after_minutes': { kind: 'number' },
  'merchandising.shelf_refill_at_bp': { kind: 'number' },
};

export function editorFor(key: string): EditorSpec {
  return KINDS[key] ?? { kind: 'text' };
}

export type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/**
 * Turn raw input into the setting's real type, then validate it with the engine's own rule. The
 * error text is the rule's plain sentence, so what the field says and what the server would say
 * are the same words.
 */
export function parseDraft(key: string, raw: unknown): ParseResult {
  const item = setupItem(key);
  if (item === undefined) return { ok: false, error: `There is no setting called ${key}.` };
  const spec = editorFor(key);

  let value: unknown;
  switch (spec.kind) {
    case 'number':
    case 'decimal': {
      const text = String(raw).trim();
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) return { ok: false, error: 'Enter a number.' };
      value = n;
      break;
    }
    case 'toggle':
      value = raw === true || raw === 'true' || raw === 'on';
      break;
    case 'list':
      value = String(raw).split(/[\n,]/).map((x) => x.trim()).filter((x) => x !== '');
      break;
    case 'currency':
      value = String(raw).trim().toUpperCase();
      break;
    case 'select':
    case 'time':
    case 'text':
    default:
      value = String(raw).trim();
      break;
  }

  const problem = item.validate ? item.validate(value) : null;
  if (problem !== null) return { ok: false, error: problem };
  return { ok: true, value };
}

// ── The per-field save state machine ────────────────────────────────────────

export type FieldStatus = 'idle' | 'saving' | 'saved' | 'queued' | 'failed' | 'conflict';

export interface FieldState {
  readonly status: FieldStatus;
  /** True once edited and not yet saved — drives the unsaved-changes warning. */
  readonly dirty: boolean;
  readonly draft: unknown;
  /** Inline validation message for the current draft, or null. */
  readonly error: string | null;
  /** The version a save will be made against (optimistic concurrency). */
  readonly version: number;
  /** On a conflict, the version the server now holds. */
  readonly conflictVersion?: number;
  /** On a failure, why. */
  readonly message?: string;
}

/** The result the browser reports back after attempting the injected save. */
export type SaveResult =
  | { readonly kind: 'saved'; readonly version: number }
  | { readonly kind: 'queued' }
  | { readonly kind: 'conflict'; readonly currentVersion: number }
  | { readonly kind: 'failed'; readonly message: string };

/** What `beginSave` hands back: either a payload to send, or why it will not send. */
export type BeginSave =
  | { readonly ok: true; readonly value: unknown; readonly ifVersion: number }
  | { readonly ok: false; readonly reason: 'not_dirty' | 'in_flight' | 'invalid'; readonly error?: string };

const idle = (version: number): FieldState => ({ status: 'idle', dirty: false, draft: undefined, error: null, version });

export class SetupEditController {
  private readonly fields = new Map<string, FieldState>();

  /** Learn a field's current version from the loaded status (idempotent; keeps a dirty draft). */
  seed(key: string, version: number): void {
    const existing = this.fields.get(key);
    if (existing === undefined) this.fields.set(key, idle(version));
    else if (!existing.dirty && existing.status !== 'saving') this.fields.set(key, { ...existing, version });
  }

  state(key: string): FieldState {
    return this.fields.get(key) ?? idle(0);
  }

  /** Record a keystroke: mark dirty and validate inline. A no-op while a save is in flight. */
  edit(key: string, raw: unknown): FieldState {
    const current = this.state(key);
    if (current.status === 'saving') return current;
    const parsed = parseDraft(key, raw);
    const next: FieldState = {
      ...current,
      status: 'idle',
      dirty: true,
      draft: raw,
      error: parsed.ok ? null : parsed.error,
      message: undefined,
      conflictVersion: undefined,
    };
    this.fields.set(key, next);
    return next;
  }

  /** Discard the draft and return to the last saved state. */
  reset(key: string): FieldState {
    const current = this.state(key);
    const next = idle(current.version);
    this.fields.set(key, next);
    return next;
  }

  /**
   * Attempt to start a save. Refuses if nothing changed, if a save is already in flight (so a
   * double-click cannot submit twice), or if the draft is invalid. On success returns the payload
   * and marks the field `saving`.
   */
  beginSave(key: string): BeginSave {
    const current = this.state(key);
    if (current.status === 'saving') return { ok: false, reason: 'in_flight' };
    if (!current.dirty) return { ok: false, reason: 'not_dirty' };
    const parsed = parseDraft(key, current.draft);
    if (!parsed.ok) {
      this.fields.set(key, { ...current, error: parsed.error });
      return { ok: false, reason: 'invalid', error: parsed.error };
    }
    this.fields.set(key, { ...current, status: 'saving', error: null });
    return { ok: true, value: parsed.value, ifVersion: current.version };
  }

  /** Fold the browser's save outcome back into the field's state. */
  onResult(key: string, result: SaveResult): FieldState {
    const current = this.state(key);
    let next: FieldState;
    switch (result.kind) {
      case 'saved':
        next = { ...current, status: 'saved', dirty: false, error: null, version: result.version, message: undefined, conflictVersion: undefined };
        break;
      case 'queued':
        // Offline: accepted into the outbox. Not dirty (it will send), but not confirmed either.
        next = { ...current, status: 'queued', dirty: false, error: null, message: undefined };
        break;
      case 'conflict':
        // Someone changed it since we loaded. Keep the draft so the person can re-apply it.
        next = { ...current, status: 'conflict', conflictVersion: result.currentVersion, message: undefined };
        break;
      case 'failed':
        next = { ...current, status: 'failed', message: result.message };
        break;
    }
    this.fields.set(key, next);
    return next;
  }

  /** From a failure or a conflict, re-enable editing/saving (the view reloads first on a conflict). */
  retry(key: string): FieldState {
    const current = this.state(key);
    const next: FieldState = { ...current, status: 'idle', message: undefined };
    this.fields.set(key, next);
    return next;
  }

  /** True if any field has an un-saved edit — the page warns before it is left. */
  hasUnsavedChanges(): boolean {
    for (const state of this.fields.values()) if (state.dirty) return true;
    return false;
  }
}

/** Map an API error code/HTTP status to the save result the controller understands. */
export function saveResultFromError(status: number, currentVersion: number, message: string): SaveResult {
  if (status === 409) return { kind: 'conflict', currentVersion };
  return { kind: 'failed', message };
}

export { InvalidSetupAnswerError };
