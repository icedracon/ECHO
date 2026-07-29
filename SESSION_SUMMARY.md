# ECHO — Session Handoff (2026-07-26)

Read this + `DESIGN.md` (architecture/plan) + `MOVES.md` (every move & its knob)
before changing behaviour.

---

## 1. What ECHO is

A **Tauri v2** desktop companion: pixel-art **Dante (DMC)** who lives on the
Windows taskbar and reacts in character to your AI session *and* to what you do
on the machine. ~30 MB RAM, click-through, always-on-top.

- **Path:** `C:\Users\zevs\Documents\agent-companion`
- **Run:** `Start ECHO.bat`, or build with `npm run tauri build` → `src-tauri/target/release/ECHO.exe`
- **Repo:** `github.com/icedracon/ECHO` (private). Last tag: **v0.0.1**
- Creative/gamedev project — nothing security-related applies here.

---

## 2. ⚠️ Hard-won lessons (read before debugging anything)

These cost hours. Don't rediscover them.

1. **You CAN screenshot his window — but only via BitBlt + CAPTUREBLT.**
   Normal/computer-use screenshots never contain him, but a PowerShell
   Add-Type with `BitBlt(SRCCOPY | CAPTUREBLT)` captures layered windows.
   Burst-capture (~200 ms/frame) + a decoy window (`cmd /k title youtube`)
   lets you trigger and SEE any scene yourself. Kill decoys by Win32 title
   (EnumWindows), NOT .NET MainWindowTitle — minimized cmd reports "" there
   and lingering decoys block the next media edge. Verify visually this way;
   the user is no longer the only ground truth.
2. **Debug via logs:**
   - `~/.echo/echo.log` — backend (watcher, `ctx` context lines)
   - `~/.echo/echo-fe.log` — frontend (`dbg()` → `fe_log` command)
3. **`device_query` reads NO keys on this machine.** Proven by log
   (`seen_any=false` while user typed). Replaced with Win32 `GetAsyncKeyState`
   + `GetLastInputInfo` — that works.
4. **`tasklist /v` shows browser window titles as "N/A"** → it can never detect a
   YouTube tab. Use `EnumWindows` + `GetWindowTextW` instead.
5. **Browsers use DNS-over-HTTPS**, so `ipconfig /displaydns` never sees
   youtube/spotify (it *does* see native apps like Steam). Hence the dual
   detection: DNS cache **+** window titles.
6. **Typing bugs were usually MY OWN GATES**, not detection. Gating on
   `state === "idle"` fails during a chat, because AI events never stop.
7. **Art landing mid-build isn't bundled** — Vite copies `public/` at build
   start. Re-run the build after new sprites land, and verify `dist/` mtime.
8. **Each JSONL block is its own line** → states get clobbered in ms. That's why
   `MIN_HOLD` exists.
9. Build takes ~1-3 min (Rust). Always kill `ECHO.exe` first — it locks the exe.
10. **Never pipe builds through `| tail`** — the pipeline exit code is tail's,
    so `&&` proceeds after a FAILED build and relaunches the stale exe. Use
    `if npm run tauri build > log; then ... else tail log; fi`.
11. `commit.gpgsign=true` + `pinentry-mode loopback` = commits fail in
    non-interactive sessions. User caches passphrase (`echo test | gpg
    --clearsign`) or explicitly asks for `-c commit.gpgsign=false`.
12. Art generation: `POST https://api.pixellab.ai/v2/animate-with-text-v3`
    (max 256x256 — our 84x107 fits; 4-16 EVEN frames; ~$0.02/gen; async via
    `/background-jobs/{id}`). Committed pipeline: `scripts/gen_anim.py`.
    The old v1 `/animate-with-text` is hard-capped at 64x64 — don't use it.
    Balance check: `GET /v2/balance` with the Bearer key from `.env`.

---

## 3. Architecture (v2, five layers)

```
AI events + OS context → Behavior Engine → Life Model → Planner → Anim/Voice/FX
```

