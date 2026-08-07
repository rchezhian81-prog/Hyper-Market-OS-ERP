# Screen spec — Admin / Security (Stage 3)

- **Surface:** Admin/Security (§27) · **Modules:** M01, M02, M32, M33, M34, M35, D12 · **Design bar:** least privilege by default; no shared logins (hard rule #4); every privileged action is audited and support access is time-bound (P-04).

> Built on `../design-system.md`.

## Screens & states (§27 Admin/Security row)
Users & roles (RBAC) · Company/branch/warehouse · Feature flags & config history ·
Approval / number / template config · Devices, terminals & versions · Support access ·
Integrations, jobs & DLQ · Audit search & legal hold · Backup/DR & observability ·
Status centre. All handle the §27.1 states.

## Identity & access (M01 · SEC)
- **No shared logins** (hard rule #4); each user is individual. **Least-privilege** roles
  (RBAC); a privilege change is itself **approved and audited** — and never made by an AI
  agent (hard rule #5).
- Approval routing, number series and templates are configured here (M02 / D12).

## Support access (M33 / D12)
- Time-bound, **audited** remote-session / support access — granted for a window,
  auto-expiring, fully logged. Never standing god-mode.

## Platform operations (M32 / M33)
- Device/terminal/version control; feature flags with **config history**; integration
  jobs with retry and **dead-letter (DLQ)** visibility — DLQ items are never deleted
  (hard rule #6).

## Audit, backup & observability (M34 / M35)
- Immutable **who / what / when / where / before / after** audit search with legal hold
  and retention; **audit evidence is never deleted** (hard rule #6).
- Backup/restore-test status, RPO/RTO, sync-lag and health dashboards with alert ownership.

## Offline / state (§31)
- Admin/security is online; the store edge keeps trading if the admin plane is
  unreachable (P-01), and sync-lag/health are always visible (P-08).

## Acceptance (QG-02 / QG-06)
- A role or privilege change requires approval and is audited.
- A support session is time-bound and fully logged.
- No screen offers to delete audit or DLQ items.
- Backup restore-test status and sync health are visible at a glance.
