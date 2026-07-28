import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Life } from "./life";
import { Story, dateKey } from "./story";
import {
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
  frames: Array.from({ length: count }, (_, i) => `/pixel/${name}/frame_${i}.png?v=15`),
  ms,
  loop,
  settle,
});
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
// Walk = the legs-visible side walk (regenerated upright-posture version).
const WALK = clip("sidewalk", 110, true, 0, 8);
// Contact frames (footfalls) hold a beat longer — ground stops feet, feet
// don't slide over ground.
WALK.msSeq = [105, 95, 128, 98, 105, 95, 128, 98];
// Scene clips hold their final pose (settle=8) so the gag orchestrator controls
// every transition — no flicker back to idle mid-sequence.
// Error gag: falls, then climbs back up. Slower ms so both read clearly.
const FALLING = clip("falling", 110, true, 8);
// Physics: a fall accelerates, then the held frame is the crash.
FALLING.msSeq = [70, 65, 60, 60, 65, 75, 90, 110, 140];
const CLIMB = clip("climb", 120, true, 8);
// Climbing is EFFORT — heavy pulls easing only at the top.
CLIMB.msSeq = [160, 150, 140, 130, 120, 110, 100, 95, 130];
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
// Eating is SLOW — box appears, opens, long chewing beats, satisfied vanish.
PIZZA.msSeq = [200, 220, 260, 320, 380, 520, 620, 560, 640, 480, 320, 260, 240];
const COINFLIP = clip("coinflip", 140, true, 8, 9); // standing coin toss
const SWORDSPIN = clip("swordspin", 110, true, 8, 9); // fiery twirl (gaming beat)
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
};
const idleClipCache: Record<string, Clip> = {};
function idleClip(name: string): Clip {
  return (idleClipCache[name] ??= clip(name, IDLE_MS[name] ?? 200, false));
}
const IDLE_CYCLE = ["sitswing", "sitcross", "sitthink"].map(idleClip); // showcase demos
// When a one-shot clip ends, run this instead of the default idle fallback.
let afterClip: (() => void) | null = null;

// preload every frame
[
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
  DEVIL,
  GUNSPIN,
  TAUNT,
  TYPING,
  TYPETAP,
].forEach((c) => c.frames.forEach((s) => (new Image().src = s)));