| File | Role |
|---|---|
| `src-tauri/src/watcher.rs` | tails Claude Code JSONL + Cursor/Claude Desktop pulses |
| `src-tauri/src/events.rs` | JSONL line → state |
| `src-tauri/src/context.rs` | **OS awareness**: typing (Win32), media/game (DNS + window titles) |
| `src-tauri/src/lib.rs` | commands: `get_state`, `idle_phrase`, `voice_clips`, `fe_log` |
| `src/life.ts` | evolving state vector, persisted to localStorage |
| `src/planner.ts` | decisions: weighted idle, voice cooldowns, scene budget |
| `src/main.ts` | glue: clips, scenes, window choreography, attention budget |

**Life vector** (0–1, drifts/decays, nudged by events, persisted):
`energy · confidence · patience · focus · curiosity · cockiness · boredom` →
derived `mood`. Logged every 20 s so non-deterministic behaviour stays explainable.

---

## 4. What he does now

- **Entrance:** walks in → stands → looks around → sits on the taskbar. No reel.
- **Idle:** weighted, **never-repeat** seated poses (swing/cross/think/watch/
  yawn/leanback/nap/laugh), each holding still up to ~60 s. Mood shifts weights.
- **Working:** thinking = seated ponder; coding = gun-spin; searching = arms
  crossed; speaking = gesture. Posture hysteresis (6 s) stops sit/stand flapping.
- **Reactions:** small win = smirk+ding; small error = shrug+thud.
  **3 wins → Jackpot**; 25★ → dance; frustration (low patience) → fall+climb;
  level-up → Devil Trigger. Also **Devil Trigger once an hour**.
- **Context:** you type → **laptop on knees, types with you** (continues while you
  type). YouTube/Spotify → **15 s dance, repeating every ~10 min** while open.
  Steam → 3-shot burst + gaming mood (spins → sit → legs → chuckle; hourly
  Jackpot + fall/climb).
- **Presence:** 10 min no AI activity → walks off; **auto-returns ~10 min later**;
  any AI event brings him straight back.
- **Attention budget:** ambient chatter ~12 % visible & silent; voice ≥150 s
  apart + per-line 20 min cooldown; scenes ≥3 min apart + daily caps; **silent
  during bursts** (>12 events/30 s).
- **Voice:** 46 ElevenLabs clips in `~/.echo/voice/*.mp3` (slug of the line);
  synthesized blip fallback. SFX all through a master gain (`SFX_VOLUME`).

---

## 5. Credentials — ROTATE THESE

All are in the old chat history and **must be rotated**:
- **ElevenLabs** key → `.env` (gitignored, verified). Regenerate voice with
  `python scripts/gen_voice.py` (skips existing clips).
- **PixelLab** keys (several burned; last one had 40 gens). Used by the
  `scripts/gen_*.py` pattern → `animate-with-text-v3` from a base frame.
- Never commit `.env`, `public/model/`, `assets-src/`, `target/`.

---

## 5b. Added 2026-07-27 (uncommitted on top of v0.0.2)

- **Typing v3**: laptop-out one-shot → 4-frame hands-only tap loop (`typetap`,
  bursty msSeq rhythm) → reversed put-away. Mouse input no longer counts as
  typing (idle_ms is anchored to real typing keys). Gaming suppresses typing.
- **msSeq engine**: per-frame durations on any clip; eased take-out, accelerating
  close, beat-accented dance; 200-400 ms "noticing" delay before win/error.
- **Поster scene**: media open → stands, arms up (dance frame 5), a second
  frameless window (`index.html?poster=1`) shows a gif above his hands, song
  plays, ±3 px bob, 15 s. Bundled defaults `public/media/poster.gif|song.mp3`
  (song is gitignored — no copyrighted audio in repo); `~/.echo/media/*`
  overrides both. Window shapes itself to the gif aspect, clamped on-screen.
- **Scene budget unified**: media/gaming scenes markScene() + sceneAllowed();
  no ambient bubbles over scenes; relaunch no longer insta-dances.
