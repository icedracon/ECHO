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
    lastNightWatchAt?: number; // 00:40 blanket/cairn watch — once per night
    lastBreakdownAt?: number; // the 01:00 / 13:00 breakdown
    lastLetterAt?: number; // the letter — once a week at most
    lastCairnAt?: number; // the cairn — once a month
    lastBinCairnAt?: number; // recycle-bin memorial, independent from the story cairn
    lastBreachAt?: number; // the Breach — the big fight
    lastRequiemAt?: number; // the 23:40 requiem — the whole grief line
    lastDoorAt?: number; // the Door fight — the monitor-edge boss scene
    lastHourSlot?: string; // legacy single-slot marker, migrated on load
    lastHourSlots?: Record<string, number>; // character/date/hour -> played at
  };
  unlocks: string[];
  // Corvin the storyteller: per-arc fragment pointers — he NEVER repeats
  // himself and picks up each arc where he left off (DESIGN §12c).
  tales?: { ptr: Record<string, number>; lastArc?: string; lastAt?: number };
  // The 100-chapter novel (novel.ts): strictly sequential, told after long
  // typing sessions. Restarts from chapter 1 when the book ends.
  novel?: { ch: number; lastAt?: number };
  // Daily ritual: the dateKey of the last day he greeted you (once per day).
  lastRitualDay?: string;
  // The director's learned weights and per-action cooldown history.
  director?: { weights: Record<string, number>; lastPlayed: Record<string, number> };
  danteDirector?: { weights: Record<string, number>; lastPlayed: Record<string, number> };
  kaelDirector?: { weights: Record<string, number>; lastPlayed: Record<string, number> };
  // Active Kael screen-time only. Closing ECHO or selecting another companion
  // pauses the reel instead of resetting it or creating a wall-clock backlog.
  kaelHardPlan?: { cursor: number; elapsedMs: number };
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
    // There is no clean shutdown hook, so a truncated/hand-edited story.json
    // must not brick the pipeline: repair every field whose shape we rely on.
    // The repair itself must never throw either — this runs before the event
    // listeners, the presence loop and the frame loop are installed, so an
    // exception here leaves a dead transparent window with nothing logged.
    try {
      const s = this.s as unknown as Record<string, unknown>;
      const obj = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
      if (!Array.isArray(this.s.firsts)) this.s.firsts = [];
      if (!Array.isArray(this.s.unlocks)) this.s.unlocks = [];
      if (!obj(s.days)) this.s.days = {};
      if (!obj(s.gags)) this.s.gags = fresh().gags;
      const hourSlots = obj(this.s.gags.lastHourSlots)
        ? this.s.gags.lastHourSlots as Record<string, number>
        : {};
      this.s.gags.lastHourSlots = hourSlots;
      if (this.s.gags.lastHourSlot) {
        hourSlots[this.s.gags.lastHourSlot] ??= Date.now();
      }
      for (const [key, value] of Object.entries(hourSlots)) {
        if (!Number.isFinite(value) || Date.now() - value > 14 * 86_400_000)
          delete hourSlots[key];
      }
      if (!Number.isFinite(this.s.totalMinutes) || this.s.totalMinutes < 0)
        this.s.totalMinutes = 0;
      // `novel`/`tales` were repaired by ASSIGNING INTO them — on a string or a
      // number that is a TypeError in strict mode, thrown outside the catch
      // above. Check the container before touching it.
      if (s.novel !== undefined && !obj(s.novel)) delete s.novel;
      if (this.s.novel) {
        const ch = Number(this.s.novel.ch);
        this.s.novel.ch = Number.isInteger(ch) && ch >= 0 ? ch : 0;
      }
      if (s.tales !== undefined && !obj(s.tales)) delete s.tales;
      if (this.s.tales) {
        if (!obj(this.s.tales.ptr)) this.s.tales.ptr = {};
        // A NaN/string pointer silently drops an arc forever (the `< length`
        // comparison is false) and indexes fragments[NaN] in the midnight arc.
        for (const [id, v] of Object.entries(this.s.tales.ptr)) {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0) this.s.tales.ptr[id] = 0;
        }
      }
      // The three Directors are spread straight into their state; a null
      // `weights` makes Director.pick throw inside a setTimeout chain, which
      // kills the idle/urge loop for the rest of the session.
      for (const key of ["director", "danteDirector", "kaelDirector"] as const) {
        const d = this.s[key];
        if (d === undefined) continue;
        if (!obj(d) || !obj(d.weights) || !obj(d.lastPlayed)) delete this.s[key];
      }
      if (s.kaelHardPlan !== undefined) {
        const plan = s.kaelHardPlan;
        if (!obj(plan)) delete s.kaelHardPlan;
        else {
          const p = plan as { cursor?: unknown; elapsedMs?: unknown };
          const cursor = Number(p.cursor);
          const elapsedMs = Number(p.elapsedMs);
          if (!Number.isInteger(cursor) || cursor < 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0)
            delete s.kaelHardPlan;
          else this.s.kaelHardPlan = { cursor, elapsedMs };
        }
      }
      // `days` is keyed by date and nothing ever pruned it, so it grew forever
      // and was re-serialised on every one of the ~1500 saves a day. Only
      // today and yesterday are read; keep a fortnight for future use and
      // drop the rest, which bounds the file and the corruption window.
      const keepDays = new Set(
        Array.from({ length: 14 }, (_, i) => dateKey(Date.now() - i * 86_400_000)),
      );
      for (const d of Object.keys(this.s.days)) if (!keepDays.has(d)) delete this.s.days[d];
      if (!this.s.installedAt) this.s.installedAt = Date.now();
    } catch {
      this.s = fresh();
    }
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
