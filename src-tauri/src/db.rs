// SQLite 数据库模块：待办表结构 + CRUD 操作封装

use anyhow::{Context, Result};
use chrono::Local;
use rusqlite::{params, Connection};
use crate::state::{Priority, Todo};

/// 数据库文件路径：优先使用项目 data 目录，其次 %LOCALAPPDATA%/WindowsPet/pet.db
fn db_path() -> std::path::PathBuf {
    // 优先使用项目内的 data 目录（避免沙箱限制）
    let project_data = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("data");
    if let Ok(_) = std::fs::create_dir_all(&project_data) {
        return project_data.join("pet.db");
    }
    // 回退到系统目录
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("WindowsPet");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("pet.db")
}

/// 初始化数据库连接，并建表（如果不存在）
pub fn init_db() -> Result<Connection> {
    let path = db_path();
    let conn = Connection::open(&path)
        .with_context(|| format!("打开数据库失败: {:?}", path))?;

    // 创建待办表
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS todos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT    NOT NULL,
            content     TEXT    NOT NULL DEFAULT '',
            done        INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL,
            deadline    TEXT,
            priority    INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_todos_done ON todos(done);
        CREATE INDEX IF NOT EXISTS idx_todos_deadline ON todos(deadline);
        "#,
    )?;
    Ok(conn)
}

// ============ 待办 CRUD ============

/// 新增一条待办
pub fn create_todo(
    conn: &Connection,
    title: &str,
    content: Option<&str>,
    deadline: Option<&str>,
    priority: Option<i32>,
) -> Result<i64> {
    let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let pri = priority.map(Priority::from_i32).unwrap_or(Priority::Medium);
    conn.execute(
        "INSERT INTO todos (title, content, done, created_at, deadline, priority)
         VALUES (?1, ?2, 0, ?3, ?4, ?5)",
        params![
            title,
            content.unwrap_or(""),
            now,
            deadline,
            pri.to_i32(),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 列表查询：status = all / unfinished / done
pub fn list_todos(conn: &Connection, status: &str) -> Result<Vec<Todo>> {
    let sql = match status {
        "done" => "SELECT id,title,content,done,created_at,deadline,priority FROM todos WHERE done=1 ORDER BY created_at DESC",
        "unfinished" => "SELECT id,title,content,done,created_at,deadline,priority FROM todos WHERE done=0 ORDER BY priority DESC, deadline IS NULL, deadline ASC, created_at DESC",
        _ => "SELECT id,title,content,done,created_at,deadline,priority FROM todos ORDER BY done ASC, priority DESC, deadline IS NULL, deadline ASC, created_at DESC",
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| {
        Ok(Todo {
            id: row.get(0)?,
            title: row.get(1)?,
            content: row.get(2)?,
            done: row.get::<_, i32>(3)? != 0,
            created_at: row.get(4)?,
            deadline: row.get(5)?,
            priority: Priority::from_i32(row.get(6)?),
        })
    })?;
    let mut list = Vec::new();
    for r in rows {
        list.push(r?);
    }
    Ok(list)
}

/// 更新待办内容
pub fn update_todo(
    conn: &Connection,
    id: i64,
    title: &str,
    content: Option<&str>,
    deadline: Option<&str>,
    priority: Option<i32>,
) -> Result<()> {
    conn.execute(
        "UPDATE todos SET title=?1, content=?2, deadline=?3, priority=?4 WHERE id=?5",
        params![
            title,
            content.unwrap_or(""),
            deadline,
            priority.map(Priority::from_i32).unwrap_or(Priority::Medium).to_i32(),
            id,
        ],
    )?;
    Ok(())
}

/// 删除待办
pub fn delete_todo(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM todos WHERE id=?1", params![id])?;
    Ok(())
}

/// 标记完成 / 未完成
pub fn mark_done(conn: &Connection, id: i64, done: bool) -> Result<()> {
    conn.execute(
        "UPDATE todos SET done=?1 WHERE id=?2",
        params![done as i32, id],
    )?;
    Ok(())
}

/// 统计未完成待办数量
pub fn count_unfinished(conn: &Connection) -> Result<i64> {
    let val: i64 = conn.query_row(
        "SELECT COUNT(*) FROM todos WHERE done=0",
        [],
        |row| row.get(0),
    )?;
    Ok(val)
}