- **Single-instance plugin** (two Dantes impossible); context log names the
  matching window title; `ipconfig` spawn uses CREATE_NO_WINDOW (console
  flash fixed); Linux monitor-null fallback (Wayland still can't position).
- **Start ECHO.bat rewritten**: prebuilt-first for normal users, one-time
  release build otherwise, console closes after launch; `dev` arg = old flow.
  NOTE: download URL needs a PUBLIC release to actually work.

## 6. State & immediate next steps

**Uncommitted work in the tree** (~14 files) — typing priority fix, media
session, new dance art, laptop-typing art, EnumWindows detection, posture
hysteresis. **Verify then commit as v0.0.2.**

Next, in order:
1. **Verify with the user** (only they can see him): laptop-typing fires while
   typing; YouTube dance repeats; no sit/stand flapping.
2. **Commit + tag v0.0.2**, push to `icedracon/ECHO`.
3. **P3 — live-test a full day**, tune §5 dials in `DESIGN.md` from real feel.
4. **P4 — `~/.echo/config.json`** (`config.example.json` already written):
   presets, `muteWhenFullscreen`, `quietHours` — tune without rebuilding.
5. Later: duration-escalation (thinking 3 s vs 90 s → pace → sigh), win-size
   scaling from turn size, rare relocation to another monitor.

**Rule from the plan:** don't add features until the user has actually lived
with it for a day.

---

## 7. Working style that worked

- The user iterates fast and reports what he *sees*; he is the only visual
  ground truth. Ask him to confirm, don't assume.
- Diagnose with logs and state facts plainly; when something was never verified,
  say so.
- Keep clips consistent: one Dante, generated from a single base sprite. Never
  mix art styles. No copyrighted audio/frames in the repo — original only.

---

# Handoff 2026-07-29 — Corvin's first sheet is LIVE

## What exists now
- **20 Corvin moves, 203 frames** in `public/pixel/corvin/` (sources in
  `assets-src/wip/corvin/`), all user-approved from GIF previews one by one.
- **`src/corvin.ts`** — the clip catalogue with hand-tuned msSeq timings
  (= the approved preview pacing). Table in `MOVES.md` §J.
- **Showcase reel**: `echo corvin > ~/.echo/demo` → full reel on the taskbar
  (walk-in, bow, charge, execution, FULL shadow aura, sit + whetstone tale,
  guitar + hovering Artsiv, vigil with the eagle, Artsiv takeoff/landing,
  meditate, mirrored knightly walk-out). Verified frame-by-frame with the
  BitBlt capture rig — no Dante flashes (playCorvin commits per clip).
- Dante gaming beats FIXED and verified: `game_start` event (Steam
  RunningAppID / fullscreen edge) arms devil@3:00, sword@7:00, then 10-min
  cadences; TOPMOST re-asserted each heartbeat (borderless games show him;
  exclusive fullscreen cannot be drawn over). Beat loop try/catch + skip logs.
- PixelLab: key `7e9bb8f8...` active (~19 gens left), old key in `.env` as
  `PIXELLAB_API_KEY_OLD` (~2.5 gens).

## Key techniques that worked (reuse these)
- Prompt alone won't engulf the body in aura: PAINT the peak frame (PIL:
  dilated-silhouette flame halo + floor pool), then generate rise/burn/sink
  with pinned endpoints. `aura_peak_anchor.png` is the canon aura peak.
- Pinning first=last to base KILLS big pose changes (raise attempt just glowed
  the blade — that became the charge move). Free the last frame, then use its
  final frame as the next stage's anchor.
- Donor transplants: guitar + flying eagle came from the banned white-face
  still (`key_guitar.png`) — objects are usable, faces are not. The standalone
  `artsivfly` sprite was cropped from the guitar loop, zero credits.

## Tomorrow (user said: continue generating new moves)
1. New moves via the one-by-one verdict loop (queue ideas: Unchained DT-analog
   from aura peak, hunt-watch stance for Steam, storyteller gesture variants,
   Artsiv shoulder-nuzzle, damage/stagger reaction).
2. Then the real pack integration: character switch (`~/.echo/character`),
   scene remaps (Jackpot→Execution, плакат→guitar, DT→Unchained,
   Breakdown→vigil), tales.ts wiring with story.json arc pointers, resting
   vector (DESIGN §12b), Artsiv free-flight during Steam (engine-driven
  `artsivfly` sprite on its own element).
