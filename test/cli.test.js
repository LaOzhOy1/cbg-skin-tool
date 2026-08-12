import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, '..', 'bin', 'cbg-skin.js');

function runCli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('help 列出 CLI 的主要能力', () => {
  const result = runCli('help');
  assert.equal(result.status, 0);
  for (const command of ['start', 'login', 'doctor', 'status', 'items', 'verify']) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test('version 输出 package 版本', () => {
  const result = runCli('--version');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '1.0.0');
});

test('未知命令返回非零退出码和提示', () => {
  const result = runCli('unknown-command');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /未知命令/);
});

test('start 在启动服务前校验端口和轮询间隔', () => {
  const badPort = runCli('start', '--port', '70000');
  assert.equal(badPort.status, 1);
  assert.match(badPort.stderr, /port 必须/);

  const badInterval = runCli('start', '--interval', '1000');
  assert.equal(badInterval.status, 1);
  assert.match(badInterval.stderr, /interval 必须/);
});

test('items 在请求服务前校验分类', () => {
  const result = runCli('items', '--category', 'invalid');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /category 只支持/);
});

test('doctor JSON 输出结构化检查结果', () => {
  const result = runCli('doctor', '--json');
  assert.ok([0, 1].includes(result.status));
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.ready, 'boolean');
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.checks.some((check) => check.name === 'Node.js'));
  assert.ok(report.checks.some((check) => check.name === 'Chromium'));
  assert.ok(report.checks.some((check) => check.name === '登录态'));
});
