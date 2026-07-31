# ECHO — Every Move (current build)

Everything Dante does right now, with the trigger, timing, position, sound, and
the exact knob to change it. All in `src/main.ts` unless noted. Times in ms.

> Current v0.2.0 note: this catalogue covers the shared engine and Corvin.
> The exact current Dante durations, Director cooldowns and fixed clocks are in
> [`DANTE_TIMINGS.md`](DANTE_TIMINGS.md).

> The Life Model and separate learned directors for Dante and Corvin are active.
> Fixed daily and gaming appointments outrank autonomous choices.

---

## A. Entrance (once, on launch)
| Step | Clip | Timing | Where | Voice |
|---|---|---|---|---|
| Walk in from off-screen left | `sidewalk` | ~150 px/s until corner | left edge → corner | — |
| Look around and settle | `sit` | ~2.7 s | corner, standing | — |
| Arrival stagger | `stagger` | 0.865 s + 0.12 s hold | corner | — |
| Sit down onto panel | `sitpanel` | 1.74 s | corner, drops to seat | — |

Change: `runIntro()`. Walk pace `slideWindow(cornerX, 150)`. The showcase is QA-only.

---

## B. Idle rotation (seated, loops forever when nothing's happening)
Plays a pose, then **holds still** a random time, then shifts. The full list of
25 poses and holds is in `DANTE_TIMINGS.md`; selection weights live in `planner.ts`.

| Pose | Clip | Plays | Holds still | Meaning |
|---|---|---|---|---|
| Swing legs | `sitswing` | 3× | 18–50 s | default fidget |
| Arms crossed | `sitcross` | 1× | 35–75 s | resting |
| Ponder | `sitthink` | 1× | 15–40 s | thinking to himself |
| Check watch | `checkwatch` | 1× | 8–15 s | impatient |

Change: edit the `hold: [min,max]` per row. Bigger = calmer/stiller.

---

## C. Working (reactive — follows your AI activity)
One event per AI action. `ANIMS`, line ~160. Held ≥ `MIN_HOLD` so it doesn't flicker.

| Your AI is… | Clip | Position | Min on-screen |
|---|---|---|---|
| thinking | `sitthink` | seated | 2200 ms + a rare "Hmm." |
| coding | `gunspin` (twirls gun) | standing | — |
| searching | `sit` (arms crossed) | standing | — |
| speaking | `taunt` (gestures) | standing | 1200 ms |

Work poses also rotate on each change: `WORK_POSES = ["gunspin","sit","taunt"]` (line 416).
Change clips/speeds in `ANIMS`. "Hmm" gate: `state==="thinking"` block ~line 430.

---

## D. Small reactions (every win / error)
| Event | What | Clip/FX | Voice |
|---|---|---|---|
| 1–2 wins | `lightWin` | ding + smirk bubble + chuckle | only if silent ≥4 min |
| 1–2 errors | `lightError` | thud + tiny shake + shrug bubble | only if silent ≥4 min |

Change: `lightWin()` / `lightError()` (~line 535). Lines: `WIN_LINES`, `SHRUG_LINES`.

---

## E. Big scenes (rare, rate-limited — ≥3 min apart, `SCENE_MIN_GAP`)
| Trigger | Scene | Clip | FX + Voice | ~Length |
|---|---|---|---|---|
| **3 wins in a row** | Jackpot | `shoot` → `gunspin`/`taunt` | single gunshot, muzzle slow-mo, shake, "Jackpot!" | 2.61-3.34 s |
| **25★ milestone** | Dance | `headbang`/`dance` ×3 | beat shake, "Too easy." | 4.02-4.61 s |
| **3 errors in a row** | Breakdown | `falling` → `climb` | thud, shake, "falling!" → "...saw nothing." | 4.45-4.59 s |
| **Level up** | Devil Trigger | `devil` | red vignette, aura hum, shake, "Devil Trigger!" | 2.65-2.80 s |
| **Director / 22:00** | Full Devil Form | `d_devilrise` → `d_devilburn` → `d_devilcalm` | red aura, demon voice | ~10.97 s |

