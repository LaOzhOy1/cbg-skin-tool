// 从 Playwright 保存的 storageState.json 里读取 Cookie，拼成纯 HTTP 请求可用的 Cookie 头。
// 轮询阶段完全不启动浏览器——这里只是复用登录/验证流程写下来的 Cookie 文件。
import fs from 'fs';
import { STORAGE_STATE_PATH } from '../src/session.js';

const TARGET_HOST = 'yjwujian.cbg.163.com';

function domainMatches(cookieDomain, host) {
  const d = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  return host === d || host.endsWith(`.${d}`);
}

let cached = null;

/**
 * 读取（或重新读取）storageState.json，返回 { cookieHeader, hasSession }。
 * hasSession 为 false 表示文件不存在，调用方应提示先登录。
 */
export function loadCookies() {
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    cached = { cookieHeader: '', hasSession: false };
    return cached;
  }
  const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf-8'));
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
