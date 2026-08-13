// 账号管理的 Express 路由，挂载在 /api/admin/accounts。
import { Router } from 'express';
import { existsSync } from 'fs';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  switchActiveAccount,
  deleteAccount,
  getActiveAccount,
  refreshAccountProfile,
} from './accounts.js';
import { runLoginFlow, isLoginFlowRunning, loginFlowRunningAccountId } from '../loginFlow.js';
import { getVerifyState } from '../state.js';
import { resumePolling, isPaused } from '../poller.js';

const router = Router();

/** 附带一份不含敏感文件路径、但带登录态摘要的展示视图，前端不需要知道具体文件路径。 */
function withLoginSummary(account) {
  const hasLogin = Boolean(account.storageStatePath && existsSync(account.storageStatePath));
  return { ...account, hasLogin };
}

router.get('/', (req, res) => {
  res.json(listAccounts().map(withLoginSummary));
});

router.post('/', (req, res) => {
  const { name, buyerRoleId, buyerServerId } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name 不能为空' });
  }
  const account = createAccount({ name, buyerRoleId, buyerServerId });
  res.status(201).json(withLoginSummary(account));
});

router.get('/:id', (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  res.json(withLoginSummary(account));
});

router.patch('/:id', (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  const updated = updateAccount(req.params.id, req.body || {});
  res.json(withLoginSummary(updated));
});

router.post('/:id/activate', (req, res) => {
  try {
    const account = switchActiveAccount(req.params.id);
    res.json(withLoginSummary(account));
  } catch (err) {
    if (err.message?.includes('不存在')) return res.status(404).json({ error: err.message });
    console.error('[admin/accountRoutes]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

router.delete('/:id', (req, res) => {
  try {
    deleteAccount(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err.message?.includes('不存在')) return res.status(404).json({ error: err.message });
    if (err.message?.includes('活跃账号')) return res.status(409).json({ error: err.message });
    console.error('[admin/accountRoutes]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * 对指定账号打开人工验证窗口——不要求这个账号当前是活跃账号，方便在切换过去之前
 * 先把登录态准备好。只有验证的账号恰好是当前活跃账号、且验证成功时，才会顺带
 * 恢复轮询（runLoginFlow 内部已经处理了 cookieJar 的部分，这里只补轮询恢复）。
 */
router.post('/:id/verify/start', (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  if (isLoginFlowRunning()) {
    return res.json({ started: false, reason: 'already_running' });
  }
  runLoginFlow(account.id)
    .then((ok) => {
      if (ok && getActiveAccount()?.id === account.id && isPaused()) resumePolling();
    })
    .catch(() => {
      // 错误已经记录在 verify state 里，这里不需要额外处理
    });
  res.json({ started: true });
});

router.get('/:id/verify/status', (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  res.json({
    ...getVerifyState(account.id),
    isRunningNow: loginFlowRunningAccountId() === account.id,
  });
});

/**
 * 拉取一次账号信息（手机号/网易通行证标识），只能对当前活跃账号调用——手动触发，
 * 不做自动/周期性刷新，避免频繁打真实接口。
 */
router.post('/:id/refresh-profile', async (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  try {
    const updated = await refreshAccountProfile(req.params.id);
    res.json(withLoginSummary(updated));
  } catch (err) {
    if (err.message?.includes('活跃账号')) return res.status(409).json({ error: err.message });
    res.status(502).json({ error: err.message || String(err) });
  }
});

export default router;
