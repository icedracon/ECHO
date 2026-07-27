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

1. **You CANNOT screenshot his window.** It's transparent + click-through +
   always-on-top; computer-use screenshots never contain him. **Never** claim a
   visual is verified. Use the logs, and ask the user what they see.
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
