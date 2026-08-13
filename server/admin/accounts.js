// 账号管理：单活跃账号模型——同一时刻只有一个账号在轮询/可执行任务，不做并发多账号
// （这个账号已经因为自动化行为模式被风控升级过，并发多账号会放大这个风险，见 CLAUDE.md）。
//
// 现有的 cookieJar.js/state.js/poller.js 仍然是进程级单例，代表的就是"当前活跃账号"的状态。
// 这个模块负责：账号 CRUD、谁是当前活跃账号、切换活跃账号时把这些单例重置干净。
import { list, get, insert, update, remove } from './store.js';
import { STORAGE_STATE_PATH, accountStorageStatePath } from '../../src/session.js';
import { reload as reloadCookies, setStorageStatePath } from '../cookieJar.js';
import { setItems, setStatus } from '../state.js';
import { fetchUserProfile } from '../cbgClient.js';

/**
 * 首次启动时如果 accounts 集合是空的，自动创建一条指向现有 storageState.json 的账号记录
 * 并标记为活跃——不移动任何文件，现有用户不需要做任何手动迁移，行为和账号管理上线前完全一样。
 * 无论是不是首次创建，都会把 cookieJar 指向当前活跃账号的登录态文件——这样重启进程后
 * cookieJar 读的始终是"当前真正活跃"的那个账号，不依赖它启动时的默认值。
 */
export function ensureDefaultAccount() {
  const accounts = list('accounts');
  if (accounts.length === 0) {
    insert('accounts', {
      name: '默认账号',
      storageStatePath: STORAGE_STATE_PATH,
      buyerRoleId: process.env.SWEEP_BUYER_ROLE_ID || null,
      buyerServerId: process.env.SWEEP_BUYER_SERVER_ID || null,
      isActive: true,
    });
  }
  const active = getActiveAccount();
  if (active?.storageStatePath) setStorageStatePath(active.storageStatePath);
}

export function listAccounts() {
  return list('accounts');
}

export function getAccount(id) {
  return get('accounts', id);
}

export function getActiveAccount() {
  return list('accounts').find((a) => a.isActive) || null;
}

export function createAccount(input) {
  const account = insert('accounts', {
    name: input.name,
    storageStatePath: null, // 新账号还没有登录态，需要之后单独触发一次验证
    buyerRoleId: input.buyerRoleId || null,
    buyerServerId: input.buyerServerId || null,
    isActive: false,
  });
  // storageStatePath 依赖刚生成的 id，创建后再补一次。
  return update('accounts', account.id, { storageStatePath: accountStorageStatePath(account.id) });
}

export function updateAccount(id, patch) {
  const allowed = {};
  if (patch.name !== undefined) allowed.name = patch.name;
  if (patch.buyerRoleId !== undefined) allowed.buyerRoleId = patch.buyerRoleId || null;
  if (patch.buyerServerId !== undefined) allowed.buyerServerId = patch.buyerServerId || null;
  return update('accounts', id, allowed);
}

/**
 * 切换活跃账号：清空 state.js 的商品快照，重新指向新账号的 storageState 并 reload cookie。
 * 下一轮定时轮询 tick 会用新账号的 cookie 重新请求，如果新账号未登录会自然触发验证
 * 流程，不需要在这里手动触发——沿用现有 poller.js 的自动验证机制。
 *
 * 已知的小竞态：不会强制中断"切换那一刻正好在飞行中"的旧账号 fetchAllSkins() 请求——
 * 故意不在这里 import poller.js 去暂停它，因为 poller.js 已经依赖 loginFlow.js 依赖
 * accounts.js，反向引入会形成模块循环依赖。影响范围很小：最坏情况下切换瞬间会有一次
 * 旧账号数据的短暂闪现，下一轮定时 tick 就会用新账号数据纠正过来；扫货任务的账号隔离
 * 不受影响，因为 sweepEngine.js 是按 task.accountId 精确匹配跳过，不依赖这份商品快照
 * 在切换瞬间是否绝对正确。
 */
export function switchActiveAccount(id) {
  const target = get('accounts', id);
  if (!target) throw new Error('账号不存在');
  const current = getActiveAccount();
  if (current?.id === id) return target;

  for (const account of list('accounts')) {
    if (account.isActive) update('accounts', account.id, { isActive: false });
  }
  const activated = update('accounts', id, { isActive: true });

  setItems([]);
  setStatus('loading');
  setStorageStatePath(activated.storageStatePath);
  reloadCookies();

  return activated;
}

/**
 * 拉取并保存账号信息（手机号/网易通行证标识/手机绑定状态），只能对当前活跃账号调用——
 * cbgClient.js 的请求头 Cookie 来自 cookieJar.js 的"当前活跃账号"单例，对非活跃账号
 * 调用会用错 Cookie，读到活跃账号自己的信息却误存到别的账号记录上。只在用户主动点击
 * "刷新账号信息"时调用一次，不做自动/周期性拉取。
 */
export async function refreshAccountProfile(id) {
  const account = get('accounts', id);
  if (!account) throw new Error('账号不存在');
  if (!account.isActive) {
    throw new Error('只能刷新当前活跃账号的信息，请先切换到该账号');
  }
  const profile = await fetchUserProfile();
  // 时间戳存在 profile 对象内部，而不是复用 account.updatedAt——updatedAt 会被
  // 保存买家角色等无关操作一起刷新，不能准确反映"账号信息是什么时候拉取的"。
  return update('accounts', id, { profile: { ...profile, fetchedAt: new Date().toISOString() } });
}

export function deleteAccount(id) {
  const account = get('accounts', id);
  if (!account) throw new Error('账号不存在');
  if (account.isActive) {
    throw new Error('不能删除当前活跃账号，请先切换到其他账号');
  }
  remove('accounts', id);
}
