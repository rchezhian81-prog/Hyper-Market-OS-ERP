// Admin and security (M01 · M02-FR-01…04 · M33 · M34-FR-01/02 · D12 · §27 · §28 · SEC).
//
// The design bar for this surface is three lines: **least privilege by default; no shared logins
// (hard rule #4); every privileged action audited and support access time-bound** (P-04).
//
// ── What was written, tested, and called by nothing ─────────────────────────
//
// `accessReview`, `supportSessionActive`, `evaluateDevice`, `fleetSummary`, `planRetention`,
// `holdApplies`, `liftHold` and `validateVersionPolicy` — eight rules, none of them reached from
// anywhere outside their own unit tests. The eleventh instance of this codebase's recurring shape.
//
// ── And the one that was worse than unwired ─────────────────────────────────
//
// **Support access had two implementations, enforcing different rules, and the weaker one was the
// one wired to the API.** `services/platform` carried its own `grantSupportAccess` whose request had
// **no `scopes` field at all** — so access granted over the wire could not state least privilege,
// could not be refused for holding a scope support may never hold, and had no rule stopping an
// approval lengthening the window that was asked for. A second, simpler copy of a security control
// is the one that drifts, and it drifts in the direction of letting more through.
//
// That is now one implementation, in `packages/platform-admin`, and this screen uses it too.
//
// ── The rule this screen turns on ───────────────────────────────────────────
//
// **A grant that has expired is not access.** `supportSessionActive` decides that from the clock —
// "expiry is a fact about time, not an event someone triggers" — and until now nothing ever asked
// it. A session was granted with an `expiresAt` in a response body and nothing anywhere read it
// again, which is standing god-mode wearing a time limit's clothes.

import {
  grantSupportAccess, supportSessionActive, evaluateDevice, fleetSummary,
  type Device, type DeviceDecision, type FleetSummary, type OwnerApproval,
  type SupportAccessRequest, type SupportSession, type VersionPolicy,
} from '../../../packages/platform-admin/src/index';
import { accessReview, type AccessReviewRow, type UserAccount } from '../../../packages/identity/src/index';
import { planRetention, type AuditRecord, type LegalHold, type RetentionPlan, type RetentionPolicy } from '../../../packages/audit/src/index';
import type { Role, RoleAssignment } from '../../../packages/rbac/src/index';

/** What this surface can see, and what it honestly cannot. */
export interface AdminPorts {
  /** Every account, so joiners, movers and leavers can be reviewed (M02-FR-04). */
  accounts(): readonly UserAccount[];
  roles(): readonly Role[];
  assignments(): readonly RoleAssignment[];
  /** Every support session ever granted. Never pruned — somebody outside the business saw live data. */
  supportSessions(): readonly SupportSession[];
  /** The tills, handhelds and phones this shop runs on. */
  devices(): readonly Device[];
  /** The minimum versions this tenant will allow. Absent means nothing is being enforced. */
  versionPolicy(): VersionPolicy | undefined;
  /** Audit records in scope for a retention review. */
  auditRecords(): readonly AuditRecord[];
  retentionPolicies(): readonly RetentionPolicy[];
  legalHolds(): readonly LegalHold[];
}

export interface AdminConfig {
  readonly tenantId: string;
  /** Who is looking. `null` means the box was not told — nothing privileged may be done. */
  readonly userId: string | null;
  readonly now: string;
  /** Days without a login after which an account is stale enough to review. Per-tenant. */
  readonly dormantAfterDays: number;
}

export type GrantRefusal =
  | 'nobody_is_named_at_this_desk'
  | 'refused_by_policy';

const GRANT_REFUSAL_VALUES: Readonly<Record<GrantRefusal, GrantRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  refused_by_policy: 'refused_by_policy',
});
export const GRANT_REFUSAL_KINDS: readonly GrantRefusal[] = Object.freeze(Object.values(GRANT_REFUSAL_VALUES));

