// Hidden-window launcher + system-tray for paperclip on Windows.
//
// Lifecycle:
//   - Single-instance via a named mutex; second double-clicks just open the
//     browser and exit.
//   - Spawns the server hidden if 3100 isn't already bound. Stdout/stderr go
//     to %USERPROFILE%\.paperclip\logs\paperclip-YYYYMMDD.log.
//   - Stays alive in the tray; menu mirrors the browser's system-actions
//     panel (Open, Update, Rebuild, Restart, Logs, Docs, Shutdown, Quit).
//
// Built from tools\paperclip-launcher\; binary lands at
// scripts\launchers\windows\paperclip.exe via build.bat.

#![windows_subsystem = "windows"]

use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIconBuilder};

use windows_sys::Win32::Foundation::SYSTEMTIME;
use windows_sys::Win32::System::SystemInformation::GetLocalTime;
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, MB_ICONERROR, MB_ICONWARNING, MB_OK, SW_SHOWNORMAL,
};

const STARTUP_TIMEOUT_SECS: u32 = 90;
const RESTART_PORT_FREE_TIMEOUT_SECS: u32 = 15;
// Loopback port reserved for the single-instance lock. Any port in the
// dynamic/private range (49152+) would do; we pick a fixed value so the lock
// is reliable across instances. If something else already has this port,
// the launcher will think another launcher is running — annoying but safe.
const SINGLE_INSTANCE_LOCK_PORT: u16 = 53100;

const DEFAULT_URL: &str = "http://localhost:3100/";
const DEFAULT_PORT: u16 = 3100;
const DEFAULT_DOCS_URL: &str = "https://docs.paperclip.ing/";

/// Runtime config. Loaded from %USERPROFILE%\.paperclip\launcher.json (if it
/// exists) and overridden by env vars (PAPERCLIP_URL, PAPERCLIP_PORT,
/// PAPERCLIP_DOCS_URL). Anything missing falls back to the DEFAULT_* consts.
#[derive(Debug, Clone)]
struct Config {
    url: String,
    port: u16,
    docs_url: String,
}

#[derive(Debug, Default, Deserialize)]
struct ConfigFile {
    url: Option<String>,
    port: Option<u16>,
    docs_url: Option<String>,
}

impl Config {
    fn load(user_profile: &Path) -> Self {
        let mut cfg = Self {
            url: DEFAULT_URL.to_string(),
            port: DEFAULT_PORT,
            docs_url: DEFAULT_DOCS_URL.to_string(),
        };

        // 1. File at %USERPROFILE%\.paperclip\launcher.json (lower priority).
        let cfg_path = user_profile.join(".paperclip").join("launcher.json");
        if let Ok(raw) = fs::read_to_string(&cfg_path) {
            // Strip a UTF-8 BOM if present — PowerShell's Out-File defaults to
            // UTF-16 with BOM; users may save with `Set-Content -Encoding UTF8`
            // which writes a BOM as well. serde_json doesn't tolerate one.
            let cleaned = raw.trim_start_matches('\u{feff}');
            match serde_json::from_str::<ConfigFile>(cleaned) {
                Ok(parsed) => {
                    if let Some(u) = parsed.url {
                        cfg.url = u;
                    }
                    if let Some(p) = parsed.port {
                        cfg.port = p;
                    }
                    if let Some(d) = parsed.docs_url {
                        cfg.docs_url = d;
                    }
                }
                Err(e) => {
                    // Bad config shouldn't kill the launcher — surface the
                    // problem and continue with whatever defaults we have.
                    warn_box(&format!(
                        "Could not parse launcher.json (using defaults):\n{}\n\nError: {}",
                        cfg_path.display(),
                        e
                    ));
                }
            }
        }

        // 2. Env vars (higher priority — useful for one-off testing).
        if let Ok(u) = env::var("PAPERCLIP_URL") {
            if !u.is_empty() {
                cfg.url = u;
            }
        }
        if let Ok(p) = env::var("PAPERCLIP_PORT") {
            if let Ok(parsed) = p.parse() {
                cfg.port = parsed;
            }
        }
        if let Ok(d) = env::var("PAPERCLIP_DOCS_URL") {
            if !d.is_empty() {
                cfg.docs_url = d;
            }
        }

        cfg
    }
}

