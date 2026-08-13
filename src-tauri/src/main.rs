// Windows 轻量待办提醒桌宠 - 二进制入口（精简，仅调用库的 run）

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    windows_pet_lib::run();
}
