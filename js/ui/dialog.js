// Modal dialogs and the parameter-form builder shared by effects, generators and settings.
import { h, $$ } from './dom.js';
import { icon } from './icons.js';
import { formatHz } from '../core/format.js';

const stack = [];

export function openDialog({ title, subtitle, content, actions = [], size = '', onClose, dismissable = true, footerStart } = {}) {
  const prevFocus = document.activeElement;
  const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
  let closed = false;
  const close = (reason) => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    stack.splice(stack.indexOf(api), 1);
    document.removeEventListener('keydown', onKey, true);
    onClose?.(reason);
    if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
  };
  const body = h('div.dialog-body', content);
  const foot = h('div.dialog-foot', footerStart, h('div.spacer'));
  const buttons = {};
  for (const a of actions) {
    const b = h(`button.btn${a.kind ? '.btn-' + a.kind : ''}`, {
      type: 'button',
      onclick: async () => {
        if (a.onClick) {
          const r = await a.onClick(api);
          if (r === false) return;
        }
        if (a.closes !== false) close(a.id || 'action');
      },
      html: (a.icon ? icon(a.icon) : '') + `<span>${a.label}</span>`,
    });
    if (a.id) buttons[a.id] = b;
    foot.append(b);
  }
  const dialog = h(`div.dialog${size ? '.' + size : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div.dialog-head',
      h('div', h('h2.dialog-title', { id: titleId }, title), subtitle ? h('p.dialog-sub', subtitle) : null),
      dismissable ? h('button.icon-btn', { 'aria-label': 'Close', onclick: () => close('cancel'), html: icon('x') }) : null),
    body,
    actions.length || footerStart ? foot : null,
  );
  const backdrop = h('div.dialog-backdrop', dialog);
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop && dismissable) close('cancel'); });

  const onKey = (e) => {
    if (stack[stack.length - 1] !== api) return;
    if (e.key === 'Escape' && dismissable) { e.preventDefault(); e.stopPropagation(); close('cancel'); }
    if (e.key === 'Tab') {
      const f = $$('button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])', dialog).filter(x => x.offsetParent);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.getElementById('dialog-layer').append(backdrop);
  const api = { el: dialog, body, foot, buttons, close, get closed() { return closed; } };
  stack.push(api);
  requestAnimationFrame(() => {
    const target = dialog.querySelector('[autofocus]') || dialog.querySelector('.dialog-body input:not([type=range]), .dialog-body select, .dialog-body button') || foot.querySelector('.btn-accent') || dialog.querySelector('button');
    target?.focus({ preventScroll: true });
  });
  return api;
}

export const dialogOpen = () => stack.length > 0;

export function confirmDialog({ title, message, confirmLabel = 'Continue', danger = false }) {
  return new Promise(resolve => {
    let ok = false;
    openDialog({
      title, content: h('p', { style: { margin: 0, color: 'var(--text-dim)' } }, message),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: confirmLabel, kind: danger ? 'danger' : 'accent', onClick: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

export function promptDialog({ title, label, value = '', confirmLabel = 'Save', placeholder = '' }) {
  return new Promise(resolve => {
    let result = null;
    const input = h('input.text-input', { value, placeholder, autofocus: true, 'aria-label': label });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { result = input.value; d.close('ok'); } });
    const d = openDialog({
      title,
      content: h('label.field', h('span.field-label', label), input),
      actions: [{ label: 'Cancel', kind: 'ghost' }, { label: confirmLabel, kind: 'accent', onClick: () => { result = input.value; } }],
      onClose: () => resolve(result),
    });
    requestAnimationFrame(() => input.select());
  });
}

// ---------- Parameter forms ----------
const decimals = (step) => (step >= 1 ? 0 : Math.min(4, String(step).split('.')[1]?.length || 2));
const SLIDER_RES = 1000;

function toSlider(p, v) {
  if (p.scale === 'log') return Math.round((Math.log(v / p.min) / Math.log(p.max / p.min)) * SLIDER_RES);
  return v;
}
function fromSlider(p, s) {
  if (p.scale === 'log') return p.min * Math.pow(p.max / p.min, s / SLIDER_RES);
  return s;
}
const snap = (p, v) => {
  const step = p.step || 0.01;
  const r = Math.round(v / step) * step;
  return +Math.min(p.max, Math.max(p.min, r)).toFixed(decimals(step));
};

export function buildForm(params, values, { onChange, layout } = {}) {
  const form = h('div.form');
  const fields = [];
  const emit = () => { refresh(); onChange?.(values); };

  const numberField = (p) => {
    const d = decimals(p.step || 0.01);
    const range = h('input', { type: 'range', min: p.scale === 'log' ? 0 : p.min, max: p.scale === 'log' ? SLIDER_RES : p.max, step: p.scale === 'log' ? 1 : (p.step || 0.01), 'aria-label': p.label });
    const numIn = h('input.num-input', { type: 'number', min: p.min, max: p.max, step: p.step || 0.01, class: p.unit ? 'has-unit' : '', 'aria-label': `${p.label} value` });
    const set = (v, src) => {
      values[p.id] = v;
      if (src !== range) range.value = toSlider(p, v);
      if (src !== numIn) numIn.value = (+v).toFixed(d);
    };
    set(values[p.id] ?? p.default);
    range.addEventListener('input', () => { set(snap(p, fromSlider(p, +range.value)), range); emit(); });
    numIn.addEventListener('change', () => {
      const v = parseFloat(numIn.value);
      set(isFinite(v) ? snap(p, v) : p.default);
      emit();
    });
    const el = h('div.field',
      h('div.field-label', h('span', p.label), p.scale === 'log' && p.unit === 'Hz' ? h('span.field-help', `${formatHz(p.min)}–${formatHz(p.max)} Hz`) : null),
      h('div.field-row', range, h('div.num-wrap', numIn, p.unit ? h('span.unit', p.unit) : null)),
      p.help ? h('div.field-help', p.help) : null);
    return { el, sync: () => set(values[p.id]) };
  };

  const selectField = (p) => {
    const s = h('select.select', { 'aria-label': p.label }, p.options.map(([v, l]) => h('option', { value: v }, l)));
    s.value = String(values[p.id] ?? p.default);
    s.addEventListener('change', () => { values[p.id] = s.value; emit(); });
    return { el: h('label.field', h('span.field-label', p.label), s, p.help ? h('div.field-help', p.help) : null), sync: () => { s.value = String(values[p.id]); } };
  };

  const boolField = (p) => {
    const c = h('input', { type: 'checkbox', checked: !!(values[p.id] ?? p.default) });
    c.addEventListener('change', () => { values[p.id] = c.checked; emit(); });
    return { el: h('label.check', c, h('span', p.label)), sync: () => { c.checked = !!values[p.id]; } };
  };

  const textField = (p) => {
    const t = h(p.multiline ? 'textarea.text-input' : 'input.text-input', { value: values[p.id] ?? p.default, placeholder: p.placeholder || '', 'aria-label': p.label, rows: 3 });
    if (p.multiline) t.value = values[p.id] ?? p.default;
    t.addEventListener('input', () => { values[p.id] = t.value; onChange?.(values); });
    return { el: h('label.field', h('span.field-label', p.label), t, p.help ? h('div.field-help', p.help) : null), sync: () => { t.value = values[p.id]; } };
  };

  let geq = null;
  for (const p of params) {
    if (values[p.id] === undefined) values[p.id] = p.default;
    if (layout === 'geq' && /^b\d+$/.test(p.id)) {
      if (!geq) { geq = h('div.geq'); form.append(geq); }
      const out = h('span.geq-val');
      const r = h('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: values[p.id], 'aria-label': `${p.label} Hz band` });
      const show = () => { out.textContent = (values[p.id] > 0 ? '+' : '') + (+values[p.id]).toFixed(1); };
      r.addEventListener('input', () => { values[p.id] = +r.value; show(); onChange?.(values); });
      r.addEventListener('dblclick', () => { values[p.id] = 0; r.value = 0; show(); onChange?.(values); });
      show();
      geq.append(h('div.geq-band', out, r, h('span.geq-freq', p.label)));
      fields.push({ p, sync: () => { r.value = values[p.id]; show(); }, el: null });
      continue;
    }
    const f = p.type === 'number' ? numberField(p) : p.type === 'select' ? selectField(p) : p.type === 'bool' ? boolField(p) : textField(p);
    fields.push({ p, ...f });
    form.append(f.el);
  }

  function refresh() {
    for (const f of fields) if (f.el && f.p.showIf) f.el.hidden = !f.p.showIf(values);
  }
  refresh();

  return {
    el: form,
    values,
    setValues(v) {
      Object.assign(values, v);
      for (const f of fields) f.sync();
      refresh();
      onChange?.(values);
    },
  };
}
