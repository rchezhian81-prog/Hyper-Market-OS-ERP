// WHICH BUILD MADE THIS HANDHELD RECORD? (Round 9 · OB-537 · M33-FR-02 · D12-FR-03 · A-10 · P-03 · P-08 · hard rules #6, #10)
//
// Round 7 (OB-501) made every till sale carry the app version that rang it; the store computer MARKS a sale from a build its
// signed pack withdraws or no longer supports, and head office raises it as an exception — the sale stands. Round 8 (OB-521)
// put the same version rule on the handhelds, but only on the device: their records said nothing about the build that made
// them, so neither the store computer nor head office could see work done on a barred build.
//
// OB-537 (owner, 28 Oct 2026, in writing): every handheld record (warehouse, picker, driver, queue till) carries the app
// version that made it; the store computer and head office flag work done on a withdrawn or too-old build as a visible
// exception — never refused after the fact, never silently dropped — as round 7 did for till sales.
//
//   • The device stamps its build on each record WHEN IT IS QUEUED (`OutboxItem.appVersion`), so a record queued on an old
//     build and sent after an update still names the old build.
//   • The store computer writes `handheldBuild` onto the record it keeps and sends — which handheld, the build it reported
//     (or `null`), and its own mark (`storeComputerVersionCheck`) when its signed pack says that build should not have
//     started new work, or when the record reported no build while a policy is in force. It never refuses the record for it.
//   • Head office judges the same build against ITS OWN policy and keeps a finding on its append-only register: material for
//     a withdrawn or too-old build (by its policy or the store computer's mark), informational for "no build reported".
//
// Pure: no clock, no I/O.

import type { VersionPolicy } from './devices';
import { judgeClientVersion, readPackVersionPolicy, type ClientVersionVerdict } from './client-version';

/** The field the store computer writes on a handheld record's payload. Head office reads it and takes it off. */
export const HANDHELD_BUILD_FIELD = 'handheldBuild';

/** The handhelds OB-537 names. */
export const HANDHELD_CLIENTS = Object.freeze(['warehouse', 'picker', 'driver', 'queue_till'] as const);
export type HandheldClient = (typeof HANDHELD_CLIENTS)[number];
export const isHandheldClient = (v: unknown): v is HandheldClient => typeof v === 'string' && (HANDHELD_CLIENTS as readonly string[]).includes(v);

/** The store computer's mark on a record from a build its signed pack says should not have started new work. */
export interface StoreComputerBuildMark {
  readonly verdict: ClientVersionVerdict;
  readonly reported: string | null;
  readonly minimumSupportedVersion: string | null;
}

