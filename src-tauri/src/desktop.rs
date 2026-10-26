use crate::{
    docking, native, tibo,
    settings::{self, Settings},
    update::{self, Updater},
    usage::{self, Collector, Snapshot},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub collector: Mutex<Collector>,
    pub snapshot: Mutex<Snapshot>,
    pub updater: Updater,
    pub tibo: Mutex<tibo::Snapshot>,
    docking: Mutex<docking::Docking>,
    dock_revision: AtomicU64,
    panel: AtomicBool,
    stop: AtomicBool,
    quitting: AtomicBool,
}
fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}
fn payload(state: &AppState) -> Settings {
    state
        .settings
        .lock()
        .unwrap()
        .payload(state.panel.load(Ordering::Relaxed))
}
fn show(app: &AppHandle) {
    reveal_dock(app);
    if let Some(w) = window(app) {
        let _ = w.unminimize();
        native::tool_window(&w);
        let _ = w.show();
        let enabled = app
            .state::<AppState>()
            .settings
            .lock()
            .unwrap()
            .always_on_top;
        if enabled {
            native::raise(&w, true);
        }
        let _ = w.set_focus();
    }
    let _ = tray_menu(app);
}
fn reveal_dock(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.dock_revision.fetch_add(1, Ordering::SeqCst);
    state.docking.lock().unwrap().reveal(docking::now());
    if let Some(w) = window(app) {
        if native::set_clip(&w, None).is_err() { state.docking.lock().unwrap().retry_clip(); }
    }
}
fn hide_window(app: &AppHandle) {
    if let Some(w) = window(app) {
        let _ = w.hide();
    }
    let _ = tray_menu(app);
}
fn tray_menu(app: &AppHandle) -> tauri::Result<()> {
    let s = app.state::<AppState>();
    let settings = s.settings.lock().unwrap().clone();
    let visible = window(app).is_some_and(|w| w.is_visible().unwrap_or(false));
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        if visible {
            "隐藏仪表盘"
        } else {
            "显示仪表盘"
        },
        true,
        None::<&str>,
    )?;
    let top = CheckMenuItem::with_id(
        app,
        "top",
        "始终置顶",
        true,
        settings.always_on_top,
        None::<&str>,
    )?;
    let small = CheckMenuItem::with_id(
        app,
        "small",
        "小",
        true,
        settings.size == "small",
        None::<&str>,
    )?;
    let dock = CheckMenuItem::with_id(app, "dock", "贴边吸附隐藏", true, settings.edge_dock, None::<&str>)?;
    let medium = CheckMenuItem::with_id(
        app,
        "medium",
        "中",
        true,
        settings.size == "medium",
        None::<&str>,
    )?;
    let large = CheckMenuItem::with_id(
        app,
        "large",
        "大",
        true,
        settings.size == "large",
        None::<&str>,
    )?;
    let sizes = Submenu::with_items(app, "窗口大小", true, &[&small, &medium, &large])?;
    let motion = CheckMenuItem::with_id(
        app,
        "motion",
        "减少动画",
        true,
        settings.reduced_motion,
        None::<&str>,
    )?;
    let fold = CheckMenuItem::with_id(
        app,
        "fold",
        "自动折叠窗口",
        !settings.edge_dock,
        !settings.edge_dock && settings.auto_hide_chrome,
        None::<&str>,
    )?;
    let login = CheckMenuItem::with_id(
        app,
        "login",
        "开机启动",
        true,
        settings.launch_at_login,
        None::<&str>,
    )?;
    let check = MenuItem::with_id(app, "check", "检查更新", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle, &top, &dock, &sizes, &motion, &fold, &login, &check, &sep, &exit,
        ],
    )?;
    if let Some(tray) = app.tray_by_id("dashboard") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
