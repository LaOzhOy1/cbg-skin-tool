import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getState, getItems, getVerifyState, setVerifyState } from './state.js';
import { startPolling, resumePolling, isPaused } from './poller.js';
import { runLoginFlow, isLoginFlowRunning } from './loginFlow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/items', (req, res) => {
  res.json(getItems());
});

app.get('/api/status', (req, res) => {
  res.json(getState());
});

app.post('/api/verify/start', (req, res) => {
  if (isLoginFlowRunning()) {
    return res.json({ started: false, reason: 'already_running' });
  }
  setVerifyState('running');
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
  res.json(getVerifyState());
});

app.listen(PORT, () => {
  console.log(`藏宝阁监控面板已启动: http://localhost:${PORT}`);
  startPolling();
});
