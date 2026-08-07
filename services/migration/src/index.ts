// API-12 Migration — staging, mapping, exceptions, reconciliation, the verification report.
//
// **This service can never point at production** (hard rule #7). Not "should not" — the target is
// asserted before anything else happens, exactly as `packages/migration/src/trial.ts` does, and
// the check runs first because a load that reached production has already done its damage by the
// time any other validation would have run.
//
// It exposes the six outside-evidence checks and the page that gets signed, and it exposes them
// **read-only for the results and write-only for the evidence**: nothing here can mark a domain
// as verified. A domain becomes verified by its evidence agreeing, and an endpoint that could set
// the verdict directly is a way to sign the report without doing the work.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assertNonProduction, type LoadTarget } from '../../../packages/migration/src/trial';
import {
  buildVerificationReport, renderVerificationReport,
  type DomainFinding, type Acceptance, type Signature,
} from '../../../packages/migration/src/verification-report';

export interface MigrationDeps {
  readonly target: (tenantId: string) => Promise<LoadTarget> | LoadTarget;
  readonly findings: (tenantId: string) => Promise<readonly DomainFinding[]> | readonly DomainFinding[];
  readonly acceptances: (tenantId: string) => Promise<readonly Acceptance[]> | readonly Acceptance[];
  readonly signatures: (tenantId: string) => Promise<readonly Signature[]> | readonly Signature[];
  readonly recordAcceptance: (tenantId: string, a: Acceptance) => Promise<void> | void;
  /**
   * Who the owner is. **`undefined` means we cannot tell, and nobody may accept in their place.**
   *
   * This was a hard-coded `'u-owner'` in the composition root, which meant the check below —
   * "only the owner may accept a figure into the opening books" — was satisfied by anybody who
   * typed that string. A control comparing a caller against a placeholder is not a control.
   */
  readonly ownerId: (tenantId: string) => Promise<string | undefined> | string | undefined;
  /**
   * Who ran the extraction. **`undefined` means we cannot tell, and no report is produced.**
   *
   * It appears by name on the page the owner and the CA sign, and it is load-bearing there: the
   * rule that whoever ran the extraction cannot choose which stock lines get counted only means
   * something if the page says who that was. A placeholder here is a fabricated audit record on a
   * signed document.
   */
  readonly extractionOperator: (tenantId: string) => Promise<string | undefined> | string | undefined;
  readonly now: () => string;
}

/**
 * Refuse the whole surface if the configured target is production.
 *
 * Called at the top of every handler rather than once at startup: a target can be re-pointed by
 * configuration between requests, and the check is worth nothing if it only ran at boot.
 */
async function assertSafeTarget(deps: MigrationDeps, tenantId: string): Promise<void> {
  const assertion = assertNonProduction(await deps.target(tenantId));
  if (!assertion.permitted) {
    throw apiError(403, {
      code: 'target_is_production',
      whatHappened: `The migration target is ${assertion.detail}. Nothing in this service will run against production (hard rule #7).`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Point the migration at the rehearsal environment. Nothing was read or written.',
    });
  }
}

/**
 * The two people the signed page names, or a refusal.
 *
 * Both were placeholders in the composition root — `'u-owner'` and `'u-operator'`. A page that
 * names a person who does not exist is worse than a page that will not render: it is signed.
 */
async function namedPeople(
  deps: MigrationDeps, tenantId: string,
): Promise<{ ownerId: string; extractionOperator: string }> {
  const ownerId = await deps.ownerId(tenantId);
  const extractionOperator = await deps.extractionOperator(tenantId);
  const missing = [
    ownerId === undefined ? 'who the owner is' : undefined,
    extractionOperator === undefined ? 'who ran the extraction' : undefined,
  ].filter((m): m is string => m !== undefined);

  if (missing.length > 0) {
    throw apiError(409, {
      code: 'the_page_would_name_nobody',
      whatHappened: `This report is signed, and it does not yet know ${missing.join(' or ')}.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'No report was produced. Record those people first — a signed page naming a placeholder is a fabricated record, and the rule that whoever ran the extraction cannot choose which lines get counted only means something if the page says who that was.',
    });
  }
  return { ownerId: ownerId!, extractionOperator: extractionOperator! };
}

export function migrationRoutes(deps: MigrationDeps): readonly Route[] {
  return [
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/verification',
      permission: 'migration.verification.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const people = await namedPeople(deps, ctx.tenantId);
        const built = buildVerificationReport({
          reportId: `VR-${ctx.tenantId}`, asAt: deps.now(),
          preparedBy: ctx.userId,
          extractionOperator: people.extractionOperator,
          findings: await deps.findings(ctx.tenantId),
          acceptances: await deps.acceptances(ctx.tenantId),
          ownerId: people.ownerId,
        });
        if (!built.ok) {
          // A refusal here is the report declining to exist, which is the point: a partial one
          // renders perfectly and reads as complete.
          throw apiError(422, {
            code: built.refusedBecause!,
            whatHappened: built.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No report was produced. Close what is named above — a report over some of the domains would look finished and would not be.',
          });
        }
        return { status: 200, body: built.report };
      },
    },
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/verification/page',
      permission: 'migration.verification.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const people = await namedPeople(deps, ctx.tenantId);
        const built = buildVerificationReport({
          reportId: `VR-${ctx.tenantId}`, asAt: deps.now(),
          preparedBy: ctx.userId,
          extractionOperator: people.extractionOperator,
          findings: await deps.findings(ctx.tenantId),
          acceptances: await deps.acceptances(ctx.tenantId),
          ownerId: people.ownerId,
        });
        if (!built.ok) throw apiError(422, {
          code: built.refusedBecause!, whatHappened: built.detail,
          wasItSaved: 'not_saved', nextSafeAction: 'No report was produced.',
        });
        return {
          status: 200,
          body: { markdown: renderVerificationReport(built.report!, await deps.signatures(ctx.tenantId)) },
        };
      },
    },
    {
      api: 'API-12', method: 'POST', path: '/v1/migration/acceptances',
      permission: 'migration.exception.accept', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const a = ctx.body as Acceptance;
        const owner = await deps.ownerId(ctx.tenantId);
        if (owner === undefined) {
          throw apiError(409, {
            code: 'nobody_is_recorded_as_the_owner',
            whatHappened: 'No user holds the owner role for this tenant, so there is nobody this acceptance could be checked against.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was accepted. Record who the owner is first — until then a check that only the owner may accept has nothing to compare a caller with, and would pass for anybody.',
          });
        }
        if (a?.acceptedBy !== owner) {
          throw apiError(403, {
            code: 'accepted_by_somebody_other_than_the_owner',
            whatHappened: 'Carrying a figure into the opening books on the old system\'s word alone is the owner\'s decision and nobody else\'s.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was accepted. The owner records this one themselves, in their own words.',
          });
        }
        await deps.recordAcceptance(ctx.tenantId, a);
        return { status: 201, body: a };
      },
    },
  ];
}
