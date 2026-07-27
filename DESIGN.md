# ECHO — Design Doc (v2 plan)

The source of truth. We build against this, not reactively. If behaviour and this
doc disagree, one of them is a bug — decide which and fix it.

---

## 1. What ECHO is

A desktop **companion**, not a widget. A pixel-art Dante (DMC) who lives on the
Windows taskbar and reacts, in character, to your AI coding session. He should
feel like someone working *alongside* you — present when you work, out of the way
when you're heads-down, gone when you leave.

**The one test that matters:** after using it for a full day, do you keep it open?
A companion that interrupts is a companion you close.

---

## 2. Design principles (non-negotiable)

1. **Attention is a budget.** Every reaction costs the user's focus. Spend it
   rarely and deliberately. Silence is the default; spectacle is earned.
2. **Event-driven, never timer-driven.** He reacts to *your* real work (AI logs),
   not to a clock. No "cronjob" behaviour. (Idle-away is measured from last
   activity, which is still event-driven.)
3. **One consistent Dante.** Every sprite is the same character, same render.
   Never mix art styles.
4. **No copyrighted assets in the repo.** No ripped game audio, no cloned actor
   voice. Original SFX, original-designed TTS voice. User's own files live in
   `~/.echo/` and are never committed.
5. **Legible while working.** The common states (coding/thinking) must read
   clearly and be visually distinct — 95% of what the user sees.

---

## 3. Architecture

- **Rust backend** (`src-tauri/src/`)
  - `watcher.rs` — tails AI log sources, classifies, emits `agent-event`, writes
    `~/.echo/echo.log`.
  - `events.rs` — JSONL line → state.
  - `store.rs` — persists stars.
  - `lib.rs` — commands: `get_state`, `idle_phrase`, `voice_clips`, `fe_log`.
- **Frontend** (`src/main.ts`, `styles.css`, `index.html`)
  - 2D pixel sprite player; each state → a 9-frame clip in `public/pixel/*`.
  - OS window is moved for walk-in / sit / scene choreography.
  - Camera FX (shake, vignette), synthesized SFX, voice (files + blip fallback),
    the attention budget.
- **Assets**: `public/pixel/<clip>/frame_0..8.png`. Voice clips: `~/.echo/voice/`.
- **Tooling**: `scripts/gen_voice.py` (ElevenLabs, reads `.env`).

### Sync sources
| Source | Path | Mode |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | parsed → rich states |
| Cursor | `%APPDATA%/Cursor/User/workspaceStorage` | activity pulse |
| Claude Desktop | `%APPDATA%/Claude` | activity pulse |
| ChatGPT / Gemini | — | web/PWA, not tailable (needs a browser extension) |

---

## 4. Behaviour spec

### States (from the AI log)
`idle · thinking · coding · searching · speaking · success · error`

### Tiers & the attention budget
| Tier | Examples | Bubble | Voice |
|---|---|---|---|
| **Ambient** | work chatter, idle lines, showcase captions | ~18% chance, suppressed during bursts | never |
| **Notable** | small win, small error | always | only if silent ≥ `VOICE_MIN_GAP` (60s) |
| **Major** | Jackpot, dance, breakdown, Devil Trigger, leave/return | always | always |

Guards: `busyBurst()` (> 12 events / 30s → stay quiet); `sceneAllowed()`
(≥ `SCENE_MIN_GAP` = 3 min between big scenes; if not allowed, degrade to a light
beat). Level-up always fires (genuinely rare).

### Idle (seated rotation, calm)
`sitswing` (swing legs 3×) → `sitcross` (hold 7–12 s) → `sitthink` (hold 5–9 s) →
`checkwatch` (hold 4–7 s) → repeat. Stillness between shifts is the point.

### Working (standing, distinct)
Rotates each state change: `gunspin` (coding) → `sit`/arms-crossed (searching) →
`taunt`/gesture (speaking). thinking = seated `sitthink` + a rare "Hmm."

### Scenes (event → rate-limited)
- success streak ×3 → **Jackpot** (`shoot` + gunshot + shake + slow-mo + voice)
- 25★ milestone → **dance**
- error streak ×3 → **fall + climb** breakdown
- level up → **Devil Trigger** (`devil` + red vignette + aura)

