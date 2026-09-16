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
