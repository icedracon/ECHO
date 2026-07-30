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
    let want: [(&str, &[(&str, &str)]); 4] = [
        ("poster", &[("gif", "image/gif"), ("png", "image/png"), ("webp", "image/webp")]),
        ("song", &[("mp3", "audio/mpeg"), ("wav", "audio/wav"), ("ogg", "audio/ogg")]),
        // Corvin's midnight ritual: ~/.echo/media/nightsong.mp3 (user's own file)
        ("nightsong", &[("mp3", "audio/mpeg"), ("wav", "audio/wav"), ("ogg", "audio/ogg")]),
        // The 23:40 requiem — its own track if you want one, else nightsong.
        ("sadsong", &[("mp3", "audio/mpeg"), ("wav", "audio/wav"), ("ogg", "audio/ogg")]),
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
        let _ = std::fs::write(dir.join("story.json"), data);
    }
}

/// Character pack selection. Precedence:
/// 1. The exe's own name — Echo-Corvin.exe / Echo-Dante.exe are LOCKED builds
///    (one binary, two names): fans download their hero and always boot him.
/// 2. ~/.echo/character ("dante" / "corvin"), written by the live switch
///    `echo corvin > ~/.echo/demo`. Plain ECHO.exe uses this.
#[tauri::command]
fn character_load() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(stem) = exe.file_stem().and_then(|s| s.to_str()) {
            let s = stem.to_lowercase();
            if s.contains("corvin") {
                return "corvin".into();
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

/// The tray menu — the whole product with a mouse, for people who will never
/// open a terminal (user-directed). Every item just emits the same
/// context-events the `echo <word> > ~/.echo/demo` path uses, so the frontend
/// needs nothing new.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    use tauri::tray::TrayIconBuilder;
    use tauri::Emitter;

    let item = |id: &str, label: &str| MenuItemBuilder::with_id(id, label);

    let characters = SubmenuBuilder::new(app, "Персонаж")
        .item(&item("ev:demo_be_corvin", "🦅  Корвин — Страж").build(app)?)
        .item(&item("ev:demo_be_dante", "🔴  Данте — охотник").build(app)?)
        .build()?;
    let corvin_scenes = SubmenuBuilder::new(app, "Сцены Корвина")
        .item(&item("ev:demo_corvin", "Полный показ (1 мин)").build(app)?)
        .item(&item("ev:demo_fly", "Полёт Арцива по экрану").build(app)?)
        .item(&item("ev:demo_tale", "Рассказать байку").build(app)?)
        .item(&item("ev:demo_chapter", "Глава романа").build(app)?)
        .item(&item("ev:demo_night", "Ночная песня").build(app)?)
        .item(&item("ev:demo_breach", "Прорыв (большой бой)").build(app)?)
        .item(&item("ev:demo_requiem", "Реквием").build(app)?)
        .build()?;
    let dante_scenes = SubmenuBuilder::new(app, "Сцены Данте")
        .item(&item("ev:demo_devil", "Devil Trigger").build(app)?)
        .item(&item("ev:demo_sword", "Огненный меч").build(app)?)
        .item(&item("ev:demo_poster", "Плакат с песней").build(app)?)
        .item(&item("ev:demo_pizza", "Пицца").build(app)?)
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&characters)
        .separator()
        .item(&corvin_scenes)
        .item(&dante_scenes)
        .separator()
        .item(&item("ev:hotkey_song", "🎸  Сыграть песню  (ALT+S)").build(app)?)
        .item(&item("ev:quiet_hour", "🤫  Тихий час — не отвлекать").build(app)?)
        .separator()
        .item(&item("open_media", "📁  Мои песни и постеры").build(app)?)
        .item(&item("quit", "Выход").build(app)?)
        .build()?;

    TrayIconBuilder::with_id("echo-tray")
        .icon(app.default_window_icon().cloned().expect("icon"))
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
                    let _ = app.emit("context-event", context::ContextEvent { kind: "hotkey_song" });
                }
                if kind == "quiet_hour" {
                    let _ = app.emit("context-event", context::ContextEvent { kind: "quiet_hour" });
                }
            } else if id == "open_media" {
                if let Some(home) = dirs::home_dir() {
                    let dir = home.join(".echo").join("media");
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::process::Command::new("explorer").arg(dir).spawn();
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
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("echo.log")) {
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
            build_tray(app.handle())?; // the mouse-only control panel by the clock
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
            character_save
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
