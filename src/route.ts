import { SEA } from './params.js';
import { inCreek, sampleHeight } from './noise.js';
import { wearAt } from './paths.js';
import { walls } from './walls.js';

/* -------------------------------------------------------------------------
   Where a road goes

   A road was the straight line between two places, which took it over the
   shoulder of a mountain and through the snow because that was the short way.
   Nobody builds a road like that. A road is the cheapest way across the
   ground, and on a hillside cheap means along it: the climb is what costs, so
   a road that goes round the hill and up the valley is shorter in the only
   sense that matters to whoever has to walk it with a load.

   So the way is searched for rather than drawn: a grid of ROUTE.cell over the
   ground between the two ends, and the least-cost way across it. A step costs
   its length, times what it climbs (ROUTE.climb against a slope of one), times
   what it crosses — a creek is a ford and costs ROUTE.ford. A slope past
   ROUTE.steep is a cliff and is not taken at all, nor is the sea, nor the
   inside of a town's wall, so a road still arrives at a gate rather than
   through the wall. The search may wander ROUTE.wide of the straight line, and
   gives up after ROUTE.most cells and goes straight, which is what it always
   did.
   ------------------------------------------------------------------------- */
export const ROUTE = {
  cell: 12,            // metres a step of the search covers
  climb: 14,           // what a slope of 1 costs against the same length of flat
  steep: 0.42,         // and the slope a road will not climb at all
  ford: 2.5,           // what a creek crossing costs, against dry ground
  along: 0.5,          // and what ground already paved costs, so roads share a way rather than run beside it
  wide: 0.45,          // how far off the straight line it may wander, as a share of its length
  most: 24000,         // cells opened before it gives up and goes straight
  turn: 0.12,          // radians: a bend flatter than this is not a bend, and is dropped
};

/** What the ground at a point costs to cross, or 0 for ground a road cannot take. */
function ground(x: number, z: number): number {
  const h = sampleHeight(x, z);
  if (h < SEA + 0.3) return 0;                       // the sea
  for (const w of walls) if (Math.hypot(x - w.x, z - w.z) < w.r - 1) return 0;   // inside a town
  /* Ground that is already road is half the price of open ground, so the second
     road this way runs along the first and leaves it where it has to, instead of
     laying its own a few paces to the side. That is what makes a road network
     branch: the way out of town is one road, and the forks are further out. */
  if (wearAt(x, z) >= 0.99) return ROUTE.along;
  return inCreek(x, z) ? ROUTE.ford : 1;
}

/* A binary heap of cells to try, cheapest first: the search opens thousands of
   them and sorting an array each time is most of the cost. */
class Heap {
  keys: number[] = [];
  vals: number[] = [];
  push(k: number, v: number) {
    this.keys.push(k); this.vals.push(v);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      [this.keys[p], this.keys[i]] = [this.keys[i], this.keys[p]];
      [this.vals[p], this.vals[i]] = [this.vals[i], this.vals[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.vals[0], k = this.keys.pop(), v = this.vals.pop();
    if (this.keys.length) {
      this.keys[0] = k; this.vals[0] = v;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < this.keys.length && this.keys[l] < this.keys[s]) s = l;
        if (r < this.keys.length && this.keys[r] < this.keys[s]) s = r;
        if (s === i) break;
        [this.keys[s], this.keys[i]] = [this.keys[i], this.keys[s]];
        [this.vals[s], this.vals[i]] = [this.vals[i], this.vals[s]];
        i = s;
      }
    }
    return top;
  }
  get size() { return this.keys.length; }
}

/** The way a road takes from one point to the other: the points it turns at,
    both ends included. A straight pair if there is no better way or none at all. */
