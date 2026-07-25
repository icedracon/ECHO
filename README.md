# ECHO — pixel-art Dante desktop companion

A lightweight **Tauri v2** desktop pet: a pixel-art **Dante (Devil May Cry)** who
lives on the Windows taskbar and reacts in real time to your AI coding session.
Always-on-top, click-through, ~30–45 MB RAM.

He walks in, sits on the panel edge with his legs dangling, and mirrors what your
AI is doing — thinking, coding, celebrating a finished task, dancing at milestones.
When you stop working he takes a break; when you start again he walks back in.

## Run

```bash
npm install
npm run tauri build
```

Then double-click **`Start ECHO.bat`** (launches the built `ECHO.exe`, or falls
back to `npm run tauri dev`). Installers are also produced under
`src-tauri/target/release/bundle/`.

## How it syncs

A Rust file-watcher tails local AI logs and maps activity to Dante's state:

| Source | What's read | Detail |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | full per-message states (thinking / coding / searching / speaking / success / error) |
| **Cursor** | `%APPDATA%/Cursor/User/workspaceStorage` | activity pulse — "AI in use" |
| **Claude Desktop** | `%APPDATA%/Claude` | activity pulse |

ChatGPT and Gemini run in the browser with no local logs, so they aren't tailed
(that would need a browser extension).

Every synced event is appended to **`~/.echo/echo.log`** (`timestamp  state
stars  level`), which rotates at ~256 KB.

## Behaviour

- **Idle rotation** (seated): swings his legs → crosses arms and rests → ponders
  and rests → repeats. Calm, not fidgety.
- **Working** (standing): reacts to coding / searching / speaking.
- **Success** → "Jackpot" gun-shoot; every 25★ → a dance.
- **Error** → falls under the panel and climbs back up.
- **Level up** → red "Devil Trigger" aura.
- **Presence** — after 10 min with no AI activity he crosses his arms, says a
  line, and walks off. The next AI event walks him back in and sits him down.

## Architecture

- **Rust backend** (`src-tauri/src/`): `watcher.rs` tails the sources above,
  `events.rs` classifies each JSONL line, `store.rs` persists stars, emits
  `agent-event` to the UI.
- **Frontend** (`src/main.ts` + `styles.css`): a 2D pixel sprite player. Each
  state maps to a 9-frame clip in `public/pixel/*`; the OS window is moved for
  the walk-in, sit, and scene choreography.

Phrases are in `src-tauri/phrases/`. All character art is the same Dante,
generated with PixelLab from a single reference sprite for a consistent look.
