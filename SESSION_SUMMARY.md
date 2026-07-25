# ECHO (Pixel Dante) — Session Handoff

## What it is
A lightweight **Tauri v2** desktop pet: a pixel-art **Dante (DMC)** that lives on the
Windows taskbar, reacts in real time to your Claude Code session, and is
click-through + always-on-top. ~40MB RAM. Project name: **ECHO**.

- Project: `C:\Users\zevs\Documents\agent-companion`
- **Run: double-click `Start ECHO.bat`** — launches the standalone
  `src-tauri\target\release\ECHO.exe` (built), or falls back to `npm run tauri dev`.
- Installers also built: `src-tauri\target\release\bundle\{msi,nsis}\ECHO_*.{msi,exe}`.

## Architecture
- **Rust backend** (`src-tauri/src/`): `watcher.rs` tails `~/.claude/projects/**/*.jsonl`,
  `events.rs` maps log lines → states (thinking/coding/searching/speaking/success/error),
  `store.rs` persists stars, emits `agent-event` to the frontend. Commands: `get_state`, `idle_phrase`.
- **Frontend** (`src/main.ts` + `styles.css`, `index.html`): a **2D pixel sprite** (`#sprite` img)
  with a frame player. Each State → a `Clip {frames, ms, loop, settle}`. Window is moved
  around the desktop for the walk-in + wander via the Tauri window API.
- Phrases (RU) are in `src-tauri/phrases/dante_lvl1.json` (compiled in).

## Current behavior (the settled version)
- **Idle** → sits on the panel edge, **swinging his dangling legs** (`sitswing`, loops);
  occasionally **laughs to himself** (`laugh`, ~38s beat). The walk-in plays `sitpanel`
  (stand→sit) once as the window drops (`sitY = y + 0.34·winH`).
- **thinking** → seated, **chin on hand** (`sitthink`).
  All seated beats generated from the seated frame → same **original Dante**, stays on the panel.
- **coding / searching / speaking** → original front Dante loop (`anim`), standing.
- **success** → `cheer` (arms up) once → back to idle.
- **error** → `stagger` once → idle.
- **walk-in (launch) + wander (every ~45s idle)** → legs-visible **side walk** (`sidewalk`),
  mirrored to face direction, ~150 px/s. Off-screen-left → corner → **sits down**.
- **level up** → red "Devil Trigger" aura pulse (CSS `.leveling`, ~1.2s).
- Speech bubbles, ★ star counter, click-through overlay.

## Sprite folders (`public/pixel/`)
All 9-frame, feet-flush-cropped. Cache-busted with `?v=13` in `clip()`.
- `sit` — arms-crossed idle (ORIGINAL Dante, from `dante_idle.png`)
- `anim` — front walk loop (ORIGINAL)
- `cheer`, `stagger` — success/error (ORIGINAL)
- `sidewalk` — legs-visible SIDE walk (PixelLab character-system Dante) ← **just regenerated as "upright" — NEEDS VISUAL CHECK next session**
- `dante_idle.png` — the base original sprite (source of the ORIGINAL animations)

## The core tension we kept hitting
Two Dante "looks" exist and don't perfectly match:
1. **Original** (create-image-pixflux, `dante_idle.png`) — prettier, but **closed long coat** → any side walk hides the far leg, front walk barely steps.
2. **Character-system** (PixelLab `create-character`, open coat) — legs visible for a real side walk, but a slightly different render → user called it "another Dante".
Current compromise: **original for everything, character ONLY for the side walk.**

## Key open items / next steps
1. ✅ **Upright walk DONE** — `sidewalk` was regenerated with a "straight back, standing tall" prompt and verified: upright posture, legs striding, coat swinging, ~74×123 (matches idle height). Live at `?v=13`. This resolved the long "hunched walk" saga.
2. **Standing height** — `y = ...- taskbar*0.52` in `runIntro`; feet-flush sprites land on the panel. Nudge in ~0.03·taskbar steps if off.
3. **Scenes** (see `SCENES.md`):
   - ✅ **Success "Jackpot"** — `shoot` clip + gold muzzle-flash flicker (`.shooting`) + "Jackpot!" → sit.
   - ✅ **Error "dive under the panel"** — `dive`→ window slides below screen (`belowY`) → hide → `climb` back up → "…я ничего не видел." → sit.
   - ✅ **Level-up aura** — red "Devil Trigger" pulse (`.leveling`, CSS).
   - ✅ **Dance** on a **25★ milestone** — `dance` clip (arms-up taunt), replaces the Jackpot at each 25-star mark (`danceScene`, `STAR_MILESTONE`).
   All new clips are the **original Dante** via `animate-with-text-v3` (new key `8e3a…`, ~30 gens left).

## Animation theory (the behavior spec)
Three tiers — calm at rest, legible while working, punchy on events.
- **Rest (idle, seated, cycles forever):** `sitswing` swing legs 3× → `sitcross` play once then **hold still 7–12s** → `sitthink` play once then **hold still 5–9s** → repeat. The *stillness between shifts* is deliberate (calm, not fidgety). Implemented via `IDLE_SEQ` (`{clip, plays, hold}`) + `holdStill()`.
- **Work (standing, loops while active):** `anim` for coding/searching/speaking; `sidewalk` while walking. `sitthink` also = the reactive *thinking* state (seated, plays once → holds till next state).
- **Events (one-shot → back to rest):**
  - success → `shoot` "Jackpot" (1×); 25★ milestone → `dance` (3 loops).
  - error → `falling` (plummets straight down at the corner) → hide → `climb` up (reversed: crouch→stand, pulls over the edge) **facing left** → sit.
  - `laugh` ~50% after a win.
- Arrival beat: after walking in he strikes `sit` (standing, arms crossed) before sitting down.
- Only leg-swing, work/walk, and dance loop; everything else plays once and settles.
- Wired clips: 3 idle poses + `sitpanel` + `anim` + `sidewalk` + `shoot` + `falling` + `climb` (regen'd, reversed) + `laugh` + `dance` + `sit` (arrival). `stagger`/`cheer` remain the never-firing state-map fallbacks (harmless).
- **Launch showcase** demos every clip once (captioned) then hands off to the rest cycle.

## Reactions — timing model (important)
- Each JSONL block is its **own line**, so thinking/speaking used to be clobbered in ms.
  `MIN_HOLD` (thinking 1100ms, speaking 750ms) holds them on screen, coalescing newer
  events, so the **thinking pose is actually visible** before he stands to code.
- **No clock-tick timers** ("no cronjob"): idle-chatter removed; laugh fires after a real
  success (~50%); wander is a rare **jittered 5–10 min** stretch, idle-only.
4. **Sit-on-panel** (legs dangling, feet swinging) was attempted but the sit sprite came out a crouch (legs tucked) and was rejected — not wired.
5. Open questions from the user: sound (gunshot/riff) yes/no; dance trigger (milestone/random/hotkey); dive fully-under vs duck-behind.

## Credentials / cleanup
- **PixelLab API keys are in the chat history — rotate them.** Latest used: the 2nd account (fresh trial). ~a dozen gens left.
- PixelLab characters still on the account: `08212ed5-...` (DMC3 rip-derived, closed coat) and `ca21a9b1-...` (open-coat, current source for walk/scenes). Delete in the PixelLab dashboard if you want the account tidy.
- Docs in repo: `SCENES.md` (scene design), `ANIMATION_PLAN.md`, this file.
- The old **3D version** work is gone; the DMC3/DMC4 3D models + `agent-companion/assets-src`, `public/model/` may still exist on disk (three.js path abandoned in favor of pixel).
