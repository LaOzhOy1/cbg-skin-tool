#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { summarizeRisk } from '../server/riskGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');
const STORAGE_STATE_PATH = path.join(PROJECT_ROOT, 'storageState.json');
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_INTERVAL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;

function printHelp() {
  console.log(`
藏宝阁皮肤监控 CLI v${packageJson.version}

用法:
  cbg-skin <命令> [选项]
  npm run cli -- <命令> [选项]

命令:
  start    启动本地监控服务和网页面板
  login    打开可见浏览器，人工登录并保存登录态
  doctor   检查 Node、依赖、Chromium 和登录态
  status   查看正在运行的监控服务状态
  items    列出当前在售商品，支持分类和数量限制
  verify   请求服务打开人工验证窗口
  help     显示帮助

全局选项:
  -h, --help       显示帮助
  -v, --version    显示版本

示例:
  npm run cli -- doctor
  npm run cli -- start --port 4173 --interval 20000
  npm run cli -- status
  npm run cli -- items --category hero --limit 10
  npm run cli -- verify
`);
}

const commandHelp = {
  start: `用法: cbg-skin start [--host 127.0.0.1] [--port 4173] [--interval 20000]\n\n启动监控服务。interval 单位为毫秒，最小 5000。`,
  login: '用法: cbg-skin login\n\n打开可见 Chromium，等待你手动完成登录后保存登录态。',
  doctor: '用法: cbg-skin doctor [--json]\n\n执行纯本地环境检查，不访问藏宝阁。',
  status: '用法: cbg-skin status [--url http://127.0.0.1:4173] [--json]\n\n读取本地服务的当前轮询状态。',
  items: '用法: cbg-skin items [--category all|hero|weapon] [--limit 20] [--url URL] [--json]\n\n列出本地服务缓存的在售商品。',
  verify: '用法: cbg-skin verify [--url http://127.0.0.1:4173] [--json]\n\n请求已运行的服务打开人工验证窗口。',
};

function parseCommandArgs(args, options) {
  return parseArgs({
    args,
    options: {
      ...options,
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
    strict: true,
  }).values;
}

function positiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return number;
}

