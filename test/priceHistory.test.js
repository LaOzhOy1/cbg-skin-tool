import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordPriceHistory, getPriceHistory, pruneExpired, _resetCacheForTest } from '../server/priceHistory.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function types(minPrice, { equipType = '3001', name = '天海' } = {}) {
  return [{ category: 'hero', equipType, typeName: name, minPrice }];
}

test('同一小时桶内取更低价，不新增点', () => {
  _resetCacheForTest({});
  const base = 1_700_000_000_000;
  recordPriceHistory(types(1000), base);
  recordPriceHistory(types(800), base + 5 * 60 * 1000); // 同一小时，更低
  recordPriceHistory(types(900), base + 10 * 60 * 1000); // 同一小时，更高，忽略
  const h = getPriceHistory('3001');
  assert.equal(h.points.length, 1);
  assert.equal(h.points[0].min, 800);
});

test('跨小时桶各自成点', () => {
  _resetCacheForTest({});
  const base = 1_700_000_000_000;
  recordPriceHistory(types(1000), base);
  recordPriceHistory(types(950), base + HOUR + 60 * 1000); // 下一个小时
  const h = getPriceHistory('3001');
  assert.equal(h.points.length, 2);
  assert.deepEqual(h.points.map((p) => p.min), [1000, 950]);
});

test('minPrice 为 null 的种类被跳过', () => {
  _resetCacheForTest({});
  recordPriceHistory([{ category: 'hero', equipType: '3002', typeName: '无货', minPrice: null }], 1_700_000_000_000);
  assert.equal(getPriceHistory('3002'), null);
});

test('超过 30 天的点被清理', () => {
  _resetCacheForTest({});
  const base = 1_700_000_000_000;
  recordPriceHistory(types(1000), base);
  // 32 天后再记一条，触发 pruneExpired，旧点应被清掉
  recordPriceHistory(types(500), base + 32 * DAY);
  const h = getPriceHistory('3001');
  assert.equal(h.points.length, 1);
  assert.equal(h.points[0].min, 500);
});

test('pruneExpired 清空后删除空种类', () => {
  _resetCacheForTest({});
  const base = 1_700_000_000_000;
  recordPriceHistory(types(1000), base);
  pruneExpired(base + 40 * DAY);
  assert.equal(getPriceHistory('3001'), null);
});

test('种类名随最新一轮更新', () => {
  _resetCacheForTest({});
  const base = 1_700_000_000_000;
  recordPriceHistory(types(1000, { name: '天海·旧名' }), base);
  recordPriceHistory(types(1000, { name: '天海·新名' }), base + HOUR + 1000);
  assert.equal(getPriceHistory('3001').typeName, '天海·新名');
});