// --- Desktop notifications ---------------------------------------------------
//
// A background thread polls the server's internal desktop-notifications queue
// and forwards each new item to the event loop as a user event, where it is
// shown as a native Windows toast. This lets reminders reach the user even when
// no browser tab is open. The poll thread MUST NEVER panic — with
// `panic = "abort"` a panic there would take the whole tray down — so every
// network/JSON step is error-swallowing (no unwrap/expect).

/// A notification ready to show as a toast. Carried through the event loop.
#[derive(Clone)]
struct DesktopNotification {
    id: String,
    title: String,
    body: String,
    url: Option<String>,
}

/// User event injected into tao's event loop by the poll thread.
enum UserEvent {
    Notify(DesktopNotification),
}

/// Shape of GET /api/internal/desktop-notifications/pending.
#[derive(Deserialize)]
struct PendingResponse {
    notifications: Vec<NotificationDto>,
}

#[derive(Deserialize)]
struct NotificationDto {
    id: String,
    title: String,
    // Reminders created without a body serialize as `"body": null`. serde's
    // `#[serde(default)]` only fills a MISSING field — a present `null` still
    // fails to deserialize into a plain `String` and would poison the whole
    // batch parse (one null-body row => the entire poll returns nothing, so no
    // toast and no ack ever fire). Model it as Option and flatten null/absent
    // to an empty string at the mapping step.
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

// CreateProcess flag — child gets a hidden console host. We don't use
// DETACHED_PROCESS because pnpm.cmd is a batch script that needs a console;
// CREATE_NO_WINDOW gives it one without showing a window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// 32x32 PNG of the paperclip favicon, embedded at compile time.
const TRAY_ICON_PNG: &[u8] = include_bytes!("../../../ui/public/favicon-32x32.png");

/// Resolved paths the launcher needs at runtime.
struct Paths {
    repo_root: PathBuf,
    logs_dir: PathBuf,
    launcher_dir: PathBuf,
    user_profile: PathBuf,
}

fn main() {
    // Fail-fast paths and config setup. Show the user a MessageBox if any of
    // these are wrong — easier than silently dying.
    let paths = match resolve_paths() {
        Ok(p) => p,
        Err(msg) => {
            error_box(&msg);
            std::process::exit(1);
        }
    };

    let config = Config::load(&paths.user_profile);

    // Single-instance: if another launcher already holds the lock port,
    // it's the tray owner. Just open the browser (which is what the user
    // wants when they double-click again) and exit.
    if !acquire_single_instance_lock() {
        open_url(&config.url);
        return;
    }

    // Make sure the server is running. Spawns it hidden + waits up to 90s.
    if !port_is_bound(config.port) {
        if let Err(msg) = spawn_server(&paths) {
            error_box(&msg);
            std::process::exit(1);
        }
        if !wait_for_port(config.port, STARTUP_TIMEOUT_SECS) {
            warn_box(&format!(
                "Paperclip didn't come up within {} seconds.\n\nCheck the log:\n{}",
                STARTUP_TIMEOUT_SECS,
                paths.logs_dir.display()
            ));
            // Continue anyway — user can use the tray to retry, view logs, etc.
        } else {
            open_url(&config.url);
        }
    } else {
        // Server already running — just open the browser.
        open_url(&config.url);
    }

    run_tray(paths, config);
}

fn resolve_paths() -> Result<Paths, String> {
    let exe_path = env::current_exe()
        .map_err(|e| format!("Could not resolve own path: {}", e))?;
    let launcher_dir = exe_path
        .parent()
        .ok_or("Exe has no parent directory")?
        .to_path_buf();
    let repo_root = launcher_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| {
            format!(
                "Exe is not nested deep enough to locate the repo root.\nExe at: {}",
                exe_path.display()
            )
        })?
        .to_path_buf();

