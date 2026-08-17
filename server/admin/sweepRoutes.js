// 扫货任务的 Express 路由，挂载在 /api/admin/sweep-tasks。
// 和 admin/routes.js（AI 需求规划）是两条独立的路径：扫货是确定性的填空模板，
// 创建后直接激活，不经过 AI 出计划/确认这一套流程。
import { Router } from 'express';
import { list, get } from './store.js';
import { getItems } from '../state.js';
import { createSweepTask, cancelSweepTask } from './sweepEngine.js';
import { listCachedTypes } from '../itemTypeCache.js';

const router = Router();

const VALID_CATEGORIES = ['hero', 'weapon'];

const VALID_STAR_LEVELS = [1, 2, 3];

function validateInput(body) {
  const { targetItemName, targetCategory, priceCeiling, targetQuantity, durationDays, starLevel, slot1, slot2, slot3, slot4 } =
    body || {};
  if (!targetItemName || typeof targetItemName !== 'string') {
    return 'targetItemName 不能为空';
  }
  if (!VALID_CATEGORIES.includes(targetCategory)) {
    return 'targetCategory 只支持 hero 或 weapon';
  }
  if (!(Number(priceCeiling) > 0)) {
    return 'priceCeiling 必须是大于 0 的数字';
  }
  if (!Number.isInteger(Number(targetQuantity)) || Number(targetQuantity) <= 0) {
    return 'targetQuantity 必须是大于 0 的整数';
  }
  if (!Number.isInteger(Number(durationDays)) || Number(durationDays) <= 0) {
    return 'durationDays 必须是大于 0 的整数';
  }
  if (starLevel !== undefined && starLevel !== '' && !VALID_STAR_LEVELS.includes(Number(starLevel))) {
    return 'starLevel 只支持 1、2 或 3';
  }
  for (const [name, value] of [['slot1', slot1], ['slot2', slot2], ['slot3', slot3], ['slot4', slot4]]) {
    if (value !== undefined && value !== '' && !Number.isFinite(Number(value))) {
      return `${name} 必须是数字`;
    }
  }
  return null;
}

router.post('/', (req, res) => {
  const error = validateInput(req.body);
  if (error) return res.status(400).json({ error });
  const task = createSweepTask(req.body);
  res.status(201).json(task);
});

/**
 * 按分类列出当前轮询缓存里在售商品的去重名称，用于表单里的"选择商品"下拉列表，
 * 零额外请求（直接读 getItems() 的内存缓存）。只是当前能看到的商品快捷方式——
 * 如果目标商品当前没人在卖，缓存里就没有它，仍然需要手动输入名称。
 */
router.get('/item-names', (req, res) => {
  const items = getItems();
  const byCategory = { hero: new Set(), weapon: new Set() };
  const categoryKey = { 英雄皮肤: 'hero', 兵器皮肤: 'weapon' };
  for (const item of items) {
    const key = categoryKey[item.category];
    if (key) byCategory[key].add(item.typeName);
  }
  res.json({
    hero: [...byCategory.hero].sort(),
    weapon: [...byCategory.weapon].sort(),
  });
});

/**
 * 可视化选品网格的数据源：最近 7 天见过的皮肤"种类"（带缩略图/参考价），
 * 比 /item-names 覆盖更宽——即使该种类当前恰好没有在售个体商品（轮询快照里没有），
 * 只要 7 天内出现过就还在这里。零额外网络请求，直接读 itemTypeCache 的本地缓存。
 */
router.get('/item-types', (req, res) => {
  const category = req.query.category === 'weapon' ? 'weapon' : 'hero';
  res.json(listCachedTypes(category));
});

router.get('/', (req, res) => {
  const tasks = list('sweepTasks')
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(tasks);
});

router.get('/:id', (req, res) => {
  const task = get('sweepTasks', req.params.id);
  if (!task) return res.status(404).json({ error: '扫货任务不存在' });
  res.json(task);
});

router.post('/:id/cancel', (req, res) => {
  try {
    const task = cancelSweepTask(req.params.id);
    res.json(task);
  } catch (err) {
    if (err.message?.includes('不存在')) return res.status(404).json({ error: err.message });
    if (err.message?.includes('非法状态迁移')) return res.status(409).json({ error: err.message });
    console.error('[admin/sweepRoutes]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

export default router;
