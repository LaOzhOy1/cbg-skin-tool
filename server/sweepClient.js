// 扫货任务用到的真实站点调用。复用 cbgClient.js 已经验证过的错误类型和请求头拼装方式，
// 不重新定义一套。
//
// placeOrder() 的请求参数格式已经两次独立抓包确认一致（preview_order/add_order），
// 详见 docs/site-map.md「下单成功后的响应体格式」一节。roleid/buyer_serverid 曾经固定用
// 环境变量配置——账号管理上线后改成从账号记录（server/admin/accounts.js）的
// buyerRoleId/buyerServerId 字段读取，每个账号自己的买家角色分开配置，不再是进程全局的。
//
// checkPaymentResult() 的请求（URL + GET）有真实依据，但响应体具体字段名没有抓到真实
// 已支付样本确认过（抓包时故意没有真的扫码付款，避免真实扣款），判定"已支付"时故意保守。
import { CaptchaRequiredError, NotLoggedInError } from './cbgClient.js';
import { getCookieHeader } from './cookieJar.js';
import { assertNetworkSafe, noteRiskSignal } from './riskGuard.js';

const ORIGIN = 'https://yjwujian.cbg.163.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class BuyerRoleNotConfiguredError extends Error {
  constructor() {
    super('下单需要配置买家角色：请在账号管理页面给当前账号填写买家角色 ID 和服务器 ID');
    this.name = 'BuyerRoleNotConfiguredError';
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

function guardedRequest(meta, request) {
  assertNetworkSafe(meta);
  return request();
}

function assertOk(json) {
  if (json.status_code === 'CAPTCHA_AUTH') {
    noteRiskSignal('captcha_auth', json.msg || '', 'high');
    throw new CaptchaRequiredError(json.msg);
  }
  if (
    json.status_code === 'NEED_LOGIN' ||
    json.status_code === 'AUTO_LOGIN' ||
    json.status_code === 'MOBILE_AUTH' ||
    json.status === -1
  ) {
    const severity = json.status_code === 'MOBILE_AUTH' ? 'high' : 'medium';
    noteRiskSignal(String(json.status_code || 'not_logged_in').toLowerCase(), json.msg || '', severity);
    throw new NotLoggedInError(json.msg);
  }
  if (json.status_code && json.status_code !== 'OK') {
    throw new Error(`接口返回异常: ${json.status_code} ${json.msg || ''}`);
  }
  return json;
}

function buyerRole(account) {
  const roleId = account?.buyerRoleId;
  const serverId = account?.buyerServerId;
  if (!roleId || !serverId) throw new BuyerRoleNotConfiguredError();
  return { roleId, serverId };
}

/**
 * 下单：先调一次带完整买家信息的 preview_order 确认（抓包发现这一步不能跳过，
 * add_order 的请求体和这次 preview_order 完全一样），再提交 add_order。
 *
 * 请求参数格式两次独立抓包结果一致：
 *   serverid / ordersn / roleid / buyer_serverid / confirm_price_total（单位：分）
 *
 * add_order 成功后的响应体（已抓包确认）：
 *   { status: 1, status_code: "OK", order: { orderid_to_epay: "2_23690157", price_total: 245000, ... } }
 * order.orderid_to_epay 已经是完整的 "serverId_订单号" 格式，可以直接传给
 * checkPaymentResult()，不需要再拼接。
 *
 * @param {{ serverId: string|number, gameOrdersn: string, price: number }} item 命中匹配条件的商品
 * @param {{ buyerRoleId: string, buyerServerId: string }} account 用哪个账号的买家角色下单
 * @returns {Promise<{ orderIdToEpay: string, priceTotal: number }>}
 */
export async function placeOrder(item, account) {
  const { roleId, serverId: buyerServerId } = buyerRole(account);
  const referer = `${ORIGIN}/cgi/mweb/order/confirm/${item.serverId}/${item.gameOrdersn}`;
  const confirmPriceTotal = Math.round(item.price * 100);
  const body =
    `serverid=${item.serverId}&ordersn=${item.gameOrdersn}&roleid=${roleId}` +
    `&buyer_serverid=${buyerServerId}&confirm_price_total=${confirmPriceTotal}&view_loc=hag_msg&exter=direct`;

  const previewRes = await guardedRequest(
    { operation: 'sweep.previewOrder', profile: 'place_order' },
    () =>
      fetch(`${ORIGIN}/cgi/api/preview_order?client_type=h5`, {
        method: 'POST',
        headers: { ...baseHeaders(referer), 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
  );
  assertOk(await previewRes.json());

  const addRes = await guardedRequest(
    { operation: 'sweep.addOrder', profile: 'place_order' },
    () =>
      fetch(`${ORIGIN}/cgi/api/add_order?client_type=h5`, {
        method: 'POST',
        headers: { ...baseHeaders(referer), 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
  );
  const addJson = assertOk(await addRes.json());
  const order = addJson.order || {};
  if (!order.orderid_to_epay) {
    throw new Error(`add_order 返回里没有 orderid_to_epay: ${JSON.stringify(addJson).slice(0, 500)}`);
  }
  return { orderIdToEpay: order.orderid_to_epay, priceTotal: order.price_total };
}

/**
 * 查询订单是否已支付成功，复用 docs/site-map.md 记录过的
 * GET /cgi/api/check_order_pay_result?orderid_to_epay_list=... 接口。
 *
 * 请求本身（URL + GET）在 docs/site-map.md 里有真实依据，但响应体的具体字段名没有抓到
 * 真实已支付样本确认过（抓包时故意没有真的扫码付款，避免真实扣款）——所以判定"已支付"时
 * 故意保守：只有明确匹配到已知的成功标记才返回 paid=true，拿不准就返回 false
 * （宁可多等一轮重新查，也不要把未支付误判成已支付导致计数错误）。
 * 同时把原始响应体一起返回，方便日后用真实抓包结果校准这里的字段名猜测。
 *
 * @param {string} orderIdToEpay 完整的 "serverId_订单号" 字符串，来自 placeOrder() 的返回值
 * @returns {Promise<{ paid: boolean, raw: any }>}
 */
export async function checkPaymentResult(orderIdToEpay) {
  const referer = `${ORIGIN}/cgi/mweb/order/result?orderid_to_epay=${orderIdToEpay}`;
  const url = `${ORIGIN}/cgi/api/check_order_pay_result?client_type=h5&orderid_to_epay_list=${orderIdToEpay}`;
  const res = await guardedRequest(
    { operation: 'sweep.checkPaymentResult', profile: 'payment_check' },
    () => fetch(url, { headers: baseHeaders(referer) })
  );
  const json = assertOk(await res.json());

  const result = json.result || json.pay_result_list || [];
  const entry = Array.isArray(result)
    ? result.find((r) => String(r.orderid_to_epay || r.order_id) === orderIdToEpay)
    : null;
  if (!entry) return { paid: false, raw: json };

  const status = String(entry.pay_status ?? entry.status ?? '').toUpperCase();
  const paid = status === 'PAID' || status === 'SUCCESS' || status === '1' || entry.pay_status === 1;
  return { paid, raw: json };
}
