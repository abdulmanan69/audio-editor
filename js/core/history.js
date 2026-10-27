import { Emitter } from './events.js';

// Linear undo history of full project snapshots. Snapshots share immutable AudioData,
// so each entry only costs the arrays an edit actually created.
export class History extends Emitter {
  constructor(limit = 100) {
    super();
    this.limit = limit;
    this.entries = [];
    this.index = -1;
  }

  reset(label, snapshot) {
    this.entries = [{ label, snapshot, time: Date.now() }];
    this.index = 0;
    this.emit('change');
  }

  push(label, snapshot) {
    this.entries.splice(this.index + 1);
    this.entries.push({ label, snapshot, time: Date.now() });
    while (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
    this.emit('change');
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length - 1; }
  get current() { return this.entries[this.index]; }

  undo() {
    if (!this.canUndo) return null;
    const undone = this.entries[this.index];
    this.index--;
    this.emit('change');
    // Re-select what the undone action worked on, so it can be redone or edited again.
    return { snapshot: { ...this.entries[this.index].snapshot, selection: undone.snapshot.selection }, label: undone.label };
  }

  redo() {
    if (!this.canRedo) return null;
    this.index++;
    this.emit('change');
    return { snapshot: this.entries[this.index].snapshot, label: this.entries[this.index].label };
  }

  jump(i) {
    if (i < 0 || i >= this.entries.length || i === this.index) return null;
    this.index = i;
    this.emit('change');
    return { snapshot: this.entries[i].snapshot, label: this.entries[i].label };
  }
}
