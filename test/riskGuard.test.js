import assert from 'node:assert/strict';
import test from 'node:test';
import { setStatus } from '../server/state.js';
import { assessNetworkRisk, noteRiskSignal, resetRiskSignals } from '../server/riskGuard.js';

const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'X-Forwarded-For',
  'X-Real-IP',
  'X_FORWARDED_FOR',
  'X_REAL_IP',
];

function snapshotProxyEnv() {
  return Object.fromEntries(PROXY_KEYS.map((key) => [key, process.env[key]]));
}

function restoreProxyEnv(snapshot) {
  for (const key of PROXY_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function clearProxyEnv() {
  for (const key of PROXY_KEYS) {
    delete process.env[key];
  }
}

test('riskGuard.js 风险预检', async (t) => {
  const proxySnapshot = snapshotProxyEnv();

  t.beforeEach(() => {
    clearProxyEnv();
  });

  t.after(() => {
    restoreProxyEnv(proxySnapshot);
    resetRiskSignals();
    setStatus('loading');
  });

  await t.test('下单类调用会被标成高风险，但在干净环境下仍允许执行', () => {
    resetRiskSignals();
    setStatus('loading');
    const risk = assessNetworkRisk({ operation: 'sweep.addOrder', profile: 'place_order', ignoreState: true });
    assert.equal(risk.allow, true);
    assert.equal(risk.level, 'high');
    assert.match(risk.reasons.join('；'), /下单路径/);
  });

  await t.test('代理环境会直接拦截站点调用', () => {
    resetRiskSignals();
    setStatus('loading');
    process.env.HTTP_PROXY = 'http://10.0.0.1:8080';
    const risk = assessNetworkRisk({ operation: 'poller.tick', profile: 'poller' });
    assert.equal(risk.allow, false);
    assert.match(risk.reasons.join('；'), /代理/);
  });

  await t.test('恢复模式不会被当前失效状态误伤', () => {
    resetRiskSignals();
    setStatus('not_logged_in');
    const blocked = assessNetworkRisk({ operation: 'api.verify.start', profile: 'login' });
    assert.equal(blocked.allow, false);
    const recovery = assessNetworkRisk({ operation: 'api.verify.start', profile: 'login', ignoreState: true });
    assert.equal(recovery.allow, true);
    assert.equal(recovery.level, 'high');
  });

  await t.test('高风险信号会让后续调用进入拦截态', () => {
    resetRiskSignals();
    setStatus('loading');
    noteRiskSignal('captcha_auth', '图形验证码', 'high');
    const risk = assessNetworkRisk({ operation: 'poller.tick', profile: 'poller' });
    assert.equal(risk.allow, false);
    assert.match(risk.reasons.join('；'), /captcha_auth/);
  });
});
