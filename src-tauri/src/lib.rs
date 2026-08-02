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

// Borderless games repaint above an already-TOPMOST window, and tao's
// set_always_on_top(true) no-ops when the flag hasn't changed — so the pet
// stays buried behind the game. An unconditional SetWindowPos re-raise is the
// only thing that actually wins the z-order fight, once per gaming heartbeat.
#[cfg(target_os = "windows")]
#[tauri::command]
fn raise_topmost(window: tauri::WebviewWindow) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowPos(
            hwnd: isize,
            insert_after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
    const HWND_TOPMOST: isize = -1;
    const SWP_NOMOVE_NOSIZE_NOACTIVATE: u32 = 0x1 | 0x2 | 0x10;
    if let Ok(h) = window.hwnd() {
        unsafe {
            SetWindowPos(
                h.0 as isize,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE_NOSIZE_NOACTIVATE,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn raise_topmost(window: tauri::WebviewWindow) {
    let _ = window.set_always_on_top(true);
}

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
        // Same write-then-rename contract as story_save: a truncated stars.json
        // loads as `.unwrap_or(0)`, silently resetting the whole star count.
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, format!("{{\"stars\":{}}}", self.stars)).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
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
    // A poisoned lock must not abort the app (panic=abort) — the data is a
    // star counter, not an invariant worth dying for.
    let stars = shared.store.lock().unwrap_or_else(|p| p.into_inner()).stars;
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
async fn voice_clips() -> Vec<(String, String)> {
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
        if p.metadata()
            .map(|m| m.len() > 4 * 1024 * 1024)
            .unwrap_or(true)
        {
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
async fn poster_media() -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let dir = home.join(".echo").join("media");
    let want: [(&str, &[(&str, &str)]); 4] = [
        (
            "poster",
            &[
                ("gif", "image/gif"),
                ("png", "image/png"),
                ("webp", "image/webp"),
            ],
        ),
        (
            "song",
            &[
                ("mp3", "audio/mpeg"),
                ("wav", "audio/wav"),
                ("ogg", "audio/ogg"),
            ],
        ),
        // Corvin's midnight ritual: ~/.echo/media/nightsong.mp3 (user's own file)
        (
            "nightsong",
            &[
                ("mp3", "audio/mpeg"),
                ("wav", "audio/wav"),
                ("ogg", "audio/ogg"),
            ],
        ),
        // The 23:40 requiem — its own track if you want one, else nightsong.
        (
            "sadsong",
            &[
                ("mp3", "audio/mpeg"),
                ("wav", "audio/wav"),
                ("ogg", "audio/ogg"),
            ],
        ),
    ];
    for (stem, exts) in want {
        for (ext, mime) in exts {
            let p = dir.join(format!("{stem}.{ext}"));
            if !p.is_file() {
                continue;
            }
            if p.metadata()
                .map(|m| m.len() > 12 * 1024 * 1024)
                .unwrap_or(true)
            {
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

/// M2 сюжет: story state (tenure, firsts, day stats) lives in ~/.echo/story.json —
/// user-visible, survives reinstalls, greppable. JSON passthrough; the frontend
/// owns the shape.
#[tauri::command]
fn story_load() -> String {
    let Some(home) = dirs::home_dir() else {
        return String::new();
    };
    std::fs::read_to_string(home.join(".echo").join("story.json")).unwrap_or_default()
}

#[tauri::command]
fn story_save(data: String) {
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(".echo");
        let _ = std::fs::create_dir_all(&dir);
        // Write-then-rename. `fs::write` truncates BEFORE writing, and this is
        // called about once a minute, so a kill in that window (with
        // panic = "abort", any panic anywhere is a kill) left a truncated
        // story.json. The frontend cannot repair that — it discards the file
        // whole and overwrites it with a fresh state, so tenure, firsts, ritual
        // clocks, the novel pointer and the learned director weights all went.
        // Rename is atomic on NTFS and POSIX alike: the old file survives.
        let tmp = dir.join("story.json.tmp");
        if std::fs::write(&tmp, data).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("story.json"));
        }
    }
}

/// Character pack selection. Precedence:
/// 1. The exe's own name — ECHO-Corvin.exe / ECHO-Dante.exe / ECHO-Kael.exe
///    are LOCKED builds (one binary, three names): fans download their hero and
///    always boot him.
/// 2. ~/.echo/character ("dante" / "corvin" / "kael"), written by the live switch
///    `echo corvin > ~/.echo/demo`. Plain ECHO.exe uses this.
#[tauri::command]
fn character_load() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(stem) = exe.file_stem().and_then(|s| s.to_str()) {
            let s = stem.to_lowercase();
            if s.contains("corvin") {
                return "corvin".into();
            }
            if s.contains("kael") {
                return "kael".into();
            }
            if s.contains("dante") {
                return "dante".into();
            }
        }
    }
    let Some(home) = dirs::home_dir() else {
        return String::new();
    };
    std::fs::read_to_string(home.join(".echo").join("character"))
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default()
}

#[tauri::command]
fn character_save(name: String) {
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(".echo");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("character"), name);
    }
}

fn open_folder(path: &std::path::Path) {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();
    let _ = result;
}

/// Frontend diagnostics -> ~/.echo/echo-fe.log (so overlay behaviour is auditable).
/// Rotates at ~256 KB — heartbeat context events land here every few seconds,
/// so without rotation the file grew forever.
#[tauri::command]
fn fe_log(line: String) {
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(".echo");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("echo-fe.log");
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > 256 * 1024 {
                let _ = fs::rename(&path, dir.join("echo-fe.log.1"));
            }
        }
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "{ts}\t{line}");
        }
    }
}

