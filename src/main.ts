import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Life } from "./life";
import { Story, dateKey } from "./story";
import { CORVIN, corvinClipTotal, type CorvinClip } from "./corvin";
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
// ---- Character packs ---------------------------------------------------------
// "dante" (default) or "corvin" — read from ~/.echo/character at boot, switched
// live with `echo be corvin > ~/.echo/demo`. Corvin swaps the state clips and
// every big scene; the engine (states, streaks, budgets, story) is shared.
let character: "dante" | "corvin" = "dante";
const isCorvin = () => character === "corvin";
const ANIMS_DANTE: Record<State, Clip> = { ...ANIMS };
function applyCharacter() {
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
// Eating is SLOW — box appears, opens, a full second ADMIRING it (the beat
// that sells the gag), then long chewing, satisfied vanish.
PIZZA.msSeq = [200, 220, 260, 320, 1050, 520, 620, 560, 640, 480, 320, 260, 240];
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
  if (!idleClipCache[name]) {
    if (name === "cleansword") {
      // Sword care is SEVERAL passes of the cloth, not one wipe: appear (0-1),
      // wipe 2-8 three times (repeats reference the same frame urls), vanish.
      const base = clip("cleansword", 200, false, 0, 11).frames;
      const wipe = [2, 3, 4, 5, 6, 7, 8];
      const seq = [0, 1, ...wipe, ...wipe, ...wipe, 9, 10].map((i) => base[i]);
      idleClipCache[name] = { frames: seq, ms: 200, loop: false, settle: 0 };
    } else {
      idleClipCache[name] = clip(name, IDLE_MS[name] ?? 200, false);
    }
  }
  return idleClipCache[name];
}
const IDLE_CYCLE = ["sitswing", "sitcross", "sitthink"].map(idleClip); // showcase demos
// When a one-shot clip ends, run this instead of the default idle fallback.
let afterClip: (() => void) | null = null;

