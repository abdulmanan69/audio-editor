// Side panel tabs: effect browser, markers, undo history and analysis.
import { h, $, $$, clear } from './dom.js';
import { icon } from './icons.js';
import { EFFECTS, EFFECT_CATEGORIES } from '../dsp/effects.js';
import { GENERATORS } from '../dsp/generators.js';
import { local } from '../core/settings.js';
import { SpectrumView } from './meters.js';
import { channelStats } from '../dsp/analysis.js';
import { measureLoudness, truePeak } from '../dsp/loudness.js';
import { formatDb, formatDuration, gainToDb } from '../core/format.js';

export class SidePanel {
  constructor(app) {
    this.app = app;
    this.tabs = $$('#side-tabs .tab');
    this.spectrum = new SpectrumView($('#spectrum'));
    this.tabs.forEach(t => t.addEventListener('click', () => this.showTab(t.dataset.tab)));
    $('#side-tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.stopPropagation();
      const i = this.tabs.findIndex(t => t.dataset.tab === this.tab);
      const n = this.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + this.tabs.length) % this.tabs.length];
      this.showTab(n.dataset.tab);
      n.focus();
    });
    const closeBtn = h('button.icon-btn.icon-btn-sm', { 'aria-label': 'Close panel', html: icon('x'), onclick: () => app.togglePanel() });
    $('#side-tabs').append(closeBtn);
    this.search = $('#fx-search');
    this.search.addEventListener('input', () => this.renderEffects());
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') $('#fx-list .fx-item')?.click();
      if (e.key === 'Escape') { this.search.value = ''; this.renderEffects(); this.search.blur(); }
    });
    this.showTab(local.get('sideTab', 'effects'));
    this.renderEffects();
    this.renderMarkers();
    this.renderHistory();
  }

  showTab(name) {
    this.tab = name;
    this.tabs.forEach(t => { const on = t.dataset.tab === name; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    $$('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== name; });
    local.set('sideTab', name);
    if (name === 'analyze') { this.updateQuickStats(); this.app.startLoop?.(); requestAnimationFrame(() => this.drawSpectrum(null, this.app.sampleRate)); }
    if (name === 'history') this.scrollHistory();
  }

  get analyzeVisible() { return this.tab === 'analyze' && !!$('#spectrum').offsetParent; }

  renderEffects() {
    const list = $('#fx-list');
    clear(list);
    const q = this.search.value.trim().toLowerCase();
    const match = (name, extra = '') => !q || `${name} ${extra}`.toLowerCase().includes(q);
    const item = (ic, name, hint, onclick, title) => h('button.fx-item', { type: 'button', onclick, title: title || '', html: icon(ic) }, h('span.fx-name', name), hint ? h('span.fx-hint', hint) : null);
    const group = (title, items) => { if (items.length) list.append(h('div.fx-group', h('div.fx-group-title', title), items)); };

    if (!q) {
      const recent = local.get('recentFx', []).map(id => EFFECTS.find(e => e.id === id)).filter(Boolean);
      group('Recently used', recent.map(e => item(e.icon, e.name, e.params.length ? '' : 'instant', () => this.app.openEffect(e.id), e.description)));
    }
    for (const cat of EFFECT_CATEGORIES) {
      group(cat, EFFECTS.filter(e => e.category === cat && match(e.name, `${cat} ${e.description}`))
        .map(e => item(e.icon, e.name, e.params.length ? '' : 'instant', () => this.app.openEffect(e.id), e.description)));
    }
    group('Generate', GENERATORS.filter(g => match(g.name, `generate ${g.description}`)).map(g => item(g.icon, g.name, '', () => this.app.openGenerator(g.id), g.description)));
    const tools = [
      ['denoise', 'Capture noise profile', 'fx.captureNoise', 'noise profile sample'],
      ['link', 'Apply effect chain', 'fx.chain', 'chain macro'],
      ['layers', 'Batch processor', 'file.batch', 'batch convert'],
    ].filter(([, n, , k]) => match(n, k));
    group('Tools', tools.map(([ic, n, cmd]) => item(ic, n, '', () => this.app.run(cmd))));
    if (!list.children.length) list.append(h('div.list-empty', `Nothing matches “${this.search.value}”. Try “noise”, “fade” or “EQ”.`));
  }

  renderMarkers() {
    const app = this.app;
    const list = $('#marker-list');
    clear(list);
    if (!app.markers.length) {
      list.append(h('li.list-empty', h('div', 'No markers yet.'), h('div', 'Press M to drop one at the playhead, or Shift+M to label a selection.')));
      return;
    }
    for (const m of app.markers) {
      const name = h('input.marker-name', { value: m.name, 'aria-label': 'Marker name', spellcheck: false });
      name.addEventListener('change', () => app.updateMarker(m.id, { name: name.value }));
      name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') name.blur(); });
      const time = h('button.marker-time', { type: 'button', title: m.end != null ? 'Select region' : 'Go to marker', onclick: () => app.focusMarker(m) },
        m.end != null ? `${app.fmt(m.time)} – ${app.fmt(m.end)}` : app.fmt(m.time));
      list.append(h('li.marker-item', { class: m.end != null ? 'region' : '' },
        h('span.marker-swatch'), name,
        h('div.marker-actions', h('button.icon-btn.icon-btn-sm', { 'aria-label': `Delete ${m.name}`, title: 'Delete', html: icon('trash'), onclick: () => app.deleteMarker(m.id) })),
        time));
    }
  }

  renderHistory() {
    const hist = this.app.history;
    const list = $('#history-list');
    clear(list);
    hist.entries.forEach((e, i) => {
      const cls = i === hist.index ? 'current' : i > hist.index ? 'future' : '';
      list.append(h('li', h('button.history-item', { type: 'button', class: cls, onclick: () => this.app.historyJump(i), 'aria-current': i === hist.index ? 'step' : null },
        h('span.h-dot'), h('span', e.label), h('span.h-time', new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))));
    });
    this.scrollHistory();
  }

  scrollHistory() {
    requestAnimationFrame(() => $('#history-list .current')?.scrollIntoView({ block: 'nearest' }));
  }

  updateQuickStats() {
    if (this.tab !== 'analyze') return;
    const dl = $('#quick-stats');
    const src = $('#quick-stats-src');
    clear(dl);
    const sum = this.app.selectionSummary();
    if (!sum || !sum.audio.length) {
      src.textContent = '—';
      dl.append(h('dt', 'Nothing selected'), h('dd', ''));
      return;
    }
    const { audio, track, whole } = sum;
    src.textContent = `${track.name} · ${whole ? 'whole track' : 'selection'}`;
    const stats = channelStats(audio);
    const peak = Math.max(...stats.map(s => s.peak));
    const rms = Math.sqrt(stats.reduce((a, s) => a + s.rms * s.rms, 0) / stats.length);
    const clipped = stats.reduce((a, s) => a + s.clipped, 0);
    const rows = [
      ['Length', formatDuration(audio.duration)],
      ['Peak', `${formatDb(gainToDb(peak))} dBFS`],
      ['RMS', `${formatDb(gainToDb(rms))} dB`],
    ];
    if (audio.duration >= 0.4 && audio.duration <= 1200) {
      const l = measureLoudness(audio);
      rows.push(['Integrated', isFinite(l.integrated) ? `${l.integrated.toFixed(1)} LUFS` : '—']);
    }
    if (audio.duration <= 600) rows.push(['True peak', `${formatDb(gainToDb(truePeak(audio)))} dBTP`]);
    rows.push(['Clipped samples', String(clipped)]);
    for (const [k, v] of rows) dl.append(h('dt', k), h('dd', v));
  }

  drawSpectrum(data, sr) { this.spectrum.draw(data, sr); $('#spectrum-src').textContent = data ? 'live output' : 'press play'; }
}
