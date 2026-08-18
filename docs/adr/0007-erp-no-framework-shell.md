# ADR 0007 — Web ERP as a no-framework static/PWA shell (§19 substitution)

- **Status:** Accepted for the pilot. The **production SSR framework choice is deferred** and coupled to
  hosting (owner decision OB-02 / OA-5).
- **Date:** 18 August 2026
- **Context:** Roadmap §19 mandates the Web ERP/Admin as "TypeScript + a modern SSR web framework."
  What is built is **not** an SSR framework: each ERP screen is a tested, DOM-free TypeScript "session"
  model (`apps/web-erp/src/*-session.ts`) plus a hand-rolled static HTML/JS shell
  (`apps/web-erp/web/*.{html,js}`) with a service worker (`apps/web-erp/web/sw.js`), bundled by esbuild
  and served as static files behind nginx (`infra/compose/docker-compose.yml`). The whole monorepo
  carries exactly one production dependency (`pg`); there is no React/Next/SvelteKit/etc. in
  `pnpm-lock.yaml`. The framework question is recorded as unresolved in `docs/STATUS.md` and is tied to
  the hosting decision (a server-rendered framework couples to a Node hosting runtime, which OB-02/OA-5
  has not yet fixed).

## Decision

Ship the Web ERP for the pilot as a **no-framework static + PWA shell** on tested, framework-agnostic
session models. Keep all screen behaviour in the DOM-free session model (which the guardrails test); the
shell only renders. **Do not** adopt an SSR framework now. The production SSR-framework choice is
**deferred** to the hosting decision (OB-02/OA-5) — the session-model boundary is deliberately kept
framework-agnostic so a future SSR/hydration layer can be adopted without rewriting screen logic.

## §19-substitution impact

- **Offline:** Strongly positive. A static shell + service worker is offline-first by construction — the
  same discipline the store screens already hold (P-01, roadmap §31). An SSR framework's server round-trip
  is the opposite of what an offline-first store needs.
- **Support:** Lower burden — static assets behind nginx, no Node SSR runtime to keep alive, no
  framework CVE treadmill. The cost is bespoke shell code instead of framework conventions.
- **Security:** Smaller surface — no server-side render path, no framework dependency tree (one prod
  dependency total), no hydration-mismatch class of bugs. CSP-friendly static assets.
- **Cost:** Lower infra (static hosting) and zero framework-license/runtime cost; higher per-screen
  engineering cost (hand-rolled shells) which the shared `packages/ui` primitives partly amortise.
- **Portability (P-06):** High — no framework lock-in; the session models are plain TypeScript. The risk
  is the inverse: bespoke shells are less portable to a future team expecting a standard framework.
- **Maintainability:** Mixed. The tested session-model/shell split keeps logic reviewable and guarded,
  but a growing number of hand-rolled shells is more code to maintain than framework conventions would be.
  This is the main reason the production framework decision is deferred, not closed.

## Consequences

- The ERP is offline-capable and dependency-light today, at the cost of bespoke shell code.
- Screen **logic** is framework-agnostic (in the session models), so adopting an SSR framework later is a
  shell-layer migration, not a logic rewrite.
- The completion model does not credit the ERP with a "production framework"; that remains an open
  architecture item, honestly tracked.

## Reconsider-when

The hosting decision (OB-02/OA-5) is made and a Node SSR runtime is available, **or** the number of
hand-rolled shells makes framework conventions cheaper than bespoke maintenance — whichever comes first.