    if !repo_root.join("package.json").exists() {
        return Err(format!(
            "Paperclip source not found at:\n{}\n\nThis exe must live in <repo>\\scripts\\launchers\\windows\\paperclip.exe.",
            repo_root.display()
        ));
    }

    let user_profile_os = env::var_os("USERPROFILE")
        .ok_or("USERPROFILE environment variable is not set")?;
    let user_profile = PathBuf::from(user_profile_os);
    let logs_dir = user_profile.join(".paperclip").join("logs");
    let _ = fs::create_dir_all(&logs_dir);

    Ok(Paths {
        repo_root,
        logs_dir,
        launcher_dir,
        user_profile,
    })
}

fn spawn_server(paths: &Paths) -> Result<(), String> {
    let log_path = paths
        .logs_dir
        .join(format!("paperclip-{}.log", today_yyyymmdd()));
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Could not open log file:\n{}\n\n{}", log_path.display(), e))?;
    let log_for_stderr = log
        .try_clone()
        .map_err(|e| format!("Could not clone log handle: {}", e))?;
    let mut header = log
        .try_clone()
        .map_err(|e| format!("Could not clone log handle: {}", e))?;
    let _ = writeln!(header, "\r\n=== paperclip starting {} ===", format_now());
    drop(header);

    let repo_root_str = paths
        .repo_root
        .to_str()
        .ok_or("Repo path contains non-UTF8 characters; can't pass to pnpm.")?;

    Command::new("cmd")
        .args([
            "/c",
            "pnpm",
            "--dir",
            repo_root_str,
            "--filter",
            "paperclipai",
            "exec",
            "tsx",
            "src/index.ts",
            "run",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_for_stderr))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to spawn pnpm: {}\n\nIs pnpm on PATH? Try launch-paperclip.bat for verbose output.",
                e
            )
        })?;
    Ok(())
}

