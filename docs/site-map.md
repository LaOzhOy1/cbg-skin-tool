# 藏宝阁页面 / 接口对照表

人工在浏览器里点击页面时，被动记录下来的「页面 → 触发的接口」对应关系。用 `npm run watch-browser` 打开的监听窗口只被动记录浏览器自己发出的请求，不会主动重复调用接口（遵守 [CLAUDE.md](../CLAUDE.md) 里的铁律）。

## 记录格式

每条记录包含：
- **页面**：你点击到的页面名称/URL
- **接口**：该页面加载时触发的关键请求（method + path，query/body 里的关键参数）
- **用途**：这个接口是干什么的（列表/详情/下单等）
- **备注**：命名、返回结构等值得记下来的细节

## 已知接口（代码里已有，供对照）

| 页面 | 接口 | 用途 |
| --- | --- | --- |
| 分类列表 `/cgi/mweb/category/list?kindid=3\|4` | `GET /cgi/api/get_aggregate_equip_type_list` | 拉某个 kindid 下的皮肤「种类」列表 |
| 种类详情 `/cgi/mweb/category/detail?equip_type=...` | `POST /cgi-bin/recommend.py?act=recommd_by_role` | 拉某个种类下具体在售的个体商品 |
| 下单确认 | `/cgi/mweb/order/confirm/:serverId/:ordersn` | 商品下单确认页（工具只拼链接，不代为下单） |

## 首页三个入口的分类参数

| 首页入口 | kindid | search_type | 代码里是否已支持 |
| --- | --- | --- | --- |
| 英雄皮肤 | `3` | `role_skin` | 已支持（`src/config.js` CATEGORIES） |
| 兵器皮肤 | `4` | `weapon_skin` | 已支持（`src/config.js` CATEGORIES） |
| 道具 | `5,6`（两个 kindid 合并查询） | `daoju` | **未支持**，`get_aggregate_equip_type_list` 的 `kindid` 参数要传 `5,6`（逗号分隔），其余请求结构和皮肤分类一致 |

点击「道具」入口后完整跳转 URL：
```
/cgi/mweb/category/list?kindid=5,6&search_type=daoju&order_by=unit_price%20ASC&is_random_draw=0
```
触发接口（顺序）：
1. `GET /cgi/api/get_aggregate_equip_type_list?...&kindid=5,6&query_onsale=1` — 在售的道具种类
2. `GET /cgi/api/get_aggregate_equip_type_list?...&kindid=5,6&query_onsale=0` — 非在售的道具种类
3. `POST /cgi-bin/recommend.py?act=recommd_by_role` — 具体商品，接口结构和皮肤分类相同

### 英雄皮肤 / 兵器皮肤复核（2026-08-12）

从首页分别点击「英雄皮肤」「兵器皮肤」入口复核，均与 `src/config.js` 里 `CATEGORIES` 记录的参数一致：

| 入口 | 跳转 URL | 备注 |
| --- | --- | --- |
| 英雄皮肤 | `/cgi/mweb/category/list?kindid=3&search_type=role_skin&order_by=unit_price%20ASC&is_random_draw=0` | 这次只观察到一次 `query_onsale=1` 请求，没有 `query_onsale=0` |
| 兵器皮肤 | `/cgi/mweb/category/list?kindid=4&search_type=weapon_skin&order_by=unit_price%20ASC&is_random_draw=0` | 这次观察到 `query_onsale=1` 和 `query_onsale=0` 两次请求 |

**更正之前的推断**：早先记录道具页面时，误以为「`query_onsale=0` 请求只在道具页面才有，皮肤分类页面没有」——现在兵器皮肤页面同样触发了这个请求，说明这不是按分类类型区分的规律，更像是和页面切换路径/缓存状态有关（比如是否刚从别的分类页面跳过来）。具体触发条件还没查清楚，先如实记录现象，不要照搬之前的错误结论。

### 种类详情页（2026-08-12）

从兵器皮肤列表点进某个具体「种类」（比如某把武器的皮肤种类）时：

