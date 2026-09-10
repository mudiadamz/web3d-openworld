# Human model: what the open world needs from humans-threejs

What [humans-threejs](https://github.com/mudiadamz/humans-threejs) has to change
for its body to be fitted to this repo's people.

> **Status:** items 1–7 shipped in humans-threejs `aae2d2c` and the body is
> fitted: `src/human-parts.js` is that commit's export, byte for byte. Items 8
> (accessory shapes) and 9 (a fist) are still open.

Measured against humans-threejs `e3ddeda`, the male GLB unless stated. All
heights are from the grounded soles. Metres, +Y up, +Z forward.

## How it will be used

The library's per-person API (`setPersonPose`, `setPersonTransform`) is **not**
needed and can stay as it is. A group is created with a fixed count, and a band
here is born into and dies out of every simulated day, so the group would have
to be rebuilt on every birth.

Instead the body's 15 pieces are hung on this repo's own rig. `writePerson` in
`src/move.js` already moves a torso, neck, head and, on each side, a thigh,
shin, foot, upper arm, forearm and hand, one `InstancedMesh` per piece. Each
limb rotates about X at its joint, and the next piece hangs straight below it
at `(0, -length, 0)`. **One geometry is shared by both sides:** instance
`i * 2 + side`, placed at `±x` by the rig.

## Must have

### 1. Bind pose with straight-down limbs, not an A-pose

Every chain currently drifts outward, and the forearm also drifts forward:

| part | top joint x | bottom joint x | drift |
|---|---|---|---|
| upper arm | 0.182 | 0.253 | **+7 cm** |
| forearm | 0.254 | 0.270 (z +1.4 cm) | +1.6 cm |
| thigh | 0.104 | 0.120 | +1.6 cm |
| calf | 0.120 | 0.140 | +2 cm |

- Within each arm, the shoulder, elbow and wrist centres share one x and have z = 0.
- Within each leg, the hip, knee and ankle centres do the same.

**Check:** for every limb piece, the top-ring centre and bottom-ring centre are
within 1 mm of each other in x and in z.

### 2. Each limb piece mirror-symmetric about its own vertical axis

Left is already exactly the mirror of right. The problem is that each piece is
not symmetric about its own centre line, so drawing one shape on both sides puts
the other side's limb in the wrong place.

Error from flipping each piece about its own joint:

| piece | error |
|---|---|
| upper arm | 14 cm |
| calf | 4 cm |
| thigh | 3 cm |
| forearm | 3 cm |
| hand | 1.8 cm |
| foot | 0 (already fine) |

Most of this goes away once item 1 is fixed. The hand only needs to be a
symmetric mitten; the fingers are drawn separately, close up, by this repo.

**Check:** every limb piece matches its own mirror (about its joint) within 2 mm.

### 3. Pivots at the joint each piece rotates about

"Centre of the uppermost ring" is right for the limbs and wrong for three pieces:

| part | now | should be |
|---|---|---|
| head | crown, y 1.735 | base of the skull / top of the neck, y ≈ 1.50 |
| neck | its top, y 1.515 | its base, y ≈ 1.43 |
| torso | shoulder line, y 1.435 | hip joint, y 0.925 (the torso bends at the waist) |

### 4. Rounded ends at the knee, elbow, wrist and ankle

The rig bends knees to about 77° and elbows to about 75°, and crouches deeply.
Open ring ends show a gap on the outside of the bend. Close each end with a cap
about the limb's radius, or overlap the neighbouring piece by about that much.

### 5. The same limbs for male and female; only the torso differs

Thigh, upper arm and forearm currently differ between the sexes by 1.4–3.3 cm.
Share one set of limbs and express the difference as joint positions instead:

| joint | male | female |
|---|---|---|
| shoulder x | 0.182 | 0.158 |
| hip x | 0.104 | 0.117 |

That keeps one mesh per limb for everybody. The torsos should stay different;
the female torso's chest depth is what makes the difference read.

## Should have

### 6. A static data export alongside the GLBs

For example `human-parts.js`, exporting:

- one entry per piece: `positions` and `normals` as `Float32Array`s, already
  offset so the piece's joint is at the origin
- the male and female torso as two entries
- a joint table: hip, knee, ankle, shoulder, elbow, wrist, neck base, head
  centre and eye height, each with its x where it has one

This loads the body without an async load or three's `GLTFLoader`, and lets
the fast test suite (`node test.js`, plain Node, 0.35 s) check it. This page's
boot sequence is sensitive to anything that awaits, so this matters more than
it looks.

### 7. Knee height (optional, your call on style)

The knee is at 0.558 on a 1.735 m body, which makes the thigh 0.365 m and the
calf 0.49 m. Typical proportions put the knee nearer 0.49–0.50, with thigh and
shin about equal. It shows most in a crouch.

## Nice to have, for a second pass

### 8. Accessory shapes exported with the body

Each relative to the joint it attaches to:

- hair styles and face marks: relative to the head's base
- the hide tunic: relative to the torso's hip joint
- the baskets of food: relative to the torso

With these, this repo can use the library's hair, face, tunic and loads instead
of its own.

### 9. A closed-fist hand shape, relative to the wrist

A fist is currently faked by squashing the open hand
(`FIST = (1.25, 0.72, 1.45)` in `src/move.js`).

## Already fine, no change needed

- +Y up, +Z forward, metres, grounded soles: matches this repo.
- Left is exactly mirrored right (checked to within 0.00001 m).
- The foot is already symmetric, with its joint at the ankle, pointing forward.
- The overlaps at the seams between pieces, about 5 mm, are fine.
- Body-shape presets (slim, average, broad, full): this repo will use
  `average` and scale the torso per person itself.

## Once 1–5 are in

Fitting is mostly swapping the geometry and setting `PERSON` in `src/clock.js`
from the joint table. For reference, the rig's current lengths are thigh 0.48,
shin 0.44, upper arm 0.31 and forearm 0.28, with the hip at 0.85.

Without 1–5 the rig would need a separate mesh for every left and right piece
plus per-side joint offsets. That is workable, but it is more code and it is
only approximate.
