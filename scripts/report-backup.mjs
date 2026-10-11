#!/usr/bin/env node
// The backup job tells head office how it went (PA-12 round 6). Called by infra/pilot/backup/encrypted-backup.sh on
// EVERY exit — success and failure. See scripts/lib/backup-report.mjs for what is measured and why.
//
//   node scripts/report-backup.mjs --ok     --id <backupId> --started <iso> --artefact <kept file> [--offsite-confirmed | --offsite-detail <text>]
//   node scripts/report-backup.mjs --failed --id <backupId> --started <iso> --reason <text>
//
// Where to report and the job's own sign-in come from the environment ONLY (SRE_BACKUP_REPORT_API_URL,
// SRE_BACKUP_REPORT_TOKEN — provisioned by the operator; docs/runbooks/backup-and-recovery.md). The token is never
// printed. Exit codes: 0 reported · 2 bad arguments · 3 NOT REPORTED, reporter not configured · 4 NOT REPORTED, head
// office refused or could not be reached. Any non-zero exit fails the systemd unit, so the operator sees it — and head
// office, having heard nothing, raises the backup as MISSED by itself when it falls due.

import { reporterFromEnv, measureArtefact, backupReportBody, reportBackupOutcome } from './lib/backup-report.mjs';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; };
const has = (flag) => process.argv.includes(flag);
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

const ok = has('--ok');
const failed = has('--failed');
const backupId = arg('--id');
const startedAt = arg('--started');
if (ok === failed || !backupId || !/^[A-Za-z0-9._-]{1,120}$/.test(backupId) || !isIso(startedAt)) {
  console.error('report-backup: say --ok or --failed, with --id <backupId> and --started <ISO time>.');
  process.exit(2);
}
const endedAt = new Date().toISOString();

let body;
if (ok) {
  const artefact = arg('--artefact');
  if (!artefact) { console.error('report-backup: --ok needs --artefact <the kept file>.'); process.exit(2); }
  let measured;
  try {
    measured = measureArtefact(artefact);
  } catch (e) {
    // The job said it succeeded but the file is not there: that is a failure, and it is reported as one.
    measured = undefined;
    body = backupReportBody({ ok: false, startedAt, endedAt, reason: `the kept file could not be read (${e.code ?? 'unreadable'})` });
  }
  if (measured !== undefined) {
    body = backupReportBody({
      ok: true, startedAt, endedAt, measured,
      offsiteConfirmed: has('--offsite-confirmed'), offsiteDetail: arg('--offsite-detail'),
    });
  }
} else {
  body = backupReportBody({ ok: false, startedAt, endedAt, reason: arg('--reason') ?? 'no reason given' });
}

const reporter = reporterFromEnv();
if (!reporter.configured) {
  console.error(`NOT REPORTED — backup ${backupId} (${body.ok ? 'completed' : 'FAILED'}) could not be reported to head office: ${reporter.missing.join(', ')} not set. Head office will raise this backup as MISSED.`);
  process.exit(3);
}

try {
  const r = await reportBackupOutcome({ reporter, backupId, body });
  if (!r.reported) {
    console.error(`NOT REPORTED — head office answered ${r.status} for backup ${backupId}: ${r.body?.error?.whatHappened ?? 'no reason given'}`);
    process.exit(4);
  }
  const counts = r.body?.counts;
  console.log(`reported   ${backupId}: ${body.ok ? 'completed' : 'FAILED'}${counts === false ? ` — does not count: ${(r.body.why ?? []).join(', ')}` : counts === true ? ' — counts as a good backup' : ' (already on the record)'}`);
} catch (e) {
  console.error(`NOT REPORTED — head office could not be reached for backup ${backupId} (${e.cause?.code ?? e.message}). Head office will raise this backup as MISSED.`);
  process.exit(4);
}
