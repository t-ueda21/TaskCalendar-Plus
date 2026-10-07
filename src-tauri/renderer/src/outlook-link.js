import { t as translate } from './i18n.js';

export function wireOutlookLinks(Store) {
  const defaults = () => document.querySelectorAll('[data-task-dialog]').forEach(dialog => { dialog.dataset.outlookDefault = String(Store.getSettings().outlookWriteDefault === true); });
  defaults(); Store.subscribe('settings', defaults);
  let polling = false;
  async function refresh() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const response = await fetch('/api/outlook/jobs');
      if (!response.ok) throw new Error(translate('outlook.statusFailed'));
      const data = await response.json();
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      const pendingCount = data.counts ? Number(data.counts.pending)+Number(data.counts.working) : jobs.filter(job => ['pending','working'].includes(job.status)).length;
      const failedCount = data.counts ? Number(data.counts.failed) : jobs.filter(job => job.status === 'failed').length;
      for (const container of document.querySelectorAll('[data-outlook-jobs]')) {
        container.replaceChildren();
        const summary = document.createElement('p');
        summary.textContent = translate('outlook.jobCounts', { pending: pendingCount, failed: failedCount });
        container.appendChild(summary);
        for (const job of jobs.filter(job => job.status === 'failed')) {
          const row = document.createElement('div'); row.className = 'outlookJobError';
          const message = document.createElement('span'); message.textContent = `${job.title ?? ''}: ${job.error}`;
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn'; retry.textContent = translate('common.retry');
          retry.addEventListener('click', async () => {
            retry.disabled = true;
            try { const res = await fetch(`/api/outlook/jobs/${encodeURIComponent(job.taskId)}/retry`, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); if (!res.ok) throw new Error(translate('outlook.failed')); await refresh(); }
            catch(error) { message.textContent = String(error.message ?? error); retry.disabled = false; }
          });
          row.append(message,retry); container.appendChild(row);
        }
      }
      let banner = document.querySelector('[data-outlook-link-banner]');
      if (!banner) { banner = document.createElement('div'); banner.dataset.outlookLinkBanner = ''; banner.className = 'outlookLinkBanner'; banner.setAttribute('role','status'); document.body.appendChild(banner); }
      const failed = failedCount;
      banner.hidden = failed === 0;
      banner.textContent = failed ? translate('outlook.failedBanner', {count:failed}) : '';
    } catch (error) { console.warn('[Outlook status]', error); }
    finally { polling = false; }
  }
  void refresh(); setInterval(() => { void refresh(); },4000);
  Store.subscribe('tasks', () => { void refresh(); });
}
