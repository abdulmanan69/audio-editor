// Seven-segment vacuum-fluorescent display rendered as SVG, with unlit "ghost" segments.
const NS = 'http://www.w3.org/2000/svg';
const W = 12, H = 22, T = 2.3, G = 0.45, PITCH = 15, SEP = 6;

const hseg = (x1, x2, y) => `${x1},${y} ${x1 + T / 2},${y - T / 2} ${x2 - T / 2},${y - T / 2} ${x2},${y} ${x2 - T / 2},${y + T / 2} ${x1 + T / 2},${y + T / 2}`;
const vseg = (x, y1, y2) => `${x},${y1} ${x + T / 2},${y1 + T / 2} ${x + T / 2},${y2 - T / 2} ${x},${y2} ${x - T / 2},${y2 - T / 2} ${x - T / 2},${y1 + T / 2}`;
const L = T / 2, R = W - T / 2, TOP = T / 2, MID = H / 2, BOT = H - T / 2;
const SEGS = {
  a: hseg(L + G, R - G, TOP), g: hseg(L + G, R - G, MID), d: hseg(L + G, R - G, BOT),
  f: vseg(L, TOP + G, MID - G), b: vseg(R, TOP + G, MID - G),
  e: vseg(L, MID + G, BOT - G), c: vseg(R, MID + G, BOT - G),
};
const DIGITS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
  '-': 'g', ' ': '', E: 'adefg', r: 'eg', o: 'cdeg', P: 'abefg', A: 'abcefg', U: 'bcdef', S: 'afgcd', L: 'def',
};

export class VFD {
  constructor(container) {
    this.container = container;
    this.text = null;
    this.layout = null;
  }

  build(layout) {
    this.layout = layout;
    const svg = document.createElementNS(NS, 'svg');
    let x = 1;
    this.cells = [];
    for (const ch of layout) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', `translate(${x} 1) skewX(-7)`);
      const cell = { kind: ch === ':' ? 'colon' : ch === '.' ? 'dot' : 'digit', segs: {}, g };
      if (cell.kind === 'digit') {
        for (const [k, pts] of Object.entries(SEGS)) {
          const p = document.createElementNS(NS, 'polygon');
          p.setAttribute('points', pts);
          p.setAttribute('class', 'seg');
          g.append(p);
          cell.segs[k] = p;
        }
        x += PITCH;
      } else {
        const dots = ch === ':' ? [[1.2, 6.5], [1.2, 15.5]] : [[0.8, BOT - 1.2]];
        dots.forEach(([cx, cy], i) => {
          const r = document.createElementNS(NS, 'rect');
          r.setAttribute('x', cx - 1.2); r.setAttribute('y', cy - 1.2);
          r.setAttribute('width', 2.4); r.setAttribute('height', 2.4);
          r.setAttribute('class', 'seg on');
          g.append(r);
          cell.segs[i] = r;
        });
        g.classList.add('lit');
        x += SEP;
      }
      svg.append(g);
      this.cells.push(cell);
    }
    svg.setAttribute('viewBox', `0 0 ${x + 2} ${H + 2}`);
    this.container.replaceChildren(svg);
    this.text = null;
  }

  // Layout chars: digits position "8", separators ":" and "."
  set(text) {
    const layout = text.replace(/[^:.]/g, '8');
    if (layout !== this.layout) this.build(layout);
    if (text === this.text) return;
    const prev = this.text || '';
    this.text = text;
    [...text].forEach((ch, i) => {
      const cell = this.cells[i];
      if (cell.kind !== 'digit' || prev[i] === ch) return;
      const on = DIGITS[ch] ?? '';
      for (const [k, p] of Object.entries(cell.segs)) p.classList.toggle('on', on.includes(k));
      cell.g.classList.toggle('lit', on.length > 0);
    });
  }
}
