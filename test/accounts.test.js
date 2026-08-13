// 账号管理的核心函数几乎都直接读写 server/admin/store.js 的固定 JSON 文件
// （data/accounts.json），不是纯函数、没法完全隔离。这里用"记录测试前的文件状态，
// 测试完整回滚"的方式，确保跑完这些测试不会污染真实账号数据——尤其是不能动到
// 正在使用的 storageState.json 关联关系。
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

function snapshotAccountsFile() {
  return existsSync(ACCOUNTS_FILE) ? readFileSync(ACCOUNTS_FILE, 'utf-8') : null;
}

function restoreAccountsFile(snapshot) {
  if (snapshot === null) {
    if (existsSync(ACCOUNTS_FILE)) rmSync(ACCOUNTS_FILE);
  } else {
    writeFileSync(ACCOUNTS_FILE, snapshot);
  }
}

test('accounts.js 核心行为（隔离测试，跑完自动回滚 data/accounts.json）', async (t) => {
  const before = snapshotAccountsFile();
  // 测试内容依赖一个干净的起点，如果这台机器已经有真实账号数据，先清空文件本身，
  // 测试结束后再用 before 的内容还原——不能在有真实数据的情况下运行这组测试逻辑
  // （会导致断言基于错误的初始状态）。
  if (existsSync(ACCOUNTS_FILE)) rmSync(ACCOUNTS_FILE);

  t.after(() => restoreAccountsFile(before));

  // 动态 import，确保每次都拿到当前 store.js 内存缓存的最新状态（store.js 的 load()
  // 有一层内存缓存，同一个进程内第一次读到什么就一直用那份缓存，所以测试必须用一个
  // 从未被读过 accounts 集合的全新模块实例——用 query string 强制 Node 重新加载模块）。
  const accounts = await import(`../server/admin/accounts.js?t=${Date.now()}`);

  await t.test('ensureDefaultAccount: 空文件时创建默认账号并标记活跃', () => {
    accounts.ensureDefaultAccount();
    const list = accounts.listAccounts();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '默认账号');
    assert.equal(list[0].isActive, true);
  });

  await t.test('ensureDefaultAccount: 已有账号时不重复创建（幂等）', () => {
    accounts.ensureDefaultAccount();
    assert.equal(accounts.listAccounts().length, 1);
  });

  let secondId;
  await t.test('createAccount: 新账号默认不活跃，storageStatePath 指向 data/accounts/{id}', () => {
    const second = accounts.createAccount({ name: '小号1' });
    secondId = second.id;
    assert.equal(second.isActive, false);
    assert.ok(second.storageStatePath.includes(path.join('data', 'accounts', `${second.id}.storageState.json`)));
    assert.equal(accounts.listAccounts().length, 2);
  });

  await t.test('switchActiveAccount: 切换后只有目标账号 isActive=true', () => {
    const activated = accounts.switchActiveAccount(secondId);
    assert.equal(activated.id, secondId);
    const list = accounts.listAccounts();
    const activeOnes = list.filter((a) => a.isActive);
    assert.equal(activeOnes.length, 1);
    assert.equal(activeOnes[0].id, secondId);
    assert.equal(accounts.getActiveAccount().id, secondId);
  });

  await t.test('switchActiveAccount: 切换到已经是活跃账号的账号，不报错、状态不变', () => {
    const activated = accounts.switchActiveAccount(secondId);
    assert.equal(activated.id, secondId);
    assert.equal(accounts.listAccounts().filter((a) => a.isActive).length, 1);
  });

  await t.test('switchActiveAccount: 账号不存在时抛错', () => {
    assert.throws(() => accounts.switchActiveAccount('not-a-real-id'), /账号不存在/);
  });

  await t.test('deleteAccount: 不能删除当前活跃账号', () => {
    assert.throws(() => accounts.deleteAccount(secondId), /活跃账号/);
  });

  await t.test('deleteAccount: 可以删除非活跃账号', () => {
    const first = accounts.listAccounts().find((a) => a.id !== secondId);
    accounts.deleteAccount(first.id);
    assert.equal(accounts.listAccounts().length, 1);
  });

  await t.test('updateAccount: 只允许更新白名单字段', () => {
    const updated = accounts.updateAccount(secondId, {
      name: '小号1改名',
      buyerRoleId: 'role-x',
      buyerServerId: 'server-y',
      isActive: false, // 不在白名单里，应该被忽略
    });
    assert.equal(updated.name, '小号1改名');
    assert.equal(updated.buyerRoleId, 'role-x');
    assert.equal(updated.buyerServerId, 'server-y');
    assert.equal(updated.isActive, true); // 忽略了尝试改动 isActive 的 patch
  });
});
