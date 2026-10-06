// Test support for the VERIFIED till operator (ADR-0020 · Wave 2b · audit PF-02).
//
// A test that rings a sale through a real store computer now signs in first, as a cashier in the shop does: the pack
// names the person with till authority, a till PIN has been issued on that box, the box knows which lane it is, and the
// sign-in goes through the box's own socket. Every PIN here is made at RUNTIME from a seed — none is written in the repo.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { issueTillCredential, tillPinKey } from '../../packages/identity/src/till-pin';

/** The lane every prepared box is told it is, unless a test names another. */
export const TEST_LANE = 'lane-1';

/** A six-digit PIN made from a seed at run time (the secret scanner sees no literal, and two seeds give two PINs). */
export const testPin = (seed: number): string => String(100_000 + ((seed * 7_919 + 4_241) % 900_000));

export interface TillPerson {
  readonly userId: string;
  readonly displayName?: string;
  /** false = named in the pack but WITHOUT till authority. Default true. */
  readonly till?: boolean;
  /** false = no till PIN issued on this box. Default true. */
  readonly pin?: boolean;
}

/** The pack sections that name people and give them till authority (`pos.sale.sync`). */
export function tillPeoplePack(people: readonly TillPerson[]): { people: unknown[]; roles: unknown[]; roleAssignments: unknown[] } {
  const roleOf = (p: TillPerson) => (p.till === false ? 'role-floor' : 'role-cashier');
  return {
    people: people.map((p) => ({ userId: p.userId, displayName: p.displayName ?? p.userId, roleId: roleOf(p) })),
    roles: [
      { id: 'role-cashier', name: 'Cashier', permissions: ['pos.sale.sync', 'pos.return.process'] },
      { id: 'role-floor', name: 'Floor staff', permissions: ['pos.exception.read'] },
    ],
    roleAssignments: people.map((p) => ({ userId: p.userId, roleId: roleOf(p), branchScope: 'all' })),
  };
}

/** Merge the till people into a pack object — a pack that already names people keeps them, and gains these. */
export function withTillPeople(pack: Record<string, unknown>, people: readonly TillPerson[]): Record<string, unknown> {
  const add = tillPeoplePack(people);
  const list = (k: string): unknown[] => (Array.isArray(pack[k]) ? (pack[k] as unknown[]) : []);
  return { version: 1, ...pack, people: [...list('people'), ...add.people], roles: [...list('roles'), ...add.roles], roleAssignments: [...list('roleAssignments'), ...add.roleAssignments] };
}

/** The PIN each person was issued, by user id (deterministic per id, made at run time). */
export const pinOf = (userId: string): string => testPin([...userId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_003, 7));

/** Write the box's till-credentials file — what the administrator's `till-pin` command writes on a real box. */
export async function issueTillPins(dataDir: string, packSigningKey: string, userIds: readonly string[]): Promise<string> {
  const key = tillPinKey(packSigningKey);
  const file = join(dataDir, 'till-credentials.json');
  let existing: unknown[] = [];
  try { existing = (JSON.parse(await readFile(file, 'utf8')) as { credentials?: unknown[] }).credentials ?? []; } catch { /* first issue */ }
  const credentials = userIds.map((userId) => issueTillCredential({ userId, pin: pinOf(userId), key, issuedAt: '2026-10-06T08:00:00.000Z', issuedBy: 'test-admin' }));
  await writeFile(file, `${JSON.stringify({ version: 1, credentials: [...existing, ...credentials] }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/**
 * Get a box's data directory ready for a till: the pack (merged with the till people) written as the box's pack file, the
 * PINs issued, and the env a test adds to `startEdge` so the box knows its lane and reads the pack.
 */
export async function prepareTillBox(input: {
  readonly dir: string;
  readonly key: string;
  readonly people?: readonly TillPerson[];
  readonly pack?: Record<string, unknown>;
  /** The lane the box is told it is; `null` = not told (a box with no lane takes no money). Default `lane-1`. */
  readonly laneId?: string | null;
  readonly packFileName?: string;
}): Promise<Record<string, string>> {
  const people = input.people ?? [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }];
  const packFile = join(input.dir, input.packFileName ?? 'store-pack.json');
  await writeFile(packFile, JSON.stringify(withTillPeople(input.pack ?? {}, people)), 'utf8');
  await issueTillPins(input.dir, input.key, people.filter((p) => p.pin !== false).map((p) => p.userId));
  return { ...(input.laneId === null ? {} : { EDGE_LANE_ID: input.laneId ?? TEST_LANE }), EDGE_PACK_FILE: packFile };
}

/** Sign in through a real box's lane socket with the person's issued PIN; resolves the session token or throws. */
export async function signInAtLane(port: number, staffId: string, pin: string = pinOf(staffId)): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/lane/operator/sign-in`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staffId, pin }),
  });
  const body = await res.json() as { signedIn?: boolean; token?: string; laneMessage?: string };
  if (body.signedIn !== true || typeof body.token !== 'string') throw new Error(`sign-in refused: ${body.laneMessage ?? res.status}`);
  return body.token;
}

