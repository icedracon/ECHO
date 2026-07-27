// Context awareness — ECHO reacts to what you're doing on the WHOLE machine,
// not just the AI session. Everything here is 100% local: no network calls, no
// keystroke *content* (only "keys are moving"), just the local DNS cache and
// running-app signals. Emits a `context-event` {kind} the frontend maps to a beat.

use std::collections::HashSet;
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};


#[derive(Clone, Serialize)]
pub struct ContextEvent {
    pub kind: &'static str, // "typing" | "media" | "gaming"
}

pub fn spawn(app: AppHandle) {
    spawn_typing(app.clone());
    spawn_dns(app);
}

/// Append a diagnostic line to ~/.echo/echo.log (the overlay can't be screenshotted,
/// so backend visibility matters).
fn clog(msg: &str) {
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join(".echo");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("echo.log"))
    {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{ts}\tctx\t{msg}");
    }
}

// --- Typing: you're at the keyboard -> he works alongside you ----------------
// device_query returned nothing on this machine, so we poll Win32 directly:
// GetAsyncKeyState reports global key state regardless of window focus.
#[cfg(windows)]
#[repr(C)]
struct LastInputInfo {
    cb_size: u32,
    dw_time: u32,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(v_key: i32) -> i16;
    fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetTickCount() -> u32;
}

/// Milliseconds since the user last touched keyboard/mouse (u32::MAX if unknown).
/// A second, independent signal — GetAsyncKeyState only sees a key at the exact
/// instant it's held, so fast typing between polls can slip through.
#[cfg(windows)]
fn idle_ms() -> u32 {
    unsafe {
        let mut lii = LastInputInfo {
            cb_size: std::mem::size_of::<LastInputInfo>() as u32,
            dw_time: 0,
        };
        if GetLastInputInfo(&mut lii) == 0 {
            return u32::MAX;
        }
        GetTickCount().wrapping_sub(lii.dw_time)
    }
}

#[cfg(not(windows))]
fn idle_ms() -> u32 {
    u32::MAX
}

#[cfg(windows)]
fn any_typing_key_down() -> bool {
    // backspace, tab, enter, space, 0-9, A-Z, and common punctuation
    const KEYS: &[i32] = &[0x08, 0x09, 0x0D, 0x20, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0];
    unsafe {
        for &k in KEYS {
            if GetAsyncKeyState(k) as u16 & 0x8000 != 0 {
                return true;
            }
        }
        for k in 0x30..=0x5A {
            // 0-9 and A-Z
            if GetAsyncKeyState(k) as u16 & 0x8000 != 0 {
                return true;
            }
        }
    }
    false
}

#[cfg(not(windows))]
fn any_typing_key_down() -> bool {
    false
}

fn spawn_typing(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_emit = Instant::now() - Duration::from_secs(60);
        let mut ticks: u64 = 0;
        let mut seen_any = false;
        clog("typing watcher started (win32)");
        loop {
            std::thread::sleep(Duration::from_millis(120));
            ticks += 1;
            // Either signal counts: a key held right now, or the OS reporting
            // input within the last ~700 ms (catches fast typing between polls).
            let active = any_typing_key_down() || idle_ms() < 700;
            if active {
                if !seen_any {
                    seen_any = true;
                    clog("first input seen (win32)");
                }
                if last_emit.elapsed() > Duration::from_secs(6) {
                    last_emit = Instant::now();
                    clog("emit typing");
                    let _ = app.emit("context-event", ContextEvent { kind: "typing" });
                }
            }
            if ticks % 500 == 0 {
                clog(&format!(
                    "typing watcher alive (seen_any={seen_any} idle_ms={})",
                    idle_ms()
                ));
            }
        }
    });
}

// --- DNS cache: what sites you've opened -> media dances, games shoot --------
const MEDIA: &[&str] = &[
    "youtube", "ytimg", "googlevideo", "spotify", "scdn.co", "soundcloud",
    "twitch", "ttvnw", "netflix", "nflxvideo", "music.apple",
];
const GAMES: &[&str] = &[
    "steampowered", "steamcommunity", "steamstatic", "steam-", "epicgames",
    "riotgames", "riotcdn", "battle.net", "blizzard", "ubisoft", "ea.com",
];

