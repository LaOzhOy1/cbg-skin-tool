// 定时轮询：纯 HTTP 调用 cbgClient，不启动浏览器。命中风控/未登录时把状态切换为
// needs_verification / not_logged_in 并暂停轮询，同时自动打开人工验证窗口（除非已经开着），
// 人工完成后自动恢复轮询。网页按钮 / `cbg-skin verify` 仍然可用，用于自动弹窗失败后手动重试。
import { fetchAllSkins, CaptchaRequiredError, NotLoggedInError } from './cbgClient.js';
import { mergeItems, setStatus, setNextPollAt } from './state.js';
import { runLoginFlow, isLoginFlowRunning } from './loginFlow.js';
import { recordSeenTypes, pruneExpired } from './itemTypeCache.js';
import { recordPriceHistory } from './priceHistory.js';
import { summarizeRisk, formatRiskBlock, RiskBlockedError } from './riskGuard.js';

const BASE_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 20000;
const JITTER_RATIO = 0.2; // ±20% 随机抖动，避免整点式请求

// 分片轮询：把个体商品(recommend.py，请求量大头)按种类分成 SHARD_COUNT 片，每轮只深挖
// 一片，轮流切换。种类列表(min_price/最低价)仍每轮全量拉，所以"实时最低价"不受影响，
// 只有个体挂单快照按 SHARD_COUNT 轮补齐一次。默认 4 片 → 单轮 recommend.py 请求量砍到 ~1/4。
const SHARD_COUNT = Math.max(1, Number(process.env.POLL_SHARD_COUNT) || 4);
let shardCursor = 0;

// 每次 recommend.py 请求前的随机停顿区间(ms)。把"背靠背连打"摊平成"像人在翻页"，
// 是降低"被判定为脚本"风险最有效的一招。设 [0,0] 关闭（测试里用）。
const REQUEST_DELAY_MS = [
  Number(process.env.POLL_REQUEST_DELAY_MIN_MS) || 200,
  Number(process.env.POLL_REQUEST_DELAY_MAX_MS) || 800,
];

// 连续报错熔断：同一错误连续出现还继续每 ~20 秒重试，本身就是在消耗账号的风控信任分
// （2026-08-17 事故：接口持续返回 ERR 系统繁忙，poller 自动重试十几分钟无人制止，
// 详见 CLAUDE.md 铁律）。连续失败达到上限后自动暂停，只能由人工排查后重启服务或
// 走一次人工验证（/api/verify/start 成功会调 resumePolling）来恢复。
const MAX_CONSECUTIVE_ERRORS = 3;
let consecutiveErrors = 0;

function nextDelay() {
  const jitter = BASE_INTERVAL_MS * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(5000, BASE_INTERVAL_MS + jitter);
}

let timer = null;
let paused = false;

async function tick() {
  if (paused) return;
  const preflight = summarizeRisk({ operation: 'poller.tick', profile: 'poller' });
  if (!preflight.allow) {
    setStatus('error', formatRiskBlock(preflight));
    pause();
    return;
  }

  try {
    const shardIndex = shardCursor % SHARD_COUNT;
    const { items, seenTypes, refreshedTypes, allTypes } = await fetchAllSkins({
      shardCount: SHARD_COUNT,
      shardIndex,
      delayMs: REQUEST_DELAY_MS,
    });
    shardCursor = (shardCursor + 1) % SHARD_COUNT;
    consecutiveErrors = 0;
    // 合并本轮分片到快照：只覆盖本轮深挖的种类，其余种类沿用上一轮（正常延迟），
    // 已下架的种类从快照剔除。shardCount=1 时等价于全量替换。
    mergeItems(items, refreshedTypes, allTypes);
    // 种类图片缓存：种类数据本来就在这轮请求里飞过，这里只是不再丢弃；
    // 下载图片是唯一新增的网络调用，且只在本地还没有缓存图时才下载一次。
    // 失败不影响主轮询流程——recordSeenTypes()/pruneExpired() 内部已经吞掉了
    // 单个种类下载失败的异常，这里额外兜底防止意外抛出打断轮询。
    await recordSeenTypes(seenTypes).catch(() => {});
    pruneExpired();
    // 历史最低价时序：seenTypes 里的 minPrice 本来就在这轮请求里飞过，这里只是不再
    // 丢弃，按小时桶追加落地，供 market-v2 画趋势曲线。零额外网络请求。
    // 用 try/catch 兜底，历史记录失败不该打断主轮询。
    try {
      recordPriceHistory(seenTypes);
    } catch (e) {
      console.error('[poller] 记录历史最低价失败（不影响轮询）:', e.message || e);
    }
  } catch (err) {
    if (err instanceof RiskBlockedError) {
      setStatus('error', err);
      pause();
      return;
    }
    if (err instanceof CaptchaRequiredError) {
      setStatus('needs_verification', err);
      pause();
      triggerAutoVerify();
      return;
    }
    if (err instanceof NotLoggedInError) {
      setStatus('not_logged_in', err);
      pause();
      triggerAutoVerify();
      return;
    }
    consecutiveErrors += 1;
    setStatus('error', err);
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(
        `[poller] 连续 ${consecutiveErrors} 次轮询失败（最近一次：${err.message || err}），` +
          '已自动暂停，不再继续向藏宝阁发请求。排查原因后重启服务，或走一次人工验证恢复。'
      );
      pause();
      return;
    }
  }
  scheduleNext();
}

/** 命中风控/未登录时自动弹出人工验证窗口，成功后自动恢复轮询。已经开着窗口时不重复打开。 */
function triggerAutoVerify() {
  if (isLoginFlowRunning()) return;
  runLoginFlow()
    .then((ok) => {
      if (ok && paused) resumePolling();
    })
    .catch(() => {
      // 错误已经记录在 verify state 里，用户可以在网页上点按钮或用 `cbg-skin verify` 重试
    });
}

function scheduleNext() {
  const delay = nextDelay();
  setNextPollAt(new Date(Date.now() + delay));
  timer = setTimeout(tick, delay);
}

function pause() {
  paused = true;
  setNextPollAt(null);
  if (timer) clearTimeout(timer);
}

/** 验证流程走完之后调用，恢复轮询（立即跑一轮，而不是等下一个周期）。*/
export function resumePolling() {
  paused = false;
  // 人工验证/重启意味着"已经排查过、明确要恢复"，连续报错计数一并清零，
  // 否则熔断暂停后即便恢复了也会因为旧计数很快再次暂停。
  consecutiveErrors = 0;
  if (timer) clearTimeout(timer);
  tick();
}

export function startPolling() {
  tick();
}

/** 供 /api/verify/status 之类的接口判断当前是否处于暂停态。 */
export function isPaused() {
  return paused;
}
