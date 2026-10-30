#!/usr/bin/env node
// scripts/release-reconcile.mjs — the post-deploy RECONCILE and the per-release QG-10 record (roadmap §22 QG-10 · WF-20).
//
// `infra/deploy/release.sh` runs it on the box, around every release:
//
//   node scripts/release-reconcile.mjs snapshot [--upto <seq>] [--settle-seconds N]
//       Read head office's books and print ONE JSON snapshot: the ledger's count, last sequence, a digest over
//       (sequence, id, idempotency key) and the count per ledger family; the outbox's pending and dead-letter counts and
//       the age of its oldest pending message. With --upto, the same ledger figures again for the events up to <seq> —
//       the ones that were there before the release. The ledger figures stop at a SETTLED horizon: the snapshot first waits
//       (up to --settle-seconds, default 60) for every append that was in flight when it began, because a sequence is
//       handed out before its append commits; an append still open after that is said, and the snapshot exits 1.
//       READ ONLY (read-only transactions; it writes nothing and takes no lock). It runs INSIDE the stack's
//       own `migrate` container (release.sh: `docker compose run … migrate node scripts/release-reconcile.mjs snapshot`),
//       so it reads DATABASE_URL from that container's own environment — the release script never sees a secret, and
//       this script never prints the connection string or any value from it.
//   node scripts/release-reconcile.mjs max-seq <before.json>
//       Print the last ledger sequence a snapshot saw (exit 1 when it is not a snapshot).
//   node scripts/release-reconcile.mjs compare <before.json> <after.json> [--max-backlog-growth N] [--max-dead-letter-growth N] [--json <out>]
//       RECONCILED (exit 0) or every DIFFERENCE in words (exit 1). An unreadable snapshot is a difference, never a pass.
//   node scripts/release-reconcile.mjs qg10 --sha S --previous P --by A --run R --attempt N --box B --outcome O
//         --health X --smoke X --reconciliation X --monitoring X --rollback X [--differences <compare --json file>]
//       Print the QG-10 evidence line for this release (JSON). It is evidence for the owner's decision, never a GO.
//   node scripts/release-reconcile.mjs post-qg10 --line <qg10 line file> --url <head office> [--token-file <key file>]
//       OB-423: post that line to head office's gate register under the release script's own machine identity. The key is
//       READ FROM THE FILE the custodian put on the box (SRE_QG10_PUSH_TOKEN_FILE) — never an argument, never printed.
//       Prints one sentence: posted, already there, or NOT POSTED and why (no key, unreachable, refused). Exit 0 when the
//       note is on the register, 3 when it is not — release.sh says it and carries on either way (P-08).
//
// Exit codes: 0 ok / reconciled · 1 a difference, or a snapshot that cannot be read · 64 usage.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compareSnapshots, parseSnapshot, qg10Record, postQg10Note } from './lib/release-reconcile.mjs';

const [, , verb, ...rest] = process.argv;
const usage = () => {
  process.stderr.write('usage: release-reconcile.mjs snapshot [--upto <seq>] [--settle-seconds N] | max-seq <before.json> | compare <before.json> <after.json> [--max-backlog-growth N] [--max-dead-letter-growth N] [--json <out>] | qg10 --sha … | post-qg10 --line <file> --url <head office> [--token-file <key file>]\n');
  process.exit(64);
};
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const count = (v, dflt) => (v === undefined ? dflt : /^\d{1,12}$/.test(v) ? Number(v) : usage());
const readSnapshot = (path) => { try { return parseSnapshot(readFileSync(path, 'utf8')); } catch { return undefined; } };

/** The ledger figures for every event (or every event up to `upTo`), in one statement. */
const LEDGER_SQL = `
  WITH ledger_rows AS (SELECT seq, id, idempotency_key, split_part(stream, chr(31), 1) AS family FROM event_ledger WHERE ($1::bigint IS NULL OR seq <= $1::bigint))
  SELECT (SELECT count(*) FROM ledger_rows)::bigint AS count,
         (SELECT coalesce(max(seq), 0) FROM ledger_rows)::bigint AS max_seq,
         (SELECT md5(coalesce(string_agg(seq::text || ':' || id::text || ':' || idempotency_key, ',' ORDER BY seq), '')) FROM ledger_rows) AS digest,
         (SELECT coalesce(json_object_agg(family, n), '{}'::json) FROM (SELECT family, count(*) AS n FROM ledger_rows GROUP BY family) f) AS by_family`;

