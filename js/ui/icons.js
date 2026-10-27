// Hand-drawn 24px stroke icon set. `.f` paths are filled.
const P = {
  play: '<path class="f" d="M7 4.5v15l12.5-7.5z"/>',
  pause: '<rect class="f" x="6" y="4.5" width="4" height="15" rx="1"/><rect class="f" x="14" y="4.5" width="4" height="15" rx="1"/>',
  stop: '<rect class="f" x="6" y="6" width="12" height="12" rx="1.5"/>',
  record: '<circle class="f" cx="12" cy="12" r="6.5"/>',
  'skip-back': '<path d="M6 5v14"/><path class="f" d="M19 5v14L9 12z"/>',
  'skip-forward': '<path d="M18 5v14"/><path class="f" d="M5 5v14l10-7z"/>',
  repeat: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  paste: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  split: '<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  mute: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  beep: '<rect x="2.5" y="6" width="19" height="12" rx="3"/><path d="M6 12c1.5-4 3-4 4.5 0s3 4 4.5 0 2.5-3 3-1"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M11 8v6M8 11h6"/>',
  'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/>',
  'zoom-sel': '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>',
  wave: '<path d="M2 12h1.5M6 8v8M10 4v16M14 7v10M18 10v4M21.5 12H22"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path class="f" d="M12 3a9 9 0 0 1 0 18z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  region: '<path d="M4 4v16M20 4v16"/><rect x="7" y="8" width="10" height="8" rx="1"/>',
  activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  more: '<circle class="f" cx="5" cy="12" r="1.7"/><circle class="f" cx="12" cy="12" r="1.7"/><circle class="f" cx="19" cy="12" r="1.7"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8M7 21v-7h10v7"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  'file-plus': '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  wand: '<path d="M15 4V2M15 10V8M11 6h2M17 6h2"/><path d="M3 21l11-11"/><path d="M18.5 13.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/>',
  'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  mono: '<circle cx="12" cy="12" r="6"/>',
  widen: '<circle cx="8.5" cy="12" r="5.5"/><circle cx="15.5" cy="12" r="5.5"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/>',
  'fade-in': '<path d="M3 20L21 4v16z"/>',
  'fade-out': '<path d="M3 4l18 16H3z"/>',
  normalize: '<path d="M4 4h16M4 20h16"/><path d="M8 16V8M12 18V6M16 14v-4"/>',
  loudness: '<path d="M4 18v-5M8 18V9M12 18V5M16 18v-8M20 18v-4"/>',
  compress: '<path d="M4 9h16M4 15h16"/><path d="M12 2v4M10 4l2 2 2-2M12 22v-4M10 20l2-2 2 2"/>',
  limit: '<path d="M3 5h18"/><path d="M3 17l3-9h4l2 9 2-9h4l3 9"/>',
  gate: '<path d="M4 20V10M20 20V10M4 10h16M9 20v-6h6v6"/>',
  deess: '<path d="M16 7a4 4 0 0 0-8 0c0 4 8 4 8 9a4 4 0 0 1-8 0"/><path d="M3 3l18 18"/>',
  eq: '<path d="M6 4v16M12 4v16M18 4v16"/><rect class="f" x="4" y="13" width="4" height="3" rx="1"/><rect class="f" x="10" y="7" width="4" height="3" rx="1"/><rect class="f" x="16" y="11" width="4" height="3" rx="1"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  highpass: '<path d="M3 19c4 0 5-12 9-12h9"/>',
  lowpass: '<path d="M3 7h9c4 0 5 12 9 12"/>',
  tone: '<circle cx="12" cy="12" r="8"/><path d="M12 12l4-4"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  tempo: '<path d="M8 21l3-18h2l3 18z"/><path d="M12 15l5-7"/>',
  metronome: '<path d="M8 21l3-18h2l3 18z"/><path d="M12 15l5-7"/>',
  pitch: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  reverse: '<path d="M20 12H4M9 7l-5 5 5 5"/>',
  echo: '<circle cx="5" cy="12" r="2"/><path d="M10 8a6 6 0 0 1 0 8M14 5a10 10 0 0 1 0 14M18 3a13 13 0 0 1 0 18"/>',
  reverb: '<path d="M3 21V9l9-6 9 6v12"/><path d="M8 21v-6h8v6"/>',
  chorus: '<path d="M2 10c3-4 5-4 8 0s5 4 8 0 3-3 4-2"/><path d="M2 15c3-4 5-4 8 0s5 4 8 0 3-3 4-2"/>',
  flanger: '<path d="M2 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0"/><path d="M2 12h20" stroke-dasharray="1 3"/>',
  phaser: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18M12 7a5 5 0 0 1 0 10"/>',
  vibrato: '<path d="M2 12c1-3 2-3 3 0s2 3 3 0 2-3 3 0 2 3 3 0 2-3 3 0 2 3 3 0"/>',
  tremolo: '<path d="M2 12h2M6 9v6M10 6v12M14 9v6M18 6v12M22 12h0"/>',
  pan: '<path d="M2 12h20M6 8l-4 4 4 4M18 8l4 4-4 4"/>',
  robot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 4h6"/><circle class="f" cx="9" cy="14" r="1.5"/><circle class="f" cx="15" cy="14" r="1.5"/>',
  distort: '<path d="M2 12h3l2-7h4l2 14h4l2-7h3"/>',
  bits: '<path d="M3 19h4v-4h4v-4h4V7h4V3"/>',
  invert: '<path d="M2 12c3-8 7-8 10 0"/><path d="M12 12c3 8 7 8 10 0" stroke-dasharray="2 2"/>',
  denoise: '<path d="M2 12h2l1-3 1 6 1-4 1 2h2"/><path d="M12 12c2-6 4-6 6 0"/><path d="M18 12h4"/>',
  declick: '<path d="M2 15h7l1.5-10L12 15h10"/><path d="M8 20h8"/>',
  hum: '<path d="M2 12c2-4 3-4 5 0s3 4 5 0 3-4 5 0 3 4 5 0"/><path d="M4 4l16 16"/>',
  dc: '<path d="M3 12h18" stroke-dasharray="2 2"/><path d="M3 8c3-4 6-4 9 0s6 4 9 0"/>',
  'silence-cut': '<path d="M3 12h4M17 12h4"/><path d="M9 7l6 10M15 7l-6 10"/>',
  karaoke: '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 11.9 5M12 17v5"/><path d="M3 3l18 18"/>',
  noise: '<path d="M2 12l1-4 1 7 1-9 1 8 1-5 1 6 1-3 1 4 1-7 1 6 1-4 1 5 1-8 1 7 1-3 1 2 1-1"/>',
  chirp: '<path d="M2 12c2-7 4-7 5 0s3 7 4 0 2-6 3 0 1.5 5 2 0 1-4 1.5 0 .8 3 1.2 0 .6-2 1-1"/>',
  morse: '<circle class="f" cx="4" cy="12" r="1.6"/><path d="M8 12h5"/><circle class="f" cx="17" cy="12" r="1.6"/><path d="M20.5 12h1.5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  palette: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10l3 2-3 2M13 15h3"/>',
  storage: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle class="f" cx="12" cy="12" r="1.5"/>',
};

export function icon(name, extraClass = '') {
  const body = P[name] || P.sparkle;
  return `<svg class="ico ${extraClass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

// Replace every [data-icon] placeholder under `root` with its SVG.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (el.tagName === 'SPAN' && !el.children.length) {
      el.outerHTML = icon(name);
    } else if (!el.querySelector(':scope > svg.ico')) {
      el.insertAdjacentHTML('afterbegin', icon(name));
    }
  });
}

export function setIcon(el, name) {
  const svg = el.querySelector(':scope > svg.ico');
  const html = icon(name);
  if (svg) svg.outerHTML = html; else el.insertAdjacentHTML('afterbegin', html);
  el.dataset.icon = name;
}
