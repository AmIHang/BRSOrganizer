//! Windows integration of an app that runs as administrator (release builds): autostart through
//! the Task Scheduler and links opened in the user's normal, unelevated browser.

use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Debug builds get their own task, like their own data dir, so `tauri dev` never touches the
/// installed app's autostart.
const TASK: &str = if cfg!(debug_assertions) { "BRSOrganizer-dev" } else { "BRSOrganizer" };

fn schtasks(args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("schtasks.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Task definition: at logon of this user, elevated without a UAC prompt (the Run key cannot start
/// an app that requires administrator), on battery too and without the default 3-day time limit.
fn task_xml(user: &str, exe: &str, args: &str) -> String {
    let (user, exe, args) = (xml_escape(user), xml_escape(exe), xml_escape(args));
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>BRSOrganizer beim Anmelden starten</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command><Arguments>{args}</Arguments></Exec></Actions>
</Task>
"#
    )
}

pub fn autostart_enabled() -> bool {
    schtasks(&["/Query", "/TN", TASK]).map(|o| o.status.success()).unwrap_or(false)
}

/// Creating an elevated task needs administrator rights (the release app has them).
pub fn set_autostart(on: bool, hidden_arg: &str) -> Result<(), String> {
    let out = if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let user = format!(
            "{}\\{}",
            std::env::var("USERDOMAIN").unwrap_or_default(),
            std::env::var("USERNAME").map_err(|e| e.to_string())?
        );
        let xml = task_xml(&user, &exe.to_string_lossy(), hidden_arg);
        // schtasks reads the definition as UTF-16 with BOM (the encoding the XML declares).
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
        let file = std::env::temp_dir().join(format!("{TASK}-autostart.xml"));
        std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
        let out = schtasks(&["/Create", "/TN", TASK, "/XML", &file.to_string_lossy(), "/F"]);
        let _ = std::fs::remove_file(&file);
        out
    } else {
        schtasks(&["/Delete", "/TN", TASK, "/F"])
    }
    .map_err(|e| e.to_string())?;
    if out.status.success() || (!on && !autostart_enabled()) {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if msg.is_empty() { format!("schtasks: exit code {:?}", out.status.code()) } else { msg })
    }
}

/// Opens an http(s) link through Explorer, so the browser runs as the user, not as administrator
/// (Explorer hands it to the running, unelevated shell).
pub fn open_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(format!("not a web link: {url}"));
    }
    Command::new("explorer.exe")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_xml_escapes_and_runs_hidden() {
        let xml = task_xml("DOM\\gra", r"C:\Apps\A&B\BRSOrganizer.exe", "--hidden");
        assert!(xml.contains(r"<Command>C:\Apps\A&amp;B\BRSOrganizer.exe</Command>"));
        assert!(xml.contains("<Arguments>--hidden</Arguments>"));
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
    }

    #[test]
    fn open_url_rejects_non_web_links() {
        assert!(open_url("file:///C:/Windows/system32/cmd.exe").is_err());
        assert!(open_url("C:\\evil.exe").is_err());
    }
}