function baseUrlFrom(value) {
  const fallback = process.env.CBG_URL || `http://${DEFAULT_HOST}:${process.env.PORT || DEFAULT_PORT}`;
  let url;
  try {
    url = new URL(value || fallback);
  } catch {
    throw new Error(`无效的服务地址: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('服务地址只支持 http 或 https');
  }
  url.pathname = url.pathname.replace(/\/*$/, '/');
  url.search = '';
  url.hash = '';
  return url;
}

async function requestApi(baseUrl, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(pathname.replace(/^\//, ''), baseUrl), {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`服务返回 HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`连接本地服务超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`);
    }
    if (error instanceof TypeError) {
      throw new Error(`无法连接本地服务 ${baseUrl.origin}，请先运行 cbg-skin start`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

async function startCommand(args) {
  const values = parseCommandArgs(args, {
    host: { type: 'string' },
    port: { type: 'string', short: 'p' },
    interval: { type: 'string', short: 'i' },
  });
  if (values.help) return console.log(commandHelp.start);

  const host = values.host || DEFAULT_HOST;
  const port = positiveInteger(values.port || DEFAULT_PORT, 'port', { min: 1, max: 65_535 });
  const interval = positiveInteger(values.interval || DEFAULT_INTERVAL_MS, 'interval', {
    min: 5_000,
    max: 86_400_000,
  });

  process.env.HOST = host;
  process.env.PORT = String(port);
  process.env.POLL_INTERVAL_MS = String(interval);
  await import('../server/index.js');
}

async function loginCommand(args) {
  const values = parseCommandArgs(args, {});
  if (values.help) return console.log(commandHelp.login);
  await import('../src/login.js');
}

function addCheck(checks, name, status, message) {
  checks.push({ name, status, message });
}

async function doctorCommand(args) {
  const values = parseCommandArgs(args, { json: { type: 'boolean' } });
  if (values.help) return console.log(commandHelp.doctor);

  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  addCheck(
    checks,
    'Node.js',
    nodeMajor >= 18 ? 'ok' : 'error',
    `${process.versions.node}${nodeMajor >= 18 ? '' : '（需要 18 或更高版本）'}`
  );

  for (const dependency of ['express', 'playwright']) {
    const installed = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', dependency, 'package.json'));
    addCheck(checks, `依赖 ${dependency}`, installed ? 'ok' : 'error', installed ? '已安装' : '未安装，请运行 npm install');
  }

  try {
    const { chromium } = await import('playwright');
    const executablePath = chromium.executablePath();
    addCheck(
      checks,
      'Chromium',
      fs.existsSync(executablePath) ? 'ok' : 'error',
      fs.existsSync(executablePath) ? '已安装' : '未安装，请运行 npx playwright install chromium'
    );
  } catch (error) {
    addCheck(checks, 'Chromium', 'error', `无法检查: ${error.message}`);
  }

  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    addCheck(checks, '登录态', 'warn', '未找到，请运行 cbg-skin login');
  } else {
    try {
      const storage = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
      const now = Date.now() / 1000;
      const targetCookies = (storage.cookies || []).filter((cookie) =>
        String(cookie.domain || '').includes('cbg.163.com')
      );
      const usableCookies = targetCookies.filter(
        (cookie) => !cookie.expires || cookie.expires === -1 || cookie.expires > now
      );
      addCheck(
        checks,
        '登录态',
        usableCookies.length > 0 ? 'ok' : 'warn',
        usableCookies.length > 0
          ? `文件存在，包含 ${usableCookies.length} 个未过期的目标站点 Cookie`
          : '文件存在，但未发现未过期的目标站点 Cookie，请重新登录'
      );
    } catch (error) {
      addCheck(checks, '登录态', 'warn', `文件无法解析: ${error.message}`);
    }
  }

  const networkRisk = summarizeRisk({ operation: 'doctor', profile: 'default', ignoreState: true });
  checks.push({
    name: '网络风险',
    status: networkRisk.allow ? (networkRisk.level === 'high' ? 'warn' : 'ok') : 'error',
    message: networkRisk.allow
      ? `${networkRisk.level === 'high' ? '当前调用本身偏高风险，但环境未见明显拦截因素' : '未见明显拦截因素'}`
      : networkRisk.reasons.join('；'),
  });
  const ready = checks.every((check) => check.status !== 'error');

  if (values.json) {
    console.log(JSON.stringify({ ready, checks }, null, 2));
  } else {
    for (const check of checks) {
      const mark = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗';
      console.log(`${mark} ${check.name}: ${check.message}`);
    }
    console.log(`\n环境检查: ${ready ? '基础环境可用' : '存在必须修复的问题'}`);
  }
  if (!ready) process.exitCode = 1;
}

async function statusCommand(args) {
  const values = parseCommandArgs(args, {
    url: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (values.help) return console.log(commandHelp.status);

  const state = await requestApi(baseUrlFrom(values.url), '/api/status');
  if (values.json) return console.log(JSON.stringify(state, null, 2));

  const labels = {
    loading: '正在加载',
    ok: '运行正常',
    needs_verification: '需要人工验证',
    not_logged_in: '未登录或登录态失效',
    error: '轮询出错',
  };
  console.log(`状态: ${labels[state.status] || state.status || '未知'}`);
  console.log(`商品: ${state.itemCount ?? 0} 件`);
  console.log(`上次更新: ${formatTime(state.lastUpdatedAt)}`);
  console.log(`下次轮询: ${formatTime(state.nextPollAt)}`);
  if (state.lastError) console.log(`错误: ${state.lastError}`);
  if (state.risk) {
    console.log(`风险: ${state.risk.allow ? state.risk.level : `blocked (${state.risk.reasons.join('；')})`}`);
  }
}

function normalizeCategory(value) {
  const key = String(value || 'all').toLowerCase();
  if (['all', '全部'].includes(key)) return null;
  if (['hero', 'hero_skin', '英雄皮肤'].includes(key)) return '英雄皮肤';
  if (['weapon', 'weapon_skin', '兵器皮肤'].includes(key)) return '兵器皮肤';
  throw new Error('category 只支持 all、hero、weapon、英雄皮肤或兵器皮肤');
}

async function itemsCommand(args) {
  const values = parseCommandArgs(args, {
    url: { type: 'string' },
    category: { type: 'string', short: 'c' },
    limit: { type: 'string', short: 'n' },
    json: { type: 'boolean' },
  });
  if (values.help) return console.log(commandHelp.items);

  const category = normalizeCategory(values.category);
  const limit = positiveInteger(values.limit || 20, 'limit', { min: 1, max: 1_000 });
  const items = await requestApi(baseUrlFrom(values.url), '/api/items');
  if (!Array.isArray(items)) throw new Error('本地服务返回的商品数据格式不正确');

  const filtered = category ? items.filter((item) => item.category === category) : items;
  const displayed = filtered.slice(0, limit);
  if (values.json) {
    return console.log(
      JSON.stringify({ total: filtered.length, displayed: displayed.length, items: displayed }, null, 2)
    );
  }

  console.log(`当前 ${category || '全部分类'}共 ${filtered.length} 件，显示前 ${displayed.length} 件:\n`);
  if (displayed.length === 0) {
    console.log('暂无商品');
    return;
  }
  displayed.forEach((item, index) => {
    const price = Number(item.price).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    console.log(`${index + 1}. [${item.category || '未分类'}] ${item.typeName || '未命名'}  ¥${price}`);
    console.log(`   ${item.serverName || '未知服务器'}${item.orderConfirmUrl ? `  ${item.orderConfirmUrl}` : ''}`);
  });
}

async function verifyCommand(args) {
  const values = parseCommandArgs(args, {
    url: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (values.help) return console.log(commandHelp.verify);

  const result = await requestApi(baseUrlFrom(values.url), '/api/verify/start', { method: 'POST' });
  if (values.json) return console.log(JSON.stringify(result, null, 2));
  if (result.started) {
    console.log('已请求打开人工验证窗口，请在浏览器中完成登录或安全验证。');
  } else if (result.reason === 'already_running') {
    console.log('人工验证窗口已经在运行。');
  } else {
    console.log(`未能启动验证流程: ${result.reason || '未知原因'}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log(packageJson.version);
    return;
  }

  const commands = {
    start: startCommand,
    login: loginCommand,
    doctor: doctorCommand,
    status: statusCommand,
    items: itemsCommand,
    verify: verifyCommand,
  };
  const handler = commands[command];
  if (!handler) {
    throw new Error(`未知命令: ${command}。运行 cbg-skin help 查看可用命令`);
  }
  await handler(args);
}

main().catch((error) => {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
});