// Context awareness (from the Rust context watcher): you typing -> he types;
// opening video/music -> a dance; launching a game -> he shoots. Rate-limited
// by the same scene budget so a long session doesn't spam.
function onContext(kind: string) {
  dbg(`context ${kind}`);
  lastActivity = Date.now(); // you're active on the machine, so he stays present
  if (!home || gagActive || showcasing || returning || wandering || away) return;
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
    if (curClip !== TYPING && curClip !== TYPETAP) {
      stage.dataset.state = "idle";
      posture("idle", true); // laptop needs him seated
      curClip = TYPING;
      frameIdx = 0;
      // take-out is a one-shot; when it finishes, settle into the typing loop
      afterClip = () => {
        curClip = TYPETAP;
        frameIdx = 0;
      };
      dbg("typing -> laptop out");
      tickTyping();
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
  // Demo hook (from ~/.echo/demo): play a scene on demand for QA / showing off.
  // ONE gate for all demos: never during the walk-in, walks, or another scene —
  // a seated payoff mid-stride breaks the walk (learned the hard way).
  if (
    kind.startsWith("demo_") &&
    (introActive || wandering || away || returning || showcasing || gagActive)
  ) {
    dbg(`demo ignored (busy): ${kind}`);
    return;
  }
  if (kind === "demo_devil") {
    devilTriggerScene();
    return;
  }
  if (kind === "demo_sword") {
    demoSword();
    return;
  }
  if (kind === "demo_poster") {
    posterScene(15000);
    return;
  }
  if (kind === "demo_pizza") {
    demoSeated(PIZZA, "Finally.");
    return;
  }
  if (kind === "demo_clean") {
    demoSeated(idleClip("cleansword"));
    return;
  }
  if (kind === "demo_wake") {
    demoSeated(WAKEUP);
    return;
  }
  if (kind === "demo_coin") {
    void coinFlourish();
    return;
  }
  if (kind === "demo_spin") {
    void demoSpin();
    return;
  }
  if (kind === "gaming_active") {
    // Short tail: heartbeats arrive every ~10 s while the game/fullscreen is
    // real, and typing should recover FAST once it ends (a 3-min tail read as
    // "typing randomly broken" after closing a game).
    gamingUntil = Date.now() + 60 * 1000;
    return;
  }
  if (kind === "media_active") {
    mediaUntil = Date.now() + 3 * 60 * 1000; // video/music still playing
    // While it's on, he breaks into a 15 s dance every ~10 min — but it shares
    // the one scene budget, so it can't stack against Jackpot & co.
    if (Date.now() - lastMediaDance > MEDIA_DANCE_EVERY) {
      if (beatReady() && sceneAllowed()) {
        lastMediaDance = Date.now();
        markScene();
        dbg("media session poster (15s)");
        posterScene(15000); // the плакат every time, not just on open
      } else {
        // Name the guard that vetoed it — silent skips are undebuggable.
        dbg(
          `media poster blocked: gag=${gagActive} show=${showcasing} away=${away} ` +
            `ret=${returning} wand=${wandering} com=${committed()} sceneOk=${sceneAllowed()}`,
        );
      }
    }
    return;
  }
  if (kind === "media") {
    // You opened music/video — that's deliberate: he holds up his плакат
    // (poster gif + song from ~/.echo/media) and dances beside it.
    lastMediaDance = Date.now();
    markScene();
    posterScene(15000);
  } else if (kind === "gaming") {
    gamingUntil = Date.now() + 3 * 60 * 1000;
    // Stagger the big gaming moments: sword ~4 min into the session, devil ~10.
    lastGamingSword = Date.now() - GAMING_SWORD_EVERY + 4 * 60 * 1000;
    lastGamingDevil = Date.now();
    markScene();
    shootScene(3); // launched a game -> a longer 3-shot burst
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
function tickTyping() {
  window.setTimeout(() => {
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
// Media session: while a video/music window is open he dances periodically.
let mediaUntil = 0;
const MEDIA_DANCE_EVERY = 10 * 60 * 1000; // every ~10 min
// If music/video is already open when he boots, the first poster beat comes
// ~90 s in (not instantly, not never); after that the normal 10-min rhythm.
let lastMediaDance = Date.now() - MEDIA_DANCE_EVERY + 90_000;
void mediaUntil; // session window (kept for future mood weighting)
const gamingActive = () => Date.now() < gamingUntil;

function beatReady(): boolean {
  return !!home && !gagActive && !showcasing && !away && !returning && !wandering && !committed();
}

// Sword combo joins the gaming rotation the moment its art exists
// (public/pixel/sword/frame_0..7 — see scripts/gen_anim.py). Probed at boot;
// while the art is missing it's guns only.
// Sword beat (the full DMC move, user-directed): fire summon -> turns left ->
// two raise-and-strike slashes, each launching a red energy wave -> settle ->
// turns back -> the fire swallows the sword. Ends front-standing.
const SWORD = clip("swordmove", 100, true, 0, 39);
SWORD.msSeq = [
  110, 110, 110, 110, 110, 110, 110, 110, 110, 140, 140, 140, 140, // summon
  140, 180, // turn
  120, 70, 60, 85, 85, 85, // strike 1 + wave 1
  90, 110, 65, 60, 85, 85, 85, // strike 2 + wave 2
  110, 110, 110, // settle
  140, // turn back
  90, 90, 90, 90, 90, 90, 90, // fire swallows the sword
];
let swordReady = false;
{
  const probe = new Image();
  probe.onload = () => (swordReady = true);
  probe.src = SWORD.frames[0];
}

// The full sword move with its soundtrack timed to the msSeq: fire ignites at
// the summon flash, a whoosh per strike, embers at the vanish.
async function playSwordMove() {
  curClip = SWORD;
  frameIdx = 0;
  // Sound offsets scale with the mood pace or the whooshes drift off-frame.
  const p = paceMul();
  window.setTimeout(sfxIgnite, 550 * p); // embers gather
  window.setTimeout(sfxSlashWhoosh, 1990 * p); // strike 1
  window.setTimeout(sfxSlashWhoosh, 2580 * p); // strike 2
  window.setTimeout(sfxEmberFizz, 3450 * p); // the sword burns away
  await sleep(SWORD.msSeq!.reduce((a, b) => a + b, 0) * p);
}

// Demo helpers: play a seated one-shot in place, or the standing fiery twirl.
function demoSeated(c: Clip, line?: string) {
  if (!home || gagActive) return;
  stage.dataset.state = "idle";
  posture("idle", true); // seated payoffs need the seat, wherever he was
  const total = (c.msSeq?.reduce((a, b) => a + b, 0) ?? c.frames.length * c.ms) * paceMul();
  commitFor(total + 400);
  curClip = c;
  frameIdx = 0;
  if (line) showBubble(line, PRIO.NOTABLE);
  afterClip = () => playIdleCycle();
}

async function demoSpin() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    await standUp();
    curClip = SWORDSPIN;
    frameIdx = 0;
    window.setTimeout(sfxIgnite, 300 * paceMul());
    await sleep(SWORDSPIN.frames.length * SWORDSPIN.ms * paceMul() + 200);
  } finally {
    gagActive = false;
    setState("idle");
  }
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
      curClip = SWORDSPIN;
      frameIdx = 0;
      window.setTimeout(sfxIgnite, 300 * paceMul());
      await sleep(SWORDSPIN.frames.length * SWORDSPIN.ms * paceMul() + 200);
    } else {
      curClip = GUNSPIN;
      frameIdx = 0;
      await sleep(GUNSPIN.frames.length * GUNSPIN.ms * loops);
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

// Big gaming moments on their own ~10 min cadences (staggered at session
// start: sword ~4 min in, devil ~10 min in), checked at random beat moments.
const GAMING_SWORD_EVERY = 10 * 60 * 1000;
const GAMING_DEVIL_EVERY = 10 * 60 * 1000;
let lastGamingSword = 0;
let lastGamingDevil = 0;

// Jittered so the beats land at random moments, never on a fixed tick.
function scheduleGamingBeat() {
  window.setTimeout(
    async () => {
      if (gamingActive() && beatReady()) {
        const now = Date.now();
        if (swordReady && now - lastGamingSword > GAMING_SWORD_EVERY && sceneAllowed()) {
          lastGamingSword = now;
          markScene();
          dbg("gaming sword move (10min cadence)");
          await demoSword();
        } else if (now - lastGamingDevil > GAMING_DEVIL_EVERY && sceneAllowed()) {
          lastGamingDevil = now;
          markScene();
          dbg("gaming devil trigger (10min cadence)");
          devilTriggerScene();
        } else if (now - lastGamingSpecial > 60 * 60 * 1000 && Math.random() < 0.35) {
          dbg("gaming special (hourly)");
          await gamingSpecial();
        } else {
          await gamingAmbience();
        }
      }
      scheduleGamingBeat();
    },
    60_000 + Math.random() * 150_000, // every ~1–3.5 min, randomly
  );
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

function playIdleCycle() {
  // M2 serialized gag: the pizza he never gets — once a week at most, and the
  // M5 payoff animation stays locked until he's earned it by asking.
  if (Math.random() < 0.05) {
    const l = story.pizzaLine();
    if (l) showBubble(l, PRIO.NOTABLE);
  }
  // M5: the payoff — ONLY after 3+ earned mentions, then the cycle restarts.
  if (story.s.gags.pizzaMentions >= 3 && Math.random() < 0.02 && !gagActive && home) {
    story.s.gags.pizzaMentions = 0;
    story.save();
    dbg("pizza payoff!");
    commitFor(PIZZA.msSeq!.reduce((a, b) => a + b, 0) * paceMul() + 400);
    curClip = PIZZA;
    frameIdx = 0;
    showBubble("Finally.", PRIO.NOTABLE);
    afterClip = () => playIdleCycle();
    return;
  }
  curUrge = pickIdle(life, lastIdleClip);
  // M5 gate: a Stranger doesn't get the intimate sword-care moment yet.
  if (curUrge.clip === "cleansword" && story.chapter() === "stranger")
    curUrge = { clip: "sitswing", plays: 2, hold: [8000, 16000] };
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
          curClip = WAKEUP;
          frameIdx = 0;
          afterClip = () => playIdleCycle();
        }
      : playIdleCycle;
  holdStill(idleClip(curUrge.clip), lo + Math.random() * (hi - lo), next);
}

function playWalk() {
  cancelAnimationFrame(winTween); // walking overrides any sit/stand tween
  curClip = WALK;
  frameIdx = 0;
}

// M1.4: mood pace — tired Dante plays every clip a touch slower, fresh Dante
// snappier. CLIP playback only; window tweens keep real time or walks drift.
function paceMul(): number {
  return Math.min(1.12, Math.max(0.88, 1.14 - life.v.energy * 0.26));
}

let curClip: Clip = ANIMS.idle;
let frameIdx = 0;
function frameLoop() {
  sprite.src = curClip.frames[frameIdx];
  const shownMs = (curClip.msSeq?.[frameIdx] ?? curClip.ms) * paceMul();
  frameIdx++;
  if (frameIdx >= curClip.frames.length) {
    if (curClip.loop) {
      frameIdx = curClip.settle; // hold the settled pose, don't replay the intro
    } else if (afterClip) {
      const fn = afterClip;
      afterClip = null;
      fn(); // e.g. advance the idle cycle
    } else if (stage.dataset.state === "idle") {
      playIdleCycle(); // a one-shot (laugh) ended while idle -> resume the rotation
    } else {
      curClip = ANIMS.idle;
      frameIdx = 0;
    }
  }
  window.setTimeout(frameLoop, shownMs);
}

let idleTimer: number | undefined;
let bubbleTimer: number | undefined;

// Work poses rotate so a long coding run isn't one clip looping forever.
const WORK_POSES = ["gunspin", "sit", "taunt"];
let workIdx = 0;

function setState(state: State) {
  // While YOU are typing, the laptop stays out — ambient AI poses don't
  // interrupt it (scenes still can, they run through their own path).
  if (Date.now() < typingUntil && state !== "success" && state !== "error") {
    stage.dataset.state = state;
    document.documentElement.style.setProperty("--accent", ACCENT[state]);
    return;
  }
  const prev = stage.dataset.state;
  stage.dataset.state = state;
  document.documentElement.style.setProperty("--accent", ACCENT[state]);
  afterClip = null;
  if (state === "idle") {
    posture(state);
    playIdleCycle(); // rotate seated poses: swing -> arms crossed -> thinking
    return;
  }
  // Entering thinking: a low "Hmm." — but only when he's been quiet a while and
  // I'm not mid-burst, so it reads as a thought, not a tic.
  if (
    state === "thinking" &&
    prev !== "thinking" &&
    !busyBurst() &&
    Date.now() - lastVoiceAt > VOICE_MIN_GAP
  ) {
    lastVoiceAt = Date.now();
    say("hmm"); // ~/.echo/voice/hmm.mp3 if present
  }
  // Working states cycle through several poses instead of repeating one.
  if (state === "coding" || state === "searching" || state === "speaking") {
    if (prev !== state) workIdx = (workIdx + 1) % WORK_POSES.length;
    // Cocky Dante taunts more (M1.4: the mood shows).
    const name =
      life.v.cockiness > 0.65 && Math.random() < 0.3 ? "taunt" : WORK_POSES[workIdx];
    curClip = clip(name, name === "gunspin" ? 90 : 200, true, name === "gunspin" ? 0 : 8);
    if (name === "gunspin") curClip.msSeq = GUNSPIN.msSeq; // keep the snap-stop curve
    if (name === "taunt") curClip.msSeq = TAUNT.msSeq;
  } else {
    curClip = ANIMS[state] ?? ANIMS.idle;
  }
  frameIdx = 0;
  posture(state); // sit on the panel for thinking, stand for the rest
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

function showBubble(text: string | null, prio: number = PRIO.NOTABLE) {
  if (bubbleTimer) clearTimeout(bubbleTimer);
  if (!text) {
    bubble.classList.add("hidden");
    return;
  }
  // Ambient chatter: usually skipped entirely, and always silent.
  if (prio === PRIO.AMBIENT) {
    // M2: a Stranger (week one) talks half as much — reserve is earned away.
    const chance =
      story.chapter() === "stranger" ? AMBIENT_BUBBLE_CHANCE / 2 : AMBIENT_BUBBLE_CHANCE;
    if (busyBurst() || Math.random() > chance) return;
  }
  bubble.textContent = text;
  bubble.classList.remove("hidden");
  const now = Date.now();
  const mayVoice =
    prio === PRIO.MAJOR || (prio === PRIO.NOTABLE && now - lastVoiceAt >= VOICE_MIN_GAP);
  if (mayVoice) {
    lastVoiceAt = now;
    voiceSay(text); // real recorded line if we have one, else a blip
  }
  bubbleTimer = window.setTimeout(() => bubble.classList.add("hidden"), 4500);
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
function levelUpFlash() {
  stage.classList.remove("leveling");
  void stage.offsetWidth; // restart the CSS animation
  stage.classList.add("leveling");
  vignettePulse(); // red Devil-Trigger flash over the whole window
  shake(500);
  sfxAura();
  sfxDemonRoar(); // the monster under the red glow
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

// Bridge: smoothly rise to standing, hold a beat, then the scene runs.
// Every scene that starts from idle goes through this — no instant jumps.
async function standUp(): Promise<void> {
  if (!home) return;
  cancelAnimationFrame(winTween);
  window.clearTimeout(postureSettle); // a pending sit-settle must not drop him mid-stand
  delete stage.dataset.facing;
  afterClip = null;
  seatedNow = false; // scenes stand regardless of the dwell
  postureChangedAt = Date.now();
  sfxRustle();
  await sleep(70); // a lean beat — bodies don't launch
  moveWindowY(home.y, 350);
  await sleep(380);
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
  curClip = seatedNow ? idleClip("sitcross") : STAND_CROSS;
  frameIdx = 0;
}

// Seated annoyed watch-check with a shrug line.
function annoyedWatch() {
  if (!home || gagActive || !seatedNow) return void lightError();
  stage.dataset.state = "error";
  document.documentElement.style.setProperty("--accent", ACCENT.error);
  commitFor(1700);
  curClip = idleClip("checkwatch");
  frameIdx = 0;
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
    curClip = COINFLIP;
    frameIdx = 0;
    await sleep(COINFLIP.frames.length * COINFLIP.ms * paceMul() + 250);
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
    curClip = GUNSPIN;
    frameIdx = 0;
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
    curClip = CHEER;
    frameIdx = 0;
    sfxDing();
    showBubble(pickLine(WIN_LINES), PRIO.NOTABLE);
    await sleep(950);
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
    curClip = STAGGER;
    frameIdx = 0;
    sfxThud();
    shake(220);
    showBubble(pickLine(SHRUG_LINES), PRIO.NOTABLE);
    await sleep(850);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

// Presence: after AWAY_AFTER_MS of no AI activity he wanders off; the next real
// event brings him back. lastActivity is refreshed on every agent-event.
const AWAY_AFTER_MS = 10 * 60 * 1000; // 10 min of silence -> he leaves
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
  recentEvents.push(lastActivity); // feeds busyBurst() — stay quiet when I'm hammering
  life.onEvent(e.state); // v2 P1: nudge the internal state (doesn't drive behaviour yet)
  // HUD + bubble are always live, even while a state is being held.
  starsEl.textContent = `★ ${e.stars}`;
  levelEl.textContent = `Lv.${e.level}`;
  const leveledUp = e.level > lastLevel; // handled as a Devil-Trigger scene below
  lastLevel = e.level;
  // Crossed a 25-star mark this event? (first event just seeds prevStars.)
  const crossedMilestone =
    prevStars >= 0 &&
    Math.floor(e.stars / STAR_MILESTONE) > Math.floor(prevStars / STAR_MILESTONE);
  prevStars = e.stars;
  // No ambient chatter over a running scene — the scene owns the screen.
  if (!gagActive && !showcasing) showBubble(e.phrase, PRIO.AMBIENT);
  dbg(
    `event=${e.state} lvlUp=${leveledUp} milestone=${crossedMilestone} home=${!!home} gag=${gagActive} show=${showcasing} away=${away} winStreak=${winStreak} errStreak=${errStreak}`,
  );
  if (gagActive || showcasing || returning || introActive) return; // a scene owns the sprite + window
  if (away) {
    returnScene(); // he's off-screen -> walk back in first; next events drive state
    return;
  }

  // Hold thinking/speaking for a minimum so they don't get clobbered instantly
  // by the next JSONL line. Defer (coalescing to the latest) until the hold ends.
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
    if (errStreak >= snap && sceneAllowed() && sceneBudgetOk("breakdown")) {
      errStreak = 0;
      markScene();
      budgetScene("breakdown");
      showBubble("Come on, seriously?", PRIO.MAJOR);
      diveGag(); // patience gone -> full breakdown
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
    if (leveledUp && sceneBudgetOk("devil")) {
      winStreak = 0;
      markScene();
      budgetScene("devil");
      devilTriggerScene();
      // M2 level chapters: levels unlock existing content, told as story.
      if (lastLevel >= 5 && story.unlock("sword_win_pool"))
        window.setTimeout(() => showBubble("Level 5. The sword comes out now.", PRIO.NOTABLE), 4000);
      if (lastLevel >= 10 && story.first("lv10"))
        window.setTimeout(() => showBubble("Double digits. Just warming up.", PRIO.NOTABLE), 4000);
    } else if (crossedMilestone && sceneAllowed() && sceneBudgetOk("dance")) {
      winStreak = 0;
      markScene();
      budgetScene("dance");
      danceScene(); // 25★ milestone -> dance
    } else if (winStreak >= 3 && sceneAllowed() && sceneBudgetOk("jackpot")) {
      winStreak = 0;
      markScene();
      budgetScene("jackpot");
      story.today().jackpots += 1;
      shootScene(); // on a roll -> Jackpot
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
  scrRight: number; // monitor's right edge (physical) — clamp popups on-screen
  winW: number;
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
  const seated = SEATED.has(state);
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
      if (p < 1) requestAnimationFrame(step);
      else {
        window.clearInterval(scuffs);
        resolve();
      }
    };
    requestAnimationFrame(step);
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
    // hang down over the taskbar. Nudge in ~0.04·winH steps if off.
    const sitY = y + Math.round(winH * 0.34);
    // A small visible dip for the error fall — he stays fully on-screen so the
    // falling + climb animations are unmissable (no dropping off the bottom).
    const belowY = y + Math.round(winH * 0.3);
    home = { win, ox, scrRight: ox + sw, winW, y, sitY, belowY, cornerX, lastX: startX, lastY: y };
    dbg(`intro home set mon=${sw}x${sh} y=${y} sitY=${sitY} corner=${cornerX}`);
    await win.setPosition(new PhysicalPosition(startX, y));
    stage.dataset.facing = "right";
    playWalk(); // side-view walk cycle while moving
    await slideWindow(cornerX, 150); // realistic walking pace (px/sec)
    delete stage.dataset.facing;
    // deceleration beat — he's stopped walking, takes a breath
    await sleep(400);
    // arrival: stand tall, arms crossed, and LOOK around before settling in
    curClip = STAND_CROSS;
    frameIdx = 0;
    await sleep(900);
    stage.dataset.facing = "left"; // glance left
    await sleep(650);
    stage.dataset.facing = "right"; // glance right
    await sleep(650);
    delete stage.dataset.facing;
    await sleep(500); // settle
    // then sit DOWN onto the panel (stand->sit) while the window lowers
    curClip = SITDOWN;
    frameIdx = 0;
    posture("idle", true); // drop the window to the seated height
    await sleep(SITDOWN.frames.length * SITDOWN.ms);
    setState("idle"); // seated leg-swing loop
    // Discovery > demonstration. No auto-showcase — let users find everything
    // naturally. Set localStorage "echo.forceReel"=1 + reload for debug.
    dbg("intro done -> natural (discovery > demonstration)");
  } catch (err) {
    dbg(`intro ERROR: ${err}`);
    console.error("intro failed", err);
  } finally {
    introActive = false;
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
    curClip = STAND_CROSS; // stand tall, arms crossed
    frameIdx = 0;
    showBubble(pickLine(LEAVE_LINES), PRIO.MAJOR);
    await sleep(2400);
    const offX = h.ox - h.winW - 8;
    stage.dataset.facing = "left";
    playWalk();
    await slideWindow(offX, 150); // walk off to the left
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
    h.lastX = h.ox - h.winW - 8; // start fully off-screen left
    await h.win.setPosition(new PhysicalPosition(h.lastX, h.y));
    h.lastY = h.y;
    stage.dataset.facing = "right";
    playWalk();
    await slideWindow(h.cornerX, 150); // walk back to the corner
    delete stage.dataset.facing;
    // stand and look around before sitting — same arrival beat as the intro
    curClip = STAND_CROSS;
    frameIdx = 0;
    await sleep(STAND_CROSS.frames.length * STAND_CROSS.ms + 500);
    curClip = SITDOWN; // sit down onto the panel
    frameIdx = 0;
    posture("idle", true);
    await sleep(SITDOWN.frames.length * SITDOWN.ms);
    setState("idle");
    showBubble(pickLine(RETURN_LINES), PRIO.MAJOR);
  } finally {
    returning = false;
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
  curClip = LAUGH; // one-shot -> frameLoop falls back to idle (leg-swing)
  frameIdx = 0;
  commitFor(LAUGH.frames.length * LAUGH.ms); // let the chuckle play out
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
    curClip = FALLING;
    frameIdx = 0;
    showBubble("Whoa, falling!", PRIO.MAJOR);
    await sleep(700); // flail, fully visible
    await new Promise<void>((res) => (moveWindowY(h.belowY, 700), window.setTimeout(res, 720)));
    sfxThud();
    shake(320); // he hits the bottom
    await sleep(500);
    // 2) climb back up (facing left), rises back to standing — fully visible
    stage.dataset.facing = "left";
    curClip = CLIMB;
    frameIdx = 0;
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
    curClip = SHOOT;
    frameIdx = 0;
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
      curClip = GUNSPIN;
      frameIdx = 0;
      await sleep(GUNSPIN.frames.length * GUNSPIN.ms);
      sfxHolster();
    } else {
      curClip = TAUNT;
      frameIdx = 0;
      showBubble("Come on!", PRIO.MAJOR);
      await sleep(TAUNT.frames.length * TAUNT.ms + 350);
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
  try {
    await sleep(700);
    // seated idle rotation
    await demo(IDLE_CYCLE[0], "sitting", 1700, true); // legs swinging
    await demo(IDLE_CYCLE[1], "arms crossed", 1900, true); // arms crossed
    await demo(IDLE_CYCLE[2], "thinking", 2300, true); // thinking
    await demo(clip("checkwatch", 200, false), "checking the time", 1900, true); // impatient
    await demo(LAUGH, "laughing", 1500, true); // laugh
    // standing work
    await demo(ANIMS.coding, "coding", 2000, false); // front work loop
    await demo(WALK, "walking", 1600, false); // side walk cycle
    afterClip = null;
    dbg("showcase SCENES begin");
    // scenes — kept INSIDE the showcasing guard so a live event can't grab
    // gagActive and make a scene early-return (that was skipping the fall/climb).
    await shootScene(); // Jackpot (+ gun-spin / taunt follow-through)
    await sleep(300);
    await devilTriggerScene(); // Devil Trigger power pose
    await sleep(300);
    await diveGag(); // fall → climb up
    await sleep(300);
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

async function posterScene(durationMs: number) {
  if (!home || gagActive) return;
  gagActive = true;
  let win: WebviewWindow | null = null;
  let audio: HTMLAudioElement | null = null;
  let bob = 0;
  const h = home;
  try {
    // Song is created (preloading) now but PLAYS at the poster reveal below,
    // so gif and music start in the same second.
    audio = new Audio(posterMedia.get("song") ?? POSTER_SONG_URL);
    audio.volume = 0.45;
    audio.preload = "auto";
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    await standUp();
    // Both arms raised (dance frame 5) — he's holding the плакат overhead.
    curClip = { frames: [DANCE.frames[5]], ms: 500, loop: true, settle: 0 };
    frameIdx = 0;
    showBubble("Too easy.", PRIO.MAJOR);
    // Poster window shaped to the gif: fit inside 250x170 logical + frame chrome.
    const sz = (await gifSize(posterMedia.get("poster") ?? "/media/poster.gif")) ?? {
      w: 84,
      h: 107,
    };
    const chrome = 18;
    const k = Math.min((250 - chrome) / sz.w, (170 - chrome) / sz.h);
    const pwL = Math.round(sz.w * k) + chrome;
    const phL = Math.round(sz.h * k) + chrome;
    win = new WebviewWindow("poster", {
      url: "index.html?poster=1",
      width: pwL,
      height: phL,
      visible: false, // built hidden; revealed in sync with the song below
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: false,
      shadow: false,
    });
    await new Promise<void>((res) => {
      win!.once("tauri://created", () => res());
      win!.once("tauri://error", (e) => {
        dbg(`poster window error: ${JSON.stringify(e)}`);
        res();
      });
    });
    // Directly above his raised hands, centered on the sprite window; a slow
    // ±3px bob so the held poster feels alive.
    const sf = window.devicePixelRatio || 1;
    const pw = Math.round(pwL * sf);
    const ph = Math.round(phL * sf);
    const winW = Math.round(190 * sf);
    // Centered over him, but a wide poster must not run off the screen edge.
    const px = Math.min(Math.round(h.lastX + (winW - pw) / 2), h.scrRight - pw - 6);
    const py = Math.round(h.y - ph + 26);
    await win.setPosition(new PhysicalPosition(px, py));
    // The synchronized beat: reveal the poster, start its gif, start the song —
    // all in the same tick. Small settle first so the webview is ready.
    await sleep(250);
    await win.show().catch(() => {});
    void emit("poster-show");
    audio.onerror = () => dbg(`song decode error: code=${audio?.error?.code}`);
    audio
      .play()
      .then(() => dbg("song playing"))
      .catch((e) => dbg(`song play failed: ${e}`));
    let t = 0;
    bob = window.setInterval(() => {
      t += 1;
      void win?.setPosition(new PhysicalPosition(px, py + Math.round(Math.sin(t) * 3)));
    }, 420);
    dbg("poster scene (media open)");
    await sleep(durationMs);
  } finally {
    window.clearInterval(bob);
    if (win) void win.close().catch(() => {});
    if (audio) {
      const a = audio;
      const fade = window.setInterval(() => {
        a.volume = Math.max(0, a.volume - 0.06);
        if (a.volume <= 0.01) {
          a.pause();
          window.clearInterval(fade);
        }
      }, 80);
    }
    gagActive = false;
    setState("idle");
  }
}

// Milestone celebration: stand up and dance a couple of loops, then sit.
async function danceScene(durationMs?: number) {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    // smooth bridge: stand up, then dance — classic moves or the headbang
    await standUp();
    await sleep(240 + Math.random() * 120); // a breath before the first move
    // §10: headbang leads; the classic moves become the rarer treat.
    curClip = Math.random() < 0.8 ? HEADBANG : DANCE;
    frameIdx = 0;
    showBubble("Too easy.", PRIO.MAJOR);
    const loop = DANCE.frames.length * DANCE.ms;
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
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.error);
    // smooth bridge: stand up, then transform
    await standUp();
    await sleep(300 + Math.random() * 150); // the stillness before the power
    curClip = DEVIL;
    frameIdx = 0;
    levelUpFlash(); // red sprite glow + vignette + aura + shake
    void sayDemonJackpot(); // the monster says JACKPOT
    showBubble(`Lv.${lastLevel} — Devil Trigger!`, PRIO.MAJOR);
    await sleep(1900);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

// M1.5: breathing — a 1px sine on a wrapper div so it never fights the
// sprite's own transforms (facing flip, scene keyframes). Pauses when a scene
// owns the stage; the period stretches when his energy is low.
function startBreathing() {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.alignItems = "flex-end";
  wrap.style.justifyContent = "center";
  sprite.parentElement!.insertBefore(wrap, sprite);
  wrap.appendChild(sprite);
  const step = (now: number) => {
    const busy = gagActive || showcasing || introActive || wandering || away || returning;
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

  // M2: load the story; a new day gets a greeting built from yesterday's REAL
  // numbers — he remembers, and says so once the walk-in has finished.
  await story.load();
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
    if (returning || wandering || gagActive || showcasing) return;
    if (away) {
      if (Date.now() - awayAt > AWAY_RETURN_MS) returnScene();
      return;
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
    if (gagActive || showcasing || wandering || away || returning || committed()) return;
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

if (new URLSearchParams(location.search).has("poster")) posterMain();
else main();