/** A support session as the screen shows it — and whether it is still access at all. */
export interface SupportView {
  readonly session: SupportSession;
  /**
   * Decided from the clock, every time this is read.
   *
   * Never a stored flag: a flag has to be turned off by something, and the something is exactly
   * what did not exist. An expired grant that still reads "active" is standing access.
   */
  readonly active: boolean;
  readonly minutesLeft: number;
  /** What it was allowed to touch. Blanket access cannot be granted, so this is never empty. */
  readonly scopes: readonly string[];
  readonly actionCount: number;
}

export type GrantOutcome =
  | { readonly ok: true; readonly session: SupportSession; readonly view: SupportView }
  | { readonly ok: false; readonly refusal: GrantRefusal; readonly detail: string };

export interface AdminSession {
  /** Who has access to what, and who should not (M02-FR-02/04). */
  access(): readonly AccessReviewRow[];
  /** Every support session, live ones first, each judged against the clock. */
  support(): readonly SupportView[];
  /** Grant one — through the single implementation, with its scope and approval rules. */
  grant(input: { readonly request: SupportAccessRequest; readonly approval?: OwnerApproval }): GrantOutcome;
  /** The fleet: what is running, what is out of date, what is blocked (M33). */
  fleet(): { readonly summary: FleetSummary | undefined; readonly verdicts: readonly DeviceDecision[]; readonly policyKnown: boolean };
  /**
   * What retention would do — and what a legal hold stops it doing.
   *
   * `undefined` when the shop has set no retention policy at all, which is **different from
   * nothing being due for deletion**: the first is a shop that has never decided, and a screen
   * showing "nothing to delete" for it would be reporting a decision nobody made.
   */
  retention(): RetentionPlan | undefined;
}

export function createAdminSession(config: AdminConfig, ports: AdminPorts): AdminSession {
  const viewOf = (session: SupportSession): SupportView => {
    const active = supportSessionActive(session, config.now);
    const msLeft = Date.parse(session.expiresAt) - Date.parse(config.now);
    return {
      session,
      active,
      minutesLeft: active ? Math.max(0, Math.floor(msLeft / 60_000)) : 0,
      scopes: session.scopes,
      actionCount: session.actions.length,
    };
  };

  const session: AdminSession = {
    access: () => accessReview(ports.accounts(), config.now, config.dormantAfterDays),

    support: () => {
      const views = ports.supportSessions().map(viewOf);
      // Live first, then most recent. A live session into a customer's data is the most urgent
      // thing on this screen, and a list ordered by date buries it under history.
      return [...views].sort((a, b) =>
        (a.active === b.active ? 0 : a.active ? -1 : 1)
        || b.session.startedAt.localeCompare(a.session.startedAt));
    },

    grant: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: GRANT_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen. Letting somebody into a customer’s live data carries the name of whoever let them in.',
        };
      }
      try {
        // The one implementation. It refuses an empty scope list, a forbidden scope, a
        // self-approval, and an approval that lengthens the window that was asked for.
        const granted = grantSupportAccess(input.request, input.approval);
        return { ok: true, session: granted, view: viewOf(granted) };
      } catch (e) {
        return {
          ok: false,
          refusal: GRANT_REFUSAL_VALUES.refused_by_policy,
          detail: e instanceof Error ? e.message : 'support access was refused',
        };
      }
    },

    fleet: () => {
      const policy = ports.versionPolicy();
      const devices = ports.devices();
      // No policy means nothing is being enforced, and that is what the screen says — rather than
      // judging every device against a minimum version nobody has set, which would report a fleet
      // as compliant with a rule the shop never made.
      if (policy === undefined) return { summary: undefined, verdicts: [], policyKnown: false };
      return {
        summary: fleetSummary(devices, policy, config.now),
        verdicts: devices.map((device) => evaluateDevice(device, policy)),
        policyKnown: true,
      };
    },

    retention: () => {
      const policies = ports.retentionPolicies();
      if (policies.length === 0) return undefined;
      return planRetention(ports.auditRecords(), policies, ports.legalHolds(), config.now);
    },
  };

  return session;
}
