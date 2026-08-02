// Context awareness — ECHO reacts to what you're doing on the WHOLE machine,
// not just the AI session. Everything here is 100% local: no network calls, no
// keystroke *content* (only "keys are moving"), just the local DNS cache and
// running-app signals. Emits a `context-event` {kind} the frontend maps to a beat.

use std::collections::HashSet;
use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(windows)]
use notify::{RecursiveMode, Watcher};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct ContextEvent {
    pub kind: &'static str, // "typing" | "media" | "gaming"
}

pub fn spawn(app: AppHandle) {
    spawn_recycle_bin(app.clone());
    spawn_typing(app.clone());
    spawn_dns(app);
}

fn classify_recycle_change(previous: usize, current: usize) -> Option<(&'static str, usize)> {
    if previous > 0 && current == 0 {
        return Some(("bin_emptied", previous));
    }
    let added = current.saturating_sub(previous);
    match added {
        1..=4 => Some(("file_deleted", added)),
        5.. => Some(("files_purged", added)),
        _ => None,
    }
}

#[cfg(windows)]
fn current_user_sid() -> Option<String> {
    let output = Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let csv = String::from_utf8_lossy(&output.stdout);
    csv.trim()
        .trim_matches('"')
        .split("\",\"")
        .nth(1)
        .map(|sid| sid.trim_matches('"').trim().to_owned())
        .filter(|sid| sid.starts_with("S-1-"))
}

#[cfg(windows)]
fn count_recycle_entries(root: &std::path::Path) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            count += count_recycle_entries(&path);
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_uppercase();
        // Windows stores one $I metadata file and one $R payload for each item.
        // Counting only $I files keeps one deletion equal to one reaction unit.
        if name.starts_with("$I") {
            count += 1;
        }
    }
    count
}

#[cfg(windows)]
fn recycle_cooldown_ready(last: Option<Instant>, cooldown: Duration) -> bool {
    last.map(|at| at.elapsed() >= cooldown).unwrap_or(true)
}

#[cfg(windows)]
fn spawn_recycle_bin(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(sid) = current_user_sid() else {
            clog("recycle watcher unavailable: current user SID not found");
            return;
        };
        let drive = std::env::var_os("SystemDrive").unwrap_or_else(|| "C:".into());
        // `C:` is drive-relative in Windows path semantics. Add the separator
        // explicitly or this becomes `C:$Recycle.Bin` and always looks missing.
        let drive_root = std::path::PathBuf::from(format!("{}\\", drive.to_string_lossy()));
        let recycle_root = drive_root.join("$Recycle.Bin");
        if !recycle_root.exists() {
            clog("recycle watcher unavailable: recycle root missing");
            return;
        }
        let user_bin = recycle_root.join(sid);
        let watch_root = if user_bin.exists() { &user_bin } else { &recycle_root };
        let mut known_count = count_recycle_entries(&user_bin);
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(watcher) => watcher,
            Err(_) => {
                clog("recycle watcher failed to initialize");
                return;
            }
        };
        if watcher.watch(watch_root, RecursiveMode::Recursive).is_err() {
            clog("recycle watcher failed to attach");
            return;
        }
        clog(&format!("recycle watcher started baseline_count={known_count}"));

        let mut aggregate_started: Option<Instant> = None;
        let mut last_deleted: Option<Instant> = None;
        let mut last_purged: Option<Instant> = None;
        let mut last_emptied: Option<Instant> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(Ok(_)) => {
                    aggregate_started.get_or_insert_with(Instant::now);
                }
                Ok(Err(_)) => clog("recycle watcher event error"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if !aggregate_started
                .map(|started| started.elapsed() >= Duration::from_secs(3))
                .unwrap_or(false)
            {
                continue;
            }
            aggregate_started = None;
            let current_count = count_recycle_entries(&user_bin);
            let change = classify_recycle_change(known_count, current_count);
            known_count = current_count;
            let Some((kind, amount)) = change else { continue };
            if idle_ms() >= 120_000 {
                clog(&format!("recycle suppressed inactive kind={kind} count={amount}"));
                continue;
            }
            let ready = match kind {
                "file_deleted" => recycle_cooldown_ready(last_deleted, Duration::from_secs(10 * 60)),
                "files_purged" => recycle_cooldown_ready(last_purged, Duration::from_secs(30 * 60)),
                "bin_emptied" => recycle_cooldown_ready(last_emptied, Duration::from_secs(6 * 60 * 60)),
                _ => false,
            };
            if !ready {
                clog(&format!("recycle suppressed cooldown kind={kind} count={amount}"));
                continue;
            }
            let now = Instant::now();
            match kind {
                "file_deleted" => last_deleted = Some(now),
                "files_purged" => last_purged = Some(now),
                "bin_emptied" => last_emptied = Some(now),
                _ => {}
            }
            clog(&format!("recycle emit kind={kind} count={amount}"));
            let _ = app.emit("context-event", ContextEvent { kind });
        }
    });
}

#[cfg(not(windows))]
fn spawn_recycle_bin(_app: AppHandle) {}

