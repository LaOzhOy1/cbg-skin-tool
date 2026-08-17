// itemTypeCache.js 直接读写 server/admin/store.js 的固定 JSON 文件（data/itemTypeCache.json），
// 和 test/accounts.test.js 一样用"记录测试前文件状态，测试完整回滚"的方式隔离，不污染真实缓存数据。
// 图片下载逻辑（ensureImageDownloaded）不在这里测——那部分需要真实网络请求，遵守 CLAUDE.md
// 的铁律不写脚本反复探测真实接口；这里只测 upsert/过期清理这些纯本地逻辑，
// recordSeenTypes() 的测试用例故意都传 imgUrl: null，跳过下载分支，不产生任何网络请求。
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '..', 'data', 'itemTypeCache.json');

function snapshotCacheFile() {
  return existsSync(CACHE_FILE) ? readFileSync(CACHE_FILE, 'utf-8') : null;
}

function restoreCacheFile(snapshot) {
  if (snapshot === null) {
    if (existsSync(CACHE_FILE)) rmSync(CACHE_FILE);
  } else {
    writeFileSync(CACHE_FILE, snapshot);
  }
}

function mockType(overrides = {}) {
  return {
    category: 'hero',
    equipType: '1001',
    typeName: '测试皮肤',
    typeDesc: '金 | 测试',
    minPrice: 100,
    imgUrl: null, // 故意传 null，跳过下载分支，不产生网络请求
    ...overrides,
  };
}

test('itemTypeCache.js 核心行为（隔离测试，跑完自动回滚 data/itemTypeCache.json）', async (t) => {
  const before = snapshotCacheFile();
  if (existsSync(CACHE_FILE)) rmSync(CACHE_FILE);
  t.after(() => restoreCacheFile(before));

  const cache = await import(`../server/itemTypeCache.js?t=${Date.now()}`);

  await t.test('recordSeenTypes: 新种类插入记录，firstSeenAt/lastSeenAt 都被设置', async () => {
    await cache.recordSeenTypes([mockType()]);
    const list = cache.listCachedTypes('hero');
    assert.equal(list.length, 1);
    assert.equal(list[0].equipType, '1001');
    assert.equal(list[0].typeName, '测试皮肤');
    assert.ok(list[0].firstSeenAt);
    assert.ok(list[0].lastSeenAt);
    assert.equal(list[0].localImagePath, null);
  });

  await t.test('recordSeenTypes: 再次见到同一种类只更新 lastSeenAt，不重复插入', async () => {
    const firstSeenBefore = cache.listCachedTypes('hero')[0].firstSeenAt;
    await cache.recordSeenTypes([mockType({ minPrice: 200 })]);
    const list = cache.listCachedTypes('hero');
    assert.equal(list.length, 1);
    assert.equal(list[0].minPrice, 200);
    assert.equal(list[0].firstSeenAt, firstSeenBefore);
  });

  await t.test('listCachedTypes: 按 category 过滤', async () => {
    await cache.recordSeenTypes([mockType({ category: 'weapon', equipType: '2001', typeName: '测试武器皮肤' })]);
    assert.equal(cache.listCachedTypes('hero').length, 1);
    assert.equal(cache.listCachedTypes('weapon').length, 1);
    assert.equal(cache.listCachedTypes('weapon')[0].typeName, '测试武器皮肤');
  });

  await t.test('listCachedTypes: 按 lastSeenAt 倒序排列（最近见过的在前）', async () => {
    await cache.recordSeenTypes([mockType({ equipType: '1002', typeName: '较早看到' })]);
    // 等待 1ms 确保时间戳不同，避免同一毫秒内两条记录排序不稳定
    await new Promise((r) => setTimeout(r, 5));
    await cache.recordSeenTypes([mockType({ equipType: '1003', typeName: '较晚看到' })]);
    const list = cache.listCachedTypes('hero');
    const names = list.map((r) => r.typeName);
    assert.ok(names.indexOf('较晚看到') < names.indexOf('较早看到'));
  });

  await t.test('pruneExpired: 7 天内的记录不会被删除', () => {
    const before = cache.listCachedTypes('hero').length;
    cache.pruneExpired(new Date());
    assert.equal(cache.listCachedTypes('hero').length, before);
  });

  await t.test('pruneExpired: 超过 7 天的记录会被删除', () => {
    const eightDaysLater = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    cache.pruneExpired(eightDaysLater);
    assert.equal(cache.listCachedTypes('hero').length, 0);
    assert.equal(cache.listCachedTypes('weapon').length, 0);
  });
});
