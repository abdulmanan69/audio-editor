// Entry point: boot the app, route keyboard shortcuts and file drops, wire up the PWA.
import { App } from './app.js';
import { eventCombo } from './commands.js';
import { hydrateIcons } from './ui/icons.js';
import { isTypingTarget, $ } from './ui/dom.js';
import { dialogOpen } from './ui/dialog.js';
import { menuOpen } from './ui/menu.js';
import { toast } from './ui/toast.js';

const app = new App();
window.kerf = app; // handy for debugging from the console

hydrateIcons();
drawEmptyWave();

app.start().then(() => {
  bindKeys();
  bindDrops();
  handleLaunch();
}).catch(err => {
  console.error(err);
  toast(`Kerf failed to start: ${err.message}`, { type: 'error', duration: 0 });
});

registerServiceWorker();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  app.installPrompt = e;
  app.updateToolbar();
});
window.addEventListener('appinstalled', () => {
  app.installPrompt = null;
  app.updateToolbar();
  toast('Kerf is installed. Open it from your apps like any desktop program.');
});
window.addEventListener('beforeunload', (e) => {
  if (app.recording || (app.dirty && !app.settings.get('autosave') && app.tracks.length)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Commands that stay available while typing in a field.
const GLOBAL_WHILE_TYPING = new Set(['Mod+K', 'Mod+S', 'Mod+O', 'Mod+E']);

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (dialogOpen() || menuOpen() || document.querySelector('.palette')) return;
    const combo = eventCombo(e);
    if (isTypingTarget(e.target) && !GLOBAL_WHILE_TYPING.has(combo)) return;
    // Let the browser copy text the user has highlighted outside the editor.
    if (/^Mod\+[CX]$/.test(combo) && String(window.getSelection())) return;
    const cmd = app.commands.keyMap.get(combo);
    if (!cmd) return;
    // Sliders keep their arrow keys; checkboxes keep Space.
    const type = e.target.type;
    if (type === 'range' && /Arrow|Home|End/.test(combo)) return;
    if ((type === 'checkbox' || type === 'radio') && combo === 'Space') return;
    e.preventDefault();
    app.run(cmd.id);
  });
}

function bindDrops() {
  const veil = $('#drop-veil');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || dialogOpen()) return;
    depth++;
    veil.hidden = false;
  });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    if (dialogOpen()) return;
    app.importFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    if (isTypingTarget(e.target)) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); app.importFiles(files); }
  });
}

async function handleLaunch() {
  // Files opened through the installed app's file handler.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map(h => h.getFile()));
      app.importFiles(files);
    });
  }
  const url = new URL(location.href);
  // Files shared to the app (Android share sheet) are parked in a cache by the service worker.
  if (url.searchParams.has('share-target') && 'caches' in window) {
    try {
      const cache = await caches.open('kerf-share');
      const keys = await cache.keys();
      const files = [];
      for (const req of keys) {
        const res = await cache.match(req);
        const name = decodeURIComponent(res.headers.get('x-name') || 'shared-audio');
        files.push(new File([await res.blob()], name, { type: res.headers.get('content-type') || '' }));
        await cache.delete(req);
      }
      if (files.length) app.importFiles(files);
    } catch (err) { console.warn('Share target failed', err); }
  }
  const action = url.searchParams.get('action');
  if (action === 'record') toast('Ready to record.', { action: () => app.toggleRecord(), actionLabel: 'Start recording', duration: 0 });
  if (action === 'batch') app.openBatch();
  if (action === 'import') toast('Choose audio to open.', { action: () => app.importDialog(), actionLabel: 'Open audio', duration: 0 });
  if (url.search) history.replaceState(null, '', url.pathname);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // On a local dev server, skip offline caching so edits show up on reload (add ?sw to test it).
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  try { if (new URLSearchParams(location.search).has('sw')) sessionStorage.setItem('kerf.sw', '1'); } catch { /* storage blocked */ }
  let optedIn = false;
  try { optedIn = sessionStorage.getItem('kerf.sw') === '1'; } catch { /* storage blocked */ }
  if (local && !optedIn) {
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
    return;
  }
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
      const offerUpdate = (worker) => {
        toast('A new version of Kerf is ready.', {
          actionLabel: 'Reload', duration: 0,
          action: () => worker.postMessage('SKIP_WAITING'),
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading || app.recording) return;
        reloading = true;
        location.reload();
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    } catch (err) {
      console.warn('Service worker registration failed', err);
    }
  });
}

// Decorative waveform in the empty state, traced in once on load.
function drawEmptyWave() {
  const path = $('#empty-wave-path');
  if (!path) return;
  let d = '';
  const n = 300;
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * 600;
    const env = Math.sin((i / n) * Math.PI) ** 0.6;
    const y = 45 + env * 34 * (0.55 * Math.sin(i * 0.37) + 0.3 * Math.sin(i * 1.13 + 1) + 0.15 * Math.sin(i * 2.9));
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  path.setAttribute('d', d);
}
