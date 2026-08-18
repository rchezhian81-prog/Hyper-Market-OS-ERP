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
- **Require status checks to pass before merging**, and select the CI check
  **"Type check, lint, tests, secret & dependency scan"** (from `.github/workflows/ci.yml`).
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
