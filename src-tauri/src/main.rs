#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// Music Manager desktop shell (Tauri v2).
//
// - Starts the API server (the `music-server` single executable, see
//   scripts/build-sea.mjs) as a sidecar and kills it when the app exits.
// - Tray menu: show / hide / quit. Closing the window hides it; playback
//   continues in the background.
// - musicmanager:// deep links (OAuth results) are delivered to the web
//   content through the deep-link plugin. On Windows and Linux a deep link
//   launches a second process, which single-instance forwards to this one.

use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct NodeProcess(Mutex<Option<CommandChild>>);

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide Window", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Music Manager", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(Image::from_bytes(include_bytes!("../icons/icon.png"))?)
        .icon_as_template(true)
        .tooltip("Music Manager")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "hide" => hide_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // v1 showed the window on double click; keep that, and also a plain
            // left click on platforms that report one.
            match event {
                TrayIconEvent::DoubleClick { .. } => show_main_window(tray.app_handle()),
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } if !cfg!(target_os = "macos") => show_main_window(tray.app_handle()),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

fn start_server(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let (mut rx, child) = app.shell().sidecar("music-server")?.spawn()?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[Node Server] {}", String::from_utf8_lossy(&line).trim_end())
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[Node Server] {}", String::from_utf8_lossy(&line).trim_end())
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[Node Server] exited: {:?}", status.code)
                }
                _ => {}
            }
        }
    });

    app.manage(NodeProcess(Mutex::new(Some(child))));
    Ok(())
}

fn main() {
    let mut builder = tauri::Builder::default();

    // Must be registered first so a second launch (e.g. a deep link on Windows
    // or Linux) is handed to the running app instead of starting another one.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // macOS registers the scheme from the bundle's Info.plist; Windows
            // and Linux need it registered at runtime (also makes `tauri dev` work).
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    eprintln!("Could not register musicmanager:// links: {err}");
                }
            }

            build_tray(app)?;
            start_server(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Exit => {
                if let Some(process) = app.try_state::<NodeProcess>() {
                    if let Some(child) = process.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
            // macOS: clicking the Dock icon while the window is hidden.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main_window(app),
            _ => {}
        });
}
