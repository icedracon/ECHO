// M2 сюжет: the memory that makes him a companion instead of a reaction
// machine. Tenure, chapters of the relationship, day-by-day stats, firsts
// that can only ever happen once, and long gags that earn their payoffs.
// Persisted to ~/.echo/story.json via the backend (incremental writes — there
// is no clean shutdown hook).
import { invoke } from "@tauri-apps/api/core";
import { TALES } from "./tales";
import { NOVEL } from "./novel";

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
    lastNightSongAt?: number; // Corvin's 00:00 guitar — once per night
  };
  unlocks: string[];
  // Corvin the storyteller: per-arc fragment pointers — he NEVER repeats
  // himself and picks up each arc where he left off (DESIGN §12c).
  tales?: { ptr: Record<string, number>; lastArc?: string; lastAt?: number };
  // The 100-chapter novel (novel.ts): strictly sequential, told after long
  // typing sessions. Restarts from chapter 1 when the book ends.
  novel?: { ch: number; lastAt?: number };
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

  // Corvin's storyteller memory: pick the next untold fragment. Arcs rotate;
  // deep arcs (THE ARM, HARDSHIPS) stay locked until the chapter allows them.
  // Returning to an arc after 20h+ prepends its continuity opener.
  nextTale(): { lines: string[] } | null {
    if (!this.s.tales) this.s.tales = { ptr: {} };
    const t = this.s.tales;
    const rank = { stranger: 0, colleague: 1, partner: 2 } as const;
    const open = TALES.filter(
      (a) =>
        a.id !== "midnight" && // the night arc belongs to the midnight guitar only
        rank[a.minChapter] <= rank[this.chapter()] &&
        (t.ptr[a.id] ?? 0) < a.fragments.length,
    );
    if (!open.length) return null;
    // round-robin: least-told arc first, but never the same arc twice in a row
    open.sort((a, b) => (t.ptr[a.id] ?? 0) - (t.ptr[b.id] ?? 0));
    const arc = open.find((a) => a.id !== t.lastArc) ?? open[0];
    const idx = t.ptr[arc.id] ?? 0;
    const frag = arc.fragments[idx];
    const gap = Date.now() - (t.lastAt ?? 0);
    const lines =
      idx > 0 && arc.id !== t.lastArc && gap > 20 * 3_600_000
        ? [arc.opener, ...frag.lines]
        : [...frag.lines];
    t.ptr[arc.id] = idx + 1;
    t.lastArc = arc.id;
    t.lastAt = Date.now();
    this.save();
    return { lines };
  }

  // The Warden's novel: next chapter in strict order, looping after 100.
  nextNovelChapter(): { idx: number; title: string; lines: string[] } {
    if (!this.s.novel) this.s.novel = { ch: 0 };
    const n = this.s.novel;
    const idx = n.ch % NOVEL.length;
    n.ch = idx + 1;
    n.lastAt = Date.now();
    this.save();
    const c = NOVEL[idx];
    return { idx: idx + 1, title: c.title, lines: [...c.lines] };
  }

  // The midnight arc: one fragment per night, only after the 00:00 guitar.
  // When the arc runs dry it loops from the start — the ritual never ends.
  nextMidnightTale(): string[] {
    if (!this.s.tales) this.s.tales = { ptr: {} };
    const arc = TALES.find((a) => a.id === "midnight");
    if (!arc) return [];
    const t = this.s.tales;
    let idx = t.ptr["midnight"] ?? 0;
    if (idx >= arc.fragments.length) idx = 0; // the ritual loops
    t.ptr["midnight"] = idx + 1;
    this.save();
    return [...arc.fragments[idx].lines];
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
