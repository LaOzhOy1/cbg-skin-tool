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

/**
 * 分片轮询的快照合并：本轮只深挖了 refreshedTypes 这一分片的个体商品，其余种类沿用
 * 上一轮快照里的数据。合并规则：
 *  - refreshedTypes 里的种类：用本轮 freshItems 覆盖（含"变 0 件"——刷新后没有了就该消失）
 *  - allTypes 里但不在本分片：保留上一轮快照里该种类的旧 items（这一轮没刷，属于正常延迟）
 *  - 不在 allTypes 里的种类：已下架，从快照剔除
 * shardCount=1 时 refreshedTypes==allTypes，等价于全量替换，行为和 setItems 一致。
 *
 * @param {object[]} freshItems 本轮深挖到的个体商品（已 normalize，带 equipType 字段）
 * @param {string[]} refreshedTypes 本轮实际深挖的种类 id
 * @param {string[]} allTypes 本轮种类列表里出现的全部种类 id（用于剔除已下架种类）
 */
export function mergeItems(freshItems, refreshedTypes, allTypes) {
  const refreshed = new Set(refreshedTypes.map(String));
  const alive = new Set(allTypes.map(String));
  // 保留：种类仍在售(alive) 且 本轮没刷新它(不在 refreshed) 的旧 item
  const kept = state.items.filter((it) => {
    const et = String(it.equipType);
    return alive.has(et) && !refreshed.has(et);
  });
  state.items = kept.concat(freshItems);
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
