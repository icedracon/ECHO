import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

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
const MIN_HOLD: Record<string, number> = { thinking: 1100, speaking: 750 };
const isTauri = "__TAURI_INTERNALS__" in window;

const stage = document.getElementById("stage") as HTMLElement;
const sprite = document.getElementById("sprite") as HTMLImageElement;
const bubble = document.getElementById("bubble") as HTMLElement;
const starsEl = document.getElementById("stars") as HTMLElement;
const levelEl = document.getElementById("level") as HTMLElement;

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
  // work states: stands, arms crossed, "on the job" (the old front-walk clip was removed)
  coding: clip("sit", 200, true, 8),
  searching: clip("sit", 220, true, 8),
  speaking: clip("sit", 240, true, 8),
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
// Idle = a calm seated rotation. Each pose does its little motion, then FREEZES
// and rests a while, then shifts to the next. Only the leg-swing actually loops.
interface IdleStep {
  clip: Clip;
  plays: number; // how many times to play the motion before resting
  hold: [number, number]; // then hold the final frame still for a random ms in range
}
const IDLE_SEQ: IdleStep[] = [
  { clip: clip("sitswing", 150, false), plays: 3, hold: [700, 1800] }, // swing legs a few times
  { clip: clip("sitcross", 200, false), plays: 1, hold: [7000, 12000] }, // arms crossed, rest
  { clip: clip("sitthink", 240, false), plays: 1, hold: [5000, 9000] }, // ponder, rest
];
const IDLE_CYCLE = IDLE_SEQ.map((s) => s.clip); // for preload + showcase demos
let idleIdx = 0;
let idlePlaysLeft = 0;
// When a one-shot clip ends, run this instead of the default idle fallback.
let afterClip: (() => void) | null = null;

// preload every frame
[...Object.values(ANIMS), ...IDLE_CYCLE, WALK, FALLING, CLIMB, SHOOT, SITDOWN, STAND_CROSS, LAUGH, DANCE].forEach(
  (c) => c.frames.forEach((s) => (new Image().src = s)),
);

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

function playIdleCycle() {
  const step = IDLE_SEQ[idleIdx];
  idlePlaysLeft = step.plays;
  curClip = step.clip;
  frameIdx = 0;
  afterClip = idleStepDone;
}

