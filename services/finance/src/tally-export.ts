// API-09 Finance — the accounts-payable vouchers as a Tally import file (WF-05 "→ AP/Tally" · M23-FR-04 · AVR-09).
//
// The payables posting run (`payables.ts`) turns every supplier's account into balanced journals in our own ledger. This
// surface hands the accountant a COPY of those journals in Tally's import format, through the tested `@sre/tally-export`
// writer, and reads the file straight back through its stand-in import check before anyone downloads it:
//
//   • LEDGER NAMES (`POST /v1/finance/tally/ledger-names`, the accountant) — which Tally ledger each of our account codes is.
//     Versioned and append-only; the latest applies; every version stays on the ledger. Never guessed: an unmapped code keeps
//     its vouchers out of the file, by name.
//   • EXPORT (`GET /v1/finance/tally/ap-vouchers?period=YYYY-MM`) — every payables journal posted to that period, as one file:
//     vouchers keyed by our entry id (a re-import is the same vouchers), control totals, every exception, and the stand-in's
//     verdict. A period with no payables journals is said as such — an empty file is never offered as "the month".
//
// Read-only over the ledger: the export writes nothing to the books (Tally is a destination, not the book of record).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { buildTallyVouchers, validateTallyImport, type TallyJournal } from '../../../packages/tally-export/src/index';
import type { JournalEntry } from './index';

/** The accountant's map from our account codes to Tally ledger names — one version of it. */
export interface TallyLedgerNames {
  readonly companyName: string;
  readonly names: Readonly<Record<string, string>>;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
}

/** A journal the export may carry, and (for a payables voucher) which supplier it is for. */
export type ExportableJournal = JournalEntry & { readonly payables?: { readonly kind: string; readonly supplierId: string } };

export interface TallyExportDeps {
  /** The latest ledger-name map, or undefined when the accountant has set none. */
  readonly ledgerNames: (tenantId: string) => Promise<TallyLedgerNames | undefined> | TallyLedgerNames | undefined;
  readonly recordLedgerNames: (tenantId: string, names: TallyLedgerNames) => Promise<void> | void;
  /** Every payables journal on the ledger (accruals, reversals, debit notes, payments). */
  readonly payablesJournals: (tenantId: string) => Promise<readonly ExportableJournal[]> | readonly ExportableJournal[];
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPeriod = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** Our journal as the writer's input — a payables voucher is a Tally `Journal`, numbered by its own entry id. */
export const asTallyJournal = (j: ExportableJournal): TallyJournal => ({
  entryId: j.entryId, documentDate: j.documentDate, narrative: j.narrative, voucherType: 'Journal',
  lines: j.lines.map((l) => ({ accountCode: l.accountCode, debitMinor: l.debitMinor, creditMinor: l.creditMinor })),
});

export function tallyExportRoutes(deps: TallyExportDeps): readonly Route[] {
  return [
    {
      // The accountant names the Tally company and the Tally ledger for each account code. Body: { companyName, names: { code: ledger } }.
      api: 'API-09', method: 'POST', path: '/v1/finance/tally/ledger-names',
      permission: 'finance.posting.configure', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const names = b['names'];
        if (!isStr(b['companyName']) || !isObj(names) || Object.keys(names).length === 0
          || !Object.entries(names).every(([code, name]) => code.trim() !== '' && isStr(name) && name.length <= 200)) {
          throw apiError(400, {
            code: 'not_readable_as_tally_ledger_names',
            whatHappened: 'Tally ledger names need { companyName, names: { "<account code>": "<Tally ledger name>" } } with at least one account.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the Tally company and the ledger name for each account code. Nothing was changed.',
          });
        }
        const prior = await deps.ledgerNames(ctx.tenantId);
        const record: TallyLedgerNames = {
          companyName: (b['companyName'] as string).trim(),
          names: Object.fromEntries(Object.entries(names as Record<string, string>).map(([c, n]) => [c.trim(), n.trim()])),
          version: (prior?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordLedgerNames(ctx.tenantId, record);
        return { status: 201, body: { ledgerNames: record } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/tally/ledger-names',
      permission: 'finance.period.read',
      handler: async (ctx) => ({ status: 200, body: { ledgerNames: (await deps.ledgerNames(ctx.tenantId)) ?? null } }),
    },
    {
      // The period's payables vouchers as a Tally import file, checked by the stand-in before it is offered.
      api: 'API-09', method: 'GET', path: '/v1/finance/tally/ap-vouchers',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const period = ctx.query['period'];
        if (!isPeriod(period)) {
          throw apiError(400, { code: 'period_required', whatHappened: 'Say which month to export: ?period=YYYY-MM.', wasItSaved: 'not_saved', nextSafeAction: 'Send the month. Nothing was changed.' });
        }
        const map = await deps.ledgerNames(ctx.tenantId);
        if (map === undefined) {
          throw apiError(409, {
            code: 'tally_ledgers_not_named',
            whatHappened: 'The accountant has not yet said which Tally ledger each account is, so no voucher can be written — which ledger a figure goes to in Tally is their decision, not the system\'s.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant sets the Tally company and ledger names (POST /v1/finance/tally/ledger-names), then export again. Nothing was changed.',
          });
        }
        const journals = (await deps.payablesJournals(ctx.tenantId)).filter((j) => j.period === period);
        if (journals.length === 0) {
          return { status: 200, body: { period, known: true, empty: true, detail: `No payables vouchers are posted to ${period}. Nothing to send to Tally for this month yet — this is not a file of the month.`, vouchers: [], exceptions: [], asAt: deps.now() } };
        }
        const out = buildTallyVouchers({ companyName: map.companyName, ledgerNames: map.names, journals: journals.map(asTallyJournal) });
        const check = validateTallyImport(out.xml, out.controlTotals);
        return {
          status: 200,
          body: {
            period, empty: false, fileName: `sre-ap-vouchers-${period}.xml`, contentType: 'application/xml',
            xml: out.xml, vouchers: out.vouchers, exceptions: out.exceptions, controlTotals: out.controlTotals,
            complete: out.complete, check: { ok: check.ok, problems: check.problems, totals: check.totals },
            ledgerNamesVersion: map.version, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
