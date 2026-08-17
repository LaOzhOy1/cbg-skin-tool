let currentId = null;
let verifyPollTimer = null;

const el = {
  createForm: document.getElementById('create-form'),
  name: document.getElementById('field-name'),
  createError: document.getElementById('create-error'),
  list: document.getElementById('account-list'),
  emptyDetail: document.getElementById('empty-detail'),
  detail: document.getElementById('detail'),
  detailName: document.getElementById('detail-name'),
  activeBadge: document.getElementById('detail-active-badge'),
  loginBadge: document.getElementById('detail-login-badge'),
  activateBtn: document.getElementById('activate-btn'),
  verifyBtn: document.getElementById('verify-btn'),
  verifyHint: document.getElementById('verify-hint'),
  deleteBtn: document.getElementById('delete-btn'),
  refreshProfileBtn: document.getElementById('refresh-profile-btn'),
  profileEmpty: document.getElementById('profile-empty'),
  profileDetail: document.getElementById('profile-detail'),
  profilePhone: document.getElementById('profile-phone'),
  profileMobileBind: document.getElementById('profile-mobile-bind'),
  profileUrs: document.getElementById('profile-urs'),
  profileUpdatedAt: document.getElementById('profile-updated-at'),
  profileError: document.getElementById('profile-error'),
  roleForm: document.getElementById('role-form'),
  roleId: document.getElementById('field-role-id'),
  serverId: document.getElementById('field-server-id'),
  roleSavedHint: document.getElementById('role-saved-hint'),
};

async function api(path, options) {
  const res = await fetch(`/api/admin/accounts${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadList() {
  const accounts = await api('/');
  el.list.innerHTML = accounts
    .map(
      (a) => `
        <button class="sweep-item ${a.id === currentId ? 'active-item' : ''}" data-id="${a.id}">
          <span class="title">${escapeHtml(a.name)}</span>
          <span class="admin-badge ${a.isActive ? 'ok' : ''}">${a.isActive ? '活跃' : '未激活'}</span>
        </button>`
    )
    .join('');
  return accounts;
}

function renderDetail(account) {
  el.emptyDetail.classList.add('hidden');
  el.detail.classList.remove('hidden');

  el.detailName.textContent = account.name;
  el.activeBadge.classList.toggle('hidden', !account.isActive);
  el.loginBadge.className = `admin-badge ${account.hasLogin ? 'ok' : 'warn'}`;
  el.loginBadge.textContent = account.hasLogin ? '已登录' : '未登录';

  el.activateBtn.classList.toggle('hidden', account.isActive);
  el.deleteBtn.classList.toggle('hidden', account.isActive);

  el.refreshProfileBtn.classList.toggle('hidden', !account.isActive);
  el.profileError.classList.add('hidden');
  if (account.profile) {
    el.profileEmpty.classList.add('hidden');
    el.profileDetail.classList.remove('hidden');
    el.profilePhone.textContent = account.profile.displayName || '未知';
    el.profileMobileBind.textContent = account.profile.mobileBindStatus ? '已绑定' : '未绑定';
    el.profileUrs.textContent = account.profile.ursInternalId || '未知';
    el.profileUpdatedAt.textContent = account.profile.fetchedAt
      ? new Date(account.profile.fetchedAt).toLocaleString()
      : '未知';
  } else {
    el.profileEmpty.classList.remove('hidden');
    el.profileDetail.classList.add('hidden');
  }

  el.roleId.value = account.buyerRoleId || '';
  el.serverId.value = account.buyerServerId || '';
  el.roleSavedHint.classList.add('hidden');
}

async function selectAccount(id) {
  currentId = id;
  stopVerifyPoll();
  await refreshCurrent();
  await loadList();
}

async function refreshCurrent() {
  if (!currentId) return;
  try {
    const account = await api(`/${currentId}`);
    renderDetail(account);
  } catch {
    // 账号可能被删除或暂时不可达，忽略单次失败
  }
}

el.list.addEventListener('click', (e) => {
  const btn = e.target.closest('.sweep-item');
  if (!btn) return;
  selectAccount(btn.dataset.id);
});

el.createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.createError.classList.add('hidden');
  const name = el.name.value.trim();
  if (!name) return;
  try {
    const account = await api('/', { method: 'POST', body: JSON.stringify({ name }) });
    el.createForm.reset();
    await loadList();
    selectAccount(account.id);
  } catch (err) {
    el.createError.textContent = err.message;
    el.createError.classList.remove('hidden');
  }
});

el.activateBtn.addEventListener('click', async () => {
  if (!currentId) return;
  el.activateBtn.disabled = true;
  try {
    await api(`/${currentId}/activate`, { method: 'POST' });
    await refreshCurrent();
    await loadList();
  } catch (err) {
    alert(`切换失败: ${err.message}`);
  } finally {
    el.activateBtn.disabled = false;
  }
});

el.deleteBtn.addEventListener('click', async () => {
  if (!currentId) return;
  if (!confirm('确定要删除这个账号吗？这不会删除藏宝阁上的真实账号，只是移除本地记录和登录态文件的关联。')) return;
  try {
    await api(`/${currentId}`, { method: 'DELETE' });
    currentId = null;
    el.detail.classList.add('hidden');
    el.emptyDetail.classList.remove('hidden');
    await loadList();
  } catch (err) {
    alert(`删除失败: ${err.message}`);
  }
});

el.roleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentId) return;
  try {
    await api(`/${currentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ buyerRoleId: el.roleId.value.trim(), buyerServerId: el.serverId.value.trim() }),
    });
    el.roleSavedHint.classList.remove('hidden');
  } catch (err) {
    alert(`保存失败: ${err.message}`);
  }
});

