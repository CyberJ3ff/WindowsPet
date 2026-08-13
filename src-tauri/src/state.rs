// 全局应用状态与设置结构体定义

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use rusqlite::Connection;
use chrono::Local;

/// 桌宠状态枚举（状态机）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PetState {
    Idle,         // 待机：轻微晃动、眨眼
    Remind,       // 提醒：踱步、抖动（空闲超时触发）
    Talk,         // 气泡：点击弹出未完成待办列表
    Sleep,        // 休眠：15分钟无操作且无未完成待办
    Interactive,  // 交互：点击时短暂打招呼
}

/// 待办优先级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Priority {
    Low,    // 低
    Medium, // 中（默认）
    High,   // 高
}

impl Priority {
    pub fn from_i32(v: i32) -> Self {
        match v {
            0 => Priority::Low,
            2 => Priority::High,
            _ => Priority::Medium,
        }
    }
    pub fn to_i32(self) -> i32 {
        match self {
            Priority::Low => 0,
            Priority::Medium => 1,
            Priority::High => 2,
        }
    }
}

/// 待办事项实体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub done: bool,
    pub created_at: String,
    pub deadline: Option<String>,
    pub priority: Priority,
}

/// 应用设置（可在设置面板配置）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// 空闲提醒超时时间（分钟），默认 5
    pub idle_timeout_minutes: u32,
    /// 提醒冷却间隔（秒），默认 30
    pub remind_cooldown_seconds: u32,
    /// 每日主动提醒创建待办的时间点（HH:MM 24h制），默认 "09:00"
    pub daily_remind_time: String,
    /// 开机自启开关
    pub autostart: bool,
    /// 窗口总是置顶
    pub always_on_top: bool,
    /// 桌宠显示缩放比例（0.5 ~ 2.0），默认 1.0
    pub scale: f32,
    /// 提醒音效开关
    pub sound_enabled: bool,
    /// 上次每日提醒的日期（yyyy-mm-dd），防止同一天重复
    pub last_daily_remind_date: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            idle_timeout_minutes: 5,
            remind_cooldown_seconds: 30,
            daily_remind_time: "09:00".to_string(),
            autostart: false,
            always_on_top: true,
            scale: 1.0,
            sound_enabled: false,
            last_daily_remind_date: None,
        }
    }
}

impl Settings {
    /// 从本地文件加载设置，不存在则返回默认值
    pub fn load_or_default() -> Self {
        if let Some(data_dir) = dirs::data_local_dir() {
            let path = data_dir.join("WindowsPet").join("settings.json");
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(s) = serde_json::from_str::<Settings>(&content) {
                    return s;
                }
            }
        }
        Settings::default()
    }

    /// 保存设置到本地 JSON 文件
    pub fn save(&self) {
        if let Some(data_dir) = dirs::data_local_dir() {
            let dir = data_dir.join("WindowsPet");
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("settings.json");
            if let Ok(json) = serde_json::to_string_pretty(self) {
                let _ = std::fs::write(&path, json);
            }
        }
    }

    /// 今日是否已经弹过每日提醒
    pub fn already_daily_reminded_today(&self) -> bool {
        let today = Local::now().format("%Y-%m-%d").to_string();
        matches!(&self.last_daily_remind_date, Some(d) if d == &today)
    }

    /// 标记今日已经提醒过
    pub fn mark_daily_reminded(&mut self) {
        self.last_daily_remind_date = Some(Local::now().format("%Y-%m-%d").to_string());
    }
}

/// Tauri 全局共享状态（通过 app.manage / app.state 访问）
pub struct AppState {
    /// SQLite 数据库连接（互斥锁保证线程安全）
    pub db: Mutex<Connection>,
    /// 应用设置
    pub settings: Mutex<Settings>,
    /// 上次提醒触发时间（用于冷却间隔判断）
    pub last_remind_time: Mutex<Option<std::time::Instant>>,
    /// 延后提醒截止时间（用户点击"延后10分钟"后设置）
    pub snooze_until: Mutex<Option<std::time::Instant>>,
    /// 当前桌宠状态
    pub pet_state: Mutex<PetState>,
}
