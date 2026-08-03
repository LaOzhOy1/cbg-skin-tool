// 纯 HTTP 版接口调用（不再用 Playwright 驱动浏览器），复用 cbg-skin-tool 第一版已经
// 抓包确认过的两层接口：
//   1. /cgi/api/get_aggregate_equip_type_list?kindid=3|4  — 皮肤种类列表
//   2. POST /cgi-bin/recommend.py?act=recommd_by_role      — 种类下具体在售个体商品
import { CATEGORIES } from '../src/config.js';
import { getCookieHeader } from './cookieJar.js';

const ORIGIN = 'https://yjwujian.cbg.163.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const EQUIP_LIST_PAGE_SIZE = 50;
const EQUIP_ITEM_PAGE_SIZE = 30;
const MAX_ITEM_PAGES_PER_TYPE = 5;

export class CaptchaRequiredError extends Error {
  constructor(msg) {
    super(msg || '触发安全验证 (CAPTCHA_AUTH)');
    this.name = 'CaptchaRequiredError';
  }
}

export class NotLoggedInError extends Error {
  constructor(msg) {
    super(msg || '未登录或登录态已失效');
    this.name = 'NotLoggedInError';
  }
}

function baseHeaders(referer) {
  const cookieHeader = getCookieHeader();
  if (!cookieHeader) throw new NotLoggedInError('未找到登录态，请先登录');
  return {
    Cookie: cookieHeader,
    'User-Agent': USER_AGENT,
    Referer: referer,
    Origin: ORIGIN,
  };
}

/** 检查响应体的 status_code，把风控/未登录错误转成明确的异常类型，不再静默吞掉。 */
function assertOk(json) {
  if (json.status_code === 'CAPTCHA_AUTH') {
    throw new CaptchaRequiredError(json.msg);
  }
  if (
    json.status_code === 'NEED_LOGIN' ||
    json.status_code === 'AUTO_LOGIN' ||
    json.status_code === 'MOBILE_AUTH' ||
    json.status === -1
  ) {
    // AUTO_LOGIN 实测出现在会话 cookie（sid 等）过期/需要刷新时，浏览器访问一次页面会
    // 自动轮转出新 cookie；MOBILE_AUTH 是风控升级到要求短信验证手机号。
    // 纯 HTTP 轮询没有自动刷新/短信验证的能力，统一当作"需要重新登录"处理，
    // 走已有的人工登录流程重新生成 storageState.json。
    throw new NotLoggedInError(json.msg);
  }
  if (json.status_code && json.status_code !== 'OK') {
    throw new Error(`接口返回异常: ${json.status_code} ${json.msg || ''}`);
  }
  return json;
}

async function fetchEquipTypes(category) {
  const referer = `${ORIGIN}/cgi/mweb/category/list?kindid=${category.kindid}&search_type=${category.searchType}`;
  const url =
    `${ORIGIN}/cgi/api/get_aggregate_equip_type_list?client_type=h5&count=${EQUIP_LIST_PAGE_SIZE}` +
    `&page=1&order_by=selling_time%20DESC&query_onsale=1&kindid=${category.kindid}&exter=direct`;
  const res = await fetch(url, { headers: baseHeaders(referer) });
  const json = assertOk(await res.json());
  return json.equip_type_list || [];
}

async function fetchEquipItems(category, equipType) {
  const referer = `${ORIGIN}/cgi/mweb/category/detail?search_type=${category.searchType}&equip_type=${equipType}&view_loc=equip_type_detail`;
  const items = [];
  for (let p = 1; p <= MAX_ITEM_PAGES_PER_TYPE; p++) {
    const body =
      `search_type=${category.searchType}&count=${EQUIP_ITEM_PAGE_SIZE}&pass_fair_show=1` +
      `&order_by=recommd&equip_type=${equipType}&view_loc=equip_type_detail&page=${p}&exter=direct`;
    const res = await fetch(`${ORIGIN}/cgi-bin/recommend.py?client_type=h5&act=recommd_by_role`, {
      method: 'POST',
      headers: { ...baseHeaders(referer), 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = assertOk(await res.json());
    const result = json.result || [];
    items.push(...result);
    if (json.paging?.is_last_page || result.length === 0) break;
  }
  return items;
}

function normalizeItem(item, category, typeInfo) {
  return {
    category: category.label,
    equipType: typeInfo.equip_type,
    typeName: typeInfo.equip_type_name,
    typeDesc: typeInfo.equip_type_desc,
    equipId: item.equipid,
    eid: item.eid,
    price: item.price / 100,
    serverName: item.server_name,
    serverId: item.serverid,
    gameOrdersn: item.game_ordersn,
    sellingTime: item.selling_time,
    icon: item.icon,
    // 购买页路由为 /order/confirm/:serverId/:ordersn（main.js 路由表 orderConfirm 确认），
    // 直接拼 URL，不需要先打开详情页、也不会代为点击购买。
    orderConfirmUrl: `${ORIGIN}/cgi/mweb/order/confirm/${item.serverid}/${item.game_ordersn}`,
  };
}

/** 抓取全部分类下的全部在售个体商品。命中风控/未登录时直接抛出，调用方（poller）负责状态切换。 */
export async function fetchAllSkins() {
  const all = [];
  for (const category of CATEGORIES) {
    const types = await fetchEquipTypes(category);
    for (const typeInfo of types) {
      const items = await fetchEquipItems(category, typeInfo.equip_type);
      for (const item of items) {
        all.push(normalizeItem(item, category, typeInfo));
      }
    }
  }
  return all;
}
