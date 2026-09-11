// market-v2 页面的只读接口：全部读本地缓存/内存态，零额外藏宝阁请求。
//   GET /api/market/types           聚合的种类 + 最低价 + 在售数量（读轮询快照 + itemTypeCache）
//   GET /api/market/items?equipType= 某种类下的个体在售挂单（读轮询快照）
//   GET /api/market/price-history?equipType=  某种类的历史最低价时序（读 priceHistory）
import express from 'express';
import { getItems } from './state.js';
import { listCachedTypes } from './itemTypeCache.js';
import { getPriceHistory } from './priceHistory.js';

const router = express.Router();

const ZH_CATEGORY = { hero: '英雄皮肤', weapon: '兵器皮肤' };

/**
 * 聚合视图：以"种类"为单位，最低价取轮询快照里该种类所有在售挂单的最小值，
 * 在售数量 = 该种类挂单数。种类的名称/图片/更新时间取自 itemTypeCache（7 天滚动）。
 * 完全在内存/本地缓存上算，不发任何请求。
 */
router.get('/types', (req, res) => {
  const items = getItems();
  // 按 equipType 聚合轮询快照
  const byType = new Map();
  for (const it of items) {
    const key = String(it.equipType);
    let agg = byType.get(key);
    if (!agg) {
      agg = { equipType: key, category: it.category, count: 0, minPrice: Infinity };
      byType.set(key, agg);
    }
    agg.count += 1;
    if (it.price < agg.minPrice) agg.minPrice = it.price;
  }

  // 用 itemTypeCache 补充种类名/图片/更新时间（缓存里可能有当前快照没有的种类）
  const cached = [...listCachedTypes('hero'), ...listCachedTypes('weapon')];
  const cacheByType = new Map(cached.map((c) => [String(c.equipType), c]));

  const out = [];
  const seen = new Set();
  for (const [key, agg] of byType) {
    const c = cacheByType.get(key);
    out.push({
      equipType: key,
      category: agg.category,
      typeName: c?.typeName || key,
      typeDesc: c?.typeDesc || '',
      minPrice: agg.minPrice === Infinity ? (c?.minPrice ?? null) : agg.minPrice,
      onSaleCount: agg.count,
      localImagePath: c?.localImagePath || null,
      updatedAt: c?.lastSeenAt || null,
    });
    seen.add(key);
  }
  // 快照里当前没有、但缓存里 7 天内见过的种类也带上（标记为无在售）
  for (const c of cached) {
    if (seen.has(String(c.equipType))) continue;
    out.push({
      equipType: String(c.equipType),
      category: ZH_CATEGORY[c.category] || c.category,
      typeName: c.typeName,
      typeDesc: c.typeDesc || '',
      minPrice: c.minPrice ?? null,
      onSaleCount: 0,
      localImagePath: c.localImagePath || null,
      updatedAt: c.lastSeenAt || null,
    });
  }
  res.json(out);
});

router.get('/items', (req, res) => {
  const equipType = String(req.query.equipType || '');
  if (!equipType) return res.status(400).json({ error: 'equipType 必填' });
  const items = getItems()
    .filter((it) => String(it.equipType) === equipType)
    .map((it) => ({
      equipId: it.equipId,
      price: it.price,
      serverName: it.serverName,
      sellingTime: it.sellingTime,
      orderConfirmUrl: it.orderConfirmUrl,
    }))
    .sort((a, b) => a.price - b.price);
  res.json(items);
});

router.get('/price-history', (req, res) => {
  const equipType = String(req.query.equipType || '');
  if (!equipType) return res.status(400).json({ error: 'equipType 必填' });
  const history = getPriceHistory(equipType);
  res.json(history || { equipType, points: [] });
});

export default router;
