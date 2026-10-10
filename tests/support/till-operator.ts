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
  /** true = a manager who may also approve refunds at the till (`pos.return.approve`, ADR-0021). */
  readonly manager?: boolean;
  /** Exactly these permissions in the pack (its own role), instead of the cashier / manager / floor roles. */
  readonly permissions?: readonly string[];
}

/** The pack sections that name people and give them till authority (`pos.sale.sync`). */
export function tillPeoplePack(people: readonly TillPerson[]): { people: unknown[]; roles: unknown[]; roleAssignments: unknown[] } {
  const roleOf = (p: TillPerson) => (p.permissions !== undefined ? `role-of-${p.userId}` : p.manager === true ? 'role-manager' : p.till === false ? 'role-floor' : 'role-cashier');
  return {
    people: people.map((p) => ({ userId: p.userId, displayName: p.displayName ?? p.userId, roleId: roleOf(p) })),
    roles: [
      { id: 'role-cashier', name: 'Cashier', permissions: ['pos.sale.sync', 'pos.return.process'] },
      { id: 'role-manager', name: 'Store manager', permissions: ['pos.sale.sync', 'pos.return.process', 'pos.return.approve'] },
      { id: 'role-floor', name: 'Floor staff', permissions: ['pos.exception.read'] },
      ...people.filter((p) => p.permissions !== undefined).map((p) => ({ id: `role-of-${p.userId}`, name: `Role of ${p.userId}`, permissions: [...p.permissions!] })),
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
 * The next receipt number from a real box's register (audit PF-04), asked with a signed-in session — what the till's own
 * `nextReceipt` does — for a test that posts records to the lane socket directly. A bill must carry a number the box gave.
 */
export async function receiptNumberAt(port: number, token: string, requestKey: string = `rq-test-${Math.random().toString(36).slice(2)}`): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/lane/receipt-numbers`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body: JSON.stringify({ requestKey }),
  });
  const body = await res.json() as { issued?: boolean; receiptNumber?: string; laneMessage?: string };
  if (body.issued !== true || typeof body.receiptNumber !== 'string') throw new Error(`no receipt number: ${body.laneMessage ?? res.status}`);
  return body.receiptNumber;
}

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

/** Give a box whose pack FILE is already written its till people (merged into that pack) and their PINs. */
export async function addTillPeople(packFile: string, dataDir: string, packSigningKey: string, people: readonly TillPerson[]): Promise<void> {
  const pack = JSON.parse(await readFile(packFile, 'utf8')) as Record<string, unknown>;
  await writeFile(packFile, JSON.stringify(withTillPeople(pack, people)), 'utf8');
  await issueTillPins(dataDir, packSigningKey, people.filter((p) => p.pin !== false).map((p) => p.userId));
}

/** Sign a person in on a `bootPos` till through its box — the page's own `signInAtTill` — or throw with the box's words. */
export async function signInTill(
  till: { signInAtTill(input: { staffId?: string; pin?: string }): Promise<{ signedIn: boolean; laneMessage?: string }> },
  staffId: string,
): Promise<void> {
  const outcome = await till.signInAtTill({ staffId, pin: pinOf(staffId) });
  if (!outcome.signedIn) throw new Error(`sign-in refused for ${staffId}: ${outcome.laneMessage ?? ''}`);
}

/**
 * A manager approves a refund on a `bootPos` till with their own PIN (ADR-0021) — the page's own `approveAtTill`.
 * Resolves the approval for the refund draft to carry, or throws with the box's words.
 */
export async function managerApprovesOn(
  till: { approveAtTill(r: { managerId: string; pin: string; kind: 'refund' | 'no_receipt_return' | 'exchange_refund'; billRef?: string; valueMinor: number; reason: string }): Promise<{ approved: boolean; approvalId?: string; approvedBy?: string; laneMessage?: string }> },
  managerId: string,
  request: { readonly kind: 'refund' | 'no_receipt_return' | 'exchange_refund'; readonly billRef?: string; readonly valueMinor: number; readonly reason?: string },
): Promise<{ by: string; reason: string; approvalId: string }> {
  const reason = request.reason ?? 'damaged';
  const outcome = await till.approveAtTill({ managerId, pin: pinOf(managerId), kind: request.kind, ...(request.billRef === undefined ? {} : { billRef: request.billRef }), valueMinor: request.valueMinor, reason });
  if (!outcome.approved || outcome.approvalId === undefined || outcome.approvedBy === undefined) throw new Error(`approval refused for ${managerId}: ${outcome.laneMessage ?? ''}`);
  return { by: outcome.approvedBy, reason, approvalId: outcome.approvalId };
}

/** The same approval asked directly of a box's lane socket, with the cashier's session — for a test posting records itself. */
export async function approvalFromLane(
  port: number, cashierToken: string, managerId: string,
  request: { readonly kind: 'refund' | 'no_receipt_return' | 'exchange_refund'; readonly billRef?: string; readonly valueMinor: number; readonly reason?: string },
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/lane/approvals`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-sre-operator': cashierToken },
    body: JSON.stringify({ managerId, pin: pinOf(managerId), reason: request.reason ?? 'damaged', ...request }),
  });
  const body = await res.json() as { approved?: boolean; approvalId?: string; laneMessage?: string };
  if (body.approved !== true || typeof body.approvalId !== 'string') throw new Error(`approval refused: ${body.laneMessage ?? res.status}`);
  return body.approvalId;
}

/**
 * DF-3-c (OB-30 "A"): sign a person in on an ENROLLED phone with the same PIN as the till — what the phone's sign-in page
 * posts. Resolves the cookie header the phone then carries: its device credential and the person's session together.
 */
export async function signInOnPhone(base: string, deviceCookie: string, staffId: string, screen: 'warehouse' | 'picker' | 'driver' = 'warehouse'): Promise<string> {
  const res = await fetch(`${base}/device/sign-in?screen=${screen}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: deviceCookie },
    body: JSON.stringify({ staffId, pin: pinOf(staffId) }),
  });
  const body = await res.json() as { signedIn?: boolean; laneMessage?: string };
  const session = res.headers.get('set-cookie')?.split(';')[0];
  if (body.signedIn !== true || session === undefined) throw new Error(`phone sign-in refused: ${body.laneMessage ?? res.status}`);
  return `${deviceCookie}; ${session}`;
}
