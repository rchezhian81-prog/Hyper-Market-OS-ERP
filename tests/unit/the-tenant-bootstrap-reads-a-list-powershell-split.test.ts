import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Store PC, 5 Nov 2026 (OB-277 · P-08): the owner typed the guide's Part 15 line in PowerShell,
//   --admin accountant-01:accountant,store-manager-01:store_manager
// PowerShell reads an unquoted comma list as an array and hands it on joined by a SPACE, so the tool saw one person,
// "accountant-01", with the role "accountant store-manager-01", and refused (unknown_role). The list is now split on
// commas and spaces alike (a login and a role never hold a space), and the guide quotes the list.

const dryRun = (admin: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'sre-boot-'));
  const envFile = join(dir, '.env.real');
  writeFileSync(envFile, 'MIGRATION_TARGET_KIND=rehearsal\nDEMO_TENANT_IDS=pilot-demo\n', { mode: 0o600 });
  return spawnSync(process.execPath, ['scripts/dist/bootstrap-tenant.js', '--tenant', randomUUID(), '--owner', 'owner-01',
    '--admin', admin, '--operator', 'Test Owner', '--env-file', envFile, '--dry-run'], { encoding: 'utf8' });
};

describe('the tenant bootstrap reads the first people however the window hands the list on', () => {
  beforeAll(() => {
    const b = spawnSync(process.execPath, ['scripts/build-service.mjs', 'tools', '--quiet'], { encoding: 'utf8' });
    expect(b.status, b.stderr).toBe(0);
  }, 120_000);

  for (const [how, admin] of [
    ['typed with a comma (quoted, or bash)', 'accountant-01:accountant,store-manager-01:store_manager'],
    ['as PowerShell hands on an unquoted comma list (a space)', 'accountant-01:accountant store-manager-01:store_manager'],
  ] as const) {
    it(`lists both people with their own roles — ${how}`, () => {
      const r = dryRun(admin);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('• accountant-01 as accountant');
      expect(r.stdout).toContain('• store-manager-01 as store_manager');
      expect(r.stdout).toContain('DRY RUN — nothing was written.');
    });
  }

  it('a role that really is not in the catalogue is still refused, by name', () => {
    const r = dryRun('accountant-01:accountent');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('REFUSED (unknown_role)');
  });

  it('the Windows guide quotes the --admin list, so PowerShell passes it whole', async () => {
    const { readFileSync } = await import('node:fs');
    const guide = readFileSync('docs/runbooks/store-computer-owner-guide-windows.md', 'utf8');
    expect(guide).toContain('--admin "accountant-01:accountant,store-manager-01:store_manager"');
    expect(guide).not.toMatch(/--admin accountant-01:accountant,/);
  });
});
