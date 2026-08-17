import { getState } from './state.js';

const SIGNAL_WINDOW_MS = 15 * 60 * 1000;

const PROXY_ENV_KEYS = [
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

const OPERATION_PROFILES = {
  poller: { level: 'medium', reason: '轮询路径会连续请求种类列表和商品列表' },
  variation_query: { level: 'high', reason: '星格筛选会触发实时查询请求' },
  place_order: { level: 'high', reason: '下单路径会触发真实订单请求' },
  payment_check: { level: 'medium', reason: '支付查询会额外访问站点接口' },
  login: { level: 'high', reason: '登录/验证会打开真实浏览器并探测站点状态' },
  image_download: { level: 'low', reason: '缩略图下载属于辅助请求' },
  default: { level: 'low', reason: '普通站点请求' },
};

const recentSignals = [];

export class RiskBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RiskBlockedError';
  }
}

function levelRank(level) {
  return { low: 0, medium: 1, high: 2 }[level] ?? 0;
}

function maxLevel(a, b) {
  return levelRank(a) >= levelRank(b) ? a : b;
}

function now() {
  return Date.now();
}

function pruneSignals(at = now()) {
  while (recentSignals.length > 0 && at - recentSignals[0].at > SIGNAL_WINDOW_MS) {
    recentSignals.shift();
  }
}

function currentProxyReasons() {
  return PROXY_ENV_KEYS.flatMap((key) => {
    const value = process.env[key];
    return value ? [`检测到代理/转发环境变量 ${key}=${value}`] : [];
  });
}

export function noteRiskSignal(kind, detail = '', severity = 'medium') {
  recentSignals.push({ kind, detail: String(detail || ''), severity, at: now() });
  pruneSignals();
}

export function resetRiskSignals() {
  recentSignals.length = 0;
}

export function assessNetworkRisk({ operation = 'default', profile = 'default', ignoreState = false } = {}) {
  pruneSignals();
  const profileInfo = OPERATION_PROFILES[profile] || OPERATION_PROFILES.default;
  const reasons = [profileInfo.reason];
  const blockers = [];
  let level = profileInfo.level;

  if (!ignoreState) {
    const state = getState();
    if (state.status === 'needs_verification' || state.status === 'not_logged_in') {
      reasons.push(`当前状态 ${state.status}，不适合继续发站点请求`);
      blockers.push(state.status);
      level = 'high';
    } else if (state.status === 'error') {
      reasons.push(`当前状态 error：${state.lastError || '未知错误'}`);
      level = maxLevel(level, 'medium');
    }
  }

  const proxyReasons = currentProxyReasons();
  if (proxyReasons.length > 0) {
    reasons.push(...proxyReasons);
    blockers.push('proxy');
    level = 'high';
  }

  const highSignals = recentSignals.filter((signal) => signal.severity === 'high');
  const mediumSignals = recentSignals.filter((signal) => signal.severity === 'medium');
  if (highSignals.length > 0) {
    reasons.push(
      `近期出现高风险信号：${highSignals
        .map((signal) => `${signal.kind}${signal.detail ? `(${signal.detail})` : ''}`)
        .join('、')}`
    );
    blockers.push('high-signal');
    level = 'high';
  } else if (mediumSignals.length >= 2) {
    reasons.push(
      `近期连续出现登录/状态失败信号：${mediumSignals
        .map((signal) => `${signal.kind}${signal.detail ? `(${signal.detail})` : ''}`)
        .join('、')}`
    );
    blockers.push('medium-signal-burst');
    level = 'high';
  }

  const allow = blockers.length === 0;
  return {
    allow,
    level,
    operation,
    profile,
    reasons,
    blockers,
    recentSignals: recentSignals.map((signal) => ({
      kind: signal.kind,
      detail: signal.detail,
      severity: signal.severity,
      at: new Date(signal.at).toISOString(),
    })),
  };
}

export function assertNetworkSafe(meta) {
  const risk = assessNetworkRisk(meta);
  if (!risk.allow) {
    throw new RiskBlockedError(formatRiskBlock(risk));
  }
  return risk;
}

export function formatRiskBlock(risk) {
  return `风险拦截：${risk.operation} 被阻止。原因：${risk.reasons.join('；')}`;
}

export function summarizeRisk(meta) {
  return assessNetworkRisk(meta);
}
