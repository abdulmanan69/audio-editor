import { h } from './dom.js';
import { icon } from './icons.js';

const host = () => document.getElementById('toasts');

// toast('Saved') · toast('Update ready', { action: reload, actionLabel: 'Reload', duration: 0 })
export function toast(message, { type = 'info', action, actionLabel = 'Undo', duration = 4200 } = {}) {
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  const el = h('div.toast', { class: type, role: type === 'error' ? 'alert' : 'status' },
    h('div.t-msg', message),
    action ? h('button.btn.btn-sm', { onclick: () => { close(); action(); } }, actionLabel) : null,
    h('button.icon-btn.icon-btn-sm', { 'aria-label': 'Dismiss', onclick: close, html: icon('x') }),
  );
  host().append(el);
  while (host().children.length > 4) host().firstChild.remove();
  if (duration) setTimeout(close, duration);
  return close;
}

export const toastError = (err) => {
  console.error(err);
  return toast(err?.message || String(err), { type: 'error', duration: 8000 });
};
