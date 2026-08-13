/* =============================================================
   草稿纸逻辑
   - 富文本编辑（文字 + 粘贴图片）
   - 自动保存（防抖 500ms）
   - 手动实现窗口拖拽（mousedown 触发 IPC start_drag）
   - 关闭按钮通过 Tauri window hide() 实现（避免白屏）
   ============================================================= */

function invoke(cmd, args) {
  const fn = window.__TAURI__?.core?.invoke;
  if (!fn) return Promise.reject(new Error('Tauri API 未就绪'));
  return fn(cmd, args);
}

const editor = document.getElementById('editor');
const saveStatus = document.getElementById('save-status');
const clearBtn = document.getElementById('btn-clear');
const header = document.querySelector('.sticky-header');
const closeBtn = document.getElementById('btn-close');

let saveTimer = null;
let clearArmed = false;
let clearArmTimer = null;

/* ---------------- 初始化 ---------------- */
async function init() {
  // 加载已保存的内容
  try {
    const content = await invoke('sticky_load');
    if (content) {
      editor.innerHTML = content;
    }
  } catch (e) {
    console.warn('加载草稿纸失败', e);
  }

  // 输入时自动保存（防抖）
  editor.addEventListener('input', scheduleSave);

  // 粘贴处理：支持图片
  editor.addEventListener('paste', handlePaste);

  // 清空按钮（二次确认）
  clearBtn.addEventListener('click', onClearClick);

  // 关闭按钮：用 Tauri window API 的 hide()（而非 window.close() 避免白屏）
  closeBtn.addEventListener('click', onCloseClick);

  // 拖拽：标题栏 mousedown 触发 Tauri 原生 start_dragging
  bindDrag();

  // 监听面板显示事件
  const listen = window.__TAURI__?.event?.listen;
  if (listen) {
    listen('panel:show', async () => {
      try {
        const content = await invoke('sticky_load');
        const current = editor.innerHTML;
        if (content !== current) {
          editor.innerHTML = content || '';
        }
      } catch (e) {}
    }).catch(() => {});
  }
}

/* ---------------- 拖拽实现 ---------------- */
function bindDrag() {
  // 方案 A：优先使用 Tauri 的 start_dragging IPC 命令（最可靠）
  header.addEventListener('mousedown', async (e) => {
    // 只响应左键
    if (e.button !== 0) return;
    // 点击按钮（清空、关闭）不触发拖拽
    if (e.target.closest('.tool-btn')) return;

    e.preventDefault();
    try {
      await invoke('window_start_drag');
    } catch (err1) {
      // 方案 B：Tauri v2 window.startDragging() API
      try {
        const win = window.__TAURI__?.window?.getCurrentWindow?.();
        if (win && typeof win.startDragging === 'function') {
          await win.startDragging();
        } else {
          // 方案 C：纯前端手动拖拽（调用 get/set_position IPC）
          fallbackManualDrag(e);
        }
      } catch (err2) {
        fallbackManualDrag(e);
      }
    }
  });
}

/* 兜底：手动实现拖拽逻辑（和桌宠一样的方式）*/
function fallbackManualDrag(startEv) {
  let dragging = true;
  let startScreenX = startEv.screenX;
  let startScreenY = startEv.screenY;
  let winStartX = 0;
  let winStartY = 0;

  const promise = invoke('window_get_position')
    .then((pos) => { winStartX = pos.x; winStartY = pos.y; })
    .catch(() => {});

  const onMove = (ev) => {
    if (!dragging) return;
    const dx = ev.screenX - startScreenX;
    const dy = ev.screenY - startScreenY;
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      promise.then(() => {
        invoke('window_set_position', { x: winStartX + dx, y: winStartY + dy }).catch(() => {});
      });
    }
  };

  const onUp = () => {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/* ---------------- 自动保存 ---------------- */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveStatus.textContent = '保存中...';
  saveStatus.className = 'sticky-status saving';
  saveTimer = setTimeout(async () => {
    try {
      await invoke('sticky_save', { content: editor.innerHTML });
      saveStatus.textContent = '已保存';
      saveStatus.className = 'sticky-status saved';
    } catch (e) {
      saveStatus.textContent = '保存失败';
      saveStatus.className = 'sticky-status error';
    }
  }, 500);
}

/* ---------------- 清空（二次确认） ---------------- */
function onClearClick() {
  if (!editor.innerHTML.trim()) return;

  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = '⚠️';
    clearBtn.classList.add('armed');
    clearBtn.title = '再次点击确认清空';
    clearArmTimer = setTimeout(() => {
      clearArmed = false;
      clearBtn.textContent = '🗑';
      clearBtn.classList.remove('armed');
      clearBtn.title = '清空内容';
    }, 2000);
  } else {
    clearTimeout(clearArmTimer);
    clearArmed = false;
    clearBtn.textContent = '🗑';
    clearBtn.classList.remove('armed');
    clearBtn.title = '清空内容';
    editor.innerHTML = '';
    scheduleSave();
    editor.focus();
  }
}

/* ---------------- 关闭按钮：调用 Tauri 窗口隐藏 ---------------- */
async function onCloseClick() {
  try {
    // 先强制保存一次
    await invoke('sticky_save', { content: editor.innerHTML });
  } catch (e) { /* 忽略保存错误，继续隐藏 */ }

  try {
    // 通过 Tauri window API 隐藏窗口
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (win && typeof win.hide === 'function') {
      await win.hide();
      return;
    }
  } catch (e) {}

  // 兜底：调用 Rust 命令（需要我们在 commands.rs 新增 sticky_hide 命令）
  try {
    await invoke('sticky_hide');
  } catch (e) {
    // 最后的兜底：直接 window.close() 可能导致白屏，但总比关不掉好
    try { window.close(); } catch {}
  }
}

/* ---------------- 粘贴图片处理 ---------------- */
function handlePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;

      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = document.createElement('img');
        img.src = ev.target.result;
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(img);
          range.setStartAfter(img);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          editor.appendChild(img);
        }
        editor.appendChild(document.createElement('br'));
        scheduleSave();
      };
      reader.readAsDataURL(blob);
      break;
    }
  }
}

/* ---------------- 启动 ---------------- */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
