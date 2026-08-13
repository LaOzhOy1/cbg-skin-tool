// 从 Playwright 保存的 storageState.json 里读取 Cookie，拼成纯 HTTP 请求可用的 Cookie 头。
// 轮询阶段完全不启动浏览器——这里只是复用登录/验证流程写下来的 Cookie 文件。
//
// 账号管理上线后，这里读的不再是一个固定文件，而是"当前活跃账号"自己的 storageStatePath。
// 故意不在这里 import server/admin/accounts.js 反查活跃账号——那样会和 accounts.js
// 反过来调用本文件 reload() 形成循环依赖。改成 accounts.js 在切换/初始化活跃账号时
// 主动调用 setStorageStatePath() 告诉这里"现在该读哪个文件"，职责更清晰：cookieJar.js
// 只管"读当前指定的这份 cookie"，不管"当前活跃账号是谁"。
import fs from 'fs';
import { STORAGE_STATE_PATH } from '../src/session.js';

const TARGET_HOST = 'yjwujian.cbg.163.com';

function domainMatches(cookieDomain, host) {
  const d = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  return host === d || host.endsWith(`.${d}`);
}

// 默认指向历史遗留的固定文件，和账号管理上线前的行为保持一致，不需要谁在启动时
// 显式调用 setStorageStatePath 才能工作。
let currentStorageStatePath = STORAGE_STATE_PATH;
let cached = null;

/** 账号切换/账号验证成功后调用，告诉 cookieJar 接下来应该读哪个账号的登录态文件。 */
export function setStorageStatePath(path) {
  currentStorageStatePath = path;
}

/**
 * 读取（或重新读取）当前账号的 storageState.json，返回 { cookieHeader, hasSession }。
 * hasSession 为 false 表示还没有登录态，调用方应提示先登录/验证。
 */
export function loadCookies() {
  if (!currentStorageStatePath || !fs.existsSync(currentStorageStatePath)) {
    cached = { cookieHeader: '', hasSession: false };
    return cached;
  }
  const state = JSON.parse(fs.readFileSync(currentStorageStatePath, 'utf-8'));
  const cookies = (state.cookies || []).filter((c) => domainMatches(c.domain, TARGET_HOST));
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  cached = { cookieHeader, hasSession: cookies.length > 0 };
  return cached;
}

/** 返回当前缓存的 Cookie 头，若还没加载过则先加载一次。 */
export function getCookieHeader() {
  if (!cached) loadCookies();
  return cached.cookieHeader;
}

/** 登录/验证流程更新了 storageState.json 之后调用，强制重新读取。 */
export function reload() {
  return loadCookies();
}
