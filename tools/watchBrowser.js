// 被动监听浏览器窗口：打开一个可见 Chromium，复用已有登录态，只记录浏览器自己
// 因为你点击页面而发出的请求（page.on('request')/'framenavigated'），不会主动发起
// 任何额外的接口调用。用于人工点击站点时，同步记录“页面 -> 接口”对照关系到
// docs/site-map.md，遵守 CLAUDE.md 里“禁止短时间内多次主动探测接口”的铁律。
//
// 用法: npm run watch-browser
// 日志同时打印到终端，也追加写入 tools/watch-browser.log，方便事后一次性读取，
// 不需要反复轮询终端输出。
import { existsSync, appendFileSync } from 'fs';
import { chromium } from 'playwright';
import { SITE_URL, STORAGE_STATE_PATH } from '../src/session.js';

const LOG_PATH = new URL('./watch-browser.log', import.meta.url).pathname;

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(LOG_PATH, stamped + '\n');
}

let pageCounter = 0;

/** 给单个 page 挂上监听。藏宝阁很多商品链接是 target="_blank" 新开标签页，
 * 必须对每个新 page 都重复挂一遍，否则新标签页里的跳转/接口完全不会被记录。 */
function attachListeners(page, label) {
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    log(`${label} [页面跳转] ${frame.url()}`);
  });

  page.on('request', (req) => {
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    log(`${label} [接口请求] ${req.method()} ${req.url()}`);
  });

  page.on('response', async (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    log(`${label} [接口响应] ${res.status()} ${req.method()} ${res.url()}`);
  });

  page.on('close', () => log(`${label} [标签页关闭]`));
}

async function main() {
  log('=== 启动被动监听窗口 ===');
  const browser = await chromium.launch({ headless: false });
  const contextOptions = { viewport: { width: 1400, height: 960 } };
  if (existsSync(STORAGE_STATE_PATH)) {
    contextOptions.storageState = STORAGE_STATE_PATH;
  }
  const context = await browser.newContext(contextOptions);

  // 新标签页（target="_blank" 或 window.open）会触发 context 的 'page' 事件，
  // 必须监听它才能追踪到点击商品详情后新开的标签页。这个事件对 context.newPage()
  // 创建的初始页面也会触发一次，所以初始页面不要再手动 attachListeners，否则会
  // 重复挂两遍监听、每条日志打印两次。
  context.on('page', (newPage) => {
    pageCounter += 1;
    const label = `[标签页#${pageCounter}]`;
    log(`${label} 检测到新标签页打开`);
    attachListeners(newPage, label);
  });

  const page = await context.newPage();
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  log('窗口已打开，随意点击页面即可（包括新开的标签页），日志会自动记录。关闭浏览器窗口即结束监听。');

  await new Promise((resolve) => {
    context.on('close', resolve);
    browser.on('disconnected', resolve);
  });

  log('=== 监听窗口已关闭 ===');
}

main().catch((err) => {
  log(`出错: ${err.message}`);
  process.exit(1);
});
