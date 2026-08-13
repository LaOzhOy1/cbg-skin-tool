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

export async function fetchEquipTypes(category) {
  const referer = `${ORIGIN}/cgi/mweb/category/list?kindid=${category.kindid}&search_type=${category.searchType}`;
  const url =
    `${ORIGIN}/cgi/api/get_aggregate_equip_type_list?client_type=h5&count=${EQUIP_LIST_PAGE_SIZE}` +
    `&page=1&order_by=selling_time%20DESC&query_onsale=1&kindid=${category.kindid}&exter=direct`;
  const res = await fetch(url, { headers: baseHeaders(referer) });
  const json = assertOk(await res.json());
  return json.equip_type_list || [];
}

/**
 * 查询单件商品的实时详情，用于下单前的二次确认。
 *
 * 抓包发现列表接口（recommend.py）返回的商品对象上完全没有公示期相关字段，只有
 * 详情接口才带 `allow_fair_show_buy`（是否允许在公示期内购买）——这是一个直接的布尔值，
 * 比之前尝试用 `fair_show_end_time` 时间戳推断公示期状态可靠得多（那个推测已经被证明有误：
 * 抓到的样本里 fair_show_end_time 已经过去，但 allow_fair_show_buy 依然是 false）。
 * 所以扫货引擎在真正下单前，必须调用这个函数用最新数据确认一次，不能只信轮询缓存里的列表数据。
 *
 * @param {{ serverId: string|number, gameOrdersn: string }} item
 */
export async function fetchEquipDetail(item) {
  const referer = `${ORIGIN}/cgi/mweb/equip/${item.serverId}/${item.gameOrdersn}`;
  const body = `serverid=${item.serverId}&ordersn=${item.gameOrdersn}&exclude_equip_desc=1&exter=direct`;
  const res = await fetch(`${ORIGIN}/cgi/api/get_equip_detail?client_type=h5`, {
    method: 'POST',
    headers: { ...baseHeaders(referer), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = assertOk(await res.json());
  const equip = json.equip || {};
  return {
    allowFairShowBuy: Boolean(equip.allow_fair_show_buy),
    status: equip.status,
  };
}

/**
 * 带星格/变异筛选条件的实时查询，用于扫货任务里配置了星格筛选的场景。
 *
 * 抓包确认的筛选参数（藏宝阁「星格」筛选面板对应的真实请求参数）：
 * - variation_unlock_num：星级（1/2/3），对应截图里的"1星/2星/3星"按钮
 * - variation_first/second/third/fourth：对应截图里的"星格1/星格2/星格3/星格4"输入框
 *
 * 这几个参数的具体数值语义（是"至少达到该数值"还是别的规则）没有抓到确凿的命中样本
 * 验证过，所以这里不在本地做任何数值解释或二次过滤，只是原样把用户填的值转发给藏宝阁，
 * 让藏宝阁自己的过滤逻辑决定结果——这样即使参数语义理解有偏差，也不会构造畸形请求，
 * 最坏情况只是筛选结果为空或不够精确，不存在下单风险。
 *
 * @param {{ kindid: number, searchType: string }} category
 * @param {string} equipType 具体皮肤种类 id
 * @param {{ starLevel?: number, slots?: (number|null)[] }} filters slots 最多 4 个，对应 first/second/third/fourth
 */
export async function searchItemsWithVariationFilter(category, equipType, filters = {}) {
  const referer = `${ORIGIN}/cgi/mweb/category/detail?search_type=${category.searchType}&equip_type=${equipType}&view_loc=equip_type_detail`;
  const params = new URLSearchParams({
    search_type: category.searchType,
    count: String(EQUIP_ITEM_PAGE_SIZE),
    pass_fair_show: '1',
    order_by: 'recommd',
    equip_type: equipType,
    view_loc: 'equip_type_detail',
    page: '1',
    exter: 'direct',
  });
  if (filters.starLevel) params.set('variation_unlock_num', String(filters.starLevel));
  const slotKeys = ['variation_first', 'variation_second', 'variation_third', 'variation_fourth'];
  (filters.slots || []).forEach((value, i) => {
    if (value !== null && value !== undefined && slotKeys[i]) params.set(slotKeys[i], String(value));
  });

  const items = [];
  for (let p = 1; p <= MAX_ITEM_PAGES_PER_TYPE; p++) {
    params.set('page', String(p));
    const res = await fetch(`${ORIGIN}/cgi-bin/recommend.py?client_type=h5&act=recommd_by_role`, {
      method: 'POST',
      headers: { ...baseHeaders(referer), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const json = assertOk(await res.json());
    const result = json.result || [];
    items.push(...result);
    if (json.paging?.is_last_page || result.length === 0) break;
  }
  return items;
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

export function normalizeItem(item, category, typeInfo) {
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
    // 列表接口（recommend.py）不带公示期相关字段（哪怕响应里有 fair_show_end_time，
    // 也已经证实不能用它判断是否可购买——见 fetchEquipDetail() 的说明）。
    // 真正的公示期判断必须在下单前调用 fetchEquipDetail() 用最新数据二次确认。
    // 购买页路由为 /order/confirm/:serverId/:ordersn（main.js 路由表 orderConfirm 确认），
    // 直接拼 URL，不需要先打开详情页、也不会代为点击购买。
    orderConfirmUrl: `${ORIGIN}/cgi/mweb/order/confirm/${item.serverid}/${item.game_ordersn}`,
  };
}

/** 抓取全部分类下的全部在售个体商品。命中风控/未登录时直接抛出，调用方（poller）负责状态切换。 */
/**
 * 查询当前登录账号的基础信息（手机号、网易通行证账号标识、手机绑定状态）。
 *
 * 抓包确认 get_user_data 的响应体里嵌了一份 login_info，字段：
 * - display_name / urs_account_id：这个账号是手机号注册的，两个字段都直接是手机号本身
 * - urs_account_type："mobile" 表示手机号注册
 * - urs：网易通行证内部账号标识，形如 "yd.xxxxxxxxxxxx@163.com"——这不是用户自己填的
 *   真实邮箱，是系统生成的内部标识，展示时不应该当作"邮箱"呈现，避免误导
 * - mobile_bind_status：布尔值，手机号是否已绑定
 *
 * 只在用户主动点"刷新账号信息"时调用一次，不做自动/周期性拉取。
 */
export async function fetchUserProfile() {
  const referer = `${ORIGIN}/cgi/mweb/`;
  const res = await fetch(`${ORIGIN}/cgi/api/get_user_data?client_type=h5&exter=direct`, {
    headers: baseHeaders(referer),
  });
  const json = assertOk(await res.json());
  const loginInfo = json.login_info || {};
  return {
    displayName: loginInfo.display_name || null,
    ursAccountId: loginInfo.urs_account_id || null,
    ursAccountType: loginInfo.urs_account_type || null,
    ursInternalId: loginInfo.urs || null,
    mobileBindStatus: Boolean(json.mobile_bind_status),
  };
}

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