// preload every frame
const PRELOADED: HTMLImageElement[] = [];
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
  // The whole Corvin pack too — an unloaded frame on a clip switch flashes the
  // broken-image icon mid-scene (caught by the capture rig, twice per reel).
  ...Object.values(CORVIN),
].forEach((c) =>
  c.frames.forEach((s) => {
    const im = new Image();
    im.src = s;
    PRELOADED.push(im); // HOLD the references — dropped Images get cache-evicted
  }),
);

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
    if (isCorvin()) {
      // No laptop for the sentinel: while you type he sits and tends the blade.
      // A typing session that survives 7 minutes earns a novel chapter; a gap
      // longer than 90 s starts the session clock over.
      if (!typingSessionStart || Date.now() - lastTypingEventAt > 90_000)
        typingSessionStart = Date.now();
      lastTypingEventAt = Date.now();
      maybeTellNovel();
      if (curClip !== (CORVIN.whetstone as Clip)) {
        stage.dataset.state = "idle";
        curClip = CORVIN.whetstone as Clip;
        frameIdx = 0;
        afterClip = null;
        dbg("typing -> whetstone (corvin)");
        tickTyping();
      }
      return;
    }
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
  if (kind === "demo_corvin") {
    void demoCorvin();
    return;
  }
  // Character pack switch (live, persisted): `echo be corvin > ~/.echo/demo`.
  if (kind === "demo_be_corvin" || kind === "demo_be_dante") {
    character = kind === "demo_be_corvin" ? "corvin" : "dante";
    applyCharacter();
    void invoke("character_save", { name: character }).catch(() => {});
    showBubble(isCorvin() ? "Корвин. Страж." : "Dante's back.", PRIO.NOTABLE);
    setState("idle");
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
  if (kind === "demo_night") return void nightSongScene();
  // ALT+S (global hotkey): the song on demand — Corvin plays the guitar,
  // Dante raises the плакат. Same busy-gate as demos: never mid-scene.
  if (kind === "hotkey_song") {
    if (isCorvin()) void nightSongScene();
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
  if (kind === "demo_combo") return void comboFlowScene();
  if (kind === "demo_parry") return void parryBeat();
  if (kind === "demo_ritual") {
    story.s.lastRitualDay = ""; // let today's ceremony run again, for QA
    maybeDailyRitual();
    return;
  }
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
    gamingUntil = Date.now() + 60 * 1000;
    // Borderless games repaint above us unless TOPMOST is re-asserted; do it
    // on the heartbeat so he rides on top of the game, not behind it.
    void getCurrentWindow().setAlwaysOnTop(true).catch(() => {});
    return;
  }
  if (kind === "game_start") {
    // The REAL game launch edge (Steam RunningAppID 0->N or a fullscreen flip):
    // anchor the fixed schedule here — devil at 3:00, sword at 7:00, then each
    // every 10 min. The Steam client window alone must not arm these.
    lastGamingDevil = Date.now() - GAMING_DEVIL_EVERY + 3 * 60 * 1000;
    lastGamingSword = Date.now() - GAMING_SWORD_EVERY + 7 * 60 * 1000;
    armHuntClocks(); // Corvin's full repertoire, one beat per minute mark
    armDanteClocks(); // spin@6:00/20m, coin@+3h, pizza@+3.5h — same session zero
    dbg("game_start -> beat clocks armed (devil@3:00, sword@7:00)");
    return;
  }
  if (kind === "media_active") {
    mediaUntil = Date.now() + 3 * 60 * 1000; // video/music still playing
    serviceMediaWish(); // a queued "you opened YouTube" moment gets its chance
    // While it's on, he breaks into a 15 s dance every ~10 min — but it shares
    // the one scene budget, so it can't stack against Jackpot & co.
    if (Date.now() - lastMediaDance > MEDIA_DANCE_EVERY) {
      if (beatReady() && sceneAllowed()) {
        lastMediaDance = Date.now();
        mediaWanted = 0; // the wish is served
        markScene();
        dbg("media session poster (15s)");
        if (isCorvin()) void guitarScene(15000); // he plays along instead
        else posterScene(15000); // the плакат every time, not just on open
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
    // The edge fires ONCE (Rust throttles it), so a busy moment must not eat
    // it: queue instead, and only burn the 10-minute clock once it really ran.
    mediaWanted = Date.now();
    serviceMediaWish();
  } else if (kind === "gaming") {
    // Mood only — the devil/sword clocks are armed by "game_start" (the real
    // launch edge), never by DNS hits or the Steam client window.
    gamingUntil = Date.now() + 3 * 60 * 1000;
    markScene();
    if (isCorvin()) void magicscanScene(); // the hunt opens with a perimeter scan
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
function tickTyping() {
  window.setTimeout(() => {
    if (isCorvin()) {
      // Whetstone session: keep stroking while you type, then simply rest.
      if (curClip !== (CORVIN.whetstone as Clip)) return;
      if (Date.now() < typingUntil) {
        tickTyping();
        return;
      }
      curClip = ANIMS.idle;
      frameIdx = 0;
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

// ---- Corvin showcase (`echo corvin > ~/.echo/demo`) ------------------------
// The Sentinel's full first sheet on the taskbar, timed per corvin.ts: entry,
// bow, charge, execution, shadow aura, storyteller, guitar, vigil, Artsiv
// cycle, meditation, exit. A rehearsal for the character pack — Dante's stage,
// Corvin's reel.
async function playCorvin(c: (typeof CORVIN)[keyof typeof CORVIN], passes = 1) {
  const total = corvinClipTotal(c) * passes;
  commitFor(total + 300); // session events must not flash Dante mid-reel
  curClip = c;
  frameIdx = 0;
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
    await playCorvin(CORVIN.walkin, 2); // steps onto the stage
    await playCorvin(CORVIN.bow);
    await playCorvin(CORVIN.idle);
    await playCorvin(CORVIN.charge); // the blade ignites
    await playCorvin(CORVIN.execraise); // execution: slow raise...
    await playCorvin(CORVIN.execstrike); // ...one devastating cut
    await playCorvin(CORVIN.aurarise); // the shadow monarch aura
    await playCorvin(CORVIN.auraburn, 2);
    await playCorvin(CORVIN.aurasink);
    await playCorvin(CORVIN.sit);
    showBubble("The bird thinks your code is sloppy.", PRIO.NOTABLE);
    await playCorvin(CORVIN.whetstone, 2); // storyteller strokes
    await playCorvin(CORVIN.guitar, 3); // the YouTube moment
    await playCorvin(CORVIN.idle); // neutral beat before the vigil
    await playCorvin(CORVIN.kneeldown);
    await playCorvin(CORVIN.eaglehop);
    await playCorvin(CORVIN.kneelrise);
    await playCorvin(CORVIN.takeoff); // Artsiv flies...
    await sleep(900);
    await playCorvin(CORVIN.landing); // ...and returns
    await playCorvin(CORVIN.meditate, 2);
    stage.dataset.facing = "left";
    await playCorvin(CORVIN.walkout, 2); // leaves the way knights do
  } finally {
    stage.dataset.facing = "right";
    gagActive = false;
    setState("idle");
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
function speakLine(text: string): Promise<void> {
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
    u.rate = 0.88; // unhurried
    u.pitch = 0.42; // deep, worn, powerful
    u.volume = 1.0;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        res();
      }
    };
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
    window.setTimeout(finish, 14000); // hard cap per line
  });
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
    curClip = CORVIN_SIT_REV; // rise first — no teleporting to his feet
    frameIdx = 0;
    afterClip = null;
    await sleep(corvinClipTotal(CORVIN_SIT_REV));
  }
  curClip = target;
  frameIdx = 0;
  afterClip = null;
  if (title) {
    commitFor(20_000);
    showBubble(title, PRIO.NOTABLE);
    await speakLine(title);
    await sleep(400);
  }
  for (const l of lines) {
    commitFor(20_000); // rolling commit: nothing yanks the clip mid-sentence
    showBubble(l, PRIO.NOTABLE);
    await speakLine(l);
    await sleep(350);
  }
  commitFor(400); // release quickly once the story is told
}

async function corvinScene(body: () => Promise<void>, accent?: string) {
  if (!home || gagActive) {
    dbg(`corvin scene refused: home=${!!home} gag=${gagActive} com=${committed()}`);
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
    gagActive = false;
    setState("idle");
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
  await playCorvin(CORVIN.sit);
  await playCorvin(CORVIN.swordaway); // the blade crumbles, tip first
  await playCorvin(CORVIN.guitartake); // reaches down, lifts it, Artsiv rises
}
async function corvinPutGuitar() {
  await playCorvin(REV(CORVIN.guitartake)); // guitar back to the floor
  await playCorvin(REV(CORVIN.swordaway)); // motes gather into steel again
}

// The плакат moment, Corvin's way: he sits and plays for the music you opened.
async function guitarScene(durationMs: number) {
  await corvinScene(async () => {
    await corvinTakeGuitar();
    const passes = Math.max(2, Math.round(durationMs / corvinClipTotal(CORVIN.guitar)));
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
  const tale = story.nextTale();
  await corvinScene(async () => {
    if (tale) await tellStory(tale.lines);
    else await playCorvin(CORVIN.whetstone, 2); // corpus finished — quiet strokes
  });
}

// ---- Media wish queue (user-directed "youtube trigger fix") ------------------
// The "media" edge fires once when you open YouTube/Spotify — the backend then
// throttles it for two minutes. If he happened to be mid-scene, the moment used
// to be DROPPED and nothing played until you reopened the tab. Now the wish is
// remembered and served the second he's free (it expires after 3 min so it
// can't surprise you long after the fact).
let mediaWanted = 0;
function serviceMediaWish() {
  if (!mediaWanted) return;
  if (Date.now() - mediaWanted > 3 * 60_000) {
    mediaWanted = 0; // stale — you've moved on
    return;
  }
  if (!beatReady() || !sceneAllowed()) return; // try again on the next heartbeat
  mediaWanted = 0;
  lastMediaDance = Date.now();
  markScene();
  dbg("media wish served");
  if (isCorvin()) void guitarScene(15000);
  else posterScene(15000);
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
      audio.onerror = () => {
        dbg("nightsong missing -> synth lament");
        stopMelody = playNightMelody(NIGHT_SONG_MS);
      };
      void audio.play().catch(() => {
        stopMelody = playNightMelody(NIGHT_SONG_MS);
      });
    } else {
      stopMelody = playNightMelody(NIGHT_SONG_MS);
    }
    try {
      const passes = Math.max(2, Math.round(NIGHT_SONG_MS / corvinClipTotal(CORVIN.guitar)));
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
    commitFor(2000);
    curClip = CORVIN_SIT_REV;
    frameIdx = 0;
    afterClip = null;
    await sleep(corvinClipTotal(CORVIN_SIT_REV));
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
    showBubble(line, PRIO.NOTABLE);
    await speakLine(line);
    await sleep(1200);
  });
}

// Fires within the first minutes of the new day; one gag flag per night. If he
// is mid-scene at 00:00 sharp, the next minute's check catches it.
function scheduleMidnight() {
  window.setInterval(() => {
    if (!isCorvin() || !home) return;
    const now = new Date();
    const h = now.getHours();
    const busy = gagActive || showcasing || introActive || wandering || away || returning;
    if (busy) return;
    // The 23:40 requiem owns the last twenty minutes of the day; every other
    // ritual keeps its ten-minute window at the top of its hour.
    if (now.getMinutes() >= 10 && !(h === 23 && now.getMinutes() >= 40)) return;
    // 17:00 — the Breach, hard (user-directed). The day's one real fight.
    if (h === 17) {
      const last = story.s.gags.lastBreachAt ?? 0;
      if (Date.now() - last < 6 * 3_600_000) return;
      dbg("breach ritual (17:00)");
      void breachScene(); // it stamps lastBreachAt itself
      return;
    }
    // The rest of the repertoire, one move per fixed hour (user-directed).
    const slot = DAILY_HOURS.find((s) => s.h === h);
    if (slot) {
      const key = `${dateKey()}-${h}`;
      if (story.s.gags.lastHourSlot === key) return; // already run today
      // Only when you're actually there (user-directed): no performances to an
      // empty room. Not stamped on a miss, so it retries within the hour.
      const seen = Math.max(lastActivity, lastTypingEventAt, gamingUntil - 60_000);
      if (Date.now() - seen > 30 * 60_000) return;
      story.s.gags.lastHourSlot = key;
      story.save();
      dbg(`daily hour ${h}:00 -> ${slot.name}`);
      slot.run();
    }
    // 23:40 — the requiem: the whole grief line as one film, under the song.
    // Midnight picks it up twenty minutes later with the guitar.
    if (h === 23 && now.getMinutes() >= 40) {
      const last = story.s.gags.lastRequiemAt ?? 0;
      if (Date.now() - last < 12 * 3_600_000) return; // once a night
      story.s.gags.lastRequiemAt = Date.now();
      story.save();
      dbg("requiem ritual (23:40)");
      void requiemScene();
      return;
    }
    // 00:00 — the guitar. He plays, the shadow rises, one quiet line.
    if (h === 0) {
      const last = story.s.gags.lastNightSongAt ?? 0;
      if (Date.now() - last < 12 * 3_600_000) return; // once per night
      story.s.gags.lastNightSongAt = Date.now();
      story.save();
      dbg("midnight ritual");
      void nightSongScene();
      return;
    }
    // 01:00 and 13:00 — the breakdown (user-directed clock). Six-hour guard so
    // a restart inside the window can't replay it.
    if (h === 1 || h === 13) {
      const last = story.s.gags.lastBreakdownAt ?? 0;
      if (Date.now() - last < 6 * 3_600_000) return;
      story.s.gags.lastBreakdownAt = Date.now();
      story.save();
      dbg(`breakdown ritual (${h}:00)`);
      void breakdownScene();
    }
  }, 60_000);
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
      // watches it dry. Same wait either way.
      const p = dayPart();
      const wet = p === "evening" || p === "night";
      await playCorvin(wet ? CORVIN.roadrain : CORVIN.road);
      await sleep(6000); // he keeps watching after the clip settles
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

async function rainScene(ms = 22_000) {
  await corvinScene(async () => {
    const stopWind = playWind();
    try {
      const passes = Math.max(2, Math.round(ms / corvinClipTotal(CORVIN.rain)));
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
      await sleep(4000);
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
    showBubble(line, PRIO.NOTABLE);
    await speakLine(line);
    await sleep(1500);
  });
}

// Long private cadences — these must stay rare to keep their weight.
const LETTER_EVERY = 7 * 86_400_000; // once a week
const CAIRN_EVERY = 30 * 86_400_000; // once a month
function griefUrge(): (() => Promise<void>) | null {
  const now = Date.now();
  const g = story.s.gags;
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
  stage.dataset.state = "error";
  document.documentElement.style.setProperty("--accent", ACCENT.error);
  commitFor(corvinClipTotal(CORVIN.parry) * paceMul() + 300);
  curClip = CORVIN.parry as Clip;
  frameIdx = 0;
  window.setTimeout(() => {
    sfxGunshot(); // the steel-on-steel crack lands on the spark frame
    shake(220);
  }, 170 * paceMul());
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
    stage.dataset.state = "error";
    document.documentElement.style.setProperty("--accent", ACCENT.error);
    commitFor(corvinClipTotal(CORVIN.damage) * paceMul() + 300);
    curClip = CORVIN.damage as Clip;
    frameIdx = 0;
    sfxIgnite();
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
function corvinSetQuiet(pose: string) {
  const wasSeated = corvinQuietPose === "meditate" || corvinQuietPose === "whet";
  const willSit = pose === "meditate" || pose === "whet";
  corvinQuietPose = pose;
  const target = (): Clip =>
    pose === "scan" ? (CORVIN.huntwatch as Clip)
    : pose === "meditate" ? (CORVIN.meditate as Clip)
    : pose === "whet" ? (CORVIN.whetstone as Clip)
    : ANIMS.idle;
  if (willSit && !wasSeated) {
    curClip = CORVIN.sit as Clip; // ease down first
    frameIdx = 0;
    afterClip = () => {
      curClip = target();
      frameIdx = 0;
    };
  } else if (!willSit && wasSeated) {
    curClip = CORVIN_SIT_REV; // stand back up, reversed sit
    frameIdx = 0;
    afterClip = () => {
      curClip = target();
      frameIdx = 0;
    };
  } else {
    curClip = target();
    frameIdx = 0;
    afterClip = null;
  }
}
// Fixed clocks for his daily animations (user-directed: hard timing, not a
// dice roll). Each move has its own period and fires when it's the most
// overdue — so every one of them is guaranteed to show up, on schedule.
// The Steam-only moves (cleave, Unchained) and the YouTube-only move (guitar)
// are deliberately NOT here: those belong to their triggers alone.
const CORVIN_CLOCKS: Array<{ name: string; every: number; last: number; run: () => void }> = [
  { name: "scan", every: 6 * 60_000, last: 0, run: () => void magicscanScene() },
  { name: "artsiv", every: 10 * 60_000, last: 0, run: () => void artsivCycleScene() },
  { name: "aura", every: 8 * 60_000, last: 0, run: () => void auraScene() },
  { name: "tale", every: 12 * 60_000, last: 0, run: () => void whetstoneTaleScene() },
  { name: "bow", every: 20 * 60_000, last: 0, run: () => void corvinScene(() => playCorvin(CORVIN.bow)) },
  // The quiet ones. Long clocks on purpose — they stop meaning anything the
  // moment they become frequent.
  { name: "road", every: 25 * 60_000, last: 0, run: () => void roadScene() },
  { name: "rain", every: 40 * 60_000, last: 0, run: () => void rainScene() },
];
// Staggered from boot so the first hour doesn't fire them all at once:
// scan 2:00, aura 4:00, artsiv 6:00, tale 8:00, bow 15:00.
function armCorvinClocks() {
  const now = Date.now();
  const firstAt: Record<string, number> = { scan: 2, aura: 4, artsiv: 6, tale: 8, bow: 15 };
  for (const c of CORVIN_CLOCKS) c.last = now - c.every + firstAt[c.name] * 60_000;
}
function runCorvinClock() {
  // The grief scenes outrank every clock: their cadences are measured in weeks
  // and months, so they must never lose a slot to a routine urge.
  const grief = griefUrge();
  if (grief) {
    void grief();
    return;
  }
  const now = Date.now();
  const due = CORVIN_CLOCKS.filter((c) => now - c.last >= c.every).sort(
    (a, b) => (now - b.last) / b.every - (now - a.last) / a.every,
  );
  if (!due.length) return; // nothing owed yet — he just keeps his watch
  const c = due[0];
  c.last = now;
  dbg(`clock(corvin) ${c.name} (every ${Math.round(c.every / 60_000)}m)`);
  c.run();
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
      // gamingActive: during a hunt the 3:00/7:00/hourly beats OWN the stage —
      // random urges must not steal their windows (they were: beat skipped
      // gag=true while a tale played over the game).
      if (
        !isCorvin() ||
        gagActive ||
        showcasing ||
        introActive ||
        wandering ||
        away ||
        returning ||
        gamingActive()
      ) {
        return; // corvinIdleCycle() (next setState idle) restarts the chain
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
          runCorvinClock(); // same fixed clocks while you work
          return;
        }
        corvinIdleTick();
        return;
      }
      if (corvinQuietRuns >= 1 + Math.floor(Math.random() * 2)) {
        // a big urge earned by a few quiet rotations
        corvinQuietRuns = 0;
        runCorvinClock(); // fixed clocks, not a dice roll (user-directed)
        return; // the scene's setState("idle") re-arms the cycle
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
    },
    // user-directed: "хочу другие анимации чаще" — quick pose turns, an urge
    // roughly every 30-90 s of quiet
    15_000 + Math.random() * 15_000,
  );
}

// ---- Dante's fixed-clock beats (user-directed timings) -----------------------
// ALL anchored to the GAME-SESSION start (the Steam shoot burst is minute 0):
// swordspin at 6:00 then every 20 min; sword move at 7:00 then every 10 min
// (the gaming loop owns that one); coinflip at +3 h then every 3 h; pizza at
// +3.5 h then every 3.5 h. Until the first game launch these clocks are silent.
// Shrug: 20 min of doing nothing at all (no typing, no gaming), any time.
// Checked every 30 s; a busy moment defers to the next tick, never skips.
const BOOT_AT = Date.now();
let lastDanteSpin = 0; // 0 = unarmed until a game session starts
let lastDanteCoin = 0;
let lastDantePizza = 0;
let lastDanteShrug = BOOT_AT;
function armDanteClocks() {
  lastDanteSpin = Date.now() - 20 * 60_000 + 6 * 60_000; // -> first spin at 6:00
  lastDanteCoin = Date.now(); // -> coin at +3 h
  lastDantePizza = Date.now(); // -> pizza at +3.5 h
  dbg("dante clocks armed: spin@6:00/20m, coin@3h, pizza@3.5h");
}
function scheduleDanteBeats() {
  window.setInterval(() => {
    if (isCorvin() || !home || !beatReady()) return;
    const now = Date.now();
    if (lastDantePizza && now - lastDantePizza > 3.5 * 3_600_000) {
      lastDantePizza = now;
      dbg("dante beat: pizza (3.5h clock)");
      demoSeated(PIZZA, "Finally.");
      return;
    }
    if (lastDanteCoin && now - lastDanteCoin > 3 * 3_600_000) {
      lastDanteCoin = now;
      dbg("dante beat: coinflip (game +3h clock)");
      void coinFlourish();
      return;
    }
    if (lastDanteSpin && now - lastDanteSpin > 20 * 60_000) {
      lastDanteSpin = now;
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

// Big gaming moments on fixed 10-min cadences: Devil Trigger at 3:00 into the
// session, sword move at 7:00 (clocks armed in the "gaming" handler), then
// every 10 min each. Checked every 20 s so beats land near their exact mark.
const GAMING_SWORD_EVERY = 10 * 60 * 1000;
const GAMING_DEVIL_EVERY = 10 * 60 * 1000;
// The Breach joins the hunt on its own 10-minute clock (user-directed), first
// at 10:00 in. With four clocks running the hunt is a near-constant show —
// that is the intent: Steam is when he actually fights.
let lastGamingSword = 0;
let lastGamingDevil = 0;
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
];

// ---- The day's hour table (user-directed) ----------------------------------
// Everything that isn't a hunt beat gets a fixed hour instead. One firing per
// hour per day, remembered in story.json so a restart can't replay it.
const DAILY_HOURS: Array<{ h: number; name: string; run: () => void }> = [
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
  { h: 19, name: "aura", run: () => void auraScene() },
  { h: 20, name: "cleave", run: () => void cleaveScene() },
  { h: 21, name: "combo", run: () => void comboFlowScene() },
  { h: 22, name: "artsiv-strike", run: () => void artsivStrikeScene() },
];
function armHuntClocks() {
  const now = Date.now();
  for (const c of HUNT_CLOCKS) c.last = now - c.every + c.firstAt * 60_000;
  dbg(`hunt clocks armed: ${HUNT_CLOCKS.map((c) => `${c.name}@${c.firstAt}:00`).join(", ")}`);
}
let nextGamingAmbience = 0;

let lastBeatSkipLog = 0;
function scheduleGamingBeat() {
  window.setTimeout(async () => {
    try {
      const now = Date.now();
      if (gamingActive() && beatReady()) {
        // Corvin's hunt runs off the clock TABLE below, so every move he owns
        // gets its own minute mark inside a session (user-directed: "all
        // animations on time in Steam"). Most-overdue wins when two are due.
        const due = isCorvin()
          ? HUNT_CLOCKS.filter((c) => now - c.last >= c.every).sort(
              (a, b) => (now - b.last) / b.every - (now - a.last) / a.every,
            )
          : [];
        if (due.length && sceneAllowed()) {
          const c = due[0];
          c.last = now;
          markScene();
          dbg(`hunt ${c.name} (${c.firstAt}:00 + ${Math.round(c.every / 60_000)}m)`);
          await c.run();
        } else if (!isCorvin() && now - lastGamingDevil > GAMING_DEVIL_EVERY && sceneAllowed()) {
          lastGamingDevil = now;
          markScene();
          dbg("gaming devil trigger (3:00 + 10min cadence)");
          devilTriggerScene();
        } else if (
          !isCorvin() &&
          swordReady &&
          now - lastGamingSword > GAMING_SWORD_EVERY &&
          sceneAllowed()
        ) {
          lastGamingSword = now;
          markScene();
          dbg("gaming sword move (7:00 + 10min cadence)");
          await demoSword();
        } else if (
          !isCorvin() &&
          now - lastGamingSpecial > 60 * 60 * 1000 &&
          Math.random() < 0.35
        ) {
          dbg("gaming special (hourly)");
          await gamingSpecial();
        } else if (now > nextGamingAmbience) {
          // Small flourishes keep their own loose ~1.5-3.5 min rhythm so the
          // 20 s cadence tick doesn't spam them.
          nextGamingAmbience = now + 90_000 + Math.random() * 120_000;
          if (isCorvin()) await huntwatchPass();
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
  }, 20_000);
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
    commitFor(PIZZA.msSeq!.reduce((a, b) => a + b, 0) * paceMul() + 400);
    curClip = PIZZA;
    frameIdx = 0;
    showBubble("Finally.", PRIO.NOTABLE);
    afterClip = () => playIdleCycle();
    return;
  }
  curUrge = pickIdle(life, lastIdleClip);
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
          curClip = WAKEUP;
          frameIdx = 0;
          afterClip = () => playIdleCycle();
        }
      : playIdleCycle;
  holdStill(idleClip(curUrge.clip), lo + Math.random() * (hi - lo), next);
}

function playWalk(leaving = false) {
  cancelAnimationFrame(winTween); // walking overrides any sit/stand tween
  // Corvin walks in with the sword over the shoulder and OUT with it slung
  // across his back, the way knights carry it home.
  curClip = isCorvin() ? ((leaving ? CORVIN.walkout : CORVIN.walkin) as Clip) : WALK;
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
    } else if (gagActive) {
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
  // A committed one-shot (pizza, sword care, laugh) FINISHES: ambient work
  // chatter updates the accent but must not yank the clip mid-bite.
  if (committed() && state !== "success" && state !== "error") {
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
  // (Dante only — Corvin's pack answers every state through ANIMS.)
  if (!isCorvin() && (state === "coding" || state === "searching" || state === "speaking")) {
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
  // Ambient chatter: usually skipped entirely, and always silent. Decide
  // BEFORE touching the hide timer — a bailing ambient call used to clear the
  // previous bubble's hide timeout and leave it stuck on screen forever.
  if (text && prio === PRIO.AMBIENT) {
    // M2: a Stranger (week one) talks half as much — reserve is earned away.
    const chance =
      story.chapter() === "stranger" ? AMBIENT_BUBBLE_CHANCE / 2 : AMBIENT_BUBBLE_CHANCE;
    if (busyBurst() || Math.random() > chance) return;
  }
  if (bubbleTimer) clearTimeout(bubbleTimer);
  if (!text) {
    bubble.classList.add("hidden");
    return;
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
  maybeDailyRitual(); // the first activity of a new day gets its ceremony
  serviceMediaWish(); // and a queued media moment gets another chance
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
  // Corvin is SILENT (user-directed): no work chatter at all — his words live
  // in the stories only. Dante keeps his phrases.
  if (!gagActive && !showcasing && !isCorvin()) showBubble(e.phrase, PRIO.AMBIENT);
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
      if (!isCorvin()) showBubble("Come on, seriously?", PRIO.MAJOR);
      if (isCorvin()) void vigilScene(); // his breakdown is a knee and the eagle
      else diveGag(); // patience gone -> full breakdown
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
      // Unchained is Steam-only (user-directed) — a level-up gets the aura.
      if (isCorvin()) void auraScene();
      else devilTriggerScene();
      // M2 level chapters: levels unlock existing content, told as story.
      if (lastLevel >= 5 && story.unlock("sword_win_pool"))
        window.setTimeout(() => showBubble("Level 5. The sword comes out now.", PRIO.NOTABLE), 4000);
      if (lastLevel >= 10 && story.first("lv10"))
        window.setTimeout(() => showBubble("Double digits. Just warming up.", PRIO.NOTABLE), 4000);
    } else if (crossedMilestone && sceneAllowed() && sceneBudgetOk("dance")) {
      winStreak = 0;
      markScene();
      budgetScene("dance");
      if (isCorvin()) void nuzzleScene(); // 25★ -> the eagle's rare approval
      else danceScene(); // 25★ milestone -> dance
    } else if (winStreak >= 3 && sceneAllowed() && sceneBudgetOk("jackpot")) {
      winStreak = 0;
      markScene();
      budgetScene("jackpot");
      story.today().jackpots += 1;
      if (isCorvin()) void executionScene(); // on a roll -> the Execution
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
  // Corvin never takes the seated window height: his seated clips (sit,
  // whetstone, guitar, meditate) are bottom-anchored scene poses, and Dante's
  // sit-down transition clip must never play on him.
  const seated = !isCorvin() && SEATED.has(state);
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
    if (isCorvin()) {
      // The sentinel arrives his own way: a knightly bow, then the watch.
      curClip = CORVIN.bow as Clip;
      frameIdx = 0;
      await sleep(corvinClipTotal(CORVIN.bow));
      setState("idle");
    } else {
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
      // the arrival stumble (user-directed): a quick stagger sells the stop
      curClip = ANIMS_DANTE.error;
      frameIdx = 0;
      await sleep(ANIMS_DANTE.error.frames.length * ANIMS_DANTE.error.ms + 120);
      // then sit DOWN onto the panel (stand->sit) while the window lowers
      curClip = SITDOWN;
      frameIdx = 0;
      posture("idle", true); // drop the window to the seated height
      await sleep(SITDOWN.frames.length * SITDOWN.ms);
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
    curClip = isCorvin() ? (CORVIN.windidle as Clip) : STAND_CROSS;
    frameIdx = 0;
    if (!isCorvin()) showBubble(pickLine(LEAVE_LINES), PRIO.MAJOR);
    await sleep(2400);
    if (!isCorvin()) {
      // the departure stumble (user-directed) — he shakes it off and goes
      curClip = ANIMS_DANTE.error;
      frameIdx = 0;
      await sleep(ANIMS_DANTE.error.frames.length * ANIMS_DANTE.error.ms + 120);
    }
    const offX = h.ox - h.winW - 8;
    stage.dataset.facing = "left";
    playWalk(true);
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
  scheduleMidnight(); // Corvin's 00:00 guitar + the MIDNIGHT arc
  scheduleDanteBeats(); // fixed clocks: spin 6m/20m, coin 3h, pizza 3.5h, shrug
  armCorvinClocks(); // and Corvin's: scan 6m, aura 8m, artsiv 10m, tale 12m, bow 20m
  initTts(); // system voices for the storyteller (ru + en)

  // Character pack: ~/.echo/character decides who walks in (default Dante).
  try {
    const c = await invoke<string>("character_load");
    if (c === "corvin") character = "corvin";
  } catch {
    /* dante */
  }
  applyCharacter();

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
else main();
