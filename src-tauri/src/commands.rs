// Tauri Commands：前端 invoke 可调用的 Rust 函数

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{command, AppHandle, Emitter, Manager, WebviewWindow};
use crate::state::{AppState, PetState, Settings, Todo};
use crate::IS_QUITTING;

// ============ 待办 CRUD ============

#[command]
pub fn todo_create(
    app: AppHandle,
    title: String,
    content: Option<String>,
    deadline: Option<String>,
    priority: Option<i32>,
) -> Result<i64, String> {
    if title.trim().is_empty() { return Err("标题不能为空".into()); }
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    crate::db::create_todo(
        &db, &title, content.as_deref(), deadline.as_deref(), priority
    ).map_err(|e| e.to_string())
}

#[command]
pub fn todo_list(app: AppHandle, status: Option<String>) -> Result<Vec<Todo>, String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let st = status.as_deref().unwrap_or("all");
    crate::db::list_todos(&db, st).map_err(|e| e.to_string())
}

#[command]
pub fn todo_update(
    app: AppHandle,
    id: i64,
    title: String,
    content: Option<String>,
    deadline: Option<String>,
    priority: Option<i32>,
) -> Result<(), String> {
    if title.trim().is_empty() { return Err("标题不能为空".into()); }
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    crate::db::update_todo(
        &db, id, &title, content.as_deref(), deadline.as_deref(), priority
    ).map_err(|e| e.to_string())
}

#[command]
pub fn todo_delete(app: AppHandle, id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    crate::db::delete_todo(&db, id).map_err(|e| e.to_string())
}

#[command]
pub fn todo_mark_done(app: AppHandle, id: i64, done: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    crate::db::mark_done(&db, id, done).map_err(|e| e.to_string())
}

#[command]
pub fn todo_count_unfinished(app: AppHandle) -> Result<i64, String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    crate::db::count_unfinished(&db).map_err(|e| e.to_string())
}

// ============ 设置 ============

#[command]
pub fn settings_get(app: AppHandle) -> Settings {
    let state = app.state::<AppState>();
    let s = state.settings.lock().unwrap().clone();
    s
}

#[command]
pub fn settings_save(app: AppHandle, mut new: Settings) -> Result<(), String> {
    new.idle_timeout_minutes = new.idle_timeout_minutes.clamp(1, 720);
    new.remind_cooldown_seconds = new.remind_cooldown_seconds.clamp(5, 3600);
    new.scale = new.scale.clamp(0.5, 2.0);

    if let Err(e) = crate::autostart::set_autostart(new.autostart) {
        log::warn!("开机自启写入失败: {:?}", e);
    }
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.set_always_on_top(new.always_on_top);
        // 根据缩放比调整窗口大小
        let w = (180.0 * new.scale as f64).round() as f64;
        let h = (340.0 * new.scale as f64).round() as f64;
        let _ = pet.set_size(tauri::LogicalSize::new(w, h));
    }
    new.save();
    {
        let state = app.state::<AppState>();
        *state.settings.lock().unwrap() = new.clone();
    }
    let _ = app.emit("settings:updated", &new);
    Ok(())
}

// ============ 窗口控制 ============

#[command]
pub fn window_get_position(window: WebviewWindow) -> Result<tauri::LogicalPosition<i32>, String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    Ok(tauri::LogicalPosition::new(
        (pos.x as f64 / scale).round() as i32,
        (pos.y as f64 / scale).round() as i32,
    ))
}

#[command]
pub fn window_set_position(window: WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())
}

