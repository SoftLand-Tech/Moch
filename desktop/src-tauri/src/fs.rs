//! Workspace file listing for the Files workbench tab (shallow, dirs first).

use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub modified: u64,
}

#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<FsEntry>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("{path} is not a directory"));
    }
    let mut entries: Vec<FsEntry> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            Some(FsEntry {
                path: e.path().to_string_lossy().to_string(),
                name,
                dir: meta.is_dir(),
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            })
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}
