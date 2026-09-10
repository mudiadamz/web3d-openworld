import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';

import { FOG_DENSITY, P, SNOW, WORLD } from './params.js';
import { fbm, lerp, mulberry32, smoothstep } from './noise.js';
import { logEvent, simDay } from './life.js';
import { pathUniforms } from './paths.js';

/* -------------------------------------------------------------------------
   Renderer, scene, camera
   ------------------------------------------------------------------------- */

export const canvas = document.getElementById('view');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = P.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

export const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x9fbcd8, FOG_DENSITY);

/* Depth precision here is 119 mm at a kilometre, which is worth knowing when
   two surfaces are close together. It is set by the NEAR plane, not the far
   one: Δz ≈ z²(f−n)/(f·n·2^bits), and with f ≫ n the far plane cancels out —
   shrinking it from 20000 to 6000 changes nothing. Near is what would help, and
   near has to stay small or the grass at your feet is clipped away. So the
   answer for near-coplanar surfaces is to separate them properly and to use a
   polygon offset, not to fiddle with the frustum. */
export const camera = new THREE.PerspectiveCamera(P.fov, innerWidth / innerHeight, 0.5, 20000);

export const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2;
controls.maxDistance = 400;
controls.minPolarAngle = 0.05;
// Deliberately past 90°: the camera has to be able to drop below its target to
// look UP, and a sky that changes all day is worth looking up at. Walking into
// the ground is prevented by the height clamp in moveCamera(), not by this.
controls.maxPolarAngle = Math.PI * 0.95;
controls.zoomSpeed = 0.8;

/* -------------------------------------------------------------------------
   Sky, sun, moon, stars

   Preetham sky (three's Sky addon) driven by one sun direction. The sun rides
   a circle tilted 24° off vertical, so noon is high but not straight overhead
   — that tilt is what makes the shadows read as landscape.
   ------------------------------------------------------------------------- */

export const sky = new Sky();
sky.scale.setScalar(450000);
scene.add(sky);

export const sunLight = new THREE.DirectionalLight(0xffffff, 3);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 900;
sunLight.shadow.camera.left = -110;
sunLight.shadow.camera.right = 110;
sunLight.shadow.camera.top = 110;
sunLight.shadow.camera.bottom = -110;
sunLight.shadow.bias = -0.0004;
/* Set in applyShadowSettings, because the right value depends entirely on
   whether the terrain is casting: metres if it is, centimetres if it is not. */
sunLight.shadow.normalBias = 0.06;
scene.add(sunLight, sunLight.target);

export const moonLight = new THREE.DirectionalLight(0x9dbcff, 0);
scene.add(moonLight);

export const hemiLight = new THREE.HemisphereLight(0x9fbcd8, 0x4a4436, 0.9);
scene.add(hemiLight);

