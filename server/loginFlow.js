// 登录 / 人工过验证码 共用的浏览器流程。
//
// 只有这一条路径会启动 Playwright，而且从头到尾都是用户本人在真实、可见的浏览器窗口里
// 操作（登录、扫码、点验证码），脚本只负责“检测到成功后保存登录态并关闭窗口”，不代替
// 用户做任何点击。轮询阶段（cbgClient.js）完全不依赖这个模块。
//
// 注意：isLoggedIn() 只能检测"是否已登录"，不能检测"风控验证码是否已解除"——
// 触发 CAPTCHA_AUTH 时用户往往已经是登录状态（cookie 有效），验证码拦的是具体接口调用。
// 所以这里判定成功的标准是：页面已登录 且 实际探测一次真实列表接口不再返回 CAPTCHA_AUTH。
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { SITE_URL, isLoggedIn } from '../src/session.js';
import { reload as reloadCookies, setStorageStatePath } from './cookieJar.js';
import { setVerifyState } from './state.js';
import { getAccount, getActiveAccount } from './admin/accounts.js';

const WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const PROBE_URL =
  '/cgi/api/get_aggregate_equip_type_list?client_type=h5&count=1&page=1&order_by=selling_time%20DESC&query_onsale=1&kindid=3&exter=direct';

// 只允许同一时刻开一个验证窗口（不管是给哪个账号验证）——账号管理允许对"非当前活跃账号"
// 单独验证，但不需要真的同时开两个浏览器窗口，串行验证已经够用，避免不必要的复杂度。
let runningAccountId = null;

async function probePasses(page) {
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) return false;
  // 修复：page.evaluate(fn, ...args) 的 args 必须作为独立参数跟在函数后面传，
  // 之前这里漏传了 PROBE_URL，导致浏览器里执行的 fetch(undefined) 从来没有真正
  // 探测过目标接口——这很可能是之前"页面看起来已登录但验证一直卡着不过"的真实原因。
  const json = await page
    .evaluate((u) => fetch(u, { credentials: 'include' }).then((r) => r.json()), PROBE_URL)
    .catch(() => null);
  return Boolean(json && json.status_code === 'OK');
}

/**
 * 打开一个可见浏览器窗口，等待用户手动登录/过验证码，成功后把 storageState 保存到
 * 这个账号自己的登录态文件里并关闭窗口。
 *
 * @param {string} [accountId] 要验证的账号 id，缺省时用当前活跃账号——保持这个函数
 *   在没有指定账号时和账号管理上线前的行为完全一样（poller.js 的自动触发就是缺省调用）。
 *   只有验证的账号恰好是当前活跃账号时，才会触发 cookieJar.reload()（让轮询用上新 cookie）；
 *   验证一个非活跃账号不会影响当前活跃账号的轮询状态。
 */
export async function runLoginFlow(accountId) {
  const account = accountId ? getAccount(accountId) : getActiveAccount();
  if (!account) {
    throw new Error('账号不存在，无法启动验证流程');
  }
  if (runningAccountId) {
    throw new Error('已有一个验证窗口在运行，请先完成或关闭它');
  }
  runningAccountId = account.id;
  setVerifyState(account.id, 'running');

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    // 复用已有登录态（如果有）：验证码拦截时账号通常仍是登录状态，直接带着旧 cookie
    // 打开就能看到验证码本身，而不是被要求重新走一遍手机号登录。
    const contextOptions = { viewport: { width: 1280, height: 900 } };
    if (account.storageStatePath && existsSync(account.storageStatePath)) {
      contextOptions.storageState = account.storageStatePath;
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
      setVerifyState(account.id, 'timeout');
      return false;
    }

    // Playwright 不会自动创建 storageState 目标文件的父目录，新账号第一次验证时
    // data/accounts/ 目录还不存在，需要先建好，否则这里会直接抛错。
    mkdirSync(path.dirname(account.storageStatePath), { recursive: true });
    await context.storageState({ path: account.storageStatePath });
    if (getActiveAccount()?.id === account.id) {
      setStorageStatePath(account.storageStatePath);
      reloadCookies();
    }
    setVerifyState(account.id, 'success');
    return true;
  } catch (err) {
    setVerifyState(account.id, 'error', err);
    throw err;
  } finally {
    runningAccountId = null;
    if (browser) await browser.close();
  }
}

export function isLoginFlowRunning() {
  return runningAccountId !== null;
}

export function loginFlowRunningAccountId() {
  return runningAccountId;
}