fn run_tray(paths: Paths, config: Config) {
    // tao's event loop is what tray-icon's Win32 hidden-window posts events
    // into. Build it before constructing the tray icon (required on Windows).
    // The `<UserEvent>` type parameter lets the notification poll thread inject
    // toast requests via an EventLoopProxy.
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let menu = Menu::new();
    let item_open = MenuItem::new("Open Paperclip", true, None);
    let sep1 = PredefinedMenuItem::separator();
    let item_update = MenuItem::new("Update Paperclip…", true, None);
    let item_rebuild = MenuItem::new("Rebuild from local…", true, None);
    let item_restart = MenuItem::new("Restart Paperclip", true, None);
    let sep2 = PredefinedMenuItem::separator();
    let item_logs = MenuItem::new("Open logs folder", true, None);
    let item_docs = MenuItem::new("Documentation", true, None);
    let sep3 = PredefinedMenuItem::separator();
    let item_shutdown = MenuItem::new("Shut down Paperclip", true, None);

    let _ = menu.append(&item_open);
    let _ = menu.append(&sep1);
    let _ = menu.append(&item_update);
    let _ = menu.append(&item_rebuild);
    let _ = menu.append(&item_restart);
    let _ = menu.append(&sep2);
    let _ = menu.append(&item_logs);
    let _ = menu.append(&item_docs);
    let _ = menu.append(&sep3);
    let _ = menu.append(&item_shutdown);

    let id_open = item_open.id().clone();
    let id_update = item_update.id().clone();
    let id_rebuild = item_rebuild.id().clone();
    let id_restart = item_restart.id().clone();
    let id_logs = item_logs.id().clone();
    let id_docs = item_docs.id().clone();
    let id_shutdown = item_shutdown.id().clone();

    let icon = load_tray_icon();

    // Build the tray icon. Box::new(menu) is required — TrayIconBuilder takes
    // a boxed trait object so the tray owns the menu lifetime.
    let _tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("Paperclip")
        .with_icon(icon)
        .build()
        .ok();

    let restart_in_progress = Arc::new(AtomicBool::new(false));
    let menu_channel = MenuEvent::receiver();

    // Background poll thread: fetch pending desktop notifications, forward each
    // new one to the event loop as a toast request, then ack them so the server
    // never hands them back. Error-swallowing throughout (no unwrap/expect) so a
    // transient network or JSON failure can never abort the process.
    // The internal desktop-notification endpoints are LOOPBACK-ONLY by design
    // (server routes/internal-notifications.ts trusts a tokenless request only
    // when it arrives on 127.0.0.1/::1). Always poll them over loopback using
    // the configured port — NOT `config.url`, which may be a user-facing LAN
    // hostname (e.g. "paperclip.local" → 192.168.27.50). Hitting the endpoint
    // via a non-loopback address returns 401, so the tray would never show a
    // toast and the queue would pile up forever. `config.url` is still used for
    // opening the browser and as the toast deep-link target below.
    let internal_port = config.port;
    std::thread::spawn(move || {
        let loopback_base = format!("http://127.0.0.1:{}/", internal_port);
        let pending_url = join_url(&loopback_base, "api/internal/desktop-notifications/pending?limit=20");
        let ack_url = join_url(&loopback_base, "api/internal/desktop-notifications/ack");
        let mut shown: std::collections::HashSet<String> = std::collections::HashSet::new();
        loop {
            if let Some(items) = poll_pending(&pending_url) {
                let mut to_ack: Vec<String> = Vec::new();
                for n in items {
                    // Only raise a toast the first time we see an id; still ack
                    // it every time so the server can retire the row.
                    if shown.insert(n.id.clone()) {
                        let _ = proxy.send_event(UserEvent::Notify(n.clone()));
                    }
                    to_ack.push(n.id);
                }
                if !to_ack.is_empty() {
                    ack(&ack_url, &to_ack);
                }
            }
            std::thread::sleep(Duration::from_secs(10));
        }
    });

    event_loop.run(move |event, _, control_flow| {
        // Wait for the next OS event (no busy-loop). Menu events come in
        // through the receiver channel — we drain it on every wakeup.
        *control_flow = ControlFlow::Wait;

        // A notification arrived from the poll thread — show a native toast.
        // Clicking it opens the notification's deep link, falling back to the
        // app URL when the server didn't attach one.
        if let tao::event::Event::UserEvent(UserEvent::Notify(n)) = &event {
            let target = n.url.clone().unwrap_or_else(|| config.url.clone());
            let _ = tauri_winrt_notification::Toast::new(
                tauri_winrt_notification::Toast::POWERSHELL_APP_ID,
            )
            .title(&n.title)
            .text1(&n.body)
            .on_activated(move |_action| {
                open_url(&target);
                Ok(())
            })
            .show();
        }

        while let Ok(event) = menu_channel.try_recv() {
            let id = &event.id;
            if id == &id_open {
                open_url(&config.url);
            } else if id == &id_docs {
                open_url(&config.docs_url);
            } else if id == &id_logs {
                open_path(&paths.logs_dir);
            } else if id == &id_update {
                spawn_visible_bat(&paths.launcher_dir, "update-paperclip.bat");
            } else if id == &id_rebuild {
                spawn_visible_bat(&paths.launcher_dir, "rebuild-paperclip.bat");
            } else if id == &id_restart {
                if !restart_in_progress.swap(true, Ordering::SeqCst) {
                    let paths_clone = clone_paths(&paths);
                    let cfg_clone = config.clone();
                    let flag = restart_in_progress.clone();
                    thread::spawn(move || {
                        do_restart(&paths_clone, &cfg_clone);
                        flag.store(false, Ordering::SeqCst);
                    });
                }
            } else if id == &id_shutdown {
                spawn_hidden_ps1(&paths.launcher_dir, "stop-paperclip.ps1");
                *control_flow = ControlFlow::Exit;
            }
        }
    });
}

