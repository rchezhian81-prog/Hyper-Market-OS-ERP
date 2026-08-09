import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSignedPack, writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner } from '../../services/catalogue/src/index';
import { publishPack, type SignedPack } from '../../services/catalogue/src/pack';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

// The signed catalogue pack on the box's disk (SYNC-01 inc 2). The swap is atomic (temp→rename) so a
// power cut never leaves a torn pack, and a restored pack is verified the SAME way a lane verifies
// one over the wire — a tampered file starts the box from no pack, never trusts a bad baseline.

const KEY = ['signed', 'pack', 'file', 'signing', 'key'].join('-').padEnd(48, '0');
const SIGNER = hmacSigner(KEY);
const TENANT = 't-sre';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-signed-pack-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function signedPack(version: number, tenantId = TENANT): SignedPack {
  const snapshot: CatalogueSnapshot = {
    tenantId, version, builtAt: `2026-08-0${version}T09:00:00Z`,
    products: [{ productId: 'P1', sku: 'GHEE-1L', name: 'Ghee 1L', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active' }],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: SIGNER, publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

describe('signed pack on disk (SYNC-01 inc 2)', () => {
  it('round-trips a verified pack — write then read returns the same pack', async () => {
    const dir = await tempDir();
    await writeSignedPack(dir, signedPack(3));
    const back = await readSignedPack(dir, SIGNER, TENANT);
    expect(back?.snapshot.version).toBe(3);
    expect(back?.snapshot.products[0]?.productId).toBe('P1');
  });

  it('leaves no temp file behind — the rename is the whole swap', async () => {
    const dir = await tempDir();
    await writeSignedPack(dir, signedPack(1));
    const files = await readdir(dir);
    expect(files).toContain('signed-pack.json');
    expect(files).not.toContain('signed-pack.json.tmp'); // renamed away, not left half-written
  });

  it('overwrites atomically — a second write is what the next read sees', async () => {
    const dir = await tempDir();
    await writeSignedPack(dir, signedPack(1));
    await writeSignedPack(dir, signedPack(2));
    expect((await readSignedPack(dir, SIGNER, TENANT))?.snapshot.version).toBe(2);
  });

  it('returns undefined when there is no pack on disk yet', async () => {
    expect(await readSignedPack(await tempDir(), SIGNER, TENANT)).toBeUndefined();
  });

  it('refuses a tampered file — a bad signature is not a baseline to trust', async () => {
    const dir = await tempDir();
    const tampered: SignedPack = { ...signedPack(2), signature: 'deadbeef'.repeat(8) };
    await writeFile(join(dir, 'signed-pack.json'), JSON.stringify(tampered));
    expect(await readSignedPack(dir, SIGNER, TENANT)).toBeUndefined();
  });

  it('refuses a pack built for another tenant', async () => {
    const dir = await tempDir();
    await writeSignedPack(dir, signedPack(2, 'some-other-tenant'));
    expect(await readSignedPack(dir, SIGNER, TENANT)).toBeUndefined();
  });

  it('refuses garbage that is not even a pack, without throwing', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'signed-pack.json'), 'not json at all {{{');
    expect(await readSignedPack(dir, SIGNER, TENANT)).toBeUndefined();
    await writeFile(join(dir, 'signed-pack.json'), JSON.stringify({ nope: true }));
    expect(await readSignedPack(dir, SIGNER, TENANT)).toBeUndefined();
  });
});
