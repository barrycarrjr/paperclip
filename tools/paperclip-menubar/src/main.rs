// Menu-bar helper for paperclip on macOS: the Mac counterpart of the Windows
// tray in tools/paperclip-launcher.
//
// It does three things:
//
// 1. Shows a paperclip icon in the menu bar with Open / Start / Stop /
//    Restart, plus a status line that follows the server's health check.
//    Start, Stop and Restart run the same scripts as the Terminal launchers
//    (scripts/launchers/unix), so there is one implementation of process
//    management on macOS and this helper never owns the server process.
// 2. Polls the server's desktop-notifications queue over loopback, the same
//    contract the Windows tray uses, and shows each reminder as a native
//    notification. Clicking it opens the reminder's deep link.
// 3. Writes `$PAPERCLIP_HOME/menubar.json` while it runs. The background
//    checker in scripts/launchers/unix/desktop-reminders.mjs reads it and
//    stays quiet for the same server, so reminders are not shown twice.
//
// Worker threads MUST NEVER panic: with `panic = "abort"` that would take the
// helper down. Network, JSON and process steps swallow their errors.

use std::collections::HashSet;
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

// Bundle identifier written into the app's Info.plist by build-app.sh.
// Notifications are posted as this app, so they carry its name and can be
// turned on or off in System Settings > Notifications.
const BUNDLE_ID: &str = "dev.barrycarrjr.paperclip.menubar";

// 32x32 PNG of the paperclip favicon. Shown as a template image, so macOS
// draws it in the menu bar's own color in light and dark mode.
const MENU_BAR_ICON_PNG: &[u8] = include_bytes!("../../../ui/public/favicon-32x32.png");

const HEALTH_INTERVAL: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_secs(10);
// A cold start can take a minute or more while the UI bundle is built.
const START_TIMEOUT: Duration = Duration::from_secs(180);