/// Append a diagnostic line to ~/.echo/echo.log (the overlay can't be screenshotted,
/// so backend visibility matters).
fn clog(msg: &str) {
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join(".echo");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("echo.log");
    // Rotate here too: for users who never run Claude Code the watcher's
    // rotation never fires, and the 6-second typing heartbeats alone would
    // grow the file forever.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 256 * 1024 {
            let _ = std::fs::rename(&path, dir.join("echo.log.1"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{ts}\tctx\t{msg}");
    }
}

/// `Instant::now() - N seconds`, but safe on a freshly booted machine.
/// Windows `Instant` counts from boot, so plain subtraction PANICS when uptime
/// is under N — i.e. ECHO crashed whenever it was launched (or autostarted)
/// within 10 minutes of turning the PC on. Saturates to "now" instead.
fn ago(secs: u64) -> Instant {
    Instant::now()
        .checked_sub(Duration::from_secs(secs))
        .unwrap_or_else(Instant::now)
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
    const KEYS: &[i32] = &[
        0x08, 0x09, 0x0D, 0x20, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0,
    ];
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

/// ALT+S -> song, ALT+B -> story: a global, focus-independent hotkey poll (Windows only, via
/// GetAsyncKeyState). Edge-triggered with a 5 s cooldown (tracked in `hotkey_at`) so holding the
/// combo fires once. No-op on other platforms — GetAsyncKeyState is Win32-only.
#[cfg(windows)]
fn poll_song_hotkeys(app: &AppHandle, hotkey_at: &mut Option<Instant>) {
    const VK_MENU: i32 = 0x12;
    const VK_S: i32 = 0x53;
    const VK_B: i32 = 0x42;
    let alt = (unsafe { GetAsyncKeyState(VK_MENU) } as u16 & 0x8000) != 0;
    let cooled = hotkey_at
        .map(|t| t.elapsed() > Duration::from_secs(5))
        .unwrap_or(true);
    if !(alt && cooled) {
        return;
    }
    let kind = if (unsafe { GetAsyncKeyState(VK_S) } as u16 & 0x8000) != 0 {
        Some(("hotkey_song", "ALT+S -> song"))
    } else if (unsafe { GetAsyncKeyState(VK_B) } as u16 & 0x8000) != 0 {
        Some(("hotkey_story", "ALT+B -> story"))
    } else {
        None
    };
    if let Some((k, label)) = kind {
        *hotkey_at = Some(Instant::now());
        clog(&format!("hotkey {label}"));
        let _ = app.emit("context-event", ContextEvent { kind: k });
    }
}

#[cfg(not(windows))]
fn poll_song_hotkeys(_app: &AppHandle, _hotkey_at: &mut Option<Instant>) {}

fn spawn_typing(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_emit = ago(60);
        let mut last_key = ago(60);
        let mut ticks: u64 = 0;
        let mut seen_any = false;
        let mut last_zone: u8 = 0;
        let mut hotkey_at: Option<Instant> = None;
        clog("typing watcher started (win32)");
        loop {
            std::thread::sleep(Duration::from_millis(120));
            ticks += 1;
            // idle_ms() counts MOUSE input too, so alone it would put the laptop
            // out on every scroll. Anchor on a real typing key; idle_ms then only
            // bridges fast typing between polls.
            let key_now = any_typing_key_down();
            if key_now {
                last_key = Instant::now();
            }
            // Global hotkey ALT+S -> song, ALT+B -> story (user-directed). Windows-only poll;
            // a no-op on other platforms (GetAsyncKeyState is Win32).
            poll_song_hotkeys(&app, &mut hotkey_at);
            let active =
                key_now || (last_key.elapsed() < Duration::from_secs(2) && idle_ms() < 700);
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
            // M1.5: cursor proximity -> glance events, zone-crossings only.
            if ticks % 4 == 0 {
                let z = cursor_zone(last_zone);
                if z != last_zone {
                    last_zone = z;
                    let kind = match z {
                        1 => "cursor_left",
                        2 => "cursor_right",
                        _ => "cursor_far",
                    };
                    let _ = app.emit("context-event", ContextEvent { kind });
                }
            }
            // Demo hook: `echo sword > ~/.echo/demo` (or devil / poster) plays
            // that scene on demand — for demos and visual QA.
            if ticks % 8 == 0 {
                if let Some(home) = dirs::home_dir() {
                    let p = home.join(".echo").join("demo");
                    if let Ok(s) = std::fs::read_to_string(&p) {
                        // Shell `echo word > demo` is create-then-write: the
                        // poll can land between the two and read "". Deleting
                        // then would eat the word before it was written — only
                        // consume the file once there is content in it.
                        let command = s.trim().trim_start_matches('\u{feff}').trim();
                        if command.is_empty() {
                            continue;
                        }
                        let _ = std::fs::remove_file(&p);
                        let kind = match command {
                            "devil" => "demo_devil",
                            "sword" => "demo_sword",
                            "poster" => "demo_poster",
                            "pizza" => "demo_pizza",
                            "coin" => "demo_coin",
                            "spin" => "demo_spin",
                            "clean" => "demo_clean",
                            "wake" => "demo_wake",
                            // Fan-facing switches: `echo corvin` / `echo dante`.
                            "corvin" | "be corvin" => "demo_be_corvin",
                            "kael" | "be kael" => "demo_be_kael",
                            "dante" | "be dante" => "demo_be_dante",
                            "reel" => "demo_corvin", // the full showcase reel
                            "cleave" => "demo_cleave",
                            "unchained" => "demo_unchained",
                            "hunt" => "demo_hunt",
                            "nuzzle" => "demo_nuzzle",
                            "damage" => "demo_damage",
                            "vigil" => "demo_vigil",
                            "execution" => "demo_execution",
                            "guitar" => "demo_guitar",
                            "night" => "demo_night",
                            "chapter" => "demo_chapter",
                            "tale" => "demo_tale",
                            "break" => "demo_break",
                            "requiem" => "demo_requiem",
                            "letter" => "demo_letter",
                            "road" => "demo_road",
                            "rain" => "demo_rain",
                            "cairn" => "demo_cairn",
                            "combo" => "demo_combo",
                            "parry" => "demo_parry",
                            "breach" => "demo_breach",
                            "ritual" => "demo_ritual",
                            "scan" => "demo_scan",
                            "fly" => "demo_fly",
                            "stone" => "demo_stone",
                            "flask" => "demo_flask",
                            "door" => "demo_door",
                            "form" => "demo_form",
                            "moto" => "demo_moto",
                            "motolegacy" | "moto_legacy" => "demo_moto_legacy",
                            "watch" => "demo_watch",
                            "videoreview" | "video_review" => "demo_video_review",
                            "youtube" | "yt" | "youtube_poster" => "demo_youtube_poster",
                            "dantreview" | "dante_review" => "demo_dante_review",
                            "fullreview" | "full_review" | "oldreview" | "old_review"
                            | "polishreview" | "polish_review" => "demo_full_review",
                            "nightwatch" => "demo_nightwatch",
                            "ride" => "demo_ride",
                            "organ" | "voidorgan" => "demo_voidorgan",
                            "voidstitch" => "demo_voidstitch",
                            "fullweapon" => "demo_fullweapon",
                            "kaelreview" | "kael_review" => "demo_kael_review",
                            "kaelwork" | "kael_work" => "demo_kael_work",
                            "kaelsearch" | "kael_search" => "demo_kael_search",
                            "kaeloverload" | "kael_overload" => "demo_kael_overload",
                            "kaelswordrest" | "kael_swordrest" => "demo_kael_swordrest",
                            "kaelcombat" | "kael_combat" => "demo_kael_combat",
                            "del" => "demo_del",
                            "purge" => "demo_purge",
                            "emptybin" => "demo_emptybin",
                            _ => "",
                        };
                        if !kind.is_empty() {
                            clog(&format!("demo trigger: {kind}"));
                            let _ = app.emit("context-event", ContextEvent { kind });
                        }
                    }
                }
            }
        }
    });
}

