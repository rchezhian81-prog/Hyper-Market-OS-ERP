// OB-423 (owner, 27 Oct 2026) · QG-10 — the release script's QG-10 evidence notes on head office's durable store. Head-office
// wiring only: the reader is `packages/compliance/src/qg10-evidence.ts`, the routes `services/compliance/src/qg10-evidence.ts`.
//
// One append-only stream (hard rules #2, #6): each note is its own fact, keyed on the release ATTEMPT — the box, the release,
// the pipeline run and the attempt (OB-423 (a)) — so a re-sent note collapses and nothing is ever overwritten. `qg10EvidenceRoutes` is this file's one registration in main.ts.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { qg10NoteKey, type Qg10EvidenceRecord, type Qg10ReleaseNote } from '../../../packages/compliance/src/index';
import { qg10EvidenceRoutes as routesOver, type Qg10EvidenceDeps } from '../../compliance/src/qg10-evidence';
import { isMachineCredential } from '../../identity/src/machine-identities';
import { rolesHeldNow, STREAM, streamName } from './adapters';
import { QG10_EVIDENCE_PUSH_ROLE_ID } from './roles';

export const QG10_EVIDENCE_STREAM = streamName(STREAM.compliance, 'qg10-release-evidence');
const EVENT_TYPE = 'Qg10ReleaseEvidenceRecorded';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** The note's content, keys in a fixed order, so the same note always has the same digest. */
const canonical = (n: Qg10ReleaseNote): string => JSON.stringify([n.gate, n.release, n.previous, n.at, n.by, n.run, n.attempt, n.box, n.outcome, n.checks, n.verified, n.notVerified, n.differences]);

export function qg10EvidenceAdapter(input: { readonly store: EventStore; readonly now: () => string }): Qg10EvidenceDeps {
  const { store, now } = input;
  return {
    now,
    notes: async (tenantId) => (await store.readStream(tenantId, QG10_EVIDENCE_STREAM, { type: EVENT_TYPE })).map((e) => e.event.payload as unknown as Qg10EvidenceRecord),
    recordNote: async (tenantId, record) => {
      const d = sha(qg10NoteKey(record)).slice(0, 24);
      await store.append(tenantId, QG10_EVIDENCE_STREAM, makeEvent({
        id: `${EVENT_TYPE}-${d}`, type: EVENT_TYPE, occurredAt: record.recordedAt, idempotencyKey: `${EVENT_TYPE}-${tenantId}-${d}`,
        source: 'api/compliance', payload: record as unknown as Record<string, unknown>,
      }));
    },
    digestOf: (note) => sha(canonical(note)),
    // A note is believed only from the release script's machine identity: a machine credential, holding the QG-10 evidence
    // role and nothing else NOW (a live emergency grant of anything else included), never a person.
    isReleaseEvidencePush: async (tenantId, userId, evidence) => {
      if (!isMachineCredential(evidence)) return false;
      const held = await rolesHeldNow(store, tenantId, userId, now());
      return held.includes(QG10_EVIDENCE_PUSH_ROLE_ID) && held.every((r) => r === QG10_EVIDENCE_PUSH_ROLE_ID);
    },
  };
}

/** This file's one registration in main.ts. Without a durable store every call answers 503 by name (P-08). */
export function qg10EvidenceRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string }): readonly Route[] {
  const { store, now } = input;
  if (store === undefined) {
    const absent = (): never => {
      throw apiError(503, { code: 'register_store_not_available', whatHappened: 'Head office is running without its durable store, so the QG-10 release evidence cannot be read or written.', wasItSaved: 'not_saved', nextSafeAction: 'Start head office with its database. Nothing was read or saved.' });
    };
    return routesOver({ now, notes: absent, recordNote: absent, digestOf: () => '', isReleaseEvidencePush: async () => absent() });
  }
  return routesOver(qg10EvidenceAdapter({ store, now }));
}
