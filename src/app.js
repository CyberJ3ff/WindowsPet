/* =============================================================
   桌宠主窗口交互逻辑
   - 状态机：idle / remind / talk / sleep / interactive
   - 事件监听：Tauri 事件 + 鼠标拖拽 + 点击
   - 气泡显示/隐藏 + 待办列表渲染
   ============================================================= */

// Tauri v2 API: 延迟获取，防止脚本加载时 __TAURI__ 未就绪
function invoke(cmd, payload) {
  const fn = window.__TAURI__?.core?.invoke;
  if (!fn) return Promise.reject(new Error('Tauri API 未就绪'));
  return fn(cmd, payload);
}
const listen = window.__TAURI__?.event?.listen
  ?? (() => () => {});

/* ---------- 自定义弹窗（替代 confirm/alert） ---------- */
function showModal(message, opts = {}) {
  const { type = 'alert', onConfirm, onCancel } = opts;
  let modal = document.getElementById('custom-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'custom-modal';
    modal.className = 'custom-modal';
    modal.innerHTML = `
      <div class="custom-modal-mask"></div>
      <div class="custom-modal-box">
        <div class="custom-modal-msg"></div>
        <div class="custom-modal-actions"></div>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.querySelector('.custom-modal-msg').textContent = message;
  const actions = modal.querySelector('.custom-modal-actions');
  actions.innerHTML = '';
  if (type === 'confirm') {
    const btnOk = document.createElement('button');
    btnOk.className = 'ctx-btn ctx-btn-primary';
    btnOk.textContent = '确认';
    btnOk.addEventListener('click', () => { modal.classList.remove('show'); if (onConfirm) onConfirm(); });
    const btnCancel = document.createElement('button');
    btnCancel.className = 'ctx-btn';
    btnCancel.textContent = '取消';
    btnCancel.addEventListener('click', () => { modal.classList.remove('show'); if (onCancel) onCancel(); });
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
  } else {
    const btnOk = document.createElement('button');
    btnOk.className = 'ctx-btn ctx-btn-primary';
    btnOk.textContent = '确定';
    btnOk.addEventListener('click', () => { modal.classList.remove('show'); if (onConfirm) onConfirm(); });
    actions.appendChild(btnOk);
  }
  modal.classList.add('show');
}
function modalAlert(msg) { showModal(msg, { type: 'alert' }); }
function modalConfirm(msg) {
  return new Promise(resolve => {
    showModal(msg, { type: 'confirm', onConfirm: () => resolve(true), onCancel: () => resolve(false) });
  });
}

const $ = id => document.getElementById(id);
const petBody   = $('pet-body');
const bubble    = $('bubble');
const bubbleTxt = $('bubble-text');
const bubbleActions = $('bubble-actions');
const bubbleList    = $('bubble-list');
const ctxMenu   = $('ctx-menu');

let bubbleTimer = null;
let currentState = 'idle';
let settings = null;

/* ---------------- 初始化 ---------------- */
async function init() {
  // 1. 加载设置 → 应用缩放
  try {
    settings = await invoke('settings_get');
    applyScale(settings.scale ?? 1);
  } catch (e) { console.warn('读取设置失败', e); }

  // 2. 监听 Rust 端发来的事件
  await listen('pet:state', (ev) => {
    const s = String(ev.payload ?? 'idle');
    // 将 PetState 枚举字符串映射到 CSS 类名
    const map = { Idle:'idle', Remind:'remind', Talk:'talk', Sleep:'sleep', Interactive:'interactive' };
    switchState(map[s] ?? s);
    // Remind 状态同时弹气泡
    if (s === 'Remind') {
      // 气泡内容后续由 remind-bubble 事件携带
    }
  });

  await listen('pet:remind-bubble', async (ev) => {
    const p = ev.payload ?? {};
    if (p.type === 'daily') {
      showBubble(p.text ?? '要创建今天的待办吗？', {
        actions: ['create-todo'],
        autoHideMs: 12000,
      });
    } else if (p.type === 'unfinished') {
      const cnt = p.count ?? 0;
      try {
        const list = await invoke('todo_list', { status: 'unfinished' });
        showBubble(`还有 ${cnt} 条待办未完成`, {
          actions: ['open-todo', 'snooze'],
          list,
          autoHideMs: 10000,
        });
      } catch {
        showBubble(`还有 ${cnt} 条待办未完成`, {
          actions: ['open-todo', 'snooze'],
          autoHideMs: 10000,
        });
      }
    }
  });

  await listen('settings:updated', (ev) => {
    settings = ev.payload;
    applyScale(settings.scale ?? 1);
  });

  // 3. 自定义右键菜单
  bindContextMenu();

  // 4. 绑定鼠标交互
  bindPetInteraction();

  // 5. 默认进入 idle 状态
  switchState('idle');
}

/* ---------------- 状态切换 ---------------- */
function switchState(state) {
  if (currentState === state && state !== 'interactive') return;
  currentState = state;
  petBody.className = 'pet-body state-' + state;
  petBody.dataset.state = state;
}

/* ---------------- 气泡 ---------------- */
/**
 * 显示气泡
 * @param {string} text 主要文字
 * @param {object} opt  { actions: string[], list: Todo[], autoHideMs: number }
 */
function showBubble(text, opt = {}) {
  clearTimeout(bubbleTimer);
  bubbleTxt.textContent = text;

  // actions
  const actionBtns = bubbleActions.querySelectorAll('button');
  actionBtns.forEach(b => b.style.display = 'none');
  (opt.actions || []).forEach(a => {
    if (a === 'open-todo')   $('btn-open-todo').style.display  = '';
    if (a === 'create-todo') $('btn-create-todo').style.display= '';
    if (a === 'snooze')      $('btn-snooze').style.display     = '';
  });
  bubbleActions.style.display = (opt.actions && opt.actions.length) ? 'flex' : 'none';

  // list
  bubbleList.innerHTML = '';
  if (opt.list && opt.list.length) {
    opt.list.slice(0, 3).forEach(todo => {
      const row = document.createElement('div');
      row.className = 'todo-item';
      const pClass = todo.priority === 'High' ? 'p-high' : todo.priority === 'Low' ? 'p-low' : '';
      row.innerHTML = `
        <div class="todo-title ${pClass}">${escapeHtml(todo.title)}</div>
        <button class="btn-done">完成</button>
      `;
      row.querySelector('.btn-done').onclick = async (e) => {
        e.stopPropagation();
        try {
          await invoke('todo_mark_done', { id: todo.id, done: true });
          row.style.opacity = 0.4;
          row.querySelector('.todo-title').style.textDecoration = 'line-through';
        } catch (e) { modalAlert(String(e)); }
      };
      bubbleList.appendChild(row);
    });
    bubbleList.style.display = 'block';
  } else {
    bubbleList.style.display = 'none';
  }

  bubble.classList.remove('hidden');
  // 状态切到 talk（说话时点头动画）
  if (currentState !== 'remind') switchState('talk');

  if (opt.autoHideMs) {
    bubbleTimer = setTimeout(hideBubble, opt.autoHideMs);
  }
}

function hideBubble() {
  clearTimeout(bubbleTimer);
  bubble.classList.add('hidden');
  if (currentState === 'talk') switchState('idle');
}

/* ---------------- 桌宠鼠标交互 ---------------- */
function bindPetInteraction() {
  let moved = false;
  let dragging = false;
  let startScreenX = 0, startScreenY = 0;
  let winStartX = 0, winStartY = 0;

  // 拖拽中 mousemove 处理器（绑定在 document 上以支持拖出窗口）
  const onDragMove = (ev) => {
    const dx = ev.screenX - startScreenX;
    const dy = ev.screenY - startScreenY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (moved) {
      invoke('window_set_position', { x: winStartX + dx, y: winStartY + dy }).catch(() => {});
    }
  };

  // 拖拽结束 mouseup 处理器
  const onDragUp = async (ev) => {
    if (ev.button !== 0) return;
    dragging = false;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragUp);

    if (moved) {
      // 拖拽结束：边界检测
      try { await invoke('window_clamp_position'); } catch {}
      return;
    }

    // === 单击（未拖动）→ 弹气泡 + Interactive 状态 ===
    ev.stopPropagation();

    // 切换 Interactive 状态 0.6 秒
    switchState('interactive');
    setTimeout(() => { if (currentState === 'interactive') switchState('idle'); }, 650);

    // 拉取未完成待办 → 气泡展示
    try {
      const list = await invoke('todo_list', { status: 'unfinished' });
      if (list && list.length) {
        showBubble(`你有 ${list.length} 条未完成待办`, {
          actions: ['open-todo', 'snooze'],
          list,
          autoHideMs: 12000,
        });
      } else {
        showBubble('当前没有未完成待办，真厉害！', {
          actions: ['create-todo', 'open-todo'],
          autoHideMs: 5000,
        });
      }
    } catch (e) {
      showBubble('你好呀～', { actions: ['create-todo'], autoHideMs: 4000 });
    }
  };

  // 鼠标按下：记录初始位置，准备拖拽
  petBody.addEventListener('mousedown', async (ev) => {
    if (ev.button !== 0) return;
    moved = false;
    dragging = true;
    startScreenX = ev.screenX;
    startScreenY = ev.screenY;
    // 获取当前窗口位置
    try {
      const pos = await invoke('window_get_position');
      winStartX = pos.x;
      winStartY = pos.y;
    } catch {
      winStartX = 0;
      winStartY = 0;
    }
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragUp);
  });

  // 点击空白处隐藏气泡
  document.addEventListener('mousedown', (ev) => {
    if (!bubble.contains(ev.target) && !petBody.contains(ev.target)) {
      hideBubble();
    }
  });

  // 气泡按钮
  $('btn-snooze').onclick = async (e) => {
    e.stopPropagation();
    try { await invoke('snooze_reminder', { minutes: 10 }); } catch {}
    hideBubble();
  };
  $('btn-open-todo').onclick = async (e) => {
    e.stopPropagation();
    try { await invoke('open_todo_window'); } catch (e) { modalAlert(String(e)); }
    hideBubble();
  };
  $('btn-create-todo').onclick = async (e) => {
    e.stopPropagation();
    try { await invoke('open_todo_window'); } catch (e) { modalAlert(String(e)); }
    hideBubble();
  };
}

/* ---------------- 自定义右键菜单 ---------------- */
function bindContextMenu() {
  // 阻止浏览器默认右键菜单（全局）
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // 右键点击桌宠本体 → 显示自定义菜单
  petBody.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    showContextMenu();
  });

  // 点击菜单项执行对应操作
  ctxMenu.addEventListener('mousedown', (e) => {
    e.stopPropagation(); // 防止触发 hideContextMenu
  });
  ctxMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.ctx-menu-item');
    if (!item) return;
    const action = item.dataset.action;
    hideContextMenu();
    switch (action) {
      case 'todo':
        try { await invoke('open_todo_window'); } catch (err) { modalAlert(String(err)); }
        break;
      case 'sticky':
        try { await invoke('open_sticky_window'); } catch (err) { modalAlert(String(err)); }
        break;
      case 'settings':
        try { await invoke('open_settings_window'); } catch (err) { modalAlert(String(err)); }
        break;
      case 'hide':
        try {
          const w = window.__TAURI__?.window?.getCurrentWindow?.();
          if (w) await w.hide();
        } catch (err) { /* ignore */ }
        break;
      case 'quit':
        {
          const ok = await modalConfirm('确认退出桌宠程序吗？');
          if (!ok) break;
          try {
            await invoke('quit_app');
          } catch {
            window.close();
          }
        }
        break;
    }
  });
}

function showContextMenu() {
  ctxMenu.classList.remove('hidden');
  // 点击菜单外任意位置隐藏
  setTimeout(() => {
    document.addEventListener('mousedown', hideContextMenu, { once: true });
  }, 0);
}

function hideContextMenu() {
  ctxMenu.classList.add('hidden');
}

/* ---------------- 工具函数 ---------------- */
function applyScale(s) {
  document.documentElement.style.setProperty('--pet-scale', String(s || 1));
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[c]);
}

/* ---------------- 启动 ---------------- */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