// --- DNS cache: what sites you've opened -> media dances, games shoot --------
const MEDIA: &[&str] = &[
    "youtube",
    "ytimg",
    "googlevideo",
    "twitch",
    "ttvnw",
    "netflix",
    "nflxvideo",
];
const MUSIC_DOMAINS: &[&str] = &[
    "spotify",
    "scdn.co",
    "soundcloud",
    "music.apple",
    "music.yandex",
    "music.yandex.ru",
];
const GAMES: &[&str] = &[
    "steampowered",
    "steamcommunity",
    "steamstatic",
    "steam-",
    "epicgames",
    "riotgames",
    "riotcdn",
    "battle.net",
    "blizzard",
    "ubisoft",
    "ea.com",
];

fn read_dns() -> HashSet<String> {
    let mut set = HashSet::new();
    let mut cmd = Command::new("ipconfig");
    cmd.arg("/displaydns");
    // CREATE_NO_WINDOW — without it this 10s poll flashes a console frame.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(out) = cmd.output() else {
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
    if MUSIC_DOMAINS.iter().any(|p| domain.contains(p)) {
        return Some("music");
    }
    if MEDIA.iter().any(|p| domain.contains(p)) {
        return Some("media");
    }
    None
}

// Browsers use DNS-over-HTTPS, so the OS DNS cache never sees youtube/spotify.
// Window TITLES do ("... - YouTube - Google Chrome"), so we read those too.
const MEDIA_TITLES: &[&str] = &[
    "youtube",
    "twitch",
    "netflix",
    "vk видео",
    "vk video",
    "кинопоиск",
    "rutube",
    "vlc",
    "mpv",
    "iina",
    "celluloid",
    // more video sites (user-directed: "not only youtube") — these only guard
    // the fullscreen-game exclusion; playback itself is judged by the OS.
    "hdrezka",
    "rezka",
    "ivi.ru",
    "okko",
    "kinopoisk",
    "premier",
    "start.ru",
    "amediateka",
    "twitch.tv",
    "primevideo",
    "hulu",
    "disney+",
    "plex",
    "jellyfin",
    "кино",
    "сериал",
    "фильм",
];
const GAME_TITLES: &[&str] = &["steam", "epic games", "battle.net", "riot client"];

// Music sources. Only consulted when the OS reports playback of an UNKNOWN
// kind (which is what browsers usually report) — a definite Music/Video answer
// from the media session always wins over this list.
const MUSIC_TITLES: &[&str] = &[
    "spotify",
    "soundcloud",
    "music.apple",
    "apple music",
    // Stem, not the nominative: the tab is "Яндекс Музыка" when idle but
    // "… слушать онлайн на Яндекс МузыкЕ" while a track plays, and the exact
    // form matched neither.
    "яндекс музык",
    "yandex music",
    "music.yandex",
    // Russian stem, kept as escapes so source encoding cannot corrupt it.
    "\u{44f}\u{43d}\u{434}\u{435}\u{43a}\u{441} \u{43c}\u{443}\u{437}\u{44b}\u{43a}",
    "музыка вконтакте",
    "vk музыка",
    "deezer",
    "tidal",
    "bandcamp",
    "last.fm",
    "foobar2000",
    "aimp",
    "winamp",
    "rhythmbox",
    "audacious",
];

