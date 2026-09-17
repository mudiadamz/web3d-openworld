/* -------------------------------------------------------------------------
   City walls, for anything that walks

   A wall that people walk through is scenery. So a step that would take
   somebody across a city's wall is refused unless it goes through a gate
   (stepPerson, move.js), and somebody whose way lies across a wall is sent to
   the gate that makes the shortest way of it: out to the gateway on their
   side, through, and on. Outside, a walker whose straight line to the gate
   would cut across the town goes round the wall instead.

   The walls themselves are put up by dressCivic (settlement.js), which hands
   them over here each time it builds them. No imports: this is geometry, and
   the modules that walk and the module that builds must both be able to load
   it without loading each other.
   ------------------------------------------------------------------------- */
export type Wall = { x: number; z: number; r: number; gates: number[]; half: number };
export let walls: Wall[] = [];
export function setWalls(list: Wall[]) { walls = list; }

export const GATEWAY = 3;              // metres either side of the wall a walker lines up at
const off = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
/** Inside the opening of one of this wall's gates, by angle; a little narrower than the gate. */
const inGate = (w: Wall, x: number, z: number) => w.gates.some((g) => off(Math.atan2(z - w.z, x - w.x), g) < w.half * 0.8);

/** Whether a step from one point to the next goes through a wall rather than a gate. */
export function wallBlocks(x0: number, z0: number, x1: number, z1: number): boolean {
  for (const w of walls) {
    const in0 = Math.hypot(x0 - w.x, z0 - w.z) < w.r, in1 = Math.hypot(x1 - w.x, z1 - w.z) < w.r;
    if (in0 !== in1 && !inGate(w, (x0 + x1) / 2, (z0 + z1) / 2)) return true;
  }
  return false;
}

/** Where to head for, on the way to (tx, tz): the target, or the gate on the way to it. */
export function viaGate(x: number, z: number, tx: number, tz: number): [number, number] {
  for (const w of walls) {
    const d = Math.hypot(x - w.x, z - w.z), inside = d < w.r;
    if (inside === (Math.hypot(tx - w.x, tz - w.z) < w.r)) continue;
    let g = w.gates[0], best = Infinity;
    for (const a of w.gates) {
      const gx = w.x + Math.cos(a) * w.r, gz = w.z + Math.sin(a) * w.r;
      const len = Math.hypot(gx - x, gz - z) + Math.hypot(tx - gx, tz - gz);
      if (len < best) { best = len; g = a; }
    }
    const at = (r: number): [number, number] => [w.x + Math.cos(g) * r, w.z + Math.sin(g) * r];
    const near = at(inside ? w.r - GATEWAY : w.r + GATEWAY), far = at(inside ? w.r + GATEWAY : w.r - GATEWAY);
    // At the gateway, or in the gate itself: straight through.
    if (Math.hypot(near[0] - x, near[1] - z) < 1.5 || (inGate(w, x, z) && Math.abs(d - w.r) < GATEWAY)) return far;
    if (inside) return near;                 // a straight line inside a ring never leaves it
    // Outside, and the line to the gateway would cross the town: round the wall, a stretch at a time.
    const dx = near[0] - x, dz = near[1] - z, len = dx * dx + dz * dz;
    const t = len > 0 ? Math.max(0, Math.min(1, ((w.x - x) * dx + (w.z - z) * dz) / len)) : 0;
    if (Math.hypot(x + dx * t - w.x, z + dz * t - w.z) < w.r + 0.5) {
      const a = Math.atan2(z - w.z, x - w.x), turn = Math.atan2(Math.sin(g - a), Math.cos(g - a));
      const b = a + Math.sign(turn) * Math.min(Math.abs(turn), 0.5), R = Math.max(d, w.r + GATEWAY + 2);
      return [w.x + Math.cos(b) * R, w.z + Math.sin(b) * R];
    }
    return near;
  }
  return [tx, tz];
}

/* -------------------------------------------------------------------------
   The roads, for anybody walking outside the walls

   A road is quicker underfoot than open ground (TREAD, paths.js), and a walker
   used to find that out only by swerving onto one that happened to run their
   way. Leaving a walled town by its gate, they now take the road: out along it
   to the branch that ends nearest where they are going, and off it there. And
   coming back, onto the road where it pays to join it, along it to a gate, and
   in. Coming and going by a town's gate, the road is taken even when it is a
   little the longer way (ROADWALK.detour): that is what the gate and the road
   are for. Anywhere else, only when it is actually quicker than walking
   straight - the road counted at the pace it is walked at - so a forager a
   hundred metres off in the other direction still just walks.

   The network is handed over by layRoads (settlement.js) each time it lays the
   roads: every stretch of road between two junctions, and between the two
   gates of a town the street through it. The route is worked out once for an
   errand, and kept on the walker until the errand or the roads change.
   ------------------------------------------------------------------------- */
export type RoadNet = {
  xs: number[]; zs: number[];          // the junctions, road ends and gates
  segs: number[];                      // pairs of junctions with road between them
  dist: Float64Array; next: Int32Array; n: number;   // shortest road between any two, and the first step of it
  slow: number;                        // a metre of road, in metres of open ground walked in the same time
  gateOut: number;                     // metres outside a wall its gate's road begins
  version: number;
};
export let roadNet: RoadNet | null = null;
let netVersion = 0;
export function setRoadNet(v: Omit<RoadNet, 'version'> | null) { roadNet = v ? { ...v, version: ++netVersion } : null; }

export const ROADWALK = {
  min: 30,             // metres: a walk shorter than this is never worth a road
  on: 3,               // metres from a point on the route at which it counts as reached
  gain: 0.97,          // away from the gates, the road has to be at least this much quicker than going straight
  detour: 1.3,         // coming or going by a gate, it may be this much the longer way
  gate: 15,            // metres from a gate's road end that count as having just come out of it
  stall: 240,          // looks without getting nearer the next point before the route is given up
};