Streak thresholds: `winStreak >= 3` / `errStreak >= 3` (~lines 637, 660) — set to
`2` for more frequent, `4` for rarer. Milestone every `STAR_MILESTONE = 25` (line 524).
Gap between any two big scenes: `SCENE_MIN_GAP = 180000` (line 460).

---

## F. Presence (comes & goes)
| Trigger | What | Clip |
|---|---|---|
| **No AI activity 15 min** | stand, arms crossed, a line, walk off left | `sit` → `sidewalk` off |
| **Next AI event after leaving** | walk back in, sit down | `sidewalk` → `sitpanel` |

Change: `AWAY_AFTER_MS`. Lines: `LEAVE_LINES`, `RETURN_LINES`.

---

## G. Voice & noise governance (the "not always" rules)
| Rule | Value | Line |
|---|---|---|
| Min gap between any two spoken lines | `VOICE_MIN_GAP` = 240 s (4 min) | 459 |
| Min gap between big scenes | `SCENE_MIN_GAP` = 180 s | 460 |
| Chance an ambient work line even shows | `AMBIENT_BUBBLE_CHANCE` = 0.10 | 461 |
| "You're busy" cutoff (stay silent) | `> 12` events / 30 s | 469 |

Voice clips: `~/.echo/voice/<slug>.mp3` (your files win); else stylized blip.

---

## H. Context moves (OS awareness — `context.rs` → `onContext()`)
| Trigger | What | Clips | Knob |
|---|---|---|---|
| **You type** (Win32 keys) | laptop OUT once → typing loop while you type → laptop AWAY (reversed) | `typing` (one-shot) → `typetap` (4-frame loop) | session extend 9 s/keystroke, `typingUntil` |
| **Video/music opens** | sits and turns toward the monitor centre; exact reverse on close | `d_watchturn` → `d_watchloop`, or `sit` → `c_watchturn` → `c_watchloop` | Dante in 2.99 s; Corvin in 3.76 s; 10 s heartbeat |
| **Game launches** | persistent session clock; Alt+Tab does not reset it; Director keeps small/pose variety between fights | `shoot` / Corvin hunt table + learned Director | Unchained 3, cleave 7, breach 10, Door 15; Dante spin 6, sword 7, coin 12, pizza 18 |

Hard priority order for Corvin: **23:40 Requiem** → a currently finishing clip →
fixed Steam fights at 3/7/10/15 minutes → small/pose Director choices. Director
reserves the stage for 45 seconds before a fixed fight, and the hunt clock is checked
every 5 seconds. Director never replaces or reschedules a hard appointment.

## I. Position on the taskbar
| Knob | Value | Effect | Line |
|---|---|---|---|
| Taskbar height | measured live | auto-adapts | ~765 |
| Feet sink into panel | `FOOT_SINK` = 0.18 | higher = lower on bar | 771 |
| Seat drop (sitting) | `y + 0.34·winH` | sit height | 778 |
| Fall dip depth | `y + 0.30·winH` | how low he falls | 781 |

---

### Quick "make him calmer" recipe
Raise `URGES` holds, raise `winStreak/errStreak` to 4, raise `SCENE_MIN_GAP` to
300000, lower `AMBIENT_BUBBLE_CHANCE` to 0.08, raise `AWAY_AFTER_MS`.

### Quick "make him livelier" recipe
Lower streak thresholds to 2, lower `SCENE_MIN_GAP` to 90000, raise
`AMBIENT_BUBBLE_CHANCE` to 0.4, shorten `URGES` holds.

---

## J. Corvin — first sheet (src/corvin.ts, public/pixel/corvin/)
20 moves, 203 frames, all approved from GIF previews. Timings live in
`src/corvin.ts` (msSeq = the approved preview pacing, verbatim).
Demo reel: `echo corvin > ~/.echo/demo` plays the full showcase.

