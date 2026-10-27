// Command registry: one definition drives menus, the command palette, toolbar state
// and keyboard shortcuts.
import { EFFECTS, EFFECT_CATEGORIES } from './dsp/effects.js';
import { GENERATORS } from './dsp/generators.js';
import { isMac } from './core/format.js';

export function displayKey(combo) {
  return combo
    .replace('Mod+', isMac ? '⌘' : 'Ctrl+')
    .replace('Shift+', isMac ? '⇧' : 'Shift+')
    .replace('Alt+', isMac ? '⌥' : 'Alt+')
    .replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
    .replace('Delete', 'Del').replace('Escape', 'Esc');
}

// Normalise a KeyboardEvent to the same combo format used in `keys`.
export function eventCombo(e) {
  let key = e.key;
  if (key === ' ' || key === 'Spacebar') key = 'Space';
  const printable = key.length === 1;
  if (printable && /[a-z]/i.test(key)) key = key.toUpperCase();
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && (!printable || /[A-Z]/.test(key) || key === 'Space')) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function createCommands(app) {
  const has = () => app.tracks.length > 0;
  const range = () => app.hasRange;
  const list = [
    // File
    { id: 'file.new', label: 'New project', category: 'File', icon: 'file-plus', run: () => app.newProject() },
    { id: 'file.import', label: 'Import audio…', category: 'File', icon: 'folder', keys: ['Mod+O'], run: () => app.importDialog() },
    { id: 'file.openProject', label: 'Open project…', category: 'File', icon: 'file', run: () => app.openProjectDialog() },
    { id: 'file.saveProject', label: 'Save project', category: 'File', icon: 'save', keys: ['Mod+S'], enabled: has, run: () => app.saveProject() },
    { id: 'file.export', label: 'Export audio…', category: 'File', icon: 'download', keys: ['Mod+E'], enabled: has, run: () => app.openExport('mix') },
    { id: 'file.exportSel', label: 'Export selection…', category: 'File', icon: 'download', keys: ['Mod+Shift+E'], enabled: range, run: () => app.openExport('selection') },
    { id: 'file.exportTracks', label: 'Export tracks separately…', category: 'File', icon: 'layers', enabled: has, run: () => app.openExport('tracks') },
    { id: 'file.batch', label: 'Batch processor…', category: 'File', icon: 'layers', keywords: 'convert many files bulk chain', run: () => app.openBatch() },
    { id: 'file.demo', label: 'Load sample audio', category: 'File', icon: 'sparkle', run: () => app.loadDemo() },
    { id: 'app.settings', label: 'Settings…', category: 'File', icon: 'sliders', keys: ['Mod+,'], run: () => app.openSettings() },
    { id: 'app.install', label: 'Install Kerf as an app', category: 'File', icon: 'download', enabled: () => !!app.installPrompt, run: () => app.install() },

    // Edit
    { id: 'edit.undo', label: 'Undo', category: 'Edit', icon: 'undo', keys: ['Mod+Z'], enabled: () => app.history.canUndo, run: () => app.undo() },
    { id: 'edit.redo', label: 'Redo', category: 'Edit', icon: 'redo', keys: ['Mod+Shift+Z', 'Mod+Y'], enabled: () => app.history.canRedo, run: () => app.redo() },
    { id: 'edit.cut', label: 'Cut', category: 'Edit', icon: 'scissors', keys: ['Mod+X'], enabled: range, run: () => app.cut() },
    { id: 'edit.copy', label: 'Copy', category: 'Edit', icon: 'copy', keys: ['Mod+C'], enabled: range, run: () => app.copy() },
    { id: 'edit.paste', label: 'Paste', category: 'Edit', icon: 'paste', keys: ['Mod+V'], enabled: () => !!app.clipboard, run: () => app.paste() },
    { id: 'edit.delete', label: 'Delete selection', category: 'Edit', icon: 'trash', keys: ['Delete', 'Backspace'], enabled: range, run: () => app.deleteSelection() },
    { id: 'edit.trim', label: 'Trim to selection', category: 'Edit', icon: 'crop', keys: ['Mod+T'], enabled: range, keywords: 'crop keep', run: () => app.trim() },
    { id: 'edit.silence', label: 'Silence selection', category: 'Edit', icon: 'mute', keys: ['Mod+L'], enabled: range, keywords: 'mute zero', run: () => app.silenceSelection() },
    { id: 'edit.bleep', label: 'Bleep selection', category: 'Edit', icon: 'beep', keys: ['Mod+B'], enabled: has, keywords: 'beep censor profanity', run: () => app.bleep() },
    { id: 'edit.bleepOptions', label: 'Bleep options…', category: 'Edit', icon: 'beep', enabled: has, keywords: 'beep censor tone', run: () => app.openBleepOptions() },
    { id: 'edit.insertSilence', label: 'Insert silence…', category: 'Edit', icon: 'plus', enabled: has, run: () => app.openGenerator('silence') },
    { id: 'edit.duplicate', label: 'Copy selection to new track', category: 'Edit', icon: 'copy', keys: ['Mod+D'], enabled: range, run: () => app.duplicateToNewTrack() },
    { id: 'edit.split', label: 'Split selection to new track', category: 'Edit', icon: 'split', keys: ['Mod+I'], enabled: range, keywords: 'move', run: () => app.splitToNewTrack() },
    { id: 'edit.selectAll', label: 'Select all', category: 'Edit', icon: 'zoom-sel', keys: ['Mod+A'], enabled: has, run: () => app.selectAll() },
    { id: 'edit.selectNone', label: 'Select none', category: 'Edit', icon: 'x', keys: ['Mod+Shift+A'], enabled: has, run: () => app.selectNone() },
    { id: 'edit.selectToStart', label: 'Select cursor to start', category: 'Edit', keys: ['Shift+Home'], enabled: has, run: () => app.selectToStart() },
    { id: 'edit.selectToEnd', label: 'Select cursor to end', category: 'Edit', keys: ['Shift+End'], enabled: has, run: () => app.selectToEnd() },
    { id: 'edit.snapZero', label: 'Snap selection to zero crossings', category: 'Edit', icon: 'target', keys: ['Z'], enabled: has, run: () => app.snapSelectionToZero() },

    // Transport
    { id: 'transport.play', label: 'Play / pause', category: 'Transport', icon: 'play', keys: ['Space'], enabled: has, run: () => app.togglePlay() },
    { id: 'transport.stop', label: 'Stop', category: 'Transport', icon: 'stop', keys: ['Escape'], run: () => app.stopOrClear() },
    { id: 'transport.record', label: 'Record', category: 'Transport', icon: 'record', keys: ['R'], run: () => app.toggleRecord() },
    { id: 'transport.loop', label: 'Loop playback', category: 'Transport', icon: 'repeat', keys: ['L'], checked: () => app.loop, run: () => app.toggleLoop() },
    { id: 'transport.start', label: 'Go to start', category: 'Transport', icon: 'skip-back', keys: ['Home'], enabled: has, run: () => app.goStart() },
    { id: 'transport.end', label: 'Go to end', category: 'Transport', icon: 'skip-forward', keys: ['End'], enabled: has, run: () => app.goEnd() },
    { id: 'transport.back', label: 'Move cursor left', category: 'Transport', keys: ['ArrowLeft'], hidden: true, enabled: has, run: () => app.nudge(-1) },
    { id: 'transport.fwd', label: 'Move cursor right', category: 'Transport', keys: ['ArrowRight'], hidden: true, enabled: has, run: () => app.nudge(1) },
    { id: 'transport.extendBack', label: 'Extend selection left', category: 'Transport', keys: ['Shift+ArrowLeft'], hidden: true, enabled: has, run: () => app.nudge(-1, true) },
    { id: 'transport.extendFwd', label: 'Extend selection right', category: 'Transport', keys: ['Shift+ArrowRight'], hidden: true, enabled: has, run: () => app.nudge(1, true) },

    // Tracks
    { id: 'track.new', label: 'New empty track', category: 'Tracks', icon: 'plus', keys: ['Shift+N'], run: () => app.newEmptyTrack() },
    { id: 'track.duplicate', label: 'Duplicate selected tracks', category: 'Tracks', icon: 'copy', enabled: has, run: () => app.duplicateTracks() },
    { id: 'track.delete', label: 'Delete selected tracks', category: 'Tracks', icon: 'trash', enabled: () => app.tracks.some(t => t.selected), run: () => app.deleteTracks(app.tracks.filter(t => t.selected).map(t => t.id)) },
    { id: 'track.mixdown', label: 'Mix down to new track', category: 'Tracks', icon: 'layers', enabled: has, keywords: 'bounce render merge', run: () => app.mixdownToTrack() },
    { id: 'track.mono', label: 'Convert to mono', category: 'Tracks', icon: 'mono', enabled: has, run: () => app.convertChannels(1) },
    { id: 'track.stereo', label: 'Convert to stereo', category: 'Tracks', icon: 'widen', enabled: has, run: () => app.convertChannels(2) },
    { id: 'track.prev', label: 'Select previous track', category: 'Tracks', keys: ['ArrowUp'], hidden: true, enabled: has, run: () => app.stepTrack(-1) },
    { id: 'track.next', label: 'Select next track', category: 'Tracks', keys: ['ArrowDown'], hidden: true, enabled: has, run: () => app.stepTrack(1) },
    { id: 'track.muteSel', label: 'Mute / unmute selected tracks', category: 'Tracks', icon: 'mute', keys: ['U'], enabled: has, run: () => app.toggleMuteSelected() },
    { id: 'track.resample', label: 'Change project sample rate…', category: 'Tracks', icon: 'gauge', enabled: has, keywords: 'resample convert hz', run: () => app.openResample() },

    // View
    { id: 'view.zoomIn', label: 'Zoom in', category: 'View', icon: 'zoom-in', keys: ['=', '+'], enabled: has, run: () => app.zoom(2) },
    { id: 'view.zoomOut', label: 'Zoom out', category: 'View', icon: 'zoom-out', keys: ['-'], enabled: has, run: () => app.zoom(0.5) },
    { id: 'view.zoomSel', label: 'Zoom to selection', category: 'View', icon: 'zoom-sel', keys: ['E'], enabled: range, run: () => app.zoomSelection() },
    { id: 'view.zoomFit', label: 'Fit project in window', category: 'View', icon: 'fit', keys: ['F'], enabled: has, run: () => app.zoomFit() },
    { id: 'view.spectrogram', label: 'Toggle spectrogram view', category: 'View', icon: 'chart', keys: ['S'], enabled: has, run: () => app.toggleSpectrogram() },
    { id: 'view.follow', label: 'Follow playhead', category: 'View', icon: 'target', checked: () => app.settings.get('followPlayhead'), run: () => app.toggleSetting('followPlayhead') },
    { id: 'view.panel', label: 'Toggle side panel', category: 'View', icon: 'panel', keys: ['\\'], run: () => app.togglePanel() },
    { id: 'view.theme', label: 'Switch light / dark theme', category: 'View', icon: 'contrast', run: () => app.cycleTheme() },
    { id: 'view.palette', label: 'Search commands', category: 'View', icon: 'search', keys: ['Mod+K', '/'], run: () => app.openPalette() },
    { id: 'view.timeHms', label: 'Time as hh:mm:ss.ms', category: 'View', checked: () => app.settings.get('timeFormat') === 'hms', run: () => app.setTimeFormat('hms') },
    { id: 'view.timeSec', label: 'Time as seconds', category: 'View', checked: () => app.settings.get('timeFormat') === 'seconds', run: () => app.setTimeFormat('seconds') },
    { id: 'view.timeSmp', label: 'Time as samples', category: 'View', checked: () => app.settings.get('timeFormat') === 'samples', run: () => app.setTimeFormat('samples') },

    // Markers
    { id: 'marker.add', label: 'Add marker at playhead', category: 'Markers', icon: 'flag', keys: ['M'], enabled: has, run: () => app.addMarker() },
    { id: 'marker.addRegion', label: 'Label selection', category: 'Markers', icon: 'region', keys: ['Shift+M'], enabled: range, run: () => app.addRegion() },
    { id: 'marker.next', label: 'Jump to next marker', category: 'Markers', icon: 'skip-forward', keys: ['.'], enabled: () => app.markers.length > 0, run: () => app.jumpMarker(1) },
    { id: 'marker.prev', label: 'Jump to previous marker', category: 'Markers', icon: 'skip-back', keys: [','], enabled: () => app.markers.length > 0, run: () => app.jumpMarker(-1) },
    { id: 'marker.export', label: 'Export labels…', category: 'Markers', icon: 'download', enabled: () => app.markers.length > 0, run: () => app.exportLabels() },
    { id: 'marker.import', label: 'Import labels…', category: 'Markers', icon: 'upload', run: () => app.importLabelsDialog() },
    { id: 'marker.clear', label: 'Remove all markers', category: 'Markers', icon: 'trash', enabled: () => app.markers.length > 0, run: () => app.clearMarkers() },

    // Effects (special)
    { id: 'fx.again', label: 'Repeat last effect', category: 'Effects', icon: 'repeat', keys: ['Mod+R'], enabled: () => !!app.lastEffect && has(), run: () => app.repeatLastEffect() },
    { id: 'fx.captureNoise', label: 'Capture noise profile', category: 'Effects', icon: 'denoise', enabled: range, keywords: 'noise reduction sample learn', run: () => app.captureNoiseProfile() },
    { id: 'fx.chain', label: 'Apply effect chain…', category: 'Effects', icon: 'link', enabled: has, keywords: 'macro preset sequence', run: () => app.openChainDialog() },

    // Analyze
    { id: 'analyze.stats', label: 'Loudness & level report…', category: 'Analyze', icon: 'activity', enabled: has, keywords: 'lufs statistics stats peak rms acx r128 compliance', run: () => app.openStats() },
    { id: 'analyze.spectrum', label: 'Plot spectrum…', category: 'Analyze', icon: 'chart', enabled: has, keywords: 'frequency fft analysis', run: () => app.openSpectrum() },
    { id: 'analyze.clipping', label: 'Find clipping…', category: 'Analyze', icon: 'limit', enabled: has, run: () => app.openFindClipping() },
    { id: 'analyze.silence', label: 'Find silence…', category: 'Analyze', icon: 'silence-cut', enabled: has, keywords: 'gaps pauses split', run: () => app.openFindSilence() },

    // Help
    { id: 'help.shortcuts', label: 'Keyboard shortcuts', category: 'Help', icon: 'keyboard', keys: ['?'], run: () => app.openShortcuts() },
    { id: 'help.about', label: 'About Kerf', category: 'Help', icon: 'info', run: () => app.openAbout() },
  ];

  for (const fx of EFFECTS) {
    list.push({ id: `fx.${fx.id}`, label: `${fx.name}${fx.params.length ? '…' : ''}`, category: 'Effects', group: fx.category, icon: fx.icon, keywords: `${fx.category} ${fx.description}`, enabled: has, run: () => app.openEffect(fx.id) });
  }
  for (const g of GENERATORS) {
    list.push({ id: `gen.${g.id}`, label: `${g.name}…`, category: 'Generate', icon: g.icon, keywords: `generate ${g.description}`, run: () => app.openGenerator(g.id) });
  }

  const byId = new Map(list.map(c => [c.id, c]));
  const keyMap = new Map();
  for (const c of list) {
    c.shortcut = c.keys?.length ? displayKey(c.keys[0]) : '';
    for (const k of c.keys || []) keyMap.set(k, c);
  }
  return { list, byId, keyMap, EFFECT_CATEGORIES };
}
