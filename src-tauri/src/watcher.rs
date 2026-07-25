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

/// Root that Claude Code writes session JSONL into: ~/.claude/projects/**/*.jsonl
fn projects_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
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
    let Some(root) = projects_root() else {
        eprintln!("[watcher] no home dir; log watching disabled");
        return;
    };
    if !root.exists() {
        eprintln!("[watcher] {} not found; log watching disabled", root.display());
        return;
    }

    std::thread::spawn(move || {
        let mut offsets: HashMap<PathBuf, u64> = HashMap::new();
        seed_offsets(&root, &mut offsets);

        let (tx, rx) = channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[watcher] failed to init: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
            eprintln!("[watcher] failed to watch {}: {e}", root.display());
            return;
        }
        eprintln!("[watcher] watching {}", root.display());

        for res in rx {
            let Ok(event) = res else { continue };
            for path in event.paths {
                if is_jsonl(&path) {
                    process_file(&app, &store, &phrases, &mut offsets, &path);
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

    let reader = BufReader::new(&mut file);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
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

    offsets.insert(path.to_path_buf(), len);
}

fn emit(app: &AppHandle, store: &Arc<Mutex<Store>>, phrases: &Arc<Phrases>, det: Detected) {
    let (stars, level) = {
        let mut s = store.lock().unwrap();
        s.stars += det.star_delta();
        if det.star_delta() != 0 {
            s.save();
        }
        (s.stars, level_for(s.stars))
    };

    let payload = AgentEvent {
        state: det.state_key().to_string(),
        phrase: phrases.pick(det.state_key()),
        stars,
        level,
    };
    let _ = app.emit("agent-event", payload);
}
