//! Finding, starting and connecting to the BRSOrganizer daemon.
//!
//! The daemon runs detached: it keeps serving MCP clients when the app window or even the
//! app itself is closed. The app only starts it when it is not running yet.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const DEFAULT_PORT: u16 = 47821;
const TOKEN_ACCOUNT: &str = "local-access-token";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Debug builds use their own data dir, credentials and port so `tauri dev` never touches
/// the real installation.
struct Profile {
    data_dir_name: &'static str,
    keyring_service: &'static str,
    fixed_port: Option<u16>,
    extra_origins: Option<&'static str>,
}

#[cfg(debug_assertions)]
const PROFILE: Profile = Profile {
    data_dir_name: "BRSOrganizer-dev",
    keyring_service: "BRSOrganizer-dev",
    fixed_port: Some(47822),
    extra_origins: Some("http://127.0.0.1:1420"),
};

#[cfg(not(debug_assertions))]
const PROFILE: Profile = Profile {
    data_dir_name: "BRSOrganizer",
    keyring_service: "BRSOrganizer",
    fixed_port: None,
    extra_origins: None,
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub base_url: String,
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPaths {
    pub node: String,
    pub script: String,
    pub installed: bool,
}

fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BRSORGANIZER_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join("AppData\\Local")
    });
    base.join(PROFILE.data_dir_name)
}

fn keyring_service() -> String {
    std::env::var("BRSORGANIZER_KEYRING_SERVICE").unwrap_or_else(|_| PROFILE.keyring_service.into())
}

fn discovered_port() -> Option<u16> {
    let text = std::fs::read_to_string(data_dir().join("daemon.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("port")?.as_u64().and_then(|p| u16::try_from(p).ok())
}

fn configured_port() -> Option<u16> {
    std::env::var("BRSORGANIZER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .or(PROFILE.fixed_port)
}

fn current_port() -> u16 {
    configured_port()
        .or_else(discovered_port)
        .unwrap_or(DEFAULT_PORT)
}

/// `GET /health` must answer with our app name (a foreign program on the port does not count).
fn is_healthy(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") && response.contains("\"app\":\"BRSOrganizer\"")
}

/// Tauri returns verbatim paths (`\\?\C:\...`). Node cannot resolve a main script given that
/// way (EISDIR on `lstat 'C:'`), and they look odd in the MCP setup snippets, so drive paths
/// are turned back into plain ones.
fn plain_path(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

/// Node runtime shipped as externalBin (next to the app exe) and the bundled scripts.
fn runtime(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let exe_dir = plain_path(std::env::current_exe().ok()?.parent()?.to_path_buf());
    let node = exe_dir.join("brsorganizer-node.exe");
    let runtime_dir = plain_path(app.path().resource_dir().ok()?).join("runtime");
    Some((node, runtime_dir))
}

#[cfg(test)]
mod tests {
    use super::plain_path;
    use std::path::PathBuf;

    #[test]
    fn strips_verbatim_prefix_from_drive_paths_only() {
        assert_eq!(
            plain_path(PathBuf::from(r"\\?\C:\Apps\BRSOrganizer")),
            PathBuf::from(r"C:\Apps\BRSOrganizer")
        );
        assert_eq!(
            plain_path(PathBuf::from(r"C:\Apps\BRSOrganizer")),
            PathBuf::from(r"C:\Apps\BRSOrganizer")
        );
        // UNC verbatim paths stay as they are.
        assert_eq!(
            plain_path(PathBuf::from(r"\\?\UNC\server\share")),
            PathBuf::from(r"\\?\UNC\server\share")
        );
    }
}

pub fn mcp_paths(app: &AppHandle) -> Option<McpPaths> {
    let (node, runtime_dir) = runtime(app)?;
    let script = runtime_dir.join("mcp-stdio.mjs");
    Some(McpPaths {
        installed: node.exists() && script.exists(),
        node: node.to_string_lossy().into_owned(),
        script: script.to_string_lossy().into_owned(),
    })
}

fn spawn_daemon(app: &AppHandle) -> Result<(), String> {
    let (node, runtime_dir) = runtime(app).ok_or("cannot locate the bundled runtime")?;
    let script = runtime_dir.join("daemon.mjs");
    if !node.exists() || !script.exists() {
        return Err(format!(
            "bundled daemon not found ({}); run `pnpm sidecar` first",
            script.display()
        ));
    }

    // Early crashes (before the daemon's own logger is up) end up here instead of nowhere.
    let logs = data_dir().join("logs");
    let _ = std::fs::create_dir_all(&logs);
    let start_log = std::fs::File::create(logs.join("daemon-start.log"))
        .map_err(|e| format!("cannot create daemon start log: {e}"))?;
    let start_log_err = start_log
        .try_clone()
        .map_err(|e| format!("cannot create daemon start log: {e}"))?;

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::from(start_log))
        .stderr(Stdio::from(start_log_err))
        .env("BRSORGANIZER_DATA_DIR", data_dir())
        .env("BRSORGANIZER_KEYRING_SERVICE", keyring_service())
        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    if let Some(port) = configured_port() {
        cmd.arg("--port").arg(port.to_string());
    }
    if let Some(origins) = PROFILE.extra_origins {
        cmd.env("BRSORGANIZER_ALLOWED_ORIGINS", origins);
    }
    // The child is intentionally not kept: the daemon outlives the app.
    cmd.spawn().map_err(|e| format!("failed to start daemon: {e}"))?;
    Ok(())
}

/// Serializes `ensure_running`: setup and the UI call it at the same time on startup, and two
/// concurrent calls would each spawn a daemon.
static ENSURE_LOCK: Mutex<()> = Mutex::new(());

/// Returns a connection to a healthy daemon, starting it if needed (blocking, up to ~15 s).
pub fn ensure_running(app: &AppHandle) -> Result<Connection, String> {
    let _guard = ENSURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut port = current_port();
    if !is_healthy(port) {
        spawn_daemon(app)?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            // The daemon may pick its port from its settings; daemon.json tells us which.
            port = current_port();
            if is_healthy(port) {
                break;
            }
            if Instant::now() > deadline {
                return Err("the daemon did not start within 15 seconds".into());
            }
        }
    }

    let token = keyring::Entry::new(&keyring_service(), TOKEN_ACCOUNT)
        .and_then(|e| e.get_password())
        .map_err(|e| format!("cannot read the access token from the Credential Manager: {e}"))?;

    Ok(Connection {
        base_url: format!("http://127.0.0.1:{port}"),
        token,
    })
}
