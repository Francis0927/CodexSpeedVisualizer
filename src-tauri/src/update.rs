use reqwest::{
    blocking::{Client, Response},
    redirect::Policy,
    Url,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};

pub const REPOSITORY: &str = "Francis0927/CodexSpeedVisualizer";
const LATEST: &str =
    "https://api.github.com/repos/Francis0927/CodexSpeedVisualizer/releases/latest";
const HOSTS: [&str; 4] = [
    "github.com",
    "api.github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub message: Option<String>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            version: None,
            notes: None,
            message: None,
        }
    }
}
#[derive(Clone, Debug)]
struct Asset {
    name: String,
    url: Url,
    size: u64,
    digest: Option<String>,
}
#[derive(Clone, Debug)]
struct Candidate {
    version: String,
    installer: Asset,
    portable: Asset,
    sums: Asset,
}
pub struct Updater {
    pub status: Mutex<Status>,
    candidate: Mutex<Option<Candidate>>,
    operation: Mutex<()>,
    check_generation: AtomicU64,
}
struct CheckCompleted<'a>(&'a AtomicU64);
impl Drop for CheckCompleted<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}
impl Updater {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(Status::default()),
            candidate: Mutex::new(None),
            operation: Mutex::new(()),
            check_generation: AtomicU64::new(0),
        }
    }
    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
    fn set(
        &self,
        app: &AppHandle,
        state: &str,
        version: Option<String>,
        notes: Option<String>,
        message: Option<String>,
    ) -> Status {
        let status = Status {
            state: state.into(),
            version,
            notes,
            message,
        };
        *self.status.lock().unwrap() = status.clone();
        let _ = app.emit("update:status", &status);
        status
    }
    pub fn check(&self, app: &AppHandle) -> Status {
        let generation = self.check_generation.load(Ordering::Relaxed);
        let _operation = self.operation.lock().unwrap();
        if generation != self.check_generation.load(Ordering::Relaxed)
            || self.status().state == "installing"
        {
            return self.status();
        }
        // Concurrent manual/background checks wait for the same completed
        // result, so a manual tray check can still open available updates.
        let _completed = CheckCompleted(&self.check_generation);
        if !enabled() {
            return self.set(
                app,
                "unsupported",
                None,
                None,
                Some("开发环境不支持更新".into()),
            );
        }
        self.set(app, "checking", None, None, None);
        *self.candidate.lock().unwrap() = None;
        let result = (|| -> Result<Option<(Candidate, Option<String>)>, String> {
            let client = client()?;
            let bytes = read(&client, Url::parse(LATEST).unwrap(), 2 * 1024 * 1024)?;
            let release: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let version = release_version(&release)?;
            if compare(&version, env!("CARGO_PKG_VERSION"))? != std::cmp::Ordering::Greater {
                return Ok(None);
            }
            let candidate = assets(&release)?;
            Ok(Some((
                candidate,
                release["body"]
                    .as_str()
                    .map(|s| s.chars().take(4000).collect()),
            )))
        })();
        match result {
            Ok(Some((candidate, notes))) => {
                let version = candidate.version.clone();
                *self.candidate.lock().unwrap() = Some(candidate);
                self.set(app, "available", Some(version), notes, None)
            }
            Ok(None) => self.set(app, "latest", None, None, None),
            Err(e) => {
                log(&format!("check failed: {e}"));
                self.set(
                    app,
                    "error",
                    None,
                    None,
                    Some(format!("无法检查 GitHub 更新：{e}")),
                )
            }
        }
    }
    pub fn install(&self, app: &AppHandle) -> Status {
        let _operation = self.operation.lock().unwrap();
        let current = self.status();
        if !enabled() || current.state != "available" {
            return current;
        }
        let Some(candidate) = self.candidate.lock().unwrap().clone() else {
            return current;
        };
        self.set(
            app,
            "downloading",
            current.version.clone(),
            current.notes.clone(),
            None,
        );
        match install_candidate(&candidate) {
            Ok(()) => {
                let status = self.set(app, "installing", current.version, current.notes, None);
                app.exit(0);
                status
            }
            Err(e) => {
                log(&format!("install failed: {e}"));
                self.set(
                    app,
                    "error",
                    current.version,
                    current.notes,
                    Some(format!("更新失败：{e}")),
                )
            }
        }
    }
}
pub fn enabled() -> bool {
    !cfg!(debug_assertions)
}
pub fn build_kind() -> String {
    if !enabled() {
        return "dev".into();
    }
    let marker = std::env::current_exe()
        .ok()
        .and_then(|p| fs::read(p.parent()?.join("build-kind.json")).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if marker
        .as_ref()
        .is_some_and(|m| m["appId"] == "dev.codex.speedpet" && m["kind"] == "installed")
    {
        "installed"
    } else {
        "portable"
    }
    .into()
}
pub fn log(message: &str) {
    let root = crate::settings::data_dir();
    let _ = fs::create_dir_all(&root);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("update.log"))
    {
        let _ = writeln!(file, "[{}] {message}", chrono::Utc::now().to_rfc3339());
    }
}
fn version(v: &str) -> Result<[u64; 3], String> {
    let parts = v.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
    {
        return Err("更新版本号无效".into());
    }
    Ok([
        parts[0].parse().map_err(|_| "更新版本号无效")?,
        parts[1].parse().map_err(|_| "更新版本号无效")?,
        parts[2].parse().map_err(|_| "更新版本号无效")?,
    ])
}
fn compare(a: &str, b: &str) -> Result<std::cmp::Ordering, String> {
    Ok(version(a)?.cmp(&version(b)?))
}
fn release_version(release: &Value) -> Result<String, String> {
    if release["draft"].as_bool().unwrap_or(false)
        || release["prerelease"].as_bool().unwrap_or(false)
    {
        return Err("GitHub 未提供有效正式版本".into());
    }
    let v = release["tag_name"]
        .as_str()
        .and_then(|s| s.strip_prefix('v'))
        .ok_or("GitHub 未提供有效正式版本")?;
    version(v)?;
    Ok(v.into())
}
fn safe_url(url: Url) -> Result<Url, String> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.host_str().is_some_and(|h| HOSTS.contains(&h))
    {
        Err("更新下载地址不受支持".into())
    } else {
        Ok(url)
    }
}
fn digest(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())
}
fn assets(release: &Value) -> Result<Candidate, String> {
    let version = release_version(release)?;
    let select = |name: String| -> Result<Asset, String> {
        let matches = release["assets"]
            .as_array()
            .ok_or("缺少更新附件")?
            .iter()
            .filter(|a| a["name"] == name)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(format!("GitHub 缺少唯一更新附件：{name}"));
        }
        let a = matches[0];
        let size = a["size"]
            .as_u64()
            .filter(|s| *s > 0 && *s <= 1024 * 1024 * 1024)
            .ok_or("更新文件大小无效")?;
        if a["state"] != "uploaded" {
            return Err("更新附件未上传完成".into());
        }
        let url = safe_url(
            Url::parse(a["browser_download_url"].as_str().ok_or("缺少下载地址")?)
                .map_err(|e| e.to_string())?,
        )?;
        if url.host_str() != Some("github.com")
            || url.path() != format!("/{REPOSITORY}/releases/download/v{version}/{name}")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("更新附件不属于当前仓库和版本".into());
        }
        let hash = match a["digest"].as_str().filter(|s| !s.is_empty()) {
            Some(v) => Some(
                v.strip_prefix("sha256:")
                    .filter(|s| digest(s))
                    .ok_or("附件 SHA-256 无效")?
                    .to_lowercase(),
            ),
            None => None,
        };
        Ok(Asset {
            name,
            url,
            size,
            digest: hash,
        })
    };
    Ok(Candidate {
        installer: select(format!("Codex-Speed-Pet-Setup-{version}.exe"))?,
        portable: select(format!("Codex-Speed-Pet-portable-{version}.zip"))?,
        sums: select("SHA256SUMS.txt".into())?,
        version,
    })
}
fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(600))
        .user_agent("Codex-Speed-Pet-updater")
        .build()
        .map_err(|e| e.to_string())
}
fn response(client: &Client, mut url: Url) -> Result<Response, String> {
    for redirects in 0..=5 {
        url = safe_url(url)?;
        let response = client
            .get(url.clone())
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(|e| e.to_string())?;
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err("更新下载重定向异常".into());
            }
            url = url
                .join(
                    response
                        .headers()
                        .get("location")
                        .ok_or("缺少重定向地址")?
                        .to_str()
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
            continue;
        }
        return match response.status().as_u16() {
            200 => Ok(response),
            403 | 429 => Err("GitHub 请求受限，请稍后重试".into()),
            s => Err(format!("GitHub 请求失败（HTTP {s}）")),
        };
    }
    Err("更新下载重定向异常".into())
}
fn read(client: &Client, url: Url, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = vec![];
    response(client, url)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("更新信息过大".into());
    }
    Ok(bytes)
}
fn checksum(text: &str, asset: &Asset) -> Result<String, String> {
    let mut found = None;
    for line in text
        .trim_start_matches('\u{feff}')
        .lines()
        .filter(|s| !s.is_empty())
    {
        let (hash, name) = line.split_once("  ").ok_or("校验文件格式无效")?;
        if !digest(hash) {
            return Err("校验文件格式无效".into());
        }
        if name == asset.name {
            if found.is_some() {
                return Err("附件校验值不唯一".into());
            }
            found = Some(hash.to_lowercase());
        }
    }
    let hash = found.ok_or("附件缺少 SHA-256 校验值")?;
    if asset.digest.as_ref().is_some_and(|d| d != &hash) {
        return Err("GitHub 附件与校验文件不一致".into());
    }
    Ok(hash)
}
fn download(client: &Client, asset: &Asset, path: &Path, expected: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    copy_verified(
        response(client, asset.url.clone())?,
        &mut file,
        asset.size,
        expected,
    )
}
fn copy_verified(
    mut stream: impl Read,
    file: &mut File,
    size: u64,
    expected: &str,
) -> Result<(), String> {
    let mut hash = Sha256::new();
    let mut count = 0;
    let mut bytes = [0u8; 65536];
    loop {
        let n = stream.read(&mut bytes).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > size {
            return Err("更新文件大小异常".into());
        }
        hash.update(&bytes[..n]);
        file.write_all(&bytes[..n]).map_err(|e| e.to_string())?;
    }
    if count != size || format!("{:x}", hash.finalize()) != expected {
        return Err("更新文件 SHA-256 或大小校验失败".into());
    }
    file.sync_all().map_err(|e| e.to_string())
}
pub fn extract_portable(archive: &Path, destination: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() != 2 {
        return Err("便携更新包结构无效".into());
    }
    let mut names = std::collections::HashSet::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if !["Codex Speed Pet.exe", "build-kind.json"].contains(&name.as_str())
            || !names.insert(name.clone())
            || entry.is_dir()
            || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            || entry.size() > 512 * 1024 * 1024
            || (name == "build-kind.json" && entry.size() > 65536)
        {
            return Err("便携 ZIP 包含无效文件或路径".into());
        }
        let mut out = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination.join(&name))
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    let marker: Value = serde_json::from_slice(
        &fs::read(destination.join("build-kind.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if marker["appId"] != "dev.codex.speedpet" || marker["kind"] != "portable" {
        return Err("便携包类型标记无效".into());
    }
    Ok(())
}
fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}
fn install_candidate(candidate: &Candidate) -> Result<(), String> {
    let client = client()?;
    let sums = read(&client, candidate.sums.url.clone(), 64 * 1024)?;
    if candidate
        .sums
        .digest
        .as_ref()
        .is_some_and(|d| format!("{:x}", Sha256::digest(&sums)) != *d)
    {
        return Err("校验文件 SHA-256 不一致".into());
    }
    let kind = build_kind();
    let asset = if kind == "installed" {
        &candidate.installer
    } else {
        &candidate.portable
    };
    let expected = checksum(
        std::str::from_utf8(&sums).map_err(|e| e.to_string())?,
        asset,
    )?;
    let stage = tempfile::Builder::new()
        .prefix("codex-speed-pet-update-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let target = stage.path().join(&asset.name);
    download(&client, asset, &target, &expected)?;
    log(&format!(
        "verified GitHub update v{}, kind={kind}",
        candidate.version
    ));
    if kind == "installed" {
        Command::new("explorer.exe")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
        let _ = stage.keep();
        return Ok(());
    }
    let files = stage.path().join("files");
    fs::create_dir(&files).map_err(|e| e.to_string())?;
    extract_portable(&target, &files)?;
    let mut probe = Command::new(files.join("Codex Speed Pet.exe"));
    probe.arg("--package-info");
    hidden(&mut probe);
    let result = probe.output().map_err(|e| e.to_string())?;
    let info: Value = serde_json::from_slice(&result.stdout).map_err(|_| "便携 EXE 诊断失败")?;
    if !result.status.success()
        || info["version"] != candidate.version
        || info["runtime"] != "tauri"
        || info["frontendEmbedded"] != true
        || info["buildKind"] != "portable"
        || info["updateEnabled"] != true
    {
        return Err("便携更新程序版本或更新行为无效".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    fs::write(
        stage.path().join("apply-update.ps1"),
        include_bytes!("../portable-update.ps1"),
    )
    .map_err(|e| e.to_string())?;
    let config = serde_json::json!({"source":files,"target":exe.parent().unwrap(),"exe":"Codex Speed Pet.exe","appPid":std::process::id(),"logDir":crate::settings::data_dir()});
    fs::write(
        stage.path().join("update.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(stage.path().join("apply-update.ps1"));
    hidden(&mut command);
    command.spawn().map_err(|e| e.to_string())?;
    let _ = stage.keep();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn downloaded_bytes_require_exact_size_and_sha256() {
        let expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        let mut output = tempfile::tempfile().unwrap();
        assert!(copy_verified(std::io::Cursor::new(b"hello"), &mut output, 5, expected).is_ok());
        for bytes in [
            b"jello".as_slice(),
            b"hell".as_slice(),
            b"hello!".as_slice(),
        ] {
            let mut output = tempfile::tempfile().unwrap();
            assert!(copy_verified(std::io::Cursor::new(bytes), &mut output, 5, expected).is_err());
        }
    }
    #[test]
    fn version_and_download_scope() {
        assert!(compare("1.2.3-beta", "1.2.3").is_err());
        assert_eq!(
            compare("1.10.0", "1.9.9").unwrap(),
            std::cmp::Ordering::Greater
        );
        for url in [
            "http://github.com/a",
            "https://evil.example/a",
            "https://name:password@github.com/a",
        ] {
            assert!(safe_url(Url::parse(url).unwrap()).is_err());
        }
    }
    #[test]
    fn checksum_must_be_unique_and_match_metadata() {
        let a = Asset {
            name: "a.zip".into(),
            url: Url::parse(LATEST).unwrap(),
            size: 1,
            digest: Some("a".repeat(64)),
        };
        assert_eq!(
            checksum(&format!("{}  a.zip\n", "a".repeat(64)), &a).unwrap(),
            "a".repeat(64)
        );
        assert!(checksum(&format!("{}  a.zip\n", "b".repeat(64)), &a).is_err());
        assert!(checksum(&format!("{0}  a.zip\n{0}  a.zip\n", "a".repeat(64)), &a).is_err());
    }
    #[test]
    fn archive_rejects_traversal_before_extracting() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bad.zip");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        writer
            .start_file("../escape", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"bad").unwrap();
        writer
            .start_file("build-kind.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"{}").unwrap();
        writer.finish().unwrap();
        assert!(extract_portable(&path, tmp.path()).is_err());
        assert!(!tmp.path().parent().unwrap().join("escape").exists());
    }
    #[test]
    fn release_assets_reject_prerelease_duplicates_and_wrong_repository() {
        let version = "1.2.3";
        let mut release =
            serde_json::json!({"tag_name":"v1.2.3","draft":false,"prerelease":false,"assets":[]});
        for name in [
            format!("Codex-Speed-Pet-Setup-{version}.exe"),
            format!("Codex-Speed-Pet-portable-{version}.zip"),
            "SHA256SUMS.txt".into(),
        ] {
            release["assets"].as_array_mut().unwrap().push(serde_json::json!({"name":name,"state":"uploaded","size":4,"browser_download_url":format!("https://github.com/{REPOSITORY}/releases/download/v{version}/{name}"),"digest":format!("sha256:{}","a".repeat(64))}));
        }
        assert!(assets(&release).is_ok());
        release["prerelease"] = Value::Bool(true);
        assert!(assets(&release).is_err());
        release["prerelease"] = Value::Bool(false);
        let first = release["assets"][0].clone();
        release["assets"].as_array_mut().unwrap().push(first);
        assert!(assets(&release).is_err());
        release["assets"].as_array_mut().unwrap().pop();
        release["assets"][0]["browser_download_url"] =
            Value::String("https://github.com/other/repo/releases/download/v1.2.3/a.exe".into());
        assert!(assets(&release).is_err());
    }
}
