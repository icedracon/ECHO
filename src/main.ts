import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { Life } from "./life";
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
const MIN_HOLD: Record<string, number> = { thinking: 2200, speaking: 1200 };
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
// Scene clips hold their final pose (settle=8) so the gag orchestrator controls
// every transition — no flicker back to idle mid-sequence.
// Error gag: falls, then climbs back up. Slower ms so both read clearly.
const FALLING = clip("falling", 110, true, 8);
const CLIMB = clip("climb", 120, true, 8);
// Success "Jackpot" gun-shoot.
const SHOOT = clip("shoot", 95, true, 8);
// Stand -> sit transition (on arrival), the standing "stand tall" arrival beat,
// and an occasional seated laugh.
const SITDOWN = clip("sitpanel", 190, false);
const STAND_CROSS = clip("sit", 200, false); // standing, arms crossed
const LAUGH = clip("laugh", 130, false);
// Star-milestone celebration: a standing dance (loops for the scene's duration).
const DANCE = clip("dance", 110, true, 0);
// Signature beats: Devil-Trigger power pose (level up), gun-spin + taunt
// (Jackpot follow-through). Check-watch joins the idle rotation below.
const DEVIL = clip("devil", 90, true, 8);
const GUNSPIN = clip("gunspin", 85, true, 8);
const TAUNT = clip("taunt", 100, true, 8);
// Light win/error reactions (every event) — a quick visible pose.
const CHEER = clip("cheer", 90, true, 8);
const STAGGER = clip("stagger", 85, true, 8);
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
].forEach((c) => c.frames.forEach((s) => (new Image().src = s)));

// Freeze on the last frame of `c` for `ms`, then run `next` (if still idle).
function holdStill(c: Clip, ms: number, next: () => void) {
  const last = c.frames[c.frames.length - 1];
  curClip = { frames: [last], ms: 600, loop: true, settle: 0 };
  frameIdx = 0;
  afterClip = null;
  window.setTimeout(() => {
    if (stage.dataset.state === "idle" && !gagActive && !showcasing) next();
  }, ms);
}

let curUrge: IdleUrge | null = null;
let idlePlaysLeft = 0;
let lastIdleClip: string | null = null;

function playIdleCycle() {
  curUrge = pickIdle(life, lastIdleClip);
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
  holdStill(idleClip(curUrge.clip), lo + Math.random() * (hi - lo), playIdleCycle);
}

function playWalk() {
  cancelAnimationFrame(winTween); // walking overrides any sit/stand tween
  curClip = WALK;
  frameIdx = 0;
}

let curClip: Clip = ANIMS.idle;
let frameIdx = 0;
function frameLoop() {
  sprite.src = curClip.frames[frameIdx];
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
  window.setTimeout(frameLoop, curClip.ms);
}

let idleTimer: number | undefined;
let bubbleTimer: number | undefined;

// Work poses rotate so a long coding run isn't one clip looping forever.
const WORK_POSES = ["gunspin", "sit", "taunt"];
let workIdx = 0;

