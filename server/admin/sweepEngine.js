// 扫货任务的定时监控循环，风格与 server/poller.js 一致：setInterval 定时 tick，
// 不并发发起一堆请求。
//
// 扫货任务的生命周期和"AI 需求"完全不同（跨天持续监控、多次触发下单），所以这里单独
// 一份状态机，不合并进 stateMachine.js——业务语义不同，硬合并只会让两边都难懂。
import { list, get, update, insert } from './store.js';
import { getState, getItems } from '../state.js';
import { fetchEquipDetail, fetchEquipTypes, normalizeItem, searchItemsWithVariationFilter } from '../cbgClient.js';
import { CATEGORIES } from '../../src/config.js';
import { placeOrder, checkPaymentResult, BuyerRoleNotConfiguredError } from '../sweepClient.js';
import { getActiveAccount } from './accounts.js';

const TICK_INTERVAL_MS = 30_000;

const TRANSITIONS = {
  draft: ['active'],
  active: ['pending_payment', 'completed', 'expired', 'cancelled', 'failed'],
  pending_payment: ['active', 'completed', 'expired', 'cancelled', 'failed'],
  completed: [],
  expired: [],
  cancelled: [],
  failed: [],
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`扫货任务非法状态迁移: ${from} -> ${to}`);
  }
  return to;
}

const NON_TERMINAL_STATUSES = ['active', 'pending_payment'];

function nowIso() {
  return new Date().toISOString();
}

function addHistory(taskId, event, detail) {
  const task = get('sweepTasks', taskId);
  const history = [...(task.history || []), { at: nowIso(), event, detail }];
  return update('sweepTasks', taskId, { history });
}

/** 归一化分类口径，和 admin/capabilities.js 里的 normalizeCategory 保持一致的映射关系。 */
function categoryLabel(targetCategory) {
  return targetCategory === 'weapon' ? '兵器皮肤' : '英雄皮肤';
}

/**
 * 在已有商品缓存里找符合条件的商品：分类+名称精确匹配，价格不超过上限，取价格最低的一个。
 * 只用于没有配置星格筛选的任务——命中零网络请求的原则，完全依赖 poller.js 的轮询缓存。
 *
 * 注意：列表接口（recommend.py，也就是 getItems() 的数据来源）不带公示期相关字段，
 * 所以这里选出来的候选商品是否真的可购买还没有确认——公示期判断必须用 fetchEquipDetail()
 * 查最新详情二次确认，见 tryPlaceOrder()。之前尝试过用 fair_show_end_time 时间戳推断，
 * 已经被抓包证实是错的（时间戳已过去但商品依然不可购买），所以这里不再做任何公示期相关过滤。
 */
export function findMatchingItem(items, task) {
  const label = categoryLabel(task.targetCategory);
  const candidates = items.filter(
    (item) => item.category === label && item.typeName === task.targetItemName && item.price <= task.priceCeiling
  );
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => a.price - b.price)[0];
}

function categoryConfig(targetCategory) {
  return CATEGORIES.find((c) => c.label === categoryLabel(targetCategory));
}

/**
 * 星格/变异筛选任务专用的匹配路径：不用轮询缓存，每次都实时向藏宝阁发一次带筛选参数的
 * 请求（searchItemsWithVariationFilter），让藏宝阁自己按星格条件过滤。
 * 只有配置了 variationFilter 的任务才走这条路径，会产生真实网络请求——这是有意的取舍，
 * 换来的是星格这种本地缓存里没有的信息也能被正确筛选。
 */
async function findMatchingItemViaVariationFilter(task) {
  const category = categoryConfig(task.targetCategory);
  if (!category) return null;

  const types = await fetchEquipTypes(category);
  const typeInfo = types.find((t) => t.equip_type_name === task.targetItemName);
  if (!typeInfo) return null;

  const rawItems = await searchItemsWithVariationFilter(category, typeInfo.equip_type, task.variationFilter);
  const items = rawItems.map((item) => normalizeItem(item, category, typeInfo));
  const candidates = items.filter((item) => item.price <= task.priceCeiling);
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => a.price - b.price)[0];
}

export function isExpired(task, at = new Date()) {
  return new Date(task.deadlineAt).getTime() <= at.getTime();
}

async function tryPlaceOrder(task, item, account) {
  try {
    // 下单前用最新详情二次确认公示期状态——列表缓存里没有这个信息，价格也可能已经变化，
    // 不能只信轮询缓存的旧数据就直接下单。
    const detail = await fetchEquipDetail(item);
    if (!detail.allowFairShowBuy) {
      addHistory(
        task.id,
        'fair_show_blocked',
        `检测到匹配商品 ${item.typeName}（¥${item.price}），但仍处于公示期不可购买，本轮跳过`
      );
      return;
    }
  } catch (err) {
    addHistory(task.id, 'order_error', `下单前查询商品详情出错：${err.message || err}`);
    return;
  }

  try {
    const order = await placeOrder(item, account);
    update('sweepTasks', task.id, {
      status: assertTransition(task.status, 'pending_payment'),
      pendingOrder: {
        equipId: item.equipId,
        serverId: item.serverId,
        gameOrdersn: item.gameOrdersn,
        price: item.price,
        orderConfirmUrl: item.orderConfirmUrl,
        placedAt: nowIso(),
        orderIdToEpay: order.orderIdToEpay,
      },
    });
    addHistory(task.id, 'order_placed', `已下单：${item.typeName}，¥${item.price}（订单号 ${order.orderIdToEpay}）`);
  } catch (err) {
    if (err instanceof BuyerRoleNotConfiguredError) {
      addHistory(task.id, 'order_role_missing', `检测到匹配商品 ${item.typeName}（¥${item.price}），但下单未配置买家角色：${err.message}`);
      return;
    }
    addHistory(task.id, 'order_error', `下单出错：${err.message || err}`);
  }
}

