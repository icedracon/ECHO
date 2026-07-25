# Dante Desktop Companion — Scene Design

Dante lives on the taskbar and reacts to your Claude Code session. Two layers:
**ambient** (subtle, state-driven) and **signature scenes** (short cinematic gags
triggered by events). Full DMC flavor — Ebony & Ivory, Rebellion, "Jackpot", taunts.

Choreography primitives (window moves, already built or trivial):
- `slideX` — walk horizontally (legs-visible side walk) ✓
- `moveY` — sit down / stand up (raise/lower window) ✓
- `diveY` — slide the window DOWN off the bottom (dive under the panel) ← new
- glow/flash — CSS aura overlay ← trivial

---

## Ambient (continuous, per state)

| State | What he does | Anim |
|---|---|---|
| **idle** | sits on the panel edge, legs dangling, **feet swinging** | sit-dangle ✓ fetching |
| **thinking** | sits, hand on chin, head tilt | sit-think ✓ fetching |
| **coding** | stands, focused, cracks knuckles | anim (have) |
| **searching** | stands, looks around | anim (have) |
| **speaking** | stands, gestures | anim (have) |

Idle micro-beats (random, every ~30–60s while sitting): gun-spin · check watch ·
yawn · glance at you.

---

## Signature scenes (event-triggered)

### 1. Entrance — "Let's rock" 🎸  (on launch)
Walks in from off-screen left → strides to the corner → **pauses, brushes coat,
looks around** → sits on the panel, feet swinging.
Bubble: *"Let's rock."* / *"Ну, погнали."*

### 2. Success — "JACKPOT!" 🔫  (agent finishes a task)
Stands up → **whips out Ebony & Ivory**, points at the screen → **muzzle flash +
gunshot** → *"Jackpot!"* → spins the gun, holsters, sits back down.
Bubble: *"Jackpot!"* · Anim: **shoot** (generate) · FX: CSS muzzle-flash + sound.

### 3. Error — "Dive!" 🪤  (agent hits an error)  ← your idea
Comedic panic: runs to the edge → **climbs onto the taskbar and jumps DOWN under
it** (window slides below the screen) → hides a beat → **climbs back up** and sits
sheepishly.
Bubbles: *"Опа, накосячили…"* → (peeks up) *"…я ничего не видел."*
Anims: **climb**, **jump/dive** (generate) · Move: `diveY` down then back up.

### 4. Dance — "Taunt" 💃  (star milestone, e.g. every +50 ★, or rare long-idle)
Breaks into an **anime dance / DMC taunt** ("Come on!"), maybe twirling Rebellion.
Bubble: *"Too easy."* · Anim: **dance** (generate).

### 5. Level up — "Devil Trigger" 😈  (level increases)
Flashy pose + **red aura flash** (CSS glow pulse), eyes glint.
Bubble: level name (*"Специалист"* …).

### 6. Wander — "Stretch" 🚶  (occasional, while idle)
Walks off-screen left, gone a few seconds, walks back. ✓ built.

---

## Animations to generate (PixelLab, open-coat character)

| Anim | Action prompt | Used by | ~Gens |
|---|---|---|---|
| sit-dangle | sitting on edge, legs swinging | idle | ✓ fetching |
| sit-think | sitting, hand on chin | thinking | ✓ fetching |
| **shoot** | drawing two pistols, aiming forward, firing | success (Jackpot) | 1 |
| **climb** | climbing up over a ledge | error (dive) | 1 |
| **jump** | jumping / diving down | error (dive), milestone | 1 |
| **dance** | dancing, taunting, arms up | milestone dance | 1 |

~4 more gens of the ~25 left. All from the same open-coat Dante → consistent.

---

## Build order (recommended)
1. **Sit-dangle + sit-think** (in flight) → wire idle/thinking to the panel perch.
2. **Success "Jackpot" shoot** — biggest payoff, most-seen event.
3. **Error "Dive under the panel"** — the gag you want; needs `diveY`.
4. **Dance** on a star milestone.
5. **Level-up aura** (free, CSS).

## Open questions for you
- **Sound?** Gunshot on Jackpot, guitar riff on level-up — want audio, or silent?
- **Dance trigger** — every +50 ★, or a keybind, or random?
- **Dive-under-panel** — fully disappear under the taskbar, or just duck behind it?
