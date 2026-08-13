/* =============================================================
   共用前端工具 + 待办面板 init + 设置面板 init
   ============================================================= */

// 等待 Tauri API 就绪
function waitForTauri(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.__TAURI__?.core?.invoke) {
        resolve();
      } else if (Date.now() - start >= timeoutMs) {
        reject(new Error('Tauri API 加载超时'));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// Tauri v2 API: 延迟获取
function invoke(cmd, args) {
  const fn = window.__TAURI__?.core?.invoke;
  if (!fn) return Promise.reject(new Error('Tauri API 未就绪，请稍后重试'));
  return fn(cmd, args);
}

/* ---------- 自定义弹窗（替代 confirm/alert，避免 WebView2 ToolWindow 兼容问题） ---------- */
function showModal(message, opts = {}) {
  const { type = 'alert', onConfirm, onCancel } = opts; // type: 'alert' | 'confirm'
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
    btnOk.className = 'btn btn-primary';
    btnOk.textContent = '确认';
    btnOk.addEventListener('click', () => { modal.classList.remove('show'); if (onConfirm) onConfirm(); });
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn';
    btnCancel.textContent = '取消';
    btnCancel.addEventListener('click', () => { modal.classList.remove('show'); if (onCancel) onCancel(); });
    actions.appendChild(btnOk);
    actions.appendChild(btnCancel);
  } else {
    const btnOk = document.createElement('button');
    btnOk.className = 'btn btn-primary';
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

/* ---------- 工具 ---------- */
function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}
function fmtDateTime(s) {
  if (!s) return '';
  // sqlite: "YYYY-MM-DD HH:MM:SS" / datetime-local 格式 YYYY-MM-DDTHH:MM
  return s.replace('T', ' ').slice(0, 16);
}
function toLocalInputValue(s) {
  // sqlite "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM"
  if (!s) return '';
  return s.replace(' ', 'T').slice(0, 16);
}
function isOverdue(deadline) {
  if (!deadline) return false;
  return new Date(deadline.replace(' ', 'T')) < new Date();
}
function alertErr(e) {
  modalAlert('操作失败：' + (typeof e === 'string' ? e : e?.message || String(e)));
}

/* =============================================================
   待办面板
   ============================================================= */
let todoFilter = 'all';

function initTodoPanel() {
  waitForTauri().then(() => {
    loadList();

    // 切换筛选
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        todoFilter = tab.dataset.f;
        loadList();
      });
    });

    // 保存
    $('btn-save').addEventListener('click', onSave);

    // 重置表单
    $('btn-reset').addEventListener('click', resetForm);

    // 关闭按钮
    const closeBtn = document.getElementById('btn-close');
    if (closeBtn) closeBtn.addEventListener('click', () => window.close());

    // 监听面板显示事件（从后台切回时刷新数据）
    const listen = window.__TAURI__?.event?.listen;
    if (listen) {
      listen('panel:show', () => loadList()).catch(() => {});
    }
  }).catch(err => {
    modalAlert('待办面板加载失败：' + err.message);
  });
}

async function loadList() {
  const listBox = $('todo-list');
  listBox.innerHTML = '<div class="todo-empty">加载中...</div>';
  try {
    const list = await invoke('todo_list', { status: todoFilter }) || [];
    $('list-count').textContent = `共 ${list.length} 条`;
    renderList(list);
  } catch (e) {
    listBox.innerHTML = '<div class="todo-empty">加载失败：' + (typeof e === 'string' ? e : e?.message || String(e)) + '<br><button class="btn btn-sm" onclick="location.reload()">重试</button></div>';
    alertErr(e);
  }
}

function renderList(list) {
  const box = $('todo-list');
  if (!list.length) {
    box.innerHTML = `<div class="todo-empty">暂无待办，点左上角新增一条吧～</div>`;
    return;
  }
  box.innerHTML = list.map(t => {
    const prioClass = t.priority === 'High' ? 'p-high' : t.priority === 'Low' ? 'p-low' : '';
    const prioTag = t.priority === 'High' ? '<span class="prio-tag prio-high">高优</span>'
                  : t.priority === 'Low'  ? '<span class="prio-tag prio-low">低优</span>'
                  : '<span class="prio-tag prio-mid">中优</span>';
    const overdue = !t.done && isOverdue(t.deadline);
    const deadlineStr = t.deadline
      ? `<span class="${overdue ? 'deadline-overdue' : ''}">⏰ ${fmtDateTime(t.deadline)}${overdue ? ' 已逾期' : ''}</span>`
      : '';
    const doneAttr = t.done ? 'checked' : '';
    return `
      <div class="todo-item ${t.done ? 'done' : ''}" data-id="${t.id}">
        <input type="checkbox" class="chk-done" ${doneAttr}/>
        <div class="todo-main">
          <div class="todo-title ${prioClass}">${escapeHtml(t.title)}</div>
          ${t.content ? `<div class="todo-content">${escapeHtml(t.content)}</div>` : ''}
          <div class="todo-meta">
            ${prioTag}
            <span>📅 创建于 ${fmtDateTime(t.created_at)}</span>
            ${deadlineStr}
          </div>
        </div>
        <div class="todo-actions">
          <button class="btn btn-sm btn-edit">编辑</button>
          <button class="btn btn-sm btn-del">删除</button>
        </div>
      </div>
    `;
  }).join('');

  // 绑定事件
  box.querySelectorAll('.todo-item').forEach(item => {
    const id = Number(item.dataset.id);
    item.querySelector('.chk-done').addEventListener('change', async (e) => {
      try {
        await invoke('todo_mark_done', { id, done: e.target.checked });
        loadList();
      } catch (err) { alertErr(err); e.target.checked = !e.target.checked; }
    });
    item.querySelector('.btn-edit').addEventListener('click', () => fillForm(id));
    item.querySelector('.btn-del').addEventListener('click', async () => {
      const ok = await modalConfirm('确认删除这条待办吗？');
      if (!ok) return;
      try {
        await invoke('todo_delete', { id });
        loadList();
      } catch (err) { alertErr(err); }
    });
  });
}

