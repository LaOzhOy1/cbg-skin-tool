// 能力注册表：AI 只能用这里登记过的能力组合出执行计划，不能编造不存在的接口。
// 这也是"AI 判断无法支持该计划则快速失败"的实现基础——把这个数组序列化进 system prompt，
// 任何超出登记范围的需求（比如真的下单）AI 会自己判断为不可行。
//
// 下一轮扩展点：往这个数组里加 place_order / check_payment_result 两条能力，
// 状态机和队列代码不需要改。
import { getItems } from '../state.js';

const CATEGORY_LABELS = {
  hero: '英雄皮肤',
  weapon: '兵器皮肤',
  all: null,
};

function normalizeCategory(value) {
  const key = String(value || 'all').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, key)) return CATEGORY_LABELS[key];
  if (['英雄皮肤', '兵器皮肤'].includes(value)) return value;
  return null;
}

export const CAPABILITIES = [
  {
    name: 'list_onsale_items',
    description: '查询本地已缓存的当前在售商品列表，可按分类过滤（all|hero|weapon）、限制返回数量',
    paramsSchema: {
      category: '字符串，all|hero|weapon，默认 all',
      limit: '数字，返回条数上限，默认 20',
    },
    async handler(params = {}) {
      const category = normalizeCategory(params.category);
      const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 20;
      const items = getItems();
      const filtered = category ? items.filter((item) => item.category === category) : items;
      return {
        total: filtered.length,
        items: filtered.slice(0, limit),
      };
    },
  },
];

export function findCapability(name) {
  return CAPABILITIES.find((c) => c.name === name) || null;
}

/** 给 LLM prompt 用的精简描述，不带 handler 函数体。 */
export function describeCapabilities() {
  return CAPABILITIES.map(({ name, description, paramsSchema }) => ({ name, description, paramsSchema }));
}