export function roadRoute(ax: number, az: number, bx: number, bz: number): [number, number][] {
  const straight: [number, number][] = [[ax, az], [bx, bz]];
  const span = Math.hypot(bx - ax, bz - az);
  if (span < ROUTE.cell * 2) return straight;
  const pad = span * ROUTE.wide + ROUTE.cell * 2;
  const x0 = Math.min(ax, bx) - pad, z0 = Math.min(az, bz) - pad;
  const cols = Math.ceil((Math.max(ax, bx) + pad - x0) / ROUTE.cell) + 1;
  const rows = Math.ceil((Math.max(az, bz) + pad - z0) / ROUTE.cell) + 1;
  if (cols * rows > ROUTE.most) return straight;
  const at = (i: number, j: number): [number, number] => [x0 + i * ROUTE.cell, z0 + j * ROUTE.cell];
  const cell = (x: number, z: number) => [Math.round((x - x0) / ROUTE.cell), Math.round((z - z0) / ROUTE.cell)];
  const [si, sj] = cell(ax, az), [ti, tj] = cell(bx, bz);
  const n = cols * rows, id = (i: number, j: number) => j * cols + i;
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heights = new Float64Array(n).fill(NaN);
  const worth = new Float64Array(n).fill(NaN);
  const hAt = (i: number, j: number) => {
    const k = id(i, j);
    if (Number.isNaN(heights[k])) { const [x, z] = at(i, j); heights[k] = sampleHeight(x, z); worth[k] = ground(x, z); }
    return heights[k];
  };
  const wAt = (i: number, j: number) => { hAt(i, j); return worth[id(i, j)]; };
  const start = id(si, sj), goal = id(ti, tj);
  cost[start] = 0;
  const open = new Heap();
  open.push(0, start);
  let opened = 0;
  while (open.size) {
    const k = open.pop();
    if (k === goal) break;
    if (done[k]) continue;
    done[k] = 1;
    if (++opened > ROUTE.most) return straight;
    const i = k % cols, j = (k / cols) | 0, h = hAt(i, j);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const nk = id(ni, nj);
        if (done[nk]) continue;
        const w = wAt(ni, nj);
        if (!w && nk !== goal) continue;                        // sea, cliff-face, or inside a town
        const d = Math.hypot(di, dj) * ROUTE.cell;
        /* The middle of the step as well as its end: a step of twelve metres
           can have a cliff face inside it, and a road laid over one is what
           this is for. The worse of the two halves is what it climbs. */
        const [mx, mz] = [x0 + (i + di / 2) * ROUTE.cell, z0 + (j + dj / 2) * ROUTE.cell];
        const mh = sampleHeight(mx, mz);
        const slope = Math.max(Math.abs(mh - h), Math.abs(hAt(ni, nj) - mh)) / (d / 2);
        if (slope > ROUTE.steep && nk !== goal) continue;
        const step = d * (1 + ROUTE.climb * slope) * (w || 1);
        if (cost[k] + step >= cost[nk]) continue;
        cost[nk] = cost[k] + step;
        from[nk] = k;
        const [nx, nz] = at(ni, nj);
        open.push(cost[nk] + Math.hypot(bx - nx, bz - nz), nk);
      }
    }
  }
  if (!Number.isFinite(cost[goal])) return straight;
  const back: [number, number][] = [];
  for (let k = goal; k !== -1 && k !== start; k = from[k]) back.push(at(k % cols, (k / cols) | 0));
  back.push([ax, az]);
  back.reverse();
  back[back.length - 1] = [bx, bz];
  /* The cells make a staircase; what a road has is bends. Every point the way
     actually turns at is kept and the rest go. */
  const out: [number, number][] = [back[0]];
  for (let i = 1; i < back.length - 1; i++) {
    const [px, pz] = out[out.length - 1], [x, z] = back[i], [qx, qz] = back[i + 1];
    const a = Math.atan2(z - pz, x - px), b = Math.atan2(qz - z, qx - x);
    if (Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) > ROUTE.turn) out.push(back[i]);
  }
  out.push(back[back.length - 1]);
  return out;
}