/// Where this instance lives and how to reach it. Resolved the way the Unix
/// launchers and desktop-reminders.mjs do, so the helper talks to the same
/// server they start.
#[derive(Clone)]
struct Settings {
    repo_root: PathBuf,
    paperclip_home: PathBuf,
    /// Loopback base for the health check and notification queue. The queue
    /// only trusts a tokenless request that arrives on loopback.
    poll_base: String,
    /// The address the user reaches this instance by.
    app_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ServerState {
    Running,
    Stopped,
    Starting,
    Stopping,
}

enum UserEvent {
    Health(bool),
    ActionFinished(&'static str, Result<(), String>),
}

#[derive(Deserialize)]
struct PendingResponse {
    notifications: Vec<NotificationDto>,
}

#[derive(Deserialize, Clone)]
struct NotificationDto {
    id: String,
    title: String,
    // Reminders without a body arrive as `"body": null`.
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

fn main() {
    let settings = match resolve_settings() {
        Ok(s) => s,
        Err(message) => {
            alert("Paperclip menu bar could not start", &message);
            return;
        }
    };

    // One helper per instance. A second launch just opens Paperclip.
    if let Some(pid) = running_helper_pid(&settings) {
        if pid != std::process::id() {
            open_url(&settings.app_url);
            return;
        }
    }
    write_marker(&settings);

    // Post notifications as this app when it runs from its bundle. A bare
    // binary (cargo run) falls back to the library's default sender.
    if bundle_info_plist().is_some() {
        let _ = mac_notification_sys::set_application(BUNDLE_ID);
    }

    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    // Menu-bar only: no Dock icon, no app menu.
    event_loop.set_activation_policy(ActivationPolicy::Accessory);
    let proxy = event_loop.create_proxy();

    spawn_health_thread(settings.clone(), proxy.clone());
    let running = Arc::new(AtomicBool::new(false));
    spawn_notification_thread(settings.clone(), running.clone());

    let item_status = MenuItem::new("Checking Paperclip…", false, None);
    let item_open = MenuItem::new("Open Paperclip", true, None);
    let item_start = MenuItem::new("Start Paperclip", false, None);
    let item_stop = MenuItem::new("Stop Paperclip", false, None);
    let item_restart = MenuItem::new("Restart Paperclip", false, None);
    let item_logs = MenuItem::new("Open logs folder", true, None);
    let item_quit = MenuItem::new("Quit menu bar helper", true, None);
    let menu = Menu::new();
    let _ = menu.append_items(&[
        &item_status,
        &PredefinedMenuItem::separator(),
        &item_open,
        &PredefinedMenuItem::separator(),
        &item_start,
        &item_stop,
        &item_restart,
        &PredefinedMenuItem::separator(),
        &item_logs,
        &PredefinedMenuItem::separator(),
        &item_quit,
    ]);

    let menu_channel = MenuEvent::receiver();
    let mut tray: Option<TrayIcon> = None;
    let mut state = ServerState::Stopped;
    // Set while a Start/Stop/Restart is in progress, so health checks do not
    // flip the menu back and forth mid-action.
    let mut busy = false;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        let mut changed = false;
        match event {
            // macOS needs the run loop going before a status item is created.
            Event::NewEvents(StartCause::Init) => {
                tray = TrayIconBuilder::new()
                    .with_menu(Box::new(menu.clone()))
                    .with_tooltip("Paperclip")
                    .with_icon(load_icon())
                    .with_icon_as_template(true)
                    .build()
                    .ok();
                if tray.is_none() {
                    alert("Paperclip menu bar could not start", "The menu-bar icon could not be created.");
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(UserEvent::Health(up)) => {
                running.store(up, Ordering::Relaxed);
                if !busy {
                    state = if up { ServerState::Running } else { ServerState::Stopped };
                    changed = true;
                }
            }
            Event::UserEvent(UserEvent::ActionFinished(action, result)) => {
                busy = false;
                let up = probe_health(&settings.poll_base);
                running.store(up, Ordering::Relaxed);
                state = if up { ServerState::Running } else { ServerState::Stopped };
                changed = true;
                match result {
                    Ok(()) if action == "stop" => notify_status("Paperclip stopped", "The server has shut down."),
                    Ok(()) => {
                        notify_status("Paperclip is running", "The server is ready to use.");
                        open_url(&settings.app_url);
                    }
                    Err(message) => alert(&format!("Paperclip {} failed", action), &message),
                }
            }
            _ => {}
        }

        while let Ok(event) = menu_channel.try_recv() {
            let id = &event.id;
            if id == item_open.id() {
                open_url(&settings.app_url);
            } else if id == item_logs.id() {
                let dir = logs_dir(&settings);
                let _ = fs::create_dir_all(&dir);
                open_url(&dir.to_string_lossy());
            } else if id == item_quit.id() {
                remove_marker(&settings);
                drop(tray.take());
                *control_flow = ControlFlow::Exit;
                return;
            } else if busy {
                // Ignore lifecycle clicks while one is already running.
            } else if id == item_start.id() {
                busy = true;
                state = ServerState::Starting;
                changed = true;
                run_action("start", settings.clone(), proxy.clone());
            } else if id == item_stop.id() {
                busy = true;
                state = ServerState::Stopping;
                changed = true;
                run_action("stop", settings.clone(), proxy.clone());
            } else if id == item_restart.id() {
                busy = true;
                state = ServerState::Starting;
                changed = true;
                run_action("restart", settings.clone(), proxy.clone());
            }
        }

        if changed {
            item_status.set_text(match state {
                ServerState::Running => "Paperclip is running",
                ServerState::Stopped => "Paperclip is stopped",
                ServerState::Starting => "Paperclip is starting…",
                ServerState::Stopping => "Paperclip is stopping…",
            });
            item_start.set_enabled(state == ServerState::Stopped);
            item_stop.set_enabled(state == ServerState::Running);
            item_restart.set_enabled(state == ServerState::Running);
        }
    });
}

// --- Settings ----------------------------------------------------------------

fn resolve_settings() -> Result<Settings, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set.")?;
    let paperclip_home = env_path("PAPERCLIP_HOME").unwrap_or_else(|| home.join(".paperclip"));
    let instance = std::env::var("PAPERCLIP_INSTANCE_ID").unwrap_or_else(|_| "default".into());
    let config_path = env_path("PAPERCLIP_CONFIG")
        .unwrap_or_else(|| paperclip_home.join("instances").join(&instance).join("config.json"));
    let config: serde_json::Value = fs::read_to_string(&config_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Null);
    let repo_root = find_repo_root().ok_or(
        "Could not find the Paperclip checkout. Rebuild the app with tools/paperclip-menubar/build-app.sh, or set PAPERCLIP_SRC.",
    )?;
    let env: Vec<(String, String)> = std::env::vars().collect();
    let (poll_base, app_url) = resolve_urls(&env, &config);
    Ok(Settings { repo_root, paperclip_home, poll_base, app_url })
}

/// Same rules as resolveSettings in desktop-reminders.mjs: port and host from
/// the environment, then the config, then defaults; the public URL wins for
/// what the browser opens.
fn resolve_urls(env: &[(String, String)], config: &serde_json::Value) -> (String, String) {
    let get = |key: &str| {
        env.iter()
            .find(|(k, v)| k == key && !v.trim().is_empty())
            .map(|(_, v)| v.trim().to_string())
    };
    let server = &config["server"];
    let port = get("PORT")
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| *p != 0)
        .or_else(|| server["port"].as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0))
        .unwrap_or(3100);
    let host = get("HOST")
        .or_else(|| server["host"].as_str().map(str::to_string))
        .unwrap_or_else(|| "127.0.0.1".into());
    let host = if host == "0.0.0.0" || host == "::" { "localhost".to_string() } else { host };
    let public = [
        "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
        "BETTER_AUTH_URL",
        "BETTER_AUTH_BASE_URL",
        "PAPERCLIP_PUBLIC_URL",
    ]
    .iter()
    .find_map(|key| get(key))
    .or_else(|| config["auth"]["publicBaseUrl"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
    let app_url = public
        .and_then(|url| url_origin(&url))
        .unwrap_or_else(|| format!("http://{}:{}", host, port));
    (format!("http://127.0.0.1:{}", port), app_url)
}

/// `scheme://host[:port]` of an http(s) URL, or None if it does not look like one.
fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some(format!("{}://{}", scheme, authority))
}

/// A reminder's url is a path in this instance, such as `/calendar`. Anything
/// that would land outside the instance opens its home page instead.
fn resolve_open_url(app_url: &str, reminder_url: Option<&str>) -> String {
    match reminder_url {
        Some(path) if path.starts_with('/') && !path.starts_with("//") && !path.contains('\\') => {
            format!("{}{}", app_url, path)
        }
        _ => format!("{}/", app_url),
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The checkout whose scripts start and stop the server: PAPERCLIP_SRC, then
/// the PaperclipSource key build-app.sh writes into the bundle, then the
/// folders above the executable.
fn find_repo_root() -> Option<PathBuf> {
    let is_checkout = |p: &Path| p.join("scripts/launchers/unix/common.sh").is_file();
    if let Some(p) = env_path("PAPERCLIP_SRC").filter(|p| is_checkout(p)) {
        return Some(p);
    }
    if let Some(p) = bundle_info_plist()
        .and_then(|text| plist_string(&text, "PaperclipSource"))
        .map(PathBuf::from)
        .filter(|p| is_checkout(p))
    {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|p| is_checkout(p)).map(Path::to_path_buf)
}

/// Contents/Info.plist when running from an app bundle.
fn bundle_info_plist() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    fs::read_to_string(contents.join("Info.plist")).ok()
}

/// Reads one `<key>name</key><string>value</string>` pair from an XML plist.
fn plist_string(text: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{}</key>", key);
    let after = &text[text.find(&marker)? + marker.len()..];
    let after = after.trim_start().strip_prefix("<string>")?;
    let value = &after[..after.find("</string>")?];
    Some(
        value
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&"),
    )
}

// --- Marker file -------------------------------------------------------------
//
// `$PAPERCLIP_HOME/menubar.json` = {"pid": ..., "pollBase": "..."}. It tells
// desktop-reminders.mjs that this helper shows reminders for that server, and
// lets a second launch find the first.

fn marker_path(settings: &Settings) -> PathBuf {
    settings.paperclip_home.join("menubar.json")
}

fn write_marker(settings: &Settings) {
    let _ = fs::create_dir_all(&settings.paperclip_home);
    let body = serde_json::json!({ "pid": std::process::id(), "pollBase": settings.poll_base });
    let _ = fs::write(marker_path(settings), body.to_string());
}

fn remove_marker(settings: &Settings) {
    // Only remove our own marker, never one a newer helper wrote.
    if running_helper_pid(settings) == Some(std::process::id()) {
        let _ = fs::remove_file(marker_path(settings));
    }
}

fn running_helper_pid(settings: &Settings) -> Option<u32> {
    let text = fs::read_to_string(marker_path(settings)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    if value["pollBase"].as_str()? != settings.poll_base {
        return None;
    }
    let pid = u32::try_from(value["pid"].as_u64()?).ok()?;
    let alive = Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    alive.then_some(pid)
}

// --- Health and lifecycle ----------------------------------------------------

fn probe_health(poll_base: &str) -> bool {
    ureq::get(&format!("{}/api/health", poll_base))
        .timeout(Duration::from_secs(2))
        .call()
        .is_ok()
}

fn spawn_health_thread(settings: Settings, proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || loop {
        if proxy.send_event(UserEvent::Health(probe_health(&settings.poll_base))).is_err() {
            return;
        }
        std::thread::sleep(HEALTH_INTERVAL);
    });
}

fn logs_dir(settings: &Settings) -> PathBuf {
    settings.paperclip_home.join("logs")
}

/// Runs scripts/launchers/unix/<name>-paperclip.sh through the user's login
/// shell, so node and pnpm resolve the way they do in Terminal (an app opened
/// from Finder gets a bare PATH). Output is appended to the day's log.
fn launcher_command(settings: &Settings, name: &str) -> Result<Command, String> {
    let script = settings
        .repo_root
        .join("scripts/launchers/unix")
        .join(format!("{}-paperclip.sh", name));
    let dir = logs_dir(settings);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    let log_path = dir.join(format!("paperclip-{}.log", today_yyyymmdd()));
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Could not open {}: {}", log_path.display(), e))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    let mut command = Command::new(shell);
    // The script path is passed as an argument, never spliced into the string.
    command
        .args(["-l", "-c", "exec /bin/bash \"$0\"", &script.to_string_lossy()])
        .current_dir(&settings.repo_root)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err);
    Ok(command)
}

fn run_action(action: &'static str, settings: Settings, proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || {
        let result = match action {
            "stop" => stop_server(&settings),
            "restart" => stop_server(&settings).and_then(|()| start_server(&settings)),
            _ => start_server(&settings),
        };
        let _ = proxy.send_event(UserEvent::ActionFinished(action, result));
    });
}