fn do_restart(paths: &Paths, config: &Config) {
    // Stop the server: invoke stop-paperclip.ps1 directly so we don't fight
    // the .bat's interactive `pause`.
    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            paths
                .launcher_dir
                .join("stop-paperclip.ps1")
                .to_str()
                .unwrap_or(""),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();

    // Wait for the port to actually free. stop-paperclip.ps1 exits as soon as
    // it sends the kill, but the OS takes a moment to release the listen.
    for _ in 0..RESTART_PORT_FREE_TIMEOUT_SECS {
        if !port_is_bound(config.port) {
            break;
        }
        thread::sleep(Duration::from_secs(1));
    }

    if let Err(msg) = spawn_server(paths) {
        warn_box(&format!("Restart failed at spawn step:\n{}", msg));
        return;
    }

    if wait_for_port(config.port, STARTUP_TIMEOUT_SECS) {
        open_url(&config.url);
    } else {
        warn_box(&format!(
            "Server didn't come back within {} seconds after restart.\n\nCheck the log under:\n{}",
            STARTUP_TIMEOUT_SECS,
            paths.logs_dir.display()
        ));
    }
}

fn spawn_visible_bat(launcher_dir: &Path, script: &str) {
    let bat = launcher_dir.join(script);
    if !bat.exists() {
        warn_box(&format!("Script not found:\n{}", bat.display()));
        return;
    }
    // `cmd /c start "" "<bat>"` opens the bat in a brand-new console window
    // and lets the spawned cmd die immediately. Same pattern the server's
    // /api/system/update route uses.
    let _ = Command::new("cmd")
        .args(["/c", "start", "", bat.to_str().unwrap_or("")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn spawn_hidden_ps1(launcher_dir: &Path, script: &str) {
    let ps1 = launcher_dir.join(script);
    if !ps1.exists() {
        warn_box(&format!("Script not found:\n{}", ps1.display()));
        return;
    }
    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            ps1.to_str().unwrap_or(""),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

fn clone_paths(p: &Paths) -> Paths {
    Paths {
        repo_root: p.repo_root.clone(),
        logs_dir: p.logs_dir.clone(),
        launcher_dir: p.launcher_dir.clone(),
        user_profile: p.user_profile.clone(),
    }
}

fn load_tray_icon() -> Icon {
    // Decode the embedded PNG to RGBA. tray-icon requires raw RGBA pixels —
    // it doesn't decode image formats itself.
    let img = image::load_from_memory(TRAY_ICON_PNG)
        .expect("decode tray icon PNG")
        .into_rgba8();
    let (w, h) = img.dimensions();
    let mut pixels = img.into_raw();

    // The embedded favicon is rendered with the SVG's light-theme stroke
    // (#18181b, zinc-900). On a dark Windows taskbar that disappears. If the
    // user is on a dark theme, swap dark stroke pixels to the SVG's
    // dark-theme color (#e4e4e7, zinc-200) while preserving anti-aliased
    // alpha. We rasterize once at startup; theme changes need a relaunch.
    if is_dark_taskbar_theme() {
        for chunk in pixels.chunks_mut(4) {
            let brightness = chunk[0] as u16 + chunk[1] as u16 + chunk[2] as u16;
            // Alpha > 0 + low brightness = stroke pixel (vs fully transparent
            // background). 240 covers anti-aliased edges as well as the core
            // stroke without bleeding into mid-grey content if any existed.
            if chunk[3] > 0 && brightness < 240 {
                chunk[0] = 0xe4;
                chunk[1] = 0xe4;
                chunk[2] = 0xe7;
            }
        }
    }

    Icon::from_rgba(pixels, w, h).expect("tray icon from rgba")
}

/// True when the Windows taskbar is using its dark theme. Reads
/// HKCU\...\Personalize\SystemUsesLightTheme via reg.exe so we don't have to
/// pull in a Win32 registry binding. If the read fails, default to dark —
/// that's the Windows 11 default and the harder case to render against.
fn is_dark_taskbar_theme() -> bool {
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "SystemUsesLightTheme",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(out) if out.status.success() => {
            // Output looks like:
            //   HKEY_CURRENT_USER\...\Personalize
            //       SystemUsesLightTheme    REG_DWORD    0x0
            let s = String::from_utf8_lossy(&out.stdout);
            // 0x1 = light, 0x0 = dark, anything else = unknown → dark.
            !s.contains("0x1")
        }
        _ => true,
    }
}

fn acquire_single_instance_lock() -> bool {
    // Bind a TCP listener on loopback. If another launcher already holds it,
    // bind fails — that's the "second instance" signal. The OS releases the
    // port when this process exits, so no stale-lock cleanup needed.
    static LOCK: OnceLock<TcpListener> = OnceLock::new();
    match TcpListener::bind(format!("127.0.0.1:{}", SINGLE_INSTANCE_LOCK_PORT)) {
        Ok(listener) => {
            // Park the listener in a OnceLock for the process lifetime so it
            // isn't dropped (which would release the port).
            let _ = LOCK.set(listener);
            true
        }
        Err(_) => false,
    }
}

fn port_is_bound(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    match addr.parse() {
        Ok(socket) => TcpStream::connect_timeout(&socket, Duration::from_millis(200)).is_ok(),
        Err(_) => false,
    }
}

fn wait_for_port(port: u16, max_secs: u32) -> bool {
    for _ in 0..max_secs {
        thread::sleep(Duration::from_secs(1));
        if port_is_bound(port) {
            return true;
        }
    }
    false
}

/// Join a base URL and a path with exactly one '/' between them. Trims a single
/// trailing '/' from base (config.url is stored with one, e.g.
/// "http://localhost:3100/").
fn join_url(base: &str, path: &str) -> String {
    let trimmed = base.strip_suffix('/').unwrap_or(base);
    format!("{}/{}", trimmed, path)
}

/// GET the pending-notifications queue. Returns None on ANY error (network,
/// non-2xx, body read, JSON parse) so the caller simply skips this cycle.
fn poll_pending(url: &str) -> Option<Vec<DesktopNotification>> {
    let resp = ureq::get(url).timeout(Duration::from_secs(4)).call().ok()?;
    let body = resp.into_string().ok()?;
    let parsed: PendingResponse = serde_json::from_str(&body).ok()?;
    Some(
        parsed
            .notifications
            .into_iter()
            .map(|n| DesktopNotification {
                id: n.id,
                title: n.title,
                body: n.body.unwrap_or_default(),
                url: n.url,
            })
            .collect(),
    )
}

/// POST the ack list. Fire-and-forget: any error is ignored (the row will just
/// be returned again next cycle, and the `shown` set dedupes the toast).
fn ack(url: &str, ids: &[String]) {
    let body = serde_json::to_string(&serde_json::json!({ "ids": ids })).unwrap_or_default();
    let _ = ureq::post(url)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(4))
        .send_string(&body);
}

fn open_url(url: &str) {
    let url_w = wide(url);
    let verb_w = wide("open");
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb_w.as_ptr(),
            url_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL as i32,
        );
    }
}

fn open_path(path: &Path) {
    let path_w = wide(&path.to_string_lossy());
    let verb_w = wide("open");
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb_w.as_ptr(),
            path_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL as i32,
        );
    }
}

fn error_box(text: &str) {
    msgbox("Paperclip", text, MB_ICONERROR);
}

fn warn_box(text: &str) {
    msgbox("Paperclip", text, MB_ICONWARNING);
}

fn msgbox(title: &str, text: &str, icon: u32) {
    let title_w = wide(title);
    let text_w = wide(text);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text_w.as_ptr(),
            title_w.as_ptr(),
            MB_OK | icon,
        );
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn today_yyyymmdd() -> String {
    let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut st) };
    format!("{:04}{:02}{:02}", st.wYear, st.wMonth, st.wDay)
}

fn format_now() -> String {
    let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut st) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
    )
}
