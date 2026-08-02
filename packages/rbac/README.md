# `packages/rbac/`

Role-based access control — **least privilege (P-04)** and **M02-FR-02** (role, branch and
permission authorization). **Default DENY**: a named user may do only what an assigned role
**explicitly** grants, within the branch scope of that assignment. Every check is for a
named user — there are no shared logins (hard rule #4).

- **`src/rbac.ts`** — `AccessControl` (built from roles + user→role assignments) with
  `can(query)` (default-deny boolean) and `assertCan(query)` (throws `AccessDeniedError`);
  `isPermission` validates permission codes. No wildcards — every permission is explicit by
  design. Tested in `tests/unit/rbac.test.ts`.

> Complements `packages/approvals` (which enforces §28 separation of duties and value
> limits): RBAC decides *may this user act at all*, the approval engine decides *may this
> action commit without a second person*. The `shared-login` guardrail covers hard rule #4
> at the code level. Part of the repository layout in `CLAUDE.md`.