function setState(state: State) {
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
    const name = WORK_POSES[workIdx];
    curClip = clip(name, name === "gunspin" ? 90 : 200, true, name === "gunspin" ? 0 : 8);
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
    if (busyBurst() || Math.random() > AMBIENT_BUBBLE_CHANCE) return;
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
  // Don't let the idle fallback clobber a running scene (showcase / gag).
  idleTimer = window.setTimeout(() => {
    if (!showcasing && !gagActive) setState("idle");
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

// Bridge: smoothly rise to standing, hold a beat, then the scene runs.
// Every scene that starts from idle goes through this — no instant jumps.
async function standUp(): Promise<void> {
  if (!home) return;
  cancelAnimationFrame(winTween);
  delete stage.dataset.facing;
  afterClip = null;
  moveWindowY(home.y, 350);
  await sleep(380);
}

// Light win: stand up, quick arms-up cheer, a smirk. VISIBLE on every win.
async function lightWin() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
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
let lastActivity = Date.now();
let away = false;
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
  showBubble(e.phrase, PRIO.AMBIENT);
  dbg(
    `event=${e.state} lvlUp=${leveledUp} milestone=${crossedMilestone} home=${!!home} gag=${gagActive} show=${showcasing} away=${away} winStreak=${winStreak} errStreak=${errStreak}`,
  );
  if (gagActive || showcasing || returning) return; // a scene owns the sprite + window
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
    // Frustration comes from the Life vector now: low patience -> he snaps sooner.
    const snap = life.v.patience < 0.35 ? 2 : 3;
    if (errStreak >= snap && sceneAllowed() && sceneBudgetOk("breakdown")) {
      errStreak = 0;
      markScene();
      budgetScene("breakdown");
      showBubble("Come on, seriously?", PRIO.MAJOR);
      diveGag(); // patience gone -> full breakdown
    } else {
      lightError(); // shrug it off
    }
    scheduleIdle();
    return;
  }
  if (e.state === "success" && home) {
    winStreak += 1;
    errStreak = 0;
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
    } else if (crossedMilestone && sceneAllowed() && sceneBudgetOk("dance")) {
      winStreak = 0;
      markScene();
      budgetScene("dance");
      danceScene(); // 25★ milestone -> dance
    } else if (winStreak >= 3 && sceneAllowed() && sceneBudgetOk("jackpot")) {
      winStreak = 0;
      markScene();
      budgetScene("jackpot");
      shootScene(); // on a roll -> Jackpot
    } else {
      lightWin(); // small win -> light beat
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

function posture(state: string) {
  if (!home) return;
  const seated = SEATED.has(state);
  // Lower slowly while the sit-down clip plays; stand up snappily.
  moveWindowY(seated ? home.sitY : home.y, seated ? 900 : 400);
}

// Slide the OS window from its current X to toX at a walking pace (px/sec),
// so the speed is realistic regardless of distance.
function slideWindow(toX: number, pace = 150): Promise<void> {
  if (!home) return Promise.resolve();
  const h = home;
  const fromX = h.lastX;
  const dur = Math.max(500, (Math.abs(toX - fromX) / pace) * 1000);
  const t0 = performance.now();
  return new Promise<void>((resolve) => {
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const x = Math.round(fromX + (toX - fromX) * e);
      h.win.setPosition(new PhysicalPosition(x, h.y));
      h.lastX = x;
      h.lastY = h.y; // walking happens standing
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

// Entrance: walk in from off-screen left to the corner, then rest.
async function runIntro() {
  if (!isTauri) return;
  try {
    const win = getCurrentWindow();
    const mon = (await currentMonitor()) ?? (await primaryMonitor());
    if (!mon) return;
    const sf = mon.scaleFactor || 1;
    const ox = mon.position.x;
    const oy = mon.position.y;
    const sw = mon.size.width;
    const sh = mon.size.height;
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
    home = { win, ox, winW, y, sitY, belowY, cornerX, lastX: startX, lastY: y };
    dbg(`intro home set mon=${sw}x${sh} y=${y} sitY=${sitY} corner=${cornerX}`);
    await win.setPosition(new PhysicalPosition(startX, y));
    stage.dataset.facing = "right";
    playWalk(); // side-view walk cycle while moving
    await slideWindow(cornerX, 150); // realistic walking pace (px/sec)
    delete stage.dataset.facing;
    // deceleration beat — he's stopped walking, takes a breath
    await sleep(400);
    // arrival beat: stand tall, arms crossed, size up the room (2.5s)
    curClip = STAND_CROSS;
    frameIdx = 0;
    await sleep(STAND_CROSS.frames.length * STAND_CROSS.ms + 700);
    // then sit DOWN onto the panel (stand->sit) while the window lowers
    curClip = SITDOWN;
    frameIdx = 0;
    posture("idle"); // drop the window to the seated height
    await sleep(SITDOWN.frames.length * SITDOWN.ms);
    setState("idle"); // seated leg-swing loop
    // Discovery > demonstration. No auto-showcase — let users find everything
    // naturally. Set localStorage "echo.forceReel"=1 + reload for debug.
    dbg("intro done -> natural (discovery > demonstration)");
  } catch (err) {
    dbg(`intro ERROR: ${err}`);
    console.error("intro failed", err);
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
    posture("idle");
    await sleep(SITDOWN.frames.length * SITDOWN.ms);
    setState("idle");
    showBubble(pickLine(RETURN_LINES), PRIO.MAJOR);
  } finally {
    returning = false;
  }
}

// Occasional idle micro-beat: while seated he laughs, then back to swinging legs.
function laughBeat() {
  if (!home || gagActive || wandering) return;
  if (stage.dataset.state !== "idle") return;
  curClip = LAUGH; // one-shot -> frameLoop falls back to idle (leg-swing)
  frameIdx = 0;
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
async function shootScene() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    // smooth bridge: stand up, then draw
    await standUp();
    // anticipation — draw and hold a beat (the calm before)
    curClip = SHOOT;
    frameIdx = 0;
    await sleep(420);
    // FIRE — muzzle flash held (slow-mo), gunshot + screen-shake, "Jackpot!"
    showBubble("Jackpot!", PRIO.AMBIENT); // shown quietly; its own voice fires below
    say("jackpot"); // ~/.echo/voice/jackpot.wav overrides the blip
    stage.classList.add("shooting");
    sfxGunshot();
    shake(380);
    await sleep(800); // hold the moment — let the single shot land
    stage.classList.remove("shooting");
    // follow-through: spin the gun, or turn and taunt the user (4th wall)
    if (Math.random() < 0.5) {
      curClip = GUNSPIN;
      frameIdx = 0;
      await sleep(GUNSPIN.frames.length * GUNSPIN.ms);
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

// Milestone celebration: stand up and dance a couple of loops, then sit.
async function danceScene() {
  if (!home || gagActive) return;
  gagActive = true;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    // smooth bridge: stand up, then dance
    await standUp();
    curClip = DANCE;
    frameIdx = 0;
    showBubble("Too easy.", PRIO.MAJOR);
    const loop = DANCE.frames.length * DANCE.ms;
    // one beat-shake at the start, then let the dance speak for itself
    shake(250);
    await sleep(loop * 3); // three full dance loops
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
    curClip = DEVIL;
    frameIdx = 0;
    levelUpFlash(); // red sprite glow + vignette + aura + shake
    showBubble(`Lv.${lastLevel} — Devil Trigger!`, PRIO.MAJOR);
    await sleep(1900);
  } finally {
    gagActive = false;
    setState("idle");
  }
}

async function main() {
  // Click-through overlay: mouse passes to the desktop, no one can grab Dante.
  if (isTauri) {
    getCurrentWindow()
      .setIgnoreCursorEvents(true)
      .catch((e) => console.error("ignoreCursorEvents failed", e));
  }

  void initVoiceFiles(); // pick up any ~/.echo/voice/*.wav the user dropped in

  try {
    applyEvent(await invoke<AgentEvent>("get_state"));
  } catch (err) {
    console.error("get_state failed", err);
  }

  await listen<AgentEvent>("agent-event", (evt) => applyEvent(evt.payload));

  // Presence loop: if there's been no AI activity for AWAY_AFTER_MS while he's
  // idle, he leaves. The next agent-event (applyEvent) walks him back in.
  window.setInterval(() => {
    if (away || returning || wandering || gagActive || showcasing) return;
    if (stage.dataset.state !== "idle") return;
    if (Date.now() - lastActivity > AWAY_AFTER_MS) leaveScene();
  }, 30000);

  // v2 P1: the Life Model heartbeat — decay the vector, accumulate idle boredom,
  // and log the state so its evolution is auditable in ~/.echo/echo.log.
  let lifeLoggedAt = 0;
  window.setInterval(() => {
    life.tick();
    if (stage.dataset.state === "idle" && !gagActive && !showcasing) life.idleFor(5000);
    if (Date.now() - lifeLoggedAt > 20000) {
      lifeLoggedAt = Date.now();
      dbg(`life ${life.summary()}`);
    }
  }, 5000);
  frameLoop();
  runIntro();
  scheduleIdle();
}

main();
