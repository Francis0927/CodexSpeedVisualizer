#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod desktop;
mod docking;
mod native;
mod runtime;
mod settings;
mod tibo;
mod update;
mod usage;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    #[cfg(windows)]
    if let Some(index) = args.iter().position(|a| a == "--test-cover") {
        native::cover_test(std::path::PathBuf::from(args.get(index + 1).expect("cover fixture")));
        return;
    }
    if let Some(index) = args.iter().position(|a| a == "--test-window") {
        desktop::window_test(std::path::PathBuf::from(
            args.get(index + 1).expect("test report path"),
        ));
        return;
    }
    if let Some(index) = args.iter().position(|a| a == "--benchmark") {
        let home = std::path::PathBuf::from(args.get(index + 1).expect("fixture home"));
        let clock = args.get(index + 2).expect("fixture clock").parse().unwrap();
        let mut collector = usage::Collector::new(home, 0);
        let start = std::time::Instant::now();
        let snapshot = collector.poll(clock, false);
        let scan = start.elapsed().as_secs_f64() * 1000.0;
        let start = std::time::Instant::now();
        for _ in 0..100 {
            let _ = collector.snapshot(clock);
        }
        let snapshot_ms = start.elapsed().as_secs_f64() * 10.0;
        let memory = native::process_memory();
        println!(
            "{}",
            serde_json::json!({"scanMs":scan,"snapshotMs":snapshot_ms,"workingSetBytes":memory.0,"peakWorkingSetBytes":memory.1,"historyTotal":snapshot.history_total,"eventCount":snapshot.event_count})
        );
        return;
    }
    if args.iter().any(|a| a == "--package-info") {
        let value = serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"appId":"dev.codex.speedpet","runtime":"tauri","frontendEmbedded":cfg!(feature="custom-protocol"),"buildKind":update::build_kind(),"updateEnabled":update::enabled(),"repository":update::REPOSITORY});
        println!("{value}");
        return;
    }
    if args.iter().any(|a| a == "--replay") {
        // Offline parity harness. Reads synthetic fixture operations from stdin;
        // never initializes a webview, tray, update timer or user settings.
        use std::io::{self, Read};
        let mut input = String::new();
        io::stdin().read_to_string(&mut input).unwrap();
        let value: serde_json::Value = serde_json::from_str(&input).unwrap();
        let home = std::path::PathBuf::from(value["home"].as_str().unwrap());
        let mut collector = usage::Collector::new(home, value["resetAt"].as_i64().unwrap_or(0));
        let mut snapshots = vec![];
        for op in value["ops"].as_array().unwrap() {
            let clock = op["now"].as_i64().unwrap();
            if let Some(writes) = op["writes"].as_array() {
                for write in writes {
                    let path = std::path::PathBuf::from(write["path"].as_str().unwrap());
                    if write["delete"] == true {
                        std::fs::remove_file(path).unwrap();
                        continue;
                    }
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    if write["append"] == true {
                        use std::io::Write;
                        let mut f = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&path)
                            .unwrap();
                        f.write_all(write["text"].as_str().unwrap().as_bytes())
                            .unwrap();
                    } else {
                        std::fs::write(&path, write["text"].as_str().unwrap()).unwrap();
                    }
                    if let Some(mtime) = write["mtimeMs"].as_u64() {
                        let modified = std::time::UNIX_EPOCH
                            .checked_add(std::time::Duration::from_millis(mtime))
                            .expect("fixture modification time");
                        std::fs::OpenOptions::new().write(true).open(&path).unwrap()
                            .set_times(std::fs::FileTimes::new().set_modified(modified)).unwrap();
                    }
                }
            }
            let result = if let Some(reset) = op["reset"].as_i64() {
                collector.reset(clock, reset)
            } else {
                collector.poll(clock, true)
            };
            snapshots.push(result);
        }
        println!("{}", serde_json::to_string(&snapshots).unwrap());
        return;
    }
    match runtime::launch() {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            let message = format!("无法启动 SpeedPet 运行进程：{error}。请确认应用目录可写，并关闭仍在运行的旧版后重试。");
            update::log(&message);
            #[cfg(windows)]
            unsafe {
                use windows::{core::{w, PCWSTR}, Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK}};
                let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
                MessageBoxW(None, PCWSTR(text.as_ptr()), w!("Codex Drive 启动失败"), MB_OK | MB_ICONERROR);
            }
            std::process::exit(1);
        }
    }
    if !native::ensure_webview() {
        return;
    }
    desktop::run();
}
