import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shardOf } from '../server/cbgClient.js';
import { mergeItems, getItems, setItems } from '../server/state.js';

test('shardOf: 稳定——同一种类每次落同一片', () => {
  const a = shardOf('T123', 4);
  const b = shardOf('T123', 4);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 4);
});

test('shardOf: shardCount=1 时恒为 0', () => {
  assert.equal(shardOf('anything', 1), 0);
});

test('shardOf: 分布覆盖到多个分片（不是全落一片）', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(shardOf(`T${i}`, 4));
  assert.ok(seen.size >= 3, `40 个种类应覆盖多数分片, 实际覆盖 ${seen.size} 片`);
});

function item(equipType, id, price) {
  return { equipType, equipId: id, price, category: '英雄皮肤' };
}

test('mergeItems: 只覆盖本轮刷新的种类，其余沿用旧快照', () => {
  setItems([item('A', 'a1', 100), item('B', 'b1', 200)]);
  // 本轮只刷新了 A（allTypes 里 A、B 都还在售）
  mergeItems([item('A', 'a2', 90)], ['A'], ['A', 'B']);
  const got = getItems();
  const a = got.filter((i) => i.equipType === 'A');
  const b = got.filter((i) => i.equipType === 'B');
  assert.deepEqual(a.map((i) => i.equipId), ['a2'], 'A 被新数据覆盖');
  assert.deepEqual(b.map((i) => i.equipId), ['b1'], 'B 沿用旧快照');
});

test('mergeItems: 刷新后某种类没有挂单了 → 该种类从快照消失', () => {
  setItems([item('A', 'a1', 100)]);
  mergeItems([], ['A'], ['A']); // 刷新 A，但 A 已经没有在售
  assert.equal(getItems().filter((i) => i.equipType === 'A').length, 0);
});

test('mergeItems: 已下架种类(不在 allTypes)从快照剔除', () => {
  setItems([item('A', 'a1', 100), item('C', 'c1', 300)]);
  // 本轮只见到 A（C 已经从种类列表消失），刷新的是 A
  mergeItems([item('A', 'a2', 90)], ['A'], ['A']);
  assert.equal(getItems().filter((i) => i.equipType === 'C').length, 0, 'C 已下架应剔除');
});

test('mergeItems: shardCount=1 语义(refreshed==all)等价于全量替换', () => {
  setItems([item('A', 'a1', 100), item('B', 'b1', 200)]);
  mergeItems([item('A', 'a2', 90), item('B', 'b2', 190)], ['A', 'B'], ['A', 'B']);
  const got = getItems();
  assert.deepEqual(got.map((i) => i.equipId).sort(), ['a2', 'b2']);
});
