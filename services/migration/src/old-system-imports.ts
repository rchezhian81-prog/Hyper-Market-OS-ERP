// API-12 — IMPORT FROM THE OLD SYSTEM, gaps fixed here (owner, 7 Nov 2026, OB-704 · M30 · MG-02 · MG-05 · M03-FR-03 · P-04).
//
// The store PC's import page reads the old ERP's Excel reports ON THE PC (they never leave it) and keeps what it read in
// the shop's data folder. Head office keeps two kinds of fact about it, each append-only and each in the signed-in
// person's own name (never a name in the body):
//
//   • the IMPORT — its id, the fingerprint (digest) of what the PC read, the files' names, sizes and digests, how many
//     items it found, the day the rates were read and the day the old ERP's backup was restored and checked (MG-02).
//     One import id, one fingerprint: a different read is a new import, never a silent replacement.
//   • each FIX — one person's correction of one gap of one item (a barcode, a price, the label facts, "not in this
//     department") — or, by Finance only, its HSN and GST rate. Kept for ever; the latest fix of a kind applies.
//
// Who may fix what is the separation the owner's roles already draw: a GST rate is a tax decision, so only Finance
// (`catalogue.tax.approve` — the accountant or the owner); everything else whoever runs the load (`migration.load.record`
// — the owner or the store manager). Finance reads the fixes through its own route, so it needs no load right to see them.
// Every route refuses a production target first (hard rule #7).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { validateFix, type FixKind, type ImportFix } from '../../../packages/migration/src/old-system-import';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { assertSafeTarget } from './guards';
import type { MigrationDeps } from './index';