### Presence
No AI activity for 10 min → stand, arms crossed, a line, walk off-screen. Next
event → walk back in, sit. Positions derive from the **measured taskbar height**.

### Voice
`~/.echo/voice/<slug>.mp3` (46 ElevenLabs lines) matched to bubble text; blip
fallback if a clip is missing. User can replace any clip.

---

## 5. Tuning constants (the dials)

`VOICE_MIN_GAP=60s · SCENE_MIN_GAP=180s · AMBIENT_BUBBLE_CHANCE=0.18 ·
busyBurst>12/30s · AWAY_AFTER_MS=10min · FOOT_SINK=0.18 · sitY=y+0.34·winH ·
belowY=y+0.30·winH · MIN_HOLD{thinking:1100,speaking:750}`

---

## 6. Current state (2026-07-26)

**Working** (verified via `echo.log` / `echo-fe.log`): sync, home/positioning,
showcase, all scenes fire, voice clips load, attention budget in.

**Debt to clear before "done":**
- [ ] Nothing committed since the voice work — push the pile.
- [ ] Remove `fe_log` / `echo-fe.log` debug instrumentation (or gate behind a flag).
- [ ] Rotate the ElevenLabs + PixelLab keys (in chat history; `.env` is gitignored).
- [ ] `dante_idle.png` initial sprite — confirm it's the right pose.

## 6b. v2 Architecture — the Life Model (five layers)

The leap to a *personality* is not more animations — it's an internal state that
**evolves over hours and days**, so the same event does not always produce the
same response. Behaviour flows through five layers (never `event → animation`):

```
AI Events  →  Behavior Engine  →  Life Model  →  Decision Planner  →  Anim + Voice + FX
                                   (evolving state)                        │
                                        ▲──────────────── future mood ─────┘
```

Implemented as modules so `main.ts` stops being an if-chain:
`events` (backend) · `life.ts` (state) · `planner.ts` (decide) · `behaviors.ts`
(play) · `main.ts` (glue).

### The hidden state vector (`life.ts`, persisted → `~/.echo/state.json`)
Each 0–1, drifts continuously, nudged by events, decays toward a resting value.
Persisted so a relaunch doesn't reset his personality.

| Stat | Rises with | Falls with | Drives |
|---|---|---|---|
| **energy** | a break, morning | hours of use, late night | speed, yawns, naps |
| **confidence** | wins, big finishes | errors | swagger vs. sheepish |
| **patience** | time, calm | rapid errors (frustration) | shrug → snap → breakdown |
| **focus** | long coding runs | idle, interruptions | less talk when high |
| **curiosity** | many searches | — | looks around, wanders |
| **cockiness** | win streaks | errors | line choice, taunts |
| **boredom** | idle time | any AI event | urges to do something |

