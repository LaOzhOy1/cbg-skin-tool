import { chromium } from 'playwright';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 历史遗留的固定登录态路径。账号管理上线后，"默认账号"（自动迁移出的第一个账号）
// 的 storageStatePath 字段直接指向这个文件——不移动它，这样 bin/cbg-skin.js、
// tools/watchBrowser.js、src/login.js 这些不感知账号概念的旧脚本继续按原样工作。
export const STORAGE_STATE_PATH = path.join(__dirname, '..', 'storageState.json');
export const SITE_URL = 'https://yjwujian.cbg.163.com/cgi/mweb/';

/** 新建账号（非默认账号）时用来生成各自独立的登录态文件路径。 */
export function accountStorageStatePath(accountId) {
  return path.join(__dirname, '..', 'data', 'accounts', `${accountId}.storageState.json`);
}

export function hasSavedSession() {
  return existsSync(STORAGE_STATE_PATH);
}

/**
 * 创建一个带已保存登录态的浏览器 context。
 * 若没有登录态文件，提示先运行 login.js。
 */
export async function createSessionContext({ headless = true } = {}) {
  if (!hasSavedSession()) {
    throw new Error(
      '未找到登录态文件 storageState.json，请先运行: npm run login'
    );
  }
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    viewport: { width: 1280, height: 900 },
  });
  return { browser, context };
}

/**
 * 检查当前 context 是否仍处于登录态。
 * 藏宝阁未登录时页面顶部会显示"未登录"文字链接，登录后该处会替换为用户昵称。
 * 实测确认：未登录状态下页面文本中能精确匹配到"未登录"。
 *
 * 注意：locator.isVisible() 不会等待元素出现，是立即返回当前状态的同步检查——
 * 在 SPA 刚导航、内容还没渲染出来时会直接判"不可见"，从而误判为"已登录"。
 * 这里必须用 waitFor() 真正等待元素出现或等待超时。
 */
export async function isLoggedIn(page) {
  const notLoggedInMark = page.getByText('未登录', { exact: true }).first();
  try {
    await notLoggedInMark.waitFor({ state: 'visible', timeout: 8000 });
    return false;
  } catch {
    return true;
  }
}
