#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::api::process::{Command, CommandEvent};
use tauri::{Manager, RunEvent};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let (mut rx, mut child) = Command::new_sidecar("music-server")
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

            app.manage(child);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let child = app_handle.state::<tauri::api::process::CommandChild>();
                child.kill().expect("Failed to kill Node.js server");
            }
        });
}