# How to check the tests (for the owner)

You never read code. You do look at whether the tests pass. This page tells you
the one command to run, what a good result looks like, and what to do if it is red.

## The one command

Open a terminal in the project folder and type:

```
pnpm test
```

The first time only, run `pnpm install` once beforehand so the tools are present.

## What a good result looks like

You are looking for the word **passed**, in green, and no failures:

```
 Test Files  7 passed (7)
      Tests  13 passed (13)
```

If every line has a tick (`✓`) and the summary says everything passed, the safety
net is happy. That is your GO signal for this check.

## What a bad result looks like

A failing test has a cross (`×`) and a red **FAIL** block that names the test and
the file, for example:

```
 ❯ tests/guardrails/card-data.test.ts (2 tests | 1 failed)
   × the codebase stores no card number, CVV or expiry

 Test Files  1 failed | 6 passed (7)
      Tests  1 failed | 12 passed (13)
```

The message under the cross is written to be readable. In the example above it is
telling you something tried to store a card number, which is forbidden.

## What to do if it is red

1. **Do not accept the work.** A red test is the system doing its job.
2. Copy the red block and paste it to Claude Code with prompt **R4 — Something
   is broken**. Ask it to explain the cause in plain English before fixing anything.
3. Do not let anyone "make the test pass" by deleting the test or weakening the
   rule. If a rule genuinely needs to change, that is a decision for you, recorded
   in an ADR — not a quiet edit.
4. Run `pnpm test` again after the fix and confirm it is green.

## What a test actually proves — and what it does not

- A passing test proves that **the specific situations the test checks** behave
  as expected, every time, automatically. It is your protection against a change
  quietly breaking something that used to work.
- A passing test does **not** prove the product is correct, complete, or usable.
  It only covers the cases someone thought to write. It cannot tell you the
  screen is confusing, the number matches a real invoice, or the till still works
  when you pull the plug.

That is why the rule in `CLAUDE.md` is *"never accept work you have not seen
behave in the store."* Tests passing is necessary. It is not sufficient. You
still scan a real barcode, unplug the router, and check a number against a real
invoice. The tests keep pace with the machine; your own eyes keep pace with the
tests.

## The other safety-net commands

You will rarely need these, but they exist and CI runs all of them on every
change:

| Command | What it checks |
| --- | --- |
| `pnpm test` | The tests behave correctly. |
| `pnpm run typecheck` | The code is internally consistent (no obvious type mistakes). |
| `pnpm run lint` | The code follows agreed style and avoids known foot-guns. |
| `pnpm run secret-scan` | No password, key or secret is present anywhere in the project. |
| `pnpm run check` | All of the above, in one go. |