// Stars: a shell of additive points that fades in as the sun drops away.
export const starUniforms = { uOpacity: { value: 0 }, uPixelRatio: { value: 1 } };
(function makeStars() {
  const count = 2200;
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const rng = mulberry32(7771);
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere: pick the height uniformly, not the angle.
    const u = rng() * 2 - 1, a = rng() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos[i * 3] = Math.cos(a) * r * 8000;
    pos[i * 3 + 1] = u * 8000;
    pos[i * 3 + 2] = Math.sin(a) * r * 8000;
    size[i] = 0.9 + rng() * rng() * 2.6;    // squared random → few bright ones
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: starUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aSize;
      varying float vSize;
      uniform float uPixelRatio;
      void main() {
        vSize = aSize;
        gl_PointSize = aSize * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uOpacity;
      varying float vSize;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = (1.0 - d * 2.0) * uOpacity * clamp(vSize * 0.4, 0.2, 1.0);
        gl_FragColor = vec4(vec3(0.86, 0.90, 1.0) * a, a);
      }`,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  scene.add(points);
})();

export const sunDir = new THREE.Vector3();
export const SUN_TILT = THREE.MathUtils.degToRad(24);

export function updateSunDirection(hour) {
  const a = ((hour - 6) / 12) * Math.PI;    // 0 at sunrise, π at sunset
  const y0 = Math.sin(a);
  sunDir.set(Math.cos(a), y0 * Math.cos(SUN_TILT), y0 * Math.sin(SUN_TILT)).normalize();
}

/* Colour stops sampled by sun elevation. Everything in the lighting derives
   from these, which is why one slider moves the whole mood. */
export const SUN_STOPS = [
  [-0.20, new THREE.Color(0xff5c1a)],
  [ 0.00, new THREE.Color(0xff7a33)],
  [ 0.10, new THREE.Color(0xffb27a)],
  [ 0.28, new THREE.Color(0xffe6c8)],
  [ 0.60, new THREE.Color(0xfffdf5)],
];
export const SKY_STOPS = [
  [-0.25, new THREE.Color(0x0a1024)],
  [-0.05, new THREE.Color(0x2a3352)],
  [ 0.03, new THREE.Color(0xc9805c)],
  [ 0.15, new THREE.Color(0xa8c2df)],
  [ 0.55, new THREE.Color(0x9fc3e8)],
];
export const FOG_STOPS = [
  [-0.25, new THREE.Color(0x070b14)],
  [-0.05, new THREE.Color(0x22293f)],
  [ 0.03, new THREE.Color(0xd39068)],
  [ 0.16, new THREE.Color(0xa9c0d8)],
  [ 0.55, new THREE.Color(0xb2cbe0)],
];
export const GROUND_AMBIENT = new THREE.Color(0x50472f);
export const WATER_DEEP = new THREE.Color(0x10202e);

export function sampleStops(stops, e, out) {
  if (e <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (e <= stops[i][0]) {
      const t = (e - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return out.copy(stops[i - 1][1]).lerp(stops[i][1], t);
    }
  }
  return out.copy(stops[stops.length - 1][1]);
}

/* -------------------------------------------------------------------------
   Seasons

   A year is a loop through four sets of numbers. Everything seasonal reads from
   the same blend — the tint on the grass, whether flowers are out, whether
   there is fruit, where the snow lies, and how much a day's foraging is worth.

   That last one is the point. Colour is decoration; a winter that yields a
   third of a summer's forage is what makes the store, the hunts and the whole
   feedback loop mean something.
   ------------------------------------------------------------------------- */

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export const SEASON = {
  //           spring  summer  autumn  winter
  tint: [[0.95, 1.10, 0.80], [1.00, 1.00, 1.00], [1.32, 0.94, 0.48], [0.80, 0.77, 0.71]],
  bloom: [1.00, 0.85, 0.15, 0.00],
  fruit: [0.00, 0.55, 1.00, 0.10],
  forage: [1.00, 1.15, 0.90, 0.35],
  snowLine: [92, 112, 86, 42],
};

export const seasonUniforms = {
  uSeasonTint: { value: new THREE.Vector3(1, 1, 1) },
  uSnowLine: { value: 100 },
  uBloom: { value: 1 },
  uFruit: { value: 1 },
};
export let seasonIndex = 0, seasonName = 'spring', forageSeason = 1;

/** Where in the year we are, 0 at the start of spring. */
export function seasonPhase() {
  return ((simDay % P.yearLength) / P.yearLength + 1) % 1;
}

/* Each season holds its own for most of its length and then hands over, rather
   than the year being one continuous slide through the colour wheel. */
export function blendSeason(table, out) {
  const p = seasonPhase() * 4;
  const i = Math.floor(p) % 4;
  const j = (i + 1) % 4;
  const t = smoothstep(0.55, 0.98, p - Math.floor(p));
  if (Array.isArray(table[i])) {
    for (let k = 0; k < 3; k++) out[k] = lerp(table[i][k], table[j][k], t);
    return out;
  }
  return lerp(table[i], table[j], t);
}

export const _tint = [1, 1, 1];

export function updateSeason() {
  blendSeason(SEASON.tint, _tint);
  seasonUniforms.uSeasonTint.value.set(_tint[0], _tint[1], _tint[2]);
  seasonUniforms.uSnowLine.value = blendSeason(SEASON.snowLine);
  seasonUniforms.uBloom.value = blendSeason(SEASON.bloom);
  seasonUniforms.uFruit.value = blendSeason(SEASON.fruit);
  forageSeason = blendSeason(SEASON.forage);

  const idx = Math.floor(seasonPhase() * 4) % 4;
  if (idx !== seasonIndex) {
    seasonIndex = idx;
    seasonName = SEASONS[idx];
    logEvent('season', `${seasonName} came`, 0, 0);
  }
}

/* -------------------------------------------------------------------------
   Wind — one set of uniforms shared by the grass shader and the tree canopies,
   so a gust crosses both at the same moment.
   ------------------------------------------------------------------------- */

export const windUniforms = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.71, -0.71) },
  uWindStrength: { value: P.wind },
  uGust: { value: P.gust },
};

export function updateWind() {
  const rad = THREE.MathUtils.degToRad(P.windDir);
  // 0° blows toward north (-Z), 90° toward east (+X).
  windUniforms.uWindDir.value.set(Math.sin(rad), -Math.cos(rad));
  windUniforms.uWindStrength.value = P.wind;
  windUniforms.uGust.value = P.gust;
}
updateWind();

export const grassUniforms = {
  ...windUniforms,
  uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
  uKeyColor: { value: new THREE.Color(1, 1, 1) },
  uSkyColor: { value: new THREE.Color(0.4, 0.5, 0.6) },
  uGroundColor: { value: new THREE.Color(0.2, 0.18, 0.12) },
  uFogColor: { value: scene.fog.color },     // shared object: stays in sync
  uFogDensity: { value: FOG_DENSITY },
  uStemColor: { value: new THREE.Color(0x4f7a35) },
  uSeasonTint: seasonUniforms.uSeasonTint,
  uBloom: seasonUniforms.uBloom,
};

/* -------------------------------------------------------------------------
   Materials
   ------------------------------------------------------------------------- */

/* The terrain's colours are baked into its vertices at build time, so the
   season cannot repaint them without rebuilding 260k vertices. It tints them in
   the shader instead, weighted by how grassy each vertex was — bare rock and
   sand do not turn gold in autumn, and the snow line is free to move down the
   mountain as the year turns. */
/* The terrain browns where it has been walked. The wear is a texture rather
   than vertex colours because the vertices are metres apart — at HIGH a terrain
   triangle is seven metres of hillside, and a path is one and a half. */
export const terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
terrainMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, seasonUniforms, pathUniforms);
  shader.uniforms.uWorldSize = { value: WORLD };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `
      #include <common>
      attribute float aGreen;
      varying float vGreen;
      varying float vWorldY;
      varying vec2 vWorldXZ;`)
    .replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vGreen = aGreen;
      vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
      vWorldY = worldPos.y;
      vWorldXZ = worldPos.xz;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `
      #include <common>
      uniform vec3 uSeasonTint;
      uniform float uSnowLine;
      uniform sampler2D uPaths;
      uniform vec3 uPathColor;
      uniform float uPathDeep;
      uniform vec3 uRoadColor;
      uniform float uWorldSize;
      varying float vGreen;
      varying float vWorldY;
      varying vec2 vWorldXZ;`)
    /* The path goes on before the season and the snow, and only over living
       ground. Trodden earth does not turn with the year and does not need to be
       told that a beach is already bare — `vGreen` is exactly "how much of this
       was growing", so multiplying by it means a path fades out where there was
       never anything to wear away. */
    .replace('#include <color_fragment>', `
      #include <color_fragment>
      float worn = texture2D(uPaths, vWorldXZ / uWorldSize + 0.5).r;
      /* Where the ground actually browns. It started at 0.10, which painted
         every faint smear anybody had ever walked across — and since the wear
         field is sampled with a linear filter, a track one cell wide paints a
         tent three metres across before the threshold trims it. Measured: a
         route walked twenty times came out 3.8 m across at 88 percent, which is
         a road. Starting at 0.45 and reaching full at 0.88 cuts the base off
         that tent and leaves the middle of it: 2.6 m, which is a path people
         have worn rather than one somebody laid. */
      float tread = smoothstep(0.45, 0.88, worn) * uPathDeep * vGreen;
      diffuseColor.rgb = mix(diffuseColor.rgb, uPathColor, tread);
      /* A road is laid, not worn (paths.js): the one value above any trail, and
         a colour of its own, whatever grew there before. */
      float road = smoothstep(0.94, 0.99, worn);
      diffuseColor.rgb = mix(diffuseColor.rgb, uRoadColor, road * 0.9);
      diffuseColor.rgb *= mix(vec3(1.0), uSeasonTint, vGreen * (1.0 - tread));
      float seasonSnow = smoothstep(uSnowLine, uSnowLine + 30.0, vWorldY);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.93, 0.96), seasonSnow * 0.92);`);
};
terrainMaterial.customProgramCacheKey = () => 'terrain-season';

export const waterUniforms = {
  uTime: windUniforms.uTime,        // the same clock as the wind that raises it
  uWaves: { value: 1 },
  uRipple: { value: 1 },
};

/* Swell in the vertex shader, ripples in the fragment.

   The swell is displaced and its normal rebuilt from the analytic derivative of
   the same sum, which is why the sea lights correctly instead of being a lumpy
   flat plane. The ripples are too fine to carry as geometry, so they are a
   normal perturbation only — rotated into view space by viewMatrix, because
   `normal` is a view-space vector by the time this runs and adding a world
   vector to it makes the sparkle swim as you turn your head. */
export function applyWaterShader(material, { swell = false, flow = false } = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, waterUniforms);
    shader.uniforms.uWindDir = windUniforms.uWindDir;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        uniform float uTime;
        uniform float uWaves;
        uniform vec2  uWindDir;
        uniform float uWindStrength;
        varying vec2 vWorldXZ;
        ${flow ? 'varying vec2 vFlowUv;' : ''}`)
      .replace('#include <beginnormal_vertex>', `
        #include <beginnormal_vertex>
        float waveH = 0.0;
        ${swell ? `
        vec2 wd = normalize(uWindDir + vec2(1e-4));
        vec2 wc = vec2(-wd.y, wd.x);
        float amp = uWaves * (0.35 + uWindStrength * 1.5);
        float k1 = 0.042, k2 = 0.068, k3 = 0.115;
        vec2 d2 = normalize(wd * 0.7 + wc * 0.7);
        float p1 = dot(position.xz, wd) * k1 - uTime * 0.9;
        float p2 = dot(position.xz, d2) * k2 - uTime * 1.3;
        float p3 = dot(position.xz, wc) * k3 + uTime * 1.7;
        waveH = (sin(p1) * 1.0 + sin(p2) * 0.55 + sin(p3) * 0.22) * amp;
        // The derivative of the line above, which is the whole reason the
        // swell has believable light on it.
        vec2 slope = (cos(p1) * k1 * wd * 1.0
                    + cos(p2) * k2 * d2 * 0.55
                    + cos(p3) * k3 * wc * 0.22) * amp;
        objectNormal = normalize(vec3(-slope.x, 1.0, -slope.y));` : ''}`)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        transformed.y += waveH;
        vWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
        ${flow ? 'vFlowUv = uv;' : ''}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        uniform float uTime;
        uniform float uRipple;
        varying vec2 vWorldXZ;
        ${flow ? 'varying vec2 vFlowUv;' : ''}`)
      .replace('#include <normal_fragment_begin>', `
        #include <normal_fragment_begin>
        ${flow ? `
        /* A creek's ripples travel downstream, so they are driven by the uv the
           ribbon carries rather than by world position — but on a varying we
           declare ourselves, not three's vUv. three declares vUv only under
           USE_UV, which a material with no texture map never sets, so reading
           it here did not compile — and a fragment shader that does not
           compile takes the whole stream program down with it. */
        float f1 = sin(vFlowUv.y * 34.0 - uTime * 5.5) * cos(vFlowUv.x * 9.0);
        float f2 = sin(vFlowUv.y * 71.0 - uTime * 8.0 + vFlowUv.x * 5.0);
        vec3 rip = vec3(f1 * 0.5, 0.0, f2 * 0.35) * uRipple * 0.55;`
        : `
        float f1 = sin(vWorldXZ.x * 1.05 + uTime * 2.1) * cos(vWorldXZ.y * 0.87 - uTime * 1.7);
        float f2 = sin(dot(vWorldXZ, vec2(0.72, -0.69)) * 2.3 + uTime * 3.1);
        vec3 rip = vec3(f1, 0.0, f2) * uRipple * 0.16;`}
        normal = normalize(normal + (viewMatrix * vec4(rip, 0.0)).xyz);`);
  };
  material.customProgramCacheKey = () => `water-${swell}-${flow}`;
  return material;
}

export const waterMaterial = applyWaterShader(new THREE.MeshPhongMaterial({
  color: 0x1b3a4d,
  specular: 0xffffff,
  shininess: 260,
  transparent: true,
  opacity: 0.88,
  // The sea meets the beach at a very shallow angle; without this the band
  // where they are within a depth-buffer step of each other flickers.
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
}), { swell: true });

/* Two surfaces this close together should not be arguing about depth at all.
   The creek is nudged toward the camera and the sea away from it, so each one
   wins its argument the same way at every distance instead of by whichever
   rounds first. */
export const streamMaterial = applyWaterShader(new THREE.MeshPhongMaterial({
  color: 0x2e5f70,
  specular: 0xffffff,
  shininess: 200,
  transparent: true,
  opacity: 0.80,
  /* DoubleSide, deliberately: a ribbon that doubles back on itself at a
     hairpin has triangles wound the other way, and culling them would open a
     hole that appears and disappears with the camera angle — flicker of
     exactly the kind being hunted. Drawn from both sides they simply blend
     twice, which is a slightly darker patch that sits still.

     No depth writing, though. That is what stops the water arguing about
     depth with the bed it lies in and with its own folds. The depth TEST
     stays on, so a rock in the stream still hides the water behind it. */
  side: THREE.DoubleSide,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
}), { flow: true });

export const rockMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });

// White base, every animal's actual colour arriving as an instance colour.
export const faunaMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });

/* Tree canopies sway with the same wind as the grass. Injecting into three's
   Lambert shader (rather than writing another one) keeps the trees inside the
   normal light and shadow path — they only needed a displacement. */
export function applyCanopyWind(material, base, span, fixedWeight = null, { turns = false, ripens = false } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWindDir = windUniforms.uWindDir;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.uniforms.uGust = windUniforms.uGust;
    shader.uniforms.uFruit = seasonUniforms.uFruit;
    // Fruit is the only thing here that ripens away to nothing, so only it
    // scales with the season; everything else leaves this at zero.
    shader.uniforms.uFruitScale = { value: ripens ? 1 : 0 };
    if (turns) {
      shader.uniforms.uSeasonTint = seasonUniforms.uSeasonTint;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSeasonTint;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= uSeasonTint;');
    }
    // Fruit sits out at the end of the branches, so it takes the canopy's full
    // sway rather than deriving one from its own height.
    const weight = fixedWeight !== null ? fixedWeight.toFixed(2)
      : `clamp((transformed.y - ${base.toFixed(2)}) / ${span.toFixed(2)}, 0.0, 1.0) * `
        + `clamp((transformed.y - ${base.toFixed(2)}) / ${span.toFixed(2)}, 0.0, 1.0)`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        uniform float uTime;
        uniform vec2  uWindDir;
        uniform float uWindStrength;
        uniform float uGust;
        uniform float uFruit;
        uniform float uFruitScale;`)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        transformed *= mix(1.0, uFruit, uFruitScale);
        vec3 instOrigin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float tTravel = dot(instOrigin.xz, uWindDir);
        float tWave = sin(tTravel * 0.05 - uTime * (0.8 + uWindStrength * 1.3));
        float tBand = sin(tTravel * 0.013 - uTime * 0.45);
        float tFlut = sin(tTravel * 0.7 - uTime * (2.6 + uWindStrength * 3.4));
        float tGust = mix(1.0, smoothstep(-0.35, 0.85, tBand), uGust);
        // Weight by height above the trunk join, so the canopy never tears
        // away from a trunk that is standing still.
        float w = ${weight};
        // Same trap as the grass: every tree carries a random yaw, so the wind
        // has to be rotated into the tree's frame or the wood leans one way and
        // the meadow beside it leans another.
        /* Same floor as the grass, for the same reason: nothing pads these
           meshes with zero-scale instances today, but the day something does,
           an unguarded normalize turns every one of them into a NaN vertex. */
        mat3 tim = mat3(instanceMatrix);
        vec3 windW = vec3(uWindDir.x, 0.0, uWindDir.y);
        vec2 windL = vec2(dot(tim[0] / max(length(tim[0]), 1e-6), windW),
                          dot(tim[2] / max(length(tim[2]), 1e-6), windW));
        transformed.xz += windL * uWindStrength * (0.9 + 0.6 * tWave + 0.25 * tFlut) * tGust * w * 1.5;
        transformed.y -= uWindStrength * w * 0.25;`);
  };
  // Without this every tweak of the material recompiles into the same program.
  material.customProgramCacheKey = () => `canopy-${base}-${span}-${fixedWeight}-${turns}-${ripens}`;
  return material;
}

export const trunkMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
export const pineCanopyMaterial = applyCanopyWind(new THREE.MeshLambertMaterial({ color: 0xffffff }), 3.0, 7.0);
// Broadleaves turn with the year; conifers are conifers.
export const roundCanopyMaterial = applyCanopyWind(new THREE.MeshLambertMaterial({ color: 0xffffff }), 3.6, 5.5, null, { turns: true });
// Fruit hangs out among the leaves, so it is given the canopy's sway directly
// rather than deriving one from its own height — a berry is 13 cm tall and any
// height-based weight would come out as nearly zero.
export const fruitMaterial = applyCanopyWind(new THREE.MeshLambertMaterial({ color: 0xffffff }), 0, 1, 0.75, { ripens: true });
export const FRUIT_COLORS = [0xc4342b, 0xe0761f, 0xe8b52c, 0x7d2f6b, 0x9d1f2e];

export const grassMaterial = new THREE.ShaderMaterial({
  uniforms: grassUniforms,
  side: THREE.DoubleSide,
  vertexShader: `
    uniform float uTime;
    uniform vec2  uWindDir;
    uniform float uWindStrength;
    uniform float uGust;

    /* 0 a grass blade, 1 a flower's stalk, 2 a petal. One attribute carries
       the whole distinction, which is how a single geometry-agnostic material
       draws grass, stalks and blooms and treats each correctly. */
    attribute float aPart;

    uniform vec3  uStemColor;
    uniform vec3  uSeasonTint;
    uniform float uBloom;

    varying vec3  vAlbedo;
    varying vec3  vNormalW;
    varying float vHeightF;
    varying float vFogDepth;

    void main() {
      vHeightF = uv.y;
      float isStalk = step(0.5, aPart) * step(aPart, 1.5);
      float isPetal = step(1.5, aPart);
      vAlbedo = mix(instanceColor, uStemColor, isStalk);
      // Blades and stalks turn with the year; a petal keeps the colour of its
      // own species, and instead stops existing when nothing is in flower.
      vAlbedo *= mix(uSeasonTint, vec3(1.0), isPetal);

      // Phase comes from where the blade stands, so neighbours lean together
      // and a gust reads as a wave travelling across the field.
      vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float travel = dot(base.xz, uWindDir);

      float wave    = sin(travel * 0.07 - uTime * (1.4 + uWindStrength * 2.2));
      float band    = sin(travel * 0.013 - uTime * 0.45);
      float flutter = sin(travel * 1.10 - uTime * (6.0 + uWindStrength * 7.0));

      float gustMask = mix(1.0, smoothstep(-0.35, 0.85, band), uGust);
      float lean = uWindStrength * (0.55 + 0.45 * wave) * gustMask;

      // Rotation only. The blade's scale is wildly non-uniform and would
      // shear the normal into nonsense.
      /* Parked instances are an all-zero matrix — every rejected blade and
         every flower that is out of season — and normalising a zero vector is
         0/0. Before the wind was rotated into the blade's own frame that NaN
         only reached the normal, and the vertex still collapsed to the origin
         and was culled. Now it reaches the position, and a NaN vertex is not an
         invisible triangle but an undefined one: the driver draws something,
         somewhere, differently every frame. Divide by a floor instead. */
      mat3 im = mat3(instanceMatrix);
      vec3 lens = vec3(length(im[0]), length(im[1]), length(im[2]));
      mat3 rot = mat3(im[0] / max(lens.x, 1e-6),
                      im[1] / max(lens.y, 1e-6),
                      im[2] / max(lens.z, 1e-6));

      /* Every blade is planted at a random angle and this displacement happens
         in the blade's own frame, so pushing along uWindDir directly sends each
         one somewhere different — coherent in timing, incoherent in direction,
         which reads as shimmer rather than as wind. Rotate the wind into the
         blade's frame first. For an orthonormal basis the inverse is the
         transpose, and GLSL ES 1.00 has no transpose(): these dot products are
         that transpose. */
      vec3 windW = vec3(uWindDir.x, 0.0, uWindDir.y);
      vec2 windL = vec2(dot(rot[0], windW), dot(rot[2], windW));

      float w = vHeightF * vHeightF;          // roots hold, tips travel
      vec3 pos = position;
      // The head shrinks onto its own stalk out of season, so a meadow comes
      // into flower and goes over without anything being rebuilt.
      pos.xz *= mix(1.0, uBloom, isPetal);
      pos.xz += windL * (lean * 1.35 + flutter * 0.10 * uWindStrength) * w;
      pos.y  -= lean * lean * 0.55 * w;       // a bent blade is no longer

      // Same trap one line further on: rot is all zeros for a parked instance.
      vec3 nWorld = mat3(modelMatrix) * rot * normal;
      float nLen = length(nWorld);
      vNormalW = nLen > 1e-6 ? nWorld / nLen : vec3(0.0, 1.0, 0.0);

      vec4 mv = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
      vFogDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform vec3  uKeyDir;
    uniform vec3  uKeyColor;
    uniform vec3  uSkyColor;
    uniform vec3  uGroundColor;
    uniform vec3  uFogColor;
    uniform float uFogDensity;

    varying vec3  vAlbedo;
    varying vec3  vNormalW;
    varying float vHeightF;
    varying float vFogDepth;

    void main() {
      vec3 N = normalize(vNormalW);
      if (!gl_FrontFacing) N = -N;

      // The same hemisphere term three uses, so grass and soil agree.
      vec3 hemi = mix(uGroundColor, uSkyColor, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
      float ndl = max(dot(N, uKeyDir), 0.0);

      // A blade is thin enough to glow when the sun is behind it. That is the
      // whole reason this shader exists instead of a Lambert material.
      float back = pow(max(dot(-N, uKeyDir), 0.0), 2.0);

      vec3 albedo = vAlbedo * mix(0.34, 1.0, vHeightF);   // dark down at the soil
      vec3 color  = albedo * (hemi + uKeyColor * ndl) + albedo * uKeyColor * back * 0.55;

      gl_FragColor = vec4(color, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      // three applies fog after tone mapping and encoding. Match it exactly or
      // the grass sits in a different haze than the hill behind it.
      float fogFactor = 1.0 - exp(- uFogDensity * uFogDensity * vFogDepth * vFogDepth);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, fogFactor);
    }`,
});

/* -------------------------------------------------------------------------
   Time of day
   ------------------------------------------------------------------------- */

export const _sunColor = new THREE.Color();
export const _skyColor = new THREE.Color();
export const _groundColor = new THREE.Color();
export const _keyColor = new THREE.Color();

export function updateTimeOfDay() {
  updateSunDirection(P.time);
  const e = sunDir.y;                              // sun elevation, -1..1
  const day = smoothstep(-0.10, 0.14, e);          // 0 at night, 1 in daylight
  const horizon = 1 - smoothstep(0.02, 0.45, Math.abs(e));

  // Sky: turbidity and rayleigh climb near the horizon — that is what buys
  // the reds at sunrise and sunset.
  const u = sky.material.uniforms;
  u.sunPosition.value.copy(sunDir);
  u.turbidity.value = lerp(2.4, 10.5, horizon);
  u.rayleigh.value = lerp(0.9, 3.4, horizon);
  u.mieCoefficient.value = lerp(0.004, 0.020, horizon);
  u.mieDirectionalG.value = 0.82;

  sampleStops(SUN_STOPS, e, _sunColor);
  sampleStops(SKY_STOPS, e, _skyColor);
  sampleStops(FOG_STOPS, e, scene.fog.color);
  _groundColor.copy(GROUND_AMBIENT).lerp(_skyColor, 0.25 * day);

  const sunIntensity = day * 3.2;
  sunLight.color.copy(_sunColor);
  sunLight.intensity = sunIntensity;

  moonLight.intensity = (1 - day) * 0.45;
  moonLight.position.copy(sunDir).multiplyScalar(-400);

  hemiLight.color.copy(_skyColor);
  hemiLight.groundColor.copy(_groundColor);
  const hemiIntensity = lerp(0.30, 1.05, day);
  hemiLight.intensity = hemiIntensity;

  starUniforms.uOpacity.value = smoothstep(0.06, -0.14, e);

  waterMaterial.color.copy(_skyColor).lerp(WATER_DEEP, 0.62);
  waterMaterial.specular.copy(_sunColor);

  /* The grass runs its own shader, so it has to be handed the lighting three
     would otherwise have given it. Both terms are divided by π because that
     is where three's Lambert BRDF puts it — without this the grass is
     brighter than the ground it grows out of and the field looks pasted on. */
  const keyIsSun = sunIntensity >= moonLight.intensity;
  grassUniforms.uKeyDir.value.copy(sunDir).multiplyScalar(keyIsSun ? 1 : -1);
  _keyColor.copy(keyIsSun ? _sunColor : moonLight.color)
    .multiplyScalar((keyIsSun ? sunIntensity : moonLight.intensity) / Math.PI);
  grassUniforms.uKeyColor.value.copy(_keyColor);
  grassUniforms.uSkyColor.value.copy(_skyColor).multiplyScalar(hemiIntensity / Math.PI);
  grassUniforms.uGroundColor.value.copy(_groundColor).multiplyScalar(hemiIntensity / Math.PI);
}

/* -------------------------------------------------------------------------
   Ground colour — shared by the terrain vertices and by the grass, so a blade
   is always a brighter version of the dirt it stands in.
   ------------------------------------------------------------------------- */

export const C_GRASS_A = new THREE.Color(0x4a7a34);
export const C_GRASS_B = new THREE.Color(0x6f9440);
export const C_GRASS_DRY = new THREE.Color(0x8a9047);
export const C_SAND = new THREE.Color(0xc9b58c);
export const C_ROCK = new THREE.Color(0x6b665e);
export const C_SNOW = new THREE.Color(0xe9eef3);

// Also records how much of the result was living ground, which is what the
// season is allowed to tint. Read it from `lastGreen` after the call.
export let lastGreen = 1;

export function groundColorAt(x, z, h, flat, out) {
  const beach = smoothstep(3.2, 0.4, h);
  const rock = smoothstep(0.86, 0.62, flat);
  const snow = smoothstep(SNOW - 8, SNOW + 26, h) * smoothstep(0.55, 0.80, flat);
  lastGreen = (1 - beach) * (1 - rock) * (1 - snow);

  out.copy(C_GRASS_A).lerp(C_GRASS_B, fbm(x * 0.006, z * 0.006, 2, P.seed + 3300));
  out.lerp(C_GRASS_DRY, smoothstep(0.62, 0.95, fbm(x * 0.0013, z * 0.0013, 2, P.seed + 51)) * 0.55);
  out.lerp(C_SAND, beach);
  out.lerp(C_ROCK, rock);
  out.lerp(C_SNOW, snow);
  return out;
}

/* seasonIndex lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setSeasonIndex(v) { seasonIndex = v; }
