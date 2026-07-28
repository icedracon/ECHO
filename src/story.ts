// M2 сюжет: the memory that makes him a companion instead of a reaction
// machine. Tenure, chapters of the relationship, day-by-day stats, firsts
// that can only ever happen once, and long gags that earn their payoffs.
// Persisted to ~/.echo/story.json via the backend (incremental writes — there
// is no clean shutdown hook).
import { invoke } from "@tauri-apps/api/core";

export interface DayStats {
  wins: number;
  errors: number;
  jackpots: number;
  stars: number;
}

interface StoryState {
  installedAt: number;
  totalMinutes: number;
  firsts: string[];
  days: Record<string, DayStats>;
  lastSeenDate: string;
  gags: {
    pizzaMentions: number;
    lastPizzaAt: number;
    lastPizzaPayoffAt?: number;
    lastSwordCareAt?: number;
  };
  unlocks: string[];
}

export const dateKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const fresh = (): StoryState => ({
  installedAt: Date.now(),
  totalMinutes: 0,
  firsts: [],
  days: {},
  lastSeenDate: "",
  gags: { pizzaMentions: 0, lastPizzaAt: 0 },
  unlocks: [],
});

export type Chapter = "stranger" | "colleague" | "partner";

export class Story {
  s: StoryState = fresh();

  async load(): Promise<void> {
    try {
      const raw = await invoke<string>("story_load");
      if (raw) this.s = { ...fresh(), ...JSON.parse(raw) };
    } catch {
      /* fresh story */
    }
    if (!this.s.installedAt) this.s.installedAt = Date.now();
  }

  save(): void {
    void invoke("story_save", { data: JSON.stringify(this.s) }).catch(() => {});
  }

  today(): DayStats {
    const d = dateKey();
    if (!this.s.days[d]) this.s.days[d] = { wins: 0, errors: 0, jackpots: 0, stars: 0 };
    return this.s.days[d];
  }

  yesterday(): DayStats | null {
    return this.s.days[dateKey(Date.now() - 86_400_000)] ?? null;
  }

  // The relationship arc: words and odds shift with tenure, mechanics never do.
  chapter(): Chapter {
    const h = this.s.totalMinutes / 60;
    return h < 20 ? "stranger" : h < 80 ? "colleague" : "partner";
  }

  // True exactly once per key, ever. Persisted immediately.
  first(key: string): boolean {
    if (this.s.firsts.includes(key)) return false;
    this.s.firsts.push(key);
    this.save();
    return true;
  }

  unlocked(key: string): boolean {
    return this.s.unlocks.includes(key);
  }

  unlock(key: string): boolean {
    if (this.unlocked(key)) return false;
    this.s.unlocks.push(key);
    this.save();
    return true;
  }

  // The pizza gag: at most one mention a week; the payoff animation (M5) is
  // gated on pizzaMentions >= 3 — it must be EARNED.
  pizzaLine(): string | null {
    const WEEK = 7 * 86_400_000;
    if (Date.now() - this.s.gags.lastPizzaAt < WEEK) return null;
    this.s.gags.lastPizzaAt = Date.now();
    this.s.gags.pizzaMentions += 1;
    this.save();
    const lines = [
      "Could murder a pizza.",
      "Still thinking about that pizza.",
      "One day. One pizza.",
    ];
    return lines[Math.min(lines.length - 1, this.s.gags.pizzaMentions - 1)];
  }
}
