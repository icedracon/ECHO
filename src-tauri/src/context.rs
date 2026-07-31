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
    let path = dir.join("echo.log");
    // Rotate here too: for users who never run Claude Code the watcher's
    // rotation never fires, and the 6-second typing heartbeats alone would
    // grow the file forever.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 256 * 1024 {
            let _ = std::fs::rename(&path, dir.join("echo.log.1"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
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
                        if s.trim().is_empty() {
                            continue;
                        }
                        let _ = std::fs::remove_file(&p);
                        let kind = match s.trim() {
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
                            "watch" => "demo_watch",
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
    "youtube", "ytimg", "googlevideo", "spotify", "scdn.co", "soundcloud",
    "twitch", "ttvnw", "netflix", "nflxvideo", "music.apple",
];
const GAMES: &[&str] = &[
    "steampowered", "steamcommunity", "steamstatic", "steam-", "epicgames",
    "riotgames", "riotcdn", "battle.net", "blizzard", "ubisoft", "ea.com",
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
    if MEDIA.iter().any(|p| domain.contains(p)) {
        return Some("media");
    }
    None
}

// Browsers use DNS-over-HTTPS, so the OS DNS cache never sees youtube/spotify.
// Window TITLES do ("... - YouTube - Google Chrome"), so we read those too.
const MEDIA_TITLES: &[&str] = &[
    "youtube", "spotify", "twitch", "netflix", "soundcloud", "vk видео", "vk video",
    "кинопоиск", "rutube", "vlc", "mpv", "iina", "rhythmbox", "celluloid",
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
        let mut mi = MonitorInfo { cb_size: std::mem::size_of::<MonitorInfo>() as u32, monitor: [0; 4], work: [0; 4], flags: 0 };
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return false;
        }
        r[0] <= mi.monitor[0] && r[1] <= mi.monitor[1] && r[2] >= mi.monitor[2] && r[3] >= mi.monitor[3]
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
#[cfg(windows)]
fn media_session_playing() -> bool {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    (|| -> windows::core::Result<bool> {
        let mgr = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.join()?;
        let sessions = mgr.GetSessions()?;
        for i in 0..sessions.Size()? {
            let s = sessions.GetAt(i)?;
            if let Ok(info) = s.GetPlaybackInfo() {
                if info.PlaybackStatus()? == Status::Playing {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    })()
    .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn media_session_playing() -> bool {
    // Most Linux browsers and players expose MPRIS. `playerctl` is the cleanest
    // reader when installed; gdbus is the dependency-free fallback available
    // on the GTK desktops required by Tauri.
    let playerctl = command_stdout("playerctl", &["--all-players", "status"]);
    if playerctl.lines().any(|line| line.trim().eq_ignore_ascii_case("playing")) {
        return true;
    }

    let names = command_stdout(
        "gdbus",
        &[
            "call", "--session", "--dest", "org.freedesktop.DBus",
            "--object-path", "/org/freedesktop/DBus", "--method",
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
                "call", "--session", "--dest", name,
                "--object-path", "/org/mpris/MediaPlayer2", "--method",
                "org.freedesktop.DBus.Properties.Get",
                "org.mpris.MediaPlayer2.Player", "PlaybackStatus",
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
        let mut s = PowerStatus { ac_line: 255, flag: 255, percent: 255, _reserved: 0, _lifetime: 0, _full_lifetime: 0 };
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
        "spotify", "vlc", "mpv", "iina", "rhythmbox", "totem", "celluloid",
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

fn spawn_dns(app: AppHandle) {
    std::thread::spawn(move || {
        // Seed with what's already there so we only react to NEW activity
        // (Steam already running at launch shouldn't trigger a shoot).
        let mut seen = read_dns();
        let titles = window_titles();
        let mut had_media = titles.iter().any(|t| MEDIA_TITLES.iter().any(|k| t.contains(k)));
        let mut had_game = titles.iter().any(|t| GAME_TITLES.iter().any(|k| t.contains(k)));
        let mut had_fullscreen = false;
        let mut had_steam_game = false;
        let mut had_battery = false;
        let mut last_media = ago(600);
        let mut last_game = ago(600);
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

            // 2) Window titles (catches browser tabs — YouTube etc.), edge-triggered.
            // Log WHICH title matched — substring matching is trigger-happy (a
            // folder named "steam stuff" counts), so false positives must be
            // diagnosable from the log.
            let titles = window_titles();
            let media_hit = titles
                .iter()
                .find(|t| MEDIA_TITLES.iter().any(|k| t.contains(k)));
            let game_hit = titles
                .iter()
                .find(|t| GAME_TITLES.iter().any(|k| t.contains(k)));
            let media_titles = media_hit.is_some();
            // SMTC sees background-tab / minimized players that titles never can.
            let media_now = media_titles || media_session_playing();
            let game_now = game_hit.is_some();
            if media_now && !had_media {
                fire_media = true;
                match media_hit {
                    Some(t) => clog(&format!("media window detected: {t:?}")),
                    None => clog("media session playing (SMTC)"),
                }
            }
            if game_now && !had_game {
                fire_game = true;
                clog(&format!("game window detected: {:?}", game_hit.unwrap()));
            }
            had_media = media_now;
            had_game = game_now;

            // A fullscreen foreground window that isn't media = a running game
            // (the game's own title matches nothing, the Steam client may be in
            // the tray). Steam's RunningAppID additionally catches WINDOWED
            // games; its 0->N edge is a real game launch -> shoot burst.
            // Fullscreen counts as gaming judged by TITLES only — background
            // music via SMTC must not cancel the gaming mood mid-match.
            let steam_game = steam_running_app();
            let fullscreen_game = foreground_fullscreen() && !media_titles;
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

            if fire_game && last_game.elapsed() > Duration::from_secs(120) {
                last_game = Instant::now();
                let _ = app.emit("context-event", ContextEvent { kind: "gaming" });
            } else if fire_media && last_media.elapsed() > Duration::from_secs(120) {
                last_media = Instant::now();
                let _ = app.emit("context-event", ContextEvent { kind: "media" });
            }

            // Heartbeats: game / video still active -> he stays in that mood.
            if game_now || fullscreen_game || steam_game {
                let _ = app.emit("context-event", ContextEvent { kind: "gaming_active" });
            }
            if media_now {
                let _ = app.emit("context-event", ContextEvent { kind: "media_active" });
            }
            // Battery: one edge when he starts running on fumes.
            let batt = battery_low();
            if batt && !had_battery {
                clog("battery low + discharging");
                let _ = app.emit("context-event", ContextEvent { kind: "battery_low" });
            }
            had_battery = batt;
        }
    });
}
