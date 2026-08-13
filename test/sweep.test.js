import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransition, assertTransition, findMatchingItem, isExpired, buildVariationFilter } from '../server/admin/sweepEngine.js';

test('状态机: 合法迁移允许通过', () => {
  assert.equal(canTransition('draft', 'active'), true);
  assert.equal(canTransition('active', 'pending_payment'), true);
  assert.equal(canTransition('pending_payment', 'active'), true);
  assert.equal(canTransition('pending_payment', 'completed'), true);
  assert.equal(canTransition('active', 'expired'), true);
  assert.equal(canTransition('active', 'cancelled'), true);
});

test('状态机: 非法迁移被拒绝', () => {
  assert.equal(canTransition('completed', 'active'), false);
  assert.equal(canTransition('expired', 'active'), false);
  assert.equal(canTransition('cancelled', 'active'), false);
  assert.equal(canTransition('draft', 'completed'), false);
});

test('assertTransition: 合法迁移返回目标状态', () => {
  assert.equal(assertTransition('draft', 'active'), 'active');
});

test('assertTransition: 非法迁移抛错', () => {
  assert.throws(() => assertTransition('completed', 'active'), /非法状态迁移/);
});

function mockItem(overrides = {}) {
  return {
    category: '英雄皮肤',
    typeName: '谧星·夜影浮香',
    price: 700,
    equipId: 'e1',
    serverId: 2,
    gameOrdersn: 'sn1',
    orderConfirmUrl: 'https://example.com/order',
    ...overrides,
  };
}

function mockTask(overrides = {}) {
  return {
    targetCategory: 'hero',
    targetItemName: '谧星·夜影浮香',
    priceCeiling: 800,
    ...overrides,
  };
}

test('findMatchingItem: 分类+名称+价格全部匹配才算命中', () => {
  const items = [mockItem()];
  const task = mockTask();
  assert.deepEqual(findMatchingItem(items, task), items[0]);
});

test('findMatchingItem: 价格超过上限不命中', () => {
  const items = [mockItem({ price: 900 })];
  const task = mockTask({ priceCeiling: 800 });
  assert.equal(findMatchingItem(items, task), null);
});

test('findMatchingItem: 分类不匹配不命中', () => {
  const items = [mockItem({ category: '兵器皮肤' })];
  const task = mockTask({ targetCategory: 'hero' });
  assert.equal(findMatchingItem(items, task), null);
});

test('findMatchingItem: 名称不匹配不命中', () => {
  const items = [mockItem({ typeName: '别的皮肤' })];
  const task = mockTask();
  assert.equal(findMatchingItem(items, task), null);
});

test('findMatchingItem: 多个命中时取价格最低的', () => {
  const cheap = mockItem({ equipId: 'cheap', price: 500 });
  const expensive = mockItem({ equipId: 'expensive', price: 750 });
  const items = [expensive, cheap];
  const task = mockTask({ priceCeiling: 800 });
  assert.equal(findMatchingItem(items, task).equipId, 'cheap');
});

test('isExpired: 截止时间已过返回 true', () => {
  const task = { deadlineAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(isExpired(task), true);
});

test('isExpired: 截止时间未到返回 false', () => {
  const task = { deadlineAt: new Date(Date.now() + 1000 * 60).toISOString() };
  assert.equal(isExpired(task), false);
});

test('buildVariationFilter: 全部留空返回 null（走零请求缓存路径）', () => {
  assert.equal(buildVariationFilter({}), null);
  assert.equal(buildVariationFilter({ starLevel: '', slot1: '', slot2: '', slot3: '', slot4: '' }), null);
});

test('buildVariationFilter: 只填星级也算启用筛选', () => {
  const result = buildVariationFilter({ starLevel: '2' });
  assert.deepEqual(result, { starLevel: 2, slots: [null, null, null, null] });
});

test('buildVariationFilter: 只填某一个星格也算启用筛选', () => {
  const result = buildVariationFilter({ slot2: '500' });
  assert.deepEqual(result, { starLevel: null, slots: [null, 500, null, null] });
});

test('buildVariationFilter: 星级+多个星格一起解析', () => {
  const result = buildVariationFilter({ starLevel: '3', slot1: '100', slot3: '999' });
  assert.deepEqual(result, { starLevel: 3, slots: [100, null, 999, null] });
});
