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

const URGES: UrgeDef[] = [
  { clip: "sitswing", plays: 3, hold: [700, 1800], weight: () => 30 },
  { clip: "sitcross", plays: 1, hold: [7000, 12000], weight: (l) => 14 + l.v.focus * 10 },
  { clip: "sitthink", plays: 1, hold: [5000, 9000], weight: (l) => 10 + l.v.focus * 8 },
  {
    clip: "checkwatch",
    plays: 1,
    hold: [4000, 7000],
    weight: (l) => 6 + l.v.boredom * 16 + (1 - l.v.patience) * 10,
  },
  { clip: "yawn", plays: 1, hold: [4000, 8000], weight: (l) => 3 + (1 - l.v.energy) * 22 },
  { clip: "leanback", plays: 1, hold: [6000, 12000], weight: (l) => 8 + l.v.confidence * 10 },
  { clip: "nap", plays: 1, hold: [9000, 16000], weight: (l) => (1 - l.v.energy) * 26 * napGate(l) },
];

// Naps only really happen when he's genuinely low / it's night.
function napGate(l: Life): number {
  const hr = new Date().getHours();
  const night = hr >= 1 && hr < 6 ? 1.6 : hr >= 22 ? 1.2 : 0.4;
  return l.v.energy < 0.4 ? night : 0.15;
}

/** Pick the next idle urge — weighted by mood, never repeating `lastClip`. */
export function pickIdle(life: Life, lastClip: string | null): IdleUrge {
  const pool = URGES.filter((u) => u.clip !== lastClip);
  const list = pool.length ? pool : URGES;
  const weights = list.map((u) => Math.max(0.01, u.weight(life)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
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