export interface OldSystemImportRecord {
  readonly importId: string;
  readonly source: string;
  /** The fingerprint of what the PC read (its item list), so the page can prove it reads the same thing. */
  readonly readDigest: string;
  readonly files: readonly { readonly role: string; readonly name: string; readonly bytes: number; readonly digest: string }[];
  readonly items: number;
  readonly ratesFrom: string;
  readonly backupRestoredOn: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

const ID = /^[A-Za-z0-9._-]{1,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const notWired = (): never => { throw apiError(503, { code: 'old_system_imports_not_wired', whatHappened: 'This server keeps no old-system imports.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. Run the import on the store computer\'s own copy of head office.' }); };
const NAMED_IN_BODY = ['by', 'recordedBy', 'operator', 'userId', 'fixedBy'];

async function importOf(deps: MigrationDeps, tenantId: string, importId: string): Promise<OldSystemImportRecord> {
  if (deps.oldSystemImports === undefined) notWired();
  const found = (await deps.oldSystemImports!(tenantId)).find((r) => r.importId === importId);
  if (found === undefined) throw notFound(`old-system import ${importId}`);
  return found;
}

/** Record one fix — the shared body of the two fix routes (which differ only in who may call them and which kinds). */
async function recordFix(deps: MigrationDeps, ctx: { tenantId: string; userId: string; params: Readonly<Record<string, string | undefined>>; body: unknown }, kinds: readonly FixKind[]): Promise<{ status: number; body: unknown }> {
  await assertSafeTarget(deps, ctx.tenantId);
  const importId = (ctx.params['importId'] ?? '').trim();
  const b = isObj(ctx.body) ? ctx.body : {};
  if (NAMED_IN_BODY.some((k) => b[k] !== undefined)) {
    throw apiError(422, { code: 'fixer_is_read_from_the_session', whatHappened: 'Who fixed a gap is the person signed in — never a name in the request.', wasItSaved: 'not_saved', nextSafeAction: 'Send the fix without a name; sign in as yourself. Nothing was recorded.' });
  }
  const kind = b['kind'];
  if (!isStr(b['itemId']) || !ID.test(b['itemId']) || typeof kind !== 'string' || !isObj(b['value'])) {
    throw apiError(400, { code: 'not_readable_as_a_fix', whatHappened: 'A fix needs { itemId, kind, value, reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. Fix it from the import page, which sends exactly this.' });
  }
  if (!(kinds as readonly string[]).includes(kind)) {
    throw apiError(403, {
      code: kind === 'tax' ? 'tax_fix_is_finance' : 'not_a_finance_fix',
      whatHappened: kind === 'tax' ? 'An item\'s HSN and GST rate are a tax decision: only Finance (the accountant or the owner) fixes them.' : `A ${kind} fix is made by whoever runs the load, not on the Finance route.`,
      wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. Ask the right person to fix it, signed in as themselves.',
    });
  }
  const reason = typeof b['reason'] === 'string' ? b['reason'] : '';
  const problems = validateFix(kind as FixKind, b['value'], reason);
  if (problems.length > 0) {
    throw apiError(422, { code: 'fix_not_kept', whatHappened: `This fix cannot be kept: ${problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. Correct it and save again.' });
  }
  const imp = await importOf(deps, ctx.tenantId, importId);
  if (deps.recordImportFix === undefined) notWired();
  const fix: ImportFix = { importId: imp.importId, itemId: (b['itemId'] as string).trim(), kind: kind as FixKind, value: b['value'], reason: reason.trim(), by: ctx.userId, at: deps.now() };
  await deps.recordImportFix!(ctx.tenantId, fix);
  return { status: 201, body: { fix } };
}

export function oldSystemImportRoutes(deps: MigrationDeps): readonly Route[] {
  return [
    {
      // Record an import: { source, readDigest, files[], items, ratesFrom, backupRestoredOn }. The recorder is the caller.
      api: 'API-12', method: 'POST', path: '/v1/migration/old-system-imports/:importId',
      permission: 'migration.load.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const importId = (ctx.params['importId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        if (NAMED_IN_BODY.some((k) => b[k] !== undefined)) {
          throw apiError(422, { code: 'recorder_is_read_from_the_session', whatHappened: 'Who read the old system\'s files is the person signed in — never a name in the request.', wasItSaved: 'not_saved', nextSafeAction: 'Send it without a name. Nothing was recorded.' });
        }
        const files = b['files'];
        if (!ID.test(importId) || !isStr(b['source']) || !isStr(b['readDigest']) || !Number.isInteger(b['items']) || (b['items'] as number) < 0
          || !isStr(b['ratesFrom']) || !DAY.test(b['ratesFrom']) || !isStr(b['backupRestoredOn']) || !DAY.test(b['backupRestoredOn'])
          || !Array.isArray(files) || files.length === 0 || !files.every((f) => isObj(f) && isStr(f['role']) && isStr(f['name']) && Number.isInteger(f['bytes']) && isStr(f['digest']))) {
          throw apiError(400, { code: 'not_readable_as_an_import', whatHappened: 'An import needs its id in the path and { source, readDigest, files: [{ role, name, bytes, digest }], items, ratesFrom: YYYY-MM-DD, backupRestoredOn: YYYY-MM-DD }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. Read the files on the import page, which sends exactly this.' });
        }
        if ((b['backupRestoredOn'] as string) > shopDateIn(deps.now())) {
          throw apiError(422, { code: 'backup_check_in_the_future', whatHappened: 'The day the old system\'s backup was restored and checked is after today.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. Give the day it was really checked (MG-02).' });
        }
        if (deps.oldSystemImports === undefined || deps.recordOldSystemImport === undefined) notWired();
        const held = (await deps.oldSystemImports!(ctx.tenantId)).find((r) => r.importId === importId);
        if (held !== undefined) {
          if (held.readDigest === b['readDigest']) return { status: 200, body: { import: held, alreadyRecorded: true } };
          throw apiError(409, { code: 'import_read_differently', whatHappened: `Import ${importId} was recorded from a different read of the old system's files. One import, one read.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. Read the files as a new import.' });
        }
        const record: OldSystemImportRecord = {
          importId, source: (b['source'] as string).trim(), readDigest: b['readDigest'] as string,
          files: (files as Record<string, unknown>[]).map((f) => ({ role: String(f['role']), name: String(f['name']), bytes: f['bytes'] as number, digest: String(f['digest']) })),
          items: b['items'] as number, ratesFrom: b['ratesFrom'] as string, backupRestoredOn: b['backupRestoredOn'] as string,
          recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        await deps.recordOldSystemImport!(ctx.tenantId, record);
        return { status: 201, body: { import: record } };
      },
    },
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/old-system-imports',
      permission: 'migration.load.read',
      handler: async (ctx) => {
        if (deps.oldSystemImports === undefined) notWired();
        return { status: 200, body: { imports: [...(await deps.oldSystemImports!(ctx.tenantId))].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)) } };
      },
    },
    {
      // The import and every fix, oldest first (the latest of a kind for an item applies).
      api: 'API-12', method: 'GET', path: '/v1/migration/old-system-imports/:importId',
      permission: 'migration.load.read',
      handler: async (ctx) => {
        const imp = await importOf(deps, ctx.tenantId, (ctx.params['importId'] ?? '').trim());
        const fixes = deps.importFixes === undefined ? [] : await deps.importFixes(ctx.tenantId, imp.importId);
        return { status: 200, body: { import: imp, fixes } };
      },
    },
    {
      // Finance reads the same import and fixes through its own right — it needs no load right to answer a tax question.
      api: 'API-12', method: 'GET', path: '/v1/migration/old-system-imports/:importId/for-finance',
      permission: 'catalogue.tax.approve',
      handler: async (ctx) => {
        const imp = await importOf(deps, ctx.tenantId, (ctx.params['importId'] ?? '').trim());
        const fixes = deps.importFixes === undefined ? [] : await deps.importFixes(ctx.tenantId, imp.importId);
        return { status: 200, body: { import: imp, fixes } };
      },
    },
    {
      // A barcode, a price, the label facts, or "not in this department" — by whoever runs the load.
      api: 'API-12', method: 'POST', path: '/v1/migration/old-system-imports/:importId/fixes',
      permission: 'migration.load.record', idempotent: true,
      handler: (ctx) => recordFix(deps, ctx, ['barcode', 'price', 'label', 'exclude']),
    },
    {
      // An item's HSN and GST rate — by Finance only.
      api: 'API-12', method: 'POST', path: '/v1/migration/old-system-imports/:importId/tax-fixes',
      permission: 'catalogue.tax.approve', idempotent: true,
      handler: (ctx) => recordFix(deps, ctx, ['tax']),
    },
  ];
}
