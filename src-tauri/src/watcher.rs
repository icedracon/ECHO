use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::events::{classify, Detected};
use crate::phrases::Phrases;
use crate::{level_for, AgentEvent, Store};

/// How a watched source is interpreted.
enum Kind {
    /// Claude Code session logs — parsed line-by-line into rich states.
    Jsonl,
    /// Other AI tools (Cursor, Claude Desktop) — their storage isn't parseable,
    /// so any file change counts as a coarse "AI is active" pulse.
    Pulse,
}

/// Every AI log/data location ECHO watches. Missing ones are skipped.
fn sources() -> Vec<(PathBuf, Kind)> {
    let mut v = Vec::new();
    if let Some(h) = dirs::home_dir() {
        v.push((h.join(".claude").join("projects"), Kind::Jsonl)); // Claude Code
    }
    if let Some(cfg) = dirs::config_dir() {
        // %APPDATA%\Cursor\User\workspaceStorage — Cursor's chat/state SQLite.
        v.push((
            cfg.join("Cursor").join("User").join("workspaceStorage"),
            Kind::Pulse,
        ));
        v.push((cfg.join("Claude"), Kind::Pulse)); // Claude Desktop app
    }
    v.retain(|(p, _)| p.exists());
    v
}

fn is_jsonl(p: &Path) -> bool {
    p.extension().map(|e| e == "jsonl").unwrap_or(false)
}

/// Seed every existing file's offset to its current length so we only react to
/// NEW activity after launch, not replay the whole history.
fn seed_offsets(root: &Path, offsets: &mut HashMap<PathBuf, u64>) {
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                seed_offsets(&p, offsets);
            } else if is_jsonl(&p) {
                let len = e.metadata().map(|m| m.len()).unwrap_or(0);
                offsets.insert(p, len);
            }
        }
    }
}

pub fn spawn(app: AppHandle, store: Arc<Mutex<Store>>, phrases: Arc<Phrases>) {
    let srcs = sources();
    if srcs.is_empty() {
        eprintln!("[watcher] no AI log sources found; disabled");
        return;
    }

    std::thread::spawn(move || {
        let jsonl_roots: Vec<PathBuf> = srcs
            .iter()
            .filter(|(_, k)| matches!(k, Kind::Jsonl))
            .map(|(p, _)| p.clone())
            .collect();
        let pulse_roots: Vec<PathBuf> = srcs
            .iter()
            .filter(|(_, k)| matches!(k, Kind::Pulse))
            .map(|(p, _)| p.clone())
            .collect();

        // Only JSONL sources need offset seeding (so we don't replay history).
        let mut offsets: HashMap<PathBuf, u64> = HashMap::new();
        for r in &jsonl_roots {
            seed_offsets(r, &mut offsets);
        }

        let (tx, rx) = channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[watcher] failed to init: {e}");
                return;
            }
        };
        for (root, _) in &srcs {
            match watcher.watch(root, RecursiveMode::Recursive) {
                Ok(()) => eprintln!("[watcher] watching {}", root.display()),
                Err(e) => eprintln!("[watcher] failed to watch {}: {e}", root.display()),
            }
        }

        // Coarse "AI is active" pulses (Cursor / Claude Desktop) are debounced so
        // frequent autosaves don't spam the companion.
        // checked_sub: Windows Instant counts from boot — plain subtraction
        // PANICS (and with panic=abort, kills the app) when uptime < 60 s,
        // i.e. exactly the autostart-with-Windows case.
        let mut last_pulse = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(60))
            .unwrap_or_else(std::time::Instant::now);
        for res in rx {
            let Ok(event) = res else { continue };
            for path in event.paths {
                if is_jsonl(&path) && jsonl_roots.iter().any(|r| path.starts_with(r)) {
                    process_file(&app, &store, &phrases, &mut offsets, &path);
                } else if pulse_roots.iter().any(|r| path.starts_with(r)) {
                    if last_pulse.elapsed() >= std::time::Duration::from_secs(4) {
                        last_pulse = std::time::Instant::now();
                        emit(&app, &store, &phrases, Detected::Coding);
                    }
                }
            }
        }
    });
}

/// Read newly-appended lines from `path`, classify each, update stars, emit.
fn process_file(
    app: &AppHandle,
    store: &Arc<Mutex<Store>>,
    phrases: &Arc<Phrases>,
    offsets: &mut HashMap<PathBuf, u64>,
    path: &Path,
) {
    let Ok(mut file) = File::open(path) else { return };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = *offsets.get(path).unwrap_or(&0);

    // File shrank/rotated -> restart from the top.
    let start = if start > len { 0 } else { start };
    if start == len {
        return;
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }

    // The recorded offset must be the position after the last COMPLETE line we
    // consumed — never the pre-read metadata length. Snapshotting `len` first
    // both double-counted lines appended during the read (stars incremented
    // twice) and, when a partial line was mid-write, parked the offset inside
    // that line so both halves later failed to parse (event lost).
    let mut consumed = start;
    let mut reader = BufReader::new(&mut file);
    let mut buf = String::new();
    loop {
        buf.clear();
        let Ok(n) = reader.read_line(&mut buf) else { break };
        if n == 0 {
            break;
        }
        if !buf.ends_with('\n') {
            break; // partial line still being written — re-read it next event
        }
        consumed += n as u64;
        let line = buf.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(det) = classify(&v) {
            emit(app, store, phrases, det);
        }
    }

    offsets.insert(path.to_path_buf(), consumed);
}

fn emit(app: &AppHandle, store: &Arc<Mutex<Store>>, phrases: &Arc<Phrases>, det: Detected) {
    let (stars, level) = {
        let mut s = store.lock().unwrap_or_else(|p| p.into_inner());
        s.stars += det.star_delta();
        if det.star_delta() != 0 {
            s.save();
        }
        (s.stars, level_for(s.stars))
    };

    log_sync(det.state_key(), stars, level);

    let payload = AgentEvent {
        state: det.state_key().to_string(),
        phrase: phrases.pick(det.state_key()),
        stars,
        level,
    };
    let _ = app.emit("agent-event", payload);
}

/// Append every synced event to ~/.echo/echo.log so the sync is auditable.
/// Rotates to echo.log.1 once the file passes ~256 KB so it can't grow forever.
fn log_sync(state: &str, stars: i64, level: u32) {
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join(".echo");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("echo.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 256 * 1024 {
            let _ = std::fs::rename(&path, dir.join("echo.log.1"));
        }
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(f, "{ts}\t{state}\tstars={stars}\tlevel={level}");
    }
}