- 跳转 URL：`/cgi/mweb/category/detail?search_type=weapon_skin&equip_type=2310049&view_loc=equip_type_detail`（结构与 `src/config.js` 的 `equipTypeDetailUrl()` 一致）
- 触发接口：
  | 接口 | 用途（推测） |
  | --- | --- |
  | `GET /cgi/api/get_equip_type_selling_info?equip_type=...&view_loc=equip_type_detail` | 查该种类的在售统计信息（**代码里目前没有调用过这个接口**，可能是最低价/在售数量摘要，和 `recommend.py` 拉的个体商品列表是两个不同用途） |
  | `POST /cgi-bin/recommend.py?act=recommd_by_role` | 该种类下具体在售个体商品，和 `cbgClient.js` 现有逻辑一致 |

### 商品详情页（2026-08-12）

从种类详情页点某个具体商品，会用 `target="_blank"` **新开一个标签页**（`watchBrowser.js` 已修复为能捕获新标签页，见下方工具说明），跳到：

```
/cgi/mweb/equip/{serverid}/{ordersn}?reco_request_id=...&tag=latest&exposed_scene_id=...&refer_sn=...
```

例：`/cgi/mweb/equip/2/38f8aac2916d45e3a2ec38cb3db4aa73`，其中 `2` 是 `serverid`，`38f8aac2916d45e3a2ec38cb3db4aa73` 是 `ordersn`（和 `cbgClient.js` 里 `normalizeItem()` 拼 `orderConfirmUrl` 用的字段一致）。

触发接口（新的，代码里都还没用到）：

| 接口 | 用途（推测） |
| --- | --- |
| `POST /cgi/api/get_equip_detail?client_type=h5` | 拉这件商品的完整详情数据 |
| `GET /cgi/api/get_equip_desc?serverid=...&ordersn=...` | 拉卖家自定义描述，返回 307 重定向到 CDN 静态 JSON：`https://cbg-other-desc.res.netease.com/yjwujian/static/equipdesc/{ordersn}.json` |
| `POST /cgi-bin/recommend.py?act=similar` | 相似商品推荐列表 |

页面停留几秒后又调用了一次 `get_mobile_bind_info`，和首页加载时一样，看起来是全站通用的检测，不是详情页特有的。

**复核**：随后点了一件兵器皮肤的具体商品（`/cgi/mweb/equip/2/c24deb5fe4e94186b68d47bc014c5bc5`），触发的接口顺序和字段结构与英雄皮肤商品详情页完全一致（`get_equip_detail` → `get_equip_desc` 307 到 CDN → `recommend.py?act=similar`）。确认「商品详情页」这套接口是全品类通用的，不区分英雄皮肤/兵器皮肤。

### 下单 + 支付流程（2026-08-12）

⚠️ 这次操作是一次**真实下单**（`add_order` 返回 200，生成了真实订单号），不只是浏览。工具本身没有代为点击任何一步，全程都是人工操作，被动监听只是记录。

流程分三段：

**1. 商品详情页 → 点购买 → 订单确认页**

跳转：`/cgi/mweb/order/confirm/{serverid}/{ordersn}?lprice={单位待确认，可能是分}&origin_equip_desc_version=...`

| 接口 | 用途（推测） |
| --- | --- |
| `GET /cgi/api/get_equip_desc?serverid=...&ordersn=...`（无 `h5_device` 参数，和详情页那次不同） | 确认页重新拉一次商品描述 |
| `POST /cgi/api/preview_order?client_type=h5` | 预览订单金额等信息，选项变化时会重复调用 |
| `GET /cgi/api/get_coupon_info_of_trade?...&sub_act=get_default_coupon` | 查可用优惠券/默认优惠券 |
| `POST /cgi/api/get_checkout_display?client_type=h5` | 结算页展示信息（返回给前端渲染用） |

**2. 提交订单**

| 接口 | 用途 |
| --- | --- |
| `POST /cgi/api/add_order?client_type=h5` | **提交订单，真正生成订单**，返回 200 后订单已创建（未必已支付） |
| `POST /cgi/api/get_order_pay_info?client_type=h5` | 获取支付所需信息（跳转支付收银台用） |

**3. 网易支付收银台**（跳到 `epay.163.com`，不是藏宝阁自己的域名，是网易统一支付网关）

| 接口 | 用途 |
| --- | --- |
| `GET /cashier/mainCash/getPayMethodWithAccountInfo` | 查可用支付方式 |
| `GET /cashier/mainCash/getQRCodeImg` | 获取支付二维码图片 |
| `GET /cashier/mainCash/ajaxQueryOrderState`（**每 5 秒轮询一次**） | 查订单支付状态，等待用户扫码完成后状态会变 |
| `GET /cashier/mainCash/checkQRCodeImg`（每 5 秒轮询一次） | 查二维码是否已被扫描 |

