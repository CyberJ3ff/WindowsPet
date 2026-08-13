// Windows 轻量待办提醒桌宠 - 库入口（Tauri 2 约定：lib.rs 包含应用逻辑）

mod db;
mod idle;
mod state;
mod tray;
mod autostart;
mod commands;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{App, Manager, WebviewWindow};
use state::AppState;

/// 全局退出标志：由 quit_app 设置，on_window_event 检查
static IS_QUITTING: AtomicBool = AtomicBool::new(false);

/// 应用启动入口（由 main.rs 调用）
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    log::info!("Windows Pet 桌宠启动中...");

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            setup_app(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::todo_create,
            commands::todo_list,
            commands::todo_update,
            commands::todo_delete,
            commands::todo_mark_done,
            commands::todo_count_unfinished,

            commands::settings_get,
            commands::settings_save,

            commands::window_get_position,
            commands::window_set_position,
            commands::window_start_drag,
            commands::window_clamp_position,
            commands::window_set_always_on_top,
            commands::window_toggle_click_through,

            commands::state_switch,
            commands::snooze_reminder,
            commands::open_todo_window,
            commands::open_settings_window,
            commands::quit_app,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 如果正在退出，跳过拦截，让窗口正常关闭
                if IS_QUITTING.load(Ordering::SeqCst) {
                    return;
                }
                // 桌宠主窗口关闭时隐藏到托盘
                if window.label() == "pet" {
                    let _ = window.hide();
                    api.prevent_close();
                }
                // 面板窗口关闭时隐藏（而非销毁，避免空白/卡死）
                else if window.label() == "todo" || window.label() == "settings" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 应用初始化：数据库、设置、托盘、空闲检测线程
fn setup_app(app: &mut App) -> anyhow::Result<()> {
    let handle = app.handle().clone();

    // 1. 数据库
    let db_conn = db::init_db()?;
    log::info!("数据库初始化完成");

    // 2. 设置
    let settings = state::Settings::load_or_default();
    log::info!(
        "设置加载完成: idle_timeout={}min scale={}x",
        settings.idle_timeout_minutes, settings.scale
    );

    // 3. 全局状态
    let app_state = AppState {
        db: Mutex::new(db_conn),
        settings: Mutex::new(settings.clone()),
        last_remind_time: Mutex::new(None),
        snooze_until: Mutex::new(None),
        pet_state: Mutex::new(state::PetState::Idle),
    };
    app.manage(app_state);

    // 4. 桌宠窗口：初始 always_on_top + ToolWindow 样式 + 按缩放比调整大小
    if let Some(pet_win) = app.get_webview_window("pet") {
        let _ = pet_win.set_always_on_top(settings.always_on_top);
        let _ = pet_win.set_ignore_cursor_events(false);
        // 根据缩放比调整窗口大小
        resize_pet_window(&pet_win, settings.scale as f64);
        #[cfg(windows)]
        let _ = apply_toolwindow_style(&pet_win);
    }

    // 5. 预创建面板窗口（隐藏状态，按需显示）
    create_panel_window(app, "todo", "/todo.html", "待办管理", 640.0, 560.0)?;
    create_panel_window(app, "settings", "/settings.html", "设置", 480.0, 520.0)?;

    // 6. 托盘
    tray::create_tray(app.handle())?;
    log::info!("系统托盘创建完成");

    // 7. 空闲检测线程（每秒轮询1次）
    let app_handle = handle.clone();
    std::thread::spawn(move || idle::run_idle_monitor(app_handle));

    // 8. 每日提醒线程
    let app_handle2 = handle.clone();
    std::thread::spawn(move || idle::run_daily_reminder(app_handle2));

    Ok(())
}

/// 根据缩放比调整桌宠窗口大小（基础尺寸 180x340，含气泡空间）
fn resize_pet_window(window: &WebviewWindow, scale: f64) {
    let w = (180.0 * scale).round() as f64;
    let h = (340.0 * scale).round() as f64;
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
}

/// 创建面板窗口（初始隐藏）
fn create_panel_window(app: &mut App, label: &str, url: &str, title: &str, w: f64, h: f64) -> anyhow::Result<()> {
    tauri::WebviewWindowBuilder::new(
        app, label, tauri::WebviewUrl::App(url.into())
    )
        .title(title)
        .inner_size(w, h)
        .min_inner_size(w * 0.8, h * 0.8)
        .decorations(true)
        .transparent(false)
        .resizable(true)
        .center()
        .visible(false)
        .build()?;
    log::info!("面板窗口 {} 已预创建", label);
    Ok(())
}

/// Windows：将桌宠窗口设置为 ToolWindow（不显示在Alt+Tab/任务栏，不抢占焦点）
#[cfg(windows)]
fn apply_toolwindow_style(window: &WebviewWindow) -> anyhow::Result<()> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos,
        GWL_EXSTYLE, WS_EX_TOOLWINDOW,
        SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE,
    };
    use windows::Win32::Foundation::HWND;

    let raw_hwnd = window.hwnd()?.0;
    let hwnd = HWND(raw_hwnd as _);

    unsafe {
        let mut ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        ex_style |= WS_EX_TOOLWINDOW.0 as i32;
        let _ = SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style);
        let _ = SetWindowPos(
            hwnd,
            None,
            0, 0, 0, 0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    Ok(())
}