#[command]
pub fn window_start_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[command]
pub fn window_clamp_position(window: WebviewWindow) -> Result<(), String> {
    let monitor = match window.current_monitor().map_err(|e| e.to_string())? {
        Some(m) => m,
        None => return Ok(()),
    };
    let scale = monitor.scale_factor();
    // work_area() 返回 PhysicalRect，手动转 logical
    let work = monitor.work_area();
    let work_x = work.position.x as f64 / scale;
    let work_y = work.position.y as f64 / scale;
    let work_w = work.size.width as f64 / scale;
    let work_h = work.size.height as f64 / scale;

    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let win_w = size.width as f64 / scale;
    let win_h = size.height as f64 / scale;

    let mut x = pos.x as f64 / scale;
    let mut y = pos.y as f64 / scale;
    x = x.clamp(work_x, work_x + work_w - win_w);
    y = y.clamp(work_y, work_y + work_h - win_h);

    let _ = window.set_position(tauri::LogicalPosition::new(x.round() as i32, y.round() as i32));
    Ok(())
}

#[command]
pub fn window_set_always_on_top(window: WebviewWindow, on_top: bool) -> Result<(), String> {
    window.set_always_on_top(on_top).map_err(|e| e.to_string())
}

#[command]
pub fn window_toggle_click_through(window: WebviewWindow, enable: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(enable).map_err(|e| e.to_string())
}

// ============ 状态机 ============

#[command]
pub fn state_switch(app: AppHandle, state_name: String) -> Result<(), String> {
    let target = match state_name.as_str() {
        "idle"        => PetState::Idle,
        "remind"      => PetState::Remind,
        "talk"        => PetState::Talk,
        "sleep"       => PetState::Sleep,
        "interactive" => PetState::Interactive,
        _ => return Err(format!("未知状态: {}", state_name)),
    };
    let app_state = app.state::<AppState>();
    *app_state.pet_state.lock().unwrap() = target;
    let _ = app.emit("pet:state", target);
    Ok(())
}

#[command]
pub fn snooze_reminder(app: AppHandle, minutes: Option<u64>) -> Result<(), String> {
    let mins = minutes.unwrap_or(10);
    let until = Instant::now() + Duration::from_secs(mins * 60);
    let app_state = app.state::<AppState>();
    *app_state.snooze_until.lock().unwrap() = Some(until);
    *app_state.pet_state.lock().unwrap() = PetState::Idle;
    let _ = app.emit("pet:state", PetState::Idle);
    Ok(())
}

// ============ 打开面板 ============

#[command]
pub fn open_todo_window(app: AppHandle) -> Result<(), String> {
    show_panel(&app, "todo");
    Ok(())
}

#[command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    show_panel(&app, "settings");
    Ok(())
}

fn show_panel(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let is_visible = win.is_visible().unwrap_or(false);
        if is_visible {
            let _ = win.set_focus();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            // 通知面板刷新数据
            let _ = app.emit_to(label, "panel:show", ());
        }
    }
}

// ============ 草稿纸 ============

#[command]
pub fn open_sticky_window(app: AppHandle) -> Result<(), String> {
    show_panel(&app, "sticky");
    Ok(())
}

#[command]
pub fn sticky_load() -> Result<String, String> {
    let path = sticky_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(html) = val.get("content").and_then(|v| v.as_str()) {
                return Ok(html.to_string());
            }
        }
    }
    Ok(String::new())
}

#[command]
pub fn sticky_save(content: String) -> Result<(), String> {
    let path = sticky_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::json!({ "content": content });
    let json_str = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    std::fs::write(&path, json_str).map_err(|e| e.to_string())?;
    Ok(())
}

fn sticky_path() -> std::path::PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("WindowsPet");
    dir.join("sticky.json")
}

#[command]
pub fn sticky_hide(app: AppHandle) -> Result<(), String> {
    // 安全兜底：通过 Rust 端隐藏 sticky 窗口（避免前端 window.close() 造成白屏）
    if let Some(win) = app.get_webview_window("sticky") {
        let _ = win.hide();
    }
    Ok(())
}

// ============ 退出 ============

#[command]
pub fn quit_app(app: AppHandle) {
    // 设置全局退出标志，让 on_window_event 跳过拦截
    IS_QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}
