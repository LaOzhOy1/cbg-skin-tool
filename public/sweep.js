const STATUS_LABELS = {
  draft: '草稿',
  active: '监控中',
  pending_payment: '待支付',
  completed: '已完成',
  expired: '已过期',
  cancelled: '已取消',
  failed: '失败',
};

const STATUS_CLASS = {
  active: 'warn',
  pending_payment: 'warn',
  completed: 'ok',
  expired: 'error',
  cancelled: '',
  failed: 'error',
};

const EVENT_LABELS = {
  order_placed: '已下单',
  order_role_missing: '检测到匹配（未配置买家角色）',
  order_error: '下单出错',
  fair_show_blocked: '检测到匹配（仍在公示期）',
  payment_confirmed: '支付确认',
  payment_check_error: '查询支付状态出错',
  expired: '任务过期',
  cancelled: '任务取消',
};

let currentId = null;
let itemNamesByCategory = { hero: [], weapon: [] };

const el = {
  createForm: document.getElementById('create-form'),
  itemName: document.getElementById('field-item-name'),
  itemNameOptions: document.getElementById('field-item-name-options'),
  itemNameHint: document.getElementById('item-name-hint'),
  category: document.getElementById('field-category'),
  price: document.getElementById('field-price'),
  quantity: document.getElementById('field-quantity'),
  duration: document.getElementById('field-duration'),
  starLevel: document.getElementById('field-star-level'),
  slot1: document.getElementById('field-slot1'),
  slot2: document.getElementById('field-slot2'),
  slot3: document.getElementById('field-slot3'),
  slot4: document.getElementById('field-slot4'),
  createError: document.getElementById('create-error'),
  list: document.getElementById('task-list'),
  emptyDetail: document.getElementById('empty-detail'),
  detail: document.getElementById('detail'),
  title: document.getElementById('detail-title'),
  status: document.getElementById('detail-status'),
  desc: document.getElementById('detail-desc'),
  statProgress: document.getElementById('stat-progress'),
  statPrice: document.getElementById('stat-price'),
  statDeadline: document.getElementById('stat-deadline'),
  pendingPanel: document.getElementById('pending-order-panel'),
  pendingText: document.getElementById('pending-order-text'),
  pendingLink: document.getElementById('pending-order-link'),
  historyTimeline: document.getElementById('history-timeline'),
  cancelBtn: document.getElementById('cancel-btn'),
};

async function api(path, options) {
  const res = await fetch(`/api/admin/sweep-tasks${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusBadge(status) {
  const cls = STATUS_CLASS[status] || '';
  return `<span class="admin-badge ${cls}">${STATUS_LABELS[status] || status}</span>`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

async function loadItemNames() {
  try {
    itemNamesByCategory = await api('/item-names');
  } catch {
    // 拉取失败不阻塞表单，退化成手动输入
  }
  renderItemNameOptions();
}

function renderItemNameOptions() {
  const names = itemNamesByCategory[el.category.value] || [];
  el.itemNameOptions.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  el.itemNameHint.textContent = names.length
    ? `当前在售 ${names.length} 种商品可选，也可以手动输入其他名称`
    : '当前分类没有在售商品可选，请手动输入名称';
}

el.category.addEventListener('change', renderItemNameOptions);

async function loadList() {
  const tasks = await api('/');
  el.list.innerHTML = tasks
    .map(
      (t) => `
        <button class="sweep-item ${t.id === currentId ? 'active-item' : ''}" data-id="${t.id}">
          <span class="title">${escapeHtml(t.title)}</span>
          ${statusBadge(t.status)}
        </button>`
    )
    .join('');
  return tasks;
}

function renderDetail(task) {
  el.emptyDetail.classList.add('hidden');
  el.detail.classList.remove('hidden');

  el.title.textContent = task.title;
  el.status.className = `admin-badge ${STATUS_CLASS[task.status] || ''}`;
  el.status.textContent = STATUS_LABELS[task.status] || task.status;
  const category = task.targetCategory === 'weapon' ? '兵器皮肤' : '英雄皮肤';
  const vf = task.variationFilter;
  const vfText = vf
    ? ` · 星格筛选：星级${vf.starLevel || '不限'} / 星格 ${vf.slots.map((v) => (v === null ? '—' : v)).join(', ')}`
    : '';
  el.desc.textContent = `${category} · ${task.targetItemName}${vfText}`;

  el.statProgress.textContent = `${task.purchasedCount} / ${task.targetQuantity}`;
  el.statPrice.textContent = `≤ ¥${task.priceCeiling}`;
  el.statDeadline.textContent = formatDateTime(task.deadlineAt);

  if (task.pendingOrder) {
    el.pendingPanel.classList.remove('hidden');
    el.pendingText.textContent = `¥${task.pendingOrder.price}，下单于 ${formatDateTime(task.pendingOrder.placedAt)}`;
    el.pendingLink.href = task.pendingOrder.orderConfirmUrl || '#';
  } else {
    el.pendingPanel.classList.add('hidden');
  }

  const history = task.history || [];
  el.historyTimeline.innerHTML = history.length
    ? history
        .slice()
        .reverse()
        .map(
          (h) => `
        <div class="history-entry event-${h.event}">
          <div class="event-time">${formatDateTime(h.at)} · ${EVENT_LABELS[h.event] || h.event}</div>
          <div>${escapeHtml(h.detail)}</div>
        </div>`
        )
        .join('')
    : '<p class="text-ink-500 text-sm">暂无事件记录</p>';

  const terminal = ['completed', 'expired', 'cancelled', 'failed'].includes(task.status);
  el.cancelBtn.classList.toggle('hidden', terminal);
}

async function selectTask(id) {
  currentId = id;
  await refreshCurrent();
  await loadList();
}

async function refreshCurrent() {
  if (!currentId) return;
  try {
    const task = await api(`/${currentId}`);
    renderDetail(task);
  } catch {
    // 任务可能被删除或暂时不可达，忽略单次失败，下一轮轮询再试
  }
}

el.list.addEventListener('click', (e) => {
  const btn = e.target.closest('.sweep-item');
  if (!btn) return;
  selectTask(btn.dataset.id);
});

el.createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.createError.classList.add('hidden');
  const payload = {
    targetItemName: el.itemName.value.trim(),
    targetCategory: el.category.value,
    priceCeiling: Number(el.price.value),
    targetQuantity: Number(el.quantity.value),
    durationDays: Number(el.duration.value),
    starLevel: el.starLevel.value,
    slot1: el.slot1.value,
    slot2: el.slot2.value,
    slot3: el.slot3.value,
    slot4: el.slot4.value,
  };
  try {
    const task = await api('/', { method: 'POST', body: JSON.stringify(payload) });
    el.createForm.reset();
    await loadList();
    selectTask(task.id);
  } catch (err) {
    el.createError.textContent = err.message;
    el.createError.classList.remove('hidden');
  }
});

el.cancelBtn.addEventListener('click', async () => {
  if (!currentId) return;
  if (!confirm('确定要取消这个扫货任务吗？如果有待支付订单，需要你自己去藏宝阁「我的订单」处理。')) return;
  try {
    await api(`/${currentId}/cancel`, { method: 'POST' });
    await refreshCurrent();
    await loadList();
  } catch (err) {
    alert(`取消失败: ${err.message}`);
  }
});

async function pollLoop() {
  await loadList().catch(() => {});
  await refreshCurrent();
}

loadList();
loadItemNames();
setInterval(pollLoop, 5000);
setInterval(loadItemNames, 30000);