| Move | Dir | Frames | Total ms | Notes |
|---|---|---|---|---|
| Idle | `idle` | 9 | 2070 | breathing loop |
| Walk-in | `walkin` | 9 | 1020/pass | over-shoulder sword carry |
| Walk-out | `walkout` | 9 | 1020/pass | knight back-carry, mirror for exit |
| Sit | `sit` | 9 | 1800 | sword across knees, settle=8 |
| Media turn | `c_watchturn` | 6 | 1960 | seated turn toward monitor centre; reversed on exit |
| Media watch | `c_watchloop` | 9 | 3780/pass | quiet breathing, sword stays across knees |
| Bow | `bow` | 9 | 2030 | knightly, back bends 25–30° |
| Meditate | `meditate` | 9 | 2920/pass | seated, loops |
| Aura rise | `aurarise` | 9 | 1610 | FULL flare: pool -> engulf |
| Aura burn | `auraburn` | 9 | 1080/pass | flicker loop at peak |
| Aura sink | `aurasink` | 9 | 1880 | flames sink back |
| Exec raise | `execraise` | 9 | 2410 | slow lift, 650 ms tension hold |
| Exec strike | `execstrike` | 13 | 2360 | slam 220 ms + shadow burst |
| Kneel down | `kneeldown` | 11 | 2710 | vigil entry, 750 ms hold |
| Eagle hop | `eaglehop` | 11 | 2410 | Artsiv to the crossguard |
| Kneel rise | `kneelrise` | 13 | 2610 | eagle returns, he stands |
| Whetstone | `whetstone` | 11 | 3150/pass | storyteller loop (tales.ts) |
| Guitar | `guitar` | 11 | 1760/pass | YouTube moment, Artsiv hovers |
| Charge | `charge` | 15 | 3480 | blade ignition, 940 ms peak |
| Takeoff | `takeoff` | 9 | 1620 | ends: Corvin alone |
| Landing | `landing` | 9 | 1720 | glide + brake, ends at base |
| Artsiv solo | `artsivfly` | 10 | 1400/pass | 84x37 flying sprite, engine-driven |

---

## K. Corvin — Door chain (v0.2.0)

The Door scene is triggered from the tray or by `door` / `breach` demo words.
It is a synchronized two-window scene: Corvin's main window plays the chained
sprite clips while the rift overlay at the right monitor edge renders the hand,
sparks and tendrils.

| Beat | Clip / system | Timing | Physics / visual rule |
|---|---|---|---|
| Sense | `c_doorsense` | 2260 | he turns and raises guard before movement |
| Retreat | `c_backstep` + `stepWindowX()` | 2880 | window moves in short footfall bursts, not a glide |
| Parry | `doorparry` | 750 | exact guarded-pose recoil; no old-model flash |
| Sword plant | `c_swordplant2` | 2330 | begins from pinned `c_backstep/frame_12` continuity |
| Demon rise | `c_armup` | 2250 | the screen-left arm turns demonic; only a little corruption reaches the body |
| Corruption | `c_infect` | 3480 | corruption grows from the raised left arm to the half-demon contact pose |
| Push | `c_monsterhold` loop | 4590 | the same transformed pose holds while the rooted tendrils force the claw back |
| Retract / calm | overlay retract + reversed `c_infect` | 3480 | tentacles retract into the palm while the same model changes back |
| Sword / return | `c_swordtake` + `slideWindow()` | ~2790 | Corvin takes the sword and returns to his corner |

Knobs: `BACKSTEP_WINDOW_BEATS`, `stepWindowX()`, and the Door `REACH`,
`LUNGE_REACH`, `EMERGE0`, `EMERGE1`, `LASH`, `CLING`, `PUSH0`, `GONE` constants
in `src/main.ts`.
