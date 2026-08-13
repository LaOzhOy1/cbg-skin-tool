// 需求管理后台的 Express 路由，挂载在 /api/admin。
//
// 简化说明：需求生命周期只有一份状态机（stateMachine.js），挂在 requirement.status 上，
// 是唯一的状态来源。plan 记录只存内容（feasible/rejectReason/steps/chatHistory），
// 不再维护自己的一份状态，避免两套状态机互相打架、产生不一致。
import { Router } from 'express';
import { list, get, insert, update } from './store.js';
import { assertTransition } from './stateMachine.js';
import { generatePlan, revisePlan, summarizeTask, LlmNotConfiguredError } from './llm.js';
import { getActiveAccount } from './accounts.js';

const router = Router();

function requirementWithDetails(requirement) {
  const plan = requirement.planId ? get('plans', requirement.planId) : null;
  const task = requirement.taskId ? get('tasks', requirement.taskId) : null;
  return { ...requirement, plan, task };
}

function sendError(res, err) {
  if (err instanceof LlmNotConfiguredError) return res.status(503).json({ error: err.message });
  if (err.message?.includes('非法状态迁移')) return res.status(409).json({ error: err.message });
  if (err.message?.includes('找不到')) return res.status(404).json({ error: err.message });
  console.error('[admin/routes]', err);
  return res.status(500).json({ error: err.message || String(err) });
}

/** 需求创建后异步跑一次 AI 出计划，不阻塞创建请求的响应。 */
async function runInitialPlanning(requirementId) {
  const requirement = get('requirements', requirementId);
  update('requirements', requirementId, { status: assertTransition(requirement.status, 'planning') });
  try {
    const result = await generatePlan(requirement.rawText);
    applyPlanResult(requirementId, result);
  } catch (err) {
    applyPlanResult(requirementId, {
      feasible: false,
      rejectReason: `AI 出计划时出错: ${err.message || err}`,
      steps: [],
    });
  }
}

function applyPlanResult(requirementId, result) {
  const requirement = get('requirements', requirementId);
  update('plans', requirement.planId, {
    feasible: Boolean(result.feasible),
    rejectReason: result.rejectReason || null,
    steps: Array.isArray(result.steps) ? result.steps : [],
  });
  const nextStatus = result.feasible ? 'plan_ready' : 'plan_rejected';
  update('requirements', requirementId, { status: assertTransition('planning', nextStatus) });
}

router.post('/requirements', (req, res) => {
  const { title, rawText } = req.body || {};
  if (!rawText || typeof rawText !== 'string') {
    return res.status(400).json({ error: 'rawText 不能为空' });
  }
  const requirement = insert('requirements', {
    title: title || rawText.slice(0, 30),
    rawText,
    status: 'draft',
    // 记录创建时的活跃账号，用于展示"这条需求是在哪个账号下提出的"——这一轮不需要
    // 执行时校验，因为现有能力（list_onsale_items）直接读 state.js 的全局快照，
    // 快照本来就只代表活跃账号，天然不会读错账号的数据。
    accountId: getActiveAccount()?.id || null,
    planId: null,
    taskId: null,
  });
  const plan = insert('plans', {
    requirementId: requirement.id,
    feasible: null,
    rejectReason: null,
    steps: [],
    chatHistory: [],
  });
  update('requirements', requirement.id, { planId: plan.id });

  runInitialPlanning(requirement.id).catch((err) => {
    console.error('[admin/routes] runInitialPlanning 出错:', err);
  });

  res.status(201).json(requirementWithDetails(get('requirements', requirement.id)));
});

router.get('/requirements', (req, res) => {
  const requirements = list('requirements')
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(requirements.map(requirementWithDetails));
});

router.get('/requirements/:id', (req, res) => {
  const requirement = get('requirements', req.params.id);
  if (!requirement) return res.status(404).json({ error: '需求不存在' });
  res.json(requirementWithDetails(requirement));
});

router.post('/requirements/:id/chat', async (req, res) => {
  try {
    const requirement = get('requirements', req.params.id);
    if (!requirement) return res.status(404).json({ error: '需求不存在' });
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message 不能为空' });
    }
    if (requirement.status !== 'plan_ready') {
      return res.status(409).json({ error: `当前状态 ${requirement.status} 不支持聊天修改计划` });
    }

    update('requirements', requirement.id, { status: assertTransition('plan_ready', 'planning') });

    const plan = get('plans', requirement.planId);
    const chatHistory = [...plan.chatHistory, { role: 'admin', content: message, createdAt: new Date().toISOString() }];
    update('plans', plan.id, { chatHistory });

    let result;
    try {
      result = await revisePlan(requirement.rawText, { ...plan, chatHistory }, message);
    } catch (err) {
      result = { feasible: false, rejectReason: `AI 修改计划时出错: ${err.message || err}`, steps: plan.steps };
    }

    const aiSummary = result.feasible
      ? `已更新计划，共 ${result.steps?.length ?? 0} 步。`
      : `判定不可行：${result.rejectReason || '未说明原因'}`;
    update('plans', plan.id, {
      chatHistory: [...chatHistory, { role: 'ai', content: aiSummary, createdAt: new Date().toISOString() }],
    });

    applyPlanResult(requirement.id, result);
    res.json(requirementWithDetails(get('requirements', requirement.id)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/requirements/:id/confirm', (req, res) => {
  try {
    const requirement = get('requirements', req.params.id);
    if (!requirement) return res.status(404).json({ error: '需求不存在' });
    if (requirement.status !== 'plan_ready') {
      return res.status(409).json({ error: `当前状态 ${requirement.status} 不能确认` });
    }
    const plan = get('plans', requirement.planId);
    if (!plan.feasible) {
      return res.status(409).json({ error: '当前计划已被判定为不可行，无法确认' });
    }

    const task = insert('tasks', {
      requirementId: requirement.id,
      planId: plan.id,
      status: 'queued',
      stepIndex: 0,
      stepResults: [],
      startedAt: null,
      finishedAt: null,
      error: null,
    });

    let updated = update('requirements', requirement.id, {
      status: assertTransition('plan_ready', 'confirmed'),
      taskId: task.id,
    });
    updated = update('requirements', requirement.id, { status: assertTransition('confirmed', 'queued') });

    res.json(requirementWithDetails(updated));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/requirements/:id/summarize', async (req, res) => {
  try {
    const requirement = get('requirements', req.params.id);
    if (!requirement) return res.status(404).json({ error: '需求不存在' });
    if (requirement.status !== 'succeeded') {
      return res.status(409).json({ error: `当前状态 ${requirement.status} 不能总结经验` });
    }
    const plan = get('plans', requirement.planId);
    const task = get('tasks', requirement.taskId);

    const result = await summarizeTask(requirement, plan, task);
    const template = insert('templates', {
      sourceRequirementId: requirement.id,
      title: result.title || requirement.title,
      summary: result.summary || '',
      planPattern: result.planPattern || '',
    });

    const updated = update('requirements', requirement.id, {
      status: assertTransition('succeeded', 'summarized'),
    });
    res.json({ requirement: requirementWithDetails(updated), template });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/templates', (req, res) => {
  const templates = list('templates')
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(templates);
});

export default router;
