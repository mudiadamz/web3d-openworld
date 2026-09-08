import { P, SEA } from './params.js';
import { sampleHeight, smoothstep } from './noise.js';
import { camera, sunDir } from './scene.js';
import { camps } from './people.js';

/* -------------------------------------------------------------------------
   Nature sound

   Synthesised, not sampled. One four-second buffer of white noise is the wind,
   the leaves and the surf — the same buffer through three different filters —
   and the birds, crickets and owl are oscillators with envelopes. That keeps
   the page a single file with nothing to download, and it means the soundscape
   can be driven by the same numbers that drive the picture: the wind slider
   opens the filter, the sun's elevation hands the day over from birds to
   crickets, and walking down to the beach brings the waves up.

   Browsers will not start audio without a gesture, so the graph is not built
   until the first click or key press.
   ------------------------------------------------------------------------- */

export const audio = { ctx: null, ready: false, failed: false, nextBird: 0, nextOwl: 0 };

export function noiseVoice(ctx, dest, type, freq, q) {
  const src = ctx.createBufferSource();
  src.buffer = audio.noise;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(filter).connect(gain).connect(dest);
  src.start();
  return { filter, gain };
}

// A cricket is a high tone chopped by a fast tremolo. Three of them at slightly
// different rates stop it sounding like one machine.
export function cricketVoice(ctx, dest, carrier, rate, pan) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = carrier;
  const am = ctx.createGain();
  am.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = rate;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.5;
  lfo.connect(lfoDepth);
  lfoDepth.connect(am.gain);
  const out = ctx.createGain();
  out.gain.value = 0.045;
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  osc.connect(am).connect(out).connect(panner).connect(dest);
  osc.start();
  lfo.start();
}

export function initAudio() {
  if (audio.ctx || audio.failed) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { audio.failed = true; return; }
  try {
    const ctx = new Ctx();
    audio.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    audio.master = master;

    const len = Math.floor(ctx.sampleRate * 4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    audio.noise = buf;

    audio.wind = noiseVoice(ctx, master, 'lowpass', 420, 0.7);
    audio.rustle = noiseVoice(ctx, master, 'bandpass', 1900, 0.6);
    audio.waves = noiseVoice(ctx, master, 'lowpass', 380, 1.1);
    audio.fire = noiseVoice(ctx, master, 'bandpass', 900, 0.9);

    audio.birdBus = ctx.createGain();
    audio.birdBus.gain.value = 0;
    audio.birdBus.connect(master);

    audio.cricketBus = ctx.createGain();
    audio.cricketBus.gain.value = 0;
    audio.cricketBus.connect(master);
    cricketVoice(ctx, audio.cricketBus, 4400, 22, -0.55);
    cricketVoice(ctx, audio.cricketBus, 3900, 19.5, 0.6);
    cricketVoice(ctx, audio.cricketBus, 5100, 25, 0.05);

    audio.nightBus = ctx.createGain();
    audio.nightBus.gain.value = 0;
    audio.nightBus.connect(master);

    audio.ready = true;
  } catch (err) {
    audio.failed = true;
    console.warn('audio unavailable:', err);
  }
}

export function armAudio() {
  if (!P.sound || audio.failed) return;
  initAudio();
  audio.ctx?.resume?.();
}

export function chirp(t0, f0, f1, dur, level, pan) {
  const ctx = audio.ctx;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 60), t0 + dur);
  const g = ctx.createGain();
  // Exponential ramps cannot touch zero, hence the near-silent floor.
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(level, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  osc.connect(g).connect(p).connect(audio.birdBus);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

// A song is a short run of swept notes from one direction, not a single beep.
export function birdSong(t0) {
  const notes = 2 + ((Math.random() * 4) | 0);
  const base = 1800 + Math.random() * 2200;
  const pan = Math.random() * 1.6 - 0.8;
  let t = t0;
  for (let i = 0; i < notes; i++) {
    const f0 = base * (0.85 + Math.random() * 0.4);
    const rising = Math.random() < 0.6;
    const f1 = f0 * (rising ? 1.5 + Math.random() * 0.8 : 0.55 + Math.random() * 0.3);
    const dur = 0.05 + Math.random() * 0.09;
    chirp(t, f0, f1, dur, 0.09 + Math.random() * 0.08, pan);
    t += dur + 0.02 + Math.random() * 0.07;
  }
}

export function hoot(t0) {
  const ctx = audio.ctx;
  for (let i = 0; i < 2; i++) {
    const t = t0 + i * 0.58;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(370, t);
    osc.frequency.linearRampToValueAtTime(302, t + 0.34);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.44);
    osc.connect(g).connect(audio.nightBus);
    osc.start(t);
    osc.stop(t + 0.5);
  }
}

