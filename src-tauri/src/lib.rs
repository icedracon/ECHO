mod context;
mod events;
mod phrases;
mod watcher;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use phrases::Phrases;
use serde::Serialize;
use tauri::Manager;

/// Persisted progress. Day 1: just stars.
#[derive(Default)]
pub struct Store {
    pub stars: i64,
    path: PathBuf,
}

impl Store {
    fn load(dir: &PathBuf) -> Self {
        let path = dir.join("stars.json");
        let stars = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("stars").and_then(|n| n.as_i64()))
            .unwrap_or(0);
        Store { stars, path }
    }

    fn save(&self) {
        let _ = fs::write(&self.path, format!("{{\"stars\":{}}}", self.stars));
    }
}

/// Star -> level per the design doc's table.
pub fn level_for(stars: i64) -> u32 {
    match stars {
        i64::MIN..=20 => 1,
        21..=60 => 2,
        61..=150 => 3,
        151..=400 => 4,
        _ => 5,
    }
}

/// Payload pushed to the overlay on every reaction.
#[derive(Serialize, Clone)]
pub struct AgentEvent {
    pub state: String,
    pub phrase: Option<String>,
    pub stars: i64,
    pub level: u32,
}

/// Shared, thread-safe app state (watcher thread + commands both touch it).
pub struct Shared {
    pub store: Arc<Mutex<Store>>,
    pub phrases: Arc<Phrases>,
}

#[tauri::command]
fn get_state(shared: tauri::State<Shared>) -> AgentEvent {
    let stars = shared.store.lock().unwrap().stars;
    AgentEvent {
        state: "idle".into(),
        phrase: None,
        stars,
        level: level_for(stars),
    }
}

/// A random idle line, driven by the frontend inactivity timer.
#[tauri::command]
fn idle_phrase(shared: tauri::State<Shared>) -> Option<String> {
    shared.phrases.pick("idle")
}

/// User-supplied voice clips from ~/.echo/voice/<name>.(wav|mp3|ogg).
/// Returned as (name, data-url) so the webview can play them directly.
/// Nothing ships with ECHO — whatever the user drops in is theirs.
#[tauri::command]
fn voice_clips() -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let dir = home.join(".echo").join("voice");
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        let Some(ext) = p.extension().and_then(|s| s.to_str()) else {
            continue;
        };
        let mime = match ext.to_ascii_lowercase().as_str() {
            "wav" => "audio/wav",
            "mp3" => "audio/mpeg",
            "ogg" => "audio/ogg",
            _ => continue,
        };
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // Keep it sane: skip anything huge for a one-liner clip.
        if p.metadata().map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(true) {
            continue;
        }
        if let Ok(bytes) = fs::read(&p) {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            out.push((stem.to_lowercase(), format!("data:{mime};base64,{b64}")));
        }
    }
    out
}

/// Poster-scene media from ~/.echo/media (user's own files, never committed):
/// poster.gif|png|webp + song.mp3|wav|ogg -> data URLs. Empty if none.
#[tauri::command]
fn poster_media() -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let dir = home.join(".echo").join("media");
    let want: [(&str, &[(&str, &str)]); 2] = [
        ("poster", &[("gif", "image/gif"), ("png", "image/png"), ("webp", "image/webp")]),
        ("song", &[("mp3", "audio/mpeg"), ("wav", "audio/wav"), ("ogg", "audio/ogg")]),
    ];
    for (stem, exts) in want {
        for (ext, mime) in exts {
            let p = dir.join(format!("{stem}.{ext}"));
            if !p.is_file() {
                continue;
            }
            if p.metadata().map(|m| m.len() > 12 * 1024 * 1024).unwrap_or(true) {
                continue; // sane cap: it's a 15s poster beat, not a movie
            }
            if let Ok(bytes) = fs::read(&p) {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                out.push((stem.to_string(), format!("data:{mime};base64,{b64}")));
                break;
            }
        }
    }
    out
}

/// Frontend diagnostics -> ~/.echo/echo-fe.log (so overlay behaviour is auditable).
#[tauri::command]
fn fe_log(line: String) {
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(".echo");
        let _ = fs::create_dir_all(&dir);
        if let Ok(mut f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("echo-fe.log"))
        {
            use std::io::Write;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "{ts}\t{line}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch exits immediately instead of
        // putting two Dantes on the taskbar.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let _ = fs::create_dir_all(&data_dir);

            let store = Arc::new(Mutex::new(Store::load(&data_dir)));
            let phrases = Arc::new(Phrases::load_default());

            app.manage(Shared {
                store: store.clone(),
                phrases: phrases.clone(),
            });

            watcher::spawn(app.handle().clone(), store, phrases);
            context::spawn(app.handle().clone()); // typing / media / gaming awareness
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            idle_phrase,
            fe_log,
            voice_clips,
            poster_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