// The VISIBLE TITLE decides, and SMTC only fills the gap. This is the older
// ECHO build's rule and it is the one that actually works here: on this machine
// Chrome reports `play=none` for a playing YouTube tab, and when it does
// register a session it labels the video `Music` (Chrome picks MediaPlaybackType
// from the audio track, not the page). Trusting SMTC's kind therefore routed
// every film into the music branch — a poster scene once per 20 minutes and
// never a watch. A window that says "… - YouTube -" is a video, whatever the OS
// thinks. SMTC still owns the case titles can never see: playback from a
// background or minimized tab.
fn resolve_media_state(play_kind: &str, video_title: bool, music_title: bool) -> (bool, bool) {
    if video_title {
        return (true, false);
    }
    if music_title {
        return (false, true);
    }
    match play_kind {
        "music" => (false, true),
        // "unknown" is what browsers usually answer. The old build treated any
        // playback as something to watch; keep that rather than dropping it.
        "video" | "unknown" => (true, false),
        _ => (false, false),
    }
}

// `tasklist /v` reports browser titles as "N/A", so it can never see a YouTube
// tab. Enumerating top-level windows and reading their captions does work.
#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn EnumWindows(cb: extern "system" fn(isize, isize) -> i32, lparam: isize) -> i32;
    fn GetWindowTextW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn GetForegroundWindow() -> isize;
    fn GetWindowRect(hwnd: isize, rect: *mut [i32; 4]) -> i32;
    fn MonitorFromWindow(hwnd: isize, flags: u32) -> isize;
    fn GetMonitorInfoW(mon: isize, info: *mut MonitorInfo) -> i32;
    fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
    fn GetCursorPos(pt: *mut [i32; 2]) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
}

/// M1.5 cursor glances: 0 = far, 1 = near & left of him, 2 = near & right.
/// "Him" is approximated as the bottom-right screen corner (his home spot).
/// Hysteresis so the boundary never chatters.
#[cfg(windows)]
fn cursor_zone(last: u8) -> u8 {
    unsafe {
        let mut pt = [0i32; 2];
        if GetCursorPos(&mut pt) == 0 {
            return 0;
        }
        let sw = GetSystemMetrics(0);
        let sh = GetSystemMetrics(1);
        let hx = sw - 140; // his sprite's rough centre
        let hy = sh - 160;
        let dx = (pt[0] - hx) as f64;
        let dy = (pt[1] - hy) as f64;
        let dist = (dx * dx + dy * dy).sqrt();
        let limit = if last != 0 { 470.0 } else { 390.0 };
        if dist > limit {
            0
        } else if last != 0 && (pt[0] - hx).abs() < 24 {
            // dead band astride the split: hovering at x ~ hx used to flip
            // left/right every poll and made him twitch his head
            last
        } else if pt[0] < hx {
            1
        } else {
            2
        }
    }
}

#[cfg(not(windows))]
fn cursor_zone(_last: u8) -> u8 {
    0
}

#[cfg(windows)]
#[repr(C)]
struct MonitorInfo {
    cb_size: u32,
    monitor: [i32; 4],
    work: [i32; 4],
    flags: u32,
}

/// Is the FOREGROUND window fullscreen? That's the strongest "user is playing a
/// game / watching a movie" signal — the Steam client title only proves the
/// launcher is open, never that a game is actually running.
#[cfg(windows)]
fn foreground_fullscreen() -> bool {
    unsafe {
        let h = GetForegroundWindow();
        if h == 0 {
            return false;
        }
        // The desktop shell itself is screen-sized; ignore it.
        let mut cls = [0u16; 64];
        let n = GetClassNameW(h, cls.as_mut_ptr(), cls.len() as i32);
        let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        if class == "Progman" || class == "WorkerW" {
            return false;
        }
        let mut r = [0i32; 4];
        if GetWindowRect(h, &mut r) == 0 {
            return false;
        }
        let mon = MonitorFromWindow(h, 2); // MONITOR_DEFAULTTONEAREST
        let mut mi = MonitorInfo {
            cb_size: std::mem::size_of::<MonitorInfo>() as u32,
            monitor: [0; 4],
            work: [0; 4],
            flags: 0,
        };
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return false;
        }
        r[0] <= mi.monitor[0]
            && r[1] <= mi.monitor[1]
            && r[2] >= mi.monitor[2]
            && r[3] >= mi.monitor[3]
    }
}

#[cfg(not(windows))]
fn foreground_fullscreen() -> bool {
    false
}

/// Steam writes the running game's AppID to the registry — the ONE signal that
/// works for windowed games too (titles and fullscreen checks both miss those).
#[cfg(windows)]
fn steam_running_app() -> bool {
    let mut cmd = Command::new("reg");
    cmd.args(["query", r"HKCU\Software\Valve\Steam", "/v", "RunningAppID"]);
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(out) = cmd.output() else { return false };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if line.trim_start().starts_with("RunningAppID") {
            if let Some(v) = line.split_whitespace().last() {
                return v != "0x0" && v != "0";
            }
        }
    }
    false
}

#[cfg(not(windows))]
fn steam_running_app() -> bool {
    false
}