fn broadcast(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = app.emit("settings:update", payload(&state));
    let _ = tray_menu(app);
}
fn patch_settings(app: &AppHandle, patch: Value) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    let (old, next) = {
        let mut s = state.settings.lock().unwrap();
        let old = s.clone();
        let mut next = old.clone();
        next.patch(&patch);
        if update::enabled()
            && settings::test_dir().is_none()
            && old.launch_at_login != next.launch_at_login
        {
            settings::autostart(next.launch_at_login)?;
        }
        if let Err(error) = settings::save(&next) {
            if update::enabled()
                && settings::test_dir().is_none()
                && old.launch_at_login != next.launch_at_login
            {
                let _ = settings::autostart(old.launch_at_login);
            }
            return Err(error);
        }
        *s = next.clone();
        (old, next)
    };
    if old.always_on_top != next.always_on_top {
        if let Some(w) = window(app) {
            let _ = w.set_always_on_top(next.always_on_top);
            native::raise(&w, next.always_on_top);
        }
    }
    if old.edge_dock != next.edge_dock {
        state.dock_revision.fetch_add(1, Ordering::SeqCst);
        state.docking.lock().unwrap().reset();
        if let Some(w) = window(app) {
            if native::set_clip(&w, None).is_err() { state.docking.lock().unwrap().retry_clip(); }
        }
    }
    broadcast(app);
    Ok(payload(&state))
}

#[tauri::command]
fn get_initial(state: State<AppState>) -> Value {
    json!({"usage":state.snapshot.lock().unwrap().clone(),"settings":payload(&state),"appInfo":{"version":env!("CARGO_PKG_VERSION"),"buildKind":update::build_kind(),"updateEnabled":update::enabled()},"updateStatus":state.updater.status(),"tibo":state.tibo.lock().unwrap().clone()})
}
#[tauri::command]
fn update_settings(app: AppHandle, patch: Value) -> Result<Settings, String> {
    patch_settings(&app, patch)
}
#[tauri::command]
fn test_report(app: AppHandle, result: Value) -> Result<(), String> {
    let root = settings::test_dir().ok_or("Test reporting is disabled")?;
    std::fs::write(root.join("report.json"), result.to_string()).map_err(|e| e.to_string())?;
    app.state::<AppState>()
        .quitting
        .store(true, Ordering::Relaxed);
    app.exit(if result["passed"] == true { 0 } else { 1 });
    Ok(())
}
#[tauri::command]
fn test_update_status(app: AppHandle, status: update::Status) -> Result<(), String> {
    settings::test_dir().ok_or("Test controls are disabled")?;
    *app.state::<AppState>().updater.status.lock().unwrap() = status.clone();
    app.emit("update:status", status).map_err(|e| e.to_string())
}
#[tauri::command]
async fn reset_history(app: AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let clock = usage::now();
        {
            let mut s = state.settings.lock().unwrap();
            let mut next = s.clone();
            next.history_reset_at = clock;
            settings::save(&next)?;
            *s = next;
        }
        let result = state.collector.lock().unwrap().reset(clock, clock);
        *state.snapshot.lock().unwrap() = result.clone();
        let _ = app.emit("usage:update", &result);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn set_panel_open(app: AppHandle, open: bool) {
    let state = app.state::<AppState>();
    if state.panel.swap(open, Ordering::Relaxed) != open {
        if open { reveal_dock(&app); }
        broadcast(&app);
    }
}
#[tauri::command]
fn set_content_size(app: AppHandle, size: Value) -> Result<(), String> {
    let current = payload(&app.state::<AppState>());
    let Some(height) = size["height"].as_u64().filter(|h| *h >= 60 && *h <= 2000) else {
        return Ok(());
    };
    let effective = current.view_size.as_deref().unwrap();
    if size["viewSize"] != effective {
        return Ok(());
    }
    if let Some(w) = window(&app) {
        resize(
            &w,
            (272.0 * settings::scale(effective)).round(),
            height as f64,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn resize(w: &WebviewWindow, width: f64, height: f64) -> tauri::Result<()> {
    let scale = w.scale_factor()?;
    let old_size = w.outer_size()?;
    let old = w.outer_position()?;
    let pw = (width * scale).round() as i32;
    let ph = (height * scale).round() as i32;
    if old_size.width as i32 == pw && old_size.height as i32 == ph {
        return Ok(());
    }
    let mut x = old.x + old_size.width as i32 - pw;
    let mut y = old.y + old_size.height as i32 - ph;
    if let Some(monitor) = w.current_monitor()? {
        let area = monitor.work_area();
        x = x.clamp(
            area.position.x,
            (area.position.x + area.size.width as i32 - pw).max(area.position.x),
        );
        y = y.clamp(
            area.position.y,
            (area.position.y + area.size.height as i32 - ph).max(area.position.y),
        );
    }
    w.set_size(LogicalSize::new(width, height))?;
    w.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}
#[tauri::command]
fn hide(app: AppHandle) {
    hide_window(&app);
}
#[tauri::command]
fn quit(app: AppHandle) {
    app.state::<AppState>()
        .quitting
        .store(true, Ordering::Relaxed);
    app.exit(0);
}
#[tauri::command]
fn test_tibo_status(app: AppHandle, snapshot: tibo::Snapshot) -> Result<(), String> {
    settings::test_dir().ok_or("Test controls are disabled")?;
    *app.state::<AppState>().tibo.lock().unwrap() = snapshot.clone();
    app.emit("tibo:update", snapshot).map_err(|e| e.to_string())
}
#[tauri::command]
fn test_window_state(app: AppHandle) -> Result<Value, String> {
    settings::test_dir().ok_or("Test controls are disabled")?;
    let w = window(&app).ok_or("Missing test window")?;
    Ok(json!({"topmost":native::styles(&w).0,"processName":std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())),"launcher":crate::runtime::launcher_path().ok()}))
}
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<update::Status, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().updater.check(&app))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<update::Status, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().updater.install(&app))
        .await
        .map_err(|e| e.to_string())
}

