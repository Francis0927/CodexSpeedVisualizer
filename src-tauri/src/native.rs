use tauri::WebviewWindow;
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
    use windows::Win32::UI::WindowsAndMessaging::*;
    let own = window.hwnd().unwrap().0;
    let mut cursor = unsafe {
        GetWindow(
            windows::Win32::Foundation::HWND(other.hwnd().unwrap().0),
            GW_HWNDPREV,
        )
        .ok()
    };
    for _ in 0..10000 {
        match cursor {
            Some(handle) if handle.0 == own => return true,
            Some(handle) if !handle.is_invalid() => {
                cursor = unsafe { GetWindow(handle, GW_HWNDPREV).ok() }
            }
            _ => return false,
        }
    }
    false
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
