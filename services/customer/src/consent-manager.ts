// Consent-manager interoperability — export and import of the consent ledger (C8 · OB-324 · DPDP Rules 2025 Rule 4 and
// the First Schedule · M16-FR-02 · P-04 · P-06 · P-08 · hard rules #2, #6 and #10).
//
// The rules are pure in packages/customer/src/consent-manager-format.ts. Here:
//   • GET  …/export            the whole shop's consent record, or one customer's (?dataPrincipalRef=), in the
//                              consent-manager layout; who exported it is recorded (nothing leaves anonymously).
//   • POST …/import            a consent manager's records for this shop: each judged against the ledger — withdrawals and
//                              denials applied at once, a grant applied only when newer than everything held; a grant
//                              older than a withdrawal the shop holds becomes a visible exception, never applied.
//                              Idempotent per artefact. The whole document is refused if any record cannot be read.
//   • GET  …/exceptions        every conflict an import raised, kept (never deleted), for a person to settle with the
//                              customer through the ordinary consent route.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  buildConsentExport, readConsentImport, judgeImport, importEvidence,
  type LedgerConsent,
} from '../../../packages/customer/src/consent-manager-format';
import type { ConsentRecord } from './index';

export interface ConsentImportException {
  readonly exceptionId: string;
  readonly importId: string;
  readonly consentManagerId: string;
  readonly artefactId: string;
  readonly dataPrincipalRef: string;
  readonly purpose: string;
  readonly channel: string;
  readonly detail: string;
  readonly raisedBy: string;
  readonly at: string;
}

export interface ConsentManagerDeps {
  /** Every consent fact the shop holds (the export's source), or one principal's. */
  readonly ledger: (tenantId: string, dataPrincipalRef?: string) => Promise<readonly LedgerConsent[]>;
  /** The SAME append the consent route uses (one ledger, P-02). */
  readonly appendConsent: (tenantId: string, r: ConsentRecord) => Promise<void>;
  readonly exceptions: (tenantId: string) => Promise<readonly ConsentImportException[]>;
  readonly recordException: (tenantId: string, e: ConsentImportException) => Promise<void>;
  /** The shop's registered name for the document, or undefined (then "not set"). */
  readonly fiduciaryName: (tenantId: string) => Promise<string | undefined>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

export function consentManagerRoutes(deps: ConsentManagerDeps): readonly Route[] {
  return [
    {
      api: 'API-06', method: 'GET', path: '/v1/privacy/consent-manager/export',
      permission: 'customer.consent.export',
      handler: async (ctx) => {
        const ref = (ctx.query['dataPrincipalRef'] ?? '').trim();
        const at = deps.now();
        const doc = buildConsentExport({
          tenantId: ctx.tenantId, fiduciaryName: (await deps.fiduciaryName(ctx.tenantId)) ?? 'not set',
          ledger: await deps.ledger(ctx.tenantId, ref === '' ? undefined : ref), ...(ref === '' ? {} : { dataPrincipalRef: ref }),
          generatedAt: at, generatedBy: ctx.userId,
        });
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'privacy.consent.export', objectType: 'consent_record', objectId: ref === '' ? 'whole_shop' : ref, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { records: String(doc.counts.records), dataPrincipals: String(doc.counts.dataPrincipals) }, correlationId: `consent-export:${at}`,
        });
        return { status: 200, body: doc };
      },
    },
    {
      api: 'API-06', method: 'POST', path: '/v1/privacy/consent-manager/import',
      permission: 'customer.consent.import', idempotent: true,
      handler: async (ctx) => {
        const at = deps.now();
        const read = readConsentImport(ctx.body, { tenantId: ctx.tenantId, now: at });
        if (!read.ok) {
          throw apiError(read.reason === 'wrong_shop' ? 409 : 400, { code: read.reason, whatHappened: `${read.detail}.`, wasItSaved: 'not_saved', nextSafeAction: 'Ask the consent manager for a readable record addressed to this shop. Nothing was imported.' });
        }
        const importId = `cm-import-${read.consentManager.id}-${ctx.idempotencyKey ?? at}`;
        const tally = { applied: 0, withdrawalsApplied: 0, alreadyReflected: 0, alreadyImported: 0, exceptions: [] as ConsentImportException[] };
        const ledgers = new Map<string, LedgerConsent[]>();
        for (const rec of read.records) {
          const held = ledgers.get(rec.dataPrincipalRef) ?? [...await deps.ledger(ctx.tenantId, rec.dataPrincipalRef)];
          ledgers.set(rec.dataPrincipalRef, held);
          const j = judgeImport(rec, read.consentManager.id, held);
          if (j.kind === 'already_imported') { tally.alreadyImported += 1; continue; }
          if (j.kind === 'already_reflected') { tally.alreadyReflected += 1; continue; }
          if (j.kind === 'exception') {
            const e: ConsentImportException = {
              exceptionId: `${read.consentManager.id}:${rec.artefactId}`, importId, consentManagerId: read.consentManager.id, artefactId: rec.artefactId,
              dataPrincipalRef: rec.dataPrincipalRef, purpose: rec.purpose, channel: rec.channel, detail: j.detail, raisedBy: ctx.userId, at,
            };
            await deps.recordException(ctx.tenantId, e);
            tally.exceptions.push(e);
            continue;
          }
          const record: ConsentRecord = {
            customerId: rec.dataPrincipalRef, purpose: rec.purpose, channel: rec.channel, given: j.given, recordedAt: rec.at,
            evidence: importEvidence(read.consentManager.id, rec.artefactId, rec.noticeReference),
          };
          await deps.appendConsent(ctx.tenantId, record);
          held.push({ eventId: `import-${rec.artefactId}`, ...record });
          tally.applied += 1;
          if (!j.given) tally.withdrawalsApplied += 1;
        }
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'privacy.consent.import', objectType: 'consent_record', objectId: importId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { consentManager: read.consentManager.id, applied: String(tally.applied), exceptions: String(tally.exceptions.length) }, correlationId: importId,
        });
        return { status: 200, body: { importId, consentManager: read.consentManager, received: read.records.length, ...tally } };
      },
    },
    {
      // Read by whoever settles them (they hold the consent write the settling goes through) — not every consent reader.
      api: 'API-06', method: 'GET', path: '/v1/privacy/consent-manager/exceptions',
      permission: 'customer.consent.write',
      handler: async (ctx) => {
        const list = await deps.exceptions(ctx.tenantId);
        return { status: 200, body: { exceptions: list, count: list.length } };
      },
    },
  ];
}
