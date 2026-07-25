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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_state, idle_phrase])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
