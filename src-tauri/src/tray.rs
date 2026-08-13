// 系统托盘模块：托盘图标、右键菜单

use anyhow::Result;
use std::sync::atomic::Ordering;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use crate::IS_QUITTING;

/// 创建系统托盘
pub fn create_tray(app: &AppHandle) -> Result<()> {
    // 菜单项
    let show_pet = MenuItem::with_id(app, "show_pet", "显示桌宠", true, None::<&str>)?;
    let hide_pet = MenuItem::with_id(app, "hide_pet", "隐藏桌宠", true, None::<&str>)?;
    let todo_panel = MenuItem::with_id(app, "todo_panel", "打开待办管理", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&show_pet, &hide_pet, &sep1, &todo_panel, &settings_item, &sep2, &quit],
    )?;

    // 构造托盘图标：生成 26x26 橙色 RGBA 图标
    let icon = generate_fallback_icon();

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Windows 待办桌宠")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_pet" => show_window(app, "pet"),
            "hide_pet" => hide_window(app, "pet"),
            "todo_panel" => open_or_focus(app, "todo", "/todo.html", 640.0, 560.0),
            "settings"   => open_or_focus(app, "settings", "/settings.html", 480.0, 520.0),
            "quit" => {
                IS_QUITTING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            if let TrayIconEvent::Click { button, button_state, .. } = event {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    if let Some(w) = app.get_webview_window("pet") {
                        match w.is_visible() {
                            Ok(true)  => { let _ = w.hide(); }
                            Ok(false) => { let _ = w.show(); }
                            Err(_) => {}
                        }
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn show_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
fn hide_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.hide();
    }
}

fn open_or_focus(app: &AppHandle, label: &str, _url: &str, _w: f64, _h: f64) {
    if let Some(win) = app.get_webview_window(label) {
        let is_visible = win.is_visible().unwrap_or(false);
        if is_visible {
            let _ = win.set_focus();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = app.emit_to(label, "panel:show", ());
        }
    }
}

/// 兜底：生成一个 26x26 橙色 RGBA 图标
fn generate_fallback_icon() -> tauri::image::Image<'static> {
    let mut raw = vec![0u8; 26 * 26 * 4];
    let mut i = 0;
    for _y in 0..26 {
        for _x in 0..26 {
            raw[i] = 255;     // R
            raw[i + 1] = 140; // G
            raw[i + 2] = 0;   // B
            raw[i + 3] = 255; // A
            i += 4;
        }
    }
    tauri::image::Image::new_owned(raw, 26, 26)
}
