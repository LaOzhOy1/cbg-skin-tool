const STATUS_LABELS = {
  draft: '草稿',
  planning: 'AI 规划中',
  plan_ready: '待确认',
  plan_rejected: '不可行',
  confirmed: '已确认',
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '执行失败',
  summarized: '已总结',
};

const STATUS_CLASS = {
  plan_ready: 'ok',
  succeeded: 'ok',
  summarized: 'ok',
  plan_rejected: 'error',
  failed: 'error',
  planning: 'warn',
  running: 'warn',
  queued: 'warn',
};

let currentId = null;
let pollTimer = null;

const el = {
  createForm: document.getElementById('create-form'),
  createText: document.getElementById('create-text'),
  list: document.getElementById('requirement-list'),
  emptyDetail: document.getElementById('empty-detail'),
  detail: document.getElementById('detail'),
  title: document.getElementById('detail-title'),
  status: document.getElementById('detail-status'),
  rawtext: document.getElementById('detail-rawtext'),
  planReject: document.getElementById('plan-reject'),
  planSteps: document.getElementById('plan-steps'),
  confirmBtn: document.getElementById('confirm-btn'),
  summarizeBtn: document.getElementById('summarize-btn'),
  chatHistory: document.getElementById('chat-history'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatHint: document.getElementById('chat-hint'),
  taskPanel: document.getElementById('task-panel'),
};

async function api(path, options) {
  const res = await fetch(`/api/admin${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function statusBadge(status) {
  const cls = STATUS_CLASS[status] || '';
  return `<span class="admin-badge ${cls}">${STATUS_LABELS[status] || status}</span>`;
}

async function loadList() {
  const requirements = await api('/requirements');
  el.list.innerHTML = requirements
    .map(
      (r) => `
        <button class="requirement-item ${r.id === currentId ? 'active' : ''}" data-id="${r.id}">
          <span class="title">${escapeHtml(r.title)}</span>
          ${statusBadge(r.status)}
        </button>`
    )
    .join('');
  return requirements;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDetail(requirement) {
  el.emptyDetail.classList.add('hidden');
  el.detail.classList.remove('hidden');

  el.title.textContent = requirement.title;
  el.status.className = `admin-badge ${STATUS_CLASS[requirement.status] || ''}`;
  el.status.textContent = STATUS_LABELS[requirement.status] || requirement.status;
  el.rawtext.textContent = requirement.rawText;

  const plan = requirement.plan;
  if (plan && plan.feasible === false) {
    el.planReject.classList.remove('hidden');
    el.planReject.textContent = `AI 判定不可行：${plan.rejectReason || '未说明原因'}`;
  } else {
    el.planReject.classList.add('hidden');
  }

  const steps = plan?.steps || [];
  el.planSteps.innerHTML = steps.length
    ? steps
        .map(
          (s, i) => `
        <li class="plan-step">
          <span class="cap-name">${i + 1}. ${escapeHtml(s.capability)}</span>
          <p class="mt-1">${escapeHtml(s.description || '')}</p>
        </li>`
        )
        .join('')
    : '<li class="text-ink-500 text-sm">（暂无步骤）</li>';

  el.confirmBtn.classList.toggle('hidden', requirement.status !== 'plan_ready' || plan?.feasible !== true);
  el.summarizeBtn.classList.toggle('hidden', requirement.status !== 'succeeded');

  el.chatHistory.innerHTML = (plan?.chatHistory || [])
    .map((turn) => `<div class="chat-turn ${turn.role}">${escapeHtml(turn.content)}</div>`)
    .join('');

  const chatDisabled = requirement.status !== 'plan_ready';
  el.chatInput.disabled = chatDisabled;
  el.chatForm.querySelector('button').disabled = chatDisabled;
  el.chatHint.classList.toggle('hidden', !chatDisabled);
  if (chatDisabled) {
    el.chatHint.textContent =
      requirement.status === 'planning' ? 'AI 正在规划中，请稍候...' : `当前状态（${STATUS_LABELS[requirement.status]}）不支持修改计划`;
  }

  const task = requirement.task;
  if (!task) {
    el.taskPanel.textContent = '尚未进入执行队列。';
  } else {
    const lines = [`任务状态：${STATUS_LABELS[task.status] || task.status}`];
    if (task.error) lines.push(`错误：${task.error}`);
    const stepLines = (task.stepResults || []).map((sr, i) => {
      const body = sr.error ? `失败：${sr.error}` : `成功：${JSON.stringify(sr.result).slice(0, 300)}`;
      return `  步骤 ${i + 1} (${sr.capability}) ${body}`;
    });
    el.taskPanel.innerHTML = [...lines, ...stepLines].map(escapeHtml).join('<br/>');
  }
}

async function selectRequirement(id) {
  currentId = id;
  await refreshCurrent();
  await loadList();
}

async function refreshCurrent() {
  if (!currentId) return;
  try {
    const requirement = await api(`/requirements/${currentId}`);
    renderDetail(requirement);
  } catch {
    // 需求可能被删除或暂时不可达，忽略单次失败，下一轮轮询再试
  }
}

el.list.addEventListener('click', (e) => {
  const btn = e.target.closest('.requirement-item');
  if (!btn) return;
  selectRequirement(btn.dataset.id);
});

el.createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const rawText = el.createText.value.trim();
  if (!rawText) return;
  el.createText.value = '';
  const requirement = await api('/requirements', { method: 'POST', body: JSON.stringify({ rawText }) });
  await loadList();
  selectRequirement(requirement.id);
});

el.confirmBtn.addEventListener('click', async () => {
  if (!currentId) return;
  el.confirmBtn.disabled = true;
  try {
    await api(`/requirements/${currentId}/confirm`, { method: 'POST' });
    await refreshCurrent();
  } catch (err) {
    alert(`确认失败: ${err.message}`);
  } finally {
    el.confirmBtn.disabled = false;
  }
});

el.summarizeBtn.addEventListener('click', async () => {
  if (!currentId) return;
  el.summarizeBtn.disabled = true;
  try {
    await api(`/requirements/${currentId}/summarize`, { method: 'POST' });
    await refreshCurrent();
  } catch (err) {
    alert(`总结失败: ${err.message}`);
  } finally {
    el.summarizeBtn.disabled = false;
  }
});

el.chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentId) return;
  const message = el.chatInput.value.trim();
  if (!message) return;
  el.chatInput.value = '';
  el.chatInput.disabled = true;
  try {
    await api(`/requirements/${currentId}/chat`, { method: 'POST', body: JSON.stringify({ message }) });
    await refreshCurrent();
  } catch (err) {
    alert(`发送失败: ${err.message}`);
  }
});

async function pollLoop() {
  await loadList().catch(() => {});
  await refreshCurrent();
}

loadList();
pollTimer = setInterval(pollLoop, 3000);
