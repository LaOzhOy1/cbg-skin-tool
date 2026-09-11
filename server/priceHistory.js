// 历史最低价时序存储：把 poller 每轮本来就会拿到的种类最低价（seenTypes 里的 minPrice）
// 按"种类 + 小时桶"落成时序数据，供 market-v2 画趋势曲线。
//
// 边界（重要）：数据源是 poller.js 的 fetchAllSkins() 已经飞过的 seenTypes，这里
// **不产生任何新的网络请求**——只是把原本每轮丢弃的最低价数字追加进本地时序，
// 和 itemTypeCache.js 复用同一份数据的思路一致。
//
// 存储后端：Node 自带的 node:sqlite（DatabaseSync）。选它的理由——它是真正的
// 嵌入式数据库（带索引、SQL 聚合、事务），但零外部依赖、无需起服务器，完全符合本项目
// "本地、单进程、无基础设施"的定位（对照 store.js 的 JSON 方案，这里数据是时序、按范围
// 查询、会持续增长，用带索引的 SQL 表比 JSON 全量读写更合适）。
//
// 为什么按小时分桶：poller 默认 20 秒一轮 = 每天 ~4320 轮，几十个种类每轮都存会让表
// 迅速膨胀且没有信息量。按小时桶只保留"这一小时内见过的最低价"，30 天 = 720 行/种类，
// 量级可控，也正好符合"实时最低价（允许延迟）"的定位。
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// node:sqlite 目前是 experimental，import 时会打一条 ExperimentalWarning。
// 只过滤这一条警告，其余警告照常透传，import 结束后立刻恢复原始 emitWarning。
const _origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : warning?.message || '';
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return _origEmitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = _origEmitWarning;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'priceHistory.db');

const BUCKET_MS = 60 * 60 * 1000; // 1 小时一个桶
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 保留 30 天

let db = null;

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      equip_type TEXT NOT NULL,
      bucket_ts  INTEGER NOT NULL,
      min_price  REAL NOT NULL,
      category   TEXT,
      type_name  TEXT,
      PRIMARY KEY (equip_type, bucket_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_bucket ON price_history (bucket_ts);
  `);
}

function getDb() {
  if (db) return db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL'); // 读（路由）与写（poller）并发更顺
  initSchema(db);
  return db;
}

function bucketStart(ts) {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

/**
 * 记录这一轮 seenTypes 里的最低价（每种类一个点，落到当前小时桶）。
 * 同一小时内多次记录取更低的价格（"这一小时见过的最低价"）。
 * minPrice 为 null（无在售）的种类跳过——没有价格就没有趋势点。
 *
 * @param {{ category:'hero'|'weapon', equipType:string, typeName:string, minPrice:number|null }[]} seenTypes
 * @param {number} [now] 便于测试注入时间
 */
export function recordPriceHistory(seenTypes, now = Date.now()) {
  const database = getDb();
  const bucket = bucketStart(now);
  // 同桶取更低价：主键冲突时用 MIN(已存, 新值)。种类名/分类随最新一轮更新。
  const upsert = database.prepare(`
    INSERT INTO price_history (equip_type, bucket_ts, min_price, category, type_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (equip_type, bucket_ts) DO UPDATE SET
      min_price = MIN(price_history.min_price, excluded.min_price),
      category  = excluded.category,
      type_name = excluded.type_name
  `);
  database.exec('BEGIN');
  try {
    let wrote = false;
    for (const t of seenTypes) {
      if (t.minPrice == null) continue;
      upsert.run(String(t.equipType), bucket, t.minPrice, t.category, t.typeName);
      wrote = true;
    }
    database.exec('COMMIT');
    if (wrote) pruneExpired(now);
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
}

/** 删除早于 30 天的时序点。纯本地操作。 */
export function pruneExpired(now = Date.now()) {
  const database = getDb();
  database.prepare('DELETE FROM price_history WHERE bucket_ts < ?').run(now - RETENTION_MS);
}

/**
 * 读取某种类的价格时序，供 /api/market/price-history 使用。
 * @returns {{ equipType:string, category:string, typeName:string, points:{t:number,min:number}[] } | null}
 */
export function getPriceHistory(equipType) {
  const database = getDb();
  const key = String(equipType);
  const rows = database
    .prepare('SELECT bucket_ts AS t, min_price AS min, category, type_name FROM price_history WHERE equip_type = ? ORDER BY bucket_ts ASC')
    .all(key);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return {
    equipType: key,
    category: last.category,
    typeName: last.type_name,
    points: rows.map((r) => ({ t: r.t, min: r.min })),
  };
}

/**
 * 测试辅助：把模块切到一个全新的内存库（:memory:），让每个用例从干净状态开始、
 * 不碰磁盘（遵守 CLAUDE.md 里"测试不污染真实数据文件"的要求）。
 */
export function _resetCacheForTest() {
  if (db) {
    try {
      db.close();
    } catch {
      // 忽略关闭异常
    }
  }
  db = new DatabaseSync(':memory:');
  initSchema(db);
}