**提醒**：整套支付流程走完全靠用户本人扫码/输入支付密码完成，工具/脚本没有也不应该介入这一步（对应 README「不做自动下单」的边界）。如果测试性质点了下单但不打算真的付款，记得去「我的订单」把未支付订单取消，避免留下挂着的订单。

**4. 支付完成后跳回藏宝阁**

扫码支付完成后，`epay.163.com` 自动跳转回：

```
/cgi/mweb/order/result?orderid_to_epay={serverid}_{epay订单号}
```

| 接口 | 用途（推测） |
| --- | --- |
| `GET /cgi/api/check_order_pay_result?orderid_to_epay_list=...` | **查询订单是否支付成功的关键接口**，结果页加载时立即调用 |
| `GET /cgi/api/get_realname_status` | 查实名认证状态 |
| `GET /cgi/api/event_ad?event=pay&orderid_to_epay_list=...` | 支付完成埋点上报 |

注：`watchBrowser.js` 只记录请求 URL 和响应状态码，不解析响应体，所以看不到 `check_order_pay_result` 返回的具体支付状态字段（成功/处理中/失败），只能看到"调用了这个接口"。要确认订单真实状态，以页面上显示的文案或去「我的订单」页面查看为准。

**5. 订单详情页**（从结果页/我的订单点进具体订单）

跳转：`/cgi/mweb/order/detail/{serverid}_{epay订单号}`（例：`/cgi/mweb/order/detail/2_23667148`）

| 接口 | 用途 |
| --- | --- |
| `GET /cgi/api/get_order_detail?orderid_to_epay=...` | 查询订单详情，**应包含最终支付/交易状态字段**，但响应体内容监听工具没解析，具体状态要看页面文案 |

## 工具说明：多标签页监听

`tools/watchBrowser.js` 一开始只监听了初始的单个 `page`，漏掉了藏宝阁很多商品链接用 `target="_blank"` 新开标签页的情况（点商品详情时完全没被记录）。已修复：现在监听 `context.on('page', ...)` 事件，为每个新标签页单独挂监听并打上 `[标签页#N]` 前缀区分。修复时注意到一个坑：`context.on('page')` 对 `context.newPage()` 创建的初始页面也会触发一次，如果同时手动给初始 page 挂一遍监听会导致每条日志重复打印两次——所以初始页面完全交给 `context.on('page')` 事件来挂监听，不要重复挂。

## 人工浏览记录（持续补充）

<!-- 在这里追加新记录，格式参考上面的表格，不要删除已有条目 -->

### 首页加载（2026-08-12）

进入 `https://yjwujian.cbg.163.com/cgi/mweb/` 时观察到的接口调用（按触发顺序）：

| 接口 | 用途（推测） |
| --- | --- |
| `GET /cgi/api/get_login_info` | 查询当前登录信息 |
| `GET /cgi/api/get_user_data` | 查询用户数据（昵称/余额等） |
| `GET /cgi/api/get_auto_topics` | 首页自动推荐专题 |
| `GET /cgi/api/get_mobile_bind_info` | 查询手机号绑定状态（和 `MOBILE_AUTH` 风控可能相关，值得关注） |
| `POST /cgi-bin/recommend.py?act=recommd_by_role` | 首页推荐商品列表（和 `cbgClient.js` 里拉具体商品用的是同一个接口） |
| `GET https://dc.cbg.163.com/cgi/ad/ad_config?...` | 广告/运营配置，非核心数据 |

### 手机验证页面（2026-08-12）

从首页进入「手机验证」页面时触发：

| 接口 | 用途（推测） |
| --- | --- |
| `POST /cgi/api/get_sms_code?client_type=h5` | 获取/发送短信验证码（点击"获取验证码"按钮触发） |

输入验证码并提交时触发：

| 接口 | 用途（推测） |
| --- | --- |
| `POST /cgi/api/verify_sms_code?client_type=h5` | 提交短信验证码校验，返回 200 后页面自动跳回首页并重新拉取 `get_auto_topics` / `recommend.py`，视为验证通过的信号 |