el.refreshProfileBtn.addEventListener('click', async () => {
  if (!currentId) return;
  el.profileError.classList.add('hidden');
  el.refreshProfileBtn.disabled = true;
  el.refreshProfileBtn.textContent = '刷新中...';
  try {
    await api(`/${currentId}/refresh-profile`, { method: 'POST' });
    await refreshCurrent();
  } catch (err) {
    el.profileError.textContent = `刷新失败: ${err.message}`;
    el.profileError.classList.remove('hidden');
  } finally {
    el.refreshProfileBtn.disabled = false;
    el.refreshProfileBtn.textContent = '刷新账号信息';
  }
});

function stopVerifyPoll() {
  if (verifyPollTimer) {
    clearInterval(verifyPollTimer);
    verifyPollTimer = null;
  }
  el.verifyBtn.disabled = false;
  el.verifyBtn.textContent = '打开验证窗口';
  el.verifyHint.classList.add('hidden');
}

el.verifyBtn.addEventListener('click', async () => {
  if (!currentId) return;
  const accountId = currentId;
  el.verifyBtn.disabled = true;
  el.verifyBtn.textContent = '验证窗口已打开...';
  el.verifyHint.classList.remove('hidden');
  el.verifyHint.textContent = '等待人工完成验证...';

  const started = await api(`/${accountId}/verify/start`, { method: 'POST' }).catch((err) => ({ error: err.message }));
  if (started?.error) {
    el.verifyHint.textContent = started.error;
    el.verifyBtn.disabled = false;
    el.verifyBtn.textContent = '打开验证窗口';
    return;
  }

  verifyPollTimer = setInterval(async () => {
    try {
      const v = await api(`/${accountId}/verify/status`);
      if (v.status === 'success') {
        stopVerifyPoll();
        if (currentId === accountId) await refreshCurrent();
      } else if (v.status === 'timeout' || v.status === 'error') {
        el.verifyHint.textContent = v.status === 'timeout' ? '等待超时，请重试' : `出错: ${v.error || ''}`;
        el.verifyBtn.disabled = false;
        el.verifyBtn.textContent = '重新打开验证窗口';
      }
    } catch {
      // 忽略单次失败
    }
  }, 3000);
});

async function pollLoop() {
  await loadList().catch(() => {});
  await refreshCurrent();
}

loadList();
setInterval(pollLoop, 5000);