fn start_server(settings: &Settings) -> Result<(), String> {
    let log_hint = format!("Details are in {}.", logs_dir(settings).display());
    let mut command = launcher_command(settings, "launch")?;
    // Own process group: the server keeps running if this helper quits.
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| format!("Could not run the launch script: {}. {}", e, log_hint))?;
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if probe_health(&settings.poll_base) {
            // Reap the launch script when it eventually exits.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("The launch script exited ({}) before the server answered. {}", status, log_hint));
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Err(format!("The server did not answer within {} seconds. {}", START_TIMEOUT.as_secs(), log_hint))
}

fn stop_server(settings: &Settings) -> Result<(), String> {
    let log_hint = format!("Details are in {}.", logs_dir(settings).display());
    let status = launcher_command(settings, "stop")?
        .status()
        .map_err(|e| format!("Could not run the stop script: {}. {}", e, log_hint))?;
    if !status.success() {
        return Err(format!("The stop script failed ({}). {}", status, log_hint));
    }
    // installed-service stops the server it started; wait for the port to go
    // quiet before reporting, so a restart does not race the old process.
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if !probe_health(&settings.poll_base) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(format!(
        "The server at {} is still answering. It may have been started some other way. {}",
        settings.poll_base, log_hint
    ))
}

// --- Reminders -----------------------------------------------------------------
//
// Each reminder is shown once and acknowledged once the user has dealt with
// it: clicked it, or cleared it from Notification Center. Until then it stays
// queued on the server, so a reminder is not lost if this helper quits first.
// `in_flight` keeps a reminder from being shown twice while it waits.

