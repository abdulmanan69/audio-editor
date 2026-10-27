// Label/marker interchange: Audacity-compatible TSV (start, end, label) and CSV reports.

export function toAudacityLabels(markers) {
  return markers
    .slice()
    .sort((a, b) => a.time - b.time)
    .map(m => `${m.time.toFixed(6)}\t${(m.end ?? m.time).toFixed(6)}\t${(m.name || '').replace(/[\t\r\n]+/g, ' ')}`)
    .join('\n') + '\n';
}

const csvCell = (s) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

export function toCsv(markers, fmt) {
  const rows = [['#', 'Start', 'End', 'Duration (s)', 'Label']];
  markers.slice().sort((a, b) => a.time - b.time).forEach((m, i) => {
    const end = m.end ?? m.time;
    rows.push([String(i + 1), fmt(m.time), fmt(end), (end - m.time).toFixed(3), m.name || '']);
  });
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

// Accepts Audacity TSV ("start\tend\tlabel") or CSV with the same columns (header optional).
export function parseLabels(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('\\')) continue;
    let cols = line.includes('\t') ? line.split('\t') : line.split(',');
    if (cols.length >= 4 && /^\d+$/.test(cols[0])) cols = [cols[1], cols[2], cols.slice(4).join(',')];
    const start = parseFloat(cols[0]);
    if (!isFinite(start)) continue;
    const end = parseFloat(cols[1]);
    const name = (cols.slice(2).join(line.includes('\t') ? '\t' : ',') || '').replace(/^"|"$/g, '').trim();
    out.push({ time: start, end: isFinite(end) && end > start ? end : undefined, name });
  }
  return out;
}
