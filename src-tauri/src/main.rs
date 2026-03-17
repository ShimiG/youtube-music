#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::api::process::{Command, CommandEvent, CommandChild};
use tauri::{
    CustomMenuItem, Manager, RunEvent, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem, WindowEvent,
};
use std::sync::Mutex;

// 1. Create a secure wrapper for our Node process
struct NodeProcess(Mutex<Option<CommandChild>>);

fn main() {
    let quit = CustomMenuItem::new("quit".to_string(), "Quit Music Manager");
    let hide = CustomMenuItem::new("hide".to_string(), "Hide Window");
    let show = CustomMenuItem::new("show".to_string(), "Show Window");
    
    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_item(hide)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "quit" => {
                    app.exit(0);
                }
                "hide" => {
                    let window = app.get_window("main").unwrap();
                    window.hide().unwrap();
                }
                "show" => {
                    let window = app.get_window("main").unwrap();
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
                _ => {}
            },
            SystemTrayEvent::DoubleClick { .. } => {
                let window = app.get_window("main").unwrap();
                window.show().unwrap();
                window.set_focus().unwrap();
            }
            _ => {}
        })
        .on_window_event(|event| match event.event() {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                event.window().hide().unwrap();
            }
            _ => {}
        })
        .setup(|app| {
            let (mut rx, child) = Command::new_sidecar("music-server")
                .expect("Failed to create sidecar command")
                .spawn()
                .expect("Failed to spawn sidecar");

            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(line) = event {
                        println!("[Node Server] {}", line);
                    }
                }
            });

            // 2. Wrap the child process in our Mutex and give it to Tauri
            app.manage(NodeProcess(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // 3. Securely take ownership of the process out of the Mutex and kill it
                if let Some(process) = app_handle.try_state::<NodeProcess>() {
                    if let Some(child) = process.0.lock().unwrap().take() {
                        child.kill().expect("Failed to kill Node.js server");
                    }
                }
            }
        });
}