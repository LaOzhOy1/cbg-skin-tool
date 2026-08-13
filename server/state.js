// 进程内内存态：最新商品快照 + 轮询状态（单例，代表"当前活跃账号"的状态，
// 见 server/admin/accounts.js 的 switchActiveAccount() 如何重置它）+ 验证流程状态。
// 单进程单实例，不需要数据库。

const state = {
  status: 'loading', // loading | ok | needs_verification | not_logged_in | error
  items: [],
  lastUpdatedAt: null,
  lastError: null,
  nextPollAt: null,
};

// 验证流程状态按账号 id 分开存——账号管理允许对"非当前活跃账号"单独打开验证窗口，
// 这个动作不该覆盖或打断当前活跃账号自己的验证状态。key 是 accountId。
const verifyByAccount = new Map();

function defaultVerifyState() {
  return { status: 'idle', startedAt: null, error: null }; // idle | running | success | timeout | error
}

export function getState() {
  return { ...state, itemCount: state.items.length };
}

export function getItems() {
  return state.items;
}

export function setItems(items) {
  state.items = items;
  state.status = 'ok';
  state.lastUpdatedAt = new Date().toISOString();
  state.lastError = null;
}

export function setStatus(status, error = null) {
  state.status = status;
  state.lastError = error ? String(error.message || error) : null;
}

export function setNextPollAt(date) {
  state.nextPollAt = date ? date.toISOString() : null;
}

export function getVerifyState(accountId) {
  return { ...(verifyByAccount.get(accountId) || defaultVerifyState()) };
}

export function setVerifyState(accountId, status, error = null) {
  const current = verifyByAccount.get(accountId) || defaultVerifyState();
  current.status = status;
  current.error = error ? String(error.message || error) : null;
  if (status === 'running') current.startedAt = new Date().toISOString();
  verifyByAccount.set(accountId, current);
}