/** The header a money write carries. */
export const operatorHeader = (token: string): Record<string, string> => ({ 'x-sre-operator': token });

/**
 * Sign a person in on a real box and hand the session to this page's lane writes — what the till page's own sign-in
 * does (`signInAtTill`), for a test that drives the lane ports directly. Resolves the token.
 */
export async function holdSignedInAt(port: number, staffId: string): Promise<string> {
  const { holdTillOperatorSession } = await import('../../apps/pos/src/browser-entry');
  const token = await signInAtLane(port, staffId);
  holdTillOperatorSession(token);
  return token;
}

/**
 * Sign a cashier in on a served till page the way the page itself does (`posSession.signInAtTill`): staff ID and till
 * PIN, checked by the box the page is served from. Throws with the box's words if it refuses.
 */
export async function signInOnPage(page: import('playwright-core').Page, staffId = 'u-lanecash'): Promise<void> {
  const outcome = await page.evaluate(
    (who) => (globalThis as unknown as { posSession: { signInAtTill(i: { staffId: string; pin: string }): Promise<{ signedIn: boolean; laneMessage?: string }> } })
      .posSession.signInAtTill({ staffId: who.staffId, pin: who.pin }),
    { staffId, pin: pinOf(staffId) },
  );
  if (!outcome.signedIn) throw new Error(`sign-in refused: ${outcome.laneMessage ?? ''}`);
}

/**
 * Sign a cashier in through the served till's OWN control, as a person does: the Sign in button, the staff ID (a badge
 * scanner's keystrokes + Enter), then the six-digit till PIN + Enter on the masked keypad. Waits until the till says who.
 */
export async function signInThroughScreen(page: import('playwright-core').Page, staffId = 'u-lanecash'): Promise<void> {
  await page.click('#signin');
  await page.waitForSelector('#sheet:not([hidden]) #entry:not([aria-label])'); // the staff-ID prompt is open
  await page.keyboard.type(staffId);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#sheet:not([hidden]) #entry[aria-label]', { timeout: 5_000 }); // the PIN panel (masked), not the staff-ID one
  await page.keyboard.type(pinOf(staffId));
  await page.keyboard.press('Enter');
  try {
    await page.waitForFunction(
      (who) => (globalThis as unknown as { posSession?: { operator(): string | undefined } }).posSession?.operator() === who,
      staffId, { timeout: 5_000 },
    );
  } catch (e) {
    // Say what the till said, not just that it timed out.
    const said = `${await page.textContent('#refusal-title') ?? ''} — ${await page.textContent('#refusal-text') ?? ''}`;
    throw new Error(`the till did not sign ${staffId} in: ${said} (${e instanceof Error ? e.message : String(e)})`);
  }
}
