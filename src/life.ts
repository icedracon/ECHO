// ECHO's Life Model — the evolving internal state that makes the same event
// produce different behaviour over hours and days.
//
// P1 scope: this module OWNS the state. It drifts, decays, is nudged by events,
// and persists across launches. Nothing here decides what Dante DOES — that's the
// planner (P2). Keeping them separate means a weird behaviour is either a bad
// STATE (visible in the log) or a bad DECISION, never a tangle of both.

export type Stat =
  | "energy"
  | "confidence"
  | "patience"
  | "focus"
  | "curiosity"
  | "cockiness"
  | "boredom";

const STATS: Stat[] = [
  "energy",
  "confidence",
  "patience",
  "focus",
  "curiosity",
  "cockiness",
  "boredom",
];

// Each stat drifts back toward a resting value at `decayPerMin`/minute.
const DECAY: Record<Stat, number> = {
  energy: 0.03,
  confidence: 0.05,
  patience: 0.09, // frustration fades fastest — he calms down
  focus: 0.07,
  curiosity: 0.05,
  cockiness: 0.04,
  boredom: 0.0, // boredom is driven by idle time + events, not decay
};

// Resting value, adjusted by time of day for a few stats.
function restingValue(stat: Stat, hour: number): number {
  if (stat === "energy") {
    if (hour >= 1 && hour < 6) return 0.22; // dead of night
    if (hour >= 22 || hour < 1) return 0.42; // late
    if (hour >= 6 && hour < 11) return 0.8; // morning
    return 0.65; // day/evening
  }
  const rest: Record<Stat, number> = {
    energy: 0.65,
    confidence: 0.6,
    patience: 0.72,
    focus: 0.4,
    curiosity: 0.4,
    cockiness: 0.42,
    boredom: 0.15,
  };
  return rest[stat];
}

const KEY = "echo.life.v1";

export class Life {
  v: Record<Stat, number>;
  private lastTick = Date.now();

  constructor() {
    this.v = this.load() ?? this.fresh();
  }

  private fresh(): Record<Stat, number> {
    const hr = new Date().getHours();
    return Object.fromEntries(STATS.map((s) => [s, restingValue(s, hr)])) as Record<Stat, number>;
  }

  private load(): Record<Stat, number> | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      // On return after a long absence, energy recovers (a break did him good).
      const gapMin = (Date.now() - (o._t ?? Date.now())) / 60000;
      const v = this.fresh();
      for (const s of STATS) if (typeof o[s] === "number") v[s] = clamp(o[s]);
      if (gapMin > 20) v.energy = clamp(v.energy + Math.min(0.4, gapMin / 240));
      v.boredom = 0; // fresh session, not bored yet
      return v;
    } catch {
      return null;
    }
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...this.v, _t: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  private nudge(stat: Stat, delta: number) {
    this.v[stat] = clamp(this.v[stat] + delta);
  }

  /** Decay every stat toward its (time-adjusted) resting value. Call periodically. */
  tick() {
    const now = Date.now();
    const dtMin = (now - this.lastTick) / 60000;
    this.lastTick = now;
    if (dtMin <= 0) return;
    const hr = new Date().getHours();
    for (const s of STATS) {
      const rest = restingValue(s, hr);
      const step = DECAY[s] * dtMin;
      if (this.v[s] > rest) this.v[s] = Math.max(rest, this.v[s] - step);
      else this.v[s] = Math.min(rest, this.v[s] + step);
    }
    this.save();
  }

  /** An AI event nudges the vector — the Behavior-Engine → Life-Model edge. */
  onEvent(state: string, size = 1) {
    this.nudge("boredom", -0.35); // any activity kills boredom
    const w = Math.min(2, 0.6 + size * 0.4); // bigger turns move him more
    switch (state) {
      case "success":
        this.nudge("confidence", 0.1 * w);
        this.nudge("cockiness", 0.09 * w);
        this.nudge("patience", 0.04);
        break;
      case "error":
        this.nudge("confidence", -0.09 * w);
        this.nudge("patience", -0.2 * w); // frustration
        this.nudge("cockiness", -0.07);
        break;
      case "coding":
        this.nudge("focus", 0.05);
        break;
      case "searching":
        this.nudge("curiosity", 0.08);
        break;
      case "thinking":
        this.nudge("focus", 0.03);
        break;
    }
    this.save();
  }

  /** Called while idle: boredom rises, energy slowly recovers. */
  idleFor(dtMs: number) {
    const m = dtMs / 60000;
    this.nudge("boredom", 0.14 * m);
    this.nudge("energy", 0.04 * m);
    this.nudge("focus", -0.05 * m);
  }

  /** A short human-readable mood label derived from the vector. */
  mood(): string {
    const { energy, patience, confidence, cockiness, boredom, focus } = this.v;
    if (energy < 0.3) return "sleepy";
    if (patience < 0.3) return "irritated";
    if (confidence > 0.72 && cockiness > 0.6) return "cocky";
    if (boredom > 0.6) return "restless";
    if (focus > 0.62) return "locked-in";
    if (confidence < 0.35) return "rattled";
    return "easy";
  }

  /** Compact one-line dump for echo.log so behaviour stays explainable. */
  summary(): string {
    const parts = STATS.map((s) => `${s.slice(0, 3)}=${this.v[s].toFixed(2)}`).join(" ");
    return `mood=${this.mood()} ${parts}`;
  }
}

function clamp(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
