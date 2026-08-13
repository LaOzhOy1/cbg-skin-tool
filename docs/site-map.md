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

## 工具说明：记录 POST 请求体（2026-08-13）

`page.on('request', ...)` 原来只记录了 `method` 和 `url`，看不到 POST 请求的具体请求体内容。已升级：用 Playwright 的 `request.postData()` 读取请求体一并记录。这个方法只是读取浏览器已经构造好、即将发出的请求内容，不会额外触发任何网络请求，依然是纯被动监听，符合 CLAUDE.md 里的铁律。

## 工具说明：记录响应体（2026-08-13）

`page.on('response', ...)` 原来只记录状态码，看不到响应体内容。已升级：对 `recommend.py`/`get_equip_detail`/`get_aggregate_equip_type_list`/`add_order`/`get_order_pay_info`/`check_order_pay_result` 这几个接口额外读取 `res.text()` 并记录（截断到 4000 字符，避免日志过大），其余接口（广告配置等无关请求）仍然只记状态码。`res.text()` 读取的是浏览器已经收到的响应内容，不会触发任何新请求，依然是纯被动监听。

## 公示期判断：`allow_fair_show_buy`（2026-08-13，已确认，但有混杂因素）

藏宝阁商品发起交易后有一段强制公示期，期间不能真正下单购买。抓包过程走过两轮：

1. **第一轮推测（已证实错误）**：以为 `fair_show_end_time`（列表/详情接口都有的时间戳字段）晚于当前时间就代表仍在公示期。抓到的样本推翻了这个推测——`fair_show_end_time` 已经过去（如 `2026-08-03`），但商品依然不可购买。
2. **第二轮确认**：`get_equip_detail` 响应体里有一个直接的布尔字段 `allow_fair_show_buy`，抓到的 5 个样本全是 `false`，同时还有一个 `equip_lock_time_desc`（锁定截止时间，测试期间数值一直在变化）。**这个字段只存在于详情接口 `get_equip_detail`，不存在于列表接口 `recommend.py`**——意味着扫货引擎不能只靠轮询缓存判断公示期，必须在下单前调用详情接口二次确认（已在 `server/cbgClient.js` 实现为 `fetchEquipDetail()`，`server/admin/sweepEngine.js` 的 `tryPlaceOrder()` 在下单前会调用它）。

**⚠️ 未消除的混杂因素**：抓包时账号正好显示"游戏在维护中"，5 个样本的 `allow_fair_show_buy` 全部是 `false`——不能排除这是维护期间全站商品都不可购买导致的，而不是这件商品真的处于公示期。等游戏维护结束后应该重新抓一次，确认正常状态下这个字段的取值分布（应该既有 `true` 也有 `false` 的样本）。

`normalizeItem()` 不再提取 `fair_show_end_time`（已确认对判断公示期没用），公示期判断完全依赖 `fetchEquipDetail()` 的实时查询。

## 星格/变异筛选参数（2026-08-13，已确认请求参数，未确认命中样本）

藏宝阁商品列表页有一个"星格"筛选面板（选星级 1/2/3 星，填 1-4 个星格数值范围）。抓包确认的真实请求参数：

| 参数名 | 对应 UI | 备注 |
| --- | --- | --- |
| `variation_unlock_num` | 星级按钮（1星/2星/3星） | 测试值 1/2/3 |
| `variation_first` | 星格1 输入框 | 测试值 999/990/8999 |
| `variation_second` | 星格2 输入框 | 未测试过非空值 |
| `variation_third` | 星格3 输入框 | 未测试过非空值 |
| `variation_fourth` | 星格4 输入框（截图里没显示，但参数名存在） | 未测试过非空值 |
| `variation_unlock_level` | 未知，可能是另一个筛选维度 | 未测试过非空值 |

**未确认的部分**：三次测试组合的筛选条件下，`recommend.py` 返回的 `result` 全部是空数组（0 命中），没能抓到一件真正命中筛选条件的商品——所以完全不知道命中后单个商品对象上，对应的星格数值字段叫什么、`variation_info`（目前抓到的样本一直是空对象 `{}`）在有实际内容时是什么结构。

**采用的实现策略**：不在本地做任何数值解释或二次过滤，`server/cbgClient.js` 的 `searchItemsWithVariationFilter()` 只是把用户填的参数原样转发给藏宝阁，让藏宝阁自己的过滤逻辑决定结果。这样即使对参数语义的理解有偏差，也不会构造出畸形请求——最坏情况是筛选结果为空或不够精确，不存在下单风险。`server/admin/sweepEngine.js` 里只有配置了 `variationFilter` 的扫货任务才会走这条路径，会对每轮 tick 产生一次真实网络请求（其余任务继续保持零请求，只读轮询缓存）。

## 下单成功后的响应体格式（2026-08-13，第三轮抓包已确认，下单能力已接入）

`preview_order`/`add_order` 的**请求体**格式（三次独立抓包结果一致）：

```
serverid={服务器ID}&ordersn={订单号}&roleid={买家角色ID}&buyer_serverid={买家服务器ID}&confirm_price_total={确认总价，单位分}&view_loc=hag_msg&exter=direct&page_session_id=...&traffic_trace=...
```

`add_order` 的请求体和第二次 `preview_order`（带完整信息那次）完全一样，说明下单前必须先调一次带完整信息的 `preview_order` 确认，不能跳过直接调 `add_order`。`roleid`/`buyer_serverid` 用环境变量 `SWEEP_BUYER_ROLE_ID`/`SWEEP_BUYER_SERVER_ID` 固定配置，不做角色列表查询。

**`add_order` 成功后的响应体**（游戏维护结束后重新抓包，流程顺畅走完，没有触发验证码）：

```json
{"status": 1, "status_code": "OK", "order": {"poundage_tip": "", "has_old_order": false, "is_cross_buy_order": false, "orderid_to_epay": "2_23690157", "price_total": 245000}, "_request_id": "..."}
```

`order.orderid_to_epay` **已经是完整的 `"serverId_订单号"` 格式**（例：`"2_23690157"`），可以直接传给 `check_order_pay_result` 的 `orderid_to_epay_list` 参数，不需要再拆分/拼接。之前设计时以为要分开存 `serverId` 和 `epayOrderId` 两个字段再拼接，这个假设被证明是多余的，`server/sweepClient.js` 的 `placeOrder()` 和 `checkPaymentResult()` 已经改成直接传递这个完整字符串。

紧跟着调用的 `get_order_pay_info` 响应体里还有一个 `epay_orderid_list`（例：`["2026081311JY41800001044718522"]`），这是网易支付网关自己用的订单号（收银台 URL 里那个），和 `orderid_to_epay` 是两个不同的编号体系——扫货任务只需要 `orderid_to_epay` 去查支付状态，不需要这个。

**仍未确认的部分**：`check_order_pay_result` 返回的具体支付状态字段名。抓包时故意没有真的扫码付款（避免真实扣款），所以没有拿到"已支付"状态下的真实响应体样本。`server/sweepClient.js` 的 `checkPaymentResult()` 判定"已支付"时依然保守——拿不准就返回 `paid: false`，宁可多等一轮重新查，不会误判成已支付导致计数错误。

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