/// §10 flagship: the system media session (SMTC). Browsers register here, so
/// music playing in a BACKGROUND tab is finally visible — window titles only
/// ever saw the foreground tab.
/// What is playing right now: "" (nothing), "music", "video" or "unknown".
/// Windows reports the kind itself via PlaybackType, so a Spotify album and a
/// film are finally distinguishable — they used to fire the exact same event,
/// and putting music on made him turn his back and "watch" a black window.
#[cfg(windows)]
fn media_playback_kind() -> &'static str {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Media::MediaPlaybackType;
    let probe = (|| -> windows::core::Result<&'static str> {
        let mgr = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.join()?;
        let sessions = mgr.GetSessions()?;
        let mut found = "";
        for i in 0..sessions.Size()? {
            let s = sessions.GetAt(i)?;
            let Ok(info) = s.GetPlaybackInfo() else {
                continue;
            };
            if info.PlaybackStatus()? != Status::Playing {
                continue;
            }
            // A definite answer wins; keep scanning past an Unknown session in
            // case a second one (a real player) states its kind outright.
            let kind = match info.PlaybackType().and_then(|t| t.Value()) {
                Ok(MediaPlaybackType::Music) => "music",
                Ok(MediaPlaybackType::Video) => "video",
                _ => "unknown",
            };
            if kind != "unknown" {
                return Ok(kind);
            }
            found = "unknown";
        }
        Ok(found)
    })();
    match probe {
        Ok(v) => v,
        Err(e) => {
            // A silent `unwrap_or(false)` made a BROKEN media session look
            // exactly like "nothing is playing" — which is the whole reason a
            // YouTube video failing to turn him around was undiagnosable.
            // Log it once; the poll runs every ten seconds.
            use std::sync::atomic::{AtomicBool, Ordering};
            static WARNED: AtomicBool = AtomicBool::new(false);
            if !WARNED.swap(true, Ordering::Relaxed) {
                clog(&format!("media session query failed: {e}"));
            }
            ""
        }
    }
}

/// Non-Windows: MPRIS/AppleScript only report "something is playing", so the
/// kind is resolved from window titles by the caller.
#[cfg(not(windows))]
fn media_playback_kind() -> &'static str {
    if media_session_playing() {
        "unknown"
    } else {
        ""
    }
}