fn spawn_notification_thread(settings: Settings, running: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let pending_url = format!("{}/api/internal/desktop-notifications/pending?limit=20", settings.poll_base);
        let ack_url = Arc::new(format!("{}/api/internal/desktop-notifications/ack", settings.poll_base));
        let in_flight: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        loop {
            if running.load(Ordering::Relaxed) {
                for n in poll_pending(&pending_url).unwrap_or_default() {
                    let is_new = in_flight.lock().map(|mut set| set.insert(n.id.clone())).unwrap_or(false);
                    if is_new {
                        show_reminder(n, settings.app_url.clone(), ack_url.clone(), in_flight.clone());
                    }
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

fn show_reminder(n: NotificationDto, app_url: String, ack_url: Arc<String>, in_flight: Arc<Mutex<HashSet<String>>>) {
    std::thread::spawn(move || {
        let body = n.body.clone().unwrap_or_default();
        // Blocks this thread until the notification is clicked or cleared.
        let response = mac_notification_sys::Notification::new()
            .title(&n.title)
            .message(&body)
            .default_sound()
            .wait_for_click(true)
            .send();
        match response {
            Ok(response) => {
                if response == mac_notification_sys::NotificationResponse::Click {
                    open_url(&resolve_open_url(&app_url, n.url.as_deref()));
                }
                // Stays in `in_flight` until acknowledged, so the next poll
                // does not show it again while the ack is retried.
                for _ in 0..30 {
                    if ack(&ack_url, &n.id) {
                        break;
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
            }
            Err(_) => {
                // Not shown: leave it queued and try again on a later poll.
                std::thread::sleep(Duration::from_secs(60));
                if let Ok(mut set) = in_flight.lock() {
                    set.remove(&n.id);
                }
            }
        }
    });
}

fn poll_pending(url: &str) -> Option<Vec<NotificationDto>> {
    let body = ureq::get(url).timeout(Duration::from_secs(4)).call().ok()?.into_string().ok()?;
    serde_json::from_str::<PendingResponse>(&body).ok().map(|r| r.notifications)
}

fn ack(url: &str, id: &str) -> bool {
    let body = serde_json::json!({ "ids": [id] }).to_string();
    ureq::post(url)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(4))
        .send_string(&body)
        .is_ok()
}

// --- Small helpers -----------------------------------------------------------

fn load_icon() -> Icon {
    let img = image::load_from_memory(MENU_BAR_ICON_PNG)
        .expect("decode menu-bar icon PNG")
        .into_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).expect("menu-bar icon from rgba")
}

fn open_url(target: &str) {
    let _ = Command::new("/usr/bin/open").arg(target).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

/// A short status banner. Runs on its own thread because sending waits for
/// delivery.
fn notify_status(title: &'static str, body: &'static str) {
    std::thread::spawn(move || {
        let _ = mac_notification_sys::send_notification(title, None, body, None);
    });
}

/// A blocking alert for errors the user needs to read. Text is passed as
/// arguments, never spliced into the script.
fn alert(title: &str, message: &str) {
    let _ = Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "display alert (item 1 of argv) message (item 2 of argv) as critical",
            "-e",
            "end run",
            title,
            message,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn today_yyyymmdd() -> String {
    Command::new("/bin/date")
        .arg("+%Y%m%d")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() == 8)
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn urls_default_to_port_3100_on_loopback() {
        let (poll, app) = resolve_urls(&[], &serde_json::Value::Null);
        assert_eq!(poll, "http://127.0.0.1:3100");
        assert_eq!(app, "http://127.0.0.1:3100");
    }

    #[test]
    fn env_port_beats_config_and_wildcard_host_opens_localhost() {
        let config = serde_json::json!({ "server": { "port": 3200, "host": "0.0.0.0" } });
        let (poll, app) = resolve_urls(&env(&[("PORT", "3199")]), &config);
        assert_eq!(poll, "http://127.0.0.1:3199");
        assert_eq!(app, "http://localhost:3199");
    }

    #[test]
    fn public_url_is_opened_but_polling_stays_on_loopback() {
        let config = serde_json::json!({ "server": { "port": 3200 }, "auth": { "publicBaseUrl": "https://pc.example.test/app" } });
        let (poll, app) = resolve_urls(&[], &config);
        assert_eq!(poll, "http://127.0.0.1:3200");
        assert_eq!(app, "https://pc.example.test");
    }

    #[test]
    fn reminder_links_stay_inside_the_instance() {
        let base = "http://localhost:3100";
        assert_eq!(resolve_open_url(base, Some("/calendar")), "http://localhost:3100/calendar");
        assert_eq!(resolve_open_url(base, Some("//evil.test/x")), "http://localhost:3100/");
        assert_eq!(resolve_open_url(base, Some("https://evil.test")), "http://localhost:3100/");
        assert_eq!(resolve_open_url(base, None), "http://localhost:3100/");
    }

    #[test]
    fn reads_and_unescapes_a_plist_string() {
        let text = "<dict><key>PaperclipSource</key>\n  <string>/Users/a &amp; b/paperclip</string></dict>";
        assert_eq!(plist_string(text, "PaperclipSource").as_deref(), Some("/Users/a & b/paperclip"));
        assert_eq!(plist_string(text, "Missing"), None);
    }

    #[test]
    fn origin_rejects_non_http_and_credentials() {
        assert_eq!(url_origin("http://host:9/x?y").as_deref(), Some("http://host:9"));
        assert_eq!(url_origin("file:///etc"), None);
        assert_eq!(url_origin("http://user@host/"), None);
    }
}
