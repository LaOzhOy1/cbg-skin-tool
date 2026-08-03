const STATUS_POLL_MS = 4000;
const VERIFY_POLL_MS = 3000;

let currentFilter = 'all';
let allItems = [];
let verifyPollTimer = null;

const el = {
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  loading: document.getElementById('loading'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  statusMeta: document.getElementById('status-meta'),
  pageTitle: document.getElementById('page-title'),
  overlay: document.getElementById('verify-overlay'),
  verifyBtn: document.getElementById('verify-btn'),
  verifyHint: document.getElementById('verify-hint'),
  nav: document.getElementById('nav'),
};

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function renderStatus(state) {
  el.statusDot.className = 'status-dot';
  let label = '未知';

  switch (state.status) {
    case 'ok':
      el.statusDot.classList.add('ok');
      label = '运行正常';
      break;
    case 'loading':
      label = '加载中';
      break;
    case 'needs_verification':
      el.statusDot.classList.add('warn');
      label = '需要人工验证';
      showVerifyOverlay();
      break;
    case 'not_logged_in':
      el.statusDot.classList.add('warn');
      label = '未登录';
      showVerifyOverlay();
      break;
    case 'error':
      el.statusDot.classList.add('error');
      label = '出错';
      break;
  }
  el.statusText.textContent = label;
  el.statusMeta.textContent = `更新于 ${formatTime(state.lastUpdatedAt)} · 共 ${state.itemCount ?? 0} 件`;

  if (state.status === 'ok' || state.status === 'loading') {
    hideVerifyOverlay();
  }
}

function cardTemplate(item) {
  const price = Number(item.price).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return `
    <div class="item-card">
      <img class="thumb" src="${item.icon || ''}" alt="${item.typeName}" loading="lazy" onerror="this.style.opacity=0" />
      <div class="flex items-center justify-between">
        <span class="tag">${item.category}</span>
        <span class="text-xs text-ink-500">${item.serverName || ''}</span>
      </div>
      <div>
        <p class="text-sm font-medium text-ink-100">${item.typeName}</p>
        <p class="text-xs text-ink-400 mt-0.5">${item.typeDesc || ''}</p>
      </div>
      <div class="flex items-center justify-between mt-auto">
        <span class="price">¥${price}</span>
      </div>
      <a class="view-link" href="${item.orderConfirmUrl}" target="_blank" rel="noopener">查看详情</a>
    </div>
  `;
}

function renderItems() {
  const filtered = currentFilter === 'all' ? allItems : allItems.filter((i) => i.category === currentFilter);

  if (filtered.length === 0) {
    el.grid.innerHTML = '';
    el.empty.classList.remove('hidden');
    return;
  }
  el.empty.classList.add('hidden');
  el.grid.style.opacity = 0;
  el.grid.innerHTML = filtered.map(cardTemplate).join('');
  requestAnimationFrame(() => {
    el.grid.style.transition = 'opacity 0.25s ease';
    el.grid.style.opacity = 1;
  });
}

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const state = await res.json();
    renderStatus(state);
    el.loading.classList.toggle('hidden', state.status !== 'loading');
  } catch {
    el.statusText.textContent = '连接失败';
  }
}

async function pollItems() {
  try {
    const res = await fetch('/api/items');
    const items = await res.json();
    if (items.length > 0) {
      allItems = items;
      renderItems();
    }
  } catch {
    // 忽略单次失败，等下一轮
  }
}

function showVerifyOverlay() {
  el.overlay.classList.remove('hidden');
}
function hideVerifyOverlay() {
  el.overlay.classList.add('hidden');
  el.verifyBtn.disabled = false;
  el.verifyBtn.textContent = '打开验证窗口';
  el.verifyHint.classList.add('hidden');
  if (verifyPollTimer) {
    clearInterval(verifyPollTimer);
    verifyPollTimer = null;
  }
}

async function startVerifyFlow() {
  el.verifyBtn.disabled = true;
  el.verifyBtn.textContent = '验证窗口已打开...';
  el.verifyHint.classList.remove('hidden');

  await fetch('/api/verify/start', { method: 'POST' }).catch(() => {});

  verifyPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/verify/status');
      const v = await res.json();
      if (v.status === 'success') {
        hideVerifyOverlay();
        pollStatus();
        pollItems();
      } else if (v.status === 'timeout' || v.status === 'error') {
        el.verifyHint.textContent = v.status === 'timeout' ? '等待超时，请重试' : `出错: ${v.error || ''}`;
        el.verifyBtn.disabled = false;
        el.verifyBtn.textContent = '重新打开验证窗口';
      }
    } catch {
      // 忽略单次失败
    }
  }, VERIFY_POLL_MS);
}

el.verifyBtn.addEventListener('click', startVerifyFlow);

el.nav.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  currentFilter = btn.dataset.filter;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('nav-item-active'));
  btn.classList.add('nav-item-active');
  document.getElementById('page-title').textContent =
    currentFilter === 'all' ? '全部在售商品' : currentFilter;
  renderItems();
});

pollStatus();
pollItems();
setInterval(pollStatus, STATUS_POLL_MS);
setInterval(pollItems, STATUS_POLL_MS);