function idleStepDone() {
  idlePlaysLeft -= 1;
  if (idlePlaysLeft > 0) {
    // repeat the motion (e.g. keep swinging)
    curClip = IDLE_SEQ[idleIdx].clip;
    frameIdx = 0;
    afterClip = idleStepDone;
    return;
  }
  // done moving -> rest still, then shift to the next pose
  const step = IDLE_SEQ[idleIdx];
  const holdMs = step.hold[0] + Math.random() * (step.hold[1] - step.hold[0]);
  holdStill(step.clip, holdMs, () => {
    idleIdx = (idleIdx + 1) % IDLE_SEQ.length;
    playIdleCycle();
  });
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

function setState(state: State) {
  stage.dataset.state = state;
  document.documentElement.style.setProperty("--accent", ACCENT[state]);
  afterClip = null;
  if (state === "idle") {
    posture(state);
    playIdleCycle(); // rotate seated poses: swing -> arms crossed -> thinking
    return;
  }
  curClip = ANIMS[state] ?? ANIMS.idle;
  frameIdx = 0;
  posture(state); // sit on the panel for thinking, stand for the rest
}

function showBubble(text: string | null) {
  if (bubbleTimer) clearTimeout(bubbleTimer);
  if (!text) {
    bubble.classList.add("hidden");
    return;
  }
  bubble.textContent = text;
  bubble.classList.remove("hidden");
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
  window.setTimeout(() => stage.classList.remove("leveling"), 1300);
}

let stateShownAt = 0;
let pendingEv: AgentEvent | null = null;
let pendingTimer: number | undefined;
let prevStars = -1;
const STAR_MILESTONE = 25;

// Presence: after AWAY_AFTER_MS of no AI activity he wanders off; the next real
// event brings him back. lastActivity is refreshed on every agent-event.
const AWAY_AFTER_MS = 10 * 60 * 1000; // 10 min of silence -> he leaves
let lastActivity = Date.now();
let away = false;
let returning = false;
const LEAVE_LINES = ["Тишина… я на перекур.", "Зови, если что.", "Скучно. Пойду разомнусь."];
const RETURN_LINES = ["Ну, погнали.", "Я вернулся.", "Начнём работать."];
const pickLine = (a: string[]) => a[Math.floor(Math.random() * a.length)];

function applyEvent(e: AgentEvent) {
  lastActivity = Date.now(); // any event means the AI is active
  // HUD + bubble are always live, even while a state is being held.
  starsEl.textContent = `★ ${e.stars}`;
  levelEl.textContent = `Lv.${e.level}`;
  if (e.level > lastLevel) levelUpFlash();
  lastLevel = e.level;
  // Crossed a 25-star mark this event? (first event just seeds prevStars.)
  const crossedMilestone =
    prevStars >= 0 &&
    Math.floor(e.stars / STAR_MILESTONE) > Math.floor(prevStars / STAR_MILESTONE);
  prevStars = e.stars;
  showBubble(e.phrase);
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
  if (e.state === "error" && home) {
    diveGag();
    scheduleIdle();
    return;
  }
  if (e.state === "success" && home) {
    if (crossedMilestone) danceScene();
    else shootScene(); // Jackpot
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

    const taskbar = Math.round(48 * sf);
    // feet are flush at the sprite bottom -> lift so they land on the panel top
    const y = oy + sh - winH - Math.round(taskbar * 0.52);
    const startX = ox - winW - 8; // fully off-screen left
    const cornerX = ox + sw - winW - Math.round(12 * sf); // by the clock

    // Dropped so his seat lands on the panel top edge and the dangling legs
    // hang down over the taskbar. Nudge in ~0.04·winH steps if off.
    const sitY = y + Math.round(winH * 0.34);
    // A small visible dip for the error fall — he stays fully on-screen so the
    // falling + climb animations are unmissable (no dropping off the bottom).
    const belowY = y + Math.round(winH * 0.3);
    home = { win, ox, winW, y, sitY, belowY, cornerX, lastX: startX, lastY: y };
    await win.setPosition(new PhysicalPosition(startX, y));
    stage.dataset.facing = "right";
    playWalk(); // side-view walk cycle while moving
    await slideWindow(cornerX, 150); // realistic walking pace (px/sec)
    delete stage.dataset.facing;
    // arrival beat: stand tall, arms crossed, size up the room
    curClip = STAND_CROSS;
    frameIdx = 0;
    await sleep(STAND_CROSS.frames.length * STAND_CROSS.ms);
    // then sit DOWN onto the panel (stand->sit) while the window lowers
    curClip = SITDOWN;
    frameIdx = 0;
    posture("idle"); // drop the window to the seated height
    await sleep(SITDOWN.frames.length * SITDOWN.ms);
    setState("idle"); // seated leg-swing loop
    showcase(); // play every beat once so they're all visible on launch
  } catch (err) {
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
    showBubble(pickLine(LEAVE_LINES));
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
    curClip = SITDOWN; // sit down onto the panel
    frameIdx = 0;
    posture("idle");
    await sleep(SITDOWN.frames.length * SITDOWN.ms);
    setState("idle");
    showBubble(pickLine(RETURN_LINES));
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
  cancelAnimationFrame(winTween);
  const h = home;
  try {
    stage.dataset.state = "error";
    document.documentElement.style.setProperty("--accent", ACCENT.error);
    delete stage.dataset.facing;
    // 1) fall — flails in place, dips down a little (stays FULLY on-screen)
    await new Promise<void>((res) => (moveWindowY(h.y, 200), window.setTimeout(res, 210)));
    curClip = FALLING;
    frameIdx = 0;
    showBubble("Опа, падаю!");
    await sleep(700); // flail, fully visible
    await new Promise<void>((res) => (moveWindowY(h.belowY, 700), window.setTimeout(res, 720)));
    await sleep(500);
    // 2) climb back up (facing left), rises back to standing — fully visible
    stage.dataset.facing = "left";
    curClip = CLIMB;
    frameIdx = 0;
    showBubble("…лезу обратно.");
    await sleep(600); // grab + start pulling, visible
    await new Promise<void>((res) => (moveWindowY(h.y, 1200), window.setTimeout(res, 1220)));
    delete stage.dataset.facing;
    showBubble("…я ничего не видел.");
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
  cancelAnimationFrame(winTween);
  const h = home;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    delete stage.dataset.facing;
    await new Promise<void>((res) => (moveWindowY(h.y, 200), window.setTimeout(res, 210)));
    curClip = SHOOT;
    frameIdx = 0;
    showBubble("Jackpot!");
    const dur = SHOOT.frames.length * SHOOT.ms;
    window.setTimeout(() => stage.classList.add("shooting"), Math.round(dur * 0.4));
    window.setTimeout(() => stage.classList.remove("shooting"), Math.round(dur * 0.85));
    await sleep(dur);
  } finally {
    stage.classList.remove("shooting");
    gagActive = false;
    setState("idle");
    // satisfied laugh after a win (event-driven, not on a timer)
    if (Math.random() < 0.5) window.setTimeout(laughBeat, 500);
  }
}

// One-time reel right after he walks in: play every beat once so you can see
// them all (thinking, laugh, Jackpot, dive+climb, dance) without waiting for the
// exact session conditions. Real events are ignored until it finishes.
async function showcase() {
  if (!home) return;
  showcasing = true;
  if (idleTimer) clearTimeout(idleTimer); // no idle fallback mid-reel
  const h = home;
  // Hold one clip on a loop for `ms`, with a caption, so frameLoop can't hijack it.
  const demo = async (c: Clip, label: string, ms: number, seated: boolean) => {
    showBubble(label);
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
    await demo(IDLE_CYCLE[0], "сижу", 1700, true); // legs swinging
    await demo(IDLE_CYCLE[1], "руки крест", 1900, true); // arms crossed
    await demo(IDLE_CYCLE[2], "думаю", 2300, true); // thinking
    await demo(LAUGH, "ха-ха", 1500, true); // laugh
    // standing work
    await demo(ANIMS.coding, "кодинг", 2000, false); // front work loop
    await demo(WALK, "иду", 1600, false); // side walk cycle
    afterClip = null;
    // scenes — kept INSIDE the showcasing guard so a live event can't grab
    // gagActive and make a scene early-return (that was skipping the fall/climb).
    await shootScene(); // Jackpot
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
  cancelAnimationFrame(winTween);
  const h = home;
  try {
    stage.dataset.state = "success";
    document.documentElement.style.setProperty("--accent", ACCENT.success);
    delete stage.dataset.facing;
    await new Promise<void>((res) => (moveWindowY(h.y, 200), window.setTimeout(res, 210)));
    curClip = DANCE;
    frameIdx = 0;
    showBubble("Too easy.");
    await sleep(DANCE.frames.length * DANCE.ms * 3); // three full dance loops
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
  frameLoop();
  runIntro();
  scheduleIdle();
}

main();
