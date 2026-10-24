// What the app emails, and when. Pure functions: the API feeds them Firestore
// data and sends what they return. Emails carry project ids, counts, sizes,
// statuses and links, never backup data.
import { runTime } from './sets.js';

const LEVEL = { ok: 0, warn: 1, bad: 2 };

// Health changes since the last check: alert when a project gets worse (or is
// new and not ok), "recovered" when it is back to ok. prev = { projectId: level }.
export function healthEvents(prev, projects) {
  const events = [];
  for (const p of projects) {
    const level = (p.health && p.health.level) || 'bad';
    const was = prev[p.projectId];
    if (was === level) continue;
    if (LEVEL[level] > LEVEL[was ?? 'ok']) events.push({ kind: 'alert', project: p, level, was: was || null });
    else if (was && level === 'ok') events.push({ kind: 'recovered', project: p, level, was });
  }
  return events;
}

export const levels = (projects) => Object.fromEntries(projects.map((p) => [p.projectId, (p.health && p.health.level) || 'bad']));

// Drill log lines only ("rebuild drill", "rebuild drill deploy", "restore drill
// (temporary database)"), never the email lines about them.
const DRILL = /^(rebuild|restore) drill/;
// A log line that just finished a drill: { passed, line } or null.
export function drillFinished(before, after, now = new Date()) {
  if (!after || !DRILL.test(after.action || '')) return null;
  if (!['succeeded', 'failed'].includes(after.status)) return null;
  if (before && before.status === after.status) return null;
  const at = after.endedAt?.toDate?.() || after.at?.toDate?.() || (after.at instanceof Date ? after.at : null);
  if (!before && at && now - at > 36 * 3600000) return null; // old GitHub runs read for the first time
  return { passed: after.status === 'succeeded', line: after };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function bytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n || 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
const tone = { ok: ['#1f7a3f', '#e3f3e8'], warn: ['#9a5b00', '#fbefd9'], bad: ['#b3261e', '#fbe4e2'] };
const pill = (level, text) => `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font:600 12px monospace;color:${tone[level][0]};background:${tone[level][1]}">${esc(text)}</span>`;

// One email layout for everything the app sends.
export function layout({ title, intro, rows = [], button, footer }) {
  const body = rows.map((r) => `<tr><td style="padding:8px 0;border-bottom:1px solid #d9e0dd">${r}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f4;font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#17201d">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #d9e0dd;border-radius:12px;padding:22px">
<tr><td style="font:700 16px sans-serif;color:#0f6b5c;padding-bottom:12px">&#9741; YourBackupAgent</td></tr>
<tr><td style="font:700 21px sans-serif;padding-bottom:8px">${esc(title)}</td></tr>
${intro ? `<tr><td style="color:#5b6964;padding-bottom:10px">${intro}</td></tr>` : ''}
<tr><td><table width="100%" cellpadding="0" cellspacing="0">${body}</table></td></tr>
${button ? `<tr><td style="padding-top:16px"><a href="${esc(button.href)}" style="display:inline-block;background:#0f6b5c;color:#fff;text-decoration:none;font-weight:600;padding:9px 16px;border-radius:7px">${esc(button.text)}</a></td></tr>` : ''}
<tr><td style="padding-top:18px;font-size:12px;color:#5b6964">${footer || 'You get this because you are on the YourBackupAgent access list. Change what you get in Settings, Email alerts.'}</td></tr>
</table></td></tr></table></body></html>`;
  return html;
}

const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

export function healthEmail(events, appUrl) {
  const bad = events.filter((e) => e.kind === 'alert');
  const subject = bad.length
    ? `Backups need attention: ${bad.map((e) => e.project.label || e.project.projectId).join(', ')}`
    : `Backups recovered: ${events.map((e) => e.project.label || e.project.projectId).join(', ')}`;
  const rows = events.map((e) => {
    const p = e.project;
    const h = p.health || {};
    return `<b>${esc(p.label || p.projectId)}</b> <span style="color:#5b6964;font:12px monospace">${esc(p.projectId)}</span><br>${pill(e.level, h.text || e.level)}${e.was ? ` <span style="color:#5b6964;font-size:13px">was ${esc(e.was)}</span>` : ''}<br><span style="font-size:13px;color:#5b6964">${h.goodCount ?? 0} good sets (keeps at least ${p.keepMinSets ?? '?'}) · newest good ${h.newestGood ? esc(runTime(h.newestGood)?.toISOString().slice(0, 16).replace('T', ' ') + ' UTC') : 'none'}</span> · <a href="${esc(appUrl)}/projects/${encodeURIComponent(p.projectId)}">open</a>`;
  });
  const html = layout({ title: subject, intro: bad.length ? 'Checked after the nightly refresh. Each project below changed since the last check.' : 'These projects are healthy again.', rows, button: { href: appUrl, text: 'Open YourBackupAgent' } });
  return { subject, html, text: strip(`${subject}\n\n${rows.join('\n\n').replace(/<br>/g, '\n')}\n\n${appUrl}`) };
}

export function drillEmail(d, label, appUrl) {
  const l = d.line;
  const subject = `Rebuild drill ${d.passed ? 'passed' : 'FAILED'}: ${label || l.project}`;
  const rows = [
    `${pill(d.passed ? 'ok' : 'bad', d.passed ? 'passed' : 'failed')} <b>${esc(l.action)}</b> of <code>${esc(l.project || '')}</code>${l.runIds && l.runIds[0] ? ` from set <code>${esc(l.runIds[0])}</code>` : ''}`,
    l.detail ? `<pre style="white-space:pre-wrap;font:12px monospace;color:#5b6964;margin:0">${esc(String(l.detail).split('\n').slice(-12).join('\n'))}</pre>` : '',
  ].filter(Boolean);
  const html = layout({ title: subject, intro: `Started by ${esc(l.by || 'someone')}.`, rows, button: { href: l.link || `${appUrl}/log`, text: l.link ? 'Open the run' : 'Open the log' } });
  return { subject, html, text: strip(`${subject}\n${l.detail || ''}\n${appUrl}/log`) };
}

// The Monday summary: last 7 days per project.
export function weeklyEmail(projects, setsByProject, log, appUrl, now = new Date()) {
  const since = now.getTime() - 7 * 86400000;
  const inWeek = (id) => (runTime(id)?.getTime() || 0) >= since;
  let good = 0, total = 0;
  const rows = projects.map((p) => {
    const sets = (setsByProject[p.projectId] || []).filter((s) => s.inProject && inWeek(s.id));
    const g = sets.filter((s) => s.status === 'succeeded').length;
    good += g; total += sets.length;
    const drills = log.filter((l) => l.project === p.projectId && /^(rebuild|restore) drill/.test(l.action) && ['succeeded', 'failed'].includes(l.status));
    const h = p.health || { level: 'bad', text: 'unknown' };
    return `<b>${esc(p.label || p.projectId)}</b> ${pill(h.level, h.text)}<br><span style="font-size:13px;color:#5b6964">${g} of ${sets.length} nightly backups good · ${bytes(p.totals?.bytes || 0)} stored · drills: ${drills.filter((d) => d.status === 'succeeded').length} passed, ${drills.filter((d) => d.status === 'failed').length} failed</span>`;
  });
  const rate = total ? Math.round((100 * good) / total) : 0;
  const subject = `Weekly backups: ${good} of ${total} good (${rate}%) across ${projects.length} project${projects.length === 1 ? '' : 's'}`;
  const html = layout({ title: subject, intro: 'The last 7 days.', rows, button: { href: `${appUrl}/reports`, text: 'Open reports' } });
  return { subject, html, text: strip(`${subject}\n\n${rows.join('\n\n').replace(/<br>/g, '\n')}\n\n${appUrl}/reports`) };
}

export function accessRequestEmail(email, note, appUrl) {
  const subject = `${email} asks for access to YourBackupAgent`;
  const html = layout({ title: subject, rows: [note ? `“${esc(note)}”` : 'No note.'], button: { href: `${appUrl}/settings`, text: 'Approve or decline' }, footer: 'You get this because you own YourBackupAgent.' });
  return { subject, html, text: `${subject}\n${note || ''}\n${appUrl}/settings` };
}

export function welcomeEmail(email, by, appUrl) {
  const subject = 'You have access to YourBackupAgent';
  const html = layout({ title: subject, intro: `${esc(by)} added ${esc(email)}. Sign in with that Google account.`, button: { href: appUrl, text: 'Open YourBackupAgent' }, footer: 'Invite only: you get this because someone on the access list added you.' });
  return { subject, html, text: `${subject}\nSign in as ${email}: ${appUrl}` };
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
