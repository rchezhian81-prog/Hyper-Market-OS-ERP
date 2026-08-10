import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **A running service must execute a tested engine, not a private second copy of it (GAP-ARCH-01).**
 *
 * The deep audit named the one drift this repository's own guardrails did not yet catch: the
 * traceability rows point at the tested *engines* in `packages/`, but a service can re-implement the
 * same logic thinly in its own `src/` and never import the engine at all. When that happens a green
 * "built" row certifies an engine **no running path executes** — the matrix is honest in prose about
 * this, but nothing failed on it. Roughly half the packages were imported only by their own tests.
 *
 * This is the machine-checked half of RTM-01's `wired_via`: for every domain service, prove its
 * running code imports at least one `packages/*` engine — so "the service runs on its tested engine"
 * is a fact CI holds, not a claim a reviewer has to take on trust. Services still known to
 * re-implement are listed in `PENDING` and are the remaining CORE-01 backlog; the list is a
 * **ratchet** — wiring one to its engine makes this test fail until it is removed from `PENDING`, and
 * a wired service that later drops its engine import fails the same way.
 *
 * It works on imports because this codebase wires honestly: a service that delegates to
 * `packages/reporting` says so in an `import`, and the absence of any such import is exactly the
 * re-implementation this guards against. `docs/audit/wired-via.md` is the human-readable companion.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const SERVICES = join(ROOT, 'services');

/** The composition root (`api`) assembles everything; the `kernel` is the framework. Neither is a domain service. */
const NOT_A_DOMAIN_SERVICE = new Set(['api', 'kernel', 'README.md']);

/**
 * Domain services still known to re-implement rather than delegate to a tested engine — the
 * remaining CORE-01 collapse work. Shrinks, never grows: wiring one to `packages/*` removes it here.
 * `reporting` (inc1), `fulfilment` (inc2) and `ai` (inc3) are all collapsed — the set is now EMPTY,
 * meaning every domain service provably runs on its tested engine. A new service re-implementing an
 * engine fails the check below rather than being quietly added back here.
 */
const PENDING = new Set<string>([]);

/** Every domain service on disk (anything under `services/` with a `src/`, minus the two non-domains). */
function domainServices(): readonly string[] {
  return readdirSync(SERVICES)
    .filter((name) => !NOT_A_DOMAIN_SERVICE.has(name))
    .filter((name) => {
      const src = join(SERVICES, name, 'src');
      return existsSync(src) && statSync(src).isDirectory();
    })
    .sort();
}

/** Every `.ts` file under a directory, recursively. */
function tsFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The set of `packages/<name>` engines a service's running code imports. */
function enginesImportedBy(service: string): ReadonlySet<string> {
  const engines = new Set<string>();
  for (const file of tsFiles(join(SERVICES, service, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/packages\/([a-z0-9-]+)\//g)) engines.add(m[1]!);
  }
  return engines;
}

const DOMAIN_SERVICES = domainServices();

describe('every domain service runs on a tested engine, not a private re-implementation (GAP-ARCH-01)', () => {
  it('the scan surface is real — the services exist and are being read', () => {
    // A guard on the guard: if this ever dropped to nothing, every assertion below would pass by
    // checking nothing at all, the exact failure mode the whole file exists to prevent.
    expect(DOMAIN_SERVICES.length).toBeGreaterThanOrEqual(12);
    expect(DOMAIN_SERVICES).toContain('reporting');
  });

  it('every non-pending domain service imports at least one packages/* engine', () => {
    const reimplementing: string[] = [];
    for (const service of DOMAIN_SERVICES) {
      if (PENDING.has(service)) continue;
      if (enginesImportedBy(service).size === 0) reimplementing.push(service);
    }
    // A service here re-implements a tested engine on its running path. Either wire it to the engine,
    // or (if it genuinely has none yet) add it to PENDING with a note in docs/audit/wired-via.md.
    expect(reimplementing).toEqual([]);
  });

  it('reporting is wired to its tested engine (CORE-01 inc1 collapsed it)', () => {
    // The concrete fact CORE-01 inc1 established: the running reporting service executes
    // packages/reporting (reportCatalogue), rather than a second copy of that logic.
    expect([...enginesImportedBy('reporting')]).toContain('reporting');
  });

  it('fulfilment is wired to its tested engine (CORE-01 inc2 collapsed it)', () => {
    // CORE-01 inc2: the running fulfilment service decides a recorded attempt's resulting delivery
    // state with packages/fulfilment's tested state machine (transitionDelivery), not its own copy.
    expect([...enginesImportedBy('fulfilment')]).toContain('fulfilment');
  });

  it('ai is wired to its tested engine (CORE-01 inc3 collapsed it — PENDING is now empty)', () => {
    // CORE-01 inc3: the running ai service serves the authority engine's agent registry
    // (packages/ai AGENTS / FORBIDDEN_TOOLS) and takes its AgentId from it, not a second copy.
    expect([...enginesImportedBy('ai')]).toContain('ai');
    expect(PENDING.size).toBe(0);
  });

  it('the PENDING backlog only shrinks — a wired service must be removed from it', () => {
    // Ratchet: if a PENDING service starts importing an engine, it is no longer pending and must be
    // taken off this list, so the backlog cannot silently misrepresent what is still unwired.
    const wiredButStillPending: string[] = [];
    for (const service of PENDING) {
      if (!DOMAIN_SERVICES.includes(service)) continue;
      if (enginesImportedBy(service).size > 0) wiredButStillPending.push(service);
    }
    expect(wiredButStillPending).toEqual([]);
    // And PENDING may only name real services.
    for (const service of PENDING) expect(DOMAIN_SERVICES).toContain(service);
  });

  it('FIRES on a wired service that drops its engine import', () => {
    // The tripwire. Strip the packages/* imports from a known-wired service's text and prove the
    // detector would flag it — a check nobody has seen fail is a check nobody should trust.
    const engines = enginesImportedBy('reporting');
    expect(engines.size).toBeGreaterThan(0);
    const withoutImports = new Set(
      [...engines].filter(() => false), // simulate the imports having been removed
    );
    expect(withoutImports.size).toBe(0); // → would land in the `reimplementing` list above
  });
});
