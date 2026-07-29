# ECHO — Every Move (current build)

Everything Dante does right now, with the trigger, timing, position, sound, and
the exact knob to change it. All in `src/main.ts` unless noted. Times in ms.

> This is the CURRENT behaviour. The autonomous "Life Model" (moods / free-will
> urges) is designed in DESIGN.md §6b but **not built yet**.

---

## A. Entrance (once, on launch)
| Step | Clip | Timing | Where | Voice |
|---|---|---|---|---|
| Walk in from off-screen left | `sidewalk` | ~150 px/s until corner | left edge → corner | — |
| Stand tall, arms crossed | `sit` | 1× (~9×200) | corner, standing | — |
| Sit down onto panel | `sitpanel` | 1× (~9×190) | corner, drops to seat | — |
| Then → showcase reel (demos every move once) | — | ~20 s | corner | captions only |

Change: `runIntro()`. Walk pace `slideWindow(cornerX, 150)`. To skip the reel,
remove the `showcase()` call at the end of `runIntro()`.

---

## B. Idle rotation (seated, loops forever when nothing's happening)
Plays a pose, then **holds still** a random time, then shifts. Line ~500 `IDLE_SEQ`.

| Pose | Clip | Plays | Holds still | Meaning |
|---|---|---|---|---|
| Swing legs | `sitswing` | 3× | 0.7–1.8 s | default fidget |
| Arms crossed | `sitcross` | 1× | **7–12 s** | resting |
| Ponder | `sitthink` | 1× | 5–9 s | thinking to himself |
| Check watch | `checkwatch` | 1× | 4–7 s | impatient |

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
| 1–2 wins | `lightWin` | ding + smirk bubble + chuckle | only if silent ≥60 s |
| 1–2 errors | `lightError` | thud + tiny shake + shrug bubble | only if silent ≥60 s |

Change: `lightWin()` / `lightError()` (~line 535). Lines: `WIN_LINES`, `SHRUG_LINES`.

---

## E. Big scenes (rare, rate-limited — ≥3 min apart, `SCENE_MIN_GAP`)
| Trigger | Scene | Clip | FX + Voice | ~Length |
|---|---|---|---|---|
| **3 wins in a row** | Jackpot | `shoot` → `gunspin`/`taunt` | single gunshot, muzzle slow-mo, shake, "Jackpot!" | ~3 s |
| **25★ milestone** | Dance | `dance` ×3 | beat shakes, "Too easy." | ~3 s |
| **3 errors in a row** | Breakdown | `falling` → `climb` | thud, shake, "falling!" → "...saw nothing." | ~4 s |
| **Level up** | Devil Trigger | `devil` | red vignette, aura hum, shake, "Devil Trigger!" | ~2 s |

Streak thresholds: `winStreak >= 3` / `errStreak >= 3` (~lines 637, 660) — set to
`2` for more frequent, `4` for rarer. Milestone every `STAR_MILESTONE = 25` (line 524).
Gap between any two big scenes: `SCENE_MIN_GAP = 180000` (line 460).

---

## F. Presence (comes & goes)
| Trigger | What | Clip |
|---|---|---|
| **No AI activity 10 min** | stand, arms crossed, a line, walk off left | `sit` → `sidewalk` off |
| **Next AI event after leaving** | walk back in, sit down | `sidewalk` → `sitpanel` |

Change: `AWAY_AFTER_MS = 10*60*1000` (line 578). Lines: `LEAVE_LINES`, `RETURN_LINES`.

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
| **Video/music opens** | 15 s dance | `dance` | `danceScene(15000)` |
| **…and stays open** | dance repeats | `dance` | `MEDIA_DANCE_EVERY` = 10 min |
| **Game launches** | 3-shot burst + playful mood | `shoot` | gaming beats every ~1–3.5 min, hourly special |

## I. Position on the taskbar
| Knob | Value | Effect | Line |
|---|---|---|---|
| Taskbar height | measured live | auto-adapts | ~765 |
| Feet sink into panel | `FOOT_SINK` = 0.18 | higher = lower on bar | 771 |
| Seat drop (sitting) | `y + 0.34·winH` | sit height | 778 |
| Fall dip depth | `y + 0.30·winH` | how low he falls | 781 |

---

### Quick "make him calmer" recipe
Raise `IDLE_SEQ` holds, raise `winStreak/errStreak` to 4, raise `SCENE_MIN_GAP` to
300000, lower `AMBIENT_BUBBLE_CHANCE` to 0.08, raise `AWAY_AFTER_MS`.

### Quick "make him livelier" recipe
Lower streak thresholds to 2, lower `SCENE_MIN_GAP` to 90000, raise
`AMBIENT_BUBBLE_CHANCE` to 0.4, shorten `IDLE_SEQ` holds.

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
