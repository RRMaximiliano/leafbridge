#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
struct GitOutput {
    stdout: String,
    stderr: String,
    #[serde(rename = "exitCode")]
    exit_code: i32,
}

#[tauri::command]
fn run_git(project_path: String, args: Vec<String>) -> Result<GitOutput, String> {
    if args.is_empty() {
        return Err("No Git arguments were provided.".to_string());
    }

    let output = Command::new("git")
        .args(args)
        .current_dir(project_path)
        .output()
        .map_err(|error| format!("Failed to start git: {error}"))?;

    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http and https URLs can be opened.".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg("start");
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(url)
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_path_in_finder(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("No path was provided.".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg("-R");
        cmd
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg("/select,");
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(path)
        .spawn()
        .map_err(|error| format!("Failed to open path: {error}"))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            run_git,
            open_external_url,
            open_path_in_finder
        ])
        .run(tauri::generate_context!())
        .expect("error while running LeafBridge");
}
