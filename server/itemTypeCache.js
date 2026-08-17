// 商品"种类"图片缓存：滚动保留最近 7 天见过的皮肤种类（不是具体挂售商品），
// 用于 /sweep 页面的可视化选品网格。数据来源是 poller.js 每轮轮询本来就会拉到的
// 种类列表响应（见 cbgClient.js 的 fetchAllSkins() 的 seenTypes），这里不产生任何
// 新的网络请求去获取种类信息——唯一新增的网络调用是下载种类缩略图，且只在本地还
// 没有这张图时才下载一次，不是每轮重新下载。
//
// 用 equipType 本身做记录的 id（天然唯一，不用 randomUUID），upsert 语义靠
// get()/update()/insert() 组合实现——store.js 没有原生 upsert，这里手动判断。
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { list, get, insert, update, remove } from './admin/store.js';
import { summarizeRisk } from './riskGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = path.join(__dirname, '..', 'public', 'item-cache');
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function imageFilePath(equipType) {
  return path.join(IMAGE_DIR, `${equipType}.jpg`);
}

function localImagePathFor(equipType) {
  return `item-cache/${equipType}.jpg`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 下载一张种类缩略图到本地（如果本地还没有）。失败不抛出——图片只是展示用的
 * 辅助信息，下载失败不该影响轮询主流程，调用方看到 localImagePath 为 null 时
 * 前端会退化成占位块，仍然可以正常选品。
 */
async function ensureImageDownloaded(equipType, imgUrl) {
  if (!imgUrl) return null;
  const risk = summarizeRisk({ operation: 'itemTypeCache.ensureImageDownloaded', profile: 'image_download' });
  if (!risk.allow) return null;
  const filePath = imageFilePath(equipType);
  if (existsSync(filePath)) return localImagePathFor(equipType);
  try {
    const res = await fetch(imgUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!existsSync(IMAGE_DIR)) mkdirSync(IMAGE_DIR, { recursive: true });
    await writeFile(filePath, buffer);
    return localImagePathFor(equipType);
  } catch {
    // 网络问题/图床变化等，不阻塞轮询，下一轮见到同一种类会再试一次
    return null;
  }
}

/**
 * 记录这一轮轮询见过的种类摘要（upsert），并按需下载缺失的缩略图。
 * @param {{ category: 'hero'|'weapon', equipType: string, typeName: string, typeDesc: string, minPrice: number|null, imgUrl: string|null }[]} types
 */
export async function recordSeenTypes(types) {
  for (const type of types) {
    const existing = get('itemTypeCache', type.equipType);
    const localImagePath = existing?.localImagePath || (await ensureImageDownloaded(type.equipType, type.imgUrl));
    const fields = {
      category: type.category,
      equipType: type.equipType,
      typeName: type.typeName,
      typeDesc: type.typeDesc,
      minPrice: type.minPrice,
      localImagePath,
      lastSeenAt: nowIso(),
    };
    if (existing) {
      update('itemTypeCache', type.equipType, fields);
    } else {
      insert('itemTypeCache', { id: type.equipType, firstSeenAt: nowIso(), ...fields });
    }
  }
}

/** 删除 lastSeenAt 早于 7 天前的记录，并删除对应的本地缩略图文件。纯本地操作，无网络请求。 */
export function pruneExpired(at = new Date()) {
  const cutoff = at.getTime() - RETENTION_MS;
  const expired = list('itemTypeCache').filter((r) => new Date(r.lastSeenAt).getTime() < cutoff);
  for (const record of expired) {
    if (record.localImagePath) {
      const filePath = path.join(__dirname, '..', 'public', record.localImagePath);
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // 文件删除失败不阻塞记录清理，最坏情况是留下一张孤立图片文件
        }
      }
    }
    remove('itemTypeCache', record.id);
  }
}

/** 供 /sweep 页面的可视化选品网格读取，按 category 过滤 + 最近见过的排前面。 */
export function listCachedTypes(category) {
  return list('itemTypeCache')
    .filter((r) => r.category === category)
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
}
