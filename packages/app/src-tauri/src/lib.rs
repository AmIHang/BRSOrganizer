mod daemon;
mod system;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Passed by the autostart entry: start in the tray without showing the window.
const HIDDEN_ARG: &str = "--hidden";

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

/// Connection data for the UI (starts the daemon if necessary).
#[tauri::command]
async fn connection(app: AppHandle) -> Result<daemon::Connection, String> {
    tauri::async_runtime::spawn_blocking(move || daemon::ensure_running(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// Paths for the MCP client setup snippets shown in the settings.
#[tauri::command]
fn mcp_paths(app: AppHandle) -> Option<daemon::McpPaths> {
    daemon::mcp_paths(&app)
}

/// Autostart is a Task Scheduler entry (see `system`), not the Run key of the autostart plugin.
#[tauri::command]
fn autostart_enabled() -> bool {
    system::autostart_enabled()
}

#[tauri::command]
async fn set_autostart(on: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::set_autostart(on, HIDDEN_ARG))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    system::open_url(&url)
}

#[tauri::command]
fn hotkey_label() -> &'static str {
    "Strg+Alt+N"
}

pub fn run() {
    let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);

    tauri::Builder::default()
        // Must be registered first: a second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &hotkey && event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let open = MenuItem::with_id(app, "open", "Öffnen", true, None::<&str>)?;
            let sync = MenuItem::with_id(app, "sync", "Jetzt synchronisieren", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &sync, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("BRSOrganizer")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "sync" => {
                        let _ = app.emit("tray-sync", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;

            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Err(e) = app.global_shortcut().register(hotkey) {
                    eprintln!("global hotkey not available: {e}");
                }
            }

            // Before running as administrator, autostart was the Run key, which cannot start an
            // elevated app: move it to the Task Scheduler. (The plugin only stays for this.)
            if !cfg!(debug_assertions) && app.autolaunch().is_enabled().unwrap_or(false) {
                match system::set_autostart(true, HIDDEN_ARG) {
                    Ok(()) => {
                        let _ = app.autolaunch().disable();
                    }
                    Err(e) => eprintln!("autostart: {e}"),
                }
            }

            if !std::env::args().any(|a| a == HIDDEN_ARG) {
                show_main(app.handle());
            }

            // Start the daemon right away so syncing runs even while the window is hidden.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = daemon::ensure_running(&handle) {
                    eprintln!("daemon: {e}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            connection,
            mcp_paths,
            hotkey_label,
            autostart_enabled,
            set_autostart,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running BRSOrganizer");
}
