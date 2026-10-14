use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Write, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub always_on_top: bool,
    pub reduced_motion: bool,
    pub launch_at_login: bool,
    pub size: String,
    pub auto_hide_chrome: bool,
    pub position: Option<Position>,
    pub position_is_physical: bool,
    pub history_reset_at: i64,
    #[serde(skip_serializing_if = "Option::is_none", skip_deserializing)]
    pub view_size: Option<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            always_on_top: true,
            reduced_motion: false,
            launch_at_login: false,
            size: "medium".into(),
            auto_hide_chrome: true,
            position: None,
            position_is_physical: false,
            history_reset_at: 0,
            view_size: None,
        }
    }
}
pub fn scale(size: &str) -> f64 {
    match size {
        "small" => 0.55,
        "large" => 1.05,
        _ => 0.82,
    }
}
pub fn test_dir() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == "--ui-test")?;
    let path = std::fs::canonicalize(PathBuf::from(args.get(at + 1)?)).ok()?;
    let temp = std::fs::canonicalize(std::env::temp_dir()).ok()?;
    (path.is_absolute()
        && path.starts_with(temp)
        && path
            .file_name()?
            .to_string_lossy()
            .starts_with("codex-speed-pet-ui-"))
    .then_some(path)
}
pub fn data_dir() -> PathBuf {
    if let Some(root) = test_dir() {
        return root;
    }
    let root = PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default());
    // Electron app.getName uses productName, with the npm name as a fallback.
    let product = root.join("Codex Speed Pet");
    let legacy = root.join("codex-speed-pet");
    if !product.join("settings.json").exists() && legacy.join("settings.json").exists() {
        legacy
    } else {
        product
    }
}
pub fn load() -> Settings {
    let mut settings = std::fs::read(data_dir().join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_slice::<Settings>(&s).ok())
        .unwrap_or_default();
    if !["small", "medium", "large"].contains(&settings.size.as_str()) {
        settings.size = "medium".into();
    }
    settings.history_reset_at = settings.history_reset_at.max(0);
    if settings
        .position
        .as_ref()
        .is_some_and(|p| !p.x.is_finite() || !p.y.is_finite())
    {
        settings.position = None;
    }
    settings
}
pub fn save(settings: &Settings) -> Result<(), String> {
    let root = data_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(&root).map_err(|e| e.to_string())?;
    let mut value = settings.clone();
    value.view_size = None;
    file.write_all(&serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(root.join("settings.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
}
impl Settings {
    pub fn payload(&self, panel: bool) -> Self {
        let mut s = self.clone();
        s.view_size = Some(if panel && self.size == "small" {
            "medium".into()
        } else {
            self.size.clone()
        });
        s
    }
    pub fn patch(&mut self, patch: &Value) {
        for (key, target) in [
            ("alwaysOnTop", &mut self.always_on_top),
            ("reducedMotion", &mut self.reduced_motion),
            ("launchAtLogin", &mut self.launch_at_login),
            ("autoHideChrome", &mut self.auto_hide_chrome),
        ] {
            if let Some(v) = patch[key].as_bool() {
                *target = v;
            }
        }
        if let Some(size) = patch["size"]
            .as_str()
            .filter(|s| ["small", "medium", "large"].contains(s))
        {
            self.size = size.to_string();
        }
    }
}

#[cfg(windows)]
pub fn autostart(enabled: bool) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = root
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if enabled {
        key.set_value("Codex Speed Pet", &format!("\"{}\"", exe.display()))
            .map_err(|e| e.to_string())?;
    } else {
        match key.delete_value("Codex Speed Pet") {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    // Retire only an Electron startup value belonging to this application.
    if let Ok(old) = key.get_value::<String, _>("codex-speed-pet") {
        if old.contains("Codex Speed Pet.exe") {
            key.delete_value("codex-speed-pet")
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[cfg(not(windows))]
pub fn autostart(_: bool) -> Result<(), String> {
    Ok(())
}