#[cfg(target_os = "linux")]
fn media_session_playing() -> bool {
    // Most Linux browsers and players expose MPRIS. `playerctl` is the cleanest
    // reader when installed; gdbus is the dependency-free fallback available
    // on the GTK desktops required by Tauri.
    let playerctl = command_stdout("playerctl", &["--all-players", "status"]);
    if playerctl
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("playing"))
    {
        return true;
    }

    let names = command_stdout(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.freedesktop.DBus",
            "--object-path",
            "/org/freedesktop/DBus",
            "--method",
            "org.freedesktop.DBus.ListNames",
        ],
    );
    for name in names.split(|c: char| !(c.is_ascii_alphanumeric() || "._-".contains(c))) {
        if !name.starts_with("org.mpris.MediaPlayer2.") {
            continue;
        }
        let status = command_stdout(
            "gdbus",
            &[
                "call",
                "--session",
                "--dest",
                name,
                "--object-path",
                "/org/mpris/MediaPlayer2",
                "--method",
                "org.freedesktop.DBus.Properties.Get",
                "org.mpris.MediaPlayer2.Player",
                "PlaybackStatus",
            ],
        );
        if status.contains("Playing") {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn media_session_playing() -> bool {
    const SCRIPT: &str = r#"
if application "Spotify" is running then
  tell application "Spotify" to if player state is playing then return "playing"
end if
if application "Music" is running then
  tell application "Music" to if player state is playing then return "playing"
end if
return "stopped"
"#;
    command_stdout("osascript", &["-e", SCRIPT]).trim() == "playing"
}

#[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
fn media_session_playing() -> bool {
    false
}

/// Battery: low + discharging feeds the life vector (he runs on fumes too).
#[cfg(windows)]
fn battery_low() -> bool {
    #[repr(C)]
    struct PowerStatus {
        ac_line: u8,
        flag: u8,
        percent: u8,
        _reserved: u8,
        _lifetime: u32,
        _full_lifetime: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemPowerStatus(s: *mut PowerStatus) -> i32;
    }
    unsafe {
        let mut s = PowerStatus {
            ac_line: 255,
            flag: 255,
            percent: 255,
            _reserved: 0,
            _lifetime: 0,
            _full_lifetime: 0,
        };
        if GetSystemPowerStatus(&mut s) == 0 {
            return false;
        }
        s.ac_line == 0 && s.percent <= 25
    }
}

#[cfg(not(windows))]
fn battery_low() -> bool {
    false
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
fn command_stdout(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn native_media_processes() -> Vec<String> {
    const PLAYERS: &[&str] = &[
        "spotify",
        "vlc",
        "mpv",
        "iina",
        "rhythmbox",
        "totem",
        "celluloid",
    ];
    command_stdout("ps", &["-Ao", "comm=,args="])
        .lines()
        .map(str::to_lowercase)
        .filter(|line| PLAYERS.iter().any(|player| line.contains(player)))
        .collect()
}

#[cfg(target_os = "linux")]
fn window_titles() -> Vec<String> {
    let mut titles: Vec<String> = command_stdout("wmctrl", &["-l"])
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            fields.next()?; // window id
            fields.next()?; // desktop
            fields.next()?; // host
            let title = fields.collect::<Vec<_>>().join(" ").to_lowercase();
            (!title.is_empty()).then_some(title)
        })
        .collect();

    // `wmctrl` is optional. xdotool is common on X11 and gives the same signal;
    // MPRIS above covers Wayland playback where global title enumeration is
    // intentionally restricted.
    if titles.is_empty() {
        for id in command_stdout("xdotool", &["search", "--onlyvisible", "--name", "."]).lines() {
            let title = command_stdout("xdotool", &["getwindowname", id]);
            if !title.trim().is_empty() {
                titles.push(title.trim().to_lowercase());
            }
        }
    }
    titles.extend(native_media_processes());
    titles
}

#[cfg(target_os = "macos")]
fn window_titles() -> Vec<String> {
    // System Events returns visible window captions (including browser tabs).
    // If macOS privacy hides captions, native player process names still keep
    // Spotify/VLC/IINA sessions observable without network access.
    const SCRIPT: &str = r#"
tell application "System Events"
  set names to {}
  repeat with p in (application processes whose visible is true)
    try
      repeat with w in windows of p
        set end of names to name of w
      end repeat
    end try
  end repeat
  return names
end tell
"#;
    let mut titles: Vec<String> = command_stdout("osascript", &["-e", SCRIPT])
        .split(',')
        .map(|title| title.trim().to_lowercase())
        .filter(|title| !title.is_empty())
        .collect();
    titles.extend(native_media_processes());
    titles
}

#[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
fn window_titles() -> Vec<String> {
    native_media_processes()
}

// Window titles and SMTC are the fast signals — they decide whether he turns
// around, so they set the felt latency of the whole feature. DNS shells out to
// `ipconfig`, so it rides a much slower cadence underneath.
const POLL_MS: u64 = 3_000;
const DNS_EVERY_TICKS: u64 = 10; // 30 s
const HEARTBEAT_EVERY_TICKS: u64 = 60; // 3 min

fn spawn_dns(app: AppHandle) {
    std::thread::spawn(move || {
        // This thread only ever logged on an EDGE, so silence was ambiguous:
        // "no video was played" and "the poll died / SMTC sees nothing" looked
        // identical in the log. The typing watcher has a heartbeat for exactly
        // this reason; without one here, a YouTube trigger that does nothing
        // cannot be diagnosed at all. See `ticks` below.
        clog("media watcher started");
        let mut ticks: u64 = 0;
        let mut last_shot = String::new();
        // Seed with what's already there so we only react to NEW activity
        // (Steam already running at launch shouldn't trigger a shoot).
        let mut seen = read_dns();
        let titles = window_titles();
        // The hard title fallback below also emits heartbeats, so an already-open
        // film can wake ECHO after launch. Keep both edges unlatched here: the
        // first poll then records and routes the exact video/music kind once.
        let mut had_media = false;
        let mut had_music = false;
        let mut had_media_title = titles
            .iter()
            .any(|t| MEDIA_TITLES.iter().any(|k| t.contains(k)));
        // Seeded from TITLES, matching the fullscreen discriminator it feeds.
        let mut last_media_seen = if titles
            .iter()
            .any(|t| MEDIA_TITLES.iter().any(|k| t.contains(k)))
        {
            Instant::now()
        } else {
            ago(600)
        };
        let mut had_game = titles
            .iter()
            .any(|t| GAME_TITLES.iter().any(|k| t.contains(k)));
        let mut had_fullscreen = false;
        let mut had_steam_game = false;
        let mut had_battery = false;
        let mut last_media = ago(600);
        let mut last_game = ago(600);
        // A throttled edge must be HELD, not dropped — see the emit block below.
        let mut pending_media = false;
        let mut pending_music = false;
        let mut pending_game = false;
        // The song is a SCENE, not a mood: once every 20 minutes at most, so a
        // full album doesn't turn into a guitar solo every other track.
        let mut last_music = ago(3600);
        // When a video SITE was last opened (DNS). Used only to tell a
        // fullscreen film apart from a fullscreen game.
        let mut media_site_at = ago(3600);
        loop {
            // Titles and SMTC are polled fast: at the old flat 10 s, opening
            // YouTube could sit dead for ten seconds before he turned around,
            // which on a screen recording is a very long nothing. Reading
            // window captions is cheap (one EnumWindows pass).
            std::thread::sleep(Duration::from_millis(POLL_MS));
            ticks += 1;
            let mut fire_media = false;
            let mut fire_music = false;
            let mut fire_game = false;

            // 1) DNS cache (catches native apps like Steam). This one shells
            // out to `ipconfig /displaydns`, so it stays on a slow cadence —
            // a process spawn every 3 s would be pure waste, and a site that
            // has just been opened is caught by its window title anyway.
            if ticks % DNS_EVERY_TICKS == 0 {
                let now = read_dns();
                for d in now.difference(&seen) {
                    match classify(d) {
                        Some("gaming") => fire_game = true,
                        Some("media") => {
                            fire_media = true;
                            // The DNS edge is the only signal that says "this
                            // browser is a video site". It fires once, when the
                            // page opens, and `seen` means it never repeats.
                            // Remember it: a fullscreen window minutes later is
                            // then knowably a film, not a game.
                            media_site_at = Instant::now();
                            clog(&format!("media site opened: {d}"));
                        }
                        Some("music") => {
                            fire_music = true;
                            clog(&format!("music site opened: {d}"));
                        }
                        _ => {}
                    }
                }
                seen = now;
            }

            // 2) Window titles (catches browser tabs — YouTube etc.), edge-triggered.
            // Log WHICH title matched — substring matching is trigger-happy (a
            // folder named "steam stuff" counts), so false positives must be
            // diagnosable from the log.
            let titles = window_titles();
            let media_hit = titles
                .iter()
                .find(|t| MEDIA_TITLES.iter().any(|k| t.contains(k)));
            let music_hit = titles
                .iter()
                .find(|t| MUSIC_TITLES.iter().any(|k| t.contains(k)));
            let game_hit = titles
                .iter()
                .find(|t| GAME_TITLES.iter().any(|k| t.contains(k)));
            // WATCHING REQUIRES ACTUAL PLAYBACK (user-directed): an open
            // YouTube tab where you are only searching must not turn him
            // around. The OS media session reports real playback for ANY
            // site or player — YouTube, Netflix, HDrezka, Twitch, VLC —
            // and keeps working when the video plays in a background tab.
            // Windows states the kind outright; browsers usually say "unknown",
            // so fall back to the window title. Music must NOT reach the watch
            // scene: he plays along with it instead (guitar / плакат), which is
            // what the media trigger did before the watch scene took it over.
            let play_kind = media_playback_kind();
            let playing = !play_kind.is_empty();
            let (media_now, music_now) =
                resolve_media_state(play_kind, media_hit.is_some(), music_hit.is_some());
            // Titles stay useful for one thing: a fullscreen video page must
            // never be mistaken for a fullscreen game. This discriminator is
            // TITLE-based on purpose (see the gaming comment below): SMTC
            // reports playback for the WHOLE machine, so folding `playing` in
            // here meant any background music cancelled fullscreen-game
            // detection entirely — no gaming_fg, and the watch scene then sat
            // him down on top of a running match. The grace window is anchored
            // on the title hit so a player that briefly drops its caption while
            // going fullscreen still counts as media.
            if media_hit.is_some() {
                last_media_seen = Instant::now();
            }
            let media_titles =
                media_hit.is_some() || last_media_seen.elapsed() < Duration::from_secs(45);
            // Only VIDEO drives the watch scene now; music has its own pair of
            // events and its own scenes (Corvin's guitar, Dante's плакат).
            let game_now = game_hit.is_some();
            if media_now && !had_media {
                fire_media = true;
                match media_hit {
                    Some(t) => clog(&format!("video playing: {t:?}")),
                    None => clog(&format!("video playing (media session, {play_kind})")),
                }
            }
            if music_now && !had_music {
                fire_music = true;
                clog(&format!("music playing ({play_kind})"));
            }
            // Browsers use DNS-over-HTTPS, so the DNS edge above almost never
            // sees youtube. The window TITLE appearing is the same event, and
            // it is the one that actually fires on this machine.
            let media_title_now = media_hit.is_some();
            if media_title_now && !had_media_title {
                fire_media = true;
                clog(&format!(
                    "media site opened (title): {:?}",
                    media_hit.unwrap()
                ));
            }
            had_media_title = media_title_now;
            // No hard playback gate (user-directed). Requiring a live SMTC
            // session meant that on a machine where Chrome reports `play=none`
            // — this one, per echo.log — opening YouTube or Netflix produced
            // exactly nothing, forever. Opening the site IS the signal; if
            // nothing follows it, the 45 s heartbeat grace turns him back on
            // its own.
            if game_now && !had_game {
                fire_game = true;
                clog(&format!("game window detected: {:?}", game_hit.unwrap()));
            }
            had_media = media_now;
            had_music = music_now;
            had_game = game_now;

            // A fullscreen foreground window that isn't media = a running game
            // (the game's own title matches nothing, the Steam client may be in
            // the tray). Steam's RunningAppID additionally catches WINDOWED
            // games; its 0->N edge is a real game launch -> shoot burst.
            // Fullscreen counts as gaming judged by TITLES only — background
            // music via SMTC must not cancel the gaming mood mid-match.
            let steam_game = steam_running_app();
            // A fullscreen window is a GAME only without positive evidence that
            // it is a film. Evidence is a media title, OR: playback is live AND
            // a video site was opened in the last half hour AND Steam is not
            // running anything. Watching YouTube fullscreen used to satisfy
            // none of that when the window caption didn't carry the site name,
            // so the browser was read as a game — which emits gaming_fg every
            // ten seconds, and gaming_fg zeroes mediaUntil and holds
            // gamingForeground() true. He could never sit down for it.
            let media_fullscreen = media_titles
                || (playing
                    && !steam_game
                    && media_site_at.elapsed() < Duration::from_secs(30 * 60));
            let fullscreen_game = foreground_fullscreen() && !media_fullscreen;
            if fullscreen_game && !had_fullscreen && !steam_game {
                clog("fullscreen foreground -> gaming mood");
                // A fullscreen flip is a launch edge only for non-Steam games.
                // While Steam's RunningAppID is set, Alt+Tab back into the game
                // must not restart every fixed session clock.
                let _ = app.emit("context-event", ContextEvent { kind: "game_start" });
            }
            had_fullscreen = fullscreen_game;
            if steam_game && !had_steam_game {
                clog("steam RunningAppID set -> game session");
                fire_game = true;
                // The 0->N edge is the actual game LAUNCH — the frontend anchors
                // its devil/sword clocks to this, not to the Steam client window.
                let _ = app.emit("context-event", ContextEvent { kind: "game_start" });
            }
            had_steam_game = steam_game;

            // Both edges are per-tick flags, so an `else if` here DISCARDED a
            // video that started in the same ten-second poll as a game hit —
            // the media edge was gone by the next tick and never came back.
            // They have separate throttles; let each fire on its own.
            //
            // The throttle must DELAY an edge, never eat it: `had_*` has already
            // latched by now, so a rejected edge was gone for good. Quitting one
            // game and launching another inside two minutes silently lost the
            // whole opening beat. Hold it until the throttle opens instead.
            pending_game |= fire_game;
            pending_media |= fire_media;
            // A held video edge is void once the video is really gone — but a
            // DNS hit lands seconds BEFORE the tab gets its caption, so "no
            // title yet" must not count as gone or the throttle eats the edge
            // it was only supposed to delay.
            if !media_now && media_site_at.elapsed() > Duration::from_secs(120) {
                pending_media = false;
            }
            if pending_game && last_game.elapsed() > Duration::from_secs(120) {
                pending_game = false;
                last_game = Instant::now();
                let _ = app.emit("context-event", ContextEvent { kind: "gaming" });
            }
            if pending_media && last_media.elapsed() > Duration::from_secs(120) {
                pending_media = false;
                last_media = Instant::now();
                let _ = app.emit("context-event", ContextEvent { kind: "media" });
            }
            // Music gets its own edge on its own clock: he plays ALONG with it
            // (guitar / плакат) instead of turning his back on you to watch.
            // NOT cleared when nothing is playing: the song now fires on
            // opening a video site too, which by definition happens before any
            // playback exists.
            pending_music |= fire_music;
            if !music_now && !fire_music {
                pending_music = false;
            }
            if pending_music && last_music.elapsed() > Duration::from_secs(20 * 60) {
                pending_music = false;
                last_music = Instant::now();
                let _ = app.emit("context-event", ContextEvent { kind: "music" });
            }

            // Heartbeats: game / video still active -> he stays in that mood.
            // A LAUNCHER IS NOT A GAME. `game_now` is only a window title match
            // ("steam", "epic games", ...), so leaving the Steam client open —
            // which is the normal state for anyone who plays — emitted this
            // heartbeat every poll forever. The frontend pushes its session
            // deadline forward on each one, so clearGamingSession() could never
            // run, and a real launch hours later was folded into the stale
            // session: "game_start ignored: session already 140m old", with
            // every fixed clock long since expired and no opening beat.
            //
            // Only evidence of a game actually RUNNING keeps a session alive:
            // Steam's RunningAppID, or a fullscreen foreground window. The
            // launcher still raises the gaming mood through the `gaming` edge.
            if fullscreen_game || steam_game {
                let _ = app.emit(
                    "context-event",
                    ContextEvent {
                        kind: "gaming_active",
                    },
                );
            }
            // A game that is actually IN FRONT is the only thing that outranks
            // watching a video (user-directed). Steam merely running in the
            // background used to kill the watch mood every 10 s, so YouTube in
            // a second window never got him to sit down.
            if fullscreen_game {
                let _ = app.emit("context-event", ContextEvent { kind: "gaming_fg" });
            }
            if media_now {
                let _ = app.emit(
                    "context-event",
                    ContextEvent {
                        kind: "media_active",
                    },
                );
            }
            // Music had an edge but no heartbeat, so an hour of Yandex Music
            // with no keystrokes read as an empty desk and he wandered off.
            // This says "someone is still here" without starting a scene.
            if music_now {
                let _ = app.emit(
                    "context-event",
                    ContextEvent {
                        kind: "music_active",
                    },
                );
            }
            // Battery: one edge when he starts running on fumes.
            let batt = battery_low();
            if batt && !had_battery {
                clog("battery low + discharging");
                let _ = app.emit(
                    "context-event",
                    ContextEvent {
                        kind: "battery_low",
                    },
                );
            }
            had_battery = batt;

            // Heartbeat every 3 minutes, plus one line on any state change.
            // This is the whole picture in one row: what the OS says is
            // playing, whether a title matched, and who owns the foreground.
            let shot = format!(
                "play={} music={} title={:?} fullscreen={} steam={} windows={}",
                if play_kind.is_empty() {
                    "none"
                } else {
                    play_kind
                },
                music_now,
                media_hit.map(|t| t.as_str()).unwrap_or(""),
                fullscreen_game,
                steam_game,
                titles.len(),
            );
            if shot != last_shot || ticks % HEARTBEAT_EVERY_TICKS == 0 {
                clog(&format!("media watcher: {shot}"));
                last_shot = shot;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{classify, classify_recycle_change, resolve_media_state};

    #[test]
    fn recycle_changes_aggregate_and_empty_has_priority() {
        assert_eq!(classify_recycle_change(3, 4), Some(("file_deleted", 1)));
        assert_eq!(classify_recycle_change(3, 7), Some(("file_deleted", 4)));
        assert_eq!(classify_recycle_change(3, 8), Some(("files_purged", 5)));
        assert_eq!(classify_recycle_change(8, 0), Some(("bin_emptied", 8)));
        assert_eq!(classify_recycle_change(8, 6), None);
        assert_eq!(classify_recycle_change(0, 0), None);
    }

    #[test]
    fn media_domains_keep_video_and_music_separate() {
        assert_eq!(classify("www.youtube.com"), Some("media"));
        assert_eq!(classify("www.netflix.com"), Some("media"));
        assert_eq!(classify("music.yandex.ru"), Some("music"));
        assert_eq!(classify("open.spotify.com"), Some("music"));
    }

    #[test]
    fn visible_titles_decide_and_smtc_only_fills_the_gap() {
        // Chrome answers `none` for a playing YouTube tab on this machine.
        assert_eq!(resolve_media_state("", true, false), (true, false));
        assert_eq!(resolve_media_state("", false, true), (false, true));
        // ...and labels the same video `Music`. The title outranks it, or every
        // film becomes a song and nobody ever sits down to watch.
        assert_eq!(resolve_media_state("music", true, false), (true, false));
        assert_eq!(resolve_media_state("video", false, true), (false, true));
        // Background tab, no caption to read: SMTC is all there is.
        assert_eq!(resolve_media_state("unknown", false, false), (true, false));
        assert_eq!(resolve_media_state("music", false, false), (false, true));
        assert_eq!(resolve_media_state("", false, false), (false, false));
    }
}
