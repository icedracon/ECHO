// ECHO's Decision Planner — reads the Life vector and decides what he does.
// Pure logic: it never touches the DOM/window. main.ts executes what this returns.
// This is the layer that makes the same situation produce different results.

import type { Life } from "./life";

// ---- Idle: weighted urge, never the same as last -----------------------------
// All seated (the panel perch). Weight is a base + modifiers from his mood, so a
// bored/sleepy/cocky Dante idles differently. `hold` = how long to rest after.
export interface IdleUrge {
  clip: string;
  plays: number;
  hold: [number, number];
}

interface UrgeDef extends IdleUrge {
  weight: (l: Life) => number;
}

// РАВНОВЕРОЯТНО (user-directed). Раньше веса были разными, и пять движений
// забирали 69% выборов: sitswing 19.8%, sitcross 16.3%, checkwatch 12%,
// leanback 11.3%, sitthink 9.9% — а хвост вроде nap (0.8%) или cleansword
// (2.5%) не показывался почти никогда.
//
// Уместность по времени и состоянию теперь держит РАСПИСАНИЕ: у каждого из 43
// движений свой слот в часовых корзинах. Холостая лотерея работает только в
// паузах между битами, и там правильнее равный шанс, чем скрытая иерархия.
//
// Два исключения оставлены, потому что это не предпочтение, а смысл:
// napGate (спать только ночью) и coffeeGate (кофе только днём).
const URGES: UrgeDef[] = [
  // Calm poses settle in for a real while (up to ~60 s) instead of shifting fast.
  { clip: "sitswing", plays: 3, hold: [18000, 50000], weight: () => 10 }, // shake legs, then rest
  { clip: "sitcross", plays: 1, hold: [35000, 75000], weight: () => 10 }, // arms crossed
  { clip: "sitthink", plays: 1, hold: [15000, 40000], weight: () => 10 },
  { clip: "leanback", plays: 1, hold: [35000, 70000], weight: () => 10 },
  // Livelier, shorter beats:
  { clip: "laugh", plays: 1, hold: [8000, 18000], weight: () => 10 }, // chuckles to himself
  {
    clip: "checkwatch",
    plays: 1,
    hold: [8000, 15000],
    weight: () => 10,
  },
  { clip: "yawn", plays: 1, hold: [10000, 22000], weight: () => 10 },
  { clip: "nap", plays: 1, hold: [40000, 90000], weight: (l) => 10 * napGate(l) },
  // M3 batch: stretch when stiff (long uptime, low energy), shrug when bored,
  // a curious head-tilt so subtle it earns "did he just move?".
  { clip: "stretch", plays: 1, hold: [6000, 14000], weight: () => 10 },
  { clip: "shrug", plays: 1, hold: [4000, 9000], weight: () => 10 },
  { clip: "headtilt", plays: 1, hold: [4000, 8000], weight: () => 10 },
  // M5: peers out past the screen edge when curiosity runs high.
  { clip: "lookout", plays: 1, hold: [5000, 10000], weight: () => 10 },
  // M5: quiet sword care in focused moments — rare, and Partner-chapter only
  // (gated in playIdleCycle; the planner doesn't know the story).
  { clip: "cleansword", plays: 1, hold: [6000, 12000], weight: () => 10 },
  // Dante polish batch (parity with Corvin's micro set) — seated micro-beats,
  // all anchored back to the seated pose so they slot into the rotation.
  { clip: "d_neckroll", plays: 1, hold: [8000, 16000], weight: () => 10 },
  { clip: "d_jacketflick", plays: 1, hold: [6000, 14000], weight: () => 10 },
  { clip: "d_fingerguns", plays: 1, hold: [6000, 12000], weight: () => 10 },
  { clip: "d_knuckles", plays: 1, hold: [6000, 14000], weight: () => 10 },
  { clip: "d_hairswipe", plays: 1, hold: [6000, 12000], weight: () => 10 },
  { clip: "d_sigh", plays: 1, hold: [8000, 18000], weight: () => 10 },
  { clip: "d_bootswing", plays: 2, hold: [8000, 18000], weight: () => 10 },
  { clip: "d_glanceover", plays: 1, hold: [6000, 12000], weight: () => 10 },
  { clip: "d_layback", plays: 1, hold: [30000, 60000], weight: () => 10 },
  { clip: "d_sitedge", plays: 1, hold: [20000, 45000], weight: () => 10 },
  // Daily life: an espresso through the working day, doomscrolling when bored.
  { clip: "d_coffee", plays: 1, hold: [10000, 20000], weight: () => coffeeGate() * 10 },
  { clip: "d_phone", plays: 1, hold: [15000, 30000], weight: () => 10 },
];

