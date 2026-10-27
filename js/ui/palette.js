// Command palette: fuzzy search across every command, effect and generator.
import { h, clear } from './dom.js';
import { icon } from './icons.js';

function score(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase(), t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 || t[idx - 1] === ' ' ? 20 : 0);
  let ti = 0, s = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return 0;
    s += f === ti ? 3 : 1;
    ti = f + 1;
  }
  return s;
}

function highlight(label, query) {
  const span = h('span');
  const i = query ? label.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (i < 0) { span.textContent = label; return span; }
  span.append(label.slice(0, i), h('mark', label.slice(i, i + query.length)), label.slice(i + query.length));
  return span;
}

export function openPalette(getCommands, run) {
  if (document.querySelector('.palette')) return;
  const input = h('input', { type: 'text', placeholder: 'Type a command, effect or tool…', 'aria-label': 'Search commands', autocomplete: 'off', spellcheck: false });
  const list = h('div.palette-list', { role: 'listbox' });
  const backdrop = h('div.palette-backdrop');
  const box = h('div.palette', { role: 'dialog', 'aria-label': 'Command palette' }, h('div.palette-input', { html: icon('search') }, input), list);
  let active = 0, shown = [];
  const prevFocus = document.activeElement;
  const close = () => { box.remove(); backdrop.remove(); prevFocus?.focus?.({ preventScroll: true }); };

  const render = () => {
    const q = input.value.trim();
    shown = getCommands()
      .filter(c => c.label && !c.hidden)
      .map(c => ({ c, s: Math.max(score(q, c.label), score(q, `${c.category} ${c.label}`) * 0.6, c.keywords && q && c.keywords.toLowerCase().includes(q.toLowerCase()) ? 30 : 0) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map(x => x.c);
    active = Math.min(active, Math.max(0, shown.length - 1));
    clear(list);
    if (!shown.length) list.append(h('div.list-empty', `No command matches “${q}”.`));
    shown.forEach((c, i) => {
      const enabled = c.enabled ? c.enabled() : true;
      const row = h('div.palette-item', { role: 'option', 'aria-selected': i === active ? 'true' : 'false', class: `${i === active ? 'active' : ''} ${enabled ? '' : 'disabled'}`, html: icon(c.icon || 'sparkle') },
        highlight(c.label, q), h('span.pi-cat', c.category || ''), h('span.pi-key', c.shortcut || ''));
      row.addEventListener('pointerdown', (e) => { e.preventDefault(); pick(i); });
      row.addEventListener('pointermove', () => { if (active !== i) { active = i; mark(); } });
      list.append(row);
    });
  };
  const mark = () => [...list.children].forEach((el, i) => { el.classList.toggle('active', i === active); el.setAttribute('aria-selected', i === active); });
  const pick = (i) => {
    const c = shown[i];
    if (!c || (c.enabled && !c.enabled())) return;
    close();
    run(c);
  };
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); mark(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  backdrop.addEventListener('pointerdown', close);
  document.body.append(backdrop, box);
  render();
  input.focus();
}
