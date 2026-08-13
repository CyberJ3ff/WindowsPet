// 空闲检测模块：GetLastInputInfo + 锁屏检测 + 全屏检测

use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use chrono::Timelike;
use crate::state::{AppState, PetState};

/// 空闲监控主循环：每秒轮询1次
pub fn run_idle_monitor(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if let Err(e) = tick_once(&app) {
            log::warn!("空闲监控 tick 错误: {:?}", e);
        }
    }
}

/// 每日定时提醒：到点检查是否需要弹"创建今日待办"
pub fn run_daily_reminder(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_secs(60));
        if let Err(e) = check_daily_reminder(&app) {
            log::warn!("每日提醒检查错误: {:?}", e);
        }
    }
}

/// 单次 tick 检查
fn tick_once(app: &AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();

    let idle_secs = get_idle_seconds().unwrap_or(0);
    let idle_threshold_secs = (settings.idle_timeout_minutes as u64) * 60;

    let locked = is_session_locked();
    if locked { return Ok(()); }

    let has_fullscreen = is_foreground_fullscreen();
    if has_fullscreen { return Ok(()); }

    let unfinished_count = {
        let db = state.db.lock().unwrap();
        crate::db::count_unfinished(&db).unwrap_or(0)
    };

    // ---- 15 分钟无操作且无未完成 → Sleep ----
    if idle_secs >= 15 * 60 && unfinished_count == 0 {
        let mut current = state.pet_state.lock().unwrap();
        if *current != PetState::Sleep {
            *current = PetState::Sleep;
            let _ = app.emit("pet:state", PetState::Sleep);
        }
        return Ok(());
    }

    // ---- 空闲提醒四条件 ----
    if unfinished_count > 0
        && idle_secs >= idle_threshold_secs
        && !locked
        && !has_fullscreen
    {
        let now = Instant::now();
        let cooldown_ok = {
            let last = state.last_remind_time.lock().unwrap();
            match *last {
                None => true,
                Some(t) => now.duration_since(t).as_secs() >= settings.remind_cooldown_seconds as u64,
            }
        };
        let snooze_ok = {
            let sn = state.snooze_until.lock().unwrap();
            match *sn {
                None => true,
                Some(until) => now >= until,
            }
        };
        if cooldown_ok && snooze_ok {
            *state.last_remind_time.lock().unwrap() = Some(now);
            *state.pet_state.lock().unwrap() = PetState::Remind;
            let _ = app.emit("pet:state", PetState::Remind);

            // 播放提醒音效（使用 Windows API 蜂鸣）
            let settings = state.settings.lock().unwrap().clone();
            if settings.sound_enabled {
                play_reminder_sound();
            }

            let _ = app.emit(
                "pet:remind-bubble",
                serde_json::json!({
                    "count": unfinished_count,
                    "type": "unfinished"
                }),
            );
        }
    } else {
        // 用户有输入 → 切回 Idle
        if idle_secs < 3 {
            let mut st = state.pet_state.lock().unwrap();
            if matches!(*st, PetState::Remind) {
                *st = PetState::Idle;
                let _ = app.emit("pet:state", PetState::Idle);
            }
        }
    }
    Ok(())
}

/// 每日提醒：检查到点就弹气泡
fn check_daily_reminder(app: &AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().unwrap().clone();
    if settings.already_daily_reminded_today() { return Ok(()); }

    let parts: Vec<&str> = settings.daily_remind_time.split(':').collect();
    if parts.len() != 2 { return Ok(()); }
    let target_h: u32 = parts[0].parse().unwrap_or(9);
    let target_m: u32 = parts[1].parse().unwrap_or(0);

    let now = chrono::Local::now();
    let cur_h = now.hour();
    let cur_m = now.minute();

    if cur_h == target_h && cur_m >= target_m && cur_m <= target_m + 1 {
        settings.mark_daily_reminded();
        settings.save();
        *state.settings.lock().unwrap() = settings;
        let _ = app.emit(
            "pet:remind-bubble",
            serde_json::json!({
                "type": "daily",
                "text": "要创建今天的待办吗？"
            }),
        );
    }
    Ok(())
}