async function checkPendingPayment(task) {
  const { pendingOrder } = task;
  if (!pendingOrder?.orderIdToEpay) return;
  try {
    const { paid } = await checkPaymentResult(pendingOrder.orderIdToEpay);
    if (!paid) return;

    const purchasedCount = (task.purchasedCount || 0) + 1;
    const reachedTarget = purchasedCount >= task.targetQuantity;
    const nextStatus = reachedTarget ? 'completed' : 'active';
    update('sweepTasks', task.id, {
      status: assertTransition(task.status, nextStatus),
      purchasedCount,
      pendingOrder: null,
    });
    addHistory(task.id, 'payment_confirmed', `支付确认成功（¥${pendingOrder.price}），已购 ${purchasedCount}/${task.targetQuantity}`);
  } catch (err) {
    addHistory(task.id, 'payment_check_error', `查询支付状态出错：${err.message || err}`);
  }
}

async function tick() {
  const globalStatus = getState().status;
  if (globalStatus !== 'ok') {
    // 轮询那边已经检测到风控/未登录，扫货引擎不重复触发验证，也不做任何新请求，
    // 完全依赖 poller.js/loginFlow.js 自己恢复。
    return;
  }

  const tasks = list('sweepTasks').filter((t) => NON_TERMINAL_STATUSES.includes(t.status));
  const items = getItems();
  const activeAccount = getActiveAccount();

  for (const task of tasks) {
    const fresh = get('sweepTasks', task.id);
    if (!fresh || !NON_TERMINAL_STATUSES.includes(fresh.status)) continue;

    // 任务绑定的是创建时的账号（见 createSweepTask），只有这个账号是当前活跃账号时
    // 才真的监控/下单——这是"优先选账号再执行"的落地。不匹配时完全跳过（不发任何
    // 请求，也不做到期判断，任务在账号切走期间视为暂停），只在第一次检测到不匹配时
    // 记一条 history，避免每 30 秒刷一条重复日志。
    if (fresh.accountId !== activeAccount?.id) {
      if (!fresh.accountMismatchNotified) {
        update('sweepTasks', fresh.id, { accountMismatchNotified: true });
        addHistory(fresh.id, 'account_inactive', '绑定的账号当前不是活跃账号，暂停监控直到切回该账号');
      }
      continue;
    }
    if (fresh.accountMismatchNotified) {
      update('sweepTasks', fresh.id, { accountMismatchNotified: false });
      addHistory(fresh.id, 'account_active', '绑定的账号已重新变为活跃账号，恢复监控');
    }

    if (isExpired(fresh)) {
      update('sweepTasks', fresh.id, { status: assertTransition(fresh.status, 'expired') });
      addHistory(
        fresh.id,
        'expired',
        fresh.status === 'pending_payment'
          ? '任务已到期，但仍有订单待支付——引擎不会自动取消真实订单，请去「我的订单」自行处理'
          : '任务已到期，未凑够目标数量'
      );
      continue;
    }

    if (fresh.status === 'pending_payment') {
      await checkPendingPayment(fresh);
      continue;
    }

    // status === 'active'
    let item;
    if (fresh.variationFilter) {
      try {
        item = await findMatchingItemViaVariationFilter(fresh);
      } catch (err) {
        addHistory(fresh.id, 'order_error', `星格筛选查询出错：${err.message || err}`);
        continue;
      }
    } else {
      item = findMatchingItem(items, fresh);
    }
    if (item) await tryPlaceOrder(fresh, item, activeAccount);
  }
}

let timer = null;

export function startSweepEngine() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[admin/sweepEngine] tick 出错:', err);
    });
  }, TICK_INTERVAL_MS);
}

export function stopSweepEngine() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * 由用户填的星格筛选表单值组装成 variationFilter，没填任何值时返回 null——
 * null 表示这个任务走零网络请求的缓存匹配路径（findMatchingItem），不是走实时查询。
 */
export function buildVariationFilter(input) {
  const starLevel = input.starLevel ? Number(input.starLevel) : null;
  const slots = [input.slot1, input.slot2, input.slot3, input.slot4].map((v) =>
    v === '' || v === undefined || v === null ? null : Number(v)
  );
  const hasAnyFilter = starLevel !== null || slots.some((v) => v !== null);
  return hasAnyFilter ? { starLevel, slots } : null;
}

/**
 * 创建扫货任务：填模板直接激活，不需要像 AI 需求那样额外走一次确认步骤。
 * 记录创建时的活跃账号 id（不是动态取——账号切换不会让已有任务"跟着换账号"，
 * 只有创建时的那个账号重新变成活跃账号，这个任务才会继续被监控）。
 */
export function createSweepTask(input) {
  const durationDays = Number(input.durationDays);
  const deadlineAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
  const account = getActiveAccount();
  const task = insert('sweepTasks', {
    title: input.title || input.targetItemName,
    status: 'draft',
    accountId: account?.id || null,
    targetCategory: input.targetCategory,
    targetItemName: input.targetItemName,
    priceCeiling: Number(input.priceCeiling),
    targetQuantity: Number(input.targetQuantity),
    purchasedCount: 0,
    deadlineAt,
    pendingOrder: null,
    history: [],
    variationFilter: buildVariationFilter(input),
    accountMismatchNotified: false,
  });
  return update('sweepTasks', task.id, { status: assertTransition('draft', 'active') });
}

export function cancelSweepTask(id) {
  const task = get('sweepTasks', id);
  if (!task) throw new Error('扫货任务不存在');
  update('sweepTasks', id, { status: assertTransition(task.status, 'cancelled') });
  return addHistory(id, 'cancelled', '管理员手动取消');
}
