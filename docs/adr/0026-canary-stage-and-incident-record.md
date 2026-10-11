# ADR 0026 — A canary stage before the full rollout, a backup before every release, and an incident record

- **Status:** Accepted (WF-20 build, round 8, 11 October 2026; extends ADR-0017 — it does not replace it)
- **Date:** 11 October 2026
- **Context:** Roadmap §26 WF-20 "Release/incident": *approve release → backup → deploy/canary → smoke/reconcile →
  monitor → rollback/incident/postmortem* (M33, M35, AID controls; §37 places it in R1). AID-08 "sign releases, stage
  rollout and prove rollback". M35-FR-04 "alert ownership, escalation, incident/postmortem". ADR-0017 built the
  approve (a merge to protected `main`), deploy, smoke (READY + stand-up check) and rollback steps. Three were missing
  (matrix WF-20, round 7): no backup was taken by the release itself, every release went straight to the one box with
  no stage watched first, and there was nowhere to record an incident and its post-mortem.

## Decision

1. **A backup before the release changes anything.** `infra/deploy/release.sh` runs the box's
   `SRE_PREDEPLOY_BACKUP_CMD` after the "is this a merged commit" check and before the checkout. If it fails, the
   release is refused (exit 69), nothing is touched, and the release log says `backup_failed`. A box with no command
   configured says so on every run (the scheduled backup is then the latest copy).
2. **A canary stage before the full rollout.** The pipeline gains a `canary` job — same gate as the full rollout (a
   push to `main` after every verification job passed), its own GitHub environment (`canary`) and queue, the same
   pinned-host-key, forced-command key, the same on-box script. The canary box's own `/opt/sre/deploy.conf` sets a
   **bake** (`SRE_BAKE_SECONDS`, e.g. 600): after READY and the stand-up check pass, the script keeps watching — the
   API must stay READY and its server errors (5xx on `/metricz`) must not grow past `SRE_BAKE_MAX_5XX`; an error count
   it cannot read is a failure, never a pass. A failed bake rolls the canary back (exit 70, `rolled_back_in_canary_bake`)
   and the job goes red; the `release` job (full rollout) runs only when `needs.canary.result == 'success'`.
3. **No canary box configured → the stage says so and the demo rollout proceeds** (synthetic data only). A box that
   holds real data requires a configured canary first — the same "required reviewers before the first secret" rule
   ADR-0017 set for real data.
4. **An incident record** (`services/platform/src/ops-incidents.ts`, `/v1/platform/incidents…`): opened by a named
   person (the caller), linked only to alerts head office really raised and optionally to the release commit; a
   timeline by author with the linked alerts' own facts read in; actions owned by a person who works here, with a date;
   a versioned post-mortem; **closed only by the caller, by name, and only once a post-mortem exists**. Append-only;
   a different fact under a used id is a 409 conflict, never an overwrite; nothing changes after close.

What this ADR does **not** decide: a second physical box (which box is the canary is the owner's choice — see
Consequences), automatic incident opening from a failed release (the script tells the person to open one; a
machine does not write the record), traffic splitting inside one box, or a registry.

## Consequences

- The release log now distinguishes `deployed`, `rolled_back`, `rolled_back_in_canary_bake`, `backup_failed` and
  `rollback_failed`; every attempt is still one line.
- A canary needs a box. The cheapest canary is the hosted demo itself with a bake, ahead of the store boxes; with one
  box today the stage is configured-off and says so on every run. The owner chooses which box is the canary before a
  store box is put on automatic deployment.
- A bake adds `SRE_BAKE_SECONDS` to every release on the canary.
- Proven by `tests/integration/the-release-script-deploys-and-rolls-back.test.ts` (the real script: backup refusal,
  a watched release that passes, one that adds server errors, an unreadable error count),
  `tests/guardrails/merged-releases-deploy-themselves.test.ts` (the canary job's gate, environment, queue, key handling
  and the full rollout's dependency on it) and `tests/integration/an-incident-is-recorded-and-closed-by-a-named-person.test.ts`
  (in memory and on PostgreSQL).

## Reconsider-when

- More than one store box: roll out store by store after the canary (a matrix of environments), each with its own bake.
- A managed container service or registry (ADR-0017 reconsider): the canary becomes a weighted rollout there.