pub fn run() {
    let builder = tauri::Builder::default();
    let builder = if settings::test_dir().is_none() {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if window(app).is_some() {
                show(app);
            }
        }))
    } else {
        builder
    };
    let app = builder
        .invoke_handler(tauri::generate_handler![
            get_initial,
            update_settings,
            reset_history,
            set_panel_open,
            set_content_size,
            hide,
            quit,
            check_update,
            install_update,
            test_report,
            test_update_status,
            test_tibo_status,
            test_window_state
        ])
        .setup(|app| {
            let settings = settings::load();
            let mut collector = Collector::new(Collector::home(), settings.history_reset_at);
            let snapshot = collector.snapshot(usage::now());
            let width = (272.0 * settings::scale(&settings.size)).round();
            let height = (560.0 * settings::scale(&settings.size)).ceil();
            // Register state before creating the WebView: renderer commands or
            // a second-instance callback may arrive during window creation.
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
                collector: Mutex::new(collector),
                snapshot: Mutex::new(snapshot),
                updater: Updater::new(),
                tibo: Mutex::new(tibo::Snapshot::default()),
                docking: Mutex::new(docking::Docking::default()),
                dock_revision: AtomicU64::new(0),
                panel: AtomicBool::new(false),
                stop: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
            });
            let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Codex Drive")
                .inner_size(width, height)
                .decorations(false)
                .transparent(true)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .no_redirection_bitmap(true)
                .shadow(false)
                .resizable(false)
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .always_on_top(settings.always_on_top)
                .data_directory(
                    settings::test_dir()
                        .map(|root| root.join("webview2"))
                        .unwrap_or(app.path().app_local_data_dir()?),
                )
                .build()?;
            native::tool_window(&w);
            if let Some(m) = w.primary_monitor()? {
                let area = m.work_area();
                let scale = m.scale_factor();
                let default = PhysicalPosition::new(
                    area.position.x + area.size.width as i32 - ((width + 24.0) * scale) as i32,
                    area.position.y + area.size.height as i32 - ((height + 24.0) * scale) as i32,
                );
                let saved = settings.position.as_ref().and_then(|p| {
                    w.available_monitors()
                        .ok()?
                        .into_iter()
                        .find_map(|monitor| {
                            let factor = monitor.scale_factor();
                            let units = if settings.position_is_physical {
                                1.0
                            } else {
                                factor
                            };
                            let x = (p.x * units).round() as i32;
                            let y = (p.y * units).round() as i32;
                            let a = monitor.work_area();
                            (x + (width * factor) as i32 > a.position.x + 30
                                && x < a.position.x + a.size.width as i32 - 30
                                && y + (height * factor) as i32 > a.position.y + 30
                                && y < a.position.y + a.size.height as i32 - 30)
                                .then_some(PhysicalPosition::new(x, y))
                        })
                });
                w.set_position(saved.unwrap_or(default))?;
            }
            let launch = settings.launch_at_login;
            if update::enabled() && launch && settings::test_dir().is_none() {
                if let Err(e) = settings::autostart(true) {
                    update::log(&format!("autostart migration failed: {e}"));
                }
            }
            TrayIconBuilder::with_id("dashboard")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Codex Drive")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        }
                    ) {
                        show(tray.app_handle());
                    } else if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) { /* Double click preserves the existing behavior. */
                    }
                })
                .on_menu_event(|app, event| {
                    let state = app.state::<AppState>();
                    let s = state.settings.lock().unwrap().clone();
                    let patch = match event.id.as_ref() {
                        "toggle" => {
                            if window(app).is_some_and(|w| w.is_visible().unwrap_or(false)) {
                                hide_window(app);
                            } else {
                                show(app);
                            }
                            return;
                        }
                        "top" => json!({"alwaysOnTop":!s.always_on_top}),
                        "dock" => json!({"edgeDock":!s.edge_dock}),
                        "motion" => json!({"reducedMotion":!s.reduced_motion}),
                        "fold" => json!({"autoHideChrome":!s.auto_hide_chrome}),
                        "login" => json!({"launchAtLogin":!s.launch_at_login}),
                        size @ ("small" | "medium" | "large") => json!({"size":size}),
                        "check" => {
                            let handle = app.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                let status = handle.state::<AppState>().updater.check(&handle);
                                if status.state == "available" {
                                    let _ = handle.emit("app:openSettings", ());
                                    show(&handle);
                                }
                            });
                            return;
                        }
                        "quit" => {
                            state.quitting.store(true, Ordering::Relaxed);
                            app.exit(0);
                            return;
                        }
                        _ => return,
                    };
                    if let Err(e) = patch_settings(app, patch) {
                        update::log(&format!("settings failed: {e}"));
                    }
                })
                .build(app)?;
            tray_menu(app.handle())?;
            w.on_window_event({
                let handle = app.handle().clone();
                move |event| {
                    let state = handle.state::<AppState>();
                    match event {
                        WindowEvent::CloseRequested { api, .. } => {
                            if !state.quitting.load(Ordering::Relaxed) {
                                api.prevent_close();
                                hide_window(&handle);
                            }
                        }
                        WindowEvent::Focused(true) => {
                            if let Some(w) = window(&handle) {
                                native::tool_window(&w);
                            }
                        }
                        WindowEvent::Moved(p) => {
                            if window(&handle).is_some() {
                                let mut s = state.settings.lock().unwrap();
                                s.position = Some(settings::Position {
                                    x: p.x as f64,
                                    y: p.y as f64,
                                });
                                s.position_is_physical = true;
                            }
                        }
                        WindowEvent::Resized(_) => {
                            if let Some(w) = window(&handle) {
                                native::tool_window(&w);
                            }
                        }
                        _ => {}
                    }
                }
            });
            w.show()?;
            if settings::test_dir().is_some() {
                let view = w.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let _ = view.eval(include_str!("../ui-test.js"));
                });
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let started = std::time::Instant::now();
                let state = handle.state::<AppState>();
                if state.stop.load(Ordering::Relaxed) {
                    break;
                }
                let result = {
                    let mut collector = state.collector.lock().unwrap();
                    collector.poll(usage::now(), false);
                    collector.snapshot(usage::now())
                };
                *state.snapshot.lock().unwrap() = result.clone();
                let _ = handle.emit("usage:update", result);
                std::thread::sleep(
                    std::time::Duration::from_secs(2).saturating_sub(started.elapsed()),
                );
            });
            // Hover detection also works when the visible strip is covered by
            // another normal window. Native reveal never activates the app.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let state = handle.state::<AppState>();
                if state.stop.load(Ordering::Relaxed) { break; }
                if let Some(w) = window(&handle) {
                    let enabled = state.settings.lock().unwrap().edge_dock;
                    let needs_update = state.docking.lock().unwrap().needs_update();
                    if (enabled || needs_update) && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
                        if let (Ok(position), Ok(size), Ok(Some(monitor))) = (w.outer_position(), w.outer_size(), w.current_monitor()) {
                            let area = monitor.work_area();
                            let revision = state.dock_revision.load(Ordering::SeqCst);
                            let cursor = w.cursor_position().ok().map(|p| (p.x.floor() as i32, p.y.floor() as i32));
                            let frame = docking::Frame {
                                enabled,
                                rect: docking::Rect { x: position.x, y: position.y, width: size.width as i32, height: size.height as i32 },
                                area: docking::Rect { x: area.position.x, y: area.position.y, width: area.size.width as i32, height: area.size.height as i32 },
                                scale: monitor.scale_factor(),
                                cursor,
                                pointer_on_window: cursor.is_some_and(|p| native::pointer_on_window(&w, p)),
                                mouse_down: native::mouse_down(),
                                panel_open: state.panel.load(Ordering::Relaxed),
                                now: docking::now(),
                            };
                            let plan = state.docking.lock().unwrap().update(frame);
                            if revision != state.dock_revision.load(Ordering::SeqCst) { continue; }
                            // Never hold state locks across calls dispatched to
                            // the UI thread (settings commands run there too).
                            if let Some((x, y)) = plan.position { let _ = w.set_position(PhysicalPosition::new(x, y)); }
                            let still_enabled = state.settings.lock().unwrap().edge_dock;
                            if still_enabled && native::styles(&w).0 { native::raise(&w, false); }
                            if plan.raise { native::raise_normal(&w, cursor); }
                            if let Some(clip) = plan.clip {
                                if native::set_clip(&w, clip).is_err() { state.docking.lock().unwrap().retry_clip(); }
                            }
                            // A simultaneous tray/settings action wins over a
                            // stale hide plan, even if it arrived during IPC.
                            if revision != state.dock_revision.load(Ordering::SeqCst) {
                                let _ = native::set_clip(&w, None);
                                state.docking.lock().unwrap().retry_clip();
                            }
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            });
            // Native polling continues while the WebView is hidden or folded.
            // Keep network waits off the usage and window-maintenance threads.
            if settings::test_dir().is_none() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut tracker = tibo::Tracker::new();
                    loop {
                        let state = handle.state::<AppState>();
                        if state.stop.load(Ordering::Relaxed) { break; }
                        let minutes = state.settings.lock().unwrap().tibo_poll_minutes;
                        if tracker.poll(std::time::Duration::from_secs(minutes * 60)) {
                            *state.tibo.lock().unwrap() = tracker.snapshot.clone();
                            let _ = handle.emit("tibo:update", &tracker.snapshot);
                        }
                        std::thread::sleep(std::time::Duration::from_secs(1));
                    }
                });
            }
            // Window maintenance and update timers must not wait for a cold
            // history scan or a large appended session file.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                let mut next_check = started + std::time::Duration::from_secs(5);
                let mut first_check = true;
                let mut last_position = None;
                loop {
                    let loop_start = std::time::Instant::now();
                    let state = handle.state::<AppState>();
                    if state.stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let s = state.settings.lock().unwrap().clone();
                    if let Some(w) = window(&handle) {
                        native::maintain(&w, s.always_on_top);
                    }
                    {
                        let latest = state.settings.lock().unwrap();
                        let position = latest.position.as_ref().map(|p| (p.x, p.y));
                        if position != last_position {
                            if let Err(e) = settings::save(&latest) {
                                update::log(&format!("position save failed: {e}"));
                            } else {
                                last_position = position;
                            }
                        }
                    }
                    if update::enabled()
                        && settings::test_dir().is_none()
                        && std::time::Instant::now() >= next_check
                    {
                        if first_check {
                            next_check = started + std::time::Duration::from_secs(14400);
                            first_check = false;
                        } else {
                            next_check += std::time::Duration::from_secs(14400);
                        }
                        let h = handle.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let state = h.state::<AppState>();
                            if ["idle", "latest", "error"]
                                .contains(&state.updater.status().state.as_str())
                            {
                                state.updater.check(&h);
                            }
                        });
                    }
                    std::thread::sleep(
                        std::time::Duration::from_secs(1).saturating_sub(loop_start.elapsed()),
                    );
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("创建 Codex Drive 窗口失败");
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            let state = handle.state::<AppState>();
            state.stop.store(true, Ordering::Relaxed);
            let _ = settings::save(&state.settings.lock().unwrap());
        }
    });
}