// ========================= Windows API =========================

/// GetLastInputInfo：返回系统全局空闲秒数
#[cfg(windows)]
pub fn get_idle_seconds() -> Option<u64> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::System::SystemInformation::GetTickCount;

    unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut lii).as_bool() {
            let tick = GetTickCount();
            let delta = tick.wrapping_sub(lii.dwTime);
            Some(delta as u64 / 1000)
        } else {
            None
        }
    }
}
#[cfg(not(windows))]
pub fn get_idle_seconds() -> Option<u64> { None }

/// 检测当前会话是否锁屏（通过检测 LogonUI.exe 进程）
#[cfg(windows)]
pub fn is_session_locked() -> bool {
    is_process_running("LogonUI.exe")
}
#[cfg(not(windows))]
pub fn is_session_locked() -> bool { false }

/// 检测某进程是否在运行（使用 ToolHelp API）
#[cfg(windows)]
fn is_process_running(name: &str) -> bool {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::Foundation::CloseHandle;

    unsafe {
        // windows 0.54: CreateToolhelp32Snapshot 返回 Result<HANDLE>
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return false };
        let mut pe = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // windows 0.54: Process32FirstW 返回 Result<()>
        if Process32FirstW(snap, &mut pe).is_err() {
            let _ = CloseHandle(snap);
            return false;
        }
        loop {
            let exe = String::from_utf16_lossy(&pe.szExeFile)
                .trim_end_matches('\u{0}').to_string();
            if exe.eq_ignore_ascii_case(name) {
                let _ = CloseHandle(snap);
                return true;
            }
            if Process32NextW(snap, &mut pe).is_err() { break; }
        }
        let _ = CloseHandle(snap);
        false
    }
}

/// 检测前台窗口是否全屏（覆盖整个显示器）
#[cfg(windows)]
pub fn is_foreground_fullscreen() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, GetWindowLongW, IsWindowVisible,
        GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    // 声明 user32.dll 中的 MonitorFromWindow
    extern "system" {
        fn MonitorFromWindow(hwnd: HWND, dwFlags: u32) -> isize;
    }

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0 == 0 || !IsWindowVisible(hwnd).as_bool() { return false; }

        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if ex_style & WS_EX_TOOLWINDOW.0 as i32 != 0 { return false; }

        let mut rect: RECT = std::mem::zeroed();
        // windows 0.54: GetWindowRect 返回 Result
        if GetWindowRect(hwnd, &mut rect).is_err() { return false; }

        let w = (rect.right - rect.left) as u32;
        let h = (rect.bottom - rect.top) as u32;
        if w < 800 || h < 600 { return false; }

        let hmon_raw = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST.0 as u32);
        if hmon_raw == 0 { return false; }
        let hmon = HMONITOR(hmon_raw);

        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        // windows 0.54: GetMonitorInfoW 返回 BOOL
        if !GetMonitorInfoW(hmon, &mut mi).as_bool() { return false; }

        let screen_w = (mi.rcMonitor.right - mi.rcMonitor.left) as u32;
        let screen_h = (mi.rcMonitor.bottom - mi.rcMonitor.top) as u32;
        (w as f64 / screen_w as f64) >= 0.95 && (h as f64 / screen_h as f64) >= 0.95
    }
}
#[cfg(not(windows))]
pub fn is_foreground_fullscreen() -> bool { false }

/// 播放提醒音效（使用 Windows API 蜂鸣）
#[cfg(windows)]
fn play_reminder_sound() {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBeep(uType: u32) -> i32;
    }
    const MB_ICONASTERISK: u32 = 0x00000040;
    unsafe {
        let _ = MessageBeep(MB_ICONASTERISK);
    }
}
#[cfg(not(windows))]
fn play_reminder_sound() {}
