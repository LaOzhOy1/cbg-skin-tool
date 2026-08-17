// 定时轮询：纯 HTTP 调用 cbgClient，不启动浏览器。命中风控/未登录时把状态切换为
// needs_verification / not_logged_in 并暂停轮询，同时自动打开人工验证窗口（除非已经开着），
// 人工完成后自动恢复轮询。网页按钮 / `cbg-skin verify` 仍然可用，用于自动弹窗失败后手动重试。
import { fetchAllSkins, CaptchaRequiredError, NotLoggedInError } from './cbgClient.js';
import { setItems, setStatus, setNextPollAt } from './state.js';
import { runLoginFlow, isLoginFlowRunning } from './loginFlow.js';
import { recordSeenTypes, pruneExpired } from './itemTypeCache.js';
import { summarizeRisk, formatRiskBlock, RiskBlockedError } from './riskGuard.js';

const BASE_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 20000;
const JITTER_RATIO = 0.2; // ±20% 随机抖动，避免整点式请求

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
    const { items, seenTypes } = await fetchAllSkins();
    setItems(items);
    // 种类图片缓存：种类数据本来就在这轮请求里飞过，这里只是不再丢弃；
    // 下载图片是唯一新增的网络调用，且只在本地还没有缓存图时才下载一次。
    // 失败不影响主轮询流程——recordSeenTypes()/pruneExpired() 内部已经吞掉了
    // 单个种类下载失败的异常，这里额外兜底防止意外抛出打断轮询。
    await recordSeenTypes(seenTypes).catch(() => {});
    pruneExpired();
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
    setStatus('error', err);
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
