function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function chunkSessions(sessions, maxColumns = 5) {
  const width = Math.floor(Number(maxColumns));
  if (!Number.isFinite(width) || width < 1) throw new RangeError('maxColumns must be at least 1');
  const list = Array.isArray(sessions) ? sessions : [];
  const chunks = [];
  for (let index = 0; index < list.length; index += width) {
    chunks.push(list.slice(index, index + width));
  }
  return chunks;
}

function sessionCell(person, session) {
  const cell = person.perSession?.[session.id] || { state: 'absent', sharePct: 0 };
  const state = cell.state === 'present' ? 'present' : 'absent';
  const share = Number.isFinite(Number(cell.sharePct)) ? Number(cell.sharePct) : 0;
  return `<td><span class="dot ${state}"></span><span class="pct ${state}">${state === 'absent' ? '-' : `${escapeHtml(share)}%`}</span></td>`;
}

function matrixTable(aggregation, sessions, className, options) {
  const labels = options.labels || {};
  const formatSession = options.formatSession || (session => session.id);
  const formatDuration = options.formatDuration || (seconds => String(seconds ?? 0));
  const sessionCount = Number(aggregation.sessionCount) || 0;
  const people = Array.isArray(aggregation.people) ? aggregation.people : [];

  return `<table class="rep-matrix ${className}"><thead><tr><th>${escapeHtml(labels.participant)}</th>
    ${sessions.map(session => `<th>${escapeHtml(formatSession(session))}</th>`).join('')}
    <th>${escapeHtml(labels.attended)}</th><th>${escapeHtml(labels.totalTime)}</th><th>${escapeHtml(labels.totalShare)}</th></tr></thead><tbody>
    ${people.map(person => `<tr><td><b>${escapeHtml(person.name)}</b></td>
      ${sessions.map(session => sessionCell(person, session)).join('')}
      <td class="mono">${escapeHtml(person.attendedCount)}/${escapeHtml(sessionCount)}</td>
      <td class="mono">${escapeHtml(formatDuration(person.totalSeconds))}</td>
      <td class="mono"><b>${escapeHtml(person.totalShare)}%</b></td></tr>`).join('')}
    </tbody></table>`;
}

export function renderSeriesMatrices(aggregation, options = {}) {
  const sessions = Array.isArray(aggregation?.sessions) ? aggregation.sessions : [];
  const labels = options.labels || {};
  const screenTable = matrixTable(aggregation || {}, sessions, 'screen-matrix', options);
  const chunks = chunkSessions(sessions, options.maxColumns ?? 5);
  if (!chunks.length) chunks.push([]);

  return {
    screen: `<div class="report-matrix-scroll" tabindex="0" role="region" aria-label="${escapeHtml(labels.matrix)}">${screenTable}</div>`,
    print: `<div class="print-matrices">${chunks.map(chunk => matrixTable(aggregation || {}, chunk, 'print-matrix', options)).join('')}</div>`
  };
}
