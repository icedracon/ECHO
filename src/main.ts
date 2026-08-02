import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Life } from "./life";
import { Story, dateKey } from "./story";
import { KAEL, kaelClipTotal } from "./kael";
import { CORVIN, corvinClipTotal, type CorvinClip } from "./corvin";
import {
  CORVIN_HARD_PLAN,
  CORVIN_HARD_PLAN_CYCLE_SEC,
  DANTE_ACTIONS,
  DANTE_HARD_PLAN,
  DANTE_HARD_PLAN_CYCLE_SEC,
  KAEL_ACTIONS,
  KAEL_HARD_PLAN,
  KAEL_HARD_PLAN_CYCLE_SEC,
  Director,
  type DirectorAction,
  type Situation,
} from "./director";
import {
  dantePolishUrge,
  pickIdle,
  type IdleUrge,
  voiceLineOk,
  markVoiceLine,
  sceneBudgetOk,
  markScene as budgetScene,
} from "./planner";

// v2: the evolving internal state (life) drives the planner's decisions.
const life = new Life();
// M2: the story — tenure, chapters, firsts, day memory. What makes him HIS.
const story = new Story();

type State =
  | "idle"
  | "thinking"
  | "coding"
  | "searching"
  | "speaking"
  | "success"
  | "error";

interface AgentEvent {
  state: State;
  phrase: string | null;
  stars: number;
  level: number;
}

const ACCENT: Record<State, string> = {
  idle: "#b3122a",
  thinking: "#6a5acd",
  coding: "#2ecc71",
  searching: "#3498db",
  speaking: "#e67e22",
  success: "#f1c40f",
  error: "#e74c3c",
};

const IDLE_AFTER_MS = 6000;
// Minimum time a fast/transient state stays on screen before a newer event can
// replace it — otherwise thinking/speaking get clobbered within milliseconds
// (each JSONL block is its own line) and you never see them.
const MIN_HOLD: Record<string, number> = { thinking: 2200, speaking: 1200, coding: 1600, searching: 1600 };
const isTauri = "__TAURI_INTERNALS__" in window;

// Diagnostics -> ~/.echo/echo-fe.log (his overlay can't be screenshotted).
function dbg(msg: string) {
  if (isTauri) void invoke("fe_log", { line: msg }).catch(() => {});
}

const stage = document.getElementById("stage") as HTMLElement;
const sprite = document.getElementById("sprite") as HTMLImageElement;
const bubble = document.getElementById("bubble") as HTMLElement;
const FIRST_RUN_HINT = "Меню ECHO — правый клик по иконке возле часов.";
const starsEl = document.getElementById("stars") as HTMLElement;
const levelEl = document.getElementById("level") as HTMLElement;
const vignetteEl = document.getElementById("vignette") as HTMLElement;

// ---- Camera FX (pure CSS/JS) ----
function shake(ms = 400) {
  stage.classList.remove("shake");
  void stage.offsetWidth; // restart the animation
  stage.classList.add("shake");
  window.setTimeout(() => stage.classList.remove("shake"), ms);
}
function vignettePulse() {
  vignetteEl.classList.remove("pulse");
  void vignetteEl.offsetWidth;
  vignetteEl.classList.add("pulse");
  window.setTimeout(() => vignetteEl.classList.remove("pulse"), 1200);
}

// ---- Sound: synthesized SFX (original — no copyrighted game audio) ----
// Everything routes through a master gain kept low so ECHO never competes with
// music, meetings, or a video. Good desktop sound is almost subconscious.
let actx: AudioContext | null = null;
let masterGain: GainNode | null = null;
const SFX_VOLUME = 0.62; // desktop apps should be almost subconscious
function ac(): AudioContext | null {
  try {
    if (!actx) actx = new AudioContext();
    if (actx.state === "suspended") void actx.resume();
    return actx;
  } catch {
    return null;
  }
}
// Shared output node — connect SFX here instead of a.destination.
function dest(): AudioNode {
  const a = actx as AudioContext;
  if (!masterGain) {
    masterGain = a.createGain();
    masterGain.gain.value = SFX_VOLUME;
    masterGain.connect(a.destination);
  }
  return masterGain;
}
// A gunshot: filtered noise burst with a fast decay.
function sfxGunshot() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.16), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
  const src = a.createBufferSource();
  src.buffer = buf;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(2200, t);
  lp.frequency.exponentialRampToValueAtTime(180, t + 0.15);
  const g = a.createGain();
  g.gain.setValueAtTime(0.34, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  src.connect(lp).connect(g).connect(dest());
  src.start(t);
  src.stop(t + 0.17);
}
// A low sweeping hum for the Devil-Trigger aura.
function sfxAura() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const o = a.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(70, t);
  o.frequency.exponentialRampToValueAtTime(220, t + 0.5);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.1);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
  o.connect(g).connect(dest());
  o.start(t);
  o.stop(t + 1.0);
}
// Demonic roar for the Devil Trigger: a cluster of detuned saws diving in
// pitch through a tanh waveshaper, with a breathy noise growl underneath.
function sfxDemonRoar() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const shaper = a.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.tanh(3.2 * (i / 128 - 1));
  shaper.curve = curve;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.4, t + 0.09);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
  shaper.connect(g).connect(dest());
  for (const det of [0, 7, -9, 13]) {
    const o = a.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(95 + det, t);
    o.frequency.exponentialRampToValueAtTime(42 + det / 2, t + 1.1);
    o.connect(shaper);
    o.start(t);
    o.stop(t + 1.25);
  }
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 1.1), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.5 * (1 - i / d.length);
  const n = a.createBufferSource();
  n.buffer = buf;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 300;
  n.connect(lp).connect(shaper);
  n.start(t);
}
// Blade whoosh: a band-passed noise sweep, fast and airy.
function sfxSlashWhoosh() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.22), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.6;
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.09);
  bp.frequency.exponentialRampToValueAtTime(320, t + 0.2);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  src.connect(bp).connect(g).connect(dest());
  src.start(t);
  src.stop(t + 0.23);
}
// Fire ignite (the summon flash): a soft whump with a crackling tail.
function sfxIgnite() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.6), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const p = i / d.length;
    d[i] = (Math.random() * 2 - 1) * (p < 0.12 ? 1 : Math.random() < 0.06 ? 0.9 : 0.15) * (1 - p);
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(900, t);
  lp.frequency.exponentialRampToValueAtTime(2400, t + 0.1);
  lp.frequency.exponentialRampToValueAtTime(500, t + 0.55);
  const g = a.createGain();
  g.gain.setValueAtTime(0.28, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  src.connect(lp).connect(g).connect(dest());
  src.start(t);
}
// Claw on stone: a gritty scrape that ends in a hard tick — the arm dragging
// itself out through the Door frame.
function sfxClawScrape() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.9), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const p = i / d.length;
    // grain: sparse impulses over noise = stone grit, not hiss
    d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.35 ? 1 : 0.25) * (0.4 + 0.6 * p);
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(700, t);
  bp.frequency.exponentialRampToValueAtTime(2100, t + 0.75);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.2, t + 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  src.connect(bp).connect(g).connect(dest());
  src.start(t);
}
// The tendrils erupting: a wet whip crack with a low swell under it.
function sfxTendrilWhip() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.35), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 1.5;
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 2.4;
  bp.frequency.setValueAtTime(2800, t);
  bp.frequency.exponentialRampToValueAtTime(420, t + 0.3);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.26, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  src.connect(bp).connect(g).connect(dest());
  src.start(t);
  const o = a.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.4);
  const og = a.createGain();
  og.gain.setValueAtTime(0.22, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  o.connect(og).connect(dest());
  o.start(t);
  o.stop(t + 0.5);
}
// A demonic engine: two detuned saws through a shaper, revving up and settling.
function sfxEngineRev(ms = 1400) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const dur = ms / 1000;
  const shaper = a.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.tanh(2.6 * (i / 128 - 1));
  shaper.curve = curve;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.26, t + 0.18);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  shaper.connect(g).connect(dest());
  for (const det of [0, 4, -6]) {
    const o = a.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(58 + det, t);
    o.frequency.exponentialRampToValueAtTime(190 + det, t + dur * 0.45);
    o.frequency.exponentialRampToValueAtTime(96 + det, t + dur);
    o.connect(shaper);
    o.start(t);
    o.stop(t + dur);
  }
}
// Tyre screech: high band-passed noise with a wobble.
function sfxTyreScreech() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.8), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 8;
  bp.frequency.setValueAtTime(1500, t);
  const lfo = a.createOscillator();
  lfo.frequency.value = 7;
  const lg = a.createGain();
  lg.gain.value = 320;
  lfo.connect(lg).connect(bp.frequency);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
  src.connect(bp).connect(g).connect(dest());
  lfo.start(t);
  src.start(t);
  lfo.stop(t + 0.85);
}

// ---- The Door's voice (user-directed: awful, timed) -------------------------
// A deep stone groan with an eerie whistle — the crack blooming open.
function sfxDoorGroan() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.9);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 3.1);
  g.connect(dest());
  for (const f of [31, 44, 52]) {
    const o = a.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.8, t + 3.0);
    o.connect(g);
    o.start(t);
    o.stop(t + 3.1);
  }
  // the whistle: a faint high sine wavering like wind through the gap
  const w = a.createOscillator();
  w.type = "sine";
  w.frequency.setValueAtTime(2300, t);
  const lfo = a.createOscillator();
  lfo.frequency.value = 4.5;
  const lg = a.createGain();
  lg.gain.value = 160;
  lfo.connect(lg).connect(w.frequency);
  const wg = a.createGain();
  wg.gain.setValueAtTime(0.0001, t);
  wg.gain.exponentialRampToValueAtTime(0.045, t + 1.4);
  wg.gain.exponentialRampToValueAtTime(0.0001, t + 3.0);
  w.connect(wg).connect(dest());
  lfo.start(t);
  w.start(t);
  w.stop(t + 3.1);
  lfo.stop(t + 3.1);
}
// The corruption creeping: a dissonant tritone climb over a slow sub-pulse.
function sfxCorruption(ms = 3200) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const dur = ms / 1000;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(dest());
  for (const [f0, f1] of [[82, 290], [116, 410]] as Array<[number, number]>) {
    const o = a.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur);
  }
  for (let i = 0; i < Math.floor(dur / 0.75); i++) {
    const p = a.createOscillator();
    p.type = "sine";
    p.frequency.value = 46;
    const pg = a.createGain();
    const pt = t + 0.3 + i * 0.75;
    pg.gain.setValueAtTime(0.0001, pt);
    pg.gain.exponentialRampToValueAtTime(0.22, pt + 0.04);
    pg.gain.exponentialRampToValueAtTime(0.0001, pt + 0.3);
    p.connect(pg).connect(dest());
    p.start(pt);
    p.stop(pt + 0.32);
  }
}
// The struggle: a strained, trembling undertone that runs until stopped.
function sfxStrainStart(): () => void {
  const a = ac();
  if (!a) return () => {};
  const t = a.currentTime;
  const o = a.createOscillator();
  o.type = "sawtooth";
  o.frequency.value = 55;
  const trem = a.createOscillator();
  trem.frequency.value = 5.2;
  const tg = a.createGain();
  tg.gain.value = 0.05;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.11, t + 0.6);
  trem.connect(tg).connect(g.gain);
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 240;
  o.connect(lp).connect(g).connect(dest());
  o.start(t);
  trem.start(t);
  return () => {
    const t2 = a.currentTime;
    g.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.5);
    window.setTimeout(() => {
      o.stop();
      trem.stop();
    }, 600);
  };
}
// The slam: a floor-shaking double thump with a lowpassed debris burst.
function sfxDoorSlam() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  for (const [dt, f, vol] of [[0, 64, 0.5], [0.13, 42, 0.42]] as Array<[number, number, number]>) {
    const o = a.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f, t + dt);
    o.frequency.exponentialRampToValueAtTime(26, t + dt + 0.5);
    const g = a.createGain();
    g.gain.setValueAtTime(vol, t + dt);
    g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.55);
    o.connect(g).connect(dest());
    o.start(t + dt);
    o.stop(t + dt + 0.6);
  }
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.5), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const n = a.createBufferSource();
  n.buffer = buf;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 420;
  const ng = a.createGain();
  ng.gain.value = 0.3;
  n.connect(lp).connect(ng).connect(dest());
  n.start(t + 0.02);
}

// ---- M1.6 sound floor: near-inaudible layers, felt more than heard --------
// One shared gain so a future config mute kills the whole floor with one dial.
let floorGain: GainNode | null = null;
function floorDest(): AudioNode {
  const a = actx as AudioContext;
  if (!floorGain) {
    floorGain = a.createGain();
    floorGain.gain.value = 0.45;
    floorGain.connect(dest());
  }
  return floorGain;
}
// Boot scuff: one soft footfall.
function sfxScuff() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.06), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource();
  src.buffer = buf;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 420;
  const g = a.createGain();
  g.gain.setValueAtTime(0.14, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  src.connect(lp).connect(g).connect(floorDest());
  src.start(t);
}
// Chair creak on sitting down.
function sfxCreak() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const o = a.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(176, t);
  o.frequency.exponentialRampToValueAtTime(118, t + 0.22);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  o.connect(g).connect(floorDest());
  o.start(t);
  o.stop(t + 0.25);
}
// Cloth rustle on standing up.
function sfxRustle() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.16), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) * 0.8;
  const src = a.createBufferSource();
  src.buffer = buf;
  const hp = a.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1800;
  const g = a.createGain();
  g.gain.setValueAtTime(0.1, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  src.connect(hp).connect(g).connect(floorDest());
  src.start(t);
}
// Holster click after a gun spin: two tiny snaps.
function sfxHolster() {
  const a = ac();
  if (!a) return;
  for (const off of [0, 0.07]) {
    const t = a.currentTime + off;
    const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.02), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = a.createBufferSource();
    src.buffer = buf;
    const bp = a.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    const g = a.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    src.connect(bp).connect(g).connect(floorDest());
    src.start(t);
  }
}

// Ember fizz (the sword dissolving): quiet sparse crackle fading out.
function sfxEmberFizz() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.8), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++)
    d[i] = Math.random() < 0.03 ? (Math.random() * 2 - 1) * (1 - i / d.length) : 0;
  const src = a.createBufferSource();
  src.buffer = buf;
  const hp = a.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1400;
  const g = a.createGain();
  g.gain.setValueAtTime(0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
  src.connect(hp).connect(g).connect(dest());
  src.start(t);
}
// A soft low thud for stumbles / the fall.
function sfxThud() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const o = a.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(50, t + 0.18);
  const g = a.createGain();
  g.gain.setValueAtTime(0.26, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  o.connect(g).connect(dest());
  o.start(t);
  o.stop(t + 0.21);
}

// A restrained engine pass for the off-screen motorcycle gag. Two detuned
// oscillators carry the rev while a lowpass keeps it behind the user's video.
function sfxMotorcycle(durationMs: number) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const duration = Math.max(0.8, durationMs / 1000);
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(520, t);
  lp.frequency.exponentialRampToValueAtTime(900, t + Math.min(0.7, duration * 0.25));
  lp.frequency.exponentialRampToValueAtTime(380, t + duration);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.12);
  g.gain.setValueAtTime(0.12, t + Math.max(0.13, duration - 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  lp.connect(g).connect(floorDest());
  for (const [hz, detune] of [
    [58, -7],
    [116, 9],
  ] as Array<[number, number]>) {
    const o = a.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(hz, t);
    o.frequency.exponentialRampToValueAtTime(hz * 1.45, t + Math.min(0.8, duration * 0.3));
    o.frequency.exponentialRampToValueAtTime(hz * 1.18, t + duration);
    o.detune.value = detune;
    o.connect(lp);
    o.start(t);
    o.stop(t + duration + 0.02);
  }
}
// ---- Voice ----
// Two layers: (1) if you drop your own clips in ~/.echo/voice/<name>.wav|mp3
// they play as-is; (2) otherwise a synthesized deep TTS voice speaks the line.
// No copyrighted game/anime audio ships with ECHO — bring your own if you want it.
// Stylized game-style voice blips instead of text-to-speech: TTS reading words
// always sounds robotic, so each "line" is a short run of vocal-ish syllables
// (low sawtooth through a formant-ish bandpass, with vibrato + pitch glide).
// One syllable: `f0` Hz, `dur` seconds, gliding by `bend`.
function syllable(at: number, f0: number, dur: number, bend = 0.9, gain = 0.22) {
  const a = ac();
  if (!a) return;
  const o = a.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(f0, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(40, f0 * bend), at + dur);
  // vibrato so it sounds voiced, not like a beep
  const lfo = a.createOscillator();
  lfo.frequency.value = 22;
  const lfoGain = a.createGain();
  lfoGain.gain.value = f0 * 0.03;
  lfo.connect(lfoGain).connect(o.frequency);
  // vowel-ish resonance
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(f0 * 3.2, at);
  bp.Q.value = 6;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1800;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.03);
  g.gain.setValueAtTime(gain, at + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(bp).connect(lp).connect(g).connect(dest());
  o.start(at);
  o.stop(at + dur + 0.02);
  lfo.start(at);
  lfo.stop(at + dur + 0.02);
}
// A closed-mouth pondering hum: "hmmm…"
function voiceHmm() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  syllable(t, 128, 0.5, 0.82, 0.2);
}
// Two punchy syllables with an up-kick — the "Jackpot!" cadence.
function voiceJackpot() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  syllable(t, 165, 0.14, 0.9, 0.26);
  syllable(t + 0.17, 140, 0.3, 1.25, 0.26);
}
// Voice ANY line he says: one syllable per vowel-group (capped), so the length
// and rhythm track the actual text. Questions lift at the end, "!" hits harder.
let lastLineAt = 0;
function voiceLine(text: string) {
  const a = ac();
  if (!a) return;
  const now = Date.now();
  if (now - lastLineAt < 350) return; // don't stack overlapping bubbles
  lastLineAt = now;
  const groups = (text.toLowerCase().match(/[aeiouyаеёиоуыэюя]+/g) || []).length;
  const n = Math.max(1, Math.min(6, groups));
  const excited = /[!?]/.test(text);
  const asks = /\?/.test(text);
  const base = excited ? 150 : 132;
  const t = a.currentTime;
  let at = t;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const f0 = base + (Math.random() * 16 - 8) + (last && asks ? 22 : 0);
    const dur = last ? 0.24 : 0.11 + Math.random() * 0.04;
    const bend = last ? (asks ? 1.22 : 0.82) : 0.96;
    syllable(at, f0, dur, bend, excited ? 0.18 : 0.14);
    at += dur + 0.045;
  }
}
// Play ~/.echo/voice/<name>.(wav|mp3|ogg) if the user supplied one; returns
// true when a custom clip was used, so the caller can skip TTS.
function playVoiceFile(name: string): boolean {
  if (!voiceFiles.has(name)) return false;
  try {
    const a = new Audio(voiceFiles.get(name)!);
    a.volume = 0.55;
    void a.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
const voiceFiles = new Map<string, string>();
// Ask the backend which custom voice clips exist and cache their asset URLs.
async function initVoiceFiles() {
  if (!isTauri) return;
  // The bundled pack first (public/voice/dante — ships in every exe, so fans
  // hear the real voice, not the blips)...
  try {
    const r = await fetch("/voice/dante/index.json");
    if (r.ok) {
      const idx = (await r.json()) as Record<string, { f: string }>;
      for (const [slug, v] of Object.entries(idx)) voiceFiles.set(slug, `/voice/dante/${v.f}`);
      dbg(`dante voice pack: ${Object.keys(idx).length} clips`);
    }
  } catch {
    /* no bundled pack */
  }
  // ...then ~/.echo/voice overrides — drop your own takes in, they win.
  try {
    const list = await invoke<Array<[string, string]>>("voice_clips");
    for (const [name, url] of list) voiceFiles.set(name, url);
    dbg(`voice clips: ${list.map((l) => l[0]).join(",") || "(none)"}`);
  } catch (e) {
    dbg(`voice_clips failed: ${e}`);
  }
}
// Call sites use this: your own clip from ~/.echo/voice/ if present, else the
// stylized blip for that line.
function say(name: "hmm" | "jackpot") {
  if (playVoiceFile(name)) return;
  if (name === "hmm") voiceHmm();
  else voiceJackpot();
}

// Devil Trigger: the "Jackpot!" clip through a demon chain — pitched way
// down, a growling sub-layer, distortion, cavern echo. Decoded live via
// WebAudio, so ANY jackpot clip (bundled blip aside) turns monstrous.
async function sayDemonJackpot() {
  const a = ac();
  const url = voiceFiles.get("jackpot");
  if (!a || !url) {
    sfxDemonRoar();
    return;
  }
  try {
    const resp = await fetch(url);
    const buf = await a.decodeAudioData(await resp.arrayBuffer());
    const shaper = a.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) curve[i] = Math.tanh(2.6 * (i / 128 - 1));
    shaper.curve = curve;
    const g = a.createGain();
    g.gain.value = 0.9;
    shaper.connect(g).connect(dest());
    const layers: Array<[number, number, number]> = [
      [0.62, 1.0, 0], // the demon voice
      [0.45, 0.55, 0.012], // growling sub-layer
      [0.62, 0.3, 0.09], // cavern echo
    ];
    for (const [rate, gain, delay] of layers) {
      const s = a.createBufferSource();
      s.buffer = buf;
      s.playbackRate.value = rate;
      const sg = a.createGain();
      sg.gain.value = gain;
      s.connect(sg).connect(shaper);
      s.start(a.currentTime + delay);
    }
  } catch {
    sfxDemonRoar();
  }
}

// Line text -> clip filename (must match scripts/gen_voice.py's slug()).
function slugOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "line";
}
// Speak a bubble: real recorded line if we have one, else the stylized blip.
// Per-line cooldown so the SAME line never repeats close together (planner).
function voiceSay(text: string) {
  if (!voiceLineOk(text)) return;
  markVoiceLine(text);
  if (playVoiceFile(slugOf(text))) return;
  voiceLine(text);
}

// A short bright blip for a light win.
function sfxDing() {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const o = a.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(880, t);
  o.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.17, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  o.connect(g).connect(dest());
  o.start(t);
  o.stop(t + 0.19);
}

// Real PixelLab frame animations (same Dante every frame). Each state maps to
// a clip: a folder of 9 frames, a speed, and whether it loops.
interface Clip {
  frames: string[];
  ms: number;
  loop: boolean;
  settle: number; // after the first full pass, loop back to THIS frame (not 0)
  // Per-frame durations (same length as frames). Nothing organic moves at a
  // constant rate — reaches ease out, taps come in bursts. Falls back to ms.
  msSeq?: number[];
}
const clip = (name: string, ms: number, loop: boolean, settle = 0, count = 9): Clip => ({
  frames: Array.from({ length: count }, (_, i) => `/pixel/${name}/frame_${i}.png?v=16`),
  ms,
  loop,
  settle,
});
function reversedClip(c: Clip): Clip {
  return {
    frames: [...c.frames].reverse(),
    ms: c.ms,
    msSeq: c.msSeq ? [...c.msSeq].reverse() : undefined,
    loop: false,
    settle: c.frames.length - 1,
  };
}
// settle=8 -> play the cross-arms motion once, then HOLD the final crossed
// frame perfectly still (no more motion).
// Original prettier front Dante for idle/reactions; legs-visible walk stays.
// Original pretty Dante everywhere — the character-system one is gone.
const ANIMS: Record<State, Clip> = {
  idle: clip("sitswing", 150, true, 0), // seated, swinging his dangling legs (loops)
  thinking: clip("sitthink", 220, true, 8), // seated, chin on hand, thinking
  // work states are DISTINCT + lively so the common case isn't a static stand:
  coding: clip("gunspin", 90, true, 0), // spins his gun while I code (loops)
  searching: clip("sit", 220, true, 8), // arms crossed, considering
  speaking: clip("taunt", 130, true, 8), // gestures / talks
  success: clip("cheer", 90, false), // once -> idle
  error: clip("stagger", 80, false), // once -> idle
};
// Shared-screen media mode. Dante is already seated at his normal taskbar
// height; these clips rotate his whole body toward the monitor and keep him
// there with only a restrained breathing motion.
const DANTE_WATCH_TURN = clip("d_watchturn", 220, false, 12, 13);
DANTE_WATCH_TURN.msSeq = [220, 180, 170, 170, 180, 190, 200, 210, 220, 240, 260, 300, 450];
const DANTE_WATCH_LOOP = clip("d_watchloop", 380, true, 0, 9);
const DANTE_MOTORIDE = clip("d_motoride", 128, true, 0, 10);
DANTE_MOTORIDE.msSeq = [132, 124, 128, 120, 130, 134, 130, 120, 128, 124];
const DANTE_BLANKET_DOWN = clip("d_blanketdown", 220, false, 16, 17);
DANTE_BLANKET_DOWN.msSeq = [
  320, 220, 200, 190, 190, 200, 210, 220, 230, 240, 250, 270, 300, 340, 400, 480, 680,
];
const DANTE_BLANKET_LOOP = clip("d_blanketloop", 460, true, 0, 9);
const DANTE_BLANKET_CHECK = clip("d_blanketcheck", 260, false, 8, 9);
DANTE_BLANKET_CHECK.msSeq = [360, 260, 240, 300, 520, 300, 240, 280, 560];
// ---- Character packs ---------------------------------------------------------
// "dante" (default) or "corvin" — read from ~/.echo/character at boot, switched
// live with `echo be corvin > ~/.echo/demo`. Corvin swaps the state clips and
// every big scene; the engine (states, streaks, budgets, story) is shared.
type CharacterName = "dante" | "corvin" | "kael";
let character: CharacterName = "dante";
const isDante = () => character === "dante";
const isCorvin = () => character === "corvin";
// Kael is the third character pack: Abyss arm, Razlom, cloak, platypus.
const isKael = () => character === "kael";
type KaelMode = "idle" | "work" | "watch" | "combat" | "night" | "away" | "scene";
type KaelWeaponForm = "dormant" | "sword" | "scythe";
let kaelMode: KaelMode = "idle";
let kaelModeToken = 0;
let kaelWeaponForm: KaelWeaponForm = "dormant";
let kaelWorkTask: Promise<void> | null = null;
let kaelPendingDraw = false;
let kaelPendingStow = false;
const ANIMS_DANTE: Record<State, Clip> = { ...ANIMS };
function applyCharacter() {
  if (isKael()) {
    // Kael state events stay in a quiet base pose. Work and reactions are
    // explicit connected sequences, never raw loops entered in the middle.
    ANIMS.idle = KAEL.breathe as Clip;
    ANIMS.thinking = KAEL.breathe as Clip;
    ANIMS.coding = KAEL.breathe as Clip;
    ANIMS.searching = KAEL.breathe as Clip;
    ANIMS.speaking = KAEL.breathe as Clip;
    ANIMS.success = KAEL.breathe as Clip;
    ANIMS.error = KAEL.breathe as Clip;
    dbg(`character: ${character}`);
    return;
  }
  if (isCorvin()) {
    ANIMS.idle = CORVIN.windidle as Clip; // the watch, coat moving in the wind
    ANIMS.thinking = CORVIN.windidle as Clip;
    // Work states sit on the CALM wind idle — the horizon-scan pose looped
    // nonstop when it was the coding base (user: "не давай ему так часто").
    // huntwatch stays in the quiet rotation and the gaming mood only.
    ANIMS.coding = CORVIN.windidle as Clip;
    ANIMS.searching = CORVIN.windidle as Clip;
    ANIMS.speaking = CORVIN.idle as Clip;
    ANIMS.success = CORVIN.idle as Clip; // wins get pooled reactions, not cheers
    ANIMS.error = CORVIN.damage as Clip; // takes the hit, never falls
  } else {
    Object.assign(ANIMS, ANIMS_DANTE);
  }
  dbg(`character: ${character}`);
}

function resetCharacterStage() {
  // A character reset owns the window position. Cancel an old sit/walk/drop
  // tween first; otherwise its next animation frame can drag the restored
  // companion back below the taskbar after this function has placed him.
  cancelAnimationFrame(winTween);
  winTween = 0;
  kaelModeToken += 1;
  kaelMode = "idle";
  kaelWeaponForm = "dormant";
  kaelWorkTask = null;
  kaelPendingDraw = false;
  kaelPendingStow = false;
  afterClip = null;
  curUrge = null;
  idlePlaysLeft = 0;
  committedUntil = 0;
  gagActive = false;
  showcasing = false;
  introActive = false;
  wandering = false;
  returning = false;
  away = false;
  window.clearTimeout(corvinIdleTimer);
  corvinTickArmed = false;
  corvinQuietPose = "watch";
  corvinQuietRuns = 0;
  corvinSeatedNow = false;
  corvinPostureTransition = null;
  dantePostureTransition = null;
  if (bubbleTimer) {
    window.clearTimeout(bubbleTimer);
    bubbleTimer = undefined;
  }
  stage.classList.remove("leveling", "shooting", "shake");
  delete stage.dataset.facing;
  stage.dataset.state = "idle";
  document.documentElement.style.setProperty("--accent", ACCENT.idle);
  if (home) {
    seatedNow = isDante();
    postureChangedAt = Date.now();
    window.clearTimeout(postureRetry);
    window.clearTimeout(postureSettle);
    home.lastX = home.cornerX;
    home.lastY = isDante() ? home.sitY : home.y;
    void home.win.setPosition(new PhysicalPosition(home.lastX, home.lastY)).catch(() => {});
  }
  if (isKael()) {
    resetKaelHardPlan("character reset");
    startClip(KAEL.breathe as Clip);
  } else if (isCorvin()) {
    resetCorvinHardPlan("character reset");
    lastCorvinDirectorAt = Date.now();
    curClip = CORVIN.windidle as Clip;
    frameIdx = 0;
    afterClip = null;
    if (home) corvinIdleCycle();
  } else {
    resetDanteHardPlan("character reset");
    curClip = idleClip("sitswing");
    frameIdx = 0;
    afterClip = idleStepDone;
  }
  sprite.src = curClip.frames[0];
}

const DANTE_DEMOS = new Set([
  "demo_devil",
  "demo_sword",
  "demo_poster",
  "demo_pizza",
  "demo_clean",
  "demo_wake",
  "demo_coin",
  "demo_spin",
  "demo_form",
  "demo_ride",
  "demo_moto",
  "demo_moto_legacy",
  "demo_dante_review",
  "demo_youtube_poster",
]);
const CORVIN_DEMOS = new Set([
  "demo_corvin",
  "demo_cleave",
  "demo_unchained",
  "demo_hunt",
  "demo_nuzzle",
  "demo_damage",
  "demo_vigil",
  "demo_execution",
  "demo_guitar",
  "demo_night",
  "demo_tale",
  "demo_break",
  "demo_requiem",
  "demo_breach",
  "demo_letter",
  "demo_road",
  "demo_rain",
  "demo_cairn",
  "demo_stone",
  "demo_flask",
  "demo_door",
  "demo_combo",
  "demo_parry",
  "demo_ritual",
  "demo_scan",
  "demo_fly",
  "demo_chapter",
]);
const KAEL_DEMOS = new Set([
  "demo_voidorgan",
  "demo_voidstitch",
  "demo_fullweapon",
  "demo_kael_review",
]);

let qaReturnTarget: CharacterName | null = null;
let qaReturnTimer = 0;
let qaReturnStartedAt = 0;
let qaRecoveryUntil = 0;
let ownedMediaUntil = 0;
function cancelQaReturn(reason: string) {
  if (!qaReturnTarget) return;
  window.clearTimeout(qaReturnTimer);
  dbg(`QA return cancelled: ${reason}`);
  qaReturnTarget = null;
}
function armQaReturn(target: CharacterName) {
  qaReturnTarget = target;
  qaReturnStartedAt = Date.now();
  window.clearTimeout(qaReturnTimer);
  const poll = () => {
    if (!qaReturnTarget) return;
    const busy =
      gagActive || showcasing || introActive || wandering || away || returning ||
      committed() || mediaWatching;
    if (busy && Date.now() - qaReturnStartedAt < 5 * 60_000) {
      qaReturnTimer = window.setTimeout(poll, 700);
      return;
    }
    const restore = qaReturnTarget;
    qaReturnTarget = null;
    qaRecoveryUntil = Date.now() + 6_000;
    // A QA scene may create its own media/game/typing heartbeats. They describe
    // the test, not a new user request, and must not turn into a burst of scenes
    // on the companion we restore. Keep explicit demo/hotkey commands queued.
    for (let i = contextQueue.length - 1; i >= 0; i--) {
      if (!isManualContext(contextQueue[i])) contextQueue.splice(i, 1);
    }
    if (character === restore) resetCharacterStage();
    else switchCharacter(restore, false, false);
    if (restore === "kael" && isKael() && gamingActive()) {
      window.setTimeout(() => void ensureKaelCombatReady("QA return"), 0);
    }
    dbg(`QA test returned to ${restore}`);
  };
  qaReturnTimer = window.setTimeout(poll, 1200);
}

function switchCharacter(
  next: CharacterName,
  announce = true,
  persist = true,
) {
  if (persist) cancelQaReturn("manual character selection");
  if (character === next) return;
  character = next;
  applyCharacter();
  if (persist) void invoke("character_save", { name: character }).catch(() => {});
  resetCharacterStage();
  // A companion selected halfway through an existing game inherits the live
  // session, not the other character's missed choreography. Future hunt marks
  // stay armed; already overdue ones are folded into the switch baseline.
  if (persist && gamingActive()) {
    if (isCorvin()) consumeOverdueHuntClocks("character switch");
    else if (isDante()) consumeOverdueDanteClocks("character switch");
  }
  if (isKael() && gamingActive()) {
    window.setTimeout(() => void ensureKaelCombatReady("character switch"), 0);
  }
  if (announce)
    showBubble(isCorvin() ? "Корвин. Страж." : isKael() ? "Каэль. Разлом." : "Dante's back.", PRIO.NOTABLE);
}

// Walk = the legs-visible side walk (regenerated upright-posture version).
const WALK = clip("sidewalk", 110, true, 0, 8);
// Contact frames (footfalls) hold a beat longer — ground stops feet, feet
// don't slide over ground.
WALK.msSeq = [105, 95, 128, 98, 105, 95, 128, 98];
// Released v0.2.4 walked at `slideWindow(cornerX, 150)` — constant 150 px/s.
// The footstep rewrite that replaced it quietly dropped to 130, i.e. 13%
// slower, which is the "previous build walked better, not fast and not slow"
// regression (user-directed). The gait pulse in slideFootstepWindow averages
// to exactly 1.0, so restoring 150 restores the ORIGINAL average speed while
// keeping the contact timing that stops the feet sliding.
const DANTE_WALK_PACE = 150;
// Scene clips hold their final pose (settle=8) so the gag orchestrator controls
// every transition — no flicker back to idle mid-sequence.
// Error gag: falls, then climbs back up. Slower ms so both read clearly.
const FALLING = clip("falling", 110, true, 8);
// Physics: a fall accelerates, then the held frame is the crash.
FALLING.msSeq = [70, 65, 60, 60, 65, 75, 90, 110, 140];
const CLIMB = clip("climb", 120, true, 8);
// Climbing is EFFORT — heavy pulls easing only at the top.
CLIMB.msSeq = [160, 150, 140, 130, 120, 110, 100, 95, 130];
const DANTE_DROP: Clip = {
  frames: FALLING.frames.slice(0, 7),
  ms: 145,
  loop: true,
  settle: 2,
  msSeq: [150, 140, 130, 125, 135, 150, 175],
};
const DANTE_CRASH: Clip = { frames: [FALLING.frames[8]], ms: 520, loop: true, settle: 0 };
const DANTE_RIDE_CLIMB: Clip = {
  ...CLIMB,
  msSeq: [360, 330, 310, 290, 280, 270, 250, 240, 320],
};
// Success "Jackpot" gun-shoot.
const SHOOT = clip("shoot", 95, true, 8);
// Fast draw, a beat of aim, the shot holds.
SHOOT.msSeq = [80, 70, 60, 55, 120, 60, 70, 90, 160];
// Stand -> sit transition (on arrival), the standing "stand tall" arrival beat,
// and an occasional seated laugh.
const SITDOWN = clip("sitpanel", 190, false);
// Weight: sitting decelerates into the settle.
SITDOWN.msSeq = [140, 150, 160, 175, 190, 205, 220, 240, 260];
const STAND_CROSS = clip("sit", 200, false); // standing, arms crossed
STAND_CROSS.msSeq = [150, 160, 170, 185, 200, 215, 230, 245, 260];
const LAUGH = clip("laugh", 130, false);
LAUGH.msSeq = [110, 100, 90, 90, 100, 110, 120, 130, 150];
// Star-milestone celebration: a standing dance (loops for the scene's duration).
// Beat-accented: the choreography hits (arms-up frame 5, wave frame 8) hold a
// touch longer, like dancing on a beat instead of fast-forward.
const DANCE = clip("dance", 125, true, 0);
DANCE.msSeq = [125, 125, 125, 125, 135, 175, 135, 135, 185];
// Alternate dance: the fist-pump headbang (seamless loop; hit on frame 4).
const HEADBANG = clip("headbang", 120, true, 0, 9);
HEADBANG.msSeq = [130, 120, 110, 100, 150, 100, 110, 120, 130];
// Signature beats: Devil-Trigger power pose (level up), gun-spin + taunt
// (Jackpot follow-through). Check-watch joins the idle rotation below.
const DEVIL = clip("devil", 90, true, 8);
// The power rises: each frame lands harder, the pose HOLDS.
DEVIL.msSeq = [130, 110, 90, 75, 65, 60, 60, 70, 140];
const GUNSPIN = clip("gunspin", 85, true, 8);
// The spin accelerates into a snap-stop.
GUNSPIN.msSeq = [120, 105, 90, 75, 65, 58, 54, 50, 60];
const TAUNT = clip("taunt", 100, true, 8);
TAUNT.msSeq = [120, 100, 85, 80, 85, 95, 105, 115, 130];
// M5 living behaviours: the payoffs and flourishes of a life, not reactions.
const PIZZA = clip("pizza", 160, false, 0, 13); // the gag's earned payoff
// Eating is SLOW — box appears, opens, a full second ADMIRING it (the beat
// that sells the gag), then long chewing, satisfied vanish.
PIZZA.msSeq = [200, 220, 260, 320, 1050, 520, 620, 560, 640, 480, 320, 260, 240];
const COINFLIP = clip("coinflip", 140, true, 8, 9); // standing coin toss
COINFLIP.msSeq = [150, 120, 100, 90, 180, 110, 110, 130, 180];
const SWORDSPIN = clip("swordspin", 110, true, 8, 9); // fiery twirl (gaming beat)
SWORDSPIN.msSeq = [140, 110, 85, 80, 95, 100, 110, 130, 180];
const WAKEUP = clip("wakeup", 150, false, 0, 9); // chained after every nap
// Waking is groggy: slow stir, then gradually back to alert.
WAKEUP.msSeq = [420, 340, 290, 250, 220, 200, 180, 170, 210];

const TYPING = clip("typing", 110, false, 0); // laptop OUT — a transition, plays once
// Physics: a reach starts quick and settles slow — ease-out, never linear.
TYPING.msSeq = [90, 90, 95, 100, 110, 125, 145, 175, 220];
// Typing is BURSTY, not a metronome: a run of taps, a beat, another run, then a
// longer "reading what he wrote" pause. 0=rest, 1=right tap, 3=left tap.
const tt = (n: number) => `/pixel/typetap/frame_${n}.png?v=15`;
const TYPETAP: Clip = {
  frames: [tt(1), tt(3), tt(1), tt(0), tt(3), tt(1), tt(3), tt(0)],
  ms: 120,
  msSeq: [110, 110, 120, 350, 110, 110, 120, 700],
  loop: true,
  settle: 0,
};
// Light win/error reactions (every event) — a quick visible pose.
const CHEER = clip("cheer", 90, true, 8);
// Anticipation dip before the jump, then quick joy.
CHEER.msSeq = [140, 150, 70, 60, 60, 70, 80, 90, 110];
const STAGGER = clip("stagger", 85, true, 8);
// The IMPACT frame holds — that's where the hit reads.
STAGGER.msSeq = [60, 55, 170, 80, 80, 90, 100, 110, 120];
// Keep every path on the same polished timing curves, including intro/return
// transitions that read these clips through the base state map.
ANIMS_DANTE.coding = GUNSPIN;
ANIMS_DANTE.speaking = TAUNT;
ANIMS_DANTE.success = CHEER;
ANIMS_DANTE.error = STAGGER;
// Idle = a WEIGHTED, never-repeat rotation of seated poses (planner.pickIdle),
// with weights bent by his mood — bored → checks watch, low energy → yawns/naps,
// confident → leans back. Each pose plays, he rests still, then a DIFFERENT pose.
const IDLE_MS: Record<string, number> = {
  sitswing: 150,
  sitcross: 200,
  sitthink: 240,
  checkwatch: 200,
  laugh: 130,
  yawn: 220,
  leanback: 200,
  nap: 260,
  // M3 batch — seated micro-behaviours, idle-anchored both ends.
  stretch: 140,
  shrug: 150,
  headtilt: 170,
  // M5 living behaviours.
  lookout: 170,
  cleansword: 200,
  // Dante polish batch — micro/links/daily (see planner URGES).
  d_neckroll: 190,
  d_jacketflick: 160,
  d_fingerguns: 150,
  d_knuckles: 170,
  d_hairswipe: 180,
  d_sigh: 210,
  d_bootswing: 150,
  d_glanceover: 170,
  d_layback: 220,
  d_sitedge: 200,
  d_coffee: 210,
  d_phone: 200,
};
// Frame counts for the non-standard clips (the API returns requested+1).
const IDLE_COUNT: Record<string, number> = {
  d_layback: 11, d_coffee: 11, d_phone: 11,
};
const idleClipCache: Record<string, Clip> = {};
function idleClip(name: string): Clip {
  if (!idleClipCache[name]) {
    if (name === "cleansword") {
      // Sword care is SEVERAL passes of the cloth, not one wipe: appear (0-1),
      // wipe 2-8 three times (repeats reference the same frame urls), vanish.
      const base = clip("cleansword", 200, false, 0, 11).frames;
      const wipe = [2, 3, 4, 5, 6, 7, 8];
      const seq = [0, 1, ...wipe, ...wipe, ...wipe, 9, 10].map((i) => base[i]);
      idleClipCache[name] = { frames: seq, ms: 200, loop: false, settle: 0 };
    } else {
      idleClipCache[name] = clip(name, IDLE_MS[name] ?? 200, false, 0, IDLE_COUNT[name] ?? 9);
    }
  }
  return idleClipCache[name];
}
const IDLE_CYCLE = ["sitswing", "sitcross", "sitthink"].map(idleClip); // showcase demos
// These older held poses end away from the neutral seated frame. Reversing the
// authored entrance gives them a physical exit instead of teleporting into the
// first frame of the next idle action.
const REVERSIBLE_IDLE_POSES = new Set([
  "sitcross",
  "sitthink",
  "checkwatch",
  "laugh",
  "yawn",
  "leanback",
  "d_layback",
]);
// When a one-shot clip ends, run this instead of the default idle fallback.
let afterClip: (() => void) | null = null;

// preload every frame
const PRELOADED: HTMLImageElement[] = [];
function preloadClips(clips: Clip[]) {
  clips.forEach((c) =>
    c.frames.forEach((s) => {
      const im = new Image();
      im.src = s;
      PRELOADED.push(im); // HOLD the references — dropped Images get cache-evicted
    }),
  );
}
preloadClips([
  ...Object.values(ANIMS),
  ...Object.keys(IDLE_MS).map(idleClip),
  WALK,
  FALLING,
  CLIMB,
  SHOOT,
  SITDOWN,
  STAND_CROSS,
  LAUGH,
  DANCE,
  HEADBANG,
  DEVIL,
  GUNSPIN,
  TAUNT,
  PIZZA,
  COINFLIP,
  SWORDSPIN,
  WAKEUP,
  CHEER,
  STAGGER,
  TYPING,
  TYPETAP,
  DANTE_WATCH_TURN,
  DANTE_WATCH_LOOP,
  DANTE_MOTORIDE,
  DANTE_BLANKET_DOWN,
  DANTE_BLANKET_LOOP,
  DANTE_BLANKET_CHECK,
  // The whole Corvin pack too — an unloaded frame on a clip switch flashes the
  // broken-image icon mid-scene (caught by the capture rig, twice per reel).
  ...Object.values(CORVIN),
  ...Object.values(KAEL),
]);

// Context awareness (from the Rust context watcher): you typing -> he types;
// opening video/music -> he turns and watches with you; launching a game -> he
// enters the gaming mood. Long scenes stay serialized by the same busy gate.
const contextQueue: string[] = [];
let contextDrainTimer = 0;
const isManualContext = (kind: string) =>
  kind.startsWith("demo_") || kind === "hotkey_song" || kind === "hotkey_story";
function queueContext(kind: string) {
  // Keep ordering for menu clicks, but coalesce an accidental double-click.
  if (contextQueue[contextQueue.length - 1] !== kind) contextQueue.push(kind);
  if (contextQueue.length > 24) {
    const dropped = contextQueue.shift();
    dbg(`context queue full, dropped oldest: ${dropped}`);
  }
  dbg(`context queued: ${kind} depth=${contextQueue.length}`);
  scheduleContextDrain();
}
function scheduleContextDrain() {
  window.clearTimeout(contextDrainTimer);
  contextDrainTimer = window.setTimeout(() => {
    if (!contextQueue.length) return;
    const shouldWake = contextQueue.some((kind) =>
      isManualContext(kind) ||
      kind === "typing" ||
      kind === "media" ||
      kind === "media_active" ||
      kind === "music" ||
      kind === "music_active" ||
      kind === "gaming"
    );
    if (away && !returning && shouldWake) {
      dbg("queued context wakes companion from off-screen");
      void returnScene();
      scheduleContextDrain();
      return;
    }
    if (!home || gagActive || showcasing || returning || wandering || away || introActive) {
      scheduleContextDrain();
      return;
    }
    const next = contextQueue.shift();
    if (next) onContext(next);
    if (contextQueue.length) scheduleContextDrain();
  }, 500);
}

function onContext(kind: string) {
  dbg(`context ${kind}`);
  if (kind === "show_help") {
    showBubble(FIRST_RUN_HINT, PRIO.NOTABLE);
    return;
  }
  // Only REAL activity keeps him present: typing, media, a game, a demo word,
  // or the mouse actually on him. The cursor_far/heartbeat noise used to stamp
  // this too, so "15 min without work -> he leaves" could never fire.
  if (
    kind === "typing" ||
    kind === "media" ||
    kind === "media_active" ||
    kind === "music" ||
    kind === "music_active" ||
    kind === "gaming" ||
    kind === "gaming_active" ||
    kind === "game_start" ||
    kind === "cursor_near" ||
    kind.startsWith("demo_")
  )
    lastActivity = Date.now();
  // Session clocks are bookkeeping, so update them even while another scene
  // owns the stage. Media heartbeats arrive every 10 s; a 45 s grace absorbs a
  // missed poll without leaving him seated minutes after the video is closed.
  if (kind === "media" || kind === "media_active") {
    if (Date.now() >= manualMediaPauseUntil) {
      mediaUntil = Date.now() + MEDIA_HEARTBEAT_GRACE;
      mediaWanted = Date.now();
      // The YouTube moment is claimed HERE, with the other bookkeeping, because
      // everything below this point sits behind the busy-stage `return`. The
      // media edge almost always lands while something owns the stage — during
      // the walk-in, mid-scene — so recording the wish further down meant it
      // was never recorded at all, and only the watch ever ran. Measured: edge
      // at intro+2 s, watch served at intro+22 s, no плакат.
      if (kind === "media") mediaSongWanted = Date.now();
    }
  }
  // A real game always outranks passive watching. If one opens mid-turn or
  // mid-loop, the watch scene finishes its current transition and exits cleanly.
  // Only a game that is actually IN FRONT outranks watching (user-directed):
  // Steam merely running in the background used to zero this every 10 s, so a
  // YouTube video in a second window never got him to sit down and watch.
  if (kind === "gaming_fg" || kind === "game_start") {
    if (Date.now() >= mediaDemoUntil) mediaUntil = 0;
  }
  if (kind === "gaming_fg") gamingFgUntil = Date.now() + 45_000;
  // The bundled poster song appears in the OS media session. Without this
  // ownership guard it emits `music` back into ECHO and tries to start a second
  // presentation immediately after the first one.
  if ((kind === "music" || kind === "music_active") && Date.now() < ownedMediaUntil) {
    dbg("music ignored: owned by ECHO poster scene");
    return;
  }
  // Manual QA/hotkey scenes must not wait forever behind continuous playback.
  // Suppress two media heartbeats, let the watch exit cleanly, then run the
  // queued scene. Playback is remembered again while that scene owns the stage.
  if (isManualContext(kind) && kind !== "demo_watch" && mediaWatching) {
    manualMediaPauseUntil = Date.now() + 25_000;
    mediaUntil = 0;
    mediaWanted = 0;
  }
  if (!home || gagActive || showcasing || returning || wandering || away || introActive) {
    // The stage is busy — but STATE must not be lost while it is (these were
    // all silently dropped here before, per the hard review):
    if (kind === "quiet_hour" && home) {
      quietUntil = Date.now() + 60 * 60_000;
      dbg("quiet hour engaged (mid-scene)");
      return;
    }
    // Battery is a one-shot EDGE from the backend — it never repeats while the
    // battery stays low. Dropping it here meant that if any scene happened to
    // be running at the moment it crossed the threshold, the energy cap and
    // the line were lost for that whole discharge.
    if (kind === "battery_low") {
      life.v.energy = Math.min(life.v.energy, 0.3);
      dbg("battery low -> energy capped (mid-scene)");
      return;
    }
    if (kind === "gaming") gamingUntil = Date.now() + 3 * 60 * 1000;
    if (kind === "gaming_active") {
      noteGamingHeartbeat();
      void invoke("raise_topmost").catch(() => {}); // stay above the game
    }
    if (kind === "game_start") {
      // Arming clocks is pure bookkeeping — a session that starts while he's
      // mid-scene must still get its 3:00/7:00/10:00 schedule.
      startGamingSession("game_start (mid-scene)");
      return;
    }
    // The drain's wake list names typing/media/gaming, but ONLY manual kinds
    // were ever queued — so those branches could never run. Starting a film or
    // sitting back down to type while he was off-screen therefore did nothing,
    // and he only reappeared on the blind AWAY_RETURN_MS timer (or an AI
    // event). Queue the ambient kinds that mean "someone is here" so the wake
    // path is reachable; queueContext coalesces the 10-second heartbeats.
    if (
      away &&
      !returning &&
      (kind === "typing" ||
        kind === "media" ||
        kind === "media_active" ||
        kind === "music" ||
        kind === "music_active" ||
        kind === "gaming")
    ) {
      queueContext(kind);
      return;
    }
    // The song fires at most once every 20 minutes, so losing it to a scene
    // that happens to be running would mean losing it entirely. Wait instead.
    if (kind === "music") {
      queueContext(kind);
      return;
    }
    // User commands wait for the current scene instead of expiring after 25 s.
    if (isManualContext(kind)) queueContext(kind);
    return;
  }
  // A tray scene owns its character. Selecting a Corvin scene while Dante is
  // active (or vice versa) switches the whole pack first, then starts frame 0.
  // The old per-handler guards silently discarded the click or briefly mixed
  // both characters on the same stage.
  // persist=false: showing ONE scene must not rewrite who lives on the
  // taskbar. `persist` defaults to true, so `echo devil` once — to show a
  // friend the Devil Trigger — used to make Dante the saved character for
  // every reboot afterwards. The explicit switches (`echo be corvin`, the
  // tray) still persist; they are handled further down.
  const qaOriginalCharacter = character;
  if (DANTE_DEMOS.has(kind) && !isDante()) switchCharacter("dante", false, false);
  if (CORVIN_DEMOS.has(kind) && !isCorvin()) switchCharacter("corvin", false, false);
  if (KAEL_DEMOS.has(kind) && !isKael()) switchCharacter("kael", false, false);
  if (
    kind.startsWith("demo_") &&
    kind !== "demo_be_corvin" && kind !== "demo_be_dante" && kind !== "demo_be_kael" &&
    kind !== "demo_full_review" && kind !== "demo_video_review"
  ) {
    armQaReturn(qaOriginalCharacter);
  }
  if (kind === "typing") {
    // Never mid-walk-in, and only once he's home in his corner.
    if (introActive) return;
    // Mid-game your keys are GAMEPLAY, not typing — keep the gaming mood
    // (spins, shots, watch-checks) instead of pulling the laptop out.
    if (gamingActive()) {
      dbg("typing suppressed (gaming mood)");
      return;
    }
    if (Math.abs(home.lastX - home.cornerX) > 4) return; // not settled yet
    // YOU typing outranks ambient AI poses — he sits down and works with you.
    typingUntil = Date.now() + 9000; // each keystroke extends the session
    if (isCorvin()) {
      // No laptop for the sentinel: while you type he sits and tends the blade.
      // A typing session that survives 7 minutes earns a novel chapter; a gap
      // longer than 90 s starts the session clock over.
      if (!typingSessionStart || Date.now() - lastTypingEventAt > 90_000)
        typingSessionStart = Date.now();
      lastTypingEventAt = Date.now();
      maybeTellNovel();
      // A committed one-shot finishes its bite before the whetstone comes out
      // (the commit contract names typing as a trigger that must WAIT).
      if (
        curClip !== (CORVIN.whetstone as Clip) &&
        !corvinTypingTransition &&
        !committed()
      ) {
        stage.dataset.state = "idle";
        void enterCorvinTyping();
      }
      return;
    }
    if (isKael()) {
      lastTypingEventAt = Date.now();
      stage.dataset.state = "coding";
      delete stage.dataset.facing;
      dbg("typing -> connected rune work (kael)");
      void kaelWorkSession();
      return;
    }
    // Only the Corvin and Kael branches above ever stamped this, so for Dante
    // it stayed 0 forever — and two Dante-only gates read it. The 20-minute
    // shrug collapsed to "no game in 20 min" and interrupted him mid-typing,
    // and watchReaction's `during` check (`0 > 0`) was always false, so his
    // Director received a POSITIVE verdict for every action it ever played and
    // could only ever learn upward. Must be stamped after the branches above:
    // Corvin's novel clock reads the PREVIOUS value to detect a 90 s gap.
    lastTypingEventAt = Date.now();
    if (
      curClip !== TYPING &&
      curClip !== TYPETAP &&
      !danteTypingTransition &&
      !committed()
    ) {
      stage.dataset.state = "idle";
      void enterDanteTyping();
    }
    return;
  }
  // M1.5: he glances toward your cursor when it wanders near — quiet moments
  // only, cleared after a beat. Zones come pre-hysteresis'd from context.rs.
  if (kind === "cursor_left" || kind === "cursor_right") {
    if (
      stage.dataset.state === "idle" &&
      !gagActive &&
      !showcasing &&
      !introActive &&
      Date.now() >= typingUntil
    ) {
      stage.dataset.facing = kind === "cursor_left" ? "left" : "right";
      window.clearTimeout(cursorGlance);
      cursorGlance = window.setTimeout(() => {
        if (!gagActive && !showcasing) delete stage.dataset.facing;
      }, 2400);
    }
    return;
  }
  if (kind === "cursor_far") {
    if (!gagActive && !showcasing && !introActive) delete stage.dataset.facing;
    return;
  }
  // Battery low: he runs on fumes with you — energy caps, one dry line.
  if (kind === "battery_low") {
    life.v.energy = Math.min(life.v.energy, 0.3);
    showBubble("Running on fumes.", PRIO.NOTABLE);
    dbg("battery low -> energy capped");
    return;
  }
  // Demo hook (from ~/.echo/demo): play a scene on demand for QA / showing
  // off. Busy-stage queuing happens in the ONE gate above.
  if (kind === "demo_devil") {
    if (isCorvin()) return;
    devilTriggerScene();
    return;
  }
  if (kind === "demo_sword") {
    if (isCorvin()) return;
    demoSword();
    return;
  }
  if (kind === "demo_poster") {
    if (isCorvin()) return;
    posterScene(15000);
    return;
  }
  if (kind === "demo_pizza") {
    if (isCorvin()) return;
    demoSeated(PIZZA, "Finally.");
    return;
  }
  if (kind === "demo_clean") {
    if (isCorvin()) return;
    demoSeated(idleClip("cleansword"));
    return;
  }
  if (kind === "demo_wake") {
    if (isCorvin()) return;
    demoSeated(WAKEUP);
    return;
  }
  if (kind === "demo_coin") {
    if (isCorvin()) return;
    void coinFlourish();
    return;
  }
  if (kind === "demo_spin") {
    if (isCorvin()) return;
    void demoSpin();
    return;
  }
  if (kind === "demo_corvin") {
    void demoCorvin();
    return;
  }
  if (kind === "demo_watch") {
    mediaDemoUntil = Date.now() + 70_000;
    mediaUntil = mediaDemoUntil;
    mediaWanted = Date.now();
    serviceMediaWish();
    return;
  }
  if (kind === "demo_nightwatch") {
    void nightWatchScene(true);
    return;
  }
  if (kind === "demo_ride") {
    void danteVideoRideDemo();
    return;
  }
  if (kind === "demo_video_review") {
    void videoReviewScene();
    return;
  }
  // Let the restored companion breathe before automatic activity resumes.
  // Bookkeeping above has already preserved media/game clocks; manual commands
  // still pass through so the user remains in control.
  if (Date.now() < qaRecoveryUntil && !isManualContext(kind)) {
    if (kind === "gaming") gamingUntil = Date.now() + 3 * 60_000;
    if (kind === "gaming_active") noteGamingHeartbeat();
    dbg(`context ${kind} held during QA recovery`);
    return;
  }
  if (kind === "demo_youtube_poster") {
    markScene();
    dbg("YouTube QA presentation: Dante GIF + MP3");
    void posterScene(15_000);
    return;
  }
  if (kind === "demo_full_review") {
    void fullReviewScene();
    return;
  }
  // Character pack switch (live, persisted): `echo be corvin > ~/.echo/demo`.
  if (kind === "demo_be_corvin" || kind === "demo_be_dante" || kind === "demo_be_kael") {
    switchCharacter(
      kind === "demo_be_corvin" ? "corvin" : kind === "demo_be_kael" ? "kael" : "dante",
    );
    return;
  }
  // Corvin scene QA hooks — same names you'd guess: echo cleave > ~/.echo/demo
  if (kind === "demo_cleave") return void cleaveScene();
  if (kind === "demo_unchained") return void unchainedScene();
  if (kind === "demo_hunt") return void huntwatchPass();
  if (kind === "demo_nuzzle") return void nuzzleScene();
  if (kind === "demo_damage") return void reactErrorCorvin();
  if (kind === "demo_vigil") return void vigilScene();
  if (kind === "demo_execution") return void executionScene();
  if (kind === "demo_guitar") return void guitarScene(12000);
  if (kind === "quiet_hour") {
    quietUntil = Date.now() + 60 * 60_000;
    showBubble(isCorvin() ? "Час тишины. Я на посту." : "Понял. Час молчу.", PRIO.NOTABLE);
    dbg("quiet hour engaged");
    return;
  }
  if (kind === "demo_night") return void nightSongScene();
  // ALT+S (global hotkey): the song on demand — Corvin plays the guitar,
  // Dante raises the плакат. Same busy-gate as demos: never mid-scene.
  if (kind === "hotkey_song") {
    if (isCorvin()) void nightSongScene();
    else if (isKael()) void kaelVoidOrganScene(true);
    else posterScene(30_000);
    return;
  }
  // ALT+B — a story on demand (user-directed): the next chapter of the novel,
  // skipping the 7-minute typing gate and the 20-minute spacing.
  if (kind === "hotkey_story") {
    if (!isCorvin()) return;
    typingSessionStart = Date.now() - NOVEL_AFTER_TYPING_MS - 1000;
    if (story.s.novel) story.s.novel.lastAt = 0;
    maybeTellNovel();
    return;
  }
  if (kind === "demo_tale") return void whetstoneTaleScene();
  if (kind === "demo_break") return void breakdownScene();
  if (kind === "demo_requiem") return void requiemScene();
  if (kind === "demo_breach") return void breachScene();
  if (kind === "demo_letter") return void letterScene();
  if (kind === "demo_road") return void roadScene();
  if (kind === "demo_rain") return void rainScene();
  if (kind === "demo_cairn") return void cairnScene();
  if (kind === "demo_stone") return void stoneRestScene(18_000);
  if (kind === "demo_flask") return void corvinScene(() => playCorvin(CORVIN.flask));
  if (kind === "demo_door") { if (isCorvin()) void doorFightScene(true); return; }
  if (kind === "demo_form") { if (isDante()) void devilFormScene(); return; }
  if (kind === "demo_moto" || kind === "demo_moto_legacy") {
    if (isDante()) void motoScene();
    return;
  }
  if (kind === "demo_dante_review") return void danteReviewScene();
  if (kind === "demo_combo") return void comboFlowScene();
  if (kind === "demo_parry") return void parryBeat();
  if (kind === "demo_ritual") {
    story.s.lastRitualDay = ""; // let today's ceremony run again, for QA
    maybeDailyRitual();
    return;
  }
  if (kind === "demo_voidorgan") return void kaelVoidOrganScene(true);
  if (kind === "demo_voidstitch") return void kaelVoidStitchScene();
  if (kind === "demo_fullweapon") return void kaelFullWeaponScene();
  if (kind === "demo_kael_review") return void kaelReviewScene();
  if (kind === "demo_scan") return void magicscanScene();
  if (kind === "demo_fly") return void artsivCycleScene();
  if (kind === "demo_chapter") {
    typingSessionStart = Date.now() - NOVEL_AFTER_TYPING_MS - 1000;
    if (story.s.novel) story.s.novel.lastAt = 0;
    maybeTellNovel();
    return;
  }
  if (kind === "gaming_active") {
    // Short tail: heartbeats arrive every ~10 s while the game/fullscreen is
    // real, and typing should recover FAST once it ends (a 3-min tail read as
    // "typing randomly broken" after closing a game).
    noteGamingHeartbeat();
    // Borderless games repaint above us unless TOPMOST is re-asserted. tao
    // no-ops set_always_on_top when the flag is unchanged, so go through the
    // Rust command that calls SetWindowPos unconditionally every heartbeat.
    void invoke("raise_topmost").catch(() => {});
    return;
  }
  if (kind === "game_start") {
    // The REAL game launch edge (Steam RunningAppID 0->N or a fullscreen flip):
    // anchor the fixed schedule here — devil at 3:00, sword at 7:00, then each
    // every 10 min. The Steam client window alone must not arm these.
    startGamingSession("game_start");
    return;
  }
  if (kind === "media_active") {
    serviceMediaWish();
    return;
  }
  // The music heartbeat's whole job is the lastActivity stamp above: it says
  // someone is still listening, so he stays. It must reach the away-branch
  // above (which queues it and wakes him), but it never starts a scene —
  // that is the once-per-20-minutes `music` edge's job.
  if (kind === "music_active") return;
  // MUSIC, not video: he plays ALONG instead of turning his back to watch.
  // This is what the media trigger did before mediaWatchScene took the slot
  // (commit 1640ef4 replaced guitarScene/posterScene with the watch scene, so
  // putting a record on started staging a film with nothing on screen).
  if (kind === "music") {
    // No sceneAllowed() gate. The comment here promised a retry that does not
    // exist — the `return` DROPPED the edge, and Rust only sends another in
    // twenty minutes, so putting a record on within 3 min of any other beat
    // did nothing at all. That 20-minute throttle IS the rate limit; the
    // stage-busy guard above already prevents stacking. Rust's own throttle IS
    // the rate limit. Same beat as the video edge, so it shares one gap and one
    // per-character dispatch instead of two copies drifting apart.
    lastWatchSongAt = Date.now();
    markScene();
    dbg(`music playing -> the song: ${character}`);
    if (isCorvin()) void guitarScene(15_000);
    else if (isKael()) void kaelVoidOrganScene(true);
    else posterScene(15_000);
    return;
  }
  if (kind === "media") {
    // The wish itself is claimed above, before the busy-stage return.
    serviceMediaWish();
  } else if (kind === "gaming") {
    // Mood only — the devil/sword clocks are armed by "game_start" (the real
    // launch edge), never by DNS hits or the Steam client window.
    gamingUntil = Date.now() + 3 * 60 * 1000;
    if (gameSessionStartedAt) {
      // DNS/window activity repeats while the same Steam session is alive. It
      // must not consume the global scene gap or replay the opening scan every
      // two minutes; fixed clocks and the gaming Director already own the stage.
      dbg("gaming edge folded into active session");
      return;
    }
    lastGamingSpecial = Date.now();
    markScene();
    if (isCorvin()) void magicscanScene(); // the hunt opens with a perimeter scan
    else if (isKael()) void kaelGameReadyScene();
    else shootScene(3); // launched a game -> a longer 3-shot burst
  }
}

// ---- Gaming-session mood ----------------------------------------------------
// While Steam/a game is open he's in a playful mood: at random moments he stands
// and spins his gun a couple of times, then drops back to the seat, swings his
// legs and chuckles. Once an hour (random moment) he does a Jackpot and, later,
// a fall+climb.
// Typing keeps going while you keep typing; each key event pushes this out.
let typingUntil = 0;
let cursorGlance = 0;
let danteTypingTransition = false;
let corvinTypingTransition = false;

async function enterDanteTyping() {
  if (!isDante() || danteTypingTransition || Date.now() >= typingUntil) return;
  danteTypingTransition = true;
  try {
    await ensureDantePosture(true);
    if (!isDante() || Date.now() >= typingUntil) return;
    // Laptop take-out begins only after the sitpanel contact frame. The callback
    // owns the exact existing typing-loop timing.
    startClip(TYPING, () => startClip(TYPETAP));
    dbg("typing -> seated laptop out");
    tickTyping();
  } finally {
    danteTypingTransition = false;
  }
}

async function enterCorvinTyping() {
  if (!isCorvin() || corvinTypingTransition || Date.now() >= typingUntil) return;
  corvinTypingTransition = true;
  try {
    await ensureCorvinSeated("typing whetstone");
    if (!isCorvin() || Date.now() >= typingUntil) return;
    corvinQuietPose = "whet";
    corvinSeatedNow = true;
    startClip(CORVIN.whetstone as Clip);
    dbg("typing -> seated whetstone (corvin)");
    tickTyping();
  } finally {
    corvinTypingTransition = false;
  }
}

async function leaveCorvinTyping() {
  if (!isCorvin() || corvinTypingTransition) return;
  corvinTypingTransition = true;
  try {
    await ensureCorvinStanding("typing finished");
    if (!isCorvin()) return;
    finishSceneIdle("corvin typing");
  } finally {
    corvinTypingTransition = false;
    if (isCorvin() && Date.now() < typingUntil) void enterCorvinTyping();
  }
}

function tickTyping() {
  window.setTimeout(() => {
    if (isCorvin()) {
      // Whetstone session: keep stroking while you type, then simply rest.
      if (curClip !== (CORVIN.whetstone as Clip)) return;
      if (Date.now() < typingUntil) {
        tickTyping();
        return;
      }
      void leaveCorvinTyping();
      return;
    }
    if (isKael()) {
      // Kael owns one connected work task. Keystrokes only extend typingUntil;
      // they never restart the enter pose or reset the rune loop.
      return;
    }
    if (curClip !== TYPING && curClip !== TYPETAP) return; // something else took over
    if (Date.now() < typingUntil) {
      tickTyping(); // still typing — keep the laptop out
      return;
    }
    // done — put the laptop AWAY (take-out reversed), then back to his own life.
    // Closing is a shove: starts gentle, speeds up.
    curClip = {
      frames: [...TYPING.frames].reverse(),
      ms: 90,
      msSeq: [130, 110, 95, 85, 75, 70, 65, 60, 60],
      loop: false,
      settle: 0,
    };
    frameIdx = 0;
    afterClip = () => {
      if (stage.dataset.state === "idle") playIdleCycle();
      else setState(stage.dataset.state as State);
    };
  }, 1000);
}

let gamingUntil = 0;
let lastGamingSpecial = 0;
const GAME_SESSION_START_KEY = "echo.gameSessionStartedAt";
const GAME_SESSION_HEARTBEAT_KEY = "echo.gameSessionHeartbeatAt";
const GAME_SESSION_CLOCKS_KEY = "echo.gameSessionClocks";
const GAME_SESSION_RESUME_GAP = 10 * 60_000;
let gameSessionStartedAt = 0;

function startGamingSession(source: string) {
  const now = Date.now();
  gamingUntil = now + 60_000;
  if (gameSessionStartedAt > 0) {
    localStorage.setItem(GAME_SESSION_HEARTBEAT_KEY, String(now));
    dbg(
      `${source} ignored: session already ${Math.floor((now - gameSessionStartedAt) / 60_000)}m old`,
    );
    return;
  }

  const savedStart = Number(localStorage.getItem(GAME_SESSION_START_KEY) || 0);
  const savedHeartbeat = Number(localStorage.getItem(GAME_SESSION_HEARTBEAT_KEY) || 0);
  const canResume =
    savedStart > 0 &&
    savedStart <= now &&
    savedHeartbeat >= savedStart &&
    now - savedHeartbeat <= GAME_SESSION_RESUME_GAP;
  gameSessionStartedAt = canResume ? savedStart : now;
  localStorage.setItem(GAME_SESSION_START_KEY, String(gameSessionStartedAt));
  localStorage.setItem(GAME_SESSION_HEARTBEAT_KEY, String(now));

  if (canResume) {
    restoreGamingClocks(gameSessionStartedAt, now);
    if (isCorvin()) consumeOverdueHuntClocks("session resume", now);
    else if (isDante()) consumeOverdueDanteClocks("session resume", now);
  } else {
    localStorage.removeItem(GAME_SESSION_CLOCKS_KEY);
    lastGamingDevil = gameSessionStartedAt - GAMING_DEVIL_EVERY + 3 * 60_000;
    lastGamingSword = gameSessionStartedAt - GAMING_SWORD_EVERY + 7 * 60_000;
    armHuntClocks(gameSessionStartedAt);
    armDanteClocks(gameSessionStartedAt);
  }
  lastGamingSpecial = now;
  saveGamingClocks();
  dbg(
    `game session ${canResume ? "resumed" : "started"}: source=${source} ` +
      `elapsed=${Math.floor((now - gameSessionStartedAt) / 1000)}s`,
  );
  if (isKael()) void ensureKaelCombatReady(canResume ? "game resumed" : "game started");
}

function noteGamingHeartbeat() {
  if (!gameSessionStartedAt) {
    startGamingSession("heartbeat");
    return;
  }
  const now = Date.now();
  gamingUntil = now + 60_000;
  localStorage.setItem(GAME_SESSION_HEARTBEAT_KEY, String(now));
}

function clearGamingSession() {
  if (!gameSessionStartedAt) return;
  dbg(`game session ended after ${Math.floor((Date.now() - gameSessionStartedAt) / 60_000)}m`);
  gameSessionStartedAt = 0;
  localStorage.removeItem(GAME_SESSION_START_KEY);
  localStorage.removeItem(GAME_SESSION_HEARTBEAT_KEY);
  localStorage.removeItem(GAME_SESSION_CLOCKS_KEY);
  for (const c of HUNT_CLOCKS) c.last = 0;
  lastGamingDevil = 0;
  lastGamingSword = 0;
  lastDanteSpin = 0;
  lastDanteCoin = 0;
  lastDantePizza = 0;
  if (isKael()) {
    kaelPendingStow = true;
    void ensureKaelWeaponDormant("game ended");
  }
}
// Media session: stay turned toward the monitor while video/music is detected.
let mediaUntil = 0;
const MEDIA_HEARTBEAT_GRACE = 45_000;
let mediaWatching = false;
let mediaDemoUntil = 0;
let manualMediaPauseUntil = 0;
const CORVIN_MEDIA_RIFT_AFTER_MS = 4 * 60_000;
const CORVIN_MEDIA_RIFT_DEMO_AFTER_MS = 4_000;
const CORVIN_MEDIA_RIFT_AWAY_MS = 4_000;
const CORVIN_MEDIA_EAT_MS = 10_000;
const CORVIN_MEDIA_LINE_MIN_MS = 10 * 60_000;
const CORVIN_MEDIA_LINE_MAX_MS = 20 * 60_000;
const CORVIN_MEDIA_SWORD_REST_MIN_MS = 12 * 60_000;
const CORVIN_MEDIA_SWORD_REST_MAX_MS = 20 * 60_000;
const CORVIN_MEDIA_SWORD_REST_MS = 3 * 60_000;
const CORVIN_MEDIA_SWORD_REST_DEMO_AFTER_MS = 30_000;
const CORVIN_MEDIA_SWORD_REST_DEMO_MS = 8_000;
const KAEL_MEDIA_GLANCE_AFTER_MS = 4 * 60_000;
const KAEL_MEDIA_GLANCE_DEMO_AFTER_MS = 12_000;
const gamingActive = () => Date.now() < gamingUntil;
// A game in the FOREGROUND (fullscreen) — the only gaming state that beats the
// shared-screen watch. Background Steam keeps the hunt clocks, not the veto.
let gamingFgUntil = 0;
const gamingForeground = () => Date.now() < gamingFgUntil;

// Quiet hour (tray item): he mutes every optional beat until it expires.
// Rituals honour it too — a "don't disturb" that actually means it.
let quietUntil = 0;
const quietNow = () => Date.now() < quietUntil;
function beatReady(): boolean {
  return (
    !!home &&
    !gagActive &&
    !showcasing &&
    !introActive &&
    !away &&
    !returning &&
    !wandering &&
    !committed() &&
    !quietNow()
  );
}

// Sword combo joins the gaming rotation the moment its art exists
// (public/pixel/sword/frame_0..7 — see scripts/gen_anim.py). Probed at boot;
// while the art is missing it's guns only.
// Sword beat (the full DMC move, user-directed): fire summon -> turns left ->
// two raise-and-strike slashes, each launching a red energy wave -> settle ->
// turns back -> the fire swallows the sword. Ends front-standing.
const SWORD = clip("swordmove", 100, false, 38, 39);
SWORD.msSeq = [
  110, 110, 110, 110, 110, 110, 110, 110, 110, 140, 140, 140, 140, // summon
  140, 180, // turn
  120, 70, 60, 85, 85, 85, // strike 1 + wave 1
  90, 110, 65, 60, 85, 85, 85, // strike 2 + wave 2
  110, 110, 110, // settle
  140, // turn back
  90, 90, 90, 90, 90, 90, 90, // fire swallows the sword
];
preloadClips([SWORD]);
let swordReady = false;
{
  const probe = new Image();
  probe.onload = () => (swordReady = true);
  probe.src = SWORD.frames[0];
}

// The full sword move with its soundtrack timed to the msSeq: fire ignites at
// the summon flash, a whoosh per strike, embers at the vanish.
async function playSwordMove() {
  startClip(SWORD);
  // Sound offsets scale with the mood pace or the whooshes drift off-frame.
  const p = paceMul();
  window.setTimeout(sfxIgnite, 550 * p); // embers gather
  window.setTimeout(sfxSlashWhoosh, 1990 * p); // strike 1
  window.setTimeout(sfxSlashWhoosh, 2580 * p); // strike 2
  window.setTimeout(sfxEmberFizz, 3450 * p); // the sword burns away
  await sleep(SWORD.msSeq!.reduce((a, b) => a + b, 0) * p);
}

// Demo helpers: play a seated one-shot in place, or the standing fiery twirl.
async function demoSeated(c: Clip, line?: string) {
  if (!home || gagActive || !isDante()) return;
  gagActive = true;
  try {
    stage.dataset.state = "idle";
    await ensureDantePosture(true);
    if (line) showBubble(line, PRIO.NOTABLE);
    startClip(c);
    await sleep(danteClipTotal(c) + 80);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

async function demoSpin() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    await standUp();
    startClip(SWORDSPIN);
    window.setTimeout(sfxIgnite, 300 * paceMul());
    await sleep(danteClipTotal(SWORDSPIN) + 200);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

// ---- Corvin showcase (`echo corvin > ~/.echo/demo`) ------------------------
// The Sentinel's full first sheet on the taskbar, timed per corvin.ts: entry,
// bow, charge, execution, shadow aura, storyteller, guitar, vigil, Artsiv
// cycle, meditation, exit. A rehearsal for the character pack — Dante's stage,
// Corvin's reel.
async function playCorvin(c: (typeof CORVIN)[keyof typeof CORVIN], passes = 1) {
  // Await the same scaled duration frameLoop renders. Otherwise the director
  // can replace a slow clip before its final frames have reached the screen.
  const total = corvinClipTotal(c) * paceMul(c as Clip) * passes;
  commitFor(total + 300); // session events must not flash Dante mid-reel
  // Paint frame zero immediately. Waiting for the breathing RAF observer made
  // short links inherit part of the previous clip's hold and look disconnected.
  startClip(c as Clip);
  await sleep(total);
}

async function demoCorvin() {
  if (!home || gagActive) return;
  gagActive = true;
  afterClip = null; // a stale idle-cycle callback must not steal the reel
  try {
    stage.dataset.state = "idle";
    await standUp();
    showBubble("Corvin. The Sentinel.", PRIO.NOTABLE);
    // Exercise both walk sheets with real root motion. The old reel played two
    // cycles in place, which looked like a frozen/gliding character.
    const reviewX = Math.max(home.ox + 8, home.cornerX - Math.min(420, home.winW));
    stage.dataset.facing = "left";
    startClip(CORVIN.walkout as Clip);
    await slideFootstepWindow(reviewX, CORVIN.walkout, 125);
    stage.dataset.facing = "right";
    startClip(CORVIN.walkin as Clip);
    await slideFootstepWindow(home.cornerX, CORVIN.walkin, 125);
    delete stage.dataset.facing;
    await playCorvin(CORVIN.bow);
    await playCorvin(CORVIN.idle);
    await playCorvin(CORVIN.charge); // the blade ignites
    await playCorvin(CORVIN.execraise); // execution: slow raise...
    await playCorvin(CORVIN.execstrike); // ...one devastating cut
    await playCorvin(CORVIN.aurarise); // the shadow monarch aura
    await playCorvin(CORVIN.auraburn, 2);
    await playCorvin(CORVIN.aurasink);
    await ensureCorvinSeated("showcase story");
    showBubble("The bird thinks your code is sloppy.", PRIO.NOTABLE);
    await playCorvin(CORVIN.whetstone, 2); // storyteller strokes
    await playCorvin(CORVIN.guitar, 3); // the YouTube moment
    await ensureCorvinStanding("showcase vigil");
    await playCorvin(CORVIN.idle); // neutral beat before the vigil
    await playCorvin(CORVIN.kneeldown);
    await playCorvin(CORVIN.eaglehop);
    await playCorvin(CORVIN.kneelrise);
    await playCorvin(CORVIN.takeoff); // Artsiv flies...
    await sleep(900);
    await playCorvin(CORVIN.landing); // ...and returns
    await ensureCorvinSeated("showcase meditation");
    await playCorvin(CORVIN.meditate, 2);
  } finally {
    await ensureCorvinStanding("showcase exit");
    delete stage.dataset.facing;
    gagActive = false;
    finishSceneIdle("corvin showcase");
  }
}

// ---- Corvin scenes (the pack's behaviour layer) ------------------------------
// Same engine, the sentinel's answers: Execution for Jackpot, Unchained for the
// Devil Trigger, the vigil for a breakdown, guitar for the плакат, the watch
// and the arcane scan for gaming, tales over the whetstone, a nuzzle for
// milestones. Every scene runs through the one gag gate and ends back in idle.
// Corvin is silent by design (user-directed): no ambient lines, no win/error
// commentary. His words live exclusively in the stories (tales / novel /
// midnight), voiced through tellStory below.

// ---- Story voice (user-directed): байки звучат ГОЛОСОМ и не прерываются -----
// The system TTS (WebView2 -> Windows voices). Cyrillic lines pick a Russian
// voice, everything else English; low pitch, unhurried rate — a worn sentinel.
// While a story runs the nuzzle loop plays and a rolling commit + gagActive
// keep every other system out until the last word is spoken.
let ttsVoices: SpeechSynthesisVoice[] = [];
function initTts() {
  const load = () => {
    ttsVoices = window.speechSynthesis?.getVoices() ?? [];
  };
  load();
  window.speechSynthesis?.addEventListener?.("voiceschanged", load);
}
// Corvin's voice is PRE-RENDERED with a neural TTS (scripts/gen_voice_corvin.py)
// and shipped in public/voice/corvin: every line he owns is fixed text, so the
// robot system voice is only ever a fallback for something unrecorded.
const corvinVoice = new Map<string, string>(); // sha1(text) -> file
const CORVIN_STORY_RATE = 1.5; // user-directed: Corvin's authored speech at 1.5x
const CORVIN_VOICE_CAP_MS = 30_000;
async function initCorvinVoice() {
  try {
    const r = await fetch("/voice/corvin/index.json");
    if (!r.ok) return;
    const idx = (await r.json()) as Record<string, { f: string }>;
    for (const [k, v] of Object.entries(idx)) corvinVoice.set(k, `/voice/corvin/${v.f}`);
    dbg(`corvin voice: ${corvinVoice.size} clips`);
  } catch {
    /* no pack -> system voice */
  }
}
// Same hash the renderer used (SHA-1, first 16 hex chars).
async function voiceKey(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
async function playVoiceClip(text: string): Promise<boolean> {
  if (!corvinVoice.size) return false;
  const url = corvinVoice.get(await voiceKey(text));
  if (!url) return false;
  return new Promise<boolean>((res) => {
    const a = new Audio(url);
    a.volume = 0.95;
    a.playbackRate = CORVIN_STORY_RATE;
    let done = false;
    let cap: number | undefined;
    const fin = (ok: boolean, stop = false) => {
      if (!done) {
        done = true;
        if (cap) window.clearTimeout(cap);
        a.onended = null;
        a.onerror = null;
        if (stop) a.pause();
        res(ok);
      }
    };
    a.onended = () => fin(true);
    a.onerror = () => fin(false, true);
    void a.play().catch(() => fin(false, true));
    // A corrupt or unexpectedly long file must never bleed into the next line.
    cap = window.setTimeout(() => fin(true, true), CORVIN_VOICE_CAP_MS);
  });
}

async function speakLine(text: string): Promise<void> {
  if (isCorvin() && (await playVoiceClip(text))) return; // the real voice
  return speakLineSystem(text);
}

function speakLineSystem(text: string): Promise<void> {
  return new Promise((res) => {
    const synth = window.speechSynthesis;
    if (!synth) {
      window.setTimeout(res, 2600); // no TTS -> bubble pacing only
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const ru = /[А-Яа-яЁё]/.test(text);
    // A sentinel needs a MAN's voice: prefer the male system voices by name,
    // fall back to any voice of the right language.
    const male = ru ? ["pavel", "dmitry", "artem"] : ["david", "mark", "guy", "james", "ryan"];
    const pool = ttsVoices.filter((x) => x.lang.toLowerCase().startsWith(ru ? "ru" : "en"));
    const v =
      pool.find((x) => male.some((m) => x.name.toLowerCase().includes(m))) ?? pool[0] ?? null;
    if (v) u.voice = v;
    u.rate = 0.88 * CORVIN_STORY_RATE;
    u.pitch = 0.42; // deep, worn, powerful
    u.volume = 1.0;
    let done = false;
    let cap: number | undefined;
    const finish = (cancel = false) => {
      if (!done) {
        done = true;
        if (cap) window.clearTimeout(cap);
        if (cancel) synth.cancel();
        res();
      }
    };
    u.onend = () => finish();
    u.onerror = () => finish();
    synth.speak(u);
    cap = window.setTimeout(() => finish(true), CORVIN_VOICE_CAP_MS);
  });
}

async function speakCorvinStoryLine(text: string): Promise<void> {
  // tellStory supplies the real neural voice. Suppress showBubble's generic
  // Dante blip and keep the text visible for the complete spoken line.
  showBubble(text, PRIO.NOTABLE, CORVIN_VOICE_CAP_MS + 1000, false);
  await speakLine(text);
}

// The storytelling pose: the nuzzle replayed as a loop — Artsiv stays close
// while he talks (user-directed).
const NUZZLE_LOOP: Clip = { ...(CORVIN.nuzzle as Clip), loop: true, settle: 0 };
// Seated poses he can be telling a story FROM; going straight to the standing
// nuzzle from one of these read as "he broke the animation and jumped up"
// (user-reported on the midnight guitar). Stand up properly first.
const SEATED_CLIPS = new Set<Clip>([
  CORVIN.sit as Clip,
  CORVIN.guitar as Clip,
  CORVIN.whetstone as Clip,
  CORVIN.meditate as Clip,
]);
async function tellStory(lines: string[], title?: string, pose?: Clip) {
  const target = pose ?? NUZZLE_LOOP;
  if (SEATED_CLIPS.has(curClip) && !SEATED_CLIPS.has(target)) {
    commitFor(2000);
    corvinSeatedNow = false;
    corvinQuietPose = "watch";
    curClip = CORVIN_SIT_REV; // rise first — no teleporting to his feet
    frameIdx = 0;
    afterClip = null;
    await sleep(corvinClipTotal(CORVIN_SIT_REV) * paceMul(CORVIN_SIT_REV));
  }
  curClip = target;
  frameIdx = 0;
  afterClip = null;
  if (title) {
    commitFor(20_000);
    await speakCorvinStoryLine(title);
    await sleep(400);
  }
  for (const l of lines) {
    commitFor(20_000); // rolling commit: nothing yanks the clip mid-sentence
    await speakCorvinStoryLine(l);
    await sleep(350);
  }
  hideBubbleAfter(1200);
  commitFor(400); // release quickly once the story is told
}

async function corvinScene(body: () => Promise<void>, accent?: string) {
  // The intro walk and the away/return walks OWN the window position — a scene
  // firing mid-walk used to anchor itself mid-screen and leave him stranded
  // there (the "standing in the middle of the desktop" bug).
  if (!home || gagActive || introActive || wandering || away || returning) {
    dbg(
      `corvin scene refused: home=${!!home} gag=${gagActive} intro=${introActive} com=${committed()}`,
    );
    return;
  }
  dbg("corvin scene start");
  gagActive = true;
  afterClip = null;
  try {
    stage.dataset.state = "idle";
    if (accent) document.documentElement.style.setProperty("--accent", accent);
    await standUp();
    await body();
  } finally {
    // Every Corvin Director scene owns a standing contract. If its body used a
    // seated prop/pose and forgot the exit link, repair it here before idle.
    await ensureCorvinStanding("scene exit");
    corvinQuietPose = "watch";
    gagActive = false;
    finishSceneIdle("corvin scene");
  }
}

function beginKaelMode(mode: KaelMode): number {
  kaelMode = mode;
  kaelModeToken += 1;
  dbg(`kael mode=${mode} token=${kaelModeToken} weapon=${kaelWeaponForm}`);
  return kaelModeToken;
}

const kaelModeCurrent = (token: number, mode?: KaelMode) =>
  isKael() && token === kaelModeToken && (!mode || kaelMode === mode);

const KAEL_MODE_CANCELLED = Symbol("kael-mode-cancelled");
type KaelModePlay = (c: CorvinClip, passes?: number) => Promise<void>;

function requireKaelMode(token: number) {
  if (!kaelModeCurrent(token)) throw KAEL_MODE_CANCELLED;
}

function startKaelModeClip(token: number, c: CorvinClip) {
  requireKaelMode(token);
  startClip(c as Clip);
}

async function playKaelMode(token: number, c: CorvinClip, passes = 1, commit = true) {
  requireKaelMode(token);
  const total = kaelClipTotal(c) * passes;
  if (commit) commitFor(total + 300);
  startKaelModeClip(token, c);
  await sleep(total);
  requireKaelMode(token);
}

function settleKaelMode(token: number, source: string) {
  if (!kaelModeCurrent(token)) return;
  committedUntil = 0;
  const combat = gamingActive() && kaelWeaponForm === "sword";
  kaelMode = combat ? "combat" : "idle";
  startClip((combat ? KAEL.combat_idle_v2 : KAEL.breathe) as Clip);
  dbg(`${source} -> ${kaelMode} weapon=${kaelWeaponForm}`);
  window.setTimeout(() => {
    if (kaelPendingStow) void ensureKaelWeaponDormant("pending stow");
    else if (kaelPendingDraw) void ensureKaelCombatReady("pending draw");
  }, 0);
}

async function kaelWorkSession() {
  if (kaelWorkTask || !home || !isKael() || gagActive || introActive || away || returning) return;
  const token = beginKaelMode("work");
  kaelWorkTask = (async () => {
    await playKaelMode(token, KAEL.work_enter, 1, false);
    while (kaelModeCurrent(token, "work") && Date.now() < typingUntil && !gagActive) {
      await playKaelMode(token, KAEL.typing_runes, 1, false);
    }
    if (!kaelModeCurrent(token, "work") || gagActive) return;
    await playKaelMode(token, KAEL.work_exit, 1, false);
    settleKaelMode(token, "kael work");
  })().catch((error) => {
    if (error !== KAEL_MODE_CANCELLED) throw error;
    dbg(`kael work cancelled token=${token}`);
  }).finally(() => {
    kaelWorkTask = null;
  });
  await kaelWorkTask;
}

async function ensureKaelCombatReady(source: string): Promise<boolean> {
  if (!isKael() || !home || away || returning) return false;
  if (kaelWeaponForm === "sword") {
    kaelPendingDraw = false;
    return true;
  }
  if (gagActive || introActive || wandering) {
    kaelPendingDraw = true;
    dbg(`kael draw deferred: ${source}`);
    return false;
  }
  kaelPendingDraw = false;
  kaelPendingStow = false;
  const token = beginKaelMode("scene");
  gagActive = true;
  try {
    await playKaelMode(token, KAEL.weapon_draw_sword);
    kaelWeaponForm = "sword";
    return true;
  } catch (error) {
    if (error !== KAEL_MODE_CANCELLED) throw error;
    return false;
  } finally {
    if (kaelModeCurrent(token)) {
      gagActive = false;
      kaelMode = "combat";
      startClip(KAEL.combat_idle_v2 as Clip);
      dbg(`kael Rift ready: ${source}`);
    }
  }
}

async function ensureKaelWeaponDormant(source: string): Promise<boolean> {
  if (!isKael() || !home) return false;
  if (kaelWeaponForm === "dormant") {
    kaelPendingStow = false;
    return true;
  }
  if (gagActive || introActive || wandering || away || returning) {
    kaelPendingStow = true;
    dbg(`kael stow deferred: ${source}`);
    return false;
  }
  kaelPendingStow = false;
  kaelPendingDraw = false;
  const token = beginKaelMode("scene");
  gagActive = true;
  try {
    if (kaelWeaponForm === "scythe") await playKaelMode(token, KAEL.fullweapon_v2);
    await playKaelMode(token, REV(KAEL.weapon_draw_sword));
    kaelWeaponForm = "dormant";
    return true;
  } catch (error) {
    if (error !== KAEL_MODE_CANCELLED) throw error;
    return false;
  } finally {
    if (kaelModeCurrent(token)) {
      gagActive = false;
      settleKaelMode(token, `kael stow: ${source}`);
    }
  }
}

async function kaelScene(body: (play: KaelModePlay, token: number) => Promise<void>, accent?: string) {
  if (!home || gagActive || introActive || wandering || away || returning) {
    dbg(
      `kael scene refused: home=${!!home} gag=${gagActive} intro=${introActive} com=${committed()}`,
    );
    return;
  }
  dbg("kael scene start");
  const token = beginKaelMode("scene");
  gagActive = true;
  afterClip = null;
  try {
    stage.dataset.state = "idle";
    delete stage.dataset.facing;
    if (accent) document.documentElement.style.setProperty("--accent", accent);
    await standUp();
    requireKaelMode(token);
    const play: KaelModePlay = (c, passes = 1) => playKaelMode(token, c, passes);
    await body(play, token);
  } catch (error) {
    if (error !== KAEL_MODE_CANCELLED) throw error;
    dbg(`kael scene cancelled token=${token}`);
  } finally {
    if (kaelModeCurrent(token)) {
      delete stage.dataset.facing;
      gagActive = false;
      settleKaelMode(token, "kael scene");
    }
  }
}

async function kaelLightSuccess() {
  await kaelScene(async (play) => {
    await play(kaelWeaponForm === "sword" ? KAEL.combat_idle_v2 : KAEL.success_v2);
  }, ACCENT.success);
}

async function kaelStreakScene() {
  if (!(await ensureKaelCombatReady("streak"))) return;
  await kaelScene(async (play) => {
    await play(KAEL.streak_v2);
  }, ACCENT.success);
  if (!gamingActive()) await ensureKaelWeaponDormant("streak complete");
}

async function kaelLightError() {
  await kaelScene(async (play) => {
    sfxTendrilWhip();
    await play(kaelWeaponForm === "sword" ? KAEL.combat_idle_v2 : KAEL.error_v2);
  }, ACCENT.error);
}

async function kaelOverloadScene() {
  await kaelScene(async (play) => {
    sfxAura();
    await play(KAEL.overload_v2);
  }, ACCENT.error);
}

async function kaelGameReadyScene() {
  await ensureKaelCombatReady("game ready");
}

async function kaelHuntLoopPass() {
  if (!(await ensureKaelCombatReady("hunt watch"))) return;
  await kaelScene(async (play) => {
    await play(KAEL.combat_idle_v2, 2);
  }, ACCENT.success);
}

async function kaelFullWeaponScene() {
  if (!(await ensureKaelCombatReady("full weapon"))) return;
  await kaelScene(async (play) => {
    sfxIgnite();
    kaelWeaponForm = "scythe";
    await play(KAEL.fullweapon_v2);
    kaelWeaponForm = "sword";
  }, ACCENT.success);
  if (!gamingActive()) await ensureKaelWeaponDormant("full weapon complete");
}

async function kaelRestScene() {
  await kaelScene(async (play) => {
    await play(KAEL.rest_enter);
    await play(KAEL.rest_loop_v2, 2);
    await play(REV(KAEL.rest_enter));
  });
}

async function kaelSwordPlantScene(holdMs = 3 * 60_000) {
  await kaelScene(async (play) => {
    await play(KAEL.swordplant);
    commitFor(holdMs + 500);
    await sleep(holdMs);
    await play(REV(KAEL.swordplant));
  });
}

async function kaelRepairScene() {
  await kaelScene(async (play) => {
    await play(KAEL.work_enter);
    await play(KAEL.work_loop_v2, 3);
    await play(KAEL.work_exit);
  });
}

async function kaelVoidStitchScene() {
  await kaelScene(async (play) => {
    sfxClawScrape();
    await play(KAEL.voidstitch_alarm);
    kaelWeaponForm = "scythe";
    await play(KAEL.voidstitch_pull);
    await play(KAEL.voidstitch_seal);
    kaelWeaponForm = gamingActive() ? "sword" : "dormant";
  }, ACCENT.error);
}

const KAEL_ORGAN_TRACK_URL = "/media/kael-passacaglia.mp3";

// No плакат gif here either (user-directed, same reason as Corvin): it is a
// Dante dance loop, and Kael's organ is already a composed 36-second piece with
// its own track. The performance is the answer to the video.
async function kaelVoidOrganScene(_songBeat = false) {
  await kaelScene(async (_play, token) => {
    const audio = new Audio(KAEL_ORGAN_TRACK_URL);
    audio.preload = "auto";
    audio.volume = 0.52;
    audio.load();
    let soundtrackRunning = false;
    const playFor = async (c: CorvinClip, durationMs: number) => {
      startKaelModeClip(token, c);
      commitFor(durationMs + 400);
      const until = performance.now() + durationMs;
      while (performance.now() < until) {
        requireKaelMode(token);
        await sleep(Math.min(80, Math.max(12, until - performance.now())));
      }
    };

    try {
      // The first eleven seconds are a silent ritual. Music belongs to the
      // instrument, so it cannot begin while Kael is still standing or while
      // the keys are assembling.
      await playFor(KAEL.organ_sense_v2, 5_000); // eye, arm segments, platypus
      await playFor(KAEL.organ_summon_v2, 6_000); // crack -> keys -> pipes -> seated

      // Start the first playing frame and the Audio element in the same event
      // turn. From here the soundtrack clock owns every remaining boundary.
      startKaelModeClip(token, KAEL.organ_play_v2);
      let performanceStart = performance.now();
      try {
        const startAudio = audio.play();
        performanceStart = performance.now();
        await startAudio;
        soundtrackRunning = true;
        performanceStart = performance.now() - audio.currentTime * 1000;
        dbg("kael organ soundtrack started at seated first note");
      } catch {
        dbg("kael organ soundtrack unavailable -> performance wall clock");
      }
      // His own track is registered with the OS media session; claim it so the
      // watcher does not read it back as "music started" and stage a second beat.
      ownedMediaUntil = Date.now() + 40_000;

      const positionMs = () => {
        if (soundtrackRunning && !audio.paused && !audio.ended) return audio.currentTime * 1000;
        return performance.now() - performanceStart;
      };
      const waitUntil = async (endSec: number, fadeAudio = false) => {
        commitFor(Math.max(0, endSec * 1000 - positionMs()) + 400);
        while (positionMs() < endSec * 1000) {
          requireKaelMode(token);
          if (fadeAudio && soundtrackRunning) {
            const left = Math.max(0, endSec * 1000 - positionMs());
            audio.volume = 0.52 * Math.min(1, left / 4000);
          }
          await sleep(Math.min(80, Math.max(12, endSec * 1000 - positionMs())));
        }
      };
      const playUntil = async (c: CorvinClip, endSec: number, fadeAudio = false) => {
        startKaelModeClip(token, c);
        await waitUntil(endSec, fadeAudio);
      };

      await waitUntil(20); // seamless living performance loop, already started
      await playUntil(KAEL.organ_memory_v3, 28); // three knights, hands still play
      await playUntil(KAEL.organ_platypus_v2, 32); // one pedal, one softened glance
      await playUntil(KAEL.organ_fade_v3, 36, true); // visible dissolve + weighted rise -> idle
    } finally {
      audio.pause();
      audio.currentTime = 0;
    }
  }, ACCENT.success);
}

// Developer-only contact reel. It never enters the user menu and deliberately
// excludes the already-approved 47-second organ film.
async function kaelReviewScene() {
  if (!home || !isKael() || gagActive || introActive || wandering || away || returning) return;
  const token = beginKaelMode("scene");
  const restoreWeapon: KaelWeaponForm = gamingActive() ? "sword" : "dormant";
  gagActive = true;
  afterClip = null;
  try {
    stage.dataset.state = "idle";
    delete stage.dataset.facing;
    const play: KaelModePlay = (c, passes = 1) => playKaelMode(token, c, passes);
    await play(KAEL.idle_v2, 2);
    await play(KAEL.scarf_adjust);
    await play(KAEL.armcheck_v2);
    await play(KAEL.platypus_v2);
    await play(KAEL.work_enter);
    await play(KAEL.work_loop_v2, 2);
    await play(KAEL.work_exit);
    await play(KAEL.success_v2);
    await play(KAEL.error_v2);
    await play(KAEL.search_v2);
    await play(KAEL.overload_v2);
    await play(KAEL.weapon_draw_sword);
    kaelWeaponForm = "sword";
    await play(KAEL.combat_idle_v2, 2);
    await play(KAEL.streak_v2);
    kaelWeaponForm = "scythe";
    await play(KAEL.fullweapon_v2);
    kaelWeaponForm = "sword";
    await play(REV(KAEL.weapon_draw_sword));
    kaelWeaponForm = "dormant";
    await play(KAEL.watch_enter_v3);
    await play(KAEL.watch_loop_v3, 2);
    await play(REV(KAEL.watch_enter_v3));
    await play(KAEL.rest_enter);
    await play(KAEL.rest_loop_v2, 2);
    await play(REV(KAEL.rest_enter));
    await play(KAEL.night_enter_v2);
    await play(KAEL.night_loop_v2, 2);
    await play(KAEL.night_glance_v2);
    await play(REV(KAEL.night_enter_v2));
    await play(KAEL.voidstitch_alarm);
    kaelWeaponForm = "scythe";
    await play(KAEL.voidstitch_pull);
    await play(KAEL.voidstitch_seal);
    kaelWeaponForm = "dormant";
    await play(KAEL.leave_v2);
    await play(KAEL.return_v2);
  } catch (error) {
    if (error !== KAEL_MODE_CANCELLED) throw error;
    dbg(`kael review cancelled token=${token}`);
  } finally {
    if (kaelModeCurrent(token)) {
      kaelWeaponForm = restoreWeapon;
      gagActive = false;
      settleKaelMode(token, "kael review");
    }
  }
}

// Execution — the win payoff: slow raise, tension, one devastating cut.
async function executionScene() {
  await corvinScene(async () => {
    await playCorvin(CORVIN.execraise);
    window.setTimeout(() => {
      shake(420);
      sfxIgnite();
    }, 230 * paceMul()); // the slam lands 3 frames into the strike
    await playCorvin(CORVIN.execstrike);
    await windedTail(); // and then he has to breathe
  }, ACCENT.success);
}

// Unchained — the Devil Trigger: crimson blade, crouch, the shadow tower.
async function unchainedScene() {
  await corvinScene(async () => {
    vignettePulse();
    sfxAura();
    window.setTimeout(sfxDemonRoar, 900 * paceMul());
    await playCorvin(CORVIN.unchrise);
    shake(500);
    await playCorvin(CORVIN.unchburn, 2);
    await playCorvin(CORVIN.unchsink);
  }, ACCENT.error);
}

// The vigil — his breakdown: no rage, a knee, the eagle, and back up.
async function vigilScene() {
  await corvinScene(async () => {
    await playCorvin(CORVIN.kneeldown);
    await playCorvin(CORVIN.eaglehop);
    await playCorvin(CORVIN.kneelrise);
  });
}

// Разрубание — the full combo (gaming's sword beat and rare win flourish).
async function cleaveScene() {
  await corvinScene(async () => {
    await playCorvin(CORVIN.cleaveprep);
    sfxIgnite();
    await playCorvin(CORVIN.cleaveslash);
    window.setTimeout(() => shake(460), 190 * paceMul()); // ground impact
    await playCorvin(CORVIN.cleavesmash);
    await playCorvin(CORVIN.cleaverecover);
    await windedTail();
  }, ACCENT.success);
}

// The warm beat: Artsiv preens his hair. Milestones only — it must stay rare.
async function nuzzleScene() {
  await corvinScene(async () => {
    await playCorvin(CORVIN.nuzzle);
    await playCorvin(CORVIN.idle);
  });
}

// Sitting down to play, properly (user-directed): sit with the sword, banish
// the blade into shadow, lift the guitar off the floor — THEN music. Leaving
// runs the same two clips backwards, so the guitar goes down and the sword
// reassembles out of the motes. Returns the ms it took, so callers can start
// audio exactly on the first strum instead of over an empty lap.
const REV = (c: CorvinClip): Clip => ({
  frames: [...c.frames].reverse(),
  ms: c.ms,
  msSeq: c.msSeq ? [...c.msSeq].reverse() : undefined,
  loop: false,
  settle: c.frames.length - 1,
});
async function corvinTakeGuitar() {
  await ensureCorvinSeated("guitar");
  await playCorvin(CORVIN.swordaway); // the blade crumbles, tip first
  await playCorvin(CORVIN.guitartake); // reaches down, lifts it, Artsiv rises
}
async function corvinPutGuitar() {
  await playCorvin(REV(CORVIN.guitartake)); // guitar back to the floor
  await playCorvin(REV(CORVIN.swordaway)); // motes gather into steel again
}

// The плакат moment, Corvin's way: he sits and plays for the music you opened.
// NO gif and NO song.mp3 (user-directed). Both are Dante's плакат — the gif is
// literally a Dante dance loop — and hanging it over the Sentinel with Artsiv on
// his shoulder looked like another character's poster had wandered in. Corvin's
// answer to a video is the guitar itself.
async function guitarScene(durationMs: number) {
  await corvinScene(async () => {
    await corvinTakeGuitar();
    const passMs = corvinClipTotal(CORVIN.guitar) * paceMul(CORVIN.guitar as Clip);
    const passes = Math.max(2, Math.round(durationMs / passMs));
    await playCorvin(CORVIN.guitar, passes);
    await corvinPutGuitar();
  });
}

// The arcane perimeter scan (gaming's rare beat and the hunt's opening).
async function magicscanScene() {
  await corvinScene(async () => {
    sfxAura();
    await playCorvin(CORVIN.magicscan);
  });
}

// One quiet pass of the watch — gaming ambience between the big beats.
async function huntwatchPass() {
  await corvinScene(async () => {
    await playCorvin(CORVIN.huntwatch);
  });
}

// Tales: he remembers where he stopped (story.nextTale). Voiced, over the
// nuzzle loop, uninterruptible until the last word (user-directed).
async function whetstoneTaleScene() {
  await corvinScene(async () => {
    // nextTale() advances the never-repeat pointer and SAVES — it must only
    // run once the scene is actually on stage. Pulling it before corvinScene
    // burned a fragment forever every time the scene was refused (mid-gag).
    const tale = story.nextTale();
    if (tale) await tellStory(tale.lines);
    else await playCorvin(CORVIN.whetstone, 2); // corpus finished — quiet strokes
  });
}

// ---- Shared-screen media watch -----------------------------------------------
// The edge is remembered if another scene is running. Once free, the companion
// sits, turns toward the centre of the monitor, and remains in a subtle loop for
// as long as Rust keeps sending media heartbeats. Closing media plays the turn
// backwards; no menu or CLI action is required from ordinary users.
let mediaWanted = 0;
const DANTE_BORED_RIDE_AFTER_MS = 75_000;
// The original v0.2.4 full-width bike tour remains a second, much rarer film
// beat. It does not replace the newer boredom/fall scene above.
const DANTE_LEGACY_MOTO_AFTER_MS = 12 * 60_000;
function serviceMediaWish() {
  if (!mediaWanted || mediaWatching) return;
  if (Date.now() >= mediaUntil) {
    mediaWanted = 0;
    mediaSongWanted = 0;
    return;
  }
  const forcedDemo = Date.now() < mediaDemoUntil;
  // Stage busy — keep BOTH wishes and retry on the next heartbeat (every 3 s).
  if (!beatReady() || (gamingForeground() && !forcedDemo)) return;
  // The YouTube moment goes first, if it is still owed. It used to be decided
  // inline on the edge, which meant that opening a video while he was busy —
  // mid-intro, mid-scene — dropped it for good: the edge fires once, and the
  // heartbeats after it only ever asked for the watch. Remembering the wish is
  // the whole fix (the same bug the music edge had).
  if (mediaSongWanted && !forcedDemo) {
    mediaSongWanted = 0;
    if (Date.now() - lastWatchSongAt >= WATCH_SONG_GAP) {
      lastWatchSongAt = Date.now();
      markScene();
      dbg(`the YouTube moment: ${character}`);
      if (isCorvin()) void guitarScene(15_000);
      else if (isKael()) void kaelVoidOrganScene(true);
      else posterScene(15_000);
      return; // the shared watch follows on the next heartbeat
    }
  }
  mediaWanted = 0;
  markScene();
  dbg("media watch served");
  void mediaWatchScene();
}

// Dante's long-watch interruption: boredom, a clean exit beyond the nearest
// edge, one full-screen motorcycle pass, then a gravity-driven return. Mounting
// happens entirely off-screen; only the finished riding silhouette is shown.
async function danteVideoRideBeat(resumeWatch: () => boolean): Promise<boolean> {
  if (!home || !isDante()) return false;
  const h = home;
  dbg("dante ride: bored line");
  showBubble("Скучно.", PRIO.MAJOR, 2400);
  await sleep(2100);

  await playDante(reversedClip(DANTE_WATCH_TURN));
  const rise = reversedClip(SITDOWN);
  startClip(rise);
  seatedNow = false;
  postureChangedAt = Date.now();
  moveWindowY(h.y, 900);
  await sleep(danteClipTotal(rise) + 80);

  // His home is beside the clock, so the nearest believable exit is right.
  // The bike then returns from that same edge and crosses the whole monitor.
  const offRight = h.scrRight + 12;
  stage.dataset.facing = "right";
  playWalk();
  await slideFootstepWindow(offRight, WALK, DANTE_WALK_PACE, 0);
  dbg("dante ride: fully off-screen right");
  await sleep(550); // mounting remains fully beyond the screen edge

  const offLeft = h.ox - h.winW - 12;
  stage.dataset.facing = "left";
  startClip(DANTE_MOTORIDE);
  dbg("dante ride: motorcycle pass right-to-left");
  await rideWindow(offLeft, 520);
  dbg("dante ride: fully off-screen left");
  await sleep(260);

  // He has exited with the motorcycle. Re-enter as Dante alone from above.
  delete stage.dataset.facing;
  startClip(DANTE_DROP);
  dbg("dante ride: falling from monitor top");
  await dropWindowToTaskbar(1850);
  startClip(DANTE_CRASH);
  sfxThud();
  shake(380);
  dbg("dante ride: taskbar impact");
  await sleep(520);
  await new Promise<void>((resolve) => {
    moveWindowY(h.belowY, 650);
    window.setTimeout(resolve, 680);
  });
  stage.dataset.facing = "left";
  startClip(DANTE_RIDE_CLIMB);
  dbg("dante ride: climbing back over taskbar edge");
  await sleep(850);
  await new Promise<void>((resolve) => {
    moveWindowY(h.y, 1800);
    window.setTimeout(resolve, 1820);
  });
  delete stage.dataset.facing;

  startClip(SITDOWN);
  posture("idle", true);
  await sleep(danteClipTotal(SITDOWN) + 80);
  if (!resumeWatch()) {
    startClip(ANIMS_DANTE.idle);
    return false;
  }
  await playDante(DANTE_WATCH_TURN);
  startClip(DANTE_WATCH_LOOP);
  dbg("dante ride: resumed shared watch");
  return true;
}

async function danteVideoRideDemo() {
  if (!home || gagActive || !isDante()) return;
  gagActive = true;
  afterClip = null;
  try {
    stage.dataset.state = "idle";
    delete stage.dataset.facing;
    await ensureDantePosture(true);
    if (Math.abs(home.lastY - home.sitY) > 4) await sleep(820);
    await playDante(DANTE_WATCH_TURN);
    startClip(DANTE_WATCH_LOOP);
    await sleep(1400);
    const watching = await danteVideoRideBeat(() => true);
    if (watching) {
      await sleep(3000);
      await playDante(reversedClip(DANTE_WATCH_TURN));
    }
  } finally {
    gagActive = false;
    finishSceneIdle("dante video ride demo");
  }
}

async function danteLegacyMotoWatchBeat(resumeWatch: () => boolean): Promise<boolean> {
  if (!home || !isDante()) return false;
  const h = home;
  dbg("dante legacy motorcycle: leaving shared watch");
  await playDante(reversedClip(DANTE_WATCH_TURN));
  const rise = reversedClip(SITDOWN);
  startClip(rise);
  seatedNow = false;
  postureChangedAt = Date.now();
  moveWindowY(h.y, 900);
  await sleep(danteClipTotal(rise) + 80);

  await danteLegacyMotoTourBody();

  startClip(SITDOWN);
  posture("idle", true);
  await sleep(danteClipTotal(SITDOWN) + 80);
  if (!resumeWatch()) {
    startClip(ANIMS_DANTE.idle);
    return false;
  }
  await playDante(DANTE_WATCH_TURN);
  startClip(DANTE_WATCH_LOOP);
  dbg("dante legacy motorcycle: resumed shared watch");
  return true;
}

// Internal QA reel: the exact automatic watch entry, living loop and exit for
// all three companions. Character persistence is deliberately untouched.
async function videoReviewScene() {
  if (!home || gagActive || showcasing || introActive || wandering || away || returning) return;
  const original = character;
  const prepare = (next: "dante" | "corvin" | "kael") => {
    if (character === next) resetCharacterStage();
    else switchCharacter(next, false, false);
    gagActive = true;
    showcasing = true;
    afterClip = null;
    stage.dataset.state = "idle";
    delete stage.dataset.facing;
  };
  try {
    dbg("video review: Dante");
    prepare("dante");
    await sleep(450);
    await playDante(DANTE_WATCH_TURN);
    startClip(DANTE_WATCH_LOOP);
    await sleep(2800);
    await playDante(reversedClip(DANTE_WATCH_TURN));

    dbg("video review: Corvin");
    prepare("corvin");
    await sleep(450);
    await ensureCorvinSeated("video review");
    await playCorvin(CORVIN.watchturn);
    startClip(CORVIN.watchloop as Clip);
    await sleep(2800);
    await playCorvin(REV(CORVIN.watchturn));
    await ensureCorvinStanding("video review exit");

    dbg("video review: Kael");
    prepare("kael");
    await sleep(450);
    const token = beginKaelMode("watch");
    await playKaelMode(token, KAEL.watch_enter_v3);
    startKaelModeClip(token, KAEL.watch_loop_v3);
    await sleep(2800);
    await playKaelMode(token, REV(KAEL.watch_enter_v3));
  } finally {
    gagActive = false;
    showcasing = false;
    if (character === original) resetCharacterStage();
    else switchCharacter(original, false, false);
    if (original === "kael" && isKael() && gamingActive()) {
      window.setTimeout(() => void ensureKaelCombatReady("video review restore"), 0);
    }
    dbg("video review ended; original character restored");
  }
}

// Release QA sequence. It reuses the real scene functions and intentionally
// does not persist temporary character switches.
async function fullReviewScene() {
  if (!home || gagActive || showcasing || introActive || wandering || away || returning) return;
  const original = character;
  const restoreGamingSword = original === "kael" && gamingActive();
  const jump = async (next: "dante" | "corvin" | "kael") => {
    if (character === next) resetCharacterStage();
    else switchCharacter(next, false, false);
    await sleep(650);
  };
  try {
    dbg("full polish review: shared video scenes");
    await videoReviewScene();
    await sleep(1400);

    dbg("full polish review: Dante old and current scenes");
    await jump("dante");
    await danteReviewScene();
    await sleep(1400);
    await danteVideoRideDemo();
    await sleep(1400);
    await motoScene();
    await sleep(1400);

    dbg("full polish review: Corvin scenes");
    await jump("corvin");
    await demoCorvin();
    await sleep(1400);
    await doorFightScene(true);
    await sleep(1400);
    await nightWatchScene(true);
    await sleep(1400);

    dbg("full polish review: Kael connected scenes");
    await jump("kael");
    await kaelReviewScene();
  } finally {
    if (character === original) resetCharacterStage();
    else switchCharacter(original, false, false);
    if (restoreGamingSword && isKael()) {
      window.setTimeout(() => void ensureKaelCombatReady("full review restore"), 0);
    }
    dbg("full polish review ended; original character restored");
  }
}

async function corvinVideoRiftSnackBeat(resumeWatch: () => boolean): Promise<boolean> {
  if (!home || !isCorvin()) return false;
  const h = home;
  dbg("corvin media rift: small door opened at right edge");
  void riftGlow(13_000, { size: "small" });
  sfxAura();

  delete stage.dataset.facing;
  await playCorvin(REV(CORVIN.watchturn));
  await ensureCorvinStanding("media rift exit");
  await playCorvin(CORVIN.turnleft);

  const offRight = h.scrRight + 18;
  stage.dataset.facing = "right";
  playWalk(true);
  await slideFootstepWindow(offRight, CORVIN.walkout, 125);
  dbg("corvin media rift: fully inside");
  await sleep(CORVIN_MEDIA_RIFT_AWAY_MS);

  // He returns already carrying the food in a rear three-quarter walk. These
  // frames are authored toward screen-left, so mirroring would put his gaze and
  // demonic arm on the wrong side.
  delete stage.dataset.facing;
  startClip(CORVIN.bbqwalk as Clip);
  await slideFootstepWindow(h.cornerX, CORVIN.bbqwalk, 110);
  dbg("corvin media rift: returned after 4 seconds with barbecue in hand");

  await playCorvin(CORVIN.bbqsit);
  startClip(CORVIN.barbecue as Clip);
  commitFor(CORVIN_MEDIA_EAT_MS + 800);
  dbg("corvin media rift: eating barbecue for 10 seconds");
  await sleep(CORVIN_MEDIA_EAT_MS);
  await playCorvin(CORVIN.bbqfinish);

  if (!resumeWatch()) {
    await playCorvin(REV(CORVIN.watchturn));
    await ensureCorvinStanding("media rift end");
    return false;
  }
  startClip(CORVIN.watchloop as Clip);
  dbg("corvin media watch resumed after rift snack");
  return true;
}

async function holdWhileWatching(ms: number, resumeWatch: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!resumeWatch()) return false;
    await sleep(Math.min(1000, until - Date.now()));
  }
  return resumeWatch();
}

// During a long film he remains turned toward the screen, but settles against a
// stone with his sword planted and his demonic left arm resting on the hilt.
// If playback ends, the three-minute hold releases within one second.
async function corvinVideoSwordRestBeat(
  resumeWatch: () => boolean,
  holdMs: number,
): Promise<boolean> {
  if (!home || !isCorvin()) return false;
  dbg(`corvin media rear rest: seated for ${Math.round(holdMs / 1000)} seconds`);
  delete stage.dataset.facing;
  if (!resumeWatch()) return false;
  await playCorvin(CORVIN.mediarest);
  startClip(CORVIN.mediarestloop as Clip);
  const watchedThrough = await holdWhileWatching(holdMs, resumeWatch);
  await playCorvin(REV(CORVIN.mediarest));
  if (!watchedThrough || !resumeWatch()) {
    await playCorvin(REV(CORVIN.watchturn));
    await ensureCorvinStanding("media rest end");
    return false;
  }
  startClip(CORVIN.watchloop as Clip);
  dbg("corvin media rear rest: resumed shared watch");
  return true;
}

// THE YOUTUBE MOMENT. corvin.ts names it outright above CORVIN.guitartake —
// "the YouTube moment: guitar + Artsiv hovering" — and Dante's плакат is the
// same beat in his own language. So it belongs to the media EDGE, the instant
// the video opens, not to the end of the film: parking it on the exit meant it
// needed a 40-second sitting and an 8-minute gap just to be seen once, and in
// practice it never played at all.
//
// The watch is not lost by going first. `media_active` keeps arriving every
// 3 s, so serviceMediaWish starts the shared watch the moment the song lets go
// of the stage — greet the video, then sit down and watch it together.
// Held, not decided on the spot: serviceMediaWish plays it as soon as the stage
// is free (see there). The edge only records that it is owed.
let lastWatchSongAt = 0;
let mediaSongWanted = 0;
const WATCH_SONG_GAP = 8 * 60_000;

async function mediaWatchScene() {
  const forcedDemo = Date.now() < mediaDemoUntil;
  if (!home || gagActive || mediaWatching || (gamingForeground() && !forcedDemo)) return;
  const watchingCharacter = character;
  const watchStartedAt = Date.now();
  const watchingCorvin = isCorvin();
  const watchingKael = isKael();
  const watchingDante = isDante();
  mediaWatching = true;
  gagActive = true;
  const kaelWatchToken = watchingKael ? beginKaelMode("watch") : 0;
  afterClip = null;
  let corvinWatchingPose = watchingCorvin;
  let kaelWatchingPose = watchingKael;
  let danteWatchingPose = watchingDante;
  let danteRideDone = false;
  const danteRideAt = Date.now() + DANTE_BORED_RIDE_AFTER_MS;
  let danteLegacyMotoDone = false;
  const danteLegacyMotoAt = Date.now() + DANTE_LEGACY_MOTO_AFTER_MS;
  let kaelScreenGlanceDone = false;
  const kaelScreenGlanceAt = Date.now() +
    (forcedDemo ? KAEL_MEDIA_GLANCE_DEMO_AFTER_MS : KAEL_MEDIA_GLANCE_AFTER_MS);
  let corvinRiftDone = false;
  const corvinRiftAt = Date.now() + (forcedDemo ? CORVIN_MEDIA_RIFT_DEMO_AFTER_MS : CORVIN_MEDIA_RIFT_AFTER_MS);
  let corvinSwordRestDone = false;
  const corvinSwordRestAt = Date.now() +
    (forcedDemo
      ? CORVIN_MEDIA_SWORD_REST_DEMO_AFTER_MS
      : CORVIN_MEDIA_SWORD_REST_MIN_MS +
        Math.random() * (CORVIN_MEDIA_SWORD_REST_MAX_MS - CORVIN_MEDIA_SWORD_REST_MIN_MS));
  let corvinLineAt = Date.now() +
    (forcedDemo
      ? 61_000
      : CORVIN_MEDIA_LINE_MIN_MS +
        Math.random() * (CORVIN_MEDIA_LINE_MAX_MS - CORVIN_MEDIA_LINE_MIN_MS));
  try {
    stage.dataset.state = "idle";
    delete stage.dataset.facing;
    document.documentElement.style.setProperty("--accent", ACCENT.idle);

    if (watchingKael) {
      delete stage.dataset.facing;
      await playKaelMode(kaelWatchToken, KAEL.watch_enter_v3);
      startKaelModeClip(kaelWatchToken, KAEL.watch_loop_v3);
    } else if (watchingCorvin) {
      // Corvin's media watch uses true back-left frames. Do not mirror them.
      delete stage.dataset.facing;
      await ensureCorvinStanding("media watch entry");
      await ensureCorvinSeated("media watch");
      await playCorvin(CORVIN.watchturn);
      startClip(CORVIN.watchloop as Clip);
    } else {
      await ensureDantePosture(true);
      await playDante(DANTE_WATCH_TURN);
      startClip(DANTE_WATCH_LOOP);
    }

    while (
      Date.now() < mediaUntil &&
      (forcedDemo || !gamingForeground()) &&
      character === watchingCharacter
    ) {
      if (watchingCorvin && !corvinRiftDone && Date.now() >= corvinRiftAt) {
        corvinRiftDone = true;
        const resumed = await corvinVideoRiftSnackBeat(
          () =>
            Date.now() < mediaUntil &&
            (forcedDemo || !gamingForeground()) &&
            isCorvin(),
        );
        corvinWatchingPose = resumed;
        if (!resumed) break;
        continue;
      }
      if (watchingCorvin && !corvinSwordRestDone && Date.now() >= corvinSwordRestAt) {
        corvinSwordRestDone = true;
        const resumed = await corvinVideoSwordRestBeat(
          () =>
            Date.now() < mediaUntil &&
            (forcedDemo || !gamingForeground()) &&
            isCorvin(),
          forcedDemo ? CORVIN_MEDIA_SWORD_REST_DEMO_MS : CORVIN_MEDIA_SWORD_REST_MS,
        );
        corvinWatchingPose = resumed;
        if (!resumed) break;
        continue;
      }
      if (watchingCorvin && corvinWatchingPose && Date.now() >= corvinLineAt) {
        maybeCorvinRareLine();
        corvinLineAt = Date.now() + CORVIN_MEDIA_LINE_MIN_MS +
          Math.random() * (CORVIN_MEDIA_LINE_MAX_MS - CORVIN_MEDIA_LINE_MIN_MS);
        continue;
      }
      if (watchingDante && !danteRideDone && Date.now() >= danteRideAt) {
        danteRideDone = true;
        danteWatchingPose = await danteVideoRideBeat(
          () =>
            Date.now() < mediaUntil &&
            (forcedDemo || !gamingForeground()) &&
            isDante(),
        );
        continue;
      }
      if (watchingDante && !danteLegacyMotoDone && Date.now() >= danteLegacyMotoAt) {
        danteLegacyMotoDone = true;
        danteWatchingPose = await danteLegacyMotoWatchBeat(
          () =>
            Date.now() < mediaUntil &&
            (forcedDemo || !gamingForeground()) &&
            isDante(),
        );
        if (!danteWatchingPose) break;
        continue;
      }
      if (watchingKael && kaelWatchingPose && !kaelScreenGlanceDone && Date.now() >= kaelScreenGlanceAt) {
        kaelScreenGlanceDone = true;
        await playKaelMode(kaelWatchToken, KAEL.screen_glance);
        if (!kaelModeCurrent(kaelWatchToken, "watch")) break;
        startKaelModeClip(kaelWatchToken, KAEL.watch_loop_v3);
        continue;
      }
      if (watchingKael && kaelWatchingPose) {
        commitFor(1500);
        await sleep(1000);
        continue;
      }
      commitFor(1500);
      await sleep(1000);
    }

    if (watchingKael && kaelWatchingPose && kaelModeCurrent(kaelWatchToken, "watch")) {
      delete stage.dataset.facing;
      await playKaelMode(kaelWatchToken, REV(KAEL.watch_enter_v3));
      delete stage.dataset.facing;
    } else if (watchingCorvin && corvinWatchingPose) {
      delete stage.dataset.facing;
      await playCorvin(REV(CORVIN.watchturn));
      await ensureCorvinStanding("media watch exit");
      delete stage.dataset.facing;
    } else if (danteWatchingPose) {
      await playDante(reversedClip(DANTE_WATCH_TURN));
    }
  } catch (error) {
    if (error !== KAEL_MODE_CANCELLED) throw error;
    dbg(`kael media watch cancelled token=${kaelWatchToken}`);
  } finally {
    const staleKaelWatch = watchingKael && !kaelModeCurrent(kaelWatchToken);
    mediaWatching = false;
    mediaDemoUntil = 0;
    if (!staleKaelWatch && (watchingCorvin || watchingKael)) delete stage.dataset.facing;
    // A closed video or interrupted beat must never strand the companion in a
    // portal, above the taskbar, or between two physical window positions.
    if (home && !staleKaelWatch) {
      cancelAnimationFrame(winTween);
      winTween = 0;
      home.lastX = home.cornerX;
      home.lastY = home.y;
      await home.win
        .setPosition(new PhysicalPosition(home.cornerX, home.y))
        .catch(() => {});
    }
    if (!staleKaelWatch) {
      gagActive = false;
      if (watchingKael) settleKaelMode(kaelWatchToken, "media watch");
      else finishSceneIdle("media watch");
    }
    dbg(`media watch ended after ${Math.round((Date.now() - watchStartedAt) / 1000)}s`);
  }
}

// ---- Daily life (user-directed: more than YouTube and Steam) -----------------
// The day has a shape. Two layers:
//   * a once-per-day RITUAL on your first activity — dawn watch, evening care
//   * time-of-day flavour that tilts which idle urges he reaches for
// Both persist through ~/.echo/story.json, so "once a day" survives restarts.
type DayPart = "night" | "morning" | "day" | "evening";
function dayPart(): DayPart {
  const h = new Date().getHours();
  if (h < 5) return "night";
  if (h < 11) return "morning";
  if (h < 18) return "day";
  return "evening";
}

// His first appearance each calendar day gets a small ceremony — the thing that
// makes a companion feel like he lives with you rather than restarts with you.
function maybeDailyRitual() {
  if (!home || gagActive || showcasing || introActive || wandering || away || returning) return;
  if (quietNow()) return; // "rituals honour it too" — now they actually do
  const today = dateKey();
  if (story.s.lastRitualDay === today) return;
  if (!sceneAllowed()) return;
  story.s.lastRitualDay = today;
  story.save();
  const part = dayPart();
  dbg(`daily ritual (${part})`);
  markScene();
  if (isCorvin()) {
    if (part === "morning") {
      // Dawn watch: the aura burns off the night, then he takes his post.
      void corvinScene(async () => {
        await playCorvin(CORVIN.aurarise);
        await playCorvin(CORVIN.auraburn, 2);
        await playCorvin(CORVIN.aurasink);
        await playCorvin(CORVIN.bow);
      });
    } else if (part === "evening") {
      // Evening care: he sits down with the whetstone and tells you something.
      void whetstoneTaleScene();
    } else if (part === "night") {
      // Deep night: he sends Artsiv up to circle once, then stands watch.
      void artsivCycleScene();
    } else {
      void magicscanScene(); // midday: sweep the perimeter
    }
  } else if (isKael()) {
    // Kael had no branch at all and fell into Dante's, where demoSeated bails
    // on !isDante(). The day was still stamped and the scene gap still taken,
    // so his morning ceremony rendered NOTHING and could never retry.
    if (part === "night") void kaelRestScene();
    else void kaelRepairScene();
  } else {
    // Dante: a stretch and a word, then back to it.
    demoSeated(WAKEUP, part === "morning" ? "Morning." : "Alright. Where were we?");
  }
}

// ---- The novel (user-directed): 7+ minutes of typing earns a chapter --------
// He's been sharpening beside you the whole session; at the 7-minute mark he
// starts telling the next chapter of the 100-chapter novel — bubbles over the
// whetstone loop, one line every ~5 s (a chapter runs 40-90 s). Strictly
// sequential; ≥20 min between chapters so a long night doesn't dump the book.
let typingSessionStart = 0;
let lastTypingEventAt = 0;
const NOVEL_AFTER_TYPING_MS = 7 * 60 * 1000;
const NOVEL_MIN_GAP_MS = 20 * 60 * 1000;
let novelTelling = false;
function maybeTellNovel() {
  if (!isCorvin() || novelTelling || !home) return;
  if (Date.now() - typingSessionStart < NOVEL_AFTER_TYPING_MS) return;
  const lastAt = story.s.novel?.lastAt ?? 0;
  if (Date.now() - lastAt < NOVEL_MIN_GAP_MS) return;
  if (gagActive || showcasing || introActive || wandering || away || returning) return;
  const ch = story.nextNovelChapter();
  novelTelling = true;
  dbg(`novel chapter ${ch.idx}: ${ch.title}`);
  // Voiced, over the nuzzle loop, uninterruptible (user-directed).
  void corvinScene(async () => {
    await tellStory(ch.lines, `Глава ${ch.idx}. ${ch.title}.`);
  }).finally(() => {
    novelTelling = false;
  });
}

// ---- The midnight ritual -----------------------------------------------------
// At 00:00, once per night: he sits, plays ~/.echo/media/nightsong.mp3 on the
// guitar for ~30 s, and afterwards tells one fragment of the MIDNIGHT arc —
// the story of the letter that never came ("Anlatamam": "I cannot tell it").
// The arc lives outside the whetstone rotation; the ritual is how you earn it.
const NIGHT_SONG_MS = 60_000; // a full minute of playing (user-directed)
const NIGHT_AFTER_AURA_MS = 30_000; // then the shadow rises, then the quiet word
// What the song leaves behind. One line, half a minute after the aura —
// never explained, never repeated twice in a row.
const NIGHT_SAD_LINES = [
  "Девять вёсен. Я всё ещё считаю их.",
  "Дорога пуста. Как и вчера.",
  "Она сказала «весной». Весна приходила девять раз.",
  "Я помню её голос лучше, чем своё имя.",
  "Иногда играю громче. Чтобы не слышать тишину.",
  "Арцив тоже смотрит на дорогу. Мы об этом не говорим.",
  "Тьма забирает всё. Кроме памяти.",
  "Шестьсот лет. А болит одно письмо.",
  "Ворота держатся. Я — не каждую ночь.",
  "Не спрашивай ничего. Просто побудь рядом.",
];
let lastSadLine = -1;

// The default song, synthesized: a plucked-string lament in A minor, composed
// for Corvin and generated in-engine (Karplus-Strong), so a fresh download
// ALWAYS has music — no audio assets, nothing copyrighted, nothing to install.
// Drop ~/.echo/media/nightsong.mp3 and that plays instead.
function pluckBuffer(a: AudioContext, freq: number, dur: number, bright = 0.996): AudioBuffer {
  const sr = a.sampleRate;
  const N = Math.max(2, Math.round(sr / freq));
  const len = Math.floor(sr * dur);
  const buf = a.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const ring = new Float32Array(N);
  for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const cur = ring[idx];
    const nxt = ring[(idx + 1) % N];
    ring[idx] = (cur + nxt) * 0.5 * bright; // string decay
    d[i] = cur;
    idx = (idx + 1) % N;
  }
  return buf;
}

function playNightMelody(ms: number): () => void {
  const a = ac();
  if (!a) return () => {};
  const out = a.createGain();
  out.gain.value = 0.0001;
  out.gain.exponentialRampToValueAtTime(0.5, a.currentTime + 1.4); // fades in
  const room = a.createBiquadFilter(); // a little air, like a stone hall
  room.type = "lowpass";
  room.frequency.value = 2600;
  out.connect(room).connect(a.destination);

  // Original phrase: Am — F — Dm — E, fingerpicked, four bars, slow.
  const N = {
    A2: 110, C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61,
    G3: 196, A3: 220, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63,
  };
  const bars: number[][] = [
    [N.A2, N.E3, N.A3, N.C4, N.E3, N.A3],
    [N.F3, N.C4, N.F3 * 2, N.A3, N.C4, N.A3],
    [N.D3, N.A3, N.D4, N.F3 * 2, N.A3, N.D4],
    [N.E3, N.B3, N.E4, N.C4, N.B3, N.G3],
  ];
  const STEP = 0.44; // slow, unhurried
  const t0 = a.currentTime + 0.15;
  const total = ms / 1000;
  let t = t0;
  let bar = 0;
  const sources: AudioBufferSourceNode[] = [];
  while (t - t0 < total) {
    const notes = bars[bar % bars.length];
    notes.forEach((f, i) => {
      const when = t + i * STEP;
      if (when - t0 > total) return;
      const src = a.createBufferSource();
      src.buffer = pluckBuffer(a, f, 2.2, i === 0 ? 0.9975 : 0.995);
      const g = a.createGain();
      g.gain.setValueAtTime(i === 0 ? 0.9 : 0.55, when); // bass note leads
      g.gain.exponentialRampToValueAtTime(0.001, when + 2.1);
      src.connect(g).connect(out);
      src.start(when);
      sources.push(src);
    });
    t += notes.length * STEP;
    bar += 1;
  }
  return () => {
    const now = a.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), now);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 1.1); // the same soft fade
    window.setTimeout(() => sources.forEach((s) => s.stop()), 1300);
  };
}

async function nightSongScene() {
  await corvinScene(async () => {
    let audio: HTMLAudioElement | null = null;
    let stopMelody: (() => void) | null = null;
    // Sit, banish the sword, pick the guitar up FIRST — the music must start
    // on the first strum, not over an empty lap (user-directed timing).
    await corvinTakeGuitar();
    // The night song ships with the build (public/media/nightsong.mp3), so
    // every install has it; ~/.echo/media/nightsong.mp3 overrides it if you
    // drop your own. The synthesized lament is the last resort.
    const url = posterMedia.get("nightsong") ?? NIGHT_SONG_URL;
    if (url) {
      audio = new Audio(url);
      audio.volume = 0.55;
      // A missing/undecodable file fires BOTH onerror and the play() catch —
      // one guard, or two laments played over each other at double volume
      // and the first stop-handle leaked (hard review).
      let lamentStarted = false;
      const lament = () => {
        if (lamentStarted) return;
        lamentStarted = true;
        dbg("nightsong missing -> synth lament");
        stopMelody = playNightMelody(NIGHT_SONG_MS);
      };
      audio.onerror = lament;
      void audio.play().catch(lament);
    } else {
      stopMelody = playNightMelody(NIGHT_SONG_MS);
    }
    try {
      const passMs = corvinClipTotal(CORVIN.guitar) * paceMul(CORVIN.guitar as Clip);
      const passes = Math.max(2, Math.round(NIGHT_SONG_MS / passMs));
      await playCorvin(CORVIN.guitar, passes); // he's already holding it
    } finally {
      // A soft fade instead of a hard cut — it's a ritual, not an alarm.
      if (stopMelody) stopMelody();
      if (audio) {
        const a = audio;
        const fade = window.setInterval(() => {
          a.volume = Math.max(0, a.volume - 0.06);
          if (a.volume <= 0.01) {
            a.pause();
            window.clearInterval(fade);
          }
        }, 120);
      }
    }
    // Song over: the guitar goes back to the floor, the sword reassembles out
    // of the motes, and he rises. Only then does the shadow come out.
    await corvinPutGuitar();
    await ensureCorvinStanding("night song aura");
    // After the song: the shadow rises (he lets it out once a night), and half
    // a minute later — one quiet, bitter line. No story, no explanation.
    await playCorvin(CORVIN.aurarise);
    await playCorvin(CORVIN.auraburn, 2);
    await playCorvin(CORVIN.aurasink);
    commitFor(NIGHT_AFTER_AURA_MS + 12_000);
    curClip = ANIMS.idle; // he stands his watch with it
    frameIdx = 0;
    afterClip = null;
    await sleep(NIGHT_AFTER_AURA_MS);
    let i = Math.floor(Math.random() * NIGHT_SAD_LINES.length);
    if (i === lastSadLine) i = (i + 1) % NIGHT_SAD_LINES.length;
    lastSadLine = i;
    const line = NIGHT_SAD_LINES[i];
    await speakCorvinStoryLine(line);
    await sleep(1200);
    hideBubbleAfter(1200);
  });
}

// Fires within the first minutes of the new day; one gag flag per night. If he
// is mid-scene at 00:00 sharp, the next minute's check catches it.
// Dante's daily hour table (user-directed: the fan build must show the beats
// without waiting hours) — same mechanics as Corvin's: once per day per hour,
// presence-gated, remembered in story.json.
const DANTE_DAILY_HOURS: Array<{ h: number; name: string; run: () => void }> = [
  { h: 10, name: "coffee", run: () => void demoSeated(idleClip("d_coffee")) },
  { h: 12, name: "coinflip", run: () => void coinFlourish() },
  { h: 14, name: "swordspin", run: () => void demoSpin() },
  { h: 15, name: "pizza", run: () => demoSeated(PIZZA, "Finally.") },
  { h: 17, name: "sword move", run: () => void demoSword() },
  { h: 19, name: "devil trigger", run: () => devilTriggerScene() },
  { h: 21, name: "dance", run: () => danceScene() },
  { h: 22, name: "devil form", run: () => void devilFormScene() },
];

const NIGHT_WATCH_FIRST_REST_MS = 10 * 60_000;
const CORVIN_NIGHT_STONE_TOSSES = 3;
const NIGHT_WATCH_FINAL_REST_MS = 7 * 60_000;
const CORVIN_STONE_TOSS_CATCH: Clip = {
  // Reusing the source arc in reverse keeps one pebble on one physical path.
  frames: [
    ...CORVIN.stonetoss.frames.slice(0, 10),
    ...CORVIN.stonetoss.frames.slice(0, 9).reverse(),
  ],
  ms: 180,
  msSeq: [
    260, 190, 180, 170, 170, 180, 200, 230, 280, 430,
    280, 230, 200, 180, 170, 170, 180, 220, 360,
  ],
  loop: false,
  settle: 18,
};
const CORVIN_NIGHT_GUARD_LINES = [
  "Ты всё ещё не спишь. Тогда я останусь на страже.",
  "Ночь глубже, чем кажется. Работай. Я рядом.",
  "Даже стражам нужен сон. Но не сегодня.",
];
const DANTE_NIGHT_GUARD_LINES = [
  "Still working? Fine. Wake me if the world ends.",
  "You're still awake? That's dedication. Or bad judgment.",
];

const nightUserWorking = () =>
  Date.now() - Math.max(lastActivity, lastTypingEventAt) < 2 * 60_000 ||
  Date.now() < typingUntil ||
  Date.now() < mediaUntil ||
  gamingActive();

async function holdNightLoop(c: Clip, ms: number) {
  if (ms <= 0) return;
  startClip(c);
  commitFor(ms + 750);
  await sleep(ms);
}

async function holdKaelModeLoop(token: number, c: CorvinClip, ms: number) {
  if (ms <= 0) return;
  startKaelModeClip(token, c);
  commitFor(ms + 750);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    requireKaelMode(token);
    await sleep(Math.min(250, until - Date.now()));
  }
  requireKaelMode(token);
}

async function danteNightWatch(demo: boolean) {
  const firstRest = demo ? 3_000 : NIGHT_WATCH_FIRST_REST_MS;
  const finalRest = demo ? 3_000 : NIGHT_WATCH_FINAL_REST_MS;
  await playDante(DANTE_BLANKET_DOWN);
  dbg("night watch dante: asleep under blanket");
  await holdNightLoop(DANTE_BLANKET_LOOP, firstRest);

  const working = demo || nightUserWorking();
  const checkMs = danteClipTotal(DANTE_BLANKET_CHECK) + 80;
  dbg("night watch dante: wakes and checks the user");
  startClip(DANTE_BLANKET_CHECK);
  await sleep(Math.round(checkMs * 0.48));
  if (working) {
    const line = DANTE_NIGHT_GUARD_LINES[Math.floor(Math.random() * DANTE_NIGHT_GUARD_LINES.length)];
    showBubble(line, PRIO.NOTABLE, 6500, false);
    voiceSay(line);
    dbg(`night watch dante: user still working — ${line}`);
  } else {
    dbg("night watch dante: room quiet, turns away again");
  }
  await sleep(Math.round(checkMs * 0.52));
  dbg("night watch dante: turns his back and sleeps again");
  await holdNightLoop(DANTE_BLANKET_LOOP, finalRest);
  await playDante(reversedClip(DANTE_BLANKET_DOWN));
}

async function corvinNightWatch(demo: boolean) {
  const firstRest = demo ? 3_000 : NIGHT_WATCH_FIRST_REST_MS;
  const finalRest = demo ? 3_000 : NIGHT_WATCH_FINAL_REST_MS;
  await playCorvin(CORVIN.sitstone);
  await playCorvin(CORVIN.nightdoze);
  dbg("night watch corvin: dozing at cairn with Artsiv");
  await holdNightLoop(CORVIN.nightdozeloop as Clip, firstRest);

  await playCorvin(REV(CORVIN.nightdoze));
  const working = demo || nightUserWorking();
  if (working) {
    const line = CORVIN_NIGHT_GUARD_LINES[Math.floor(Math.random() * CORVIN_NIGHT_GUARD_LINES.length)];
    showBubble(line, PRIO.NOTABLE, 6500, false);
    await speakLine(line);
    dbg(`night watch corvin: user still working — ${line}`);
    for (let toss = 1; toss <= CORVIN_NIGHT_STONE_TOSSES; toss += 1) {
      dbg(`night watch corvin: pebble toss ${toss}/${CORVIN_NIGHT_STONE_TOSSES}`);
      await playCorvin(CORVIN_STONE_TOSS_CATCH);
      if (toss < CORVIN_NIGHT_STONE_TOSSES) await sleep(demo ? 180 : 420);
    }
    dbg("night watch corvin: three catches complete, drop begins");
    await playCorvin(CORVIN.stonedrop);
    dbg("night watch corvin: pebble dropped, guard resumes");
  } else {
    dbg("night watch corvin: room quiet, no words");
  }

  await playCorvin(CORVIN.nightdoze);
  await holdNightLoop(CORVIN.nightdozeloop as Clip, finalRest);
  await playCorvin(REV(CORVIN.nightdoze));
  await playCorvin(REV(CORVIN.sitstone));
}

async function kaelNightWatch(demo: boolean, token: number) {
  const firstRest = demo ? 3_000 : NIGHT_WATCH_FIRST_REST_MS;
  const finalRest = demo ? 3_000 : NIGHT_WATCH_FINAL_REST_MS;
  await playKaelMode(token, KAEL.night_enter_v2);
  dbg("night watch kael: black mirror opened");
  await holdKaelModeLoop(token, KAEL.night_loop_v2, firstRest);

  const working = demo || nightUserWorking();
  if (working) {
    dbg("night watch kael: user still working, quiet glance");
    await playKaelMode(token, KAEL.night_glance_v2);
  } else {
    dbg("night watch kael: room quiet, mirror holds");
  }

  await holdKaelModeLoop(token, KAEL.night_loop_v2, finalRest);
  await playKaelMode(token, REV(KAEL.night_enter_v2));
}

async function nightWatchScene(demo = false, scheduled = false): Promise<boolean> {
  if (!home || gagActive || showcasing || introActive || wandering || away || returning) {
    if (scheduled) dbg("night watch appointment deferred: stage was not available");
    return false;
  }
  const h = home;
  const corvin = isCorvin();
  const kael = isKael();
  const kaelNightToken = kael ? beginKaelMode("night") : 0;
  gagActive = true;
  afterClip = null;
  // Persist the appointment only after this function has actually acquired the
  // stage. A rejected entry must remain due and retry inside the 00:40-04:59
  // window instead of recording a scene the user never saw.
  if (scheduled) {
    story.s.gags.lastNightWatchAt = Date.now();
    story.save();
    markScene();
    dbg(`night watch ritual acquired (00:40, ${corvin ? "corvin" : kael ? "kael" : "dante"})`);
  }
  try {
    stage.dataset.state = "idle";
    delete stage.dataset.facing;
    document.documentElement.style.setProperty("--accent", ACCENT.idle);
    await standUp();
    dbg(`night watch start: ${corvin ? "corvin" : kael ? "kael" : "dante"}${demo ? " (demo)" : ""}`);
    if (kael) await kaelNightWatch(demo, kaelNightToken);
    else if (corvin) await corvinNightWatch(demo);
    else await danteNightWatch(demo);
  } catch (error) {
    if (error !== KAEL_MODE_CANCELLED) throw error;
    dbg(`kael night watch cancelled token=${kaelNightToken}`);
  } finally {
    const staleKaelNight = kael && !kaelModeCurrent(kaelNightToken);
    if (!staleKaelNight) {
      cancelAnimationFrame(winTween);
      winTween = 0;
      h.lastX = h.cornerX;
      h.lastY = h.y;
      await h.win.setPosition(new PhysicalPosition(h.cornerX, h.y)).catch(() => {});
      delete stage.dataset.facing;
      gagActive = false;
      if (kael) settleKaelMode(kaelNightToken, "night watch");
      else finishSceneIdle("night watch");
    }
  }
  return true;
}

function requiemPendingNow(at = new Date()) {
  return (
    isCorvin() &&
    at.getHours() === 23 &&
    at.getMinutes() >= 40 &&
    Date.now() - (story.s.gags.lastRequiemAt ?? 0) >= 12 * 3_600_000
  );
}

function nightWatchWindowNow(at = new Date()) {
  const h = at.getHours();
  const minute = at.getMinutes();
  // 00:40 is the appointment. A companion launched late must still notice the
  // same night, so keep a catch-up window through 04:59; the 12h story guard
  // below guarantees that this remains one scene, never an hourly repeat.
  return (h === 0 && minute >= 40) || (h >= 1 && h < 5);
}

function hourSlotPlayed(key: string): boolean {
  return Boolean(story.s.gags.lastHourSlots?.[key]);
}

function rememberHourSlot(key: string) {
  story.s.gags.lastHourSlots ??= {};
  story.s.gags.lastHourSlots[key] = Date.now();
  story.s.gags.lastHourSlot = key; // keep older builds able to read the newest mark
  story.save();
}

function scheduleMidnight() {
  window.setInterval(() => {
    if (!home) return;
    const now = new Date();
    const h = now.getHours();
    const minute = now.getMinutes();
    const requiemWindow = h === 23 && minute >= 40;
    const nightWatchWindow = nightWatchWindowNow(now);
    const busy =
      gagActive || showcasing || introActive || wandering || returning || committed() || quietNow();
    if (busy) return;
    // Rituals used to be silently LOST whenever he happened to be off-screen:
    // `away` aborted the tick, the ten-minute window ran out, and the slot was
    // never stamped or played. He leaves after 15 quiet minutes, so this ate
    // daily moments constantly. If a ritual window is open and somebody is
    // actually at the machine, walk him back in and let the next tick run it.
    if (away) {
      const dailyWindow = isDante()
        ? DANTE_DAILY_HOURS.some((slot) => slot.h === h)
        : isCorvin()
          ? DAILY_HOURS.some((slot) => slot.h === h) || h === 0 || h === 1 || h === 13 || h === 17
          : false;
      const inWindow = dailyWindow || requiemWindow || nightWatchWindow;
      const seen = Math.max(lastActivity, lastTypingEventAt, gamingUntil - 60_000);
      if (inWindow && Date.now() - seen <= 30 * 60_000) {
        dbg("ritual window while off-screen -> walking back in first");
        void returnScene();
      }
      return;
    }
    // Hour-table appointments remain due until the hour ends. A scene that owns
    // the stage at :00 delays the appointment; it never deletes it at :10.
    // The 23:40 requiem still owns the final twenty minutes of the day.
    if (nightWatchWindow) {
      const last = story.s.gags.lastNightWatchAt ?? 0;
      if (Date.now() - last >= 12 * 3_600_000 && sceneAllowed()) {
        void nightWatchScene(false, true);
        return;
      }
    }
    // Dante's day: the hour table is all he needs — the rituals below are
    // Corvin's alone.
    if (isDante()) {
      const slot = DANTE_DAILY_HOURS.find((s) => s.h === h);
      if (slot) {
        if (gamingActive()) return; // in a game the session clocks own the stage
        if (!sceneAllowed()) return; // retry next minute instead of stacking scenes
        // Keyed by CHARACTER too: both hour tables share this one field and
        // overlap at 12/14/15/17/19/21/22, so switching companions inside an
        // hour made the second one skip his slot for the whole day.
        const key = `${character}-${dateKey()}-${h}`;
        if (hourSlotPlayed(key)) return;
        const seen = Math.max(lastActivity, lastTypingEventAt, gamingUntil - 60_000);
        if (Date.now() - seen > 30 * 60_000) return; // nobody's watching
        markScene();
        rememberHourSlot(key);
        dbg(`dante daily hour ${h}:00 -> ${slot.name}`);
        slot.run();
      }
      return;
    }
    if (isKael()) return;
    // 17:00 — the Breach, hard (user-directed). The day's one real fight.
    if (h === 17) {
      const last = story.s.gags.lastBreachAt ?? 0;
      if (Date.now() - last < 6 * 3_600_000) return;
      if (!sceneAllowed()) return;
      dbg("breach ritual (17:00)");
      void breachScene(); // it stamps lastBreachAt itself
      return;
    }
    // The rest of the repertoire, one move per fixed hour (user-directed).
    // NOTE (hard review): from 23:40 the stage belongs to the REQUIEM — the
    // flask slot used to slip in here, stamp, and swallow the whole ritual.
    // And a slot skip must not `return`: that aborted the tick before the
    // requiem check ever ran.
    const slot = DAILY_HOURS.find((s) => s.h === h);
    if (slot && !requiemWindow && !gamingActive()) {
      // Keyed by character — see the Dante table above.
      const key = `${character}-${dateKey()}-${h}`;
      const seen = Math.max(lastActivity, lastTypingEventAt, gamingUntil - 60_000);
      // Presence-gated and once per day; a busy stage retries inside the hour.
      if (!hourSlotPlayed(key) && Date.now() - seen <= 30 * 60_000 && sceneAllowed()) {
        markScene();
        rememberHourSlot(key);
        dbg(`daily hour ${h}:00 -> ${slot.name}`);
        slot.run();
        return; // the slot owns this tick — nothing else may double-fire
      }
    }
    // 23:40 — the requiem: the whole grief line as one film, under the song.
    // Midnight picks it up twenty minutes later with the guitar.
    if (requiemWindow) {
      const last = story.s.gags.lastRequiemAt ?? 0;
      if (Date.now() - last < 12 * 3_600_000) return; // once a night
      if (!sceneAllowed()) return;
      story.s.gags.lastRequiemAt = Date.now();
      story.save();
      markScene();
      dbg("requiem ritual (23:40)");
      void requiemScene();
      return;
    }
    // 00:00 — the guitar. He plays, the shadow rises, one quiet line.
    if (h === 0) {
      const last = story.s.gags.lastNightSongAt ?? 0;
      if (Date.now() - last < 12 * 3_600_000) return; // once per night
      if (!sceneAllowed()) return;
      story.s.gags.lastNightSongAt = Date.now();
      story.save();
      markScene();
      dbg("midnight ritual");
      void nightSongScene();
      return;
    }
    // 01:00 and 13:00 — the breakdown (user-directed clock). Six-hour guard so
    // a restart inside the window can't replay it.
    if (h === 1 || h === 13) {
      const last = story.s.gags.lastBreakdownAt ?? 0;
      if (Date.now() - last < 6 * 3_600_000) return;
      if (!sceneAllowed()) return;
      story.s.gags.lastBreakdownAt = Date.now();
      story.save();
      markScene();
      dbg(`breakdown ritual (${h}:00)`);
      void breakdownScene();
    }
  }, 15_000);
}

// ---- The breakdown (01:00 and 13:00) ----------------------------------------
// The one scene where he has nothing left: no aura, no voice, no music. Just a
// low wind, a man on his knees, and a bird that comes down to sit with him.
// Synthesized wind — filtered noise with a slow-drifting filter, no assets.
function playWind(): () => void {
  const a = ac();
  if (!a) return () => {};
  const len = Math.floor(a.sampleRate * 2);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 320;
  lp.Q.value = 0.7;
  const g = a.createGain();
  g.gain.value = 0.0001;
  g.gain.exponentialRampToValueAtTime(0.16, a.currentTime + 3);
  // the gusts: the filter drifts, so it breathes instead of hissing
  const lfo = a.createOscillator();
  lfo.frequency.value = 0.08;
  const lfoGain = a.createGain();
  lfoGain.gain.value = 150;
  lfo.connect(lfoGain).connect(lp.frequency);
  src.connect(lp).connect(g).connect(a.destination);
  src.start();
  lfo.start();
  return () => {
    const now = a.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);
    window.setTimeout(() => {
      try {
        src.stop();
        lfo.stop();
      } catch {
        /* already stopped */
      }
    }, 2800);
  };
}

const BREAK_HOLD_PASSES = 4; // ~14 s of holding perfectly still
async function breakdownScene() {
  await corvinScene(async () => {
    const stopWind = playWind(); // it runs until the scene ends
    try {
      await playCorvin(CORVIN.breakdown); // the sword falls, he goes down
      await playCorvin(CORVIN.breakhold, BREAK_HOLD_PASSES); // nothing happens
      await playCorvin(CORVIN.breakrise); // and he gets up anyway
    } finally {
      stopWind();
    }
  });
}

// ---- The grief line: four quiet scenes on long, private clocks -------------
// None of them are performances. They happen, you may or may not be looking,
// and they leave without a word. The wind is the only sound.
async function letterScene() {
  await corvinScene(async () => {
    const stopWind = playWind();
    try {
      await playCorvin(CORVIN.letter);
    } finally {
      stopWind();
    }
  });
}

async function roadScene() {
  await corvinScene(async () => {
    const stopWind = playWind();
    try {
      // Evenings and nights it rains on that road (user-directed); by day he
      // watches it dry. The rain KEEPS FALLING through the watch (the hold is
      // a repainted loop, not a frozen frame), and he always TURNS BACK to
      // you before the next thing happens — no teleporting out of the pose.
      const p = dayPart();
      const wet = p === "evening" || p === "night";
      if (wet) {
        await playCorvin(CORVIN.roadrain);
        await playCorvin(CORVIN.roadrainhold, 7); // ~6.7s of living downpour
      } else {
        await playCorvin(CORVIN.road);
        await sleep(6000); // dry road — the still frame IS the scene
      }
      await playCorvin(REV(wet ? CORVIN.roadrain : CORVIN.road)); // turns back to you
    } finally {
      stopWind();
    }
  });
}

// Artsiv's strike (the action line's last piece): he sends the eagle, it dives
// across the whole screen talons-first, and comes back to the shoulder.
async function artsivStrikeScene() {
  await corvinScene(async () => {
    await playCorvin(CORVIN.takeoff);
    commitFor(9000);
    const flew = await skyFly(7000, true); // dive mode
    if (!flew) await artsivFly(5000);
    await playCorvin(CORVIN.landing);
  });
}

// The rest at the cairn (user-directed): he sits on the ground against the
// stones and just breathes with the wind for a while, then rises the same way.
async function stoneRestScene(holdMs = 30_000) {
  await corvinScene(async () => {
    const stopWind = playWind();
    try {
      await playCorvin(CORVIN.sitstone);
      commitFor(holdMs + 600);
      await sleep(holdMs);
      await playCorvin(REV(CORVIN.sitstone));
    } finally {
      stopWind();
    }
  });
}

async function rainScene(ms = 22_000) {
  await corvinScene(async () => {
    const stopWind = playWind();
    try {
      const passMs = corvinClipTotal(CORVIN.rain) * paceMul(CORVIN.rain as Clip);
      const passes = Math.max(2, Math.round(ms / passMs));
      await playCorvin(CORVIN.rain, passes);
    } finally {
      stopWind();
    }
  });
}

async function cairnScene() {
  await corvinScene(async () => {
    const stopWind = playWind();
    try {
      await playCorvin(CORVIN.cairn);
      await sleep(2500); // the palm stays on the stone
    } finally {
      stopWind();
    }
  });
}

// ---- The requiem (23:40): all five grief scenes as one film ----------------
// User-directed: everything sad, joined, with the song under it — and then
// midnight takes over with the guitar. The order is the arc: he looks at the
// letter, watches the road, stands in the rain, visits the grave, and only
// then goes down. One line at the very end, and nothing else.
// Song priority: ~/.echo/media/sadsong.mp3, then nightsong.mp3, then the
// synthesized lament, so it always has music.
async function requiemScene() {
  await corvinScene(async () => {
    // NO music (user-directed): the requiem carries itself. Only the wind —
    // silence is heavier here than any song. The guitar comes at 00:00.
    const stopWind = playWind();
    try {
      dbg("requiem: the whole grief line");
      await playCorvin(CORVIN.letter); // he looks at it
      await playCorvin(CORVIN.roadrain); // watches the road in the rain
      await playCorvin(CORVIN.roadrainhold, 5); // the downpour keeps falling
      await playCorvin(REV(CORVIN.roadrain)); // and he turns back
      await playCorvin(CORVIN.rain, 2); // and just stands in it
      await playCorvin(CORVIN.cairn); // and visits the grave
      await sleep(2000);
      await playCorvin(CORVIN.breakdown); // and then he goes down
      await playCorvin(CORVIN.breakhold, BREAK_HOLD_PASSES);
      await playCorvin(CORVIN.breakrise); // and gets up anyway
    } finally {
      stopWind();
    }
    // One line, then the watch. Midnight follows in twenty minutes.
    let i = Math.floor(Math.random() * NIGHT_SAD_LINES.length);
    if (i === lastSadLine) i = (i + 1) % NIGHT_SAD_LINES.length;
    lastSadLine = i;
    const line = NIGHT_SAD_LINES[i];
    await speakCorvinStoryLine(line);
    await sleep(1500);
    hideBubbleAfter(1200);
  });
}

// Long private cadences — these must stay rare to keep their weight.
const LETTER_EVERY = 7 * 86_400_000; // once a week
const CAIRN_EVERY = 30 * 86_400_000; // once a month
function griefUrge(): (() => Promise<void>) | null {
  const now = Date.now();
  const g = story.s.gags;
  // An unset clock meant 1970, so on a FRESH INSTALL the monthly cairn fired
  // within the first minute and the weekly letter on the very next tick — the
  // two rarest, most private scenes both spent before the user had any
  // relationship with him at all. Anchor an unset clock to the install
  // instant, the same way the pizza payoff already does.
  if (g.lastCairnAt === undefined || g.lastLetterAt === undefined) {
    const base = story.s.installedAt || now;
    g.lastCairnAt ??= base;
    g.lastLetterAt ??= base;
    story.save();
  }
  if (now - (g.lastCairnAt ?? 0) > CAIRN_EVERY) {
    g.lastCairnAt = now;
    story.save();
    dbg("grief: the cairn (monthly)");
    return cairnScene;
  }
  if (now - (g.lastLetterAt ?? 0) > LETTER_EVERY) {
    g.lastLetterAt = now;
    story.save();
    dbg("grief: the letter (weekly)");
    return letterScene;
  }
  return null;
}

// ---- The fight line ---------------------------------------------------------
// A block instead of a hit: sparks, boots skidding, back into guard.
function parryBeat() {
  void corvinScene(async () => {
    stage.dataset.state = "error";
    window.setTimeout(() => {
      sfxGunshot();
      shake(220);
    }, 170 * paceMul());
    await playCorvin(CORVIN.parry);
  }, ACCENT.error);
}

// Every big fight now ends with him breathing — this is what gives them weight.
async function windedTail() {
  await playCorvin(CORVIN.winded);
}

// THE BREACH — the fight he nearly loses. Twenty seconds, six parts, one run.
// Camera and sound are timed to the frames: the exchange rattles, the knockdown
// hits once and then goes quiet, the rise brings the aura back, and the finisher
// detonates. Ends on the winded tail — he has to breathe after this one.
async function breachScene() {
  await corvinScene(async () => {
    story.s.gags.lastBreachAt = Date.now();
    story.save();
    dbg("BREACH");
    await playCorvin(CORVIN.bralarm); // Artsiv screams, he squares up
    window.setTimeout(() => shake(300), 120 * paceMul());
    window.setTimeout(sfxIgnite, 260 * paceMul());
    await playCorvin(CORVIN.brclash); // the exchange
    sfxDemonRoar(); // whatever came through answers
    window.setTimeout(() => shake(520), 60 * paceMul());
    await playCorvin(CORVIN.brthrown); // and it puts him on the ground
    vignettePulse();
    sfxAura();
    await playCorvin(CORVIN.brrise); // he gets up with the shadow out
    window.setTimeout(() => shake(420), 200 * paceMul());
    sfxIgnite();
    await playCorvin(CORVIN.brcounter); // the counter
    window.setTimeout(() => {
      shake(620);
      sfxAura();
    }, 240 * paceMul());
    await playCorvin(CORVIN.brfinish); // the finisher
    await windedTail(); // and then he breathes
  }, ACCENT.error);
}

// The combo flow (no new art): charge into the cleave into the Execution, one
// unbroken run with the camera and the sound rising through it.
async function comboFlowScene() {
  await corvinScene(async () => {
    sfxIgnite();
    await playCorvin(CORVIN.charge);
    shake(260);
    await playCorvin(CORVIN.cleaveprep);
    sfxIgnite();
    await playCorvin(CORVIN.cleaveslash);
    window.setTimeout(() => shake(420), 190 * paceMul());
    await playCorvin(CORVIN.cleavesmash);
    await playCorvin(CORVIN.execraise);
    window.setTimeout(() => {
      shake(560);
      sfxAura();
    }, 230 * paceMul());
    await playCorvin(CORVIN.execstrike);
    await windedTail();
  }, ACCENT.success);
}

// The shadow aura — his stretch/flex idle flourish.
async function auraScene() {
  await corvinScene(async () => {
    await playCorvin(CORVIN.aurarise);
    await playCorvin(CORVIN.auraburn, 2);
    await playCorvin(CORVIN.aurasink);
  });
}

// Artsiv free flight: takeoff clip, then the STATIC #artsiv img (dynamic
// nodes never paint in the transparent window) sweeps ellipses over the stage
// while the body holds the "alone" settle frame, then the landing.
const artsivEl = document.getElementById("artsiv") as HTMLImageElement;
function artsivFly(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const rect = stage.getBoundingClientRect();
    const el = artsivEl;
    const frames = CORVIN.artsivfly.frames;
    let fi = 0;
    el.src = frames[0];
    const w = Math.max(60, rect.width * 0.55);
    el.style.width = `${w}px`;
    el.style.display = "block";
    const frameTimer = window.setInterval(() => {
      fi = (fi + 1) % frames.length;
      el.src = frames[fi];
    }, CORVIN.artsivfly.ms);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = (now - t0) / ms;
      if (t >= 1 || !gagActive) {
        window.clearInterval(frameTimer);
        el.style.display = "none";
        resolve();
        return;
      }
      const a = t * 2 * Math.PI * (ms / 4200); // ~one lap per 4.2 s
      const cx = rect.width / 2 + Math.cos(a) * rect.width * 0.28 - w / 2;
      const cy = rect.height * 0.04 + Math.sin(2 * a) * rect.height * 0.05;
      el.style.left = `${Math.round(cx)}px`;
      el.style.top = `${Math.round(cy)}px`;
      el.style.transform = `scaleX(${Math.cos(a + Math.PI / 2) < 0 ? -1 : 1})`;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// The FULL-SCREEN flight (user-directed "летать где угодно"): a transparent
// click-through window over the whole monitor; the eagle launches from
// Corvin's corner, sweeps two grand laps across the screen and returns.
// Falls back to the small in-window flight if the window can't be created.
async function skyFly(ms: number, dive = false): Promise<boolean> {
  if (!home) return false;
  const h = home;
  let win: WebviewWindow | null = null;
  try {
    const mon = await currentMonitor();
    if (!mon) return false;
    const sf = mon.scaleFactor || window.devicePixelRatio || 1;
    const mw = Math.round(mon.size.width / sf);
    const mh = Math.round(mon.size.height / sf);
    // Corvin's head in the sky-window's logical coordinates.
    const sx = Math.round((h.lastX - mon.position.x) / sf) + 55;
    const sy = Math.round((h.y - mon.position.y) / sf) + 8;
    win = new WebviewWindow("skyfly", {
      url: `index.html?skyfly=1&ms=${ms}&sx=${sx}&sy=${sy}${dive ? "&dive=1" : ""}`,
      width: mw,
      height: mh,
      x: Math.round(mon.position.x / sf),
      y: Math.round(mon.position.y / sf),
      visible: true,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: false,
      shadow: false,
    });
    const created = await new Promise<boolean>((res) => {
      win!.once("tauri://created", () => res(true));
      win!.once("tauri://error", (e) => {
        dbg(`skyfly window error: ${JSON.stringify(e)}`);
        res(false);
      });
    });
    if (!created) return false;
    void win.setIgnoreCursorEvents(true).catch(() => {});
    dbg(`skyfly open mon=${mw}x${mh} start=${sx},${sy}`);
    // The sky window emits skyfly-done when the lap is flown.
    await new Promise<void>((res) => {
      let settled = false;
      const fin = () => {
        if (!settled) {
          settled = true;
          res();
        }
      };
      void listen("skyfly-done", fin).then((un) => window.setTimeout(() => un(), ms + 4000));
      window.setTimeout(fin, ms + 3000); // hard cap
    });
    return true;
  } finally {
    if (win) void win.close().catch(() => {});
  }
}

async function artsivCycleScene() {
  await corvinScene(async () => {
    await playCorvin(CORVIN.takeoff);
    const FLIGHT_MS = 11_000;
    commitFor(FLIGHT_MS + 1200);
    const flew = await skyFly(FLIGHT_MS);
    if (!flew) {
      commitFor(7600);
      await artsivFly(7000); // fallback: the small in-window circles
    }
    await playCorvin(CORVIN.landing);
  });
}

// Corvin's reaction pools — a sentinel doesn't cheer; he acknowledges.
function reactWinCorvin() {
  // Silent sentinel: a win earns steel, not words (user-directed).
  // No cleave here — Разрубание belongs to the hunt (Steam) alone.
  const pick = pickWeighted([
    ["charge", 0.2],
    ["nothing", 0.8],
  ]);
  dbg(`react=win(corvin):${pick}`);
  if (pick === "charge")
    void corvinScene(async () => {
      sfxIgnite();
      await playCorvin(CORVIN.charge);
    }, ACCENT.success);
}

function reactErrorCorvin() {
  // Silent: he blocks it, takes it, or doesn't flinch at all. No commentary.
  const pick = pickWeighted([
    ["parry", 0.3],
    ["damage", 0.3],
    ["nothing", 0.4],
  ]);
  dbg(`react=err(corvin):${pick}`);
  if (pick === "parry") {
    parryBeat();
    return;
  }
  if (pick === "damage") {
    void corvinScene(async () => {
      stage.dataset.state = "error";
      sfxIgnite();
      await playCorvin(CORVIN.damage);
    }, ACCENT.error);
  }
}

// Corvin's idle life, two tiers (user-directed: "не хочу вечный один луп"):
//   quiet poses — the base rotates every ~25-50 s between the watch, the
//     horizon scan, seated meditation and quiet whetstone strokes (never the
//     same pose twice in a row; standing up from a seat plays the sit reversed)
//   big urges — every 2-3 rotations one of: a tale, the aura, the arcane scan,
//     Artsiv's flight, a bow. Scenes end in setState("idle") which re-arms this.
const CORVIN_SIT_REV: Clip = {
  frames: [...CORVIN.sit.frames].reverse(),
  ms: 150,
  msSeq: [200, 170, 150, 140, 130, 120, 115, 110, 110],
  loop: false,
  settle: 0,
};
let corvinIdleTimer = 0;
let corvinQuietPose = "watch";
let corvinQuietRuns = 0;
let corvinSeatedNow = false;
let corvinPostureTransition: "seated" | "standing" | null = null;
function corvinSetQuiet(pose: string) {
  const wasSeated = corvinSeatedNow;
  const willSit = pose === "meditate" || pose === "whet";
  corvinQuietPose = pose;
  const target = (): Clip =>
    pose === "scan" ? (CORVIN.huntwatch as Clip)
    : pose === "meditate" ? (CORVIN.meditate as Clip)
    : pose === "whet" ? (CORVIN.whetstone as Clip)
    : ANIMS.idle;
  if (willSit && !wasSeated) {
    corvinSeatedNow = true;
    corvinPostureTransition = "seated";
    commitFor(corvinClipTotal(CORVIN.sit) * paceMul(CORVIN.sit as Clip) + 200);
    startClip(CORVIN.sit as Clip, () => {
      if (corvinPostureTransition === "seated") corvinPostureTransition = null;
      if (isCorvin()) startClip(target());
    });
  } else if (!willSit && wasSeated) {
    corvinSeatedNow = false;
    corvinPostureTransition = "standing";
    commitFor(corvinClipTotal(CORVIN_SIT_REV) * paceMul(CORVIN_SIT_REV) + 200);
    startClip(CORVIN_SIT_REV, () => {
      if (corvinPostureTransition === "standing") corvinPostureTransition = null;
      if (isCorvin()) startClip(target());
    });
  } else {
    corvinSeatedNow = willSit;
    startClip(target());
  }
}

async function ensureCorvinSeated(source: string) {
  while (isCorvin() && corvinPostureTransition !== null) await sleep(25);
  if (!isCorvin() || corvinSeatedNow) return;
  dbg(`corvin posture: standing -> seated (${source})`);
  corvinSeatedNow = true;
  corvinPostureTransition = "seated";
  try {
    await playCorvin(CORVIN.sit);
  } finally {
    if (corvinPostureTransition === "seated") corvinPostureTransition = null;
  }
}

async function ensureCorvinStanding(source: string) {
  while (isCorvin() && corvinPostureTransition !== null) await sleep(25);
  const quietSeat = corvinQuietPose === "meditate" || corvinQuietPose === "whet";
  if (!isCorvin() || (!corvinSeatedNow && !quietSeat && !SEATED_CLIPS.has(curClip))) return;
  dbg(`corvin posture: seated -> standing (${source})`);
  corvinSeatedNow = false;
  corvinQuietPose = "watch";
  corvinPostureTransition = "standing";
  try {
    await playCorvin(CORVIN_SIT_REV);
  } finally {
    if (corvinPostureTransition === "standing") corvinPostureTransition = null;
  }
}
// ---- The Director (src/director.ts): the local brain --------------------------
// Replaces the fixed urge clocks: every tick it scores the whole repertoire
// against the current situation and picks what FITS — or picks silence. Fully
// local, learns from your reaction, state persisted in story.json.
const director = new Director(story.s.director);
const danteDirector = new Director(story.s.danteDirector, DANTE_ACTIONS);
const kaelDirector = new Director(story.s.kaelDirector, KAEL_ACTIONS);
function saveDirector() {
  story.s.director = director.st;
  story.save();
}
function saveDanteDirector() {
  story.s.danteDirector = danteDirector.st;
  story.save();
}
function saveKaelDirector() {
  story.s.kaelDirector = kaelDirector.st;
  story.save();
}

const CORVIN_HARD_PLAN_CYCLE_MS = CORVIN_HARD_PLAN_CYCLE_SEC * 1000;
const CORVIN_HARD_PLAN_GUARD_MS = 75_000;
const CORVIN_HARD_PLAN_TICK_MS = 1000;
const CORVIN_HARD_PLAN_RECOVERY_GAP_MS = 120_000;
let corvinPlanStartedAt = Date.now();
let corvinPlanCursor = 0;
let lastCorvinHardBeatAt = 0;

function resetCorvinHardPlan(source: string) {
  corvinPlanStartedAt = Date.now();
  corvinPlanCursor = 0;
  lastCorvinHardBeatAt = 0;
  dbg(`corvin hard plan reset: ${source}`);
}

function corvinPlanBeatAt(cursor: number): number {
  const cycle = Math.floor(cursor / CORVIN_HARD_PLAN.length);
  const beat = CORVIN_HARD_PLAN[cursor % CORVIN_HARD_PLAN.length];
  return corvinPlanStartedAt + cycle * CORVIN_HARD_PLAN_CYCLE_MS + beat.atSec * 1000;
}

function dueCorvinHardBeat(now: number): { id: string; cursorAfter: number } | null {
  if (corvinPlanBeatAt(corvinPlanCursor) > now) return null;
  return {
    id: CORVIN_HARD_PLAN[corvinPlanCursor % CORVIN_HARD_PLAN.length].id,
    cursorAfter: corvinPlanCursor + 1,
  };
}

function runCorvinHardPlan(now = Date.now()): boolean {
  if (now - lastCorvinHardBeatAt < CORVIN_HARD_PLAN_RECOVERY_GAP_MS) return false;
  const due = dueCorvinHardBeat(now);
  if (!due || !runCorvinClock(true, due.id)) return false;
  corvinPlanCursor = due.cursorAfter;
  lastCorvinHardBeatAt = now;
  dbg(`corvin hard beat: ${due.id} cursor=${corvinPlanCursor}`);
  return true;
}

const DANTE_HARD_PLAN_CYCLE_MS = DANTE_HARD_PLAN_CYCLE_SEC * 1000;
const DANTE_HARD_PLAN_GUARD_MS = 75_000;
const DANTE_DIRECTOR_TICK_MS = 1000;
const DANTE_HARD_PLAN_RECOVERY_GAP_MS = 90_000;
const DANTE_AMBIENT_MIN_MS = 45_000;
const DANTE_AMBIENT_MAX_MS = 90_000;
let dantePlanStartedAt = Date.now();
let dantePlanCursor = 0;
let lastDanteHardBeatAt = 0;
let danteAmbientDueAt = Date.now() + DANTE_AMBIENT_MIN_MS;

const nextDanteAmbientDelay = () =>
  DANTE_AMBIENT_MIN_MS + Math.random() * (DANTE_AMBIENT_MAX_MS - DANTE_AMBIENT_MIN_MS);

function resetDanteHardPlan(source: string) {
  const now = Date.now();
  dantePlanStartedAt = now;
  dantePlanCursor = 0;
  lastDanteHardBeatAt = 0;
  danteAmbientDueAt = now + nextDanteAmbientDelay();
  dbg(`dante hard plan reset: ${source}`);
}

function dantePlanBeatAt(cursor: number): number {
  const cycle = Math.floor(cursor / DANTE_HARD_PLAN.length);
  const beat = DANTE_HARD_PLAN[cursor % DANTE_HARD_PLAN.length];
  return dantePlanStartedAt + cycle * DANTE_HARD_PLAN_CYCLE_MS + beat.atSec * 1000;
}

function dueDanteHardBeat(now: number): { id: string; cursorAfter: number } | null {
  if (dantePlanBeatAt(dantePlanCursor) > now) return null;
  return {
    id: DANTE_HARD_PLAN[dantePlanCursor % DANTE_HARD_PLAN.length].id,
    cursorAfter: dantePlanCursor + 1,
  };
}

function runDanteHardPlan(now = Date.now()): boolean {
  if (now - lastDanteHardBeatAt < DANTE_HARD_PLAN_RECOVERY_GAP_MS) return false;
  const due = dueDanteHardBeat(now);
  if (!due || !runDanteClock(true, due.id)) return false;
  dantePlanCursor = due.cursorAfter;
  lastDanteHardBeatAt = now;
  dbg(`dante hard beat: ${due.id} cursor=${dantePlanCursor}`);
  return true;
}

const KAEL_HARD_PLAN_CYCLE_MS = KAEL_HARD_PLAN_CYCLE_SEC * 1000;
const KAEL_HARD_PLAN_GUARD_MS = 75_000;
const KAEL_DIRECTOR_TICK_MS = 1000;
const KAEL_HARD_PLAN_RECOVERY_GAP_MS = 120_000;
const KAEL_AMBIENT_MIN_MS = 75_000;
const KAEL_AMBIENT_MAX_MS = 120_000;
let kaelPlanStartedAt = Date.now();
let kaelPlanCursor = 0;
let lastKaelHardBeatAt = 0;
let kaelAmbientDueAt = Date.now() + KAEL_AMBIENT_MIN_MS;

const nextKaelAmbientDelay = () =>
  KAEL_AMBIENT_MIN_MS + Math.random() * (KAEL_AMBIENT_MAX_MS - KAEL_AMBIENT_MIN_MS);

function resetKaelHardPlan(source: string) {
  const now = Date.now();
  kaelPlanStartedAt = now;
  kaelPlanCursor = 0;
  lastKaelHardBeatAt = 0;
  kaelAmbientDueAt = now + nextKaelAmbientDelay();
  dbg(`kael hard plan reset: ${source}`);
}

function kaelPlanBeatAt(cursor: number): number {
  const cycle = Math.floor(cursor / KAEL_HARD_PLAN.length);
  const beat = KAEL_HARD_PLAN[cursor % KAEL_HARD_PLAN.length];
  return kaelPlanStartedAt + cycle * KAEL_HARD_PLAN_CYCLE_MS + beat.atSec * 1000;
}

function dueKaelHardBeat(now: number): { id: string; cursorAfter: number } | null {
  if (kaelPlanBeatAt(kaelPlanCursor) > now) return null;
  return {
    id: KAEL_HARD_PLAN[kaelPlanCursor % KAEL_HARD_PLAN.length].id,
    cursorAfter: kaelPlanCursor + 1,
  };
}

function runKaelHardPlan(now = Date.now()): boolean {
  if (now - lastKaelHardBeatAt < KAEL_HARD_PLAN_RECOVERY_GAP_MS) return false;
  const due = dueKaelHardBeat(now);
  if (!due) return false;
  if (!runKaelClock(true, due.id)) return false;
  kaelPlanCursor = due.cursorAfter;
  lastKaelHardBeatAt = now;
  dbg(`kael hard beat: ${due.id} cursor=${kaelPlanCursor}`);
  return true;
}

// The continuous-session clock: resets after a 10-minute silence, so
// workMinutes really means "how long THIS work session has run" (the old
// formula saturated at 60 during work and grew only while you were AWAY).
let workStartAt = Date.now();
let workLastSeen = 0;
function workMinutesNow(): number {
  const now = Date.now();
  const active = Math.max(lastActivity, lastTypingEventAt);
  if (active > workLastSeen) {
    if (active - workLastSeen > 10 * 60_000) workStartAt = active; // new session
    workLastSeen = active;
  }
  if (now - workLastSeen > 10 * 60_000) return 0; // nobody is working right now
  return Math.round((now - workStartAt) / 60_000);
}

function currentSituation(): Situation {
  const now = Date.now();
  return {
    hour: new Date().getHours(),
    workMinutes: workMinutesNow(),
    typing: now < typingUntil,
    present: now - Math.max(lastActivity, lastTypingEventAt) < 5 * 60_000,
    gaming: gamingActive(),
    errStreak,
    winStreak,
    sinceSceneSec: Math.round((now - lastSceneAt) / 1000),
  };
}

// A committed one-shot: the small/micro clips play inline, no gag needed.
function playMicro(c: CorvinClip) {
  if (c.loop) {
    dbg("micro clip refused: looping clips require a mode owner");
    return;
  }
  commitFor(corvinClipTotal(c) * paceMul() + 250);
  startClip(c as Clip);
}

// Pose spells: enter, hold a while, exit — committed the whole way.
async function poseSpell(enter: CorvinClip, exit: CorvinClip, holdMs: number) {
  await corvinScene(async () => {
    await playCorvin(enter);
    commitFor(holdMs + 500);
    await sleep(holdMs);
    await playCorvin(exit);
  });
}

// Sleep: enter, breathe until you come back (or 25 min), soldier's wake.
async function sleepScene() {
  await corvinScene(async () => {
    const start = Date.now();
    await playCorvin(CORVIN.sleepdown);
    const loopMs = corvinClipTotal(CORVIN.sleeploop) * paceMul(CORVIN.sleeploop as Clip);
    while (Date.now() - start < 25 * 60_000) {
      commitFor(loopMs + 500);
      await playCorvin(CORVIN.sleeploop);
      const active = Date.now() - Math.max(lastActivity, lastTypingEventAt) < 15_000;
      if (active) break; // you're back — he feels it
    }
    await playCorvin(CORVIN.sleepup);
  });
}

// Feedback probe: if your typing spikes right after a BIG scene started, it
// was in the way; calm continuation means it landed well.
function watchReaction(id: string, brain: Director = director) {
  // Scenes played to an empty room must not learn anything — "no typing"
  // there is absence, not approval, and it was drifting night scenes to the
  // weight cap while punishing everything played during real work.
  if (Date.now() - lastActivity > 5 * 60_000) return;
  const before = lastTypingEventAt;
  window.setTimeout(() => {
    const during = lastTypingEventAt > before && Date.now() - lastTypingEventAt < 12_000;
    brain.feedback(id, !during ? true : false);
    if (brain === danteDirector) saveDanteDirector();
    else if (brain === kaelDirector) saveKaelDirector();
    else saveDirector();
  }, 15_000);
}

let lastCorvinDirectorAt = 0;
const CORVIN_DIRECTOR_GAP_MS = 60_000;
const CORVIN_GAMING_DIRECTOR_GAP_MS = 90_000;
function runCorvinClock(allowBigScenes = true, plannedId?: string): boolean {
  const now = Date.now();
  const globalGap = gamingActive() ? CORVIN_GAMING_DIRECTOR_GAP_MS : CORVIN_DIRECTOR_GAP_MS;
  if (!plannedId && now - lastCorvinDirectorAt < globalGap) return false;
  if (!plannedId && corvinPlanBeatAt(corvinPlanCursor) - now <= CORVIN_HARD_PLAN_GUARD_MS)
    return false;
  // Grief outranks everything: weeks/months cadences never lose to routine.
  if (!plannedId && allowBigScenes) {
    const grief = griefUrge();
    if (grief) {
      // Grief is the biggest scene there is; every other big path stamps the
      // shared gap. Without this the next 15-30 s tick saw sceneAllowed() and
      // could stack another big scene straight on top of the cairn — and
      // sinceSceneSec still read "nothing has happened in 15 minutes" seconds
      // after the most dramatic moment in the app.
      markScene();
      void grief();
      return true;
    }
  }
  const s = currentSituation();
  const allowBig = allowBigScenes && sceneAllowed();
  const a = plannedId ? director.takePlanned(plannedId, s, allowBig) : director.pick(s, allowBig);
  saveDirector();
  if (!a) return false; // silence is a choice too
  lastCorvinDirectorAt = now;
  // Match Dante's Director contract: once a large scene wins the lottery it
  // immediately owns the shared attention gap. Without this stamp Corvin could
  // chain a different large scene on the very next 15-30 second idle tick.
  if (a.kind === "big") markScene();
  // Only the `big` cases below call watchReaction, so Corvin's 18 micro/pose
  // actions never received feedback and their weight stayed pinned at exactly
  // 1 forever. Feedback is asymmetric (+0.06 / -0.18) and an uninterrupted
  // scene counts as a win, so his big scenes drifted to the 2.5 cap while the
  // quiet beats structurally could not follow — the free-time lottery skewed
  // toward spectacle. Dante and Kael call it for every pick; match them.
  if (a.kind !== "big") watchReaction(a.id);
  dbg(`director: ${a.id} (${a.kind}${plannedId ? ", hard" : ""})`);
  switch (a.id) {
    // micro
    case "flinch": void corvinScene(() => playCorvin(CORVIN.flinch)); break;
    case "coatdust": void corvinScene(() => playCorvin(CORVIN.coatdust)); break;
    case "nodself": void corvinScene(() => playCorvin(CORVIN.nodself)); break;
    case "lookarm": void corvinScene(() => playCorvin(CORVIN.lookarm)); break;
    case "breathfog": void corvinScene(() => playCorvin(CORVIN.breathfog)); break;
    case "knuckle": void corvinScene(() => playCorvin(CORVIN.knuckle)); break;
    case "eaglelook": void corvinScene(() => playCorvin(CORVIN.eaglelook)); break;
    case "hairwind": void corvinScene(() => playCorvin(CORVIN.hairwind)); break;
    case "shiftweight": void corvinScene(() => playCorvin(CORVIN.shiftweight)); break;
    case "glanceback": void corvinScene(() => playCorvin(CORVIN.glanceback)); break;
    case "stretch2": void corvinScene(() => playCorvin(CORVIN.stretch2)); break;
    case "crouchcheck": void corvinScene(() => playCorvin(CORVIN.crouchcheck)); break;
    // poses
    case "stepright": void corvinScene(() => playCorvin(CORVIN.stepright)); break;
    case "crouchrest": void corvinScene(() => playCorvin(CORVIN.crouchrest)); break;
    case "turnpair": void poseSpell(CORVIN.turnleft, CORVIN.turnback, 2500 + Math.random() * 4000); break;
    case "leanspell": void poseSpell(CORVIN.leanwall, CORVIN.leanoff, 9000 + Math.random() * 12000); break;
    case "swordcarry": void poseSpell(CORVIN.swordshoulder, CORVIN.swordplant, 7000 + Math.random() * 9000); break;
    case "swordrest": void poseSpell(CORVIN.swordplant, REV(CORVIN.swordplant), 3 * 60_000); break;
    // big — the scenes he already owns, now competed for
    case "tale": watchReaction(a.id); void whetstoneTaleScene(); break;
    case "aura": watchReaction(a.id); void auraScene(); break;
    case "scan": watchReaction(a.id); void magicscanScene(); break;
    case "artsiv": watchReaction(a.id); void artsivCycleScene(); break;
    case "bow": watchReaction(a.id); void corvinScene(() => playCorvin(CORVIN.bow)); break;
    case "road": watchReaction(a.id); void roadScene(); break;
    case "door": watchReaction(a.id); void doorFightScene(); break;
    case "rain": watchReaction(a.id); void rainScene(); break;
    case "feedeagle": watchReaction(a.id); void corvinScene(() => playCorvin(CORVIN.feedeagle)); break;
    case "flask": watchReaction(a.id); void corvinScene(() => playCorvin(CORVIN.flask)); break;
    case "leanstone": watchReaction(a.id); void corvinScene(() => playCorvin(CORVIN.leanstone)); break;
    case "stonerest": watchReaction(a.id); void stoneRestScene(25_000 + Math.random() * 20_000); break;
    case "sleep": void sleepScene(); break;
  }
  return true;
}

function runDanteClock(allowBigScenes = true, plannedId?: string): boolean {
  const situation = currentSituation();
  const allowBig = allowBigScenes && sceneAllowed();
  const a: DirectorAction | null = plannedId
    ? danteDirector.takePlanned(plannedId, situation, allowBig)
    : danteDirector.pick(situation, allowBig);
  saveDanteDirector();
  if (!a) return false;
  if (a.kind === "big") markScene();
  watchReaction(a.id, danteDirector);
  dbg(`dante director: ${a.id} (${a.kind}${plannedId ? ", hard" : ""})`);
  // The `posture` tag is a CONTRACT, and until now nothing read it: the switch
  // below went straight to frame zero, so a standing pack selected while he sat
  // swapped silhouettes on the spot — seated one frame, on his feet the next.
  // Individual standing scenes each remembered to call standUp(), but that is a
  // promise every future scene has to keep by hand, and the seated micros never
  // asserted their side at all.
  //
  // Enforce it once, here, for every action: bridge to the tagged pose with the
  // real sit/stand transition, then dispatch. ensureDantePosture is a no-op when
  // he is already in the right pose, so this costs nothing in the common case.
  if (a.posture && isDante() && !gagActive && seatedNow !== (a.posture === "seated")) {
    dbg(`dante posture bridge for ${a.id}: -> ${a.posture}`);
    void ensureDantePosture(a.posture === "seated").then(() => dispatchDanteAction(a));
    return true;
  }
  dispatchDanteAction(a);
  return true;
}

function dispatchDanteAction(a: DirectorAction) {
  switch (a.id) {
    case "sitswing": playDantePlannedIdle("sitswing"); break;
    case "sitcross": playDantePlannedIdle("sitcross"); break;
    case "sitthink": playDantePlannedIdle("sitthink"); break;
    case "leanback": playDantePlannedIdle("leanback"); break;
    case "laugh": playDantePlannedIdle("laugh"); break;
    case "checkwatch": playDantePlannedIdle("checkwatch"); break;
    case "yawn": playDantePlannedIdle("yawn"); break;
    case "nap": playDantePlannedIdle("nap"); break;
    case "stretch": playDantePlannedIdle("stretch"); break;
    case "shrug": playDantePlannedIdle("shrug"); break;
    case "headtilt": playDantePlannedIdle("headtilt"); break;
    case "lookout": playDantePlannedIdle("lookout"); break;
    case "cleansword": playDantePlannedIdle("cleansword"); break;
    case "d_glanceover": playDantePlannedIdle("d_glanceover"); break;
    case "d_bootswing": playDantePlannedIdle("d_bootswing"); break;
    case "d_neckroll": playDantePlannedIdle("d_neckroll"); break;
    case "d_jacketflick": playDantePlannedIdle("d_jacketflick"); break;
    case "d_knuckles": playDantePlannedIdle("d_knuckles"); break;
    case "d_hairswipe": playDantePlannedIdle("d_hairswipe"); break;
    case "d_sigh": playDantePlannedIdle("d_sigh"); break;
    case "d_sitedge": playDantePlannedIdle("d_sitedge"); break;
    case "d_phone": playDantePlannedIdle("d_phone"); break;
    case "d_fingerguns": playDantePlannedIdle("d_fingerguns"); break;
    case "d_coffee":
      if (new Date().getHours() >= 10 && new Date().getHours() < 20)
        playDantePlannedIdle("d_coffee");
      else dbg("dante hard beat: coffee skipped outside waking day");
      break;
    case "d_layback": playDantePlannedIdle("d_layback"); break;
    case "d_standlean": void dantePoseScene(DANTE_STANDLEAN, 3500 + Math.random() * 3500); break;
    case "d_crouchpeer": void dantePoseScene(DANTE_CROUCHPEER, 2500 + Math.random() * 3000); break;
    case "coin": void coinFlourish(); break;
    case "swordspin": void demoSpin(); break;
    case "pizza": demoSeated(PIZZA, "Finally."); break;
    case "dance": void danceScene(undefined, DANCE); break;
    case "headbang": void danceScene(undefined, HEADBANG); break;
    case "deviltrigger": void devilTriggerScene(); break;
    case "devilform": void devilFormScene(); break;
    case "moto": void motoScene(); break;
    case "dive": void diveGag(); break;
    case "shoot": void shootScene(); break;
    case "gunspin": void gunFlourish(); break;
    case "taunt": void danteStandingClipScene(TAUNT, 1); break;
    case "cheer": void lightWin(); break;
    case "stagger": void lightError(); break;
    case "standcross": void danteStandingClipScene(STAND_CROSS, 1); break;
    case "swordmove": void demoSword(); break;
  }
}

function runKaelClock(allowBigScenes = true, plannedId?: string): boolean {
  // Every Kael Director pack starts on the exact standing dormant silhouette.
  // Connected work/watch/night/combat modes own their own exits and can never
  // be replaced by an ambient first frame.
  if (kaelMode !== "idle" || kaelWeaponForm !== "dormant") return false;
  const situation = currentSituation();
  const allowBig = allowBigScenes && sceneAllowed();
  const a = plannedId
    ? kaelDirector.takePlanned(plannedId, situation, allowBig)
    : kaelDirector.pick(situation, allowBig);
  saveKaelDirector();
  if (!a) return false;
  if (a.kind === "big") markScene();
  watchReaction(a.id, kaelDirector);
  dbg(`kael director: ${a.id} (${a.kind}${plannedId ? ", hard" : ""})`);
  switch (a.id) {
    case "cloaksettle": playMicro(KAEL.cloaksettle); break;
    case "razlomtap": playMicro(KAEL.razlomtap); break;
    case "swordplant": void kaelSwordPlantScene(); break;
    case "platypus_sniff": playMicro(KAEL.platypus_sniff); break;
    case "armcheck": playMicro(KAEL.armcheck_v2); break;
    case "platypus": playMicro(KAEL.platypus_v2); break;
    case "scarf": playMicro(KAEL.scarf_adjust); break;
    case "repair": void kaelRepairScene(); break;
    case "rest": void kaelRestScene(); break;
    case "voidorgan": void kaelVoidOrganScene(); break;
    case "voidstitch": void kaelVoidStitchScene(); break;
  }
  return true;
}

// A live AI session parks the stage in "coding"/"searching"/"speaking" for
// minutes at a time, so a strict idle gate starved these two Directors exactly
// when the companion must stay alive — the same bug corvinIdleTick already
// fixes for Corvin. Work states are allowed, but only on every SECOND window,
// so session hammering never turns into a beat every 45 seconds.
const DIRECTOR_WORK_STATES = new Set(["coding", "searching", "speaking"]);
const directorWorkRuns: Record<string, number> = { dante: 0, kael: 0 };
function directorStageReady(who: "dante" | "kael"): boolean {
  const st = stage.dataset.state || "idle";
  if (st === "idle") {
    directorWorkRuns[who] = 0;
    return true;
  }
  if (!DIRECTOR_WORK_STATES.has(st)) return false;
  directorWorkRuns[who] += 1;
  if (directorWorkRuns[who] < 2) return false;
  directorWorkRuns[who] = 0;
  return true;
}

function scheduleDanteDirector() {
  window.setTimeout(() => {
    const now = Date.now();
    if (
      isDante() &&
      home &&
      beatReady() &&
      !introActive &&
      !gamingActive() &&
      now >= typingUntil
    ) {
      // A synchronous throw here (a corrupt director weight, a bad clip) left
      // the setTimeout chain unarmed for the rest of the session with no way
      // back — the gaming chain already guards for exactly this reason.
      try {
        if (stage.dataset.state === "idle" && runDanteHardPlan(now)) {
          danteAmbientDueAt = now + nextDanteAmbientDelay();
        } else if (
          now >= danteAmbientDueAt &&
          dantePlanBeatAt(dantePlanCursor) - now > DANTE_HARD_PLAN_GUARD_MS &&
          directorStageReady("dante")
        ) {
          runDanteClock();
          danteAmbientDueAt = now + nextDanteAmbientDelay();
        }
      } catch (e) {
        dbg(`dante director threw: ${e}`);
        danteAmbientDueAt = now + nextDanteAmbientDelay();
      }
    }
    scheduleDanteDirector();
  }, DANTE_DIRECTOR_TICK_MS);
}

function scheduleKaelDirector() {
  window.setTimeout(() => {
    const now = Date.now();
    if (
      isKael() &&
      home &&
      beatReady() &&
      !introActive &&
      !gamingActive() &&
      now >= typingUntil &&
      kaelMode === "idle"
    ) {
      try {
        if (runKaelHardPlan(now)) {
          kaelAmbientDueAt = now + nextKaelAmbientDelay();
        } else if (
          now >= kaelAmbientDueAt &&
          kaelPlanBeatAt(kaelPlanCursor) - now > KAEL_HARD_PLAN_GUARD_MS &&
          directorStageReady("kael")
        ) {
          runKaelClock();
          kaelAmbientDueAt = now + nextKaelAmbientDelay();
        }
      } catch (e) {
        dbg(`kael director threw: ${e}`);
        kaelAmbientDueAt = now + nextKaelAmbientDelay();
      }
    }
    scheduleKaelDirector();
  }, KAEL_DIRECTOR_TICK_MS);
}

function scheduleCorvinHardPlan() {
  window.setTimeout(() => {
    const now = Date.now();
    const state = stage.dataset.state || "idle";
    if (
      isCorvin() &&
      home &&
      beatReady() &&
      !gamingActive() &&
      now >= typingUntil &&
      (state === "idle" || DIRECTOR_WORK_STATES.has(state))
    ) {
      try {
        runCorvinHardPlan(now);
      } catch (error) {
        dbg(`corvin hard plan threw: ${error}`);
      }
    }
    scheduleCorvinHardPlan();
  }, CORVIN_HARD_PLAN_TICK_MS);
}

let corvinTickArmed = false;
function corvinIdleCycle() {
  if (!home) return;
  // Re-entering idle must NOT reset the urge clock — playIdleCycle fires on
  // every setState("idle") and the constant resets were why he "only ever
  // loops the watch". Keep the current quiet pose, keep the counter, and make
  // sure exactly one tick chain is armed.
  if (!gagActive && stage.dataset.state === "idle") corvinSetQuiet(corvinQuietPose);
  if (!corvinTickArmed) {
    corvinTickArmed = true;
    corvinIdleTick();
  }
}
function corvinIdleTick() {
  // Arming discipline: armed=true only while a timer is pending. The callback
  // clears it on entry; every path that wants the chain alive calls
  // corvinIdleTick() again (urge launches don't — the scene's setState("idle")
  // -> corvinIdleCycle() re-arms instead). Without this, a tick landing inside
  // any scene killed every urge and pose rotation until app restart.
  corvinTickArmed = true;
  window.clearTimeout(corvinIdleTimer);
  corvinIdleTimer = window.setTimeout(
    () => {
      corvinTickArmed = false;
      // A synchronous throw anywhere below (director.pick on a corrupt weight,
      // a playMicro path) escapes the setTimeout and leaves the chain unarmed
      // for the rest of the session — corvinIdleCycle can't revive it either,
      // it only re-arms when corvinTickArmed is false and the throw happens
      // after that flag is cleared. Guarantee the re-arm.
      try {
        corvinIdleBody();
      } catch (e) {
        dbg(`corvin idle tick threw: ${e}`);
        corvinIdleTick();
      }
    },
    15_000 + Math.random() * 15_000,
  );
}
function corvinIdleBody() {
      // During a hunt, fixed headline beats own the big-scene lane. The local
      // Director still supplies small and pose animations between appointments,
      // otherwise Corvin collapses into one endless huntwatch loop.
      if (
        !isCorvin() ||
        gagActive ||
        showcasing ||
        introActive ||
        wandering ||
        away ||
        returning ||
        requiemPendingNow() ||
        quietNow()
      ) {
        // Re-arm OURSELVES: relying on the next setState("idle") left the
        // chain dead for hours when a quiet hour / game tail expired with no
        // scene running to call it (hard review). clearTimeout in the arming
        // makes the double-arm case safe.
        corvinIdleTick();
        return;
      }
      if (gamingActive()) {
        if (!committed() && !huntBeatDueSoon()) runCorvinClock(false);
        corvinIdleTick();
        return;
      }
      const st = stage.dataset.state || "idle";
      const workish = st === "coding" || st === "searching" || st === "speaking";
      // Urges may fire during WORK states too (the AI session keeps him in
      // "coding" almost permanently — pure idle basically never happens while
      // a session runs, and that read as "he only ever loops"). No busyBurst
      // gate here: the session hammering is exactly when he must stay alive.
      if ((st !== "idle" && !workish) || Date.now() < typingUntil) {
        corvinIdleTick();
        return;
      }
      corvinQuietRuns += 1;
      if (workish) {
        // No pose rotation here — setState would stomp it on the next event.
        // Straight to an urge on a slightly slower clock (~45-120 s).
        if (corvinQuietRuns >= 2) {
          corvinQuietRuns = 0;
          runCorvinClock(); // the director decides (or stays silent)
          // Micro actions don't end in setState("idle"), so the chain must
          // re-arm itself here — a big scene's re-arm just replaces this timer.
          corvinIdleTick();
          return;
        }
        corvinIdleTick();
        return;
      }
      if (corvinQuietRuns >= 1 + Math.floor(Math.random() * 2)) {
        // a big urge earned by a few quiet rotations
        corvinQuietRuns = 0;
        runCorvinClock(); // the director decides (or stays silent)
        corvinIdleTick(); // survive micro actions — see the workish branch
        return;
      }
      const next = pickWeighted(
        (
          [
            ["watch", 0.38],
            ["scan", 0.16],
            ["meditate", 0.24],
            ["whet", 0.22],
          ] as Array<[string, number]>
        ).filter(([k]) => k !== corvinQuietPose), // never the same pose twice
      );
      dbg(`idle(corvin) pose=${next}`);
      corvinSetQuiet(next);
      corvinIdleTick();
}

// ---- Dante's fixed-clock beats (user-directed: hard, frequent, no LLM) ------
// Steam session table, anchored to the real game launch (minute 0 = burst):
//   spin 6:00 /20m · sword 7:00 /10m (gaming loop) · coin 12:00 /25m ·
//   pizza 18:00 /60m — the old 3h/3.5h waits meant most fans never saw them.
// Outside games the DAILY hour table below covers the same beats.
// Shrug: 20 min of doing nothing at all (no typing, no gaming), any time.
const BOOT_AT = Date.now();
const DANTE_COIN_EVERY = 25 * 60_000;
const DANTE_PIZZA_EVERY = 60 * 60_000;
let lastDanteSpin = 0; // 0 = unarmed until a game session starts
let lastDanteCoin = 0;
let lastDantePizza = 0;
let lastDanteShrug = BOOT_AT;
function armDanteClocks(startedAt = Date.now()) {
  lastDanteSpin = startedAt - 20 * 60_000 + 6 * 60_000; // -> first spin at 6:00
  lastDanteCoin = startedAt - DANTE_COIN_EVERY + 12 * 60_000; // -> coin at 12:00
  lastDantePizza = startedAt - DANTE_PIZZA_EVERY + 18 * 60_000; // -> pizza at 18:00
  dbg("dante clocks armed: spin@6m, coin@12m, pizza@18m");
}
function scheduleDanteBeats() {
  window.setInterval(() => {
    if (!isDante() || !home || !beatReady()) return;
    const now = Date.now();
    // These three are GAME-SESSION clocks: once armed they used to run for
    // the rest of the app's life — pizza every hour at the desk with no game
    // open (hard review). Outside a session the daily hour table covers them.
    if (!gamingActive()) {
      lastDanteSpin = 0;
      lastDanteCoin = 0;
      lastDantePizza = 0;
    }
    if (lastDantePizza && now - lastDantePizza > DANTE_PIZZA_EVERY) {
      const folded = consumeOverdueDanteClocks("pizza beat", now);
      saveGamingClocks();
      if (folded.length > 1) dbg(`dante backlog selected pizza from: ${folded.join(", ")}`);
      dbg("dante beat: pizza (game 18:00 + 60m clock)");
      demoSeated(PIZZA, "Finally.");
      return;
    }
    if (lastDanteCoin && now - lastDanteCoin > DANTE_COIN_EVERY) {
      const folded = consumeOverdueDanteClocks("coin beat", now);
      saveGamingClocks();
      if (folded.length > 1) dbg(`dante backlog selected coin from: ${folded.join(", ")}`);
      dbg("dante beat: coinflip (game 12:00 + 25m clock)");
      void coinFlourish();
      return;
    }
    if (lastDanteSpin && now - lastDanteSpin > 20 * 60_000) {
      const folded = consumeOverdueDanteClocks("spin beat", now);
      saveGamingClocks();
      if (folded.length > 1) dbg(`dante backlog selected spin from: ${folded.join(", ")}`);
      dbg("dante beat: swordspin (game 6:00 + 20min clock)");
      void demoSpin();
      return;
    }
    // Shrug only when truly idle: no typing and no game for the whole window.
    const idleEnough =
      now - Math.max(lastTypingEventAt, gamingUntil - 60_000) > 20 * 60_000;
    if (idleEnough && now - lastDanteShrug > 20 * 60_000) {
      lastDanteShrug = now;
      dbg("dante beat: shrug (20min idle clock)");
      demoSeated(idleClip("shrug"));
    }
  }, 30_000);
}

// Demo path: the sword move outside the gaming mood (guards itself).
async function demoSword() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    await standUp();
    await playSwordMove();
  } finally {
    gagActive = false;
    setState("idle");
  }
}

async function gamingAmbience() {
  if (!beatReady() || stage.dataset.state !== "idle") return;
  const loops = 2 + Math.floor(Math.random() * 2); // 2–3 loops
  gagActive = true;
  try {
    await standUp();
    // M5: sometimes the fiery sword twirl instead of the gun spins.
    if (Math.random() < 0.4) {
      startClip(SWORDSPIN);
      window.setTimeout(sfxIgnite, 300 * paceMul());
      await sleep(danteClipTotal(SWORDSPIN) + 200);
    } else {
      // GUNSPIN settles on its last frame, so one assignment plus a long sleep
      // only played one spin and froze. Restart it for every requested pass.
      await playDante(GUNSPIN, loops);
      sfxHolster();
    }
  } finally {
    gagActive = false;
    setState("idle"); // sits back down, legs swinging
  }
  window.setTimeout(laughBeat, 1200 + Math.random() * 1500); // ...and a chuckle
}

async function gamingSpecial() {
  lastGamingSpecial = Date.now();
  await shootScene(3); // Jackpot
  await sleep(20000 + Math.random() * 90000); // some time later...
  if (beatReady()) await diveGag(); // ...the fall + climb
}

// Big gaming moments on fixed 10-min cadences: Devil Trigger at 3:00 into the
// session, sword move at 7:00 (clocks armed in the "gaming" handler), then
// every 10 min each. Checked every 5 s so beats land near their exact mark.
const GAMING_SWORD_EVERY = 10 * 60 * 1000;
const GAMING_DEVIL_EVERY = 10 * 60 * 1000;
// The Breach joins the hunt on its own 10-minute clock (user-directed), first
// at 10:00 in. With four clocks running the hunt is a near-constant show —
// that is the intent: Steam is when he actually fights.
let lastGamingSword = 0;
let lastGamingDevil = 0;
function consumeOverdueDanteClocks(reason: string, now = Date.now()): string[] {
  if (!gameSessionStartedAt) return [];
  const overdue: Array<[string, number, () => void]> = [
    ["devil", GAMING_DEVIL_EVERY, () => (lastGamingDevil = now)],
    ["sword", GAMING_SWORD_EVERY, () => (lastGamingSword = now)],
    ["spin", 20 * 60_000, () => (lastDanteSpin = now)],
    ["coin", DANTE_COIN_EVERY, () => (lastDanteCoin = now)],
    ["pizza", DANTE_PIZZA_EVERY, () => (lastDantePizza = now)],
  ];
  const folded: string[] = [];
  for (const [name, cadence, consume] of overdue) {
    const last =
      name === "devil" ? lastGamingDevil :
      name === "sword" ? lastGamingSword :
      name === "spin" ? lastDanteSpin :
      name === "coin" ? lastDanteCoin : lastDantePizza;
    if (last > 0 && now - last >= cadence) {
      consume();
      folded.push(name);
    }
  }
  if (folded.length) {
    saveGamingClocks();
    dbg(`dante backlog folded (${reason}): ${folded.join(", ")}`);
  }
  return folded;
}
// ---- The hunt table (user-directed: everything he owns fires during Steam) --
// Each beat gets its own minute mark and its own cadence, so one session walks
// through the whole repertoire instead of replaying two moves. `firstAt` is
// minutes into the session; armed on the real game-launch edge.
const HUNT_CLOCKS: Array<{
  name: string;
  firstAt: number;
  every: number;
  last: number;
  run: () => Promise<void>;
}> = [
  // THREE beats belong to the hunt (user-directed) — the rest live on the
  // daily hour table below, so a game session stays a fight, not a revue.
  { name: "unchained", firstAt: 3, every: 10 * 60_000, last: 0, run: () => unchainedScene() },
  { name: "cleave", firstAt: 7, every: 10 * 60_000, last: 0, run: () => cleaveScene() },
  { name: "breach", firstAt: 10, every: 10 * 60_000, last: 0, run: () => breachScene() },
  // The DOOR joins the hunt at 15:00 into the session (user-directed) and
  // returns each half hour; the 4h guard inside the scene keeps it special.
  { name: "door", firstAt: 15, every: 30 * 60_000, last: 0, run: () => doorFightScene(true) },
];
const HARD_BEAT_RESERVE_MS = 45_000;

function huntBeatDueSoon(withinMs = HARD_BEAT_RESERVE_MS, now = Date.now()) {
  return (
    isCorvin() &&
    HUNT_CLOCKS.some((clock) => clock.last > 0 && clock.last + clock.every - now <= withinMs)
  );
}

// ---- The day's hour table (user-directed) ----------------------------------
// Everything that isn't a hunt beat gets a fixed hour instead. One firing per
// hour per day, remembered in story.json so a restart can't replay it.
const DAILY_HOURS: Array<{ h: number; name: string; run: () => void }> = [
  // The sleep trilogy used to exist only behind a Director roll. At 02:00 it
  // now has a real night appointment, after the 00:40 watch has settled.
  { h: 2, name: "sleep", run: () => void sleepScene() },
  // Afternoon through night (user-directed): mornings played to an empty room.
  // The three hunt beats keep daily slots too, so you see them on days with
  // no games at all.
  { h: 12, name: "scan", run: () => void magicscanScene() },
  { h: 14, name: "unchained", run: () => void unchainedScene() },
  {
    h: 15,
    name: "charge",
    run: () =>
      void corvinScene(async () => {
        sfxIgnite();
        await playCorvin(CORVIN.charge);
      }, ACCENT.success),
  },
  { h: 16, name: "artsiv-flight", run: () => void artsivCycleScene() },
  { h: 18, name: "execution", run: () => void executionScene() },
  // 19:00 — the Door fight (the aura still lives on level-ups + the director)
  { h: 19, name: "door", run: () => void doorFightScene() },
  { h: 20, name: "cleave", run: () => void cleaveScene() },
  { h: 21, name: "combo", run: () => void comboFlowScene() },
  { h: 22, name: "artsiv-strike", run: () => void artsivStrikeScene() },
  // the evening sip before the requiem — otherwise flask only wins the
  // director's lottery once in a blue moon and nobody ever sees it
  { h: 23, name: "flask", run: () => void corvinScene(() => playCorvin(CORVIN.flask)) },
];
function armHuntClocks(startedAt = Date.now()) {
  for (const c of HUNT_CLOCKS) c.last = startedAt - c.every + c.firstAt * 60_000;
  dbg(`hunt clocks armed: ${HUNT_CLOCKS.map((c) => `${c.name}@${c.firstAt}:00`).join(", ")}`);
}

function consumeOverdueHuntClocks(reason: string, now = Date.now()) {
  if (!gameSessionStartedAt) return;
  const overdue = HUNT_CLOCKS.filter((c) => c.last > 0 && now - c.last >= c.every);
  if (!overdue.length) return;
  for (const c of overdue) c.last = now;
  saveGamingClocks();
  dbg(`hunt backlog folded (${reason}): ${overdue.map((c) => c.name).join(", ")}`);
}

function scheduledClockOnResume(
  startedAt: number,
  firstAtMinutes: number,
  every: number,
  now: number,
  saved: number,
) {
  // An armed first appointment deliberately stores a timestamp before the
  // session start (`start - cadence + firstAt`). Preserve that value: if ECHO
  // restarts after the appointment, the overdue hard beat must still run.
  if (saved >= startedAt - every && saved <= now) return saved;
  const firstDue = startedAt + firstAtMinutes * 60_000;
  if (now < firstDue) return startedAt - every + firstAtMinutes * 60_000;
  // No saved per-beat state means this is the first build with persistence.
  // Treat appointments before the restart as consumed instead of replaying a
  // burst of 3/7/10-minute fights immediately on boot.
  return firstDue + Math.floor((now - firstDue) / every) * every;
}

function restoreGamingClocks(startedAt: number, now: number) {
  let saved: Record<string, number> = {};
  try {
    saved = JSON.parse(localStorage.getItem(GAME_SESSION_CLOCKS_KEY) || "{}");
  } catch {
    /* repaired below from the session timeline */
  }
  for (const c of HUNT_CLOCKS) {
    c.last = scheduledClockOnResume(startedAt, c.firstAt, c.every, now, Number(saved[c.name] || 0));
  }
  lastGamingDevil = scheduledClockOnResume(
    startedAt,
    3,
    GAMING_DEVIL_EVERY,
    now,
    Number(saved.danteDevil || 0),
  );
  lastGamingSword = scheduledClockOnResume(
    startedAt,
    7,
    GAMING_SWORD_EVERY,
    now,
    Number(saved.danteSword || 0),
  );
  lastDanteSpin = scheduledClockOnResume(startedAt, 6, 20 * 60_000, now, Number(saved.danteSpin || 0));
  lastDanteCoin = scheduledClockOnResume(
    startedAt,
    12,
    DANTE_COIN_EVERY,
    now,
    Number(saved.danteCoin || 0),
  );
  lastDantePizza = scheduledClockOnResume(
    startedAt,
    18,
    DANTE_PIZZA_EVERY,
    now,
    Number(saved.dantePizza || 0),
  );
  dbg(`game clocks restored at ${Math.floor((now - startedAt) / 60_000)}m`);
}

function saveGamingClocks() {
  const clocks: Record<string, number> = {
    danteDevil: lastGamingDevil,
    danteSword: lastGamingSword,
    danteSpin: lastDanteSpin,
    danteCoin: lastDanteCoin,
    dantePizza: lastDantePizza,
  };
  for (const c of HUNT_CLOCKS) clocks[c.name] = c.last;
  localStorage.setItem(GAME_SESSION_CLOCKS_KEY, JSON.stringify(clocks));
}
let nextGamingAmbience = 0;

let lastBeatSkipLog = 0;
function scheduleGamingBeat() {
  window.setTimeout(async () => {
    try {
      const now = Date.now();
      if (!gamingActive()) clearGamingSession();
      if (gamingActive() && beatReady() && !requiemPendingNow()) {
        // Corvin's hunt runs off the clock TABLE below, so every move he owns
        // gets its own minute mark inside a session (user-directed: "all
        // animations on time in Steam"). Most-overdue wins when two are due.
        const due = isCorvin()
          ? HUNT_CLOCKS.filter((c) => c.last > 0 && now - c.last >= c.every).sort(
              (a, b) => (now - b.last) / b.every - (now - a.last) / a.every,
            )
          : [];
        // The 15:00 Door is a fixed appointment, not an ambient suggestion.
        // It wins over another overdue hunt beat and bypasses the generic
        // three-minute scene gap; beatReady() above still prevents overlap.
        const c = due.find((clock) => clock.name === "door") ?? due[0];
        if (c) {
          // A busy stage can make several appointments overdue together. Play
          // the strongest one and consume the cohort: replaying each missed
          // timestamp in turn makes a returning companion look accelerated.
          for (const clock of due) clock.last = now;
          saveGamingClocks();
          markScene();
          if (due.length > 1) {
            dbg(`hunt backlog folded (beat ${c.name}): ${due.map((clock) => clock.name).join(", ")}`);
          }
          dbg(`hunt ${c.name} (${c.firstAt}:00 + ${Math.round(c.every / 60_000)}m)`);
          await c.run();
        } else if (isDante() && lastGamingDevil > 0 && now - lastGamingDevil > GAMING_DEVIL_EVERY && sceneAllowed()) {
          const folded = consumeOverdueDanteClocks("devil beat", now);
          saveGamingClocks();
          if (folded.length > 1) dbg(`dante backlog selected devil from: ${folded.join(", ")}`);
          markScene();
          dbg("gaming devil trigger (3:00 + 10min cadence)");
          devilTriggerScene();
        } else if (
          isDante() &&
          swordReady &&
          lastGamingSword > 0 &&
          now - lastGamingSword > GAMING_SWORD_EVERY &&
          sceneAllowed()
        ) {
          const folded = consumeOverdueDanteClocks("sword beat", now);
          saveGamingClocks();
          if (folded.length > 1) dbg(`dante backlog selected sword from: ${folded.join(", ")}`);
          markScene();
          dbg("gaming sword move (7:00 + 10min cadence)");
          await demoSword();
        } else if (
          isDante() &&
          now - lastGamingSpecial > 60 * 60 * 1000 &&
          sceneAllowed() && // it blocks the beat chain for up to 2 min — gate it
          Math.random() < 0.35
        ) {
          lastGamingSpecial = now;
          dbg("gaming special (hourly)");
          await gamingSpecial();
        } else if (now > nextGamingAmbience && !huntBeatDueSoon(HARD_BEAT_RESERVE_MS, now)) {
          // Small flourishes keep their own loose ~1.5-3.5 min rhythm. Most are
          // chosen by the learned Director; the old huntwatch remains only a
          // rare quiet beat instead of becoming the whole gaming personality.
          nextGamingAmbience = now + 90_000 + Math.random() * 120_000;
          if (isCorvin()) {
            if (Math.random() < 0.2) await huntwatchPass();
            else runCorvinClock(false);
          }
          else if (isKael()) {
            if (Math.random() < 0.25) await kaelHuntLoopPass();
            else runKaelClock(false);
          }
          else await gamingAmbience();
        }
      } else if (gamingActive() && now - lastBeatSkipLog > 60_000) {
        // A beat wanted to run but a guard vetoed it — name the guard so a
        // silent 2-hour drought is diagnosable from the log.
        lastBeatSkipLog = now;
        dbg(
          `gaming beat skipped: gag=${gagActive} show=${showcasing} away=${away} ` +
            `ret=${returning} wand=${wandering} com=${committed()} home=${!!home}`,
        );
      }
    } catch (err) {
      dbg(`gaming beat error: ${err}`);
    }
    // The chain must survive a throwing beat — a dead timer means no sword
    // for the rest of the session.
    scheduleGamingBeat();
  }, 5_000);
}

// M3 blink: closed-eye variants of the held idle frames (hand-pixel-edited,
// public/pixel/blink). He blinks every ~3-6 s while holding still.
const BLINKS: Record<string, string> = {};
for (const n of ["sitswing", "sitcross", "sitthink", "checkwatch"])
  BLINKS[`/pixel/${n}/frame_8.png`] = `/pixel/blink/${n}_8.png?v=15`;
const urlKeyOf = (url: string) => (url.match(/\/pixel\/[^?]+/) || [url])[0];

// Freeze on the last frame of `c` for `ms`, then run `next` (if still idle).
function holdStill(c: Clip, ms: number, next: () => void) {
  const last = c.frames[c.frames.length - 1];
  curClip = { frames: [last], ms: 600, loop: true, settle: 0 };
  frameIdx = 0;
  afterClip = null;
  const variant = BLINKS[urlKeyOf(last)];
  if (variant) {
    const held = curClip;
    const blink = () => {
      if (curClip !== held) return; // the hold ended — stop blinking
      held.frames[0] = variant;
      sprite.src = variant;
      window.setTimeout(() => {
        if (curClip === held) {
          held.frames[0] = last;
          sprite.src = last;
        }
        window.setTimeout(blink, 2600 + Math.random() * 3400);
      }, 160);
    };
    window.setTimeout(blink, 1200 + Math.random() * 2200);
  }
  window.setTimeout(() => {
    if (stage.dataset.state === "idle" && !gagActive && !showcasing) next();
  }, ms);
}

let curUrge: IdleUrge | null = null;
let idlePlaysLeft = 0;
let lastIdleClip: string | null = null;

function playDantePlannedIdle(name: string) {
  const urge = dantePolishUrge(name);
  if (!urge || !isDante() || stage.dataset.state !== "idle") return;
  curUrge = urge;
  lastIdleClip = urge.clip;
  idlePlaysLeft = urge.plays;
  // Use the normal idle owner so frame speed, mood pace, authored repeats and
  // hold/reverse physics remain exactly the same as before hard scheduling.
  startClip(idleClip(urge.clip), idleStepDone);
}

function playIdleCycle() {
  if (isKael()) {
    if (kaelMode === "work" || kaelMode === "watch" || kaelMode === "night" || kaelMode === "away") return;
    if (gamingActive() && kaelWeaponForm === "sword") {
      kaelMode = "combat";
      startClip(KAEL.combat_idle_v2 as Clip);
    } else {
      kaelMode = "idle";
      startClip(KAEL.breathe as Clip);
    }
    return;
  }
  if (isCorvin()) {
    corvinIdleCycle();
    return;
  }
  // M2 serialized gag: the pizza he never gets — once a week at most, and the
  // M5 payoff animation stays locked until he's earned it by asking.
  if (Math.random() < 0.05) {
    const l = story.pizzaLine();
    if (l) showBubble(l, PRIO.NOTABLE);
  }
  // M5 payoff, user-tuned cadence: pizza roughly once per 4 days.
  const PIZZA_EVERY = 4 * 86_400_000;
  if (!story.s.gags.lastPizzaPayoffAt) {
    story.s.gags.lastPizzaPayoffAt = Date.now(); // clock starts on first run
    story.save();
  }
  if (
    Date.now() - story.s.gags.lastPizzaPayoffAt > PIZZA_EVERY &&
    Math.random() < 0.06 &&
    !gagActive &&
    home
  ) {
    story.s.gags.lastPizzaPayoffAt = Date.now();
    story.save();
    dbg("pizza payoff!");
    void demoSeated(PIZZA, "Finally.");
    return;
  }
  curUrge = pickIdle(life, lastIdleClip, danteDirector.st.weights);
  // Dante learns like Corvin: the new poses feed the reaction watcher — kept
  // working = the pose earns weight, grabbed the mouse = it fades.
  if (curUrge.clip.startsWith("d_")) watchReaction(curUrge.clip, danteDirector);
  // M5, user-tuned: sword care roughly once per 2 days — when the cooldown
  // holds, the urge quietly becomes leg-swinging instead.
  if (curUrge.clip === "cleansword") {
    const last = story.s.gags.lastSwordCareAt ?? 0;
    if (Date.now() - last < 2 * 86_400_000) {
      curUrge = { clip: "sitswing", plays: 2, hold: [8000, 16000] };
    } else {
      story.s.gags.lastSwordCareAt = Date.now();
      story.save();
      dbg("sword care (2-day cadence)");
    }
  }
  lastIdleClip = curUrge.clip;
  idlePlaysLeft = curUrge.plays;
  curClip = idleClip(curUrge.clip);
  frameIdx = 0;
  afterClip = idleStepDone;
}

function idleStepDone() {
  if (!curUrge) {
    playIdleCycle();
    return;
  }
  idlePlaysLeft -= 1;
  if (idlePlaysLeft > 0) {
    curClip = idleClip(curUrge.clip);
    frameIdx = 0;
    afterClip = idleStepDone;
    return;
  }
  const [lo, hi] = curUrge.hold;
  // M5: waking from a nap is its own little scene, not a teleport to alert.
  const next =
    curUrge.clip === "nap"
      ? () => {
          startClip(WAKEUP, () => playIdleCycle());
        }
      : playIdleCycle;
  const heldClip = curUrge.clip;
  const leaveHold = REVERSIBLE_IDLE_POSES.has(heldClip)
    ? () => startClip(reversedClip(idleClip(heldClip)), next)
    : next;
  holdStill(idleClip(heldClip), lo + Math.random() * (hi - lo), leaveHold);
}

function playWalk(leaving = false) {
  cancelAnimationFrame(winTween); // walking overrides any sit/stand tween
  // Corvin walks in with the sword over the shoulder and OUT with it slung
  // across his back, the way knights carry it home.
  startClip(
    isKael()
      ? (KAEL.walkin as Clip) // side-profile walk-in from the Kael references
      : isCorvin()
        ? ((leaving ? CORVIN.walkout : CORVIN.walkin) as Clip)
        : WALK,
  );
}

// Sprite directories whose frames are authored AGAINST WINDOW MOVEMENT: the
// gait cycle in slideFootstepWindow, the ride, and the sit that plays while
// moveWindowY lowers him onto the panel. Matched on the frame path so the
// reversed variants (stand-up, walk-out) are covered by the same rule.
const PHYSICAL_DIRS = [
  "/pixel/sidewalk/",
  "/pixel/sitpanel/",
  "/pixel/d_motoride/",
  "/pixel/corvin/walkin/",
  "/pixel/corvin/walkout/",
  "/pixel/corvin/c_bbqwalk/",
  "/pixel/kael/walkin/",
];
const isPhysicalClip = (c?: Clip) =>
  !!c && PHYSICAL_DIRS.some((d) => c.frames[0]?.includes(d));

// Ambient life breathes with his mood: tired runs a little heavy, wired runs a
// little quick. Flattening this to a hard 1.0 made every idle, work and loop
// clip ~14% slower at full energy — that is the sluggishness, not the art.
//
// It applies to AMBIENT LIFE ONLY. Everything choreographed against wall-clock
// stays at exactly 1.0, because nothing else scales with it:
//   * walking — slideFootstepWindow derives its gait phase from the RAW msSeq
//     total and moves the window at a fixed px/s. Legs cycling 12% quicker than
//     the window travels shortens the stride into a mince: the "fast walk that
//     doesn't land" (user-reported).
//   * sitting/standing — moveWindowY runs on fixed 300/400/900 ms tweens, so a
//     quicker sit finishes with him still hanging in the air.
//   * the intro, the leave and the return — hand-timed `await sleep(...)` beats
//     between poses, exactly like a scene, just without gagActive. That arrival
//     chain reading as "very fast moves in 2 seconds" is this.
function paceMul(c?: Clip): number {
  if (gagActive || introActive || showcasing || returning || wandering || away) return 1;
  if (isKael() && kaelMode !== "idle") return 1;
  if (isPhysicalClip(c)) return 1;
  return Math.min(1.12, Math.max(0.88, 1.14 - life.v.energy * 0.26));
}

let curClip: Clip = ANIMS.idle;
let frameIdx = 0;
let frameTimer = 0;
let frameGeneration = 0;
let observedClip: Clip = curClip;

// Clip changes can happen while the old frame is holding for up to 600 ms.
// Re-arm the clock immediately so a scene always paints frame 0 before its
// choreography timers start. The observer also covers legacy direct curClip
// assignments; startClip handles deliberate restarts of the same clip.
function restartFrameLoop() {
  window.clearTimeout(frameTimer);
  frameGeneration += 1;
  frameLoop();
}
function startClip(c: Clip, next: (() => void) | null = null) {
  curClip = c;
  frameIdx = 0;
  afterClip = next;
  restartFrameLoop();
}
function frameLoop() {
  const generation = frameGeneration;
  observedClip = curClip;
  sprite.src = curClip.frames[frameIdx];
  const shownMs = (curClip.msSeq?.[frameIdx] ?? curClip.ms) * paceMul(curClip);
  frameIdx++;
  if (frameIdx >= curClip.frames.length) {
    if (curClip.loop) {
      frameIdx = curClip.settle; // hold the settled pose, don't replay the intro
    } else if (afterClip) {
      const fn = afterClip;
      afterClip = null;
      const finishedClip = curClip;
      // The old loop called the link immediately after painting the final frame,
      // so its authored hold (often the 300-700 ms weight/contact beat) was never
      // visible. Finish that frame at normal 1.0 timing before entering the next
      // pose. This is also the hard ceiling against accidental fast-forward.
      frameTimer = window.setTimeout(() => {
        if (generation !== frameGeneration || curClip !== finishedClip) return;
        fn();
        // Modern callbacks use startClip() and own the next timer. Legacy links
        // assign curClip directly; re-arm them here instead of waiting for RAF.
        if (generation === frameGeneration) restartFrameLoop();
      }, shownMs);
      return;
    } else if (gagActive || (isKael() && kaelMode !== "idle")) {
      // A sleep-driven scene (playCorvin) owns this one-shot: HOLD the settle
      // frame. Running past the end put frames[length] = undefined on screen —
      // the broken-image flash the capture rig kept catching.
      frameIdx = Math.min(curClip.settle, curClip.frames.length - 1);
    } else if (stage.dataset.state === "idle") {
      playIdleCycle(); // a one-shot (laugh) ended while idle -> resume the rotation
    } else {
      curClip = ANIMS.idle;
      frameIdx = 0;
    }
  }
  // An afterClip callback may have synchronously started another clip. Its new
  // timer owns playback; never leave a second stale loop running beside it.
  if (generation !== frameGeneration) return;
  frameTimer = window.setTimeout(frameLoop, shownMs);
}

let idleTimer: number | undefined;
let bubbleTimer: number | undefined;

// Work poses rotate so a long coding run isn't one clip looping forever.
const WORK_POSES = ["gunspin", "sit", "taunt"];
let workIdx = 0;
// A session is a stream of short bursts with `idle` in every gap. Sitting down
// the instant one pauses — then standing again eight seconds later when the
// next tool call lands — is the other half of the pacing. He only takes the
// seat once the work has actually stopped.
const DANTE_WORK_SETTLE_MS = 25_000;
let lastDanteWorkAt = 0;
let danteSettleTimer = 0;

function setState(state: State, force = false) {
  // While YOU are typing, the laptop stays out — ambient AI poses don't
  // interrupt it (scenes still can, they run through their own path).
  if (!force && Date.now() < typingUntil && state !== "success" && state !== "error") {
    stage.dataset.state = state;
    document.documentElement.style.setProperty("--accent", ACCENT[state]);
    return;
  }
  // A committed one-shot (pizza, sword care, laugh) FINISHES: ambient work
  // chatter updates the accent but must not yank the clip mid-bite.
  if (!force && committed() && state !== "success" && state !== "error") {
    stage.dataset.state = state;
    document.documentElement.style.setProperty("--accent", ACCENT[state]);
    return;
  }
  const prev = stage.dataset.state;
  stage.dataset.state = state;
  document.documentElement.style.setProperty("--accent", ACCENT[state]);
  // A state event may arrive while the body is physically between postures.
  // Record the newest intent, then let the bridge callback apply it from its
  // contact frame instead of replacing a half-seated body.
  if (isDante() && dantePostureTransition !== null) return;
  afterClip = null;
  // See the posture block below: while he is already on his feet, a thinking
  // beat is played standing instead of sitting him down and straight back up.
  if (isDante() && (state === "coding" || state === "searching" || state === "speaking")) {
    lastDanteWorkAt = Date.now();
  }
  const danteThinksOnFeet = isDante() && state === "thinking" && !seatedNow;
  // Same rule for the gaps between bursts: `idle` may not seat him while the
  // session is still warm. It keeps him on his feet in the standing considering
  // pose, and a timer takes the seat once the work has genuinely stopped.
  const danteWaitsOnFeet =
    isDante() &&
    state === "idle" &&
    !seatedNow &&
    Date.now() - lastDanteWorkAt < DANTE_WORK_SETTLE_MS;
  // movePosture=false: change the clip only. Used by the dwell hold below —
  // posture() would queue its own retry and later move the window with no
  // sit/stand clip at all, which is the silhouette teleport the bridge exists
  // to prevent.
  const applyPose = (movePosture = true) => {
    if (state === "idle") {
      if (danteWaitsOnFeet) {
        // Standing pause between bursts. playIdleCycle() would start his seated
        // idle art at standing height, which reads as sunk under the taskbar.
        const wait = clip("sit", 200, true, 8);
        wait.msSeq = STAND_CROSS.msSeq;
        startClip(wait);
        return;
      }
      if (movePosture) posture(state);
      playIdleCycle();
      return;
    }
    // Entering thinking: a low "Hmm." — but only when he's been quiet a while
    // and I'm not mid-burst, so it reads as a thought, not a tic.
    if (
      state === "thinking" &&
      prev !== "thinking" &&
      !busyBurst() &&
      Date.now() - lastVoiceAt > VOICE_MIN_GAP
    ) {
      lastVoiceAt = Date.now();
      say("hmm");
    }
    if (isDante() && (state === "coding" || state === "searching" || state === "speaking")) {
      if (prev !== state) workIdx = (workIdx + 1) % WORK_POSES.length;
      const name =
        life.v.cockiness > 0.65 && Math.random() < 0.3 ? "taunt" : WORK_POSES[workIdx];
      const workClip = clip(name, name === "gunspin" ? 90 : 200, true, name === "gunspin" ? 0 : 8);
      if (name === "gunspin") workClip.msSeq = GUNSPIN.msSeq;
      if (name === "taunt") workClip.msSeq = TAUNT.msSeq;
      if (name === "sit") workClip.msSeq = STAND_CROSS.msSeq;
      startClip(workClip);
    } else if (danteThinksOnFeet) {
      // Standing think: arms crossed, considering. Loops like the other work
      // poses so a long pause holds instead of falling back to seated art.
      const think = clip("sit", 200, true, 8);
      think.msSeq = STAND_CROSS.msSeq;
      startClip(think);
    } else {
      startClip(ANIMS[state] ?? ANIMS.idle);
    }
    if (movePosture) posture(state);
  };

  if (isDante()) {
    // `thinking` must never CAUSE a sit — it may only keep the pose he has.
    //
    // Its clip (sitthink) is seated art while coding/searching/speaking are all
    // standing, so a working session alternates between opposite postures every
    // couple of seconds. The dwell below paces that oscillation but cannot stop
    // it: he still stood up and sat down every six seconds, forever.
    //
    // Thinking on his feet is the honest reading of a pause between two work
    // poses, and the art for it already exists — STAND_CROSS, "standing, arms
    // crossed, considering", which is his `searching` clip. Seated thinking is
    // still what happens when he is genuinely at rest and thinks.
    const targetSeated = danteThinksOnFeet || danteWaitsOnFeet ? false : SEATED.has(state);
    // Without this the last `idle` of a session would already have been held,
    // and nothing would ever come back to seat him — he'd stand until the next
    // burst. Re-run the decision once the settle window closes.
    window.clearTimeout(danteSettleTimer);
    if (danteWaitsOnFeet) {
      danteSettleTimer = window.setTimeout(
        () => {
          if (!isDante() || gagActive || showcasing || away || returning || wandering) return;
          if ((stage.dataset.state || "idle") !== "idle" || seatedNow) return;
          dbg("dante work settled -> taking the seat");
          setState("idle", true);
        },
        DANTE_WORK_SETTLE_MS - (Date.now() - lastDanteWorkAt) + 250,
      );
    }
    // AI states alternate every couple of seconds during a working burst —
    // thinking (seated) then coding (standing) then thinking again — and each
    // flip drove a FULL sit/stand bridge. Measured in echo-fe.log: three
    // transitions inside six seconds. He spent the session popping up and down.
    //
    // POSTURE_DWELL_MS was meant to stop exactly this, but it lives inside
    // posture() and the bridge calls that with force=true, so the dwell never
    // applied to the one path that actually moves his body.
    //
    // Hold the pose through the burst. The state, accent and bubble still
    // update; only the physical stand/sit waits for the activity to settle,
    // which is what makes it read as a person working rather than a toy.
    if (seatedNow !== targetSeated && Date.now() - postureChangedAt < POSTURE_DWELL_MS) {
      dbg(`dante posture hold: ${state} wants ${targetSeated ? "seated" : "standing"}`);
      // Keep whatever clip fits the posture he is actually in. A seated pose at
      // standing height (or the reverse) reads as sunk under the taskbar.
      if (!seatedNow && (state === "coding" || state === "searching" || state === "speaking")) {
        applyPose(false); // standing work pose — matches the body he already has
      }
      return;
    }
    const linked = startDantePostureBridge(targetSeated, () => {
      const latest = (stage.dataset.state || "idle") as State;
      if (latest === state) applyPose();
      else setState(latest, true);
    });
    if (linked) return;
  }
  if (
    isCorvin() &&
    state !== "idle" &&
    (
      corvinPostureTransition !== null ||
      corvinSeatedNow ||
      corvinQuietPose === "meditate" ||
      corvinQuietPose === "whet" ||
      SEATED_CLIPS.has(curClip)
    )
  ) {
    void ensureCorvinStanding(`state ${state}`).then(() => {
      if (!isCorvin()) return;
      const latest = (stage.dataset.state || "idle") as State;
      if (latest === state) applyPose();
      else setState(latest, true);
    });
    return;
  }
  applyPose();
}

function finishSceneIdle(source: string) {
  // The final playCorvin() intentionally protects its settle frame for 300 ms.
  // Once the scene's own `finally` runs that protection is stale; letting the
  // normal setState guards see it leaves the transition frame frozen forever.
  committedUntil = 0;
  setState("idle", true);
  dbg(`${source} end -> idle`);
}

const CORVIN_RARE_LINES = [
  "Люди по-прежнему любят смотреть истории...",
  "Раньше у костра. Теперь на экране.",
  "Тишина... Иногда она говорит громче.",
  "Орел говорит, что ты давно не отдыхал.",
  "Не каждый меч оставляет шрам. Некоторые оставляют память.",
];
function maybeCorvinRareLine() {
  // These are film remarks, not ambient desktop chatter. Speak only from the
  // settled watch loop, never while he is inside the rift, eating, or resting.
  if (
    !home ||
    !isCorvin() ||
    !mediaWatching ||
    curClip !== (CORVIN.watchloop as Clip) ||
    quietNow() ||
    introActive ||
    wandering ||
    away ||
    returning ||
    showcasing
  ) return;
  const pool = CORVIN_RARE_LINES.filter((line) => voiceLineOk(line, 60 * 60_000));
  const line = pickLine(pool.length ? pool : CORVIN_RARE_LINES);
  markVoiceLine(line);
  lastVoiceAt = Date.now();
  showBubble(line, PRIO.NOTABLE, 6500, false);
  void speakLine(line);
  dbg(`corvin rare line: ${line}`);
}

// ---- Attention budget -------------------------------------------------
// A companion that interrupts is a companion you close. Every reaction has a
// cost, and he spends it carefully:
//   0 AMBIENT  work/idle chatter — bubble sometimes, NEVER voiced
//   1 NOTABLE  small win/error   — bubble always, voiced only if quiet lately
//   2 MAJOR    Jackpot / Devil Trigger / leaving — always voiced
const PRIO = { AMBIENT: 0, NOTABLE: 1, MAJOR: 2 } as const;
const VOICE_MIN_GAP = 240_000; // ≥4 min between spoken lines — rare = memorable
const SCENE_MIN_GAP = 180_000; // ≥3 min between big animated scenes
const AMBIENT_BUBBLE_CHANCE = 0.10; // most work chatter stays silent
let lastVoiceAt = 0;
let lastSceneAt = 0;
// Recent event timestamps -> "is he hammering tool calls right now?"
const recentEvents: number[] = [];
function busyBurst(): boolean {
  const now = Date.now();
  while (recentEvents.length && now - recentEvents[0] > 30_000) recentEvents.shift();
  return recentEvents.length > 12; // heavy activity -> stay out of the way
}
// Is the AI mid-flow (rapid state changes)? Defer flashy reactions so he
// stays focused while you work — celebrations land when the dust settles.
function aiMidFlow(): boolean {
  const now = Date.now();
  const recent = recentEvents.filter(t => now - t < 15_000);
  return recent.length >= 3;
}
// May a big animated scene run now? (rate-limited so they stay special)
function sceneAllowed(): boolean {
  return Date.now() - lastSceneAt >= SCENE_MIN_GAP;
}
function markScene() {
  lastSceneAt = Date.now();
}

function showBubble(
  text: string | null,
  prio: number = PRIO.NOTABLE,
  durationMs = 4500,
  allowVoice = true,
) {
  // Ambient chatter: usually skipped entirely, and always silent. Decide
  // BEFORE touching the hide timer — a bailing ambient call used to clear the
  // previous bubble's hide timeout and leave it stuck on screen forever.
  if (text && prio === PRIO.AMBIENT) {
    // M2: a Stranger (week one) talks half as much — reserve is earned away.
    const chance =
      story.chapter() === "stranger" ? AMBIENT_BUBBLE_CHANCE / 2 : AMBIENT_BUBBLE_CHANCE;
    if (busyBurst() || Math.random() > chance) return;
  }
  if (bubbleTimer) {
    clearTimeout(bubbleTimer);
    bubbleTimer = undefined;
  }
  if (!text) {
    bubble.classList.add("hidden");
    return;
  }
  bubble.textContent = text;
  bubble.classList.remove("hidden");
  const now = Date.now();
  const mayVoice =
    prio === PRIO.MAJOR || (prio === PRIO.NOTABLE && now - lastVoiceAt >= VOICE_MIN_GAP);
  if (allowVoice && mayVoice) {
    lastVoiceAt = now;
    voiceSay(text); // real recorded line if we have one, else a blip
  }
  bubbleTimer = window.setTimeout(() => {
    bubble.classList.add("hidden");
    bubbleTimer = undefined;
  }, durationMs);
}

function hideBubbleAfter(durationMs: number) {
  if (bubbleTimer) window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => {
    bubble.classList.add("hidden");
    bubbleTimer = undefined;
  }, durationMs);
}

function scheduleIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  // Don't let the idle fallback clobber a running scene (showcase / gag / intro).
  idleTimer = window.setTimeout(() => {
    // Also skip while he's walking off / away / coming back, or the idle pose
    // would drop him into a seat mid-walk.
    if (!showcasing && !gagActive && !introActive && !wandering && !away && !returning)
      setState("idle");
  }, IDLE_AFTER_MS);
}

let lastLevel = 1;
function levelUpFlash(withRoar = true) {
  stage.classList.remove("leveling");
  void stage.offsetWidth; // restart the CSS animation
  stage.classList.add("leveling");
  vignettePulse(); // red Devil-Trigger flash over the whole window
  shake(500);
  sfxAura();
  if (withRoar) sfxDemonRoar(); // the monster under the red glow
  window.setTimeout(() => stage.classList.remove("leveling"), 1300);
}

let stateShownAt = 0;
let pendingEv: AgentEvent | null = null;
let pendingTimer: number | undefined;
let prevStars = -1;
const STAR_MILESTONE = 25;
// Emotional continuity: wins/errors build up. Small ones get a light beat; a
// streak earns the big scene (Jackpot / breakdown), so the payoffs feel earned.
let winStreak = 0;
let errStreak = 0;
const WIN_LINES = ["Easy.", "Heh."];
const SHRUG_LINES = ["Pff.", "Doesn't count."];
// M2 demon-hunt framing: an error streak is a demon, and demons bite.
const DEMON_LINES = ["This one bites.", "Big demon.", "It's hunting me."];

// Dante's posture bridge owns both the authored sitpanel frames and the window
// height. Callers only begin their pack after the bridge reaches its contact
// frame, so seated and standing silhouettes can never replace one another.
let dantePostureTransition: boolean | null = null;
function startDantePostureBridge(toSeated: boolean, done: () => void): boolean {
  if (!home || !isDante() || dantePostureTransition !== null || seatedNow === toSeated) return false;
  cancelAnimationFrame(winTween);
  window.clearTimeout(postureSettle);
  delete stage.dataset.facing;
  afterClip = null;
  const bridge = toSeated ? SITDOWN : reversedClip(SITDOWN);
  dantePostureTransition = toSeated;
  const total = danteClipTotal(bridge);
  if (!toSeated) sfxRustle();
  // Keep the established root-motion timings. Only the missing body frames are
  // added; no clip `ms`, `msSeq`, or playback multiplier is changed.
  posture(toSeated ? "idle" : "coding", true);
  commitFor(total + 180);
  dbg(`dante posture: ${toSeated ? "standing -> seated" : "seated -> standing"}`);
  startClip(bridge, () => {
    const contact = bridge.frames[bridge.frames.length - 1];
    startClip({ frames: [contact], ms: 600, loop: true, settle: 0 });
    dantePostureTransition = null;
    done();
  });
  return true;
}

function ensureDantePosture(toSeated: boolean): Promise<void> {
  return new Promise((resolve) => {
    const begin = () => {
      if (!isDante()) {
        resolve();
        return;
      }
      if (dantePostureTransition !== null) {
        window.setTimeout(begin, 25);
        return;
      }
      if (!startDantePostureBridge(toSeated, resolve)) {
        posture(toSeated ? "idle" : "coding", true);
        resolve();
      }
    };
    begin();
  });
}

// Every standing scene for every companion passes here. Dante uses the real
// reversed sitpanel link; Corvin rises from his quiet seated pose; Kael's
// Director is already restricted to his connected standing idle.
async function standUp(): Promise<void> {
  if (!home) return;
  if (isDante()) {
    await ensureDantePosture(false);
    return;
  }
  if (isCorvin()) {
    await ensureCorvinStanding("scene entry");
    return;
  }
  // Kael's scene catalogue already contains its connected enter/exit clips.
}

// Light win: stand up, quick arms-up cheer, a smirk. VISIBLE on every win.
// M1.3: reaction pools — the same event doesn't always get the same answer,
// and ~20% of the time the answer is nothing at all. Every pick is logged.
function pickWeighted(items: Array<[string, number]>): string {
  let sum = 0;
  for (const [, w] of items) sum += w;
  let r = Math.random() * sum;
  for (const [k, w] of items) {
    r -= w;
    if (r <= 0) return k;
  }
  return items[0][0];
}

function reactWin() {
  // A committed one-shot OWNS the sprite: a second event arriving mid-animation
  // used to restart or replace it (user: "he breaks one animation for the
  // second trigger"). Reactions set curClip directly, bypassing setState's
  // guard, so the check has to live here too.
  if (committed()) {
    dbg("react=win skipped (animation in flight)");
    return;
  }
  if (isCorvin()) {
    reactWinCorvin();
    return;
  }
  if (isKael()) {
    void kaelLightSuccess();
    return;
  }
  const pick = pickWeighted([
    ["cheer", 0.3],
    ["flourish", 0.12 + life.v.cockiness * 0.18],
    ["laugh", 0.13],
    ["coin", 0.1], // M5: flips a coin over a win
    ["line", 0.2],
    ["nothing", 0.15 + life.v.focus * 0.15],
    // M2 Lv5 unlock: the sword joins the win pool, rare and earned.
    ["sword", story.unlocked("sword_win_pool") && swordReady ? 0.06 : 0],
  ]);
  dbg(`react=win:${pick}`);
  if (pick === "cheer") void lightWin();
  else if (pick === "flourish") void gunFlourish();
  else if (pick === "coin") void coinFlourish();
  else if (pick === "laugh") laughBeat();
  else if (pick === "sword") void demoSword();
  else if (pick === "line") showBubble(pickLine(WIN_LINES), PRIO.NOTABLE);
  // nothing: the win still counted — he just doesn't perform it
}

function reactError() {
  if (committed()) {
    dbg("react=err skipped (animation in flight)");
    return; // let the running beat finish — see reactWin()
  }
  if (isCorvin()) {
    reactErrorCorvin();
    return;
  }
  if (isKael()) {
    void kaelLightError();
    return;
  }
  // Low patience forces the cold treatment — anger is quiet.
  const pick =
    life.v.patience < 0.3
      ? "cold"
      : pickWeighted([
          ["stagger", 0.35],
          ["cold", 0.2],
          ["watch", 0.2],
          ["nothing", 0.25],
        ]);
  dbg(`react=err:${pick}`);
  if (pick === "stagger") void lightError();
  else if (pick === "cold") coldError();
  else if (pick === "watch") annoyedWatch();
}

// The cold treatment: no stagger, no sound, no shake — arms crossed, silence.
function coldError() {
  if (!home || gagActive) return;
  stage.dataset.state = "error";
  document.documentElement.style.setProperty("--accent", ACCENT.error);
  commitFor(1900);
  startClip(seatedNow ? idleClip("sitcross") : STAND_CROSS);
}

// Seated annoyed watch-check with a shrug line.
function annoyedWatch() {
  if (!home || gagActive || !seatedNow) return void lightError();
  stage.dataset.state = "error";
  document.documentElement.style.setProperty("--accent", ACCENT.error);
  commitFor(1700);
  startClip(idleClip("checkwatch"));
  showBubble(pickLine(SHRUG_LINES), PRIO.NOTABLE);
}

// M5: stands, flips a coin over the win, checks it, sits back down.
async function coinFlourish() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    await standUp();
    startClip(COINFLIP);
    await sleep(danteClipTotal(COINFLIP) + 250);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

// A single show-off gun spin with a holster click — the cocky win reaction.
async function gunFlourish() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    await standUp();
    startClip(GUNSPIN);
    await sleep(GUNSPIN.msSeq!.reduce((a, b) => a + b, 0) * paceMul());
    sfxHolster();
    await sleep(180);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

async function lightWin() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    // Noticing beat: a human takes a moment to register before reacting —
    // an instant reaction reads scripted.
    await sleep(200 + Math.random() * 200);
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    await standUp();
    startClip(CHEER);
    sfxDing();
    showBubble(pickLine(WIN_LINES), PRIO.NOTABLE);
    await sleep(danteClipTotal(CHEER) + 120);
  } finally {
    gagActive = false;
    setState("idle");
  }
}
// Light error: stand up, quick stagger recoil. VISIBLE on every error.
async function lightError() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    await sleep(250 + Math.random() * 250); // errors take a beat longer to sink in
    stage.dataset.state = "error";
    document.documentElement.style.setProperty("--accent", ACCENT.error);
    await standUp();
    startClip(STAGGER);
    sfxThud();
    shake(220);
    showBubble(pickLine(SHRUG_LINES), PRIO.NOTABLE);
    await sleep(danteClipTotal(STAGGER) + 120);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

// Presence: after AWAY_AFTER_MS of no AI activity he wanders off; the next real
// event brings him back. lastActivity is refreshed on every agent-event.
const AWAY_AFTER_MS = 15 * 60 * 1000; // 15 min of silence -> he leaves (user-directed)
const AWAY_RETURN_MS = 10 * 60 * 1000; // then ~10 min later he comes back on his own
let lastActivity = Date.now();
let away = false;
let awayAt = 0; // when he walked off (for the auto-return timer)
let returning = false;
const LEAVE_LINES = ["Quiet. Taking a break.", "Call me if you need me.", "Bored. Going for a walk."];
const RETURN_LINES = ["Alright, let's go.", "I'm back.", "Let's get to work."];
const pickLine = (a: string[]) => a[Math.floor(Math.random() * a.length)];

function applyEvent(e: AgentEvent) {
  lastActivity = Date.now(); // any event means the AI is active
  maybeDailyRitual(); // the first activity of a new day gets its ceremony
  serviceMediaWish(); // and a queued media moment gets another chance
  // HUD + bubble are always live, even while a state is being held.
  starsEl.textContent = `★ ${e.stars}`;
  levelEl.textContent = `Lv.${e.level}`;
  // No ambient chatter over a running scene — the scene owns the screen.
  // Corvin is SILENT (user-directed): no work chatter at all — his words live
  // in the stories only. Dante keeps his phrases.
  if (!gagActive && !showcasing && isDante()) showBubble(e.phrase, PRIO.AMBIENT);
  dbg(
    `event=${e.state} home=${!!home} gag=${gagActive} show=${showcasing} away=${away} winStreak=${winStreak} errStreak=${errStreak}`,
  );
  if (gagActive || showcasing || returning || introActive || wandering) return; // a scene/walk owns the stage
  if (away) {
    returnScene(); // he's off-screen -> walk back in first; next events drive state
    return;
  }

  // Hold thinking/speaking for a minimum so they don't get clobbered instantly
  // by the next JSONL line. Defer (coalescing to the latest) until the hold
  // ends. This check MUST run before any one-shot bookkeeping below — the
  // level/star mutations used to run first, so a deferred event replayed
  // against already-updated values and the Devil-Trigger/milestone payoffs
  // were silently eaten (hard review, HIGH).
  const cur = stage.dataset.state || "idle";
  const hold = MIN_HOLD[cur] ?? 0;
  const held = performance.now() - stateShownAt;
  if (hold && held < hold && e.state !== cur) {
    pendingEv = e;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(() => {
      pendingTimer = undefined;
      const p = pendingEv;
      pendingEv = null;
      if (p) applyEvent(p);
    }, hold - held);
    return;
  }
  pendingEv = null;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }

  // One-shot bookkeeping — exactly once per event, never on the deferral path.
  recentEvents.push(lastActivity); // feeds busyBurst() — stay quiet when I'm hammering
  life.onEvent(e.state); // v2 P1: nudge the internal state
  const leveledUp = e.level > lastLevel; // handled as a Devil-Trigger scene below
  lastLevel = e.level;
  // Crossed a 25-star mark this event? (first event just seeds prevStars.)
  const crossedMilestone =
    prevStars >= 0 &&
    Math.floor(e.stars / STAR_MILESTONE) > Math.floor(prevStars / STAR_MILESTONE);
  prevStars = e.stars;

  stateShownAt = performance.now();
  // Big scenes are rate-limited (SCENE_MIN_GAP): if one just ran, the moment
  // degrades to a light beat instead of stacking spectacle on spectacle.
  // Big scenes need BOTH the time gap (sceneAllowed) AND the daily budget
  // (sceneBudgetOk) — so they stay rare and memorable, not just spaced out.
  if (e.state === "error" && home) {
    errStreak += 1;
    winStreak = 0;
    story.today().errors += 1;
    // Frustration comes from the Life vector now: low patience -> he snaps sooner.
    const snap = life.v.patience < 0.35 ? 2 : 3;
    // During a game the hunt clocks own the stage (and grab every open scene
    // window otherwise) — AI payoffs degrade to bubbles until the game ends.
    if (errStreak >= snap && !gamingActive() && !quietNow() && sceneAllowed() && sceneBudgetOk("breakdown")) {
      errStreak = 0;
      markScene();
      budgetScene("breakdown");
      if (isCorvin()) void vigilScene(); // his breakdown is a knee and the eagle
      else if (isKael()) void kaelOverloadScene();
      else {
        showBubble("Come on, seriously?", PRIO.MAJOR);
        diveGag(); // patience gone -> full breakdown
      }
      // M2: after the climb — a once-ever first, or a partner's word.
      window.setTimeout(() => {
        if (story.first("breakdown")) showBubble("First real fight. We got up.", PRIO.NOTABLE);
        else if (story.chapter() === "partner" && Math.random() < 0.3)
          showBubble("We'll fix it.", PRIO.NOTABLE);
      }, 6000);
    } else {
      // M2 demon-hunt framing: a growing streak is a demon that bites.
      if (errStreak >= 2 && Math.random() < 0.5)
        showBubble(pickLine(DEMON_LINES), PRIO.NOTABLE);
      reactError(); // M1.3: pooled — stagger, cold silence, watch-check, or nothing
    }
    scheduleIdle();
    return;
  }
  if (e.state === "success" && home) {
    const slainDemon = errStreak >= 2; // the streak this win just ended
    winStreak += 1;
    errStreak = 0;
    story.today().wins += 1;
    story.today().stars = e.stars;
    // M2 star firsts — once ever, slightly delayed so scenes finish first.
    if (e.stars >= 100 && story.first("stars100"))
      window.setTimeout(() => showBubble("A hundred stars, partner.", PRIO.NOTABLE), 2500);
    else if (e.stars >= 500 && story.first("stars500"))
      window.setTimeout(() => showBubble("Five hundred. Legendary.", PRIO.NOTABLE), 2500);
    // If the AI is still processing rapidly, bank the win — don't celebrate
    // mid-flow. The streak accumulates so he might Jackpot when dust settles.
    if (aiMidFlow()) {
      setState(e.state);
      scheduleIdle();
      return;
    }
    if (leveledUp && !gamingActive() && !quietNow() && sceneBudgetOk("devil")) {
      winStreak = 0;
      markScene();
      budgetScene("devil");
      // Unchained is Steam-only (user-directed) — a level-up gets the aura.
      if (isCorvin()) void auraScene();
      else if (isKael()) void kaelFullWeaponScene();
      else devilTriggerScene();
      // M2 level chapters: levels unlock existing content, told as story.
      if (lastLevel >= 5 && story.unlock("sword_win_pool"))
        window.setTimeout(() => showBubble("Level 5. The sword comes out now.", PRIO.NOTABLE), 4000);
      if (lastLevel >= 10 && story.first("lv10"))
        window.setTimeout(() => showBubble("Double digits. Just warming up.", PRIO.NOTABLE), 4000);
    } else if (crossedMilestone && !gamingActive() && !quietNow() && sceneAllowed() && sceneBudgetOk("dance")) {
      winStreak = 0;
      markScene();
      budgetScene("dance");
      if (isCorvin()) void nuzzleScene(); // 25★ -> the eagle's rare approval
      else if (isKael()) void kaelRestScene();
      else danceScene(); // 25★ milestone -> dance
    } else if (winStreak >= 3 && !gamingActive() && !quietNow() && sceneAllowed() && sceneBudgetOk("jackpot")) {
      winStreak = 0;
      markScene();
      budgetScene("jackpot");
      story.today().jackpots += 1;
      if (isCorvin()) void executionScene(); // on a roll -> the Execution
      else if (isKael()) void kaelStreakScene();
      else shootScene(); // on a roll -> Jackpot
      if (story.first("jackpot"))
        window.setTimeout(() => showBubble("First Jackpot. Remember this one.", PRIO.NOTABLE), 5000);
    } else if (slainDemon) {
      // M2: the win that ends an error streak is a kill, not a cheer.
      dbg("react=win:demon-slain");
      showBubble("Demon's dead.", PRIO.NOTABLE);
    } else {
      reactWin(); // M1.3: pooled — cheer, flourish, laugh, a line, or nothing
    }
    scheduleIdle();
    return;
  }
  setState(e.state);
  scheduleIdle();
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

// Home spot on the taskbar (filled in by the intro). y = standing height,
// sitY = dropped so he's seated on the panel with legs dangling.
let home: {
  win: ReturnType<typeof getCurrentWindow>;
  ox: number;
  oy: number;
  scrRight: number; // monitor's right edge (physical) — clamp popups on-screen
  winW: number;
  winH: number;
  y: number;
  sitY: number;
  belowY: number;
  cornerX: number;
  lastX: number;
  lastY: number;
} | null = null;
let wandering = false;
let gagActive = false;
let showcasing = false;
let introActive = false; // true while the walk-in is running — blocks idle/events
let winTween = 0;

// States where he sits on the taskbar edge (legs dangling); others stand.
const SEATED = new Set<string>(["idle", "thinking"]);

// Smoothly raise/lower the window between standing and seated height.
function moveWindowY(targetY: number, dur = 480) {
  if (!home) return;
  cancelAnimationFrame(winTween);
  const h = home;
  const fromY = h.lastY;
  if (fromY === targetY) return;
  const t0 = performance.now();
  const step = (now: number) => {
    if (!home) return;
    const p = Math.min(1, (now - t0) / dur);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const yy = Math.round(fromY + (targetY - fromY) * e);
    h.win.setPosition(new PhysicalPosition(h.cornerX, yy));
    h.lastY = yy;
    if (p < 1) winTween = requestAnimationFrame(step);
  };
  winTween = requestAnimationFrame(step);
}

// Posture hysteresis: rapid AI events used to flip him sit->stand->sit every
// second. He now only changes posture if he's held the current one a while
// (scenes bypass this via `force`).
const POSTURE_DWELL_MS = 6000;
let seatedNow = true;
let postureChangedAt = 0;
let postureRetry = 0;
function posture(state: string, force = false) {
  if (!home) return;
  // Corvin never takes the seated window height: his seated clips (sit,
  // whetstone, guitar, meditate) are bottom-anchored scene poses, and Dante's
  // sit-down transition clip must never play on him.
  const seated = isDante() && SEATED.has(state);
  const targetY = seated ? home.sitY : home.y;
  window.clearTimeout(postureRetry);
  if (seated === seatedNow) {
    // Self-heal: an interrupted tween can strand the window between heights
    // while the flag already agrees — he'd sit floating or stand sunk forever.
    if (Math.abs(home.lastY - targetY) > 4) moveWindowY(targetY, 300);
    return;
  }
  if (!force && Date.now() - postureChangedAt < POSTURE_DWELL_MS) {
    // The dwell blocks the move but the CLIP already changed — a standing pose
    // at seated height reads as "sunk under the taskbar" (and vice versa).
    // Re-apply once the dwell expires instead of leaving the mismatch.
    postureRetry = window.setTimeout(
      () => {
        if (gagActive || showcasing || wandering || away || returning) return;
        posture(stage.dataset.state || "idle");
      },
      POSTURE_DWELL_MS - (Date.now() - postureChangedAt) + 30,
    );
    return;
  }
  seatedNow = seated;
  postureChangedAt = Date.now();
  window.clearTimeout(postureSettle);
  if (seated) {
    // Weight: drop a touch PAST the seat, then settle up — bodies bounce.
    sfxCreak();
    moveWindowY(targetY + 5, 760);
    postureSettle = window.setTimeout(() => {
      if (seatedNow && home) moveWindowY(home.sitY, 200);
    }, 800);
  } else {
    moveWindowY(targetY, 400);
  }
}
let postureSettle = 0;

// Slide the OS window from its current X to toX at a walking pace (px/sec),
// so the speed is realistic regardless of distance.
function slideWindow(toX: number, pace = 150): Promise<void> {
  if (!home) return Promise.resolve();
  cancelAnimationFrame(winTween);
  const h = home;
  const fromX = h.lastX;
  const dur = Math.max(500, (Math.abs(toX - fromX) / pace) * 1000);
  const t0 = performance.now();
  // Boot scuffs on the footfall cadence while he walks (sound floor).
  const scuffs = window.setInterval(sfxScuff, 440);
  return new Promise<void>((resolve) => {
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      // Steady walking pace with only a brief ease-in — a crisp stop at the
      // corner (no slow decel tail that reads as "walking in place").
      const e = p < 0.12 ? (p / 0.12) ** 2 * 0.12 : p;
      const x = Math.round(fromX + (toX - fromX) * e);
      h.win.setPosition(new PhysicalPosition(x, h.y));
      h.lastX = x;
      h.lastY = h.y; // walking happens standing
      if (p < 1) winTween = requestAnimationFrame(step);
      else {
        window.clearInterval(scuffs);
        winTween = 0;
        resolve();
      }
    };
    winTween = requestAnimationFrame(step);
  });
}

// Kept only as a compatibility definition for older local scene snippets. No
// production choreography calls it; all visible walking uses footstep motion.
void slideWindow;

// Kael's side walk carries its own root motion. The OS window barely moves on
// planted-foot frames and advances during the leg swing, so the sprite reads as
// stepping across the taskbar rather than gliding over it.
// `gaitDepth` 0 = constant speed, the released v0.2.4 motion. Dante uses it:
// the pulse below swings his speed ±20% twice per 852 ms cycle, and on a long
// approach that surge-and-settle reads as extra movement rather than as weight
// (user-directed: the previous build's walk was the good one). Corvin keeps the
// pulse — his stride is slower and the contact beat lands cleanly on it.
function slideFootstepWindow(
  toX: number,
  walkClip: CorvinClip | Clip,
  pace: number,
  gaitDepth = 0.4,
): Promise<void> {
  if (!home) return Promise.resolve();
  cancelAnimationFrame(winTween);
  const h = home;
  const fromX = h.lastX;
  const dir = Math.sign(toX - fromX) || 1;
  const distance = Math.abs(toX - fromX);
  const cycleMs = "frames" in walkClip
    ? (walkClip.msSeq ?? Array(walkClip.frames.length).fill(walkClip.ms)).reduce((a, b) => a + b, 0)
    : 1000;
  let travelled = 0;
  let previous = performance.now();
  const started = previous;
  const scuffs = window.setInterval(sfxScuff, Math.max(420, cycleMs / 2));
  return new Promise<void>((resolve) => {
    const step = (now: number) => {
      const dt = Math.min(50, now - previous);
      previous = now;
      const phase = ((now - started) % cycleMs) / cycleMs;
      // Two smooth contact pulses per cycle. Average rate is exactly 1.0, while
      // the body keeps at least 71% momentum on a planted foot: weight transfer,
      // never a visible stop.
      const contact = Math.pow(Math.cos(phase * Math.PI * 2), 8);
      // cos^8 averages 35/128 over a cycle, so the base term keeps the mean rate
      // at exactly 1.0 for any depth — the distance and duration are unchanged,
      // only the smoothness. Depth 0 collapses to constant speed.
      const gaitRate = 1 + gaitDepth * 0.2734375 - gaitDepth * contact;
      travelled = Math.min(distance, travelled + (pace * dt * gaitRate) / 1000);
      const x = Math.round(fromX + dir * travelled);
      void h.win.setPosition(new PhysicalPosition(x, h.y));
      h.lastX = x;
      h.lastY = h.y;
      if (travelled < distance) {
        winTween = requestAnimationFrame(step);
      } else {
        window.clearInterval(scuffs);
        winTween = 0;
        h.lastX = toX;
        void h.win.setPosition(new PhysicalPosition(toX, h.y));
        resolve();
      }
    };
    winTween = requestAnimationFrame(step);
  });
}

const slideKaelWalk = (toX: number, pace = 125) => {
  if (!home) return Promise.resolve();
  const distance = Math.abs(toX - home.lastX);
  const cycleMs = (KAEL.walkin.msSeq ?? Array(KAEL.walkin.frames.length).fill(KAEL.walkin.ms))
    .reduce((a, b) => a + b, 0);
  const cycles = Math.max(1, Math.ceil((distance / pace) * 1000 / cycleMs));
  const fittedPace = distance / (cycles * cycleMs / 1000);
  return slideFootstepWindow(toX, KAEL.walkin, fittedPace);
};

// Motorcycle motion is deliberately separate from walking: no boot-scuff
// cadence, a short acceleration, then constant speed cleanly through the edge.
function rideWindow(toX: number, pace = 700): Promise<void> {
  if (!home) return Promise.resolve();
  cancelAnimationFrame(winTween);
  const h = home;
  const fromX = h.lastX;
  const y = h.y;
  const dur = Math.max(900, (Math.abs(toX - fromX) / pace) * 1000);
  const t0 = performance.now();
  sfxMotorcycle(dur);
  return new Promise<void>((resolve) => {
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = p < 0.16 ? (p / 0.16) ** 2 * 0.16 : p;
      const x = Math.round(fromX + (toX - fromX) * e);
      h.win.setPosition(new PhysicalPosition(x, y));
      h.lastX = x;
      h.lastY = y;
      if (p < 1) winTween = requestAnimationFrame(step);
      else {
        winTween = 0;
        resolve();
      }
    };
    winTween = requestAnimationFrame(step);
  });
}

// Re-entry after the ride uses real gravity: the OS window accelerates from
// above the monitor, drifts lightly in the air, and lands on the exact home X.
function dropWindowToTaskbar(durationMs = 1350): Promise<void> {
  if (!home) return Promise.resolve();
  cancelAnimationFrame(winTween);
  const h = home;
  const fromY = h.oy - h.winH - 18;
  const toY = h.y;
  h.lastX = h.cornerX;
  h.lastY = fromY;
  void h.win.setPosition(new PhysicalPosition(h.cornerX, fromY));
  const t0 = performance.now();
  return new Promise<void>((resolve) => {
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const fall = p * p;
      const drift = Math.round(Math.sin(p * Math.PI * 3) * (1 - p) * 7);
      const x = h.cornerX + drift;
      const y = Math.round(fromY + (toY - fromY) * fall);
      h.win.setPosition(new PhysicalPosition(x, y));
      h.lastX = x;
      h.lastY = y;
      if (p < 1) winTween = requestAnimationFrame(step);
      else {
        h.win.setPosition(new PhysicalPosition(h.cornerX, toY));
        h.lastX = h.cornerX;
        h.lastY = toY;
        winTween = 0;
        resolve();
      }
    };
    winTween = requestAnimationFrame(step);
  });
}

const BACKSTEP_WINDOW_BEATS: Array<[number, number]> = [
  [120, 0.05],
  [420, 0.17],
  [760, 0.32],
  [1120, 0.47],
  [1510, 0.62],
  [1900, 0.76],
  [2300, 0.9],
  [2650, 1],
];

function stepWindowX(toX: number, beats = BACKSTEP_WINDOW_BEATS, stepMs = 145): Promise<void> {
  if (!home) return Promise.resolve();
  cancelAnimationFrame(winTween);
  const h = home;
  const fromX = h.lastX;
  const y = h.y;
  let segment = 0;
  let segFrom = fromX;
  let segTo = fromX;
  let segStartedAt = performance.now();
  const start = segStartedAt;
  return new Promise<void>((resolve) => {
    const tick = (now: number) => {
      if (!home) {
        resolve();
        return;
      }
      const elapsed = now - start;
      while (segment < beats.length && elapsed >= beats[segment][0]) {
        segFrom = h.lastX;
        segTo = Math.round(fromX + (toX - fromX) * beats[segment][1]);
        segStartedAt = now;
        segment += 1;
        if (Math.abs(segTo - segFrom) > 1) sfxScuff();
      }
      const p = Math.min(1, (now - segStartedAt) / stepMs);
      const e = 1 - Math.pow(1 - p, 3);
      const x = Math.round(segFrom + (segTo - segFrom) * e);
      h.win.setPosition(new PhysicalPosition(x, y));
      h.lastX = x;
      h.lastY = y;
      if (segment >= beats.length && p >= 1) {
        h.win.setPosition(new PhysicalPosition(toX, y));
        h.lastX = toX;
        h.lastY = y;
        winTween = 0;
        resolve();
        return;
      }
      winTween = requestAnimationFrame(tick);
    };
    winTween = requestAnimationFrame(tick);
  });
}

// Entrance: walk in from off-screen left to the corner, then rest.
async function runIntro() {
  if (!isTauri) return;
  introActive = true;
  try {
    const win = getCurrentWindow();
    const mon = (await currentMonitor()) ?? (await primaryMonitor());
    // Linux (esp. Wayland) can answer null here. Bailing out used to leave him
    // parked wherever the compositor dropped the window — mid-desktop. Fall
    // back to the webview's own screen numbers so home is always computed.
    // (On pure Wayland setPosition may still be ignored; X11 sessions behave.)
    let sf: number, ox: number, oy: number, sw: number, sh: number;
    if (mon) {
      sf = mon.scaleFactor || 1;
      ox = mon.position.x;
      oy = mon.position.y;
      sw = mon.size.width;
      sh = mon.size.height;
    } else {
      sf = window.devicePixelRatio || 1;
      ox = 0;
      oy = 0;
      sw = Math.round(window.screen.width * sf);
      sh = Math.round(window.screen.height * sf);
      dbg("monitor query returned null — using window.screen fallback");
    }
    const { width: winW, height: winH } = await win.outerSize();

    // Measure the REAL taskbar height (full screen minus the work area) so he
    // aligns to THIS taskbar instead of a hardcoded guess.
    const availH = window.screen.availHeight; // logical px, excludes the taskbar
    const scrH = window.screen.height; // logical px, full screen
    let taskbar = Math.round((scrH - availH) * sf);
    if (!(taskbar > 4 && taskbar < sh * 0.25)) taskbar = Math.round(48 * sf); // sanity fallback
    dbg(`taskbar measured=${taskbar} availH=${availH} scrH=${scrH} sf=${sf} sh=${sh}`);
    // Sit his feet right ON the taskbar's top edge (small sink so he rests on it,
    // not buried in it). FOOT_SINK 0 = exactly on the edge; raise it to sink more.
    const panelTop = oy + sh - taskbar;
    const FOOT_SINK = 0.18;
    const y = panelTop - winH + Math.round(taskbar * FOOT_SINK);
    const startX = ox - winW - 8; // fully off-screen left
    const cornerX = ox + sw - winW - Math.round(12 * sf); // by the clock

    // Dropped so his seat lands on the panel top edge and the dangling legs
    // hang down over the taskbar. The window has extra transparent headroom
    // for speech bubbles, so this stays tied to the 190px sprite, not winH.
    const sitY = y + Math.round(74 * sf);
    // A small visible dip for the error fall — he stays fully on-screen so the
    // falling + climb animations are unmissable (no dropping off the bottom).
    const belowY = y + Math.round(66 * sf);
    home = { win, ox, oy, scrRight: ox + sw, winW, winH, y, sitY, belowY, cornerX, lastX: startX, lastY: y };
    dbg(`intro home set mon=${sw}x${sh} y=${y} sitY=${sitY} corner=${cornerX}`);
    await win.setPosition(new PhysicalPosition(startX, y));
    // Kael's authored side profile faces opposite to the shared walk sheets.
    // Mirror only his moving entrance; arrival returns to the front pose below.
    stage.dataset.facing = isKael() ? "left" : "right";
    playWalk(); // side-view walk cycle while moving
    if (isKael()) await slideKaelWalk(cornerX, 125);
    else if (isCorvin()) await slideFootstepWindow(cornerX, CORVIN.walkin, 125);
    else await slideFootstepWindow(cornerX, WALK, DANTE_WALK_PACE, 0);
    delete stage.dataset.facing;
    if (isCorvin()) {
      await sleep(400);
      // The sentinel arrives his own way: a knightly bow, then the watch.
      startClip(CORVIN.bow as Clip);
      await sleep(corvinClipTotal(CORVIN.bow) * paceMul(CORVIN.bow as Clip));
      setState("idle");
    } else if (isKael()) {
      // Root motion and the walk loop stop together; this link turns the final
      // side step into the exact front-facing idle without an in-place stride.
      const token = beginKaelMode("scene");
      try {
        await playKaelMode(token, KAEL.arrival);
        settleKaelMode(token, "kael intro arrival");
      } catch (error) {
        if (error !== KAEL_MODE_CANCELLED) throw error;
        dbg(`kael intro arrival cancelled token=${token}`);
        return;
      }
      setState("idle");
    } else {
      // He reaches his corner and sits. Nothing else (user-directed: no extra
      // movement at the edge).
      //
      // What used to live here: a mirror "glance" left and right — `facing` is
      // an instant scaleX(-1) on the whole sprite, so that was the figure
      // snapping to its own reflection and back, fired mid-way through
      // STAND_CROSS — then a stumble. Then, after that was cut, a full 1.8 s
      // stand-up followed immediately by sitting down again: rising to his feet
      // only to fold back onto the panel two seconds later is the least
      // believable thing he could do on arriving somewhere he lives.
      //
      // He is already standing when he stops walking, so the sit is the only
      // transition the moment needs.
      await sleep(300); // the step lands, weight settles
      startClip(SITDOWN);
      posture("idle", true); // drop the window to the seated height
      await sleep(danteClipTotal(SITDOWN));
      setState("idle"); // seated leg-swing loop
    }
    // Discovery > demonstration. No auto-showcase — let users find everything
    // naturally. Set localStorage "echo.forceReel"=1 + reload for debug.
    dbg("intro done -> natural (discovery > demonstration)");
  } catch (err) {
    dbg(`intro ERROR: ${err}`);
    console.error("intro failed", err);
  } finally {
    introActive = false;
    if (!localStorage.getItem("echo.firstRunHint.v1")) {
      localStorage.setItem("echo.firstRunHint.v1", "1");
      window.setTimeout(() => showBubble(FIRST_RUN_HINT, PRIO.NOTABLE), 500);
    }
    scheduleIdle();
  }
}

// After a long silence (no AI activity), Dante stands, crosses his arms, says
// something, and walks off the left edge. He stays gone until the next event.
async function leaveScene() {
  if (!home || away || returning || wandering || gagActive || showcasing) return;
  if (stage.dataset.state !== "idle") return;
  wandering = true; // reuse the guard to block laugh / idle churn
  const h = home;
  try {
    delete stage.dataset.facing;
    afterClip = null;
    await new Promise<void>((res) => (moveWindowY(h.y, 300), window.setTimeout(res, 320)));
    if (isKael()) {
      const token = beginKaelMode("away");
      try {
        await playKaelMode(token, KAEL.leave_v2);
        if (!kaelModeCurrent(token, "away")) return;
      } catch (error) {
        if (error !== KAEL_MODE_CANCELLED) throw error;
        dbg(`kael leave cancelled token=${token}`);
        return;
      }
      await h.win.hide();
      away = true;
      awayAt = Date.now();
      dbg("kael portal closed -> window hidden");
      return;
    }
    curClip = isCorvin() ? (CORVIN.windidle as Clip) : STAND_CROSS;
    frameIdx = 0;
    if (!isCorvin()) showBubble(pickLine(LEAVE_LINES), PRIO.MAJOR);
    await sleep(2400);
    if (!isCorvin()) {
      // the departure stumble (user-directed) — he shakes it off and goes
      startClip(ANIMS_DANTE.error);
      await sleep(danteClipTotal(ANIMS_DANTE.error) + 120);
    }
    const offX = h.ox - h.winW - 8;
    stage.dataset.facing = "left";
    playWalk(true);
    await slideFootstepWindow(offX, isCorvin() ? CORVIN.walkout : WALK, isCorvin() ? 125 : DANTE_WALK_PACE, isCorvin() ? 0.4 : 0);
    away = true;
    awayAt = Date.now();
  } finally {
    wandering = false;
  }
}

// A real AI event arrived while away -> walk back in from the left and sit down.
async function returnScene() {
  if (!home || returning) return;
  returning = true;
  away = false;
  const h = home;
  try {
    if (isKael()) {
      const token = beginKaelMode("scene");
      await h.win.setPosition(new PhysicalPosition(h.cornerX, h.y));
      h.lastX = h.cornerX;
      h.lastY = h.y;
      delete stage.dataset.facing;
      try {
        startKaelModeClip(token, KAEL.return_v2);
        await h.win.show();
        await sleep(kaelClipTotal(KAEL.return_v2));
        requireKaelMode(token);
      } catch (error) {
        if (error !== KAEL_MODE_CANCELLED) throw error;
        dbg(`kael return cancelled token=${token}`);
        return;
      }
      settleKaelMode(token, "kael return");
      if (gamingActive()) void ensureKaelCombatReady("returned during game");
      return;
    }
    h.lastX = h.ox - h.winW - 8; // start fully off-screen left
    await h.win.setPosition(new PhysicalPosition(h.lastX, h.y));
    h.lastY = h.y;
    stage.dataset.facing = "right";
    playWalk();
    await slideFootstepWindow(h.cornerX, isCorvin() ? CORVIN.walkin : WALK, isCorvin() ? 125 : DANTE_WALK_PACE, isCorvin() ? 0.4 : 0);
    delete stage.dataset.facing;
    // stand tall, hold, then sit — the same arrival beat as the intro
    if (isCorvin()) {
      // Corvin returns on his own feet. The old shared branch replaced him with
      // Dante's crossed-arms and sitpanel frames immediately after walk-in.
      corvinSeatedNow = false;
      corvinQuietPose = "watch";
      await playCorvin(CORVIN.bow);
      finishSceneIdle("corvin return");
    } else {
      // Walk in, sit. Same as the intro: he is already on his feet, so standing
      // up first only to sit down again is movement for its own sake.
      await sleep(300);
      startClip(SITDOWN);
      posture("idle", true);
      await sleep(danteClipTotal(SITDOWN));
      setState("idle");
      showBubble(pickLine(RETURN_LINES), PRIO.MAJOR);
    }
  } finally {
    returning = false;
    // Arriving IS presence. Without this the presence loop still saw a
    // stale lastActivity on its very next 30-second tick and sent him
    // straight back off-screen: on an idle machine he walked in and out
    // every ~10 minutes forever. The event-driven wake path was fine —
    // those kinds stamp lastActivity themselves — only the blind
    // AWAY_RETURN_MS timer produced the loop.
    lastActivity = Date.now();
  }
}

// Occasional idle micro-beat: while seated he laughs, then back to swinging legs.
// "Let the animation finish": while a one-shot beat is mid-play, autonomous
// triggers (laugh, typing, hourly devil, idle churn) wait instead of cutting it.
let committedUntil = 0;
function committed(): boolean {
  return Date.now() < committedUntil;
}
function commitFor(ms: number) {
  committedUntil = Date.now() + ms;
}

function laughBeat() {
  if (!home || gagActive || wandering || committed()) return;
  if (stage.dataset.state !== "idle") return;
  startClip(LAUGH); // one-shot -> frameLoop falls back to idle (leg-swing)
  commitFor(danteClipTotal(LAUGH)); // let the chuckle play out
}

// Error gag: gets hit (stagger) → FALLS down under the taskbar → hides a beat →
// climbs back up on the LEFT side (facing left) → sits sheepishly.
async function diveGag() {
  if (!home || gagActive) return;
  gagActive = true;
  const h = home;
  try {
    stage.dataset.state = "error";
    document.documentElement.style.setProperty("--accent", ACCENT.error);
    // smooth bridge: stand up first, then the gag starts
    await standUp();
    await sleep(260 + Math.random() * 140); // anticipation — the beat before
    // 1) fall — flails in place, dips down a little (stays FULLY on-screen)
    startClip(FALLING);
    showBubble("Whoa, falling!", PRIO.MAJOR);
    await sleep(700); // flail, fully visible
    await new Promise<void>((res) => (moveWindowY(h.belowY, 700), window.setTimeout(res, 720)));
    sfxThud();
    shake(320); // he hits the bottom
    await sleep(500);
    // 2) climb back up (facing left), rises back to standing — fully visible
    stage.dataset.facing = "left";
    startClip(CLIMB);
    showBubble("...climbing back up.", PRIO.NOTABLE);
    await sleep(600); // grab + start pulling, visible
    await new Promise<void>((res) => (moveWindowY(h.y, 1200), window.setTimeout(res, 1220)));
    delete stage.dataset.facing;
    showBubble("...saw nothing.", PRIO.MAJOR);
  } finally {
    gagActive = false;
    setState("idle"); // sits sheepishly back on the panel
  }
}

// Success gag: stand up, whip out the guns and fire (gold muzzle flicker),
// "Jackpot!", then sit back down.
async function shootScene(shots = 1) {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    // smooth bridge: stand up, then draw
    await standUp();
    await sleep(260 + Math.random() * 140); // the calm before the draw
    // anticipation — draw and hold a beat (the calm before)
    startClip(SHOOT);
    await sleep(420);
    // FIRE — muzzle flash held (slow-mo), gunshot + screen-shake, "Jackpot!"
    showBubble("Jackpot!", PRIO.AMBIENT); // shown quietly; its own voice fires below
    say("jackpot"); // ~/.echo/voice/jackpot.wav overrides the blip
    stage.classList.add("shooting");
    for (let i = 0; i < Math.max(1, shots); i++) {
      sfxGunshot();
      shake(380);
      await sleep(i === Math.max(1, shots) - 1 ? 800 : 420); // hold the last shot
    }
    stage.classList.remove("shooting");
    // follow-through: spin the gun; the 4th-wall taunt is now RARE (M1.7) —
    // at 5% it becomes the moment people screenshot, not the expected beat.
    // M2: and a Stranger never breaks the wall — that intimacy is earned.
    if (Math.random() < 0.95 || story.chapter() === "stranger") {
      startClip(GUNSPIN);
      await sleep(danteClipTotal(GUNSPIN));
      sfxHolster();
    } else {
      startClip(TAUNT);
      showBubble("Come on!", PRIO.MAJOR);
      await sleep(danteClipTotal(TAUNT) + 350);
    }
  } finally {
    stage.classList.remove("shooting");
    gagActive = false;
    setState("idle");
    // satisfied laugh after a win (event-driven, not on a timer)
    if (Math.random() < 0.5) window.setTimeout(laughBeat, 500);
  }
}

// Debug-only: replay the full reel from the browser console with
// `window.__echoShowcase()`. Never auto-fires — discovery > demonstration.
// @ts-ignore – attached to window for console access
window.__echoShowcase = showcase;
async function danteReviewScene() {
  if (!home || !isDante() || gagActive || showcasing || introActive || wandering || away || returning) return;
  await showcase();
}

async function showcase() {
  if (!home) {
    dbg("showcase SKIPPED (home null)");
    return;
  }
  showcasing = true;
  dbg("showcase START");
  if (idleTimer) clearTimeout(idleTimer); // no idle fallback mid-reel
  const h = home;
  // Hold one clip on a loop for `ms`, with a caption, so frameLoop can't hijack it.
  const demo = async (c: Clip, label: string, ms: number, seated: boolean) => {
    showBubble(label, PRIO.AMBIENT);
    moveWindowY(seated ? h.sitY : h.y, 300);
    const rearm = () => {
      curClip = c;
      frameIdx = 0;
      afterClip = c.loop ? null : rearm;
    };
    rearm();
    await sleep(ms);
  };
  const demoWalk = async () => {
    showBubble("walking", PRIO.AMBIENT);
    moveWindowY(h.y, 300);
    await sleep(320);
    const reviewX = Math.max(h.ox + 8, h.cornerX - Math.min(360, h.winW));
    stage.dataset.facing = "left";
    startClip(WALK);
    await slideFootstepWindow(reviewX, WALK, DANTE_WALK_PACE, 0);
    stage.dataset.facing = "right";
    startClip(WALK);
    await slideFootstepWindow(h.cornerX, WALK, DANTE_WALK_PACE, 0);
    delete stage.dataset.facing;
  };
  try {
    await sleep(1400);
    // seated idle rotation
    await demo(IDLE_CYCLE[0], "sitting", 1700, true); // legs swinging
    await demo(IDLE_CYCLE[1], "arms crossed", 1900, true); // arms crossed
    await demo(IDLE_CYCLE[2], "thinking", 2300, true); // thinking
    await demo(clip("checkwatch", 200, false), "checking the time", 1900, true); // impatient
    await demo(LAUGH, "laughing", 1500, true); // laugh
    // standing work
    await demo(ANIMS.coding, "coding", 2000, false); // front work loop
    await demoWalk(); // both directions with physical root motion
    afterClip = null;
    dbg("showcase SCENES begin");
    // scenes — kept INSIDE the showcasing guard so a live event can't grab
    // gagActive and make a scene early-return (that was skipping the fall/climb).
    await shootScene(); // Jackpot (+ gun-spin / taunt follow-through)
    await sleep(900);
    await devilTriggerScene(); // Devil Trigger power pose
    await sleep(900);
    await diveGag(); // fall → climb up
    await sleep(900);
    await danceScene(); // dance
  } finally {
    showcasing = false;
    setState("idle");
  }
}

// Media open -> poster beat: a small always-on-top window pops up beside him
// showing ~/.echo/media/poster.gif while song.mp3 plays, and he dances along.
// Both files are the user's own (never committed); without them -> plain dance.
const posterMedia = new Map<string, string>();
async function initPosterMedia() {
  if (!isTauri) return;
  try {
    const list = await invoke<Array<[string, string]>>("poster_media");
    for (const [k, v] of list) posterMedia.set(k, v);
    dbg(`poster media: ${list.map((l) => l[0]).join(",") || "(none)"}`);
  } catch (e) {
    dbg(`poster_media failed: ${e}`);
  }
}

// Bundled default song (shipped in the exe); ~/.echo/media/song.mp3 overrides.
// The poster window resolves its own gif the same way in posterMain().
const POSTER_SONG_URL = "/media/song.mp3";
// Corvin's night song, bundled with the build so every install has music.
const NIGHT_SONG_URL = "/media/nightsong.mp3";

// Measure a gif so the poster window can take its shape (landscape gifs get a
// landscape плакат instead of a letterboxed sliver).
function gifSize(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((res) => {
    const im = new Image();
    const to = window.setTimeout(() => res(null), 1500);
    im.onload = () => {
      window.clearTimeout(to);
      res({ w: im.naturalWidth || 84, h: im.naturalHeight || 107 });
    };
    im.onerror = () => {
      window.clearTimeout(to);
      res(null);
    };
    im.src = url;
  });
}

// The плакат window, detached from whoever is standing under it. Dante holds it
// overhead, Corvin plays to it, Kael's organ rises beside it — the GIF is the
// same beat for all three (user-directed: "not only Dante"). Returns the closer
// so each scene disposes of it in its own finally.
// `handsOffsetPx` places the poster's bottom edge relative to the sprite top:
// Dante's raised hands sit ~12 px into it, the others hold nothing.
async function raisePosterWindow(handsOffsetPx = 12): Promise<() => void> {
  const noop = () => {};
  if (!home) return noop;
  const h = home;
  // Poster window shaped to the gif: fit inside 250x170 logical + frame chrome.
  const sz = (await gifSize(posterMedia.get("poster") ?? "/media/poster.gif")) ?? {
    w: 84,
    h: 107,
  };
  const chrome = 18;
  const k = Math.min((250 - chrome) / sz.w, (170 - chrome) / sz.h);
  const pwL = Math.round(sz.w * k) + chrome;
  const phL = Math.round(sz.h * k) + chrome;
  let win: WebviewWindow | null = new WebviewWindow("poster", {
    url: "index.html?poster=1",
    width: pwL,
    height: phL,
    visible: false, // built hidden; revealed by the caller's beat
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focus: false,
    shadow: false,
  });
  const posterOk = await new Promise<boolean>((res) => {
    win!.once("tauri://created", () => res(true));
    win!.once("tauri://error", (e) => {
      dbg(`poster window error: ${JSON.stringify(e)}`);
      res(false);
    });
  });
  // A failed poster window must degrade to song-plus-performance, not abort the
  // whole beat with an unhandled rejection on a dead handle (hard review).
  if (!posterOk) win = null;
  const sf = window.devicePixelRatio || 1;
  const pw = Math.round(pwL * sf);
  const ph = Math.round(phL * sf);
  const spriteW = Math.round(190 * sf);
  // The sprite is right-aligned inside a wider 260px stage. Centering from the
  // OS-window left put the poster left of him; center on the 190px sprite box.
  const spriteLeft = h.lastX + h.winW - spriteW;
  const px = Math.max(
    h.ox + 6,
    Math.min(Math.round(spriteLeft + (spriteW - pw) / 2), h.scrRight - pw - 6),
  );
  const spriteTop = h.lastY + h.winH - spriteW;
  const py = Math.max(h.oy + 6, spriteTop + Math.round(handsOffsetPx * sf) - ph);
  const placePoster = async () => {
    await win?.setPosition(new PhysicalPosition(px, py)).catch((e) => {
      dbg(`poster position failed: ${e}`);
    });
  };
  await placePoster();
  await sleep(250); // small settle so the webview is ready to paint
  await win?.show().catch(() => {});
  // Windows can ignore a layered child position assigned before its first
  // show. Re-apply it now so it never remains at the default top of screen.
  await placePoster();
  void emit("poster-show");
  // A slow ±3px bob so the held poster feels alive.
  let t = 0;
  const bob = window.setInterval(() => {
    t += 1;
    void win
      ?.setPosition(new PhysicalPosition(px, py + Math.round(Math.sin(t) * 3)))
      .catch((e) => dbg(`poster bob failed: ${e}`));
  }, 420);
  return () => {
    window.clearInterval(bob);
    if (win) void win.close().catch(() => {});
  };
}

// Preloaded so the gif reveal and the first note land in the same second.
function prepareSong(url: string, volume = 0.45) {
  const audio = new Audio(url);
  audio.volume = volume;
  audio.preload = "auto";
  audio.onerror = () => dbg(`song decode error: code=${audio.error?.code}`);
  return {
    play: () =>
      audio
        .play()
        .then(() => dbg("song playing"))
        .catch((e) => dbg(`song play failed: ${e}`)),
    stop: () => {
      const fade = window.setInterval(() => {
        audio.volume = Math.max(0, audio.volume - 0.06);
        if (audio.volume <= 0.01) {
          audio.pause();
          window.clearInterval(fade);
        }
      }, 80);
    },
  };
}

async function posterScene(durationMs: number) {
  if (!home || gagActive) return;
  gagActive = true;
  let closePoster: (() => void) | null = null;
  let stopSong: (() => void) | null = null;
  try {
    ownedMediaUntil = Date.now() + durationMs + 5_000;
    const song = prepareSong(posterMedia.get("song") ?? POSTER_SONG_URL);
    stopSong = song.stop;
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    await standUp();
    // Both arms raised (dance frame 5) — he's holding the плакат overhead.
    curClip = { frames: [DANCE.frames[5]], ms: 500, loop: true, settle: 0 };
    frameIdx = 0;
    showBubble("Too easy.", PRIO.MAJOR);
    closePoster = await raisePosterWindow();
    void song.play();
    dbg("poster scene (media open)");
    await sleep(durationMs);
  } finally {
    closePoster?.();
    stopSong?.();
    gagActive = false;
    setState("idle");
  }
}

// Milestone celebration: stand up and dance a couple of loops, then sit.
async function danceScene(durationMs?: number, forcedClip?: Clip) {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    // smooth bridge: stand up, then dance — classic moves or the headbang
    await standUp();
    await sleep(240 + Math.random() * 120); // a breath before the first move
    // §10: headbang leads; the classic moves become the rarer treat.
    const danceClip = forcedClip ?? (Math.random() < 0.8 ? HEADBANG : DANCE);
    startClip(danceClip);
    showBubble("Too easy.", PRIO.MAJOR);
    const loop = danteClipTotal(danceClip);
    // one beat-shake at the start, then let the dance speak for itself
    shake(250);
    // M1.7: 1% of milestone dances run double length — a discovery, not a habit.
    const rare = !durationMs && Math.random() < 0.01;
    if (rare) dbg("rare: double-length dance");
    await sleep(durationMs ?? loop * (rare ? 6 : 3));
  } finally {
    gagActive = false;
    setState("idle");
  }
}

// Level up -> Devil Trigger: stand, strike the power pose, red aura + vignette.
async function devilTriggerScene() {
  if (!isDante() || !home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.error);
    // smooth bridge: stand up, then transform
    await standUp();
    await sleep(300 + Math.random() * 150); // the stillness before the power
    startClip(DEVIL);
    levelUpFlash(false); // Jackpot already supplies the demonic voice/roar
    void sayDemonJackpot(); // the monster says JACKPOT
    showBubble(`Lv.${lastLevel} — Devil Trigger!`, PRIO.MAJOR, 4500, false);
    await sleep(1900);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

// ---- Dante's headline transformations --------------------------------------
// Sequential Dante clip playback: set the clip, wait out its real duration.
const danteClipTotal = (c: Clip): number =>
  (c.msSeq ? c.msSeq.reduce((a, b) => a + b, 0) : c.frames.length * c.ms) * paceMul(c);
async function playDante(c: Clip, plays = 1): Promise<void> {
  for (let i = 0; i < plays; i++) {
    startClip(c);
    await sleep(danteClipTotal(c) + 80);
  }
}
const DEVIL_RISE = clip("d_devilrise", 160, false, 14, 15);
const DEVIL_BURN = clip("d_devilburn", 140, true, 0, 11);
const DEVIL_CALM = clip("d_devilcalm", 180, false, 14, 15);
const DANTE_STANDLEAN = clip("d_standlean", 170, false, 10, 11);
const DANTE_CROUCHPEER = clip("d_crouchpeer", 170, false, 10, 11);
preloadClips([
  DEVIL_RISE,
  DEVIL_BURN,
  DEVIL_CALM,
  DANTE_STANDLEAN,
  DANTE_CROUCHPEER,
]);

// ---- Dante's motorcycle (user-directed "dante moto scenes") ----------------
// He leaves on foot and mounts beyond the right edge, so the visible sequence
// uses one coherent sportbike from entrance through wheelie and dismount.
const MOTO_WHEELIE = clip("d_motowheelie", 130, false, 10, 11);
const MOTO_OFF = clip("d_motooff", 160, false, 10, 11);
preloadClips([MOTO_WHEELIE, MOTO_OFF]);

// The complete v0.2.4 choreography, kept as its own reusable scene: walk past
// the desktop edge, mount out of sight, cross, wheelie, ride home and dismount.
// The caller owns the surrounding idle/watch transition and busy flag.
async function danteLegacyMotoTourBody() {
  if (!home || !isDante()) return;
  const h = home;
  const homeX = h.cornerX;

  const offRight = h.scrRight + 12;
  stage.dataset.facing = "right";
  playWalk();
  await slideFootstepWindow(offRight, WALK, DANTE_WALK_PACE, 0);
  dbg("dante legacy motorcycle: off-screen mount");
  await sleep(550);

  const leftTurnX = h.ox + 18;
  stage.dataset.facing = "left";
  startClip(DANTE_MOTORIDE);
  dbg("dante legacy motorcycle: full-width ride right-to-left");
  await rideWindow(leftTurnX, 520);
  sfxEngineRev(1300);
  dbg("dante legacy motorcycle: wheelie at left edge");
  await playDante(MOTO_WHEELIE);

  stage.dataset.facing = "right";
  startClip(DANTE_MOTORIDE);
  dbg("dante legacy motorcycle: ride home left-to-right");
  await rideWindow(homeX, 520);
  sfxTyreScreech();
  dbg("dante legacy motorcycle: dismount");
  await playDante(MOTO_OFF);
}

async function motoScene() {
  if (!home || gagActive || !isDante()) return;
  gagActive = true;
  const h = home;
  const homeX = h.cornerX;
  try {
    afterClip = null;
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    await standUp();
    await danteLegacyMotoTourBody();
  } finally {
    delete stage.dataset.facing;
    cancelAnimationFrame(winTween);
    winTween = 0;
    h.lastX = homeX;
    h.lastY = h.y;
    await h.win.setPosition(new PhysicalPosition(homeX, h.y)).catch(() => {});
    gagActive = false;
    finishSceneIdle("dante motorcycle");
  }
}

// The full Devil Form — the beautiful one: eruption, the winged demon burning
// in place, then a graceful return to the man.
async function devilFormScene() {
  if (!home || gagActive || !isDante()) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.error);
    await standUp();
    await sleep(400); // stillness before the power
    levelUpFlash();
    await playDante(DEVIL_RISE);
    void sayDemonJackpot();
    await playDante(DEVIL_BURN, 3);
    await playDante(DEVIL_CALM);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

async function dantePoseScene(c: Clip, holdMs: number) {
  if (!home || gagActive || !isDante()) return;
  gagActive = true;
  try {
    await standUp();
    await playDante(c);
    await sleep(holdMs);
    await playDante(reversedClip(c));
  } finally {
    gagActive = false;
    setState("idle");
  }
}

async function danteStandingClipScene(c: Clip, plays = 1) {
  if (!home || gagActive || !isDante()) return;
  gagActive = true;
  try {
    await standUp();
    await playDante(c, plays);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

// Corvin's Door scene: the monitor's right edge opens and one monstrous arm
// reaches through. Corvin retreats, blocks, and drives it back with his own arm.
async function doorFightScene(force = false) {
  // Daily/director paths share the 4-hour rule. The demo word and Steam's hard
  // 15-minute appointment pass force=true so a previous QA/daily fight cannot
  // silently consume the session beat.
  if (!force && Date.now() - (story.s.gags.lastDoorAt ?? 0) < 4 * 3_600_000) return;
  await corvinScene(async () => {
    // THE DOOR, single-arm cut (user-directed): a slow epic opening, ONE
    // monstrous arm forcing its way out, two guarded steps back, the sword
    // set aside — and THE ARM's octopus grip pushing the claws back through.
    // Character clock: sense 0-2.26, retreat 2.26-5.14, block 5.44-6.19,
    // plant 6.54-8.87, arm rise 8.87-11.12, infection 11.12-14.60,
    // struggle 14.60-19.19, recovery 19.19-22.67, sword/home to ~25.8 s.
    void riftGlow(26_900, { fight: "door" }); // seal begins at scene 22.66s — the SLAM sound
    // Anchor on the CORNER, never on lastX — if anything nudged the window,
    // the duel still fights (and ends) at his post.
    const homeX = home!.cornerX;
    if (Math.abs(home!.lastX - homeX) > 4) {
      home!.lastX = homeX;
      await home!.win.setPosition(new PhysicalPosition(homeX, home!.y));
    }
    // The Door's SOUND (user-directed: awful, on the beats): wind under the
    // whole scene, the stone groan as the crack blooms, the roar when the
    // claws punch through — every later beat has its own voice below.
    const stopWind = playWind();
    const stopStrain: Array<() => void> = [];
    try {
      sfxDoorGroan();
      window.setTimeout(sfxDemonRoar, 1900); // the claws punch through
      window.setTimeout(sfxClawScrape, 2600); // and drag themselves out
      window.setTimeout(sfxClawScrape, 3900);
      await playCorvin(CORVIN.doorsense); // turn, grip — the guard is up
      // ONE CONNECTED GENERATED FLOW from here (user-directed): the backstep
      // clip walks him backward WHILE the window moves on footfall beats, then
      // sword-plant -> ARM raised -> octopus erupts, all chained frame to frame.
      const stepBack = stepWindowX(homeX - 160); // short bursts match the steps
      await playCorvin(CORVIN.backstep);
      await stepBack;
      await sleep(300); // the arm is fully out — it coils
      void sfxSlashWhoosh(); // the claw cuts the air...
      window.setTimeout(() => {
        sfxGunshot(); // ...and meets steel
        shake(220);
      }, 210 * paceMul());
      await playCorvin(CORVIN.doorparry); // exact-pose recoil: no model flash
      await sleep(350);
      window.setTimeout(() => {
        shake(300); // the blade bites the ground
        sfxScuff();
      }, 1150);
      await playCorvin(CORVIN.doorplant); // his choice: the blade goes into the ground
      sfxAura(); // power gathers along the rising arm
      await playCorvin(CORVIN.armup); // the DEMONIC left arm rises
      // THE TRANSFORMATION (user-directed, canon): the corruption creeps slowly
      // from the arm — shoulder, then half the face — and the half-demon form
      // completes EXACTLY when the tentacles reach the claw (overlay CONTACT).
      sfxCorruption(3400); // the dissonant climb rides the creep exactly
      window.setTimeout(sfxTendrilWhip, 2600); // the tendrils erupt
      await playCorvin(CORVIN.infect);
      sfxDemonRoar(); // the tendrils SEIZE the claw
      sfxTendrilWhip();
      window.setTimeout(sfxClawScrape, 1500); // the claw is dragged back
      window.setTimeout(sfxClawScrape, 3100);
      stopStrain.push(sfxStrainStart()); // and the trembling struggle begins
      await playCorvin(CORVIN.monsterhold, 3); // the struggle — the form HOLDS
      stopStrain.shift()?.();
      // The overlay retracts the tendrils while the same monster pose unwinds.
      // c_armretract belongs to the older arm-octopus chain and would pop models.
      await playCorvin(REV(CORVIN.infect));
      sfxDoorSlam(); // the Door SLAMS
      shake(420);
      await sleep(300); // — the silence after
      await playCorvin(CORVIN.swordtake); // he pulls the blade free — the watch resumes
      window.setTimeout(sfxSlashWhoosh, 200); // steel leaving the earth
      stage.dataset.facing = "right";
      startClip(CORVIN.walkin as Clip);
      await slideFootstepWindow(homeX, CORVIN.walkin, 125);
      delete stage.dataset.facing;
    } finally {
      stopStrain.forEach((s) => s());
      stopWind();
    }
  }, "#a852ff");
  story.s.gags.lastDoorAt = Date.now();
  story.save();
}

// M1.5: breathing — a 1px sine on a wrapper div so it never fights the
// sprite's own transforms (facing flip, scene keyframes). Pauses when a scene
// owns the stage; the period stretches when his energy is low.
function startBreathing() {
  const wrap = document.createElement("div");
  wrap.style.position = "absolute";
  wrap.style.right = "0";
  wrap.style.bottom = "0";
  wrap.style.width = "190px";
  wrap.style.height = "190px";
  wrap.style.display = "flex";
  wrap.style.alignItems = "flex-end";
  wrap.style.justifyContent = "flex-end";
  wrap.style.pointerEvents = "none";
  sprite.parentElement!.insertBefore(wrap, sprite);
  wrap.appendChild(sprite);
  const step = (now: number) => {
    // This loop already runs for breathing, so it can cheaply notice legacy
    // direct clip assignments and re-arm frame 0 without another RAF chain.
    if (curClip !== observedClip) restartFrameLoop();
    const busy =
      gagActive || showcasing || introActive || wandering || away || returning || quietNow();
    if (busy) {
      wrap.style.transform = "";
    } else {
      const period = 2600 + (1 - life.v.energy) * 1600;
      wrap.style.transform = `translateY(${Math.round(Math.sin((now / period) * Math.PI * 2))}px)`;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function main() {
  // Click-through overlay: mouse passes to the desktop, no one can grab Dante.
  if (isTauri) {
    getCurrentWindow()
      .setIgnoreCursorEvents(true)
      .catch((e) => console.error("ignoreCursorEvents failed", e));
  }

  void initVoiceFiles(); // pick up any ~/.echo/voice/*.wav the user dropped in
  void initPosterMedia(); // ~/.echo/media poster.gif + song.mp3 for the media beat
  startBreathing(); // M1.5: the constant tier — he's never a statue again
  scheduleMidnight(); // Corvin's 00:00 guitar + the MIDNIGHT arc
  scheduleCorvinHardPlan(); // guaranteed living reel; Director only gates safe windows
  scheduleDanteBeats(); // fixed clocks: spin 6/20m, coin 12/25m, pizza 18/60m, shrug
  scheduleDanteDirector(); // situational Dante beats between fixed appointments
  scheduleKaelDirector(); // Kael's quiet Abyss/platypus beats
  initTts(); // system voices — the fallback under the pre-rendered pack
  void initCorvinVoice(); // his real, neural voice (public/voice/corvin)

  // Character pack: ~/.echo/character decides who walks in (default Dante).
  try {
    const c = await invoke<string>("character_load");
    if (c === "corvin" || c === "kael") character = c;
  } catch {
    /* dante */
  }
  applyCharacter();
  if (isDante()) resetDanteHardPlan("startup");
  if (isCorvin()) resetCorvinHardPlan("startup");
  if (isKael()) resetKaelHardPlan("startup");

  // M2: load the story; a new day gets a greeting built from yesterday's REAL
  // numbers — he remembers, and says so once the walk-in has finished.
  await story.load();
  // The director was constructed BEFORE the story loaded (module scope), so
  // its state was always fresh and the first save wiped everything learned.
  // Rebind to the loaded state — this is what makes learning survive restarts.
  director.st = { weights: {}, lastPlayed: {}, ...story.s.director };
  danteDirector.st = { weights: {}, lastPlayed: {}, ...story.s.danteDirector };
  kaelDirector.st = { weights: {}, lastPlayed: {}, ...story.s.kaelDirector };
  const todayKey = dateKey();
  const newDay = !!story.s.lastSeenDate && story.s.lastSeenDate !== todayKey;
  const y = story.yesterday();
  story.s.lastSeenDate = todayKey;
  story.save();
  if (newDay) {
    window.setTimeout(() => {
      let line = "Back at it.";
      if (y) {
        if (y.jackpots >= 2) line = `${y.jackpots} Jackpots yesterday. Show-off.`;
        else if (y.errors > y.wins) line = "Yesterday was rough. Today we win.";
        else if (y.wins > 0) line = "Yesterday went well. Keep it rolling.";
      }
      dbg(`story greeting: ${line}`);
      showBubble(line, PRIO.NOTABLE);
    }, 18000);
  }

  try {
    applyEvent(await invoke<AgentEvent>("get_state"));
  } catch (err) {
    console.error("get_state failed", err);
  }

  await listen<AgentEvent>("agent-event", (evt) => applyEvent(evt.payload));
  await listen<{ kind: string }>("context-event", (evt) => onContext(evt.payload.kind));

  // Presence loop. He leaves after AWAY_AFTER_MS of no AI activity; while away he
  // comes back on his own after AWAY_RETURN_MS (and, if still nothing's happening,
  // leaves again later — so the desktop breathes). A real AI event brings him
  // straight back via applyEvent regardless.
  window.setInterval(() => {
    if (returning || wandering || gagActive || showcasing || introActive) return;
    if (away) {
      if (Date.now() - awayAt > AWAY_RETURN_MS) returnScene();
      return;
    }
    // X self-heal: a scene that died mid-slide (thrown promise, killed
    // overlay) used to strand him mid-screen forever — Y healed, X never did.
    if (home && Math.abs(home.lastX - home.cornerX) > 4) {
      dbg(`x-heal: ${home.lastX} -> corner ${home.cornerX}`);
      home.lastX = home.cornerX;
      void home.win.setPosition(new PhysicalPosition(home.cornerX, home.y)).catch(() => {});
    }
    if (stage.dataset.state !== "idle") return;
    if (Date.now() - lastActivity > AWAY_AFTER_MS) leaveScene();
  }, 30000);

  scheduleGamingBeat(); // playful beats while a game is open

  // Signature hourly moment: Devil Trigger once an hour. Checked every 2 min so
  // a busy/away moment only DELAYS it instead of skipping the whole hour, and
  // the clock persists across relaunches (rebuilds used to reset it forever).
  // M1.7: rare = precious. Once per ~14 h of companionship, not hourly.
  // (The 10-min GAMING Devil Trigger cadence is separate and stays.)
  const DEVIL_EVERY = 14 * 60 * 60 * 1000;
  let lastDevil = Number(localStorage.getItem("echo.lastDevil") || 0);
  if (!lastDevil || lastDevil > Date.now()) {
    lastDevil = Date.now();
    localStorage.setItem("echo.lastDevil", String(lastDevil));
  }
  window.setInterval(() => {
    if (Date.now() - lastDevil < DEVIL_EVERY) return;
    if (!isDante()) return;
    if (gagActive || showcasing || wandering || away || returning || committed() || quietNow()) return;
    if (stage.dataset.state !== "idle") return;
    lastDevil = Date.now();
    localStorage.setItem("echo.lastDevil", String(lastDevil));
    dbg("devil trigger (14h clock)");
    devilTriggerScene();
  }, 120_000);

  // v2 P1: the Life Model heartbeat — decay the vector, accumulate idle boredom,
  // and log the state so its evolution is auditable in ~/.echo/echo.log.
  let lifeLoggedAt = 0;
  let storySavedAt = Date.now();
  window.setInterval(() => {
    life.tick();
    if (stage.dataset.state === "idle" && !gagActive && !showcasing) life.idleFor(5000);
    if (Date.now() - lifeLoggedAt > 20000) {
      lifeLoggedAt = Date.now();
      dbg(`life ${life.summary()}`);
    }
    // M2: tenure accumulates while he runs; saved incrementally (no clean
    // shutdown hook exists). 100 hours together is a once-ever moment.
    story.s.totalMinutes += 5 / 60;
    if (story.s.totalMinutes / 60 >= 100 && story.first("hours100"))
      showBubble("A hundred hours together. Time flies.", PRIO.NOTABLE);
    if (Date.now() - storySavedAt > 5 * 60 * 1000) {
      storySavedAt = Date.now();
      story.save();
    }
  }, 5000);
  frameLoop();
  runIntro(); // intro sets introActive=true, calls scheduleIdle() when done
}

// ?poster=1 -> this window IS the poster: just the framed gif, nothing else.
async function posterMain() {
  document.body.innerHTML = "";
  document.body.style.cssText = "margin:0;background:transparent;overflow:hidden";
  const frame = document.createElement("div");
  frame.style.cssText =
    "box-sizing:border-box;width:100vw;height:100vh;padding:6px;" +
    "background:#17171a;border:3px solid #b3122a;border-radius:4px;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
  const img = document.createElement("img");
  img.style.cssText = "max-width:100%;max-height:100%;image-rendering:pixelated";
  frame.appendChild(img);
  document.body.appendChild(frame);
  // The gif starts on the "poster-show" signal so it begins in the same second
  // as the song (the window is built hidden, then revealed). Fallback timer in
  // case the signal raced past us before our listener was up.
  let gifUrl = "/media/poster.gif"; // bundled default, always present
  try {
    const list = await invoke<Array<[string, string]>>("poster_media");
    const gif = list.find(([k]) => k === "poster");
    if (gif) gifUrl = gif[1]; // a ~/.echo/media/poster.gif overrides it
  } catch {
    /* bundled gif it is */
  }
  let shown = false;
  const reveal = () => {
    if (shown) return;
    shown = true;
    img.src = gifUrl;
  };
  void listen("poster-show", reveal);
  window.setTimeout(reveal, 1200);
}

// ?rift=1 -> THE DOOR: the right edge cracks open. The overlay renders the
// portal glow, the connected demon arm, impact sparks, and rooted tendrils.
function riftMain(q: URLSearchParams) {
  const ms = Math.max(6000, Number(q.get("ms")) || 20000);
  document.body.innerHTML = "";
  document.body.style.cssText = "margin:0;background:transparent;overflow:hidden";
  // The Door overlay belongs to Corvin. Dante has no screen-demon fight.
  if (q.has("demon")) {
    const W = window.innerWidth;
    // Times mirror doorFightScene with roughly 600 ms of overlay boot latency.
    // Corvin retreats left while the hand stays physically attached to the
    // right edge. The only bridge between them grows from his raised palm.
    const armRootX = W - 215; // exact raised-palm position after the retreat
    {
      // --- THE DOOR, single-arm cut (user-directed) ------------------------
      // One monstrous arm. Slow epic opening, a real emergence animation,
      // a lunge met by the sword-shield, then THE ARM's octopus tendrils
      // CLING to the demon hand and force it back through, inch by inch.
      // Timeline (overlay ms = scene ms - ~600 boot lag):
      //   1450-4700  the claws creep through while his retreat steps land
      //   5050       the capped LUNGE -> Corvin's parry (spark on the blade)
      //   11550-13660 corruption and tentacles grow together from the left arm
      //   13660-18250 contact: the arm, trembling, is pushed back through
      //   ~18250     tentacles retract and the Door slams shut
      const GH = window.innerHeight - 46;
      for (let i = 0; i < 15; i++) new Image().src = `/pixel/demon_arm_out/frame_${i}.png?v=1`;
      for (let i = 0; i < 9; i++) new Image().src = `/pixel/demon_arm/frame_${i}.png?v=1`;
      for (let i = 0; i < 9; i++) new Image().src = `/pixel/fx_burst/frame_${i}.png?v=1`;
      for (let i = 0; i < 9; i++) new Image().src = `/pixel/fx_tendril/frame_${i}.png?v=1`;
      const ARM_HEIGHT = 210; // the one arm, big
      const EDGE_OVERLAP = 18; // bury the shoulder behind the Door glow
      const ARM_ALPHA_SPAN = (128 - 6) / 128; // full-arm art starts near source x=6
      const el = document.createElement("img");
      el.style.cssText =
        `position:fixed;top:${GH - 205}px;right:-${EDGE_OVERLAP}px;` + // a little up (user-directed)
        `width:0;height:${ARM_HEIGHT}px;` +
        "image-rendering:pixelated;pointer-events:none;z-index:1;" +
        "filter:drop-shadow(0 6px 10px rgba(0,0,0,0.55));";
      document.body.appendChild(el);
      const REACH = 145; // a visible tentacle span remains before the claw
      const LUNGE_REACH = 18; // the sword can meet it; Corvin's body cannot
      const EMERGE0 = 1450; // claws punch through during his sense-turn
      const EMERGE1 = 4700; // full emergence stretches across the backstep
      const LASH = 4870; // lunge peak lands exactly on the block frame (scene 5.65s)
      const CLING = 11550; // the wrist root appears as corruption begins spreading
      const CONTACT = 14000; // touch = the half-demon form completes (scene 14.60s)
      const PUSH0 = CONTACT;
      const GONE = 18590; // pushed through exactly as the struggle ends (scene 19.19s)
      // World-space position of the screen-left demon arm beneath Artsiv after
      // the backstep. The bridge has one wrist-sized root at its left centre.
      // Rooted in the RAISED demonic hand (user-directed): the stream leaves
      // from the fist up top and slopes down to the claw — never across his body.
      const ARM_ROOT_X = armRootX;
      const ARM_ROOT_Y = GH - 248;
      let armX = W; // left edge of the arm img — the tendril clings to this
      const pinArmToDoor = (reach: number) => {
        const visibleReach = Math.max(0, reach);
        armX = W - visibleReach;
        // The shoulder stays behind the right edge. Increasing width extends
        // only the claw end to the left, so a lunge can never tear the arm
        // away from the Door.
        el.style.width = `${(visibleReach + EDGE_OVERLAP) / ARM_ALPHA_SPAN}px`;
      };
      const sparkAt = (x: number, y: number, size = 90) => {
        const s = document.createElement("img");
        s.style.cssText =
          `position:fixed;width:${size}px;image-rendering:pixelated;pointer-events:none;z-index:3;left:${x}px;top:${y}px;`;
        document.body.appendChild(s);
        let si = 0;
        const st = window.setInterval(() => {
          if (si >= 9) { window.clearInterval(st); s.remove(); return; }
          s.src = `/pixel/fx_burst/frame_${si++}.png?v=1`;
        }, 60);
      };
      const tn = document.createElement("img");
      tn.style.cssText =
        `position:fixed;height:96px;image-rendering:pixelated;pointer-events:none;z-index:2;` +
        `left:${ARM_ROOT_X}px;top:${ARM_ROOT_Y}px;width:0;` +
        `transform-origin:left center;transform:rotate(13deg);`; // slopes down to the claw
      document.body.appendChild(tn);
      let clingFired = false;
      const t0h = performance.now();
      const htick = (now: number) => {
        const t = now - t0h;
        if (t > GONE + 1800) {
          el.remove();
          tn.remove();
          return;
        }
        // --- the arm ---
        if (t >= EMERGE0) {
          if (t < EMERGE1) {
            // the emergence ANIMATION carries this phase (claws punch through,
            // fingers unfurl); the img itself crawls out slowly with the steps
            const p = (t - EMERGE0) / (EMERGE1 - EMERGE0);
            const r = REACH * 0.62 * p + 26 * Math.sin(p * Math.PI); // heave
            const fi = Math.min(14, Math.floor(p * 15));
            el.src = `/pixel/demon_arm_out/frame_${fi}.png?v=1`;
            pinArmToDoor(r);
          } else if (t < PUSH0) {
            let r = REACH * 0.62 + (REACH * 0.38) * Math.min(1, (t - EMERGE1) / 1000);
            if (t >= LASH && t < LASH + 560) {
              const lp = (t - LASH) / 560;
              r += (lp < 0.32 ? lp / 0.32 : 1 - (lp - 0.32) / 0.68) * LUNGE_REACH;
            }
            el.src = `/pixel/demon_arm/frame_${(((t / 150) | 0) % 9)}.png?v=1`;
            pinArmToDoor(r);
          } else {
            // the struggle: forced back slowly, trembling, grasping fast
            const pp = Math.min(1, (t - PUSH0) / (GONE - PUSH0));
            const ease = pp * pp * (3 - 2 * pp); // smoothstep — heavy resistance
            const r = Math.max(0, REACH * (1 - ease) - Math.sin(t / 45) * 3.5);
            el.src = `/pixel/demon_arm/frame_${(((t / 90) | 0) % 9)}.png?v=1`; // frantic
            pinArmToDoor(r);
            if (pp >= 1) el.style.opacity = "0";
          }
        }
        // --- the octopus grip ---
        if (t >= CLING && t < GONE + 300) {
          const grow = Math.min(1, (t - CLING) / (CONTACT - CLING));
          if (!clingFired && grow >= 1) {
            clingFired = true;
            sparkAt(armX - 24, ARM_ROOT_Y + 52, 120); // the tentacles SEIZE the hand
          }
          // clings to the hand: the stream spans exactly to the arm, however
          // far it has been pushed — attached, not decorative
          const span = Math.max(34, armX + 30 - ARM_ROOT_X);
          const retract = t > GONE ? Math.max(0, 1 - (t - GONE) / 300) : 1;
          const reveal = grow * retract;
          tn.style.width = `${span}px`;
          tn.style.clipPath = `inset(0 ${(1 - reveal) * 100}% 0 0)`;
          tn.src = `/pixel/fx_tendril/frame_${((t / 110) | 0) % 9}.png?v=1`;
        } else if (t >= GONE + 300) {
          tn.style.width = "0";
        }
        requestAnimationFrame(htick);
      };
      requestAnimationFrame(htick);
    }
  }
  const small = q.has("small");
  const bandBox = small ? "top:auto;bottom:72px;height:170px;width:56px;" : "top:0;height:100vh;width:110px;";
  const crackBox = small ? "top:auto;bottom:78px;height:158px;width:3px;" : "top:0;height:100vh;width:4px;";
  const band = document.createElement("div");
  band.style.cssText =
    `position:fixed;right:0;${bandBox}pointer-events:none;` +
    "background:linear-gradient(to left, rgba(140,60,255,0.55), rgba(140,60,255,0.18) 45%, transparent);" +
    "opacity:0;filter:blur(2px);";
  const crack = document.createElement("div");
  crack.style.cssText =
    `position:fixed;right:0;${crackBox}pointer-events:none;` +
    "background:linear-gradient(to bottom, transparent, #e2b0ff 12%, #a852ff 50%, #e2b0ff 88%, transparent);" +
    "box-shadow:0 0 18px 6px rgba(168,82,255,0.8);opacity:0;";
  document.body.appendChild(band);
  document.body.appendChild(crack);
  const t0 = performance.now();
  const openMs = ms * 0.16;
  const sealAt = ms * 0.82;
  const tick = () => {
    const t = performance.now() - t0;
    if (t >= ms) {
      void getCurrentWindow().close();
      return;
    }
    let k: number;
    if (t < openMs) k = t / openMs;
    else if (t < sealAt) k = 1;
    else k = Math.max(0, 1 - (t - sealAt) / (ms - sealAt));
    const pulse = 0.82 + 0.18 * Math.sin(t / 260); // the Door breathes
    band.style.opacity = String((small ? 0.78 : 0.9) * k * pulse);
    crack.style.opacity = String(k);
    crack.style.width = `${(small ? 1 : 2) + 3 * k * pulse}px`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.setTimeout(() => void getCurrentWindow().close().catch(() => {}), ms + 1500);
}

// Opens the rift overlay for `ms` — fire-and-forget; it seals and closes itself.
// opts.fight enables the Door hand choreography preset.
async function riftGlow(
  ms: number,
  opts?: { fight?: "door"; size?: "small" },
): Promise<void> {
  try {
    const mon = await currentMonitor();
    if (!mon) return;
    const sf = mon.scaleFactor || window.devicePixelRatio || 1;
    const extra = `${opts?.fight ? `&demon=1&fight=${opts.fight}` : ""}${opts?.size === "small" ? "&small=1" : ""}`;
    const win = new WebviewWindow(opts?.size === "small" ? "rift-small" : "rift", {
      url: `index.html?rift=1&ms=${ms}${extra}`,
      width: Math.round(mon.size.width / sf),
      height: Math.round(mon.size.height / sf),
      x: Math.round(mon.position.x / sf),
      y: Math.round(mon.position.y / sf),
      visible: true,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: false,
      shadow: false,
    });
    win.once("tauri://created", () => void win.setIgnoreCursorEvents(true).catch(() => {}));
    win.once("tauri://error", (e) => dbg(`rift window error: ${JSON.stringify(e)}`));
    // Parent-side failsafe: the overlay closes itself, but if its JS ever
    // dies the "rift" label would be squatted forever and every later Door
    // fight would silently lose its overlay. The parent guarantees the close.
    window.setTimeout(() => void win.close().catch(() => {}), ms + 4000);
  } catch (e) {
    dbg(`rift failed: ${e}`);
  }
}

// ?skyfly=1 -> this window IS the sky: a transparent monitor-sized layer where
// Artsiv launches from Corvin's corner, flies two grand laps and returns.
function skyflyMain(q: URLSearchParams) {
  const ms = Math.max(4000, Number(q.get("ms")) || 11000);
  const sx = Number(q.get("sx")) || window.innerWidth - 160;
  const sy = Number(q.get("sy")) || window.innerHeight - 240;
  document.body.innerHTML = "";
  document.body.style.cssText = "margin:0;background:transparent;overflow:hidden";
  const img = document.createElement("img");
  img.style.cssText =
    "position:absolute;left:0;top:0;width:150px;image-rendering:pixelated;" +
    "pointer-events:none;filter:drop-shadow(0 4px 6px rgba(0,0,0,0.45));";
  document.body.appendChild(img);
  // dive=1 -> the strike: talons-forward frames and a steep attack run.
  const dive = q.has("dive");
  const frames = dive
    ? Array.from({ length: 11 }, (_, i) => `/pixel/corvin/artsivdive/frame_${i}.png?v=1`)
    : Array.from({ length: 10 }, (_, i) => `/pixel/corvin/artsivfly/frame_${i}.png?v=1`);
  frames.forEach((s) => (new Image().src = s));
  let fi = 0;
  img.src = frames[0];
  const frameTimer = window.setInterval(
    () => {
      fi = (fi + 1) % frames.length;
      img.src = frames[fi];
    },
    dive ? 90 : 140, // a dive beats its wings faster
  );
  const W = window.innerWidth;
  const H = window.innerHeight;
  const cx = W * 0.5;
  const cy = H * 0.34;
  const rx = W * 0.36;
  const ry = H * 0.2;
  const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
  // Ellipse entry angle nearest to Corvin's corner, so paths join smoothly.
  const a0 = Math.atan2((sy - cy) / ry, (sx - cx) / rx);
  const pos = (t: number): [number, number] => {
    if (dive) {
      // The strike: climb high, then a steep power dive clean across the
      // screen, and back up out of frame to Corvin's corner.
      const CLIMB = 0.3;
      const STRIKE = 0.62;
      const topX = W * 0.82;
      const topY = H * 0.1;
      const hitX = W * 0.16;
      const hitY = H * 0.78;
      if (t < CLIMB) {
        const p = ease(t / CLIMB);
        return [sx + (topX - sx) * p, sy + (topY - sy) * p];
      }
      if (t < STRIKE) {
        const p = (t - CLIMB) / (STRIKE - CLIMB);
        const q = p * p; // it accelerates all the way down
        return [topX + (hitX - topX) * q, topY + (hitY - topY) * q];
      }
      const p = ease((t - STRIKE) / (1 - STRIKE));
      return [hitX + (sx - hitX) * p, hitY + (sy - hitY) * p - Math.sin(p * Math.PI) * H * 0.25];
    }
    const IN = 0.16;
    const OUT = 0.84;
    const ex = (a: number) => cx + Math.cos(a) * rx;
    const ey = (a: number) => cy + Math.sin(a) * ry;
    if (t < IN) {
      const p = ease(t / IN);
      return [sx + (ex(a0) - sx) * p, sy + (ey(a0) - sy) * p];
    }
    if (t > OUT) {
      const p = ease((t - OUT) / (1 - OUT));
      return [ex(a0) + (sx - ex(a0)) * p, ey(a0) + (sy - ey(a0)) * p];
    }
    const a = a0 + ((t - IN) / (OUT - IN)) * 2 * Math.PI * 2; // two grand laps
    return [ex(a), ey(a)];
  };
  const t0 = performance.now();
  let px = sx;
  const step = (now: number) => {
    const t = (now - t0) / ms;
    if (t >= 1) {
      window.clearInterval(frameTimer);
      void emit("skyfly-done");
      return;
    }
    const [x, y] = pos(t);
    img.style.left = `${Math.round(x - 75)}px`;
    img.style.top = `${Math.round(y - 30)}px`;
    img.style.transform = `scaleX(${x < px ? -1 : 1})`;
    px = x;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // Safety: if the parent never closes us (crash), self-hide after ms + 5 s.
  window.setTimeout(() => void getCurrentWindow().close().catch(() => {}), ms + 5000);
}

const bootQ = new URLSearchParams(location.search);
if (bootQ.has("poster")) posterMain();
else if (bootQ.has("skyfly")) skyflyMain(bootQ);
else if (bootQ.has("rift")) riftMain(bootQ);
else {
  void main();
  // Browser-only visual QA hook: Tauri runs the real first-launch hint after
  // the walk-in, while ?welcome=1 lets us inspect the same bubble at 260x420.
  if (bootQ.has("welcome")) {
    stage.style.position = "fixed";
    stage.style.right = "0";
    stage.style.bottom = "0";
    stage.style.width = "260px";
    stage.style.height = "420px";
    const previewSpeech = bootQ.get("speech") || FIRST_RUN_HINT;
    window.setTimeout(() => showBubble(previewSpeech, PRIO.NOTABLE), 300);
  }
}