`mood` is derived from the vector (e.g. high confidence + low patience = "smug and
snappy"). **Every decision logs the whole vector to `echo.log`** so non-deterministic
behaviour is still explainable.

### Decision Planner rules (`planner.ts`)
- **Idle:** weighted-random urge, **never the same as the previous** one. Weights
  shift with the vector (bored→moves, low energy→naps, curious→looks around).
- **Work states escalate by DURATION, not just kind:** thinking 3 s → `sitthink`;
  10 s → pace; 20 s → check watch; 45 s → look away; 90 s → sigh. Same state, a
  restlessness that grows. Applies to any held state.
- **Wins scale with WORK SIZE** (measured: `tool_use` count + wall-time in the
  turn): tiny answer → smile; complex reasoning → smirk; big job → cheer; huge
  research turn → Jackpot. The magnitude is read, not guessed.
- **Errors track frustration** (patience decays): 1st "Hm." → 2nd "Really?" → 3rd
  breakdown → then patience **recovers over ~10 min** and he's calm again.
- **Big scenes: daily budget.** e.g. Jackpot needs `5 wins AND ≥2 min AND not
  already today`. Rarity = memory.
- **Voice: per-line cooldown** (~20 min) on top of the global gap, so a line never
  repeats close together.
- **Position: rare relocation** (once every few hours): drifts to mid-screen or
  another monitor, gone a while, returns. Creates "where did Dante go?".

### Day rhythm (time-of-day → resting mood)
| Time | Flavour |
|---|---|
| 06–11 Morning | fresh, "Let's rock", more spins |
| 11–17 Day | focused, works alongside |
| 17–22 Evening | playful, jokes, more likely to dance |
| 22–01 Late | dry, yawns, "Still going?" |
| 01–06 Night | sleepy naps, near-silent (config `quietHours`) |

### Config (`~/.echo/config.json`, see `config.example.json`)
Presets `chill|lively|silent|off`; `muteWhenFullscreen`; voice/scene/chatter gaps;
`quietHours`; position. Read at launch — tune without a rebuild.

### Legacy note
The old §6b "urges list" and the current build's **fixed idle rotation** are
replaced by the weighted/never-repeat planner above. **Remove the launch showcase**
from normal startup (keep: first-ever-launch intro + a hidden replay for debug,
since the overlay can't be screenshotted).

---

## 7. v2 roadmap (prioritized)

The refactor is real: `main.ts` becomes glue; behaviour moves into modules. Build
it in the order that keeps ECHO runnable at every step.

1. **P0 — Commit & clean.** Push the current pile (checkpoint), strip `fe_log`
   debug spam, keep the `.env`/keys out.
2. **P1 — `life.ts`: the state vector.** energy/confidence/patience/focus/
   curiosity/cockiness/boredom, with drift + decay + event nudges, **persisted to
   `~/.echo/state.json`**, logged on every tick. Wire existing reactions to *read*
   it (no behaviour change yet) — proves the model before the planner.
3. **P2 — `planner.ts`: the decisions.** Idle weighted + never-repeat; work
   duration-escalation; win magnitude from turn-size; frustration/patience decay;
   daily scene budget; per-line voice cooldown. Remove the launch showcase (keep
   first-run + debug replay).
4. **P3 — Live-test a full day.** Tune weights from `echo.log` + real feel.
5. **P4 — `config.json`** (`config.example.json` exists): presets,
   `muteWhenFullscreen`, `quietHours`, gaps. Tune without a rebuild.
6. **P5 — Polish beats**: rare relocation / other-monitor; new art (`yawn`,
   `leanback`, `nap` already generated) into urges; punchier `gunspin`.
7. **P6 — ChatGPT/Gemini** browser-extension bridge (only if wanted).

**Rule: P1→P2 is the next build, in that order. P5+ waits until P3 (living with
it) says he needs it. Everything is explainable via the logged state vector.**

---

## 8. v3 direction — "make him feel alive" (director review, 2026-07-27)

External animation-director review verdict: concept 10/10, execution "a
collection of animations, not a living character." The one-line brief:
**stop adding features; make every existing action breathe, hesitate, carry
weight, and occasionally surprise.** Adopted roadmap:

**Phase 1 — motion quality (next):**
- Anticipation before EVERY action (bend-pause-act), not just scenes.
- Weight: no pose teleports — sit = down/bounce/settle, stand = lean/push/rise.
- Reaction pools with real odds, including "no reaction" (~20%): predictability
  kills the illusion. Success ≠ always cheer.
- Idle as the masterpiece: overlapping micro-behaviors (blink, breathing,
  coat sway, finger tap, sigh) layered, not one clip at a time.

**Phase 2 — mood & memory:** the life vector (§6b) must VISIBLY drive
reactions — same event, different response depending on mood; frustration and
boredom arcs users can narrate ("he got bored", not "the timer expired").

**Phase 3 — environment:** time-of-day energy, CPU/compile awareness (long
build → arms crossed), music awareness beyond titles (Windows media session
API — sees background-tab playback, fixes tab-switch blindness), battery,
cursor proximity.

**Phase 4 — discovery & rarity:** hour-20 idle, hour-50 voice line, hour-100
scene; extremely rare one-offs (coin toss, pizza, fourth-wall stare). Never
listed anywhere — found, screenshotted, shared.

**Anti-goals (traps):** combat, RPG systems, achievements, settings with 400
toggles, more one-shot features before Phase 1 lands.

### v2 concrete plan (reconciled 2026-07-27, animation-lead review #2)

Phase 1-2 of the frame-count plan is ~80% shipped already (walk, sit/stand,
work poses, sword move, dances, idle pack). The EMPTY tier is the top of the
frequency table — blink / breathing / micro-glances — and that's v2:

1. **Micro-life layer — 0 gens (code + hand pixel edits):** 1px breathing
   oscillation; 2-frame closed-eye variants of the 4 most-seen poses (eye
   region hand-edited like the typetap frames); eye-shift glances; he LOOKS AT
   THE CURSOR when it comes near (mouse pos via Win32 exists).
2. **Small gen batch — ~5-6 gens (trial has 8):** stretch (2), shrug (2),
   head-tilt (1-2). animate-v3 cost model: ~1 gen per 4 frames.
3. **Live with him a week** before anything else (the P3 rule).
4. **Phase 3 later — ~12-15 gens:** pizza, coin flip, clean sword, sword spin,
   wake-up, look-outside-screen. **Phase 4 — ~30-45 gens:** rain, birthday,
   discoveries; the Christmas re-skin alone is 15-30 gens — park it.
   Reroll reality: budget ~1.5x list price per clip.

Also adopt from review #2: Devil Trigger rarity should trend toward once per
10-20 h of use, not hourly — rare = precious.

---

## 9. Master plan — v2 milestones with implementation nuances
(planned 2026-07-27 · build in this order · every item logs to echo.log or it
didn't happen)

### M1 — Breathe: the no-new-moves update (0 gens, pure code)

**1. Timing pass (msSeq everywhere).** Only typing/dance/sword have curves.
Give the other clips theirs: gunspin accelerates into a snap-stop, cheer dips
(anticipation) before the jump, stagger holds the impact frame, falling eases
in. *Nuances:* frameLoop already supports msSeq; for settle-clips (settle=8)
indices still align because msSeq[frameIdx]. A global `paceMul` (see M1.4)
multiplies shownMs — the sword's SOUND setTimeout offsets must scale by the
same paceMul or audio desyncs.

**2. Window weight.** Sit = drop past target ~6px then rise (chained
moveWindowY tweens); stand = 80 ms lean beat then rise. *Nuances:* chain must
cancel cleanly — winTween races are the posture-desync class of bug; scenes
that force posture skip the bounce (force flag path). Anticipation: 250-400 ms
hold AFTER standUp, BEFORE the action clip, in every scene — but not twice in
demo paths.

**3. Reaction pools.** applyEvent success -> weighted pick {cheer .30,
gunspin flourish .15, laugh .15, line-only .20, nothing .20}; error ->
{stagger .35, cold arms-crossed silence .25, annoyed watch-check .20,
nothing .20}. Weights bend with the vector (cocky -> flourish up; focus high
-> nothing up). *Nuances:* streak counters and star logic are untouched (they
live upstream); voice/bubble gaps still apply; log `react=<pick>` every time;
"nothing" must still refresh lastActivity.

**4. Visible mood.** `paceMul = clamp(0.88, 1.12)` from energy (tired = slow,
morning = snappy); WORK_POSES ordering biased by cockiness; line tables gain
mood/time tags and pickLine filters by them (slugs stay stable — voice files
match slugOf); patience < 0.3 -> error reactions force the cold silent
variant and suppress the shake. *Nuance:* paceMul applies in frameLoop only —
window tweens keep real time or walks look drunk.

**5. Micro-motion.** Breathing: rAF sine on the sprite, 1px amplitude, ~3.2 s
period scaled by energy. *Nuances:* #sprite transform is already used by
facing (scaleX) and shooting/leveling keyframes — wrap the img in a breather
div so transforms never fight, and PAUSE breathing while gagActive/showcasing.
Sway only when seated-idle. Cursor-look: frontend can't see the global mouse
(click-through window) — context.rs polls GetCursorPos in the 120 ms typing
loop and emits zone-crossing events only (near-left / near-right / far,
hysteresis ~40 px, throttled); frontend flips facing toward the cursor when
within ~300 px and idle, clears after ~2 s. Never during scenes/walks.

**6. Sound floor.** All gains <= 0.12 — felt, not heard. Boot scuffs: two per
walk cycle timed to sidewalk footfall frames (schedule during slideWindow,
stop on arrival). Chair creak in posture()->seated; cloth rustle in standUp();
holster click at gunspin end. *Nuance:* one shared "floor" gain node so a
future config mute kills the whole layer with one dial.

**7. Rarity retune.** Idle-hours Devil Trigger: hourly -> once per 12-20 h
(persisted clock exists). The GAMING 10-min DT cadence stays — that one is an
explicit user order. 4th-wall taunt after Jackpot: 0.5 -> 0.05 (it becomes a
legend). 1% of dances run double length. Log every rare roll.

### M2 — Сюжет: memory, relationship, payoffs (0 gens, story.ts + writing)

**State.** `~/.echo/story.json` via new lib.rs commands story_load/story_save
(file over localStorage: user-visible, survives reinstalls, greppable):
`{installedAt, totalHours, chapter, firsts:[], days:{date:{wins,errors,
jackpots,stars}}, lastSeenDate, gags:{pizzaMentions,lastPizzaAt}}`.
*Nuances:* no clean shutdown hook exists — accumulate totalHours and today's
counters incrementally (write every ~5 min and after each scene); midnight
rollover on first event of a new date.

**1. Demon-hunt framing.** New line pools keyed to existing beats: streak
errors ("This one bites."), breakdown = losing the fight, streak-ending win
("Demon's dead."). Pure writing; wired through the M1 pools' line-only picks.

**2. Relationship arc.** totalHours < 20 = Stranger (reserved lines, ambient
bubble chance halved, NO 4th-wall), < 80 = Colleague (jokes, taunts), else
Partner (4th-wall glances unlocked, protective lines on bad days: "We'll fix
it."). *Nuance:* arc gates ODDS and POOLS, never mechanics — he works the
same, he talks different.

**3. Daily memory.** First launch of a day (lastSeenDate < today): greeting
from yesterday's numbers ("Three Jackpots yesterday. Show-off." / "Yesterday
was rough. Today we win."). Late-night sign-off line when he walks off after
23:00. Firsts fire once ever, at MAJOR priority, persisted immediately:
first Jackpot, first breakdown survived, 100★, 500★, 100 h together.

**4. Serialized gags.** Pizza line max once/week (lastPizzaAt), counter
grows; the M5 pizza animation checks pizzaMentions >= 3 before it may ever
play — the payoff must be EARNED or it's just another clip.

**5. Level chapters.** lvlUp switch: Lv5 unlocks the sword move outside
gaming (rare idle flourish), Lv8 adds an idle to rotation, Lv10 a unique
line. Unlock flags live in story.json; planner reads them.

**Writing rule:** original lines in his vibe — never copied game dialogue
(same law as the art).

### M3 — Small art batch (~5-6 of the 8 trial gens)
stretch (8f, 2 gens), shrug (8f, 2), head-tilt (4f, 1-2) via gen_anim.py,
idle-anchored first/last frames, MOCK GIF BEFORE EVERY SPEND (standing rule).
Blink: 0 gens — closed-eye variants of sitswing/sitcross/sitthink/typetap
settle frames, eyes are a ~6px region, PIL edit like the typetap taps; played
by frameLoop URL-swap (variant map per clip/frame) for ~120 ms every 3-7 s
when idle. *Nuance:* blink pauses during scenes and speaking.

### M4 — Live with him a week (no new features)
Watch echo.log distributions: reaction-pool spread, mood ranges over days,
scene frequency, blink/breath feel. Fix only what the log or the eye flags.

### M5 — Living behaviors (~12-15 gens, needs top-up)
pizza payoff (gated by the gag counter), coin flip, clean sword, sword spin,
wake-up stretch, look-outside-screen. All enter through M1 pools + M2 gates,
never as bare timers.

### M6 — Later infra + rare events (~30-45 gens + code)
config.json presets + quietHours (kills the sound floor + voice with one
dial); Windows media-session API for background-tab music (replaces title
heuristic, titles stay as fallback); Linux context layer (evdev typing needs
input-group perms, MPRIS/D-Bus media, Steam registry.vdf) — unlocks the
friend; rain/birthday/discovery events; Christmas re-skin ONLY with abundant
gens (15-30 alone).

**Invariants across all milestones:** attention budget rules hold (gaps,
budgets, busy-burst silence); every decision logs; no timer-driven spectacle
without an earned/contextual gate; mocks before generations; the user's
machine is ground truth — capture-verify anything visual.**

**Sound direction:** layered near-inaudible soundscape (cloth, boot scuff,
chair creak, holster click) instead of adding louder effects.
