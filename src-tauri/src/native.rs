use tauri::WebviewWindow;

#[cfg(windows)]
fn on_window_thread<T: Send + 'static>(
    window: &WebviewWindow,
    action: impl FnOnce(windows::Win32::Foundation::HWND) -> T + Send + 'static,
) -> Result<T, String> {
    let handle = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    window.run_on_main_thread(move || {
        let result = action(windows::Win32::Foundation::HWND(handle as _));
        let _ = send.send(result);
    }).map_err(|e| e.to_string())?;
    receive.recv().map_err(|e| e.to_string())
}

// Clip the native window instead of parking it on an adjacent monitor. Its
// content size and saved position stay intact, and only the edge strip receives input.
#[cfg(windows)]
pub fn set_clip(window: &WebviewWindow, clip: Option<crate::docking::Rect>) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::*;
    on_window_thread(window, move |hwnd| {
        let region = if let Some(rect) = clip {
            let region = unsafe { CreateRectRgn(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height) };
            if region.is_invalid() { return Err("无法创建贴边隐藏区域".into()); }
            Some(region)
        } else { None };
        if unsafe { SetWindowRgn(hwnd, region, true) } == 0 {
            // On success Windows owns the region; on failure it remains ours.
            if let Some(region) = region { unsafe { let _ = DeleteObject(region.into()); } }
            return Err("无法应用贴边隐藏区域".into());
        }
        Ok(())
    })?
}
#[cfg(windows)]
pub fn clip_bounds(window: &WebviewWindow) -> Option<crate::docking::Rect> {
    on_window_thread(window, |hwnd| {
        let mut rect = windows::Win32::Foundation::RECT::default();
        let kind = unsafe { windows::Win32::Graphics::Gdi::GetWindowRgnBox(hwnd, &mut rect) };
        (kind.0 > 0).then_some(crate::docking::Rect { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top })
    }).ok().flatten()
}
#[cfg(windows)]
pub fn mouse_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 }
}
#[cfg(windows)]
pub fn pointer_on_window(window: &WebviewWindow, point: (i32, i32)) -> bool {
    use windows::Win32::{Foundation::POINT, UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT}};
    let Ok(hwnd) = window.hwnd() else { return false; };
    unsafe {
        GetAncestor(WindowFromPoint(POINT { x: point.0, y: point.1 }), GA_ROOT).0 == hwnd.0
    }
}
#[cfg(windows)]
pub fn raise_normal(window: &WebviewWindow, point: Option<(i32, i32)>) {
    use windows::Win32::UI::WindowsAndMessaging::*;
    let _ = on_window_thread(window, move |hwnd| {
        unsafe {
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
            let foreground = GetForegroundWindow();
            let overlay_at_edge = point.is_some_and(|(x, y)| {
                let cover = GetAncestor(WindowFromPoint(windows::Win32::Foundation::POINT { x, y }), GA_ROOT);
                cover != hwnd && GetWindowLongPtrW(cover, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 != 0
            });
            let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0,
                flags);
            // Windows can reject HWND_TOP from a background process. A pair of
            // non-activating calls in the same UI task raises the normal window
            // without leaving it topmost or taking the other app's focus.
            // Never use this promotion against a topmost edge overlay.
            if !overlay_at_edge && !foreground.is_invalid() && foreground != hwnd
                && GetWindowLongPtrW(foreground, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 == 0
                && !above_hwnd(hwnd, foreground)
            {
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
                let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags);
            }
        }
    });
}
#[cfg(not(windows))]
pub fn set_clip(_: &WebviewWindow, clip: Option<crate::docking::Rect>) -> Result<(), String> {
    if clip.is_some() { Err("贴边隐藏仅支持 Windows".into()) } else { Ok(()) }
}
#[cfg(not(windows))]
pub fn mouse_down() -> bool { false }
#[cfg(not(windows))]
pub fn pointer_on_window(_: &WebviewWindow, _: (i32, i32)) -> bool { true }
#[cfg(not(windows))]
pub fn raise_normal(_: &WebviewWindow, _: Option<(i32, i32)>) {}
#[cfg(windows)]
pub fn styles(window: &WebviewWindow) -> (bool, bool, bool) {
    use windows::Win32::UI::WindowsAndMessaging::*;
    let Ok(handle) = window.hwnd() else {
        return (false, false, false);
    };
    let value =
        unsafe { GetWindowLongPtrW(windows::Win32::Foundation::HWND(handle.0), GWL_EXSTYLE) }
            as u32;
    (
        value & WS_EX_TOPMOST.0 != 0,
        value & WS_EX_TOOLWINDOW.0 != 0,
        value & WS_EX_APPWINDOW.0 != 0,
    )
}
#[cfg(windows)]
pub fn tool_window(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::*;
    if let Ok(handle) = window.hwnd() {
        unsafe {
            let hwnd = windows::Win32::Foundation::HWND(handle.0);
            let value = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let next = (value | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
            if value != next {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
        }
    }
    let _ = window.set_skip_taskbar(true);
}
#[cfg(windows)]
pub fn raise(window: &WebviewWindow, enabled: bool) {
    use windows::Win32::UI::WindowsAndMessaging::*;
    if let Ok(handle) = window.hwnd() {
        unsafe {
            let _ = SetWindowPos(
                windows::Win32::Foundation::HWND(handle.0),
                Some(if enabled {
                    HWND_TOPMOST
                } else {
                    HWND_NOTOPMOST
                }),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}
pub fn maintain(window: &WebviewWindow, enabled: bool) {
    if enabled
        && window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false)
        && !styles(window).0
    {
        raise(window, true);
    }
}
#[cfg(windows)]
pub fn above(window: &WebviewWindow, other: &WebviewWindow) -> bool {
    above_handle(window, other.hwnd().unwrap().0 as isize)
}
#[cfg(windows)]
pub fn above_handle(window: &WebviewWindow, other: isize) -> bool {
    above_hwnd(windows::Win32::Foundation::HWND(window.hwnd().unwrap().0), windows::Win32::Foundation::HWND(other as _))
}
#[cfg(windows)]
fn above_hwnd(own: windows::Win32::Foundation::HWND, other: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::*;
    let mut cursor = unsafe {
        GetWindow(
            other,
            GW_HWNDPREV,
        )
        .ok()
    };
    for _ in 0..10000 {
        match cursor {
            Some(handle) if handle == own => return true,
            Some(handle) if !handle.is_invalid() => {
                cursor = unsafe { GetWindow(handle, GW_HWNDPREV).ok() }
            }
            _ => return false,
        }
    }
    false
}

// A separate-process ordinary window for the isolated occlusion regression.
// This mode never initializes application settings, usage collection or updates.
#[cfg(windows)]
pub fn cover_test(fixture: std::path::PathBuf) {
    use windows::{core::w, Win32::UI::WindowsAndMessaging::*};
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&fixture).unwrap()).unwrap();
    unsafe {
        let window = CreateWindowExW(WS_EX_TOOLWINDOW, w!("STATIC"), w!("Codex dock regression cover"), WS_POPUP | WS_VISIBLE,
            value["x"].as_i64().unwrap() as i32, value["y"].as_i64().unwrap() as i32,
            value["width"].as_i64().unwrap() as i32, value["height"].as_i64().unwrap() as i32,
            None, None, None, None).unwrap();
        std::fs::write(&fixture, serde_json::json!({"handle":window.0 as isize}).to_string()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
        let mut message = MSG::default();
        let mut activated = false;
        while IsWindow(Some(window)).as_bool() && std::time::Instant::now() < deadline {
            if !activated { activated = SetForegroundWindow(window).as_bool(); }
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = DestroyWindow(window);
    }
}
#[cfg(windows)]
pub fn foreground(window: &WebviewWindow) -> bool {
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 == window.hwnd().unwrap().0
    }
}
#[cfg(windows)]
pub fn process_memory() -> (usize, usize) {
    use windows::Win32::System::{
        ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
        Threading::GetCurrentProcess,
    };
    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let size = counters.cb;
    unsafe {
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size).is_ok() {
            return (counters.WorkingSetSize, counters.PeakWorkingSetSize);
        }
    }
    (0, 0)
}
#[cfg(not(windows))]
pub fn process_memory() -> (usize, usize) {
    (0, 0)
}
#[cfg(not(windows))]
pub fn styles(window: &WebviewWindow) -> (bool, bool, bool) {
    (window.is_always_on_top().unwrap_or(false), true, false)
}
#[cfg(not(windows))]
pub fn tool_window(window: &WebviewWindow) {
    let _ = window.set_skip_taskbar(true);
}
#[cfg(not(windows))]
pub fn raise(window: &WebviewWindow, enabled: bool) {
    let _ = window.set_always_on_top(enabled);
}

pub fn ensure_webview() -> bool {
    #[cfg(windows)]
    {
        use winreg::{enums::*, RegKey};
        let installed=[HKEY_CURRENT_USER,HKEY_LOCAL_MACHINE].iter().any(|&root| {
            [KEY_READ|KEY_WOW64_32KEY,KEY_READ|KEY_WOW64_64KEY].iter().any(|&access| {
                RegKey::predef(root).open_subkey_with_flags("Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",access).ok()
                    .and_then(|key|key.get_value::<String,_>("pv").ok()).is_some_and(|v|!v.is_empty()&&v!="0.0.0.0")
            })
        });
        if installed {
            return true;
        }
        use windows::{core::w, Win32::UI::WindowsAndMessaging::*};
        let answer = unsafe {
            MessageBoxW(None,w!("Codex Drive 需要 Microsoft Edge WebView2 运行时。是否打开微软官方下载页面？安装完成后重新启动应用。离线机器请在其他设备下载 Evergreen Standalone Installer x64 后安装。"),w!("缺少 WebView2 运行时"),MB_YESNO|MB_ICONINFORMATION)
        };
        if answer == IDYES {
            let _ = std::process::Command::new("explorer.exe")
                .arg("https://developer.microsoft.com/microsoft-edge/webview2/")
                .spawn();
        }
        return false;
    }
    #[cfg(not(windows))]
    {
        true
    }
}
