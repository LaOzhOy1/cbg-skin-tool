// 进程内内存态：最新商品快照 + 轮询状态 + 验证流程状态。单进程单实例，不需要数据库。

const state = {
  status: 'loading', // loading | ok | needs_verification | not_logged_in | error
  items: [],
  lastUpdatedAt: null,
  lastError: null,
  nextPollAt: null,
};

const verify = {
  status: 'idle', // idle | running | success | timeout | error
  startedAt: null,
  error: null,
};

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

export function getVerifyState() {
  return { ...verify };
}

export function setVerifyState(status, error = null) {
  verify.status = status;
  verify.error = error ? String(error.message || error) : null;
  if (status === 'running') verify.startedAt = new Date().toISOString();
}