export let nextAudioTick = 0;

export function updateAudio() {
  if (!audio.ready) return;
  const ctx = audio.ctx;
  const now = ctx.currentTime;
  // Ten times a second is plenty for ambience, and every setTargetAtTime call
  // puts another event on the parameter's timeline — no reason to file sixty a
  // second for a value that drifts this slowly.
  if (now < nextAudioTick) return;
  nextAudioTick = now + 0.1;
  const smooth = 0.25;

  audio.master.gain.setTargetAtTime(P.sound ? P.volume : 0, now, 0.25);
  if (!P.sound) return;

  // Wind: louder and brighter as it picks up. Leaves only rustle when there is
  // enough wind to rustle them, so that band comes in on the square.
  const w = P.wind;
  audio.wind.gain.gain.setTargetAtTime(0.05 + w * 0.40, now, smooth);
  audio.wind.filter.frequency.setTargetAtTime(240 + w * 900, now, smooth);
  audio.rustle.gain.gain.setTargetAtTime(w * w * 0.18, now, smooth);
  audio.rustle.filter.frequency.setTargetAtTime(1400 + w * 2200, now, smooth);

  // Surf, if you are anywhere near sea level — walk down to the beach and it
  // comes up on its own.
  const groundY = sampleHeight(camera.position.x, camera.position.z);
  const shore = smoothstep(30, 2, groundY - SEA);
  const swell = 0.55 + 0.45 * Math.sin(now * 0.5);
  audio.waves.gain.gain.setTargetAtTime(shore * 0.26 * swell, now, 0.45);

  // A fire is only audible from a few metres away, so this is the one voice
  // that depends on where you are standing rather than on the time of day.
  let nearestFire = Infinity;
  for (let i = 0; i < camps.length; i++) {
    nearestFire = Math.min(nearestFire,
      Math.hypot(camps[i].x - camera.position.x, camps[i].z - camera.position.z));
  }
  const atFire = smoothstep(26, 4, nearestFire);
  const crackle = 0.6 + 0.4 * Math.sin(now * 7.3) * Math.sin(now * 3.1);
  audio.fire.gain.gain.setTargetAtTime(atFire * 0.13 * crackle, now, 0.12);
  audio.fire.filter.frequency.setTargetAtTime(700 + crackle * 900, now, 0.12);

  // The sun hands the day over from the birds to the crickets.
  const e = sunDir.y;
  const day = smoothstep(-0.10, 0.14, e);
  const night = 1 - day;
  audio.birdBus.gain.setTargetAtTime(day * 0.85, now, 0.7);
  audio.cricketBus.gain.setTargetAtTime(night * 0.55, now, 1.5);
  audio.nightBus.gain.setTargetAtTime(night * 0.8, now, 1.0);

  // Busiest near the horizon: a dawn chorus, and an evening one to match.
  const chorus = 1 - smoothstep(0.05, 0.45, Math.abs(e));
  const activity = day * (0.5 + 1.1 * chorus);
  if (now > audio.nextBird) {
    if (activity > 0.06) birdSong(now + 0.05);
    audio.nextBird = now + (0.7 + Math.random() * 3.0) / Math.max(activity, 0.06);
  }
  if (now > audio.nextOwl) {
    if (night > 0.55 && Math.random() < 0.6) hoot(now + 0.1);
    audio.nextOwl = now + 16 + Math.random() * 40;
  }
}

