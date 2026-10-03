import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **Demo backups on the box are encrypted, and the box cannot decrypt them** (owner decision 28 Sep
 * 2026, option C — off-site deferred until before real data).
 *
 * The plain dump may exist only in RAM (/dev/shm) and is shredded on every exit path; what lands on
 * disk is `age`-encrypted to a PUBLIC recipient key (never a passphrase, which would have to live on the
 * box beside the backups). Restoring needs the owner's private key, and still goes through the verified
 * restore (checksum, empty-target-unless-force, exact reconciliation). Nothing deletes from the backups
 * folder. These are structural checks; the live encrypt → restore → reconcile proof is recorded in
 * docs/pilot/HOSTED-DEMO-RESULTS.md.
 */

const BACKUP = readFileSync('infra/pilot/backup/encrypted-backup.sh', 'utf8');
const RESTORE = readFileSync('infra/pilot/backup/restore-encrypted.sh', 'utf8');
const code = (s: string): string => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('the demo backup is encrypted at rest', () => {
  it('writes the plain dump only to RAM, and shreds it on every exit', () => {
    expect(code(BACKUP)).toMatch(/mktemp -d \/dev\/shm\//);
    expect(code(BACKUP)).toMatch(/--out "\$WORK"/);
    expect(code(BACKUP)).toMatch(/trap cleanup EXIT/);
    expect(code(BACKUP)).toMatch(/shred -u/);
  });

  it('encrypts to a public recipient key — never a passphrase kept on the box', () => {
    expect(code(BACKUP)).toMatch(/age -R "\$RECIPIENT"/);
    expect(code(BACKUP)).not.toMatch(/age\s+(-p|--passphrase)/);
    expect(code(BACKUP)).toMatch(/grep -q '\^age1'/);
  });

  it('never deletes anything from the backups folder', () => {
    expect(code(BACKUP)).not.toMatch(/rm [^\n]*\$OUT|rm [^\n]*backups/);
    expect(code(RESTORE)).not.toMatch(/rm [^\n]*\$BACKUPS|rm [^\n]*backups/);
  });

  it('never prints or passes the database password on a command line', () => {
    expect(code(BACKUP)).not.toMatch(/echo[^\n]*DATABASE_URL|echo[^\n]*PASSWORD/);
    // The password travels in PGPASSWORD, never inside the connection URL.
    expect(code(BACKUP)).toMatch(/export PGPASSWORD/);
    expect(code(BACKUP)).not.toMatch(/:\$\(val POSTGRES_PASSWORD\)@|%s:%s@/);
    expect(code(RESTORE)).toMatch(/RESTORE_TARGET_URL/);
    expect(code(RESTORE)).not.toMatch(/--target/);
  });

  it('restores through the verified restore, unlocked only into RAM', () => {
    expect(code(RESTORE)).toMatch(/mktemp -d \/dev\/shm\//);
    expect(code(RESTORE)).toMatch(/age -d -i "\$key"/);
    expect(code(RESTORE)).toMatch(/scripts\/restore\.mjs" --manifest/);
    expect(code(RESTORE)).toMatch(/trap cleanup EXIT/);
  });
});
