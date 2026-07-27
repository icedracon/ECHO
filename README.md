# ECHO — pixel-art Dante desktop companion

A lightweight **Tauri v2** desktop pet: a pixel-art **Dante (Devil May Cry)** who
lives on the Windows taskbar and reacts in real time to what you're doing —
your AI coding session, your typing, your music, your games. Always-on-top,
click-through, ~30–45 MB RAM.

He walks in, sits on the panel edge with his legs dangling, and lives his own
little life: works when you work, celebrates your wins, breaks down over your
error streaks, dances when you put music on, and summons a greatsword when
you launch a game.

<p align="center">
  <img src="docs/media/taskbar-sword.gif" alt="The sword move, live on the taskbar" width="260">
</p>

---

## What he does

### He types when you type
Real keystrokes only (mouse doesn't count). He pulls a laptop onto his knees,
taps along in bursts while you type, and shoves it away ~9 s after you stop.

<img src="docs/media/typing.gif" alt="Laptop out, typing, laptop away" width="200">

### He celebrates your music — плакат style
Open YouTube / Spotify / Twitch and he stands up, raises both arms, and holds a
poster above his head with a dance GIF playing on it while a song plays —
15 seconds, then back to work. Repeats every ~10 minutes while the music stays on.

<img src="docs/media/plakat-live.gif" alt="The плакат scene, captured live" width="300">

### He fights when you game
Steam launch (fullscreen **or** windowed — detected via the Steam registry and
fullscreen foreground) → a 3-shot gold Jackpot burst. While you play: gun-spin
beats at random moments, the **full sword move** every ~10 minutes, and a
**Devil Trigger with a monster-voice "JACKPOT!"** on its own 10-minute clock.
Your keys and mouse are gameplay — the laptop never appears mid-game.

The sword move — fire summon, side turn, two vertical slashes, two red energy
waves, and the blade burns away:

<p>
  <img src="docs/media/summon.gif" alt="Fire summon" width="200">
  <img src="docs/media/sword-move.gif" alt="Full sword move with energy waves" width="240">
</p>

### He dances
Star milestones and media moments trigger a dance — the classic moves or the
fist-pump headbang (a seamless loop, hit lands on the beat):

<p>
  <img src="docs/media/dance.gif" alt="Dance" width="180">
  <img src="docs/media/headbang.gif" alt="Headbang" width="180">
</p>

### He reacts to your AI session
Tails your AI coding activity locally:

| Source | Path | Mode |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | parsed → rich states |
| **Cursor** | `%APPDATA%/Cursor/User/workspaceStorage` | activity pulse |
| **Claude Desktop** | `%APPDATA%/Claude` | activity pulse |

thinking → seated ponder · coding → gun spins · a win → a smirk or a cheer ·
**3 wins in a row → Jackpot** · **3 errors → falls off the taskbar and climbs
back** · level-up → Devil Trigger. Rapid events are debounced; big scenes are
rate-limited (≥3 min apart, daily budgets) so they stay special.

### He has a life
A persistent 7-stat mood vector (energy, confidence, patience, focus,
curiosity, cockiness, boredom) drifts with time and events, survives restarts,
and tilts his idle choices: leg swings, arms crossed, pondering, watch checks,
yawns, lean-backs, naps, chuckles. After 10 minutes of silence he walks off
screen; he wanders back on his own or the moment you need him.

All 22 animation clips, one consistent Dante (PixelLab, single reference sprite):

<img src="docs/media/clips.png" alt="Every clip in the build" width="640">

### He sounds right
Synthesized in-engine (no audio assets): gunshots, thuds, blade whooshes timed
to each slash, fire ignite and ember fizz, a demonic roar — and the Devil
Trigger runs your "Jackpot!" voice clip through a live demon chain (pitch-down
layers + distortion + cavern echo).

---

## Install & run

**Easiest:** grab `ECHO.exe` from [Releases](../../releases) and run it. Done.

**From a clone:** double-click **`Start ECHO.bat`** — it finds or downloads a
prebuilt exe (building from source only as a last resort, one time), seeds
your media folder, launches Dante, and closes itself. Developers:
`Start ECHO.bat dev` for the dev server.

**Linux:** `./Start\ ECHO.sh` (builds from source). On Fedora/GNOME pick
**"GNOME on Xorg"** at login — Wayland doesn't let apps position their own
windows. Context awareness (typing/media/gaming) is Windows-only for now.

## Make him yours

Everything lives in `~/.echo/` — swap files, restart ECHO, no rebuild:

| File | What it changes |
|---|---|
| `~/.echo/media/poster.gif` | the GIF on his плакат |
| `~/.echo/media/song.mp3` | the song he plays with it |
| `~/.echo/voice/<slug>.mp3` | any spoken line (46 slugs, e.g. `jackpot.mp3`) |

Any real-named `.gif` in the repo's `public/media/` is auto-installed as the
poster by the launchers.

**Demo any scene on demand:**

```bash
echo sword > ~/.echo/demo    # the full sword move
echo devil > ~/.echo/demo    # Devil Trigger + monster JACKPOT
echo poster > ~/.echo/demo   # the плакат scene
```

## Architecture

- **Rust backend** (`src-tauri/src/`): `watcher.rs` tails the AI sources,
  `events.rs` classifies each JSONL line, `context.rs` watches typing / media /
  gaming (Win32), `store.rs` persists stars.
- **Frontend** (`src/main.ts`): a 2D pixel sprite player with per-frame timing
  (`msSeq`), a weighted never-repeat idle planner driven by the mood vector,
  and OS-window choreography for walk-ins, scenes, and the poster window.
- Every decision is logged to **`~/.echo/echo.log`**, so any behaviour is
  explainable after the fact.

## Docs

`DESIGN.md` — the behaviour spec and roadmap · `MOVES.md` — every move with
its trigger and tuning knob · `SESSION_SUMMARY.md` — dev handoff notes.
