# Branch protection (must be enabled once, in GitHub settings)

Hard rule #8 in `CLAUDE.md`: **never push to main. Branch, test, open a pull
request.** The repository is set up so that all checks run automatically, but the
final lock — *main cannot be changed except through a passing pull request* — is a
GitHub **repository setting**. It cannot be created by a file in the repository,
so it must be switched on by hand, once, by an administrator.

## What to switch on

In GitHub: **Settings → Branches → Add branch ruleset** (or "Add rule") for the
branch `main`, and enable:

- **Require a pull request before merging.** No direct pushes to `main`.
- **Require status checks to pass before merging**, and select ALL SIX CI checks (from `.github/workflows/ci.yml`):
  **"Type check, lint, tests, secret & dependency scan"**, **"Stage gate suites (real PostgreSQL)"**,
  **"The container builds, starts, and refuses a bad configuration"**, **"Browser suites (real Chromium) — required, never skip"**,
  **"Performance suites — required, never skip"** and **"Identity server suites (real Keycloak)"**. The browser and
  performance checks exist since GT-01 (4 Oct 2026): before that the automatic build ran no browser or performance suite
  at all, and the deploy job did not wait for them. The identity check exists since 10 Oct 2026 (before it, the real
  Keycloak suites ran only by hand).
- **Require branches to be up to date before merging.**
- **Require conversation resolution before merging.**
- **Require review from Code Owners.** The owner is named in `.github/CODEOWNERS`
  (owner decision OA-14), so this makes the owner's approval a blocking requirement
  on every pull request — the accountable sign-off.
- **Do not allow bypassing the above settings** (so the rule applies to everyone,
  including administrators — this matches CLAUDE.md: the rule is for everyone,
  every time).
- Optionally **Require linear history** and **Require signed commits**.

## How to confirm it worked

Try to push a trivial change directly to `main`. GitHub must **reject** it with a
message that a pull request is required. If the push succeeds, protection is not
on yet.

## Why this matters

Everything else in the safety net is only advisory until this switch is on. With
it on, the tests, the secret scan and the type check are not suggestions — they
are the gate. Nothing reaches the trusted version of the product without passing
them.

## What GitHub says today (checked 10 October 2026)

Read through the session's GitHub connection, once each:

| Question | Answer |
|---|---|
| `GET /repos/rchezhian81-prog/hyper-market-os-erp/branches/main` | `"protected": false`; `required_status_checks.enforcement_level: "off"`, `contexts: []`, `checks: []` |
| `GET …/branches/main/protection` | **403 "Resource not accessible by integration"** — the connection used by the build sessions is not an administrator, so it can neither read nor set protection (this is correct: the lock must not be in the hands of the thing it locks) |
| `GET …/rulesets` | `[]` — no ruleset exists |

**So `main` is not protected today.** Hard rule #8 is held only by discipline (every change so far arrived through a pull
request), not by GitHub. Nothing in the repository can change this; an administrator of the GitHub repository must.

## The exact checks to require

From `.github/workflows/ci.yml` (job `name:` values — these are the strings GitHub lists as status checks):

1. `Type check, lint, tests, secret & dependency scan`
2. `Stage gate suites (real PostgreSQL)`
3. `The container builds, starts, and refuses a bad configuration`
4. `Browser suites (real Chromium) — required, never skip`
5. `Performance suites — required, never skip`
6. `Identity server suites (real Keycloak)` — added 10 October 2026 (see `docs/runbooks/identity-server.md`).

Do **not** require `Deploy the merged release to the demo box (rolls back if it does not come up)`: it runs only after a
merge to `main` (`if: github.event_name == 'push'`), so on a pull request it never reports and would block every merge.

A check only appears in GitHub's list after it has run once; if number 6 is missing from the list, open any pull request
from this branch onwards and it will appear.

## The administrator's action (about five minutes)

1. Sign in to GitHub as the repository's owner (`rchezhian81-prog`).
2. Repository → **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.
3. Name: `main is changed only by a green pull request`. Enforcement status: **Active**. Bypass list: **empty**.
4. Target branches: **Add target → Include default branch**.
5. Tick: **Restrict deletions**, **Block force pushes**, **Require a pull request before merging** (with **Require review
   from Code Owners** and **Require conversation resolution before merging**), **Require status checks to pass** (tick
   **Require branches to be up to date before merging**, then add the six checks above by name).
6. **Create**. Then check it as described in "How to confirm it worked" above, and tell the build session the date it
   was done so `docs/STATUS.md` can record it.