/** What a handheld record carries about the build that made it. */
export interface HandheldBuild {
  readonly client: HandheldClient;
  /** The build the device reported when it queued the record; `null` = it reported none (a device older than OB-537). */
  readonly appVersion: string | null;
  /** Present only when the store computer flagged it. */
  readonly storeComputerVersionCheck?: StoreComputerBuildMark;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A device's reported build: text, or absent. Anything else is not a build (the record is refused as malformed). */
export function readReportedBuild(v: unknown): { readonly ok: true; readonly appVersion: string | undefined } | { readonly ok: false } {
  if (v === undefined) return { ok: true, appVersion: undefined };
  if (typeof v === 'string' && v.trim() !== '' && v.length <= 64) return { ok: true, appVersion: v.trim() };
  return { ok: false };
}

/**
 * The store computer's judgement of a handheld's build against its signed pack's policy (`packPolicy` as the pack holds it;
 * `undefined` = the pack has none). Always returns what the record carries; the mark only when it is flagged.
 */
export function storeComputerBuildOf(client: HandheldClient, appVersion: string | null | undefined, packPolicy: unknown): HandheldBuild {
  const reported = isStr(appVersion) ? appVersion.trim() : null;
  const base: HandheldBuild = { client, appVersion: reported };
  const policy = packPolicy === undefined ? undefined : readPackVersionPolicy(packPolicy);
  if (policy === undefined) return base;
  const judged = judgeClientVersion(reported, policy, client);
  if (judged.mayStartWork && judged.verdict !== 'no_version_reported') return base;
  return { ...base, storeComputerVersionCheck: { verdict: judged.verdict, reported: judged.reported, minimumSupportedVersion: judged.minimumSupportedVersion } };
}

/** Read what a record says about its build, or undefined when it says nothing readable. */
export function readHandheldBuild(v: unknown): HandheldBuild | undefined {
  if (!isObj(v) || !isHandheldClient(v['client'])) return undefined;
  const appVersion = isStr(v['appVersion']) ? v['appVersion'].trim() : null;
  const m = v['storeComputerVersionCheck'];
  const mark: StoreComputerBuildMark | undefined = isObj(m) && isStr(m['verdict'])
    ? { verdict: m['verdict'] as ClientVersionVerdict, reported: isStr(m['reported']) ? m['reported'] : null, minimumSupportedVersion: isStr(m['minimumSupportedVersion']) ? m['minimumSupportedVersion'] : null }
    : undefined;
  return { client: v['client'], appVersion, ...(mark === undefined ? {} : { storeComputerVersionCheck: mark }) };
}

/** A record's payload with the build written on (the store computer), or taken off (head office, before its handler). */
export function withHandheldBuild<T extends Record<string, unknown>>(payload: T, build: HandheldBuild): T & { readonly handheldBuild: HandheldBuild } {
  return { ...payload, [HANDHELD_BUILD_FIELD]: build } as T & { readonly handheldBuild: HandheldBuild };
}
export function withoutHandheldBuild(payload: unknown): { readonly build: HandheldBuild | undefined; readonly payload: unknown; readonly carried: boolean } {
  if (!isObj(payload) || !(HANDHELD_BUILD_FIELD in payload)) return { build: undefined, payload, carried: false };
  const rest = { ...payload };
  const build = readHandheldBuild(rest[HANDHELD_BUILD_FIELD]);
  delete rest[HANDHELD_BUILD_FIELD];
  return { build, payload: rest, carried: true };
}

const CLIENT_NAME: Readonly<Record<HandheldClient, string>> = Object.freeze({
  warehouse: 'a warehouse handheld', picker: 'a picking handheld', driver: 'a delivery phone', queue_till: 'a queue till',
});

/** Head office's finding on one handheld record's build, or undefined when there is nothing to flag. */
export interface HandheldBuildFinding {
  readonly severity: 'material' | 'informational';
  readonly verdict: ClientVersionVerdict;
  readonly client: HandheldClient;
  readonly appVersion: string | null;
  /** The store computer's own verdict, when it marked the record. */
  readonly markedByStoreComputer: ClientVersionVerdict | null;
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * Head office's judgement: its OWN policy (`undefined` = none set) first, then the store computer's mark. Material for a
 * build that should not have started new work; informational for a record that reported no build while the store computer
 * held a policy (a device older than OB-537 cannot report one). The record stands either way.
 */
export function judgeHandheldBuild(build: HandheldBuild, policy: VersionPolicy | undefined, what: string): HandheldBuildFinding | undefined {
  const boxVerdict = build.storeComputerVersionCheck?.verdict;
  const judged = policy === undefined ? undefined : judgeClientVersion(build.appVersion, policy, build.client);
  const headOffice = judged !== undefined && !judged.mayStartWork ? judged.verdict : undefined;
  const marked = boxVerdict === 'version_killed' || boxVerdict === 'upgrade_required' ? boxVerdict : undefined;
  const verdict = headOffice ?? marked;
  const who = CLIENT_NAME[build.client];
  if (verdict === undefined) {
    if (boxVerdict !== 'no_version_reported' || build.appVersion !== null) return undefined;
    return {
      severity: 'informational', verdict: 'no_version_reported', client: build.client, appVersion: null, markedByStoreComputer: boxVerdict,
      detail: `${what} was done on ${who} that did not report its app version (the store computer marked it)`,
      ownerAction: 'That handheld is older than the version rule. Update it to the current version so it can be held to the rule.',
    };
  }
  const minimum = judged?.minimumSupportedVersion ?? build.storeComputerVersionCheck?.minimumSupportedVersion ?? null;
  const why = verdict === 'version_killed' ? 'head office has withdrawn' : `is below the minimum supported version${minimum === null ? '' : ` ${minimum}`}`;
  return {
    severity: 'material', verdict, client: build.client, appVersion: build.appVersion, markedByStoreComputer: boxVerdict ?? null,
    detail: `${what} was done on ${who} on app ${build.appVersion ?? 'an unreported version'}, which ${why}${marked !== undefined ? ' (the store computer marked it too)' : ''}`,
    ownerAction: 'Update that handheld to the current version. A handheld on such a build finishes the work it had started and then refuses new work, so new work done after the change means it did not get the rule — check its store computer has the current pack. The record stands.',
  };
}
