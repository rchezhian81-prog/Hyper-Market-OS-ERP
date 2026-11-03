// Failed jobs (W4 · M35-FR-03 · P-08) — the page over head office's background-job register. The session
// (apps/web-erp/src/failed-jobs-session.ts, in the bundle as window.failedJobs) does every call and every rule; this page
// lays out what it is told. It reads as it opens; sending a job round again is an explicit press, offered only on a job
// that failed and only to a person who may. Every word this page adds has a Tamil twin; head office's own sentences (the
// job's error, a refusal) stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.failedJobs ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, retry: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const when = (iso) => (api === null ? iso : api.moment(iso));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let failed = null;

function paintJobs() {
  $('jobs').replaceChildren(); $('jobs-asat').textContent = '';
  if (failed === null) return;
  if (failed.asAt !== '') $('jobs-asat').textContent = `${t('asAt')} ${when(failed.asAt)}`;
  if (failed.jobs.length === 0) $('jobs').append(text('li', t('none'), 'meta'));
  for (const j of failed.jobs) {
    const li = document.createElement('li'); li.dataset.job = j.jobId;
    li.append(text('h4', `⚠ ${j.jobId} · ${t('kind')} ${j.kind}`),
      text('p', `${j.attempts} ${t('runs')} · ${j.retries} ${t('retries')} · ${t('lastRun')} ${j.lastRunAt === undefined ? t('notRun') : when(j.lastRunAt)}`, 'meta'),
      text('p', `${t('error')}: ${j.lastError}`, 'meta'));
    if (may.retry) {
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t('retry');
      b.addEventListener('click', async () => {
        b.disabled = true;
        status.textContent = t('reading');
        const out = await session.retry(j.jobId);
        status.textContent = out.result === 'ok' ? t('retried') : api.outcomeWords(lang, out);
        if (out.result === 'ok') { $('jobs-status').textContent = `${j.jobId}: ${t('retried')}`; void load(); } else b.disabled = false;
      });
      li.append(b, status);
    }
    $('jobs').append(li);
  }
}

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  $('jobs-h').textContent = t('listH');
  paintJobs();
}

async function load() {
  const out = await session.failed();
  if (out.result === 'ok') { failed = out.value; if ($('jobs-status').textContent === t('reading')) $('jobs-status').textContent = ''; } else { failed = null; $('jobs-status').textContent = api.outcomeWords(lang, out); }
  paintJobs();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('jobs-s').hidden = false; if (!may.retry) $('page-status').textContent = t('cannotRetry'); $('jobs-status').textContent = t('reading'); void load(); }