const near2 = (px: number, pz: number, ax: number, az: number, bx: number, bz: number): [number, number] => {
  const dx = bx - ax, dz = bz - az, len = dx * dx + dz * dz;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len)) : 0;
  return [ax + dx * t, az + dz * t];
};

/** The quickest way from (x, z) to (ax, az) that uses the roads, as the points
    to walk through, and what it costs in metres of open ground - or null. */
function route(x: number, z: number, ax: number, az: number): { cost: number; pts: number[] } | null {
  const net = roadNet;
  const S = net.segs.length / 2, { xs, zs, dist, n, slow } = net;
  const on = [], off = [];
  for (let s = 0; s < S; s++) {
    const a = net.segs[2 * s], b = net.segs[2 * s + 1];
    on.push(near2(x, z, xs[a], zs[a], xs[b], zs[b]));
    off.push(near2(ax, az, xs[a], zs[a], xs[b], zs[b]));
  }
  let best = Infinity, plan: number[] | null = null;
  for (let i = 0; i < S; i++) {
    const [ex, ez] = on[i], toRoad = Math.hypot(ex - x, ez - z);
    if (toRoad >= best) continue;
    for (let j = 0; j < S; j++) {
      const [lx, lz] = off[j], base = toRoad + Math.hypot(ax - lx, az - lz);
      if (base >= best) continue;
      if (i === j) {
        const c = base + slow * Math.hypot(lx - ex, lz - ez);
        if (c < best) { best = c; plan = [ex, ez, lx, lz]; }
        continue;
      }
      for (const e of [net.segs[2 * i], net.segs[2 * i + 1]]) {
        for (const f of [net.segs[2 * j], net.segs[2 * j + 1]]) {
          const d = dist[e * n + f];
          if (!Number.isFinite(d)) continue;
          const c = base + slow * (Math.hypot(xs[e] - ex, zs[e] - ez) + d + Math.hypot(lx - xs[f], lz - zs[f]));
          if (c >= best) continue;
          best = c;
          plan = [ex, ez];
          for (let u = e; ; u = net.next[u * n + f]) {
            plan.push(xs[u], zs[u]);
            if (u === f) break;
          }
          plan.push(lx, lz);
        }
      }
    }
  }
  return plan ? { cost: best, pts: plan } : null;
}

const insideWall = (x: number, z: number) => walls.find((w) => Math.hypot(x - w.x, z - w.z) < w.r) || null;

/** The road route for a walk, if the road is quicker; null if it is not, or if
    the walker is still inside a wall (the gate comes first). */
function planWalk(x: number, z: number, tx: number, tz: number): number[] | null {
  if (!roadNet || Math.hypot(tx - x, tz - z) < ROADWALK.min || insideWall(x, z)) return null;
  // Into a walled town: the road goes to one of its gates, and the wall's own rule does the rest.
  const w = insideWall(tx, tz);
  const aims = w ? w.gates.map((g) => [w.x + Math.cos(g) * (w.r + roadNet.gateOut), w.z + Math.sin(g) * (w.r + roadNet.gateOut)])
    : [[tx, tz]];
  const byGate = Boolean(w) || walls.some((g) => g.gates.some((a) => Math.hypot(
    x - (g.x + Math.cos(a) * (g.r + roadNet.gateOut)), z - (g.z + Math.sin(a) * (g.r + roadNet.gateOut))) < ROADWALK.gate));
  let best = Infinity, pts: number[] | null = null, straight = Infinity;
  for (const [ax, az] of aims) {
    const rest = Math.hypot(tx - ax, tz - az);
    straight = Math.min(straight, Math.hypot(ax - x, az - z) + rest);
    const r = route(x, z, ax, az);
    if (r && r.cost + rest < best) { best = r.cost + rest; pts = r.pts; }
  }
  return pts && best < straight * (byGate ? ROADWALK.detour : ROADWALK.gain) ? pts : null;
}

/** Where somebody walking to (tx, tz) heads next: along the road if that is
    their way, through a gate if a wall is in it, or straight there. `keep` is
    false for anybody who goes where they are pointed, runs, chases or hides. */
export function wayTo(p: any, tx: number, tz: number, keep: boolean): [number, number] {
  const x = p.x, z = p.z;
  if (!keep || !roadNet) { p.way = null; return viaGate(x, z, tx, tz); }
  const inside = Boolean(insideWall(x, z));
  let way = p.way;
  if (!way || way.v !== roadNet.version || way.tx !== tx || way.tz !== tz || way.inside !== inside) {
    way = p.way = { v: roadNet.version, tx, tz, inside, pts: planWalk(x, z, tx, tz), i: 0, best: Infinity, stall: 0 };
  }
  const pts = way.pts;
  if (pts) {
    while (way.i < pts.length / 2 && Math.hypot(pts[2 * way.i] - x, pts[2 * way.i + 1] - z) < ROADWALK.on) {
      way.i++; way.best = Infinity; way.stall = 0;
    }
    if (way.i < pts.length / 2) {
      const d = Math.hypot(pts[2 * way.i] - x, pts[2 * way.i + 1] - z);
      if (d < way.best - 0.05) { way.best = d; way.stall = 0; }
      // Not getting any nearer - a cliff, a creek, somebody's field: off the road, and straight on.
      else if (++way.stall > ROADWALK.stall) way.i = pts.length / 2;
      if (way.i < pts.length / 2) return [pts[2 * way.i], pts[2 * way.i + 1]];
    }
  }
  return viaGate(x, z, tx, tz);
}
