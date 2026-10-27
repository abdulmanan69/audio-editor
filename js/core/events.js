// Minimal event emitter.
export class Emitter {
  constructor() { this._handlers = new Map(); }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this._handlers.get(type)?.delete(fn); }
  emit(type, payload) {
    const set = this._handlers.get(type);
    if (set) for (const fn of [...set]) fn(payload);
  }
}
