import { treeSpots } from './world.js';
import { TENT_REACH, camps } from './people.js';
import { CITY, campReach } from './settlement.js';

/* -------------------------------------------------------------------------
   Room to stand

   Tents were scattered round their fires with nothing keeping one out of the
   next: most of a slot either way round the fire and anywhere from five to nine
   metres out, ten to a fire, five fires thirteen metres apart. Two tents could
   land on the same spot, the rings of neighbouring fires crossed, and when a
   band built houses on the spots its tents had stood on, the houses - wider
   than any tent - stood in each other.

   Every tent and house now keeps a footprint clear of every other one, of the
   fires, and of the trees. The footprint is the widest a household's shelter
   ever gets on that spot, because the spot is kept while the shelter on it
   grows from a cone of hides to a house: a house's eaves, corner to corner.
   A tent sized for a tent would be in its neighbour's house a few years later.

   Where the drawn spot is taken, the nearest free one round the same fire is
   used - a little either way round, a little in or out, never past TENT_REACH,
   which is what the granaries and the outskirts are laid out against. Nothing
   is drawn off a stream to find it, so every draw after it lands where it did.
   Where there is no room at all round that fire, there is no tent there; the
   household goes to the next free one, and past the core to the outskirts,
   the way every household past the fiftieth always has.
   ------------------------------------------------------------------------- */

export const DWELLING = {
  radius: 2.95,        // a house's eaves at scale 1, corner to corner (village.js): the widest a shelter gets
  margin: 0.4,         // daylight between two of them
  fire: 1.3,           // a hearth: its ring of stones and its logs
  tree: 0.3,           // a trunk
};

export const footprint = (sc) => DWELLING.radius * sc;

/** Everything a new shelter near (x, z) has to keep clear of: every tent and
    house laid out in any camp near enough to matter, their outskirts fires,
    and the trees. Each is { x, z, r }. */
export function dwellingsNear(x, z, reach) {
  const out = [];
  for (const c of camps) {
    if (c.gone || Math.hypot(c.x - x, c.z - z) > reach + campReach(c) + TENT_REACH) continue;
    for (const h of c.huts || []) out.push(h);
    for (const hearth of c.outer?.hearths || []) {
      out.push({ x: hearth.fire.x, z: hearth.fire.z, r: DWELLING.fire });
      for (const t of hearth.huts) out.push(t.hut);
    }
    if ((c.stage || 0) >= CITY.at) for (const h of c.city?.homes || []) out.push(h);
  }
  for (const t of treeSpots) {
    if (Math.abs(t.x - x) < reach && Math.abs(t.z - z) < reach) out.push({ x: t.x, z: t.z, r: DWELLING.tree });
  }
  return out;
}

/** Whether a footprint of radius r at (x, z) is clear of all of them. */
export function clearOf(near, x, z, r) {
  for (const o of near) {
    const d = r + (o.r ?? footprint(1.25)) + DWELLING.margin;
    const dx = o.x - x, dz = o.z - z;
    if (dx < d && dx > -d && dz < d && dz > -d && dx * dx + dz * dz < d * d) return false;
  }
  return true;
}

/** Where a shelter meant for angle a and distance r from a fire can actually
    stand: the nearest spot to that one with its footprint clear and its ground
    good, turning round the fire either way in steps of 7.5 degrees and trying
    every distance at each, nearest first - or null if there is none. */
export function pitch(near, cx, cz, a, r, fp, good) {
  const rMin = DWELLING.fire + fp + DWELLING.margin, rMax = TENT_REACH - fp;
  if (rMax < rMin) return null;
  const r0 = Math.min(rMax, Math.max(rMin, r));
  const radii = [r0];
  for (let d = 0.7; r0 + d <= rMax || r0 - d >= rMin; d += 0.7) {
    if (r0 + d <= rMax) radii.push(r0 + d);
    if (r0 - d >= rMin) radii.push(r0 - d);
  }
  const steps = 48;
  for (let k = 0; k <= steps; k++) {
    const turn = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * ((Math.PI * 2) / steps);
    for (const rr of radii) {
      const x = cx + Math.cos(a + turn) * rr, z = cz + Math.sin(a + turn) * rr;
      if (good(x, z) && clearOf(near, x, z, fp)) return { x, z, a: a + turn };
    }
  }
  return null;
}