/// The tray is intentionally not a scene console. It keeps only character and
/// comfort controls; scenes belong to triggers, hotkeys, directors and clocks.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    use tauri::tray::TrayIconBuilder;
    use tauri::Emitter;

    let item = |id: &str, label: &str| MenuItemBuilder::with_id(id, label);

    let characters = SubmenuBuilder::new(app, "Персонаж")
        .item(&item("ev:demo_be_corvin", "🦅  Корвин — Страж").build(app)?)
        .item(&item("ev:demo_be_dante", "🔴  Данте — охотник").build(app)?)
        .item(&item("ev:demo_be_kael", "🟣  Каэль — Разлом").build(app)?)
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&characters)
        .separator()
        .item(&item("ev:quiet_hour", "🤫  Тихий час — не отвлекать").build(app)?)
        .separator()
        .item(&item("help", "Как управлять ECHO").build(app)?)
        .item(&item("open_media", "📁  Мои песни и постеры").build(app)?)
        .item(&item("quit", "Выход").build(app)?)
        .build()?;

    TrayIconBuilder::with_id("echo-tray")
        .icon(match app.default_window_icon().cloned() {
            Some(i) => i,
            None => return Ok(()), // no icon -> no tray, but the app LIVES
        })
        .tooltip("ECHO — твой компаньон")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if let Some(kind) = id.strip_prefix("ev:") {
                clog_tray(kind);
                // Scene/switch items route through the demo file — the same
                // path `echo <word> > ~/.echo/demo` fans already use, so the
                // frontend needs zero new handlers for them.
                let word = match kind {
                    "demo_be_corvin" => Some("corvin"),
                    "demo_be_dante" => Some("dante"),
                    "demo_be_kael" => Some("kael"),
                    "demo_corvin" => Some("reel"),
                    "demo_fly" => Some("fly"),
                    "demo_tale" => Some("tale"),
                    "demo_chapter" => Some("chapter"),
                    "demo_night" => Some("night"),
                    "demo_breach" => Some("breach"),
                    "demo_requiem" => Some("requiem"),
                    "demo_devil" => Some("devil"),
                    "demo_sword" => Some("sword"),
                    "demo_poster" => Some("poster"),
                    "demo_pizza" => Some("pizza"),
                    _ => None,
                };
                if let (Some(w), Some(home)) = (word, dirs::home_dir()) {
                    let _ = std::fs::write(home.join(".echo").join("demo"), w);
                }
                if kind == "hotkey_song" {
                    let _ = app.emit(
                        "context-event",
                        context::ContextEvent {
                            kind: "hotkey_song",
                        },
                    );
                }
                if kind == "quiet_hour" {
                    let _ = app.emit(
                        "context-event",
                        context::ContextEvent { kind: "quiet_hour" },
                    );
                }
            } else if id == "help" {
                let _ = app.emit(
                    "context-event",
                    context::ContextEvent {
                        kind: "show_help".into(),
                    },
                );
            } else if id == "open_media" {
                if let Some(home) = dirs::home_dir() {
                    let dir = home.join(".echo").join("media");
                    let _ = std::fs::create_dir_all(&dir);
                    open_folder(&dir);
                }
            } else if id == "quit" {
                std::process::exit(0);
            }
        })
        .build(app)?;
    Ok(())
}

fn clog_tray(kind: &str) {
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(".echo");
        let _ = fs::create_dir_all(&dir);
        if let Ok(mut f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("echo.log"))
        {
            use std::io::Write;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "{ts}\ttray\t{kind}");
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
            // The tray is a convenience, not the product. Propagating this `?`
            // made every menu/icon construction error abort `setup`, which the
            // `.expect` on Builder::run turns into an instant silent death —
            // no window, no console (windows_subsystem), no dialog. build_tray
            // already degrades gracefully when the ICON is missing ("the app
            // LIVES"); honour the same contract for the rest of it, e.g. a
            // Linux box without a working appindicator backend.
            if let Err(e) = build_tray(app.handle()) {
                clog_tray(&format!("tray unavailable, continuing without it: {e}"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            idle_phrase,
            fe_log,
            voice_clips,
            poster_media,
            story_load,
            story_save,
            character_load,
            character_save,
            raise_topmost
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
