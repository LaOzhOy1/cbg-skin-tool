// 需求管理后台的持久化层：四个集合（requirements/plans/tasks/templates）各存一个 JSON 文件。
// 项目里没有数据库，量级也不大（单管理员、串行执行），JSON 文件 + 原子写足够了。
// 原子写方式：先写临时文件再 rename，避免进程中途崩溃写出半份 JSON。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const COLLECTIONS = ['requirements', 'plans', 'tasks', 'templates'];

function filePathFor(collection) {
  return path.join(DATA_DIR, `${collection}.json`);
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readCollection(collection) {
  const file = filePathFor(collection);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf-8');
  if (!raw.trim()) return [];
  return JSON.parse(raw);
}

function writeCollection(collection, records) {
  ensureDataDir();
  const file = filePathFor(collection);
  const tmpFile = `${file}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(records, null, 2));
  renameSync(tmpFile, file);
}

/** 简单的读改写内存缓存，避免每次操作都读一遍文件；持久化行为不变，仍然是原子写。 */
const cache = new Map();

function load(collection) {
  if (!cache.has(collection)) cache.set(collection, readCollection(collection));
  return cache.get(collection);
}

function persist(collection) {
  writeCollection(collection, cache.get(collection) || []);
}

function nowIso() {
  return new Date().toISOString();
}

export function list(collection) {
  return [...load(collection)];
}

export function get(collection, id) {
  return load(collection).find((r) => r.id === id) || null;
}

export function insert(collection, record) {
  const records = load(collection);
  const withDefaults = { id: randomUUID(), createdAt: nowIso(), updatedAt: nowIso(), ...record };
  records.push(withDefaults);
  persist(collection);
  return withDefaults;
}

/** 按 id 就地合并更新，找不到记录时抛错——调用方应该先确认记录存在。 */
export function update(collection, id, patch) {
  const records = load(collection);
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) throw new Error(`${collection} 里找不到 id=${id} 的记录`);
  records[index] = { ...records[index], ...patch, updatedAt: nowIso() };
  persist(collection);
  return records[index];
}

/** 按 id 删除记录，找不到时抛错。 */
export function remove(collection, id) {
  const records = load(collection);
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) throw new Error(`${collection} 里找不到 id=${id} 的记录`);
  records.splice(index, 1);
  persist(collection);
}

export const COLLECTION_NAMES = COLLECTIONS;