async function snapshot() {
  const upTo = flag('--upto') === undefined ? undefined : count(flag('--upto'));
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    process.stderr.write('release-reconcile: DATABASE_URL is not set in this container, so the books cannot be read.\n');
    process.exit(1);
  }
  let pg;
  try { pg = (await import('pg')).default; } catch { process.stderr.write('release-reconcile: the database driver is not installed here.\n'); process.exit(1); }
  const settleSeconds = count(flag('--settle-seconds'), 60);
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    // The ledger's sequence is handed out when an append STARTS, not when it commits, so an append still in flight can
    // land BELOW the highest sequence already visible. A horizon read while one is in flight would later "grow events in
    // the past" — a false difference while trading carries on during the release. So: read the horizon, then draw a
    // transaction id of our own a moment later (a read-only transaction may; it writes nothing) and wait until every
    // transaction older than it has finished — the oldest still running (the snapshot's xmin) has passed it. Every
    // append that drew a sequence at or below the horizon is older, so after that the figures up to it are final.
    // (A snapshot's in-progress list leaves out the newest running transactions, so it cannot be waited on alone.)
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id', '*', true)");
    const horizon = Number((await client.query('SELECT coalesce(max(seq), 0)::bigint AS horizon FROM event_ledger')).rows[0].horizon);
    await client.query('ROLLBACK');
    await new Promise((r) => setTimeout(r, 100));
    await client.query('BEGIN READ ONLY');
    const mark = String((await client.query('SELECT pg_current_xact_id()::text AS x')).rows[0].x);
    await client.query('COMMIT');
    const deadline = Date.now() + settleSeconds * 1000;
    for (;;) {
      const open = Number((await client.query(
        'SELECT CASE WHEN pg_snapshot_xmin(pg_current_snapshot()) > $1::xid8 THEN 0 ELSE (SELECT count(*) FROM pg_snapshot_xip(pg_current_snapshot()) x WHERE x < $1::xid8) END::bigint AS n',
        [mark],
      )).rows[0].n);
      if (open === 0) break;
      if (Date.now() > deadline) {
        process.stderr.write(`release-reconcile: the books did not settle — ${open} transaction(s) that were running when the snapshot began are still open after ${settleSeconds} s, so the ledger up to sequence ${horizon} is not final yet. Nothing was compared; take the snapshot again.\n`);
        process.exitCode = 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await client.query('BEGIN READ ONLY');
    // The platform scope operator tools read in (migration 0012): every shop's rows, read only.
    await client.query("SELECT set_config('app.tenant_id', '*', true)");
    const facts = async (seq) => {
      const r = (await client.query(LEDGER_SQL, [seq ?? null])).rows[0];
      return { count: Number(r.count), maxSeq: Number(r.max_seq), digest: String(r.digest), byFamily: Object.fromEntries(Object.entries(r.by_family ?? {}).map(([k, v]) => [k, Number(v)])) };
    };
    // The ledger as it stands up to the settled horizon (events after it are later trading, counted by the next snapshot).
    const ledger = await facts(horizon);
    const states = Object.fromEntries((await client.query('SELECT state, count(*)::bigint AS n FROM sync_outbox GROUP BY state')).rows.map((r) => [r.state, Number(r.n)]));
    const oldest = (await client.query("SELECT extract(epoch FROM now() - min(created_at))::bigint AS s FROM sync_outbox WHERE state = 'pending'")).rows[0]?.s;
    const at = (await client.query('SELECT now() AS at')).rows[0].at;
    const out = {
      version: 1, at: new Date(at).toISOString(), ledger,
      outbox: { pending: states['pending'] ?? 0, deadLetter: states['dead_letter'] ?? 0, oldestPendingSeconds: oldest === null || oldest === undefined ? null : Number(oldest) },
      ...(upTo === undefined ? {} : { upTo: { seq: upTo, ...(({ count: c, digest, byFamily }) => ({ count: c, digest, byFamily }))(await facts(upTo)) } }),
    };
    await client.query('ROLLBACK');
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    // The driver's own words only by their code: a message could carry a host name, never a value we should print.
    process.stderr.write(`release-reconcile: the books could not be read (${e && typeof e === 'object' && 'code' in e ? String(e.code) : 'error'}).\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

function compare() {
  const [beforePath, afterPath] = rest;
  if (beforePath === undefined || afterPath === undefined || beforePath.startsWith('--') || afterPath.startsWith('--')) usage();
  const result = compareSnapshots(readSnapshot(beforePath), readSnapshot(afterPath), {
    maxBacklogGrowth: count(flag('--max-backlog-growth'), 0), maxDeadLetterGrowth: count(flag('--max-dead-letter-growth'), 0),
  });
  const out = flag('--json');
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(result)}\n`);
  if (result.ok) {
    process.stdout.write('RECONCILED — every event on the ledger before the release is still there, unchanged; no new dead letters; the sync backlog did not grow.\n');
    return;
  }
  for (const d of result.differences) process.stdout.write(`DIFFERENCE — ${d}\n`);
  process.exitCode = 1;
}

function qg10() {
  const need = (n) => { const v = flag(`--${n}`); return v === undefined ? usage() : v; };
  let differences = [];
  const from = flag('--differences');
  if (from !== undefined) { try { differences = JSON.parse(readFileSync(from, 'utf8')).differences ?? []; } catch { differences = ['the reconcile result could not be read back']; } }
  const record = qg10Record({
    sha: need('sha'), previous: need('previous'), by: need('by'), run: need('run'), attempt: need('attempt'), box: need('box'), outcome: need('outcome'),
    at: new Date().toISOString(),
    checks: { health: need('health'), smoke: need('smoke'), reconciliation: need('reconciliation'), monitoring: need('monitoring'), rollback: need('rollback') },
    differences,
  });
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function postQg10() {
  const linePath = flag('--line');
  if (linePath === undefined) usage();
  let line = '';
  try { line = readFileSync(linePath, 'utf8').trim(); } catch { line = ''; }
  // The key: only from the file the custodian placed on the box. Its text is never printed, logged or passed on a command line.
  const keyFile = (flag('--token-file') ?? '').trim();
  let token = ''; let noKeyBecause;
  if (keyFile === '') noKeyBecause = 'no key is configured on this box (SRE_QG10_PUSH_TOKEN_FILE is not set)';
  else {
    try { token = readFileSync(keyFile, 'utf8').trim(); } catch (e) {
      noKeyBecause = e && typeof e === 'object' && e.code === 'ENOENT'
        ? 'the key file named by SRE_QG10_PUSH_TOKEN_FILE is not on this box'
        : 'the key file named by SRE_QG10_PUSH_TOKEN_FILE cannot be read by the release script';
    }
    if (noKeyBecause === undefined && token === '') noKeyBecause = 'the key file named by SRE_QG10_PUSH_TOKEN_FILE is empty';
  }
  const out = await postQg10Note({
    line, url: flag('--url') ?? '', token, ...(noKeyBecause === undefined ? {} : { noKeyBecause }),
    idempotencyKey: `qg10-note-${createHash('sha256').update(line).digest('hex').slice(0, 40)}`,
    fetch: (url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
  process.stdout.write(`${out.words}\n`);
  process.exitCode = out.posted ? 0 : 3;
}

if (verb === 'snapshot') await snapshot();
else if (verb === 'max-seq') {
  const s = rest[0] === undefined ? usage() : readSnapshot(rest[0]);
  if (s === undefined) { process.stderr.write('release-reconcile: that is not a snapshot.\n'); process.exit(1); }
  process.stdout.write(`${s.ledger.maxSeq}\n`);
} else if (verb === 'compare') compare();
else if (verb === 'qg10') qg10();
else if (verb === 'post-qg10') await postQg10();
else usage();