// An isolated real Windows regression executable mode: no settings, session
// collection, startup registration or GitHub requests are initialized.
#[cfg(windows)]
fn verify_dock_window(w: &WebviewWindow) {
    use docking::{Docking, Frame, Rect};
    let monitor = w.current_monitor().unwrap().unwrap();
    let area = monitor.work_area();
    let area = Rect { x: area.position.x, y: area.position.y, width: area.size.width as i32, height: area.size.height as i32 };
    let size = w.outer_size().unwrap();
    let width = size.width as i32;
    let height = size.height as i32;
    let middle_x = area.x + (area.width - width) / 2;
    let middle_y = area.y + (area.height - height) / 2;
    for (x, y) in [(area.x, middle_y), (area.x + area.width - width, middle_y), (middle_x, area.y), (middle_x, area.y + area.height - height)] {
        w.set_position(PhysicalPosition::new(x, y)).unwrap();
        let rect = Rect { x, y, width, height };
        let frame = |now, cursor, panel_open| Frame { enabled: true, rect, area, scale: monitor.scale_factor(), cursor, pointer_on_window: true, mouse_down: false, panel_open, now };
        let outside = Some((area.x - 1000, area.y - 1000));
        let mut dock = Docking::default();
        dock.update(frame(200, outside, false));
        let hidden = dock.update(frame(1000, outside, false));
        let clip = hidden.clip.unwrap().unwrap();
        native::set_clip(w, Some(clip)).unwrap();
        assert_eq!(native::clip_bounds(w), Some(clip), "native region must contain only the edge strip");
        assert_eq!(w.outer_size().unwrap(), size, "hiding preserves content dimensions");
        let open_panel = dock.update(frame(1100, outside, true));
        native::set_clip(w, open_panel.clip.unwrap()).unwrap();
        assert_eq!(native::clip_bounds(w), None, "panels restore the entire native region");
        dock.update(frame(1200, outside, false));
        native::set_clip(w, dock.update(frame(2100, outside, false)).clip.unwrap()).unwrap();
        let point = Some((x + clip.x + clip.width / 2, y + clip.y + clip.height / 2));
        let reveal = dock.update(frame(2200, point, false));
        assert!(reveal.raise);
        native::raise_normal(w, point);
        native::set_clip(w, reveal.clip.unwrap()).unwrap();
        assert_eq!(native::clip_bounds(w), None);
        assert!(!native::styles(w).0, "hover reveal must not enable topmost");
        assert!(!native::foreground(w), "hover reveal must not take keyboard focus");
        dock.update(frame(2300, outside, false));
        native::set_clip(w, dock.update(frame(3200, outside, false)).clip.unwrap()).unwrap();
        let mut disabled = frame(3300, outside, false);
        disabled.enabled = false;
        native::set_clip(w, dock.update(disabled).clip.unwrap()).unwrap();
        assert_eq!(native::clip_bounds(w), None, "disabling removes the native mask");
    }
}