async function fillForm(id) {
  const list = await invoke('todo_list', { status: 'all' }) || [];
  const t = list.find(x => x.id === id);
  if (!t) return;
  $('form-title').textContent = '编辑待办';
  $('f-id').value = t.id;
  $('f-title').value = t.title;
  $('f-content').value = t.content || '';
  $('f-deadline').value = toLocalInputValue(t.deadline);
  $('f-priority').value = t.priority === 'High' ? '2' : t.priority === 'Low' ? '0' : '1';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm() {
  $('form-title').textContent = '新增待办';
  $('f-id').value = '';
  $('f-title').value = '';
  $('f-content').value = '';
  $('f-deadline').value = '';
  $('f-priority').value = '1';
}

async function onSave() {
  const title = $('f-title').value.trim();
  if (!title) { modalAlert('请输入标题'); $('f-title').focus(); return; }
  const content  = $('f-content').value.trim() || null;
  const deadline = $('f-deadline').value ? $('f-deadline').value.replace('T', ' ') + ':00' : null;
  const priority = parseInt($('f-priority').value, 10);
  const editId   = Number($('f-id').value || '0');

  try {
    if (editId) {
      await invoke('todo_update', { id: editId, title, content, deadline, priority });
    } else {
      await invoke('todo_create', { title, content, deadline, priority });
    }
    resetForm();
    loadList();
  } catch (e) { alertErr(e); }
}

/* =============================================================
   设置面板
   ============================================================= */
let curSettings = null;

function initSettingsPanel() {
  waitForTauri().then(() => {
    loadSettings();

    // 实时显示缩放值
    $('s-scale').addEventListener('input', () => {
      $('s-scale-val').textContent = Number($('s-scale').value).toFixed(1) + 'x';
    });

    $('btn-save').addEventListener('click', onSaveSettings);
    $('btn-reset').addEventListener('click', () => applySettingsForm({
      idle_timeout_minutes: 5, remind_cooldown_seconds: 30,
      daily_remind_time: '09:00', autostart: false,
      always_on_top: true, scale: 1.0, sound_enabled: false,
    }));

    $('btn-show-pet').addEventListener('click', async () => {
      try {
        const win = await getWindow('pet');
        await win.show();
        await win.setFocus();
      } catch (e) {}
    });
    $('btn-hide-pet').addEventListener('click', async () => {
      try { (await getWindow('pet')).hide(); } catch (e) {}
    });
    $('btn-exit').addEventListener('click', async () => {
      const ok = await modalConfirm('确认退出桌宠程序吗？');
      if (!ok) return;
      try {
        await invoke('quit_app');
      } catch {}
    });

    // 关闭按钮
    const closeBtn = document.getElementById('btn-close');
    if (closeBtn) closeBtn.addEventListener('click', () => window.close());

    // 打开数据目录
    const dataBtn = document.getElementById('btn-open-data');
    if (dataBtn) dataBtn.addEventListener('click', () => {
      alert('数据目录：%LOCALAPPDATA%\\WindowsPet');
    });

    // 监听面板显示事件
    const listen = window.__TAURI__?.event?.listen;
    if (listen) {
      listen('panel:show', () => loadSettings()).catch(() => {});
    }
  }).catch(err => {
    modalAlert('设置面板加载失败：' + err.message);
  });
}

async function getWindow(label) {
  const WebviewWindow = window.__TAURI__?.window?.WebviewWindow;
  if (!WebviewWindow) throw new Error('Tauri window API not available');
  return (await WebviewWindow.getByLabel(label))
    || new WebviewWindow(label);
}

async function loadSettings() {
  try {
    curSettings = await invoke('settings_get');
    applySettingsForm(curSettings);
  } catch (e) {
    // 设置加载失败时使用默认值
    curSettings = {
      idle_timeout_minutes: 5, remind_cooldown_seconds: 30,
      daily_remind_time: '09:00', autostart: false,
      always_on_top: true, scale: 1.0, sound_enabled: false,
    };
    applySettingsForm(curSettings);
    modalAlert('设置加载失败，已使用默认值');
  }
}
function applySettingsForm(s) {
  $('s-idle').value     = s.idle_timeout_minutes;
  $('s-cooldown').value = s.remind_cooldown_seconds;
  $('s-daily').value    = s.daily_remind_time;
  $('s-autostart').checked = !!s.autostart;
  $('s-top').checked    = !!s.always_on_top;
  $('s-sound').checked  = !!s.sound_enabled;
  $('s-scale').value    = s.scale;
  $('s-scale-val').textContent = Number(s.scale).toFixed(1) + 'x';
}
function collectSettingsForm() {
  return {
    // 保留原设置里不展示的字段（last_daily_remind_date 等）
    ...(curSettings || {}),
    idle_timeout_minutes: parseInt($('s-idle').value, 10) || 5,
    remind_cooldown_seconds: parseInt($('s-cooldown').value, 10) || 30,
    daily_remind_time: $('s-daily').value || '09:00',
    autostart: $('s-autostart').checked,
    always_on_top: $('s-top').checked,
    sound_enabled: $('s-sound').checked,
    scale: parseFloat($('s-scale').value) || 1.0,
  };
}
async function onSaveSettings() {
  const s = collectSettingsForm();
  try {
    await invoke('settings_save', { new: s });
    curSettings = s;
    modalAlert('设置已保存');
  } catch (e) { alertErr(e); }
}
