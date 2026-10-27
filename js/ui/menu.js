// Menu bar, dropdowns and context menus with keyboard navigation and submenus.
import { h, clear } from './dom.js';
import { icon } from './icons.js';

let openMenus = [];
let outsideHandler = null;

function closeAll() {
  openMenus.forEach(m => m.el.remove());
  openMenus = [];
  document.querySelectorAll('.menu-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  if (outsideHandler) {
    document.removeEventListener('pointerdown', outsideHandler, true);
    document.removeEventListener('keydown', keyHandler, true);
    window.removeEventListener('blur', closeAll);
    outsideHandler = null;
  }
}

function keyHandler(e) {
  const top = openMenus[openMenus.length - 1];
  if (!top) return;
  const items = [...top.el.querySelectorAll('.menu-item:not(:disabled)')];
  const idx = items.indexOf(document.activeElement);
  const move = (d) => { e.preventDefault(); const n = items[(idx + d + items.length) % items.length]; n?.focus(); };
  if (e.key === 'ArrowDown') move(1);
  else if (e.key === 'ArrowUp') move(-1);
  else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
  else if (e.key === 'ArrowRight') {
    const it = document.activeElement;
    if (it?.dataset.sub) { e.preventDefault(); it.click(); }
    else if (openMenus.length === 1 && top.bar) { e.preventDefault(); top.bar.step(1); }
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (openMenus.length > 1) { const m = openMenus.pop(); m.el.remove(); m.parentItem?.focus(); }
    else if (top.bar) top.bar.step(-1);
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    const anchor = openMenus[0]?.anchor;
    closeAll();
    anchor?.focus();
  } else if (e.key === 'Tab') closeAll();
}

// items: [{ label, icon, shortcut, disabled, checked, action, submenu: () => items, separator, heading }]
export function showMenu(items, { x, y, anchor, bar, level = 0, parentItem, focusFirst = true } = {}) {
  while (openMenus.length > level) openMenus.pop().el.remove();
  const el = h('div.menu', { role: 'menu' });
  const resolved = typeof items === 'function' ? items() : items;
  for (const it of resolved) {
    if (!it) continue;
    if (it.separator) { el.append(h('div.menu-sep', { role: 'separator' })); continue; }
    if (it.heading) { el.append(h('div.menu-heading', it.heading)); continue; }
    const b = h('button.menu-item', {
      role: 'menuitem', type: 'button', disabled: !!it.disabled,
      class: it.checked ? 'checked' : '',
      html: `${icon(it.checked ? 'check' : (it.icon || 'none'), it.icon || it.checked ? '' : 'ico-blank')}<span class="mi-label"></span>${it.shortcut ? `<span class="mi-key">${it.shortcut}</span>` : ''}${it.submenu ? icon('chevron-right', 'mi-arrow') : ''}`,
    });
    b.querySelector('.mi-label').textContent = it.label;
    if (!it.icon && !it.checked) b.querySelector('svg.ico').style.visibility = 'hidden';
    if (it.submenu) {
      b.dataset.sub = '1';
      const openSub = () => {
        const r = b.getBoundingClientRect();
        showMenu(it.submenu, { x: r.right - 2, y: r.top - 5, level: level + 1, parentItem: b, focusFirst: false });
      };
      b.addEventListener('click', () => { openSub(); openMenus[openMenus.length - 1]?.el.querySelector('.menu-item:not(:disabled)')?.focus(); });
      b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') openSub(); });
    } else {
      b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') while (openMenus.length > level + 1) openMenus.pop().el.remove(); });
      b.addEventListener('click', () => { closeAll(); it.action?.(); });
    }
    el.append(b);
  }
  document.getElementById('menu-layer').append(el);
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y;
  if (left + r.width > vw - 6) left = level > 0 ? Math.max(6, x - r.width - (parentItem?.offsetWidth || 0)) : vw - r.width - 6;
  if (top + r.height > vh - 6) top = Math.max(6, vh - r.height - 6);
  el.style.left = `${Math.max(6, left)}px`;
  el.style.top = `${top}px`;
  openMenus.push({ el, anchor, bar, parentItem });
  if (!outsideHandler) {
    outsideHandler = (e) => {
      if (openMenus.some(m => m.el.contains(e.target))) return;
      if (e.target.closest?.('.menu-btn') && bar) return;
      closeAll();
    };
    setTimeout(() => {
      document.addEventListener('pointerdown', outsideHandler, true);
      document.addEventListener('keydown', keyHandler, true);
      window.addEventListener('blur', closeAll);
    });
  }
  if (focusFirst) requestAnimationFrame(() => el.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true }));
  return el;
}

export const closeMenus = closeAll;
export const menuOpen = () => openMenus.length > 0;

export class MenuBar {
  constructor(container, menus) {
    this.container = container;
    this.menus = menus;
    this.buttons = [];
    clear(container);
    menus.forEach((m, i) => {
      const b = h('button.menu-btn', { type: 'button', role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, m.label);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (b.getAttribute('aria-expanded') === 'true') closeAll(); else this.open(i, e.pointerType !== 'mouse');
      });
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); this.open(i, true); } });
      b.addEventListener('pointerenter', () => { if (menuOpen() && this.current != null && this.current !== i) this.open(i, false); });
      this.buttons.push(b);
      container.append(b);
    });
  }
  open(i, focus = true) {
    closeAll();
    this.current = i;
    const b = this.buttons[i];
    b.setAttribute('aria-expanded', 'true');
    const r = b.getBoundingClientRect();
    showMenu(this.menus[i].items, { x: r.left, y: r.bottom + 2, anchor: b, bar: this, focusFirst: focus });
  }
  step(d) { this.open((this.current + d + this.menus.length) % this.menus.length, true); }
}
