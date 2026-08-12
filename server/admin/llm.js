// DeepSeek 客户端：OpenAI 兼容的 /chat/completions 协议。
// 结构化输出用 response_format: {type:"json_object"} + 在 system prompt 里附上 JSON Schema
// 的文字说明兜底——纯 json_object 模式只保证"是合法 JSON"，不保证字段结构，所以两手都要抓。
import { describeCapabilities } from './capabilities.js';
import { list as listRecords } from './store.js';

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const REQUEST_TIMEOUT_MS = 60_000;

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('未配置 DEEPSEEK_API_KEY，无法调用 AI。请设置环境变量后重启服务。');
    this.name = 'LlmNotConfiguredError';
  }
}

function apiKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new LlmNotConfiguredError();
  return key;
}

async function chatCompletion(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DeepSeek 接口返回 HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek 返回内容为空');
    try {
      return JSON.parse(content);
    } catch {
      throw new Error(`DeepSeek 返回内容不是合法 JSON: ${content.slice(0, 500)}`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`调用 DeepSeek 超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const PLAN_JSON_SCHEMA_TEXT = `{
  "feasible": boolean,           // 现有能力能否组合完成这个需求
  "rejectReason": string | null, // feasible=false 时必填，说明做不到的原因
  "steps": [                     // feasible=true 时必填，可以是空数组
    { "capability": string, "params": object, "description": string }
  ]
}`;

function capabilitiesPromptBlock() {
  const caps = describeCapabilities();
  return caps
    .map((c) => `- ${c.name}: ${c.description}\n  参数: ${JSON.stringify(c.paramsSchema)}`)
    .join('\n');
}

function templatesPromptBlock() {
  const templates = listRecords('templates');
  if (templates.length === 0) return '（暂无历史经验）';
  return templates
    .slice(-10)
    .map((t) => `- ${t.title}: ${t.summary}\n  计划模式: ${t.planPattern}`)
    .join('\n');
}

function systemPrompt() {
  return [
    '你是藏宝阁监控工具的需求规划助手。你的任务是把管理员的自然语言需求，拆解成一份只使用下方"可用能力列表"组合而成的执行计划。',
    '严格规则：',
    '1. 只能使用可用能力列表里登记的能力，不能编造不存在的接口或能力。',
    '2. 如果需求超出现有能力范围（比如需要真实下单、支付、需要能力列表里没有的操作），必须直接判定 feasible=false 并给出清晰的 rejectReason，不要勉强拼凑一个做不到的计划。',
    '3. 只输出一个 JSON 对象，不要任何多余文字、不要代码块标记。',
    '',
    '可用能力列表：',
    capabilitiesPromptBlock(),
    '',
    '历史经验模板（供参考，不是必须遵循）：',
    templatesPromptBlock(),
    '',
    '输出必须是符合以下结构的 JSON：',
    PLAN_JSON_SCHEMA_TEXT,
  ].join('\n');
}

/** 需求提交后首次生成计划。 */
export async function generatePlan(requirementText) {
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: `管理员需求：${requirementText}` },
  ];
  return chatCompletion(messages);
}

/** 管理员在聊天框里发消息，要求 AI 修改当前计划。 */
export async function revisePlan(requirementText, plan, chatMessage) {
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: `原始需求：${requirementText}` },
    {
      role: 'assistant',
      content: JSON.stringify({ feasible: plan.feasible, rejectReason: plan.rejectReason, steps: plan.steps }),
    },
    ...plan.chatHistory.map((turn) => ({
      role: turn.role === 'admin' ? 'user' : 'assistant',
      content: turn.content,
    })),
    { role: 'user', content: chatMessage },
  ];
  return chatCompletion(messages);
}

/** 需求执行成功后，总结成一条可复用的经验模板。 */
export async function summarizeTask(requirement, plan, task) {
  const messages = [
    {
      role: 'system',
      content: [
        '你是需求经验总结助手。给定一个已经成功执行完的需求、它的计划和执行结果，',
        '提炼一条简短的可复用经验，帮助以后遇到类似需求时更快做出正确的计划。',
        '只输出一个 JSON 对象，不要多余文字，不要代码块标记。',
        '结构：{ "title": string, "summary": string, "planPattern": string }',
        '其中 planPattern 用一句话描述"遇到这类需求应该怎么组合能力"，供以后的 system prompt 直接引用。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        requirementText: requirement.rawText,
        steps: plan.steps,
        stepResults: task.stepResults,
      }),
    },
  ];
  return chatCompletion(messages);
}
