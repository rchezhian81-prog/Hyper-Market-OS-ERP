// Versioned configuration with rollback (M01-FR-03) — configuration changes far
// more often than code, and an unversioned change is a common cause of outages.
// So every change is a NEW immutable version with author, reason and effective
// date; rollback restores a prior version's value as a NEW version (append-only,
// never destructive — §29.1). Full history is retained. Pure, in-memory (a
// durable store slots in later); timestamps are injected so it stays deterministic.

import { isIsoUtcTimestamp } from '../../contracts/src/event';

export interface ConfigVersion<T = unknown> {
  readonly key: string;
  /** 1-based, monotonic per key. */
  readonly version: number;
  readonly value: T;
  readonly author: string;
  readonly reason: string;
  /** ISO-8601 UTC (injected). */
  readonly effectiveAt: string;
  /** The version this one restored, if it was created by a rollback; else null. */
  readonly rolledBackFrom: number | null;
}

function requireNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RangeError(`Config ${field} must be a non-empty string.`);
  }
}

function requireTimestamp(effectiveAt: string): void {
  if (!isIsoUtcTimestamp(effectiveAt)) {
    throw new RangeError(`effectiveAt must be an ISO-8601 UTC timestamp, got "${effectiveAt}".`);
  }
}

/** An append-only, versioned configuration store with one-step rollback. */
export class ConfigStore<T = unknown> {
  private readonly versionsByKey = new Map<string, ConfigVersion<T>[]>();

  private append(entry: ConfigVersion<T>): ConfigVersion<T> {
    const list = this.versionsByKey.get(entry.key) ?? [];
    list.push(entry);
    this.versionsByKey.set(entry.key, list);
    return entry;
  }

  /** Record a new configuration value as the next version. */
  set(key: string, value: T, author: string, reason: string, effectiveAt: string): ConfigVersion<T> {
    requireNonEmpty('key', key);
    requireNonEmpty('author', author);
    requireNonEmpty('reason', reason);
    requireTimestamp(effectiveAt);
    const version = (this.versionsByKey.get(key)?.length ?? 0) + 1;
    return this.append(
      Object.freeze({ key, version, value, author, reason, effectiveAt, rolledBackFrom: null }),
    );
  }

  /** The current (latest) version for a key, or undefined if none. */
  current(key: string): ConfigVersion<T> | undefined {
    const list = this.versionsByKey.get(key);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  /** Full version history for a key, oldest first (a copy — never the internal array). */
  history(key: string): readonly ConfigVersion<T>[] {
    return (this.versionsByKey.get(key) ?? []).slice();
  }

  /**
   * Roll back to a prior version by creating a NEW version that restores its
   * value (append-only — the intervening versions are kept, not deleted).
   */
  rollback(
    key: string,
    toVersion: number,
    author: string,
    reason: string,
    effectiveAt: string,
  ): ConfigVersion<T> {
    requireNonEmpty('author', author);
    requireNonEmpty('reason', reason);
    requireTimestamp(effectiveAt);
    const list = this.versionsByKey.get(key);
    if (!list) {
      throw new RangeError(`No configuration for key "${key}".`);
    }
    const target = list.find((v) => v.version === toVersion);
    if (!target) {
      throw new RangeError(`No version ${toVersion} for key "${key}".`);
    }
    return this.append(
      Object.freeze({
        key,
        version: list.length + 1,
        value: target.value,
        author,
        reason,
        effectiveAt,
        rolledBackFrom: toVersion,
      }),
    );
  }
}
