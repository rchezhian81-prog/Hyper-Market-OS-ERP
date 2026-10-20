// A real store box (edge/store-edge/src/main.ts startEdge) with the office PIN gate on (OB-259), for the integration and
// browser tests: a store setup naming an owner, a store manager, an accountant and a cashier, each with a till PIN issued
// on this box exactly as `till-pin` does (only the verifier is written). Synthetic people only.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { issueTillCredential, tillPinKey } from '../../packages/identity/src/till-pin';

export const OFFICE_KEY = ['office', 'gate', 'pack', 'key', 'for', 'tests'].join('-').padEnd(64, '0');
export const STORE = 'S-OFFICE';
export const PEOPLE = {
  owner: { userId: 'u-owner', displayName: 'Owner Person', roleId: 'owner', pin: '135790' },
  manager: { userId: 'u-manager', displayName: 'Manager Person', roleId: 'store_manager', pin: '246801' },
  accountant: { userId: 'u-accounts', displayName: 'Accounts Person', roleId: 'accountant', pin: '112233' },
  cashier: { userId: 'u-cashier', displayName: 'Cashier Person', roleId: 'cashier', pin: '998877' },
} as const;

/** The roles as the store setup carries them — the permissions the gate and the screens read. */
const ROLES = [
  { id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'till.dayclose.read', 'migration.cleaning.read', 'pos.sale.sync'] },
  { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'till.dayclose.read', 'migration.cleaning.read', 'pos.sale.sync'] },
  { id: 'accountant', name: 'Accountant', permissions: ['identity.self.read', 'migration.cleaning.read'] },
  { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'pos.sale.sync', 'migration.screen.read'] },
];

export interface OfficeBox { readonly edge: EdgeProcess; readonly base: string; readonly dataDir: string; stop(): Promise<void> }

/** Start the box (again, over the same folder, for a cold restart). `gate: false` starts it the old way, with no gate. */
export async function startOfficeBox(opts: { readonly dataDir?: string; readonly gate?: boolean } = {}): Promise<OfficeBox> {
  const dataDir = opts.dataDir ?? await mkdtemp(join(tmpdir(), 'sre-office-gate-'));
  if (opts.dataDir === undefined) {
    const people = Object.values(PEOPLE);
    await writeFile(join(dataDir, 'store-pack.json'), JSON.stringify({
      version: 1,
      policies: { storeId: STORE, branchId: STORE, branchName: 'Office gate store', warehouseId: null, tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
      lossPreventionRules: [],
      people: people.map((p) => ({ userId: p.userId, displayName: p.displayName, roleId: p.roleId })),
      roles: ROLES,
      roleAssignments: people.map((p) => ({ userId: p.userId, roleId: p.roleId, branchScope: [STORE] })),
    }), 'utf8');
    const at = new Date().toISOString();
    await writeFile(join(dataDir, 'till-credentials.json'), JSON.stringify({ version: 1, credentials: people.map((p) => issueTillCredential({ userId: p.userId, pin: p.pin, key: tillPinKey(OFFICE_KEY), issuedAt: at, issuedBy: 'test' })) }), { mode: 0o600 });
  }
  const edge = await startEdge({
    EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: 't-office', PACK_SIGNING_KEY: OFFICE_KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: join(dataDir, 'store-pack.json'),
    ...(opts.gate === false ? {} : { EDGE_OFFICE_SIGN_IN: 'pin' }),
  }, () => {});
  if (edge === undefined || edge.screens === null || edge.screens === undefined) throw new Error('the box did not start');
  return { edge, base: `http://127.0.0.1:${edge.screens.port}`, dataDir, stop: () => edge.stop() };
}
