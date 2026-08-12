// 需求生命周期状态机。用一张迁移表校验，而不是散落在各处的 if 判断——
// 任何不在表里的迁移直接抛错，调用方（routes.js/queue.js）出了 bug 会立刻暴露，不会静默产生
// 不一致的状态。
//
// draft -> planning -> plan_ready -> confirmed -> queued -> running -> succeeded
//                    \-> plan_rejected（AI 判断不可行，终态）
// plan_ready -> planning（管理员发聊天消息，AI 重新出计划，可反复）
// running -> failed（任一步骤执行出错，终态，不自动重试）
// succeeded -> summarized（点击"总结经验"，可选，不是必经状态）

const TRANSITIONS = {
  draft: ['planning'],
  planning: ['plan_ready', 'plan_rejected'],
  plan_ready: ['planning', 'confirmed'],
  plan_rejected: [],
  confirmed: ['queued'],
  queued: ['running'],
  running: ['succeeded', 'failed'],
  succeeded: ['summarized'],
  failed: [],
  summarized: [],
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/** 校验并返回目标状态；非法迁移抛错，调用方无需自己再判断一遍。 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态迁移: ${from} -> ${to}`);
  }
  return to;
}
