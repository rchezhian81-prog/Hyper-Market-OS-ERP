// API-09 Payroll — the owner's hard PAY-RELEASE SWITCH (R4 · OB-228, the owner in writing, 19 Oct 2026).
//
// "Approve, lock and the bank file stay refused until I switch release on." This is a switch on the RELEASE path, in
// addition to — never instead of — the fresh MFA re-authentication those steps already demand (SEC-03, §28) and the
// payroll pages being unserved (OB-209):
//
//   • GET  /v1/hr/payroll/release-switch — the switch as it stands, IN WORDS (off is said), and who set it, when and why.
//   • POST /v1/hr/payroll/release-switch — { on: true / false, reason }. The OWNER's act alone (`payroll.release.switch`,
//                                          held by the owner role only), with a written reason; appended as one event
//                                          (hard rule #2 — every earlier setting stays) and audited.
//
// It starts OFF: with no switch event recorded, release is refused. `requirePayReleaseOn` is the one check the release
// routes call (`pay-run-store.ts` approve / lock, `payroll.ts` bank file): refused 409 `pay_release_switched_off`,
// before anything is read or written.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** One setting of the switch, as recorded. */
export interface PayReleaseSwitch {
  readonly on: boolean;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

export interface PayReleaseSwitchDeps {
  /** The latest setting, or undefined when the owner has never set it (OFF). */
  readonly current: (tenantId: string) => Promise<PayReleaseSwitch | undefined> | PayReleaseSwitch | undefined;
  /** Append one setting (never overwrites an earlier one). */
  readonly record: (tenantId: string, s: PayReleaseSwitch) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

/** Whether the owner has switched release ON — what the release routes are handed. */
export type PayReleaseSwitchedOn = (tenantId: string) => Promise<boolean> | boolean;

export const PAY_RELEASE_SWITCH_PERMISSION = 'payroll.release.switch';

const stateWords = (on: boolean): string => on
  ? 'Pay release is switched ON by the owner: approve, lock and the bank file may proceed to their own checks (a fresh MFA sign-in, a different approver).'
  : 'Pay release is switched OFF: approving or locking a pay run and building the salary bank file are refused until the owner switches release on.';

/**
 * The release check (OB-228). Absent (`undefined`) means nobody told this route the switch — that is OFF, never a
 * silent "on". Throws 409 `pay_release_switched_off` naming the step.
 */
export async function requirePayReleaseOn(switchedOn: PayReleaseSwitchedOn | undefined, tenantId: string, step: string): Promise<void> {
  const on = switchedOn === undefined ? false : await switchedOn(tenantId);
  if (on) return;
  throw apiError(409, {
    code: 'pay_release_switched_off',
    whatHappened: `${step} is refused: pay release is switched off (owner decision OB-228). Approving or locking a pay run and building the salary bank file wait for the owner to switch release on, in writing.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Ask the owner. Only he switches pay release on, with a written reason. Nothing was recorded or built.',
  });
}

export function payReleaseSwitchRoutes(deps: PayReleaseSwitchDeps): readonly Route[] {
  const view = (s: PayReleaseSwitch | undefined) => ({
    on: s?.on === true, state: stateWords(s?.on === true),
    ...(s === undefined ? { setBy: null, setAt: null, reason: null } : { setBy: s.by, setAt: s.at, reason: s.reason }),
  });
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/hr/payroll/release-switch',
      permission: 'payroll.statutory.read',
      handler: async (ctx) => ({ status: 200, body: view(await deps.current(ctx.tenantId)) }),
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/release-switch',
      permission: PAY_RELEASE_SWITCH_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
        if (typeof b['on'] !== 'boolean' || reason === '') {
          throw apiError(400, { code: 'not_readable_as_a_pay_release_switch', whatHappened: 'The pay-release switch is { on: true / false, reason } — the owner writes why.', wasItSaved: 'not_saved', nextSafeAction: 'Send it with a written reason. The switch did not change.' });
        }
        const before = await deps.current(ctx.tenantId);
        const s: PayReleaseSwitch = { on: b['on'], reason: reason.slice(0, 500), by: ctx.userId, at: deps.now() };
        await deps.record(ctx.tenantId, s);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'payroll.release.switch', objectType: 'pay_release_switch', objectId: 'pay-release', at: s.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { on: String(before?.on === true) }, after: { on: String(s.on) },
          reason: s.reason, correlationId: 'pay-release-switch',
        });
        return { status: 201, body: view(s) };
      },
    },
  ];
}
