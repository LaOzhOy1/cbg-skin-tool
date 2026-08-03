// 登录 / 人工过验证码 共用的浏览器流程。
//
// 只有这一条路径会启动 Playwright，而且从头到尾都是用户本人在真实、可见的浏览器窗口里
// 操作（登录、扫码、点验证码），脚本只负责“检测到成功后保存登录态并关闭窗口”，不代替
// 用户做任何点击。轮询阶段（cbgClient.js）完全不依赖这个模块。
//
// 注意：isLoggedIn() 只能检测"是否已登录"，不能检测"风控验证码是否已解除"——
// 触发 CAPTCHA_AUTH 时用户往往已经是登录状态（cookie 有效），验证码拦的是具体接口调用。
// 所以这里判定成功的标准是：页面已登录 且 实际探测一次真实列表接口不再返回 CAPTCHA_AUTH。
import { existsSync } from 'fs';
import { chromium } from 'playwright';
import { SITE_URL, STORAGE_STATE_PATH, isLoggedIn } from '../src/session.js';
import { reload as reloadCookies } from './cookieJar.js';
import { setVerifyState } from './state.js';

const WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const PROBE_URL =
  '/cgi/api/get_aggregate_equip_type_list?client_type=h5&count=1&page=1&order_by=selling_time%20DESC&query_onsale=1&kindid=3&exter=direct';

let running = false;

async function probePasses(page) {
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) return false;
  const json = await page
    .evaluate((u) => fetch(u, { credentials: 'include' }).then((r) => r.json()))
    .catch(() => null);
  return Boolean(json && json.status_code === 'OK');
}

/**
 * 打开一个可见浏览器窗口，等待用户手动登录/过验证码，成功后保存 storageState 并关闭。
 * 用一个模块级标志防止同时开出多个窗口。
 */
export async function runLoginFlow() {
  if (running) {
    throw new Error('已有一个验证窗口在运行，请先完成或关闭它');
  }
  running = true;
  setVerifyState('running');

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    // 复用已有登录态（如果有）：验证码拦截时账号通常仍是登录状态，直接带着旧 cookie
    // 打开就能看到验证码本身，而不是被要求重新走一遍手机号登录。
    const contextOptions = { viewport: { width: 1280, height: 900 } };
    if (existsSync(STORAGE_STATE_PATH)) {
      contextOptions.storageState = STORAGE_STATE_PATH;
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });

    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let ok = false;
    while (Date.now() < deadline) {
      ok = await probePasses(page);
      if (ok) break;
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }

    if (!ok) {
      setVerifyState('timeout');
      return false;
    }

    await context.storageState({ path: STORAGE_STATE_PATH });
    reloadCookies();
    setVerifyState('success');
    return true;
  } catch (err) {
    setVerifyState('error', err);
    throw err;
  } finally {
    running = false;
    if (browser) await browser.close();
  }
}

export function isLoginFlowRunning() {
  return running;
}
