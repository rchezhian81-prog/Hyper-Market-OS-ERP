// OB-423 (owner, 27 Oct 2026) · QG-10 · WF-20 — the release script's QG-10 evidence line on head office's gate register.
//
//   POST /v1/compliance/gate-register/qg10-evidence   the release script's own note for one release   compliance.qg10.evidence.push
//   GET  /v1/compliance/gate-register/qg10-evidence   every attempt's note, newest first               compliance.gate.read
//
// A note is believed ONLY from the release script's own machine identity (a machine credential holding the QG-10 evidence
// role and nothing else) — a person, the owner included, is refused (403). OB-423 (b): ONE machine login PER COMPUTER — the
// login's user id names its computer (`qg10-release-<box>`), and a note naming any other computer is refused (403) by name,
// as is a login that names none. A line that is not exactly the script's QG-10 line is refused (400, every problem named).
// OB-423 (a): every release ATTEMPT is its own note (box + release + run + attempt): the same attempt's note again is
// "already recorded" (idempotent); a DIFFERENT note claiming an attempt already noted is refused (409) — the first stands,
// nothing is overwritten (hard rules #2, #6, #10). The note is evidence for the owner's QG-10 decision, never a decision
// (QG-12).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  readQg10Note, qg10NoteKey, qg10ComputerOfLogin, newestQg10First, NotAQg10NoteError, QG10_PASS_CONDITION, QG10_LOGIN_PREFIX,
  type Qg10ReleaseNote, type Qg10EvidenceRecord,
} from '../../../packages/compliance/src/index';

export interface Qg10EvidenceDeps {
  readonly notes: (tenantId: string) => Promise<readonly Qg10EvidenceRecord[]> | readonly Qg10EvidenceRecord[];
  readonly recordNote: (tenantId: string, record: Qg10EvidenceRecord) => Promise<void> | void;
  /** A stable digest of a note's content, so the same note sent again is recognised as the same. */
  readonly digestOf: (note: Qg10ReleaseNote) => string;
  /**
   * Is this caller the release script's machine identity — a MACHINE credential (no interactive sign-in evidence), holding
   * the QG-10 evidence role and nothing else NOW? Absent on a bare stub: then no note is believed.
   */
  readonly isReleaseEvidencePush?: (tenantId: string, userId: string, evidence: { readonly authTime?: number; readonly amr?: readonly string[] } | undefined) => Promise<boolean>;
  readonly now: () => string;
}

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

export function qg10EvidenceRoutes(deps: Qg10EvidenceDeps): readonly Route[] {
  return [
    {
      // Body: { note: <the QG-10 line exactly as scripts/release-reconcile.mjs qg10 printed it> }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/gate-register/qg10-evidence',
      permission: 'compliance.qg10.evidence.push', idempotent: true,
      handler: async (ctx) => {
        if (deps.isReleaseEvidencePush === undefined || !(await deps.isReleaseEvidencePush(ctx.tenantId, ctx.userId, ctx.reauth))) {
          throw refuse(403, 'not_the_release_evidence_identity', `${ctx.userId} is not the release script's machine identity (a machine credential holding only the QG-10 release-evidence role), so this note is not believed.`, 'Only infra/deploy/release.sh posts QG-10 evidence, with the key the custodian gave the box. Nothing was recorded.');
        }
        let note: Qg10ReleaseNote;
        try {
          note = readQg10Note(((ctx.body ?? {}) as Record<string, unknown>)['note']);
        } catch (e) {
          if (e instanceof NotAQg10NoteError) {
            throw refuse(400, 'not_readable_as_a_qg10_note', `The QG-10 note could not be read: ${e.problems.join('; ')}.`, 'Send { note } exactly as scripts/release-reconcile.mjs qg10 prints it. Nothing was recorded.');
          }
          throw e;
        }
        // OB-423 (b): one machine login per computer — believed only from the login of the computer the note names.
        const computer = qg10ComputerOfLogin(ctx.userId);
        if (computer === undefined) {
          throw refuse(403, 'qg10_login_names_no_computer', `${ctx.userId} holds the QG-10 release-evidence role but its login names no computer (a QG-10 machine login is ${QG10_LOGIN_PREFIX}<computer>, one per computer), so this note is not believed.`, 'The custodian gives each computer that runs releases its own QG-10 machine login (docs/runbooks/automatic-deployment.md). Nothing was recorded.');
        }
        if (computer !== note.box) {
          throw refuse(403, 'qg10_note_names_another_computer', `${ctx.userId} is the QG-10 machine login of computer ${computer}, but this note names computer ${note.box} — one computer's login never speaks for another, so this note is not believed.`, `Computer ${note.box} posts its own notes with its own login. Nothing was recorded.`);
        }
        const digest = deps.digestOf(note);
        const sameAttempt = async (): Promise<Qg10EvidenceRecord | undefined> => (await deps.notes(ctx.tenantId)).find((r) => qg10NoteKey(r) === qg10NoteKey(note));
        const conflict = (prior: Qg10EvidenceRecord) => refuse(409, 'qg10_note_already_recorded', `Box ${note.box} already left a QG-10 note for release ${note.release}, run ${note.run}, attempt ${note.attempt} (${prior.outcome}, recorded ${prior.recordedAt}); a different note claiming the same attempt is not taken — the first stands.`, 'Nothing was recorded. A new attempt carries its own run and attempt; the box keeps every attempt in its own QG-10 log (SRE_QG10_LOG).');
        const prior = await sameAttempt();
        if (prior !== undefined) {
          if (prior.noteDigest === digest) return { status: 200, body: { note: prior, alreadyRecorded: true } };
          throw conflict(prior);
        }
        const record: Qg10EvidenceRecord = { ...note, recordedBy: ctx.userId, recordedAt: deps.now(), noteDigest: digest };
        await deps.recordNote(ctx.tenantId, record);
        // Two different notes for one attempt racing each other: the store keeps the first; the loser is told so (rule #10).
        const kept = await sameAttempt();
        if (kept !== undefined && kept.noteDigest !== digest) throw conflict(kept);
        return { status: 201, body: { note: kept ?? record, alreadyRecorded: false } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/compliance/gate-register/qg10-evidence',
      permission: 'compliance.gate.read',
      handler: async (ctx) => {
        const notes = newestQg10First(await deps.notes(ctx.tenantId));
        return {
          status: 200,
          body: {
            gate: 'QG-10', passCondition: QG10_PASS_CONDITION, notes, count: notes.length,
            says: 'Every attempt of every release, newest first. Each line is evidence from the release script for the owner\'s QG-10 decision — never a decision (QG-12).',
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
