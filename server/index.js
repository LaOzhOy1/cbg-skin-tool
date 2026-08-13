import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getState, getItems, getVerifyState } from './state.js';
import { startPolling, resumePolling, isPaused } from './poller.js';
import { runLoginFlow, isLoginFlowRunning } from './loginFlow.js';
import adminRouter from './admin/routes.js';
import { startQueue } from './admin/queue.js';
import sweepRouter from './admin/sweepRoutes.js';
import { startSweepEngine } from './admin/sweepEngine.js';
import accountRouter from './admin/accountRoutes.js';
import { ensureDefaultAccount, getActiveAccount } from './admin/accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env 是可选的（比如 DEEPSEEK_API_KEY），不存在也不影响监控面板本身运行。
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // 没有 .env 文件时静默跳过，AI 相关功能会在调用时报"未配置 DEEPSEEK_API_KEY"
}

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
app.get('/sweep', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'sweep.html'));
});
app.get('/accounts', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'accounts.html'));
});
app.use('/api/admin', adminRouter);
app.use('/api/admin/sweep-tasks', sweepRouter);
app.use('/api/admin/accounts', accountRouter);

app.get('/api/items', (req, res) => {
  res.json(getItems());
});

app.get('/api/status', (req, res) => {
  res.json(getState());
});

// 这两个旧接口保留，始终针对"当前活跃账号"操作——账号管理上线后，更精确的
// 按账号验证走 /api/admin/accounts/:id/verify/*，这两个是历史兼容路径。
app.post('/api/verify/start', (req, res) => {
  if (isLoginFlowRunning()) {
    return res.json({ started: false, reason: 'already_running' });
  }
  runLoginFlow()
    .then((ok) => {
      if (ok && isPaused()) resumePolling();
    })
    .catch(() => {
      // 错误已经记录在 verify state 里，这里不需要额外处理
    });
  res.json({ started: true });
});

app.get('/api/verify/status', (req, res) => {
  const account = getActiveAccount();
  res.json(account ? getVerifyState(account.id) : { status: 'idle', startedAt: null, error: null });
});

app.listen(PORT, HOST, () => {
  ensureDefaultAccount();
  console.log(`藏宝阁监控面板已启动: http://${HOST}:${PORT}`);
  console.log(`需求管理后台: http://${HOST}:${PORT}/admin`);
  console.log(`账号管理: http://${HOST}:${PORT}/accounts`);
  startPolling();
  startQueue();
  startSweepEngine();
});
