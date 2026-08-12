// 任务队列：进程内、并发=1、setInterval 轮询，风格与 server/poller.js 的定时循环一致。
// 并发=1 是有意的：这个账号已经因风控被限制过，任何会触发真实站点请求的能力都不该并发/抢跑。
import { list, get, update } from './store.js';
import { assertTransition } from './stateMachine.js';
import { findCapability } from './capabilities.js';

const POLL_INTERVAL_MS = 2000;

let timer = null;
let running = false;

function nowIso() {
  return new Date().toISOString();
}

/** 进程重启后，把上次异常中断的 running 任务统一标记为 failed，不自动续跑——
 * 涉及真实副作用的步骤不能在不确定状态下自动重来。 */
export function recoverStuckTasks() {
  const stuck = list('tasks').filter((t) => t.status === 'running');
  for (const task of stuck) {
    update('tasks', task.id, {
      status: assertTransition('running', 'failed'),
      error: '进程重启中断',
      finishedAt: nowIso(),
    });
    const requirement = get('requirements', task.requirementId);
    if (requirement && requirement.status === 'running') {
      update('requirements', requirement.id, { status: assertTransition('running', 'failed') });
    }
  }
}

async function runTask(task) {
  const plan = get('plans', task.planId);
  const stepResults = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const capability = findCapability(step.capability);
    update('tasks', task.id, { stepIndex: i });
    if (!capability) {
      const error = `找不到能力 ${step.capability}`;
      stepResults.push({ capability: step.capability, params: step.params, error, at: nowIso() });
      update('tasks', task.id, { stepResults });
      return { ok: false, error };
    }
    try {
      const result = await capability.handler(step.params || {});
      stepResults.push({ capability: step.capability, params: step.params, result, at: nowIso() });
      update('tasks', task.id, { stepResults });
    } catch (err) {
      const error = err.message || String(err);
      stepResults.push({ capability: step.capability, params: step.params, error, at: nowIso() });
      update('tasks', task.id, { stepResults });
      return { ok: false, error };
    }
  }
  return { ok: true };
}

async function tick() {
  if (running) return;
  const requirement = list('requirements').find((r) => r.status === 'queued');
  if (!requirement) return;

  running = true;
  try {
    update('requirements', requirement.id, { status: assertTransition('queued', 'running') });
    const task = update('tasks', requirement.taskId, {
      status: assertTransition('queued', 'running'),
      startedAt: nowIso(),
    });

    const outcome = await runTask(task);

    if (outcome.ok) {
      update('tasks', task.id, { status: assertTransition('running', 'succeeded'), finishedAt: nowIso() });
      update('requirements', requirement.id, { status: assertTransition('running', 'succeeded') });
    } else {
      update('tasks', task.id, {
        status: assertTransition('running', 'failed'),
        error: outcome.error,
        finishedAt: nowIso(),
      });
      update('requirements', requirement.id, { status: assertTransition('running', 'failed') });
    }
  } finally {
    running = false;
  }
}

export function startQueue() {
  recoverStuckTasks();
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => {
      // 队列 tick 本身出错（比如状态机迁移异常）时打日志，不让 setInterval 因未捕获异常停摆。
      console.error('[admin/queue] tick 出错:', err);
    });
  }, POLL_INTERVAL_MS);
}

export function stopQueue() {
  if (timer) clearInterval(timer);
  timer = null;
}
