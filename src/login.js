import { chromium } from 'playwright';
import { SITE_URL, STORAGE_STATE_PATH, isLoggedIn } from './session.js';

/**
 * 打开一个真实浏览器窗口，让用户手动完成网易通行证登录（扫码/短信/密码，
 * 人机验证均由用户本人操作）。检测到登录成功后保存 storageState 并退出。
 */
async function main() {
  console.log('正在打开浏览器，请在窗口中手动登录你的藏宝阁账号...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });

  console.log('等待检测登录状态（最多等待 5 分钟）...');
  const deadline = Date.now() + 5 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    loggedIn = await isLoggedIn(page);
    if (loggedIn) break;
    await page.waitForTimeout(2000);
  }

  if (!loggedIn) {
    console.error('超时未检测到登录成功，请重新运行 npm run login。');
    await browser.close();
    process.exit(1);
  }

  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log(`登录成功，登录态已保存到 ${STORAGE_STATE_PATH}`);
  await browser.close();
}

main().catch((err) => {
  console.error('登录流程出错:', err);
  process.exit(1);
});