pub fn window_test(report: std::path::PathBuf) {
    let application=tauri::Builder::default().setup(move|app|{
        let pet=WebviewWindowBuilder::new(app,"test-dashboard",WebviewUrl::External("about:blank".parse().unwrap())).inner_size(180.0,120.0).position(30.0,30.0).decorations(false).transparent(true).shadow(false).skip_taskbar(true).focused(false).always_on_top(true).data_directory(report.parent().unwrap().join("webview2")).build()?;
        native::tool_window(&pet);
        let blocker=WebviewWindowBuilder::new(app,"test-overlay",WebviewUrl::External("about:blank".parse().unwrap())).inner_size(210.0,150.0).position(30.0,30.0).skip_taskbar(true).always_on_top(true).data_directory(report.parent().unwrap().join("webview2")).build()?;
        let handle=app.handle().clone();let output=report.clone();
        std::thread::spawn(move||{
            let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
                use std::{thread::sleep,time::Duration};
                native::raise(&blocker,true);blocker.set_focus().unwrap();sleep(Duration::from_millis(200));
                assert_eq!(native::styles(&pet),(true,true,false));
                assert!(!native::above(&pet,&blocker),"later topmost overlay must cover dashboard");
                for _ in 0..3{native::maintain(&pet,true);sleep(Duration::from_millis(400));}
                assert!(!native::above(&pet,&blocker),"maintenance cannot raise over screenshot overlay");
                assert!(!native::foreground(&pet),"maintenance cannot steal foreground focus");
                native::raise(&blocker,false);assert!(native::above(&pet,&blocker),"ordinary windows stay below dashboard");
                pet.set_position(PhysicalPosition::new(45,45)).unwrap();pet.set_size(LogicalSize::new(220.0,180.0)).unwrap();native::maintain(&pet,true);
                assert_eq!(native::styles(&pet),(true,true,false));
                native::raise(&pet,false);assert!(!native::styles(&pet).0);native::maintain(&pet,true);assert!(native::styles(&pet).0);
                native::raise(&pet,false);native::maintain(&pet,false);assert!(!native::styles(&pet).0);
                pet.hide().unwrap();native::maintain(&pet,true);assert!(!pet.is_visible().unwrap());assert!(!native::styles(&pet).0);
                pet.show().unwrap();native::raise(&pet,true);native::tool_window(&pet);pet.minimize().unwrap();pet.unminimize().unwrap();native::tool_window(&pet);
                assert_eq!(native::styles(&pet),(true,true,false));
                #[cfg(windows)]
                { blocker.set_focus().unwrap(); sleep(Duration::from_millis(100)); native::raise(&pet,false); verify_dock_window(&pet); verify_covered_dock(&pet, output.parent().unwrap()); }
            }));
            let ok=outcome.is_ok();let _=std::fs::write(&output,json!({"passed":ok,"checks":["native topmost","tool window","screenshot overlay order","foreground focus","move and resize","lost flag repair","disabled maintenance","hide restore","four-edge native clipping","hover reveal without focus or topmost","panel and dock disable restore","separate-process cover before and after hide"]}).to_string());
            handle.exit(if ok{0}else{1});
        });Ok(())
    }).build(tauri::generate_context!()).expect("native regression application");
    application.run(|_, _| {});
}