fn read_dns() -> HashSet<String> {
    let mut set = HashSet::new();
    let Ok(out) = Command::new("ipconfig").arg("/displaydns").output() else {
        return set;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        // "    Record Name . . . . . : www.youtube.com"
        if let Some(idx) = line.find(':') {
            if line.to_lowercase().contains("record name") {
                let name = line[idx + 1..].trim().to_lowercase();
                if !name.is_empty() {
                    set.insert(name);
                }
            }
        }
    }
    set
}

fn classify(domain: &str) -> Option<&'static str> {
    if GAMES.iter().any(|p| domain.contains(p)) {
        return Some("gaming");
    }
    if MEDIA.iter().any(|p| domain.contains(p)) {
        return Some("media");
    }
    None
}

// Browsers use DNS-over-HTTPS, so the OS DNS cache never sees youtube/spotify.
// Window TITLES do ("... - YouTube - Google Chrome"), so we read those too.
const MEDIA_TITLES: &[&str] = &[
    "youtube", "spotify", "twitch", "netflix", "soundcloud", "vk видео", "vk video",
    "кинопоиск", "rutube",
];
const GAME_TITLES: &[&str] = &["steam", "epic games", "battle.net", "riot client"];

// `tasklist /v` reports browser titles as "N/A", so it can never see a YouTube
// tab. Enumerating top-level windows and reading their captions does work.
#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn EnumWindows(cb: extern "system" fn(isize, isize) -> i32, lparam: isize) -> i32;
    fn GetWindowTextW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
}

#[cfg(windows)]
thread_local! {
    static TITLES: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(windows)]
extern "system" fn collect_title(hwnd: isize, _l: isize) -> i32 {
    unsafe {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n > 0 {
            let s = String::from_utf16_lossy(&buf[..n as usize]).to_lowercase();
            TITLES.with(|t| t.borrow_mut().push(s));
        }
    }
    1 // keep enumerating
}

#[cfg(windows)]
fn window_titles() -> Vec<String> {
    TITLES.with(|t| t.borrow_mut().clear());
    unsafe {
        EnumWindows(collect_title, 0);
    }
    TITLES.with(|t| t.borrow().clone())
}

#[cfg(not(windows))]
fn window_titles() -> Vec<String> {
    Vec::new()
}

fn spawn_dns(app: AppHandle) {
    std::thread::spawn(move || {
        // Seed with what's already there so we only react to NEW activity
        // (Steam already running at launch shouldn't trigger a shoot).
        let mut seen = read_dns();
        let mut had_media = false;
        let mut had_game = false;
        let mut last_media = Instant::now() - Duration::from_secs(600);
        let mut last_game = Instant::now() - Duration::from_secs(600);
        {
            let titles = window_titles();
            had_media = titles.iter().any(|t| MEDIA_TITLES.iter().any(|k| t.contains(k)));
            had_game = titles.iter().any(|t| GAME_TITLES.iter().any(|k| t.contains(k)));
        }
        loop {
            std::thread::sleep(Duration::from_secs(10));
            let mut fire_media = false;
            let mut fire_game = false;

            // 1) DNS cache (catches native apps like Steam)
            let now = read_dns();
            for d in now.difference(&seen) {
                match classify(d) {
                    Some("gaming") => fire_game = true,
                    Some("media") => fire_media = true,
                    _ => {}
                }
            }
            seen = now;

            // 2) Window titles (catches browser tabs — YouTube etc.), edge-triggered
            let titles = window_titles();
            let media_now = titles.iter().any(|t| MEDIA_TITLES.iter().any(|k| t.contains(k)));
            let game_now = titles.iter().any(|t| GAME_TITLES.iter().any(|k| t.contains(k)));
            if media_now && !had_media {
                fire_media = true;
                clog("media window detected");
            }
            if game_now && !had_game {
                fire_game = true;
                clog("game window detected");
            }
            had_media = media_now;
            had_game = game_now;

            if fire_game && last_game.elapsed() > Duration::from_secs(120) {
                last_game = Instant::now();
                let _ = app.emit("context-event", ContextEvent { kind: "gaming" });
            } else if fire_media && last_media.elapsed() > Duration::from_secs(120) {
                last_media = Instant::now();
                let _ = app.emit("context-event", ContextEvent { kind: "media" });
            }

            // Heartbeats: Steam / a video still open -> he stays in that mood
            // (the frontend keeps a session window alive from these).
            if game_now {
                let _ = app.emit("context-event", ContextEvent { kind: "gaming_active" });
            }
            if media_now {
                let _ = app.emit("context-event", ContextEvent { kind: "media_active" });
            }
        }
    });
}
