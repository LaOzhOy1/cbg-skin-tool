// 定时轮询：纯 HTTP 调用 cbgClient，不启动浏览器。命中风控/未登录时把状态切换为
// needs_verification / not_logged_in 并暂停轮询，等待 /api/verify/start 走完人工流程后
// 由调用方重新启动。
import { fetchAllSkins, CaptchaRequiredError, NotLoggedInError } from './cbgClient.js';
import { setItems, setStatus, setNextPollAt } from './state.js';

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
  try {
    const items = await fetchAllSkins();
    setItems(items);
  } catch (err) {
    if (err instanceof CaptchaRequiredError) {
      setStatus('needs_verification', err);
      pause();
      return;
    }
    if (err instanceof NotLoggedInError) {
      setStatus('not_logged_in', err);
      pause();
      return;
    }
    setStatus('error', err);
  }
  scheduleNext();
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
