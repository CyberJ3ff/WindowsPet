// 开机自启模块：封装 winreg 读写注册表 HKEY_CURRENT_USER\...\Run

use anyhow::Result;

const REG_APP_NAME: &str = "WindowsPet";
const REG_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// 检查当前是否已启用开机自启
#[cfg(windows)]
pub fn is_autostart_enabled() -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey(REG_PATH) {
        key.get_value::<String, _>(REG_APP_NAME).is_ok()
    } else {
        false
    }
}
#[cfg(not(windows))]
pub fn is_autostart_enabled() -> bool { false }

/// 启用 / 禁用开机自启
#[cfg(windows)]
pub fn set_autostart(enabled: bool) -> Result<()> {
    use winreg::{enums::{HKEY_CURRENT_USER, KEY_WRITE}, RegKey};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey_with_flags(REG_PATH, KEY_WRITE)?;
    if enabled {
        let exe_path = std::env::current_exe()?
            .to_string_lossy()
            .to_string();
        key.set_value(REG_APP_NAME, &exe_path)?;
    } else {
        let _ = key.delete_value(REG_APP_NAME);
    }
    Ok(())
}
#[cfg(not(windows))]
pub fn set_autostart(_: bool) -> Result<()> { Ok(()) }