// Espresso belongs to the waking day — not at 3 a.m.
function coffeeGate(): number {
  const hr = new Date().getHours();
  return hr >= 10 && hr < 20 ? 1 : 0;
}

// Naps only really happen when he's genuinely low / it's night.
function napGate(l: Life): number {
  const hr = new Date().getHours();
  // hour 0 belongs to the night too — it used to fall into the 0.4 "day"
  // branch, suppressing naps exactly when energy bottoms out
  const night = hr >= 1 && hr < 6 ? 1.6 : hr >= 22 || hr === 0 ? 1.2 : 0.4;
  return l.v.energy < 0.4 ? night : 0.15;
}

/** Pick the next idle urge — weighted by mood, never repeating `lastClip`.
 *  `learned` is the director's reaction memory (story.json): poses you kept
 *  working through drift up, poses that made you grab the mouse drift down. */
export function pickIdle(
  life: Life,
  lastClip: string | null,
  learned?: Record<string, number>,
): IdleUrge {
  // Dante's generated d_* polish pack is owned by the hard living reel in
  // main.ts. Keeping it in this lottery made those clips fire both randomly
  // and on schedule, destroying the intended spacing.
  const randomUrges = URGES.filter((u) => !u.clip.startsWith("d_"));
  const pool = randomUrges.filter((u) => u.clip !== lastClip);
  const list = pool.length ? pool : randomUrges;
  const weights = list.map((u) =>
    Math.max(0.01, u.weight(life) * Math.min(2.5, Math.max(0.3, learned?.[u.clip] ?? 1))),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

export function dantePolishUrge(clip: string): IdleUrge | null {
  // The hard reel also reuses Dante's original seated library. Return its
  // authored repeats/hold contract for any known idle clip, not only d_*.
  const urge = URGES.find((candidate) => candidate.clip === clip);
  return urge ? { clip: urge.clip, plays: urge.plays, hold: urge.hold } : null;
}

// ---- Win magnitude: small wins ≠ big wins ------------------------------------
// `size` = a rough measure of the turn's work (event count / duration), 0..1+.
export type WinTier = "smile" | "smirk" | "cheer" | "jackpot";
export function winTier(size: number, life: Life): WinTier {
  const s = size + life.v.cockiness * 0.25; // cocky mood inflates the read a touch
  if (s >= 1.0) return "jackpot";
  if (s >= 0.55) return "cheer";
  if (s >= 0.25) return "smirk";
  return "smile";
}

// ---- Voice: per-line cooldown so a line never repeats close together ---------
const lineUsed = new Map<string, number>();
export function voiceLineOk(text: string, cooldownMs = 20 * 60_000): boolean {
  const t = lineUsed.get(text) ?? 0;
  return Date.now() - t >= cooldownMs;
}
export function markVoiceLine(text: string) {
  lineUsed.set(text, Date.now());
}

// ---- Big scenes: a daily budget so they stay memorable -----------------------
// e.g. only a couple of Devil Triggers a day. Resets at local midnight.
const sceneCount = new Map<string, number>();
let sceneDay = new Date().toDateString();
const DAILY_CAP: Record<string, number> = { jackpot: 8, dance: 4, breakdown: 6, devil: 3 };
function rollDay() {
  const d = new Date().toDateString();
  if (d !== sceneDay) {
    sceneDay = d;
    sceneCount.clear();
  }
}
export function sceneBudgetOk(kind: string): boolean {
  rollDay();
  const cap = DAILY_CAP[kind] ?? 99;
  return (sceneCount.get(kind) ?? 0) < cap;
}
export function markScene(kind: string) {
  rollDay();
  sceneCount.set(kind, (sceneCount.get(kind) ?? 0) + 1);
}