#[cfg(windows)]
fn verify_covered_dock(w: &WebviewWindow, root: &std::path::Path) {
    use docking::{Docking, Frame, Rect};
    use std::{os::windows::process::CommandExt, time::{Duration, Instant}};
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
    struct Cover(std::process::Child);
    impl Drop for Cover {
        fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
    }
    let monitor = w.current_monitor().unwrap().unwrap();
    let area = monitor.work_area();
    let area = Rect { x: area.position.x, y: area.position.y, width: area.size.width as i32, height: area.size.height as i32 };
    let size = w.outer_size().unwrap();
    let width = size.width as i32;
    let height = size.height as i32;
    let fixture = root.join("cover.json");
    std::fs::write(&fixture, json!({"x":area.x,"y":area.y,"width":width,"height":height}).to_string()).unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap()).arg("--test-cover").arg(&fixture).creation_flags(0x08000000).spawn().unwrap();
    unsafe { let _ = AllowSetForegroundWindow(child.id()); }
    let _cover = Cover(child);
    let deadline = Instant::now() + Duration::from_secs(5);
    let handle = loop {
        if let Some(handle) = std::fs::read(&fixture).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).and_then(|v| v["handle"].as_i64()) {
            if unsafe { GetForegroundWindow().0 as isize } == handle as isize { break handle as isize; }
        }
        assert!(Instant::now() < deadline, "cover helper must become the foreground app");
        std::thread::sleep(Duration::from_millis(20));
    };
    let positions = [(area.x, area.y + 100), (area.x + area.width - width, area.y + 100), (area.x + 100, area.y), (area.x + 100, area.y + area.height - height)];
    for (index, (x, y)) in positions.into_iter().enumerate() {
        w.set_position(PhysicalPosition::new(x, y)).unwrap();
        let rect = Rect { x, y, width, height };
        let point = match index { 0 => (x + 2, y + height / 2), 1 => (x + width - 2, y + height / 2), 2 => (x + width / 2, y + 2), _ => (x + width / 2, y + height - 2) };
        let frame = |now, cursor| Frame { enabled: true, rect, area, scale: monitor.scale_factor(), cursor, pointer_on_window: cursor.is_some_and(|p| native::pointer_on_window(w, p)), mouse_down: false, panel_open: false, now };
        let cover = || unsafe { SetWindowPos(HWND(handle as _), Some(HWND_TOP), x, y, width, height, SWP_NOACTIVATE).unwrap(); };
        cover();
        assert!(!native::above_handle(w, handle), "other process must cover the dashboard");
        assert!(!native::pointer_on_window(w, point), "edge point belongs to the covering app");
        let mut dock = Docking::default();
        dock.update(frame(200, Some((x + width / 2, y + height / 2))));
        let reveal = dock.update(frame(300, Some(point)));
        assert!(reveal.raise, "edge entry raises even before hide finishes");
        native::raise_normal(w, Some(point));
        if let Some(clip) = reveal.clip { native::set_clip(w, clip).unwrap(); }
        assert!(native::above_handle(w, handle), "hover must reveal above a different foreground process");
        assert_eq!(unsafe { GetForegroundWindow().0 as isize }, handle, "hover cannot steal foreground focus");
        let outside = Some((area.x - 1000, area.y - 1000));
        dock.update(frame(400, outside));
        native::set_clip(w, dock.update(frame(1200, outside)).clip.unwrap()).unwrap();
        cover();
        let reveal = dock.update(frame(1300, Some(point)));
        assert!(reveal.raise);
        native::raise_normal(w, Some(point));
        native::set_clip(w, reveal.clip.unwrap()).unwrap();
        assert!(native::above_handle(w, handle), "hidden dashboard must reveal above the cover");
        assert_eq!(native::clip_bounds(w), None);
        assert!(!native::styles(w).0);
        assert_eq!(unsafe { GetForegroundWindow().0 as isize }, handle);
        unsafe { SetWindowPos(HWND(handle as _), Some(HWND_TOPMOST), x, y, width, height, SWP_NOACTIVATE).unwrap(); }
        dock.update(frame(1400, outside));
        native::set_clip(w, dock.update(frame(2200, outside)).clip.unwrap()).unwrap();
        let reveal = dock.update(frame(2300, Some(point)));
        assert!(reveal.raise);
        native::raise_normal(w, Some(point));
        native::set_clip(w, reveal.clip.unwrap()).unwrap();
        assert!(!native::above_handle(w, handle), "topmost overlays keep their order");
        assert!(!native::styles(w).0);
        assert_eq!(unsafe { GetForegroundWindow().0 as isize }, handle);
        unsafe { SetWindowPos(HWND(handle as _), Some(HWND_NOTOPMOST), x, y, width, height, SWP_NOACTIVATE).unwrap(); }
    }
}
