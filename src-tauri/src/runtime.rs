use std::{fs, io::Write, path::{Path, PathBuf}};

const LAUNCHER: &str = "Codex Speed Pet.exe";
const RUNTIME: &str = "SpeedPet.exe";

pub fn launcher_path() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    Ok(if exe.file_name().is_some_and(|name| name.eq_ignore_ascii_case(RUNTIME)) {
        exe.with_file_name(LAUNCHER)
    } else {
        exe
    })
}

fn prepare(launcher: &Path) -> std::io::Result<PathBuf> {
    let runtime = launcher.with_file_name(RUNTIME);
    match fs::symlink_metadata(&runtime) {
        Ok(meta) => {
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let linked = meta.file_type().is_symlink();
            if linked || !meta.is_file() {
                return Err(std::io::Error::other("运行文件不能是链接或目录"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let bytes = fs::read(launcher)?;
    if runtime.exists() && fs::read(&runtime)? == bytes {
        return Ok(runtime);
    }
    // Keep the old entry point and payload names for already-installed updaters.
    let mut staged = tempfile::NamedTempFile::new_in(launcher.parent().unwrap())?;
    staged.write_all(&bytes)?;
    staged.as_file().sync_all()?;
    staged.persist(&runtime).map_err(|error| error.error)?;
    Ok(runtime)
}

pub fn launch() -> std::io::Result<bool> {
    let exe = std::env::current_exe()?;
    if !exe.file_name().is_some_and(|name| name.eq_ignore_ascii_case(LAUNCHER)) {
        return Ok(false);
    }
    let runtime = prepare(&exe)?;
    let mut command = std::process::Command::new(runtime);
    command.args(std::env::args_os().skip(1));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command.spawn()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_and_refreshes_runtime_without_changing_launcher_or_user_files() {
        let root = tempfile::tempdir().unwrap();
        let launcher = root.path().join(LAUNCHER);
        fs::write(&launcher, b"version one").unwrap();
        fs::write(root.path().join("notes.txt"), b"keep").unwrap();
        let runtime = prepare(&launcher).unwrap();
        assert_eq!(fs::read(&runtime).unwrap(), b"version one");
        let modified = fs::metadata(&runtime).unwrap().modified().unwrap();
        prepare(&launcher).unwrap();
        assert_eq!(fs::metadata(&runtime).unwrap().modified().unwrap(), modified);
        fs::write(&launcher, b"version two").unwrap();
        prepare(&launcher).unwrap();
        assert_eq!(fs::read(&runtime).unwrap(), b"version two");
        assert_eq!(fs::read(&launcher).unwrap(), b"version two");
        assert_eq!(fs::read(root.path().join("notes.txt")).unwrap(), b"keep");
        assert!(!RUNTIME.to_ascii_lowercase().starts_with("codex"));
    }

    #[test]
    fn refuses_runtime_directory() {
        let root = tempfile::tempdir().unwrap();
        let launcher = root.path().join(LAUNCHER);
        fs::write(&launcher, b"app").unwrap();
        fs::create_dir(root.path().join(RUNTIME)).unwrap();
        assert!(prepare(&launcher).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn occupied_runtime_keeps_previous_bytes_on_refresh_failure() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        let launcher = root.path().join(LAUNCHER);
        fs::write(&launcher, b"old").unwrap();
        let runtime = prepare(&launcher).unwrap();
        let locked = fs::OpenOptions::new().read(true).share_mode(1).open(&runtime).unwrap();
        fs::write(&launcher, b"new").unwrap();
        assert!(prepare(&launcher).is_err());
        assert_eq!(fs::read(&runtime).unwrap(), b"old");
        drop(locked);
        prepare(&launcher).unwrap();
        assert_eq!(fs::read(&runtime).unwrap(), b"new");
    }
}
