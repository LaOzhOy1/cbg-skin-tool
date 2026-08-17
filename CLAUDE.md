# 项目须知

## 铁律：探测/调试藏宝阁接口时，禁止短时间内多次发请求

这个账号历史上已经因为短时间内大量请求被风控标记（`CAPTCHA_AUTH` → `AUTO_LOGIN` → `MOBILE_AUTH` 逐级升级，详见 README「已知限制」）。风控信任分不容易涨回来，但很容易因为脚本式的高频探测再次跌下去。

**因此：**
- 任何调试、排查、验证登录态是否恢复，都不允许写脚本连续 `fetch` 真实接口（`get_aggregate_equip_type_list`、`recommend.py` 等）去反复试探。
- 需要确认状态时，优先读本地已有信号：`/api/status`、`/api/verify/status`、日志、`storageState.json` 时间戳，而不是直接打真实站点。
- 如果确实需要打一次真实接口确认，最多打一次，打完之后不要在几分钟内因为“再看看”又打第二次。
- 观察站点行为（比如记录页面/接口命名）优先用被动监听（浏览器 `page.on('response')` 之类），不要用轮询脚本反复主动请求。
- 所有真正会碰藏宝阁的调用都要先过 `server/riskGuard.js` 预检；一旦检测到代理/机房出口/高风险信号，直接拦截，不要硬试。
- 登录/验证流程只在恢复用途上放行，不能绕过风险预检直接开验证窗口。

## 站点页面 / 接口对照表

用于记录人工浏览藏宝阁网页时观察到的“页面 → 触发的接口”对照关系，方便后续开发时复用。持续补充，不要覆盖已有条目。

参见 `docs/site-map.md`。

## 待开发：登录/验证成功后自动刷新登录态

现状：`loginFlow.js` 里的 `runLoginFlow()` 有自己的检测循环，成功后会调用 `context.storageState()` 保存并 `cookieJar.reload()`。但 `tools/watchBrowser.js`（被动监听窗口，用于人工浏览记录接口）目前**不会**做这件事——它只记录接口，不检测登录状态、不保存 storageState。

结果：如果用户是在 `watch-browser` 窗口里顺手把验证/登录走完的（比如手机验证码提交成功），本地服务并不会感知到，`storageState.json` 也不会更新，`/api/status` 会继续显示未登录，直到用户专门走一次 `/api/verify/start` 或 `cbg-skin verify`。

需要补的能力：验证成功后要自动刷新登录态，而不是要求用户额外触发一次独立的验证流程。可选方向（后续实现时再定）：
- `watchBrowser.js` 里也接入 `isLoggedIn()` / 探测逻辑，检测到登录成功时自动 `context.storageState()` 保存 + `cookieJar.reload()`，就像 `loginFlow.js` 做的那样；
- 或者监听窗口和验证窗口本来就该是同一个窗口，减少“被动监听”和“主动验证”两条路径的割裂。

## 需求管理后台（`server/admin/`，第一版，2026-08-12）

在监控面板之上新增了一套"AI 编排需求"的管理系统骨架：管理员在 `/admin` 页面提交自然语言需求，AI（DeepSeek）把需求拆解成一份只由「能力注册表」（`server/admin/capabilities.js`）里登记过的能力组合而成的执行计划，管理员确认后计划进入进程内任务队列（`server/admin/queue.js`，并发=1）异步执行，全程状态由 `server/admin/stateMachine.js` 的迁移表严格校验。执行成功后可以点"总结经验"，AI 把这次的做法提炼成一条 `Template` 记录，存进 `data/templates.json`，以后生成新计划时会被拼进 system prompt 里参考。

**环境变量**：`DEEPSEEK_API_KEY`（必填，否则调用报 503）、`DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）、`DEEPSEEK_MODEL`（默认 `deepseek-chat`）。

**数据持久化**：`data/requirements.json`、`data/plans.json`、`data/tasks.json`、`data/templates.json`，原子写（临时文件 + rename），已加入 `.gitignore`，不提交到版本库。

**安全边界，务必注意**：这套管理后台**没有任何登录/鉴权**，和现有监控面板一样，靠 `HOST` 默认绑定 `127.0.0.1` 做隔离。如果以后把 `HOST` 改成 `0.0.0.0` 对外暴露，`/admin` 页面和 `/api/admin/*` 接口任何人都能访问、提交需求、确认执行——这是当前架构的已知假设，不是遗漏，但改动部署方式前必须先解决这个问题。

**这一轮范围**：只注册了 1 条真实能力 `list_onsale_items`（查询本地已缓存的在售商品，复用 `server/state.js` 的 `getItems()`），用来验证"提交需求 → AI 出计划 → 确认 → 入队 → 执行 → 完成 → 总结经验"这条骨架是通的。**真正的"AI 自动下单藏金匣 + 跟踪支付结果"这个具体能力还没有接入**，按计划留到下一轮：往 `CAPABILITIES` 数组里加 `place_order`、`check_payment_result` 两条能力即可插入现有骨架，不需要改状态机/队列/路由代码。下单能力接入时要遵守项目一贯的边界——校验商品在售、生成订单可以自动化，但**支付本身必须人工完成**，不能让 AI 或脚本碰支付密码/验证码（参考 `docs/site-map.md` 里记录的下单+支付接口流程）。

## 扫货任务（`server/admin/sweepEngine.js` + `/sweep`，2026-08-13，经过两轮抓包修正）

在需求管理后台之外新增了一套独立的"扫货"能力：管理员在 `/sweep` 页面填一个模板表单（商品名称、分类、价格上限、目标数量、期限，可选星格筛选），提交后立即激活，`sweepEngine.js` 用 `setInterval`（30 秒一次，风格与 `poller.js` 一致）持续监控。这是完全独立于「AI 需求规划」的一条路径——匹配判断、数量计数、到期判断都是确定性代码逻辑，**扫货引擎里完全不调用 DeepSeek**，因为这里涉及真实资金决策，不该交给 AI 临场发挥。

**状态机**（写在 `sweepEngine.js` 里，独立于 `admin/stateMachine.js`，因为业务语义完全不同）：`draft -> active -> pending_payment -> active/completed`，到期转 `expired`，管理员可随时 `cancel`。**串行下单**：一个任务同时最多有一个待支付订单，避免堆积未支付订单或被风控当成批量下单行为。

### 两条匹配路径（关键架构分叉）

- **没配置星格筛选的任务**：走 `findMatchingItem()`，零网络请求，只读 `server/state.js` 的 `getItems()`（轮询缓存），按分类+名称精确匹配+价格≤上限过滤。
- **配置了星格筛选的任务**（`task.variationFilter` 非空）：走 `findMatchingItemViaVariationFilter()`，**每轮 tick 都发一次真实网络请求**——原因是列表接口（`recommend.py`）返回的商品对象上根本没有星格/变异相关字段，本地缓存里查不到这个信息，必须让藏宝阁自己按筛选参数过滤（`server/cbgClient.js` 的 `searchItemsWithVariationFilter()`）。这是有意的架构分叉，不是疏漏：没配置星格筛选的任务继续保持零请求，只有真的需要这个信息的任务才承担额外的请求成本。

抓包确认的星格筛选参数：`variation_unlock_num`（星级 1/2/3）、`variation_first/second/third/fourth`（对应截图里的"星格1-4"输入框）。**这几个参数的具体数值语义没有抓到命中样本验证过**（三次测试筛选条件下命中数都是 0），所以代码里不在本地做任何数值解释，只是原样转发参数让藏宝阁自己过滤——即使语义理解有偏差，最坏情况是筛选结果不精确，不会构造出畸形请求。

### 公示期判断（已修正一次错误推测）

第一次实现时曾用 `fair_show_end_time` 时间戳推测公示期状态（"晚于当前时间即视为仍在公示期"），**这个推测已经被抓包证实是错的**：样本里 `fair_show_end_time` 已经过去，但商品依然不可购买。真正可靠的字段是 `get_equip_detail` 响应体里的 `allow_fair_show_buy`（布尔值），但这个字段**只存在于详情接口，不存在于列表接口**——所以公示期判断不能只查缓存，必须在 `tryPlaceOrder()` 下单前调用 `server/cbgClient.js` 的 `fetchEquipDetail()` 做一次实时二次确认。

抓包时账号恰好处于"游戏维护中"的状态，`allow_fair_show_buy` 全部是 `false`，不能排除是维护导致的混杂因素，不是公示期本身的正常表现——等游戏维护结束后应该再抓一次确认。

### 下单能力已接入真实调用（2026-08-13，第三轮抓包完成）

游戏维护结束后重新走了一遍"商品详情→购买→提交订单"（不用付款，提交后去我的订单取消），这次流程顺畅走完，没有触发验证码，抓到了缺失的最后一块拼图。`server/sweepClient.js` 的 `placeOrder()` 已经从占位实现换成真实调用：

- 先调一次带完整买家信息的 `preview_order` 确认（抓包发现这一步不能跳过，`add_order` 的请求体和这次 `preview_order` 完全一样），再提交 `add_order`。
- `add_order` 成功后的响应体已确认：`{ status: 1, status_code: "OK", order: { orderid_to_epay: "2_23690157", price_total: 245000 } }`。`order.orderid_to_epay` **已经是完整的 "serverId_订单号" 格式**，直接传给 `checkPaymentResult()` 即可，不需要拆分/拼接（之前设计时以为要分开存 `serverId`+`epayOrderId`，抓包结果证明这是多余的，`pendingOrder` 数据结构已经简化为直接存 `orderIdToEpay` 一个字段）。
- `roleid`/`buyer_serverid` 最初通过两个环境变量配置：`SWEEP_BUYER_ROLE_ID`、`SWEEP_BUYER_SERVER_ID`（两个都必填，缺一个就抛 `BuyerRoleNotConfiguredError`，不会用空值/猜测值发请求）。**这两个环境变量已经被账号管理模块取代**——见下方「账号管理」一节，`placeOrder(item, account)` 现在从账号对象上的 `buyerRoleId`/`buyerServerId` 取值，不再读环境变量。首次启动自动迁移出的默认账号会把当时 `.env` 里的这两个环境变量值搬进账号记录，行为对老用户无感。

`checkPaymentResult()` 的请求本身有真实依据，但响应体字段名依然没有抓到真实"已支付"样本确认过（抓包时故意没有真的扫码付款，避免真实扣款）——判定"已支付"时依然保守，拿不准就返回 `paid: false`。这是唯一还留着的不确定性，但风险很小：漏判的后果只是多等一轮重新查，不会误判成已支付导致计数错误。

**这意味着扫货任务现在具备完整的真实下单能力**——命中价格/公示期/星格筛选条件后会真的调用 `add_order` 生成真实订单。使用前必须在账号管理页面给当前活跃账号配置买家角色，否则会在 `history` 里记录"下单未配置买家角色"，不会阻塞或报错整个引擎。

**数据持久化**：新增 `data/sweepTasks.json`，走的是同一套 `server/admin/store.js` 原子写机制。

**安全联动**：扫货引擎每次 tick 前会先查 `server/state.js` 的 `getState().status`，不是 `ok`（比如风控/未登录）就直接跳过这一轮（包括星格筛选的实时请求和下单尝试），完全依赖 `poller.js`/`loginFlow.js` 自己恢复。

## 账号管理（`server/admin/accounts.js` + `/accounts`，2026-08-13）

在扫货任务之后新增账号管理，动机：之前 `storageState.json`/`cookieJar.js`/`state.js` 全是进程级单例，隐含"只有一个账号"的假设，用户想要在这个基础上支持注册多个账号，并让扫货任务和 AI 需求执行时"优先选账号再执行"。

**明确的范围边界**：单活跃账号，不是并发多账号——同一时刻只有一个账号在轮询/可执行任务，账号切换是显式操作。这不是技术限制，是有意选择：避免对藏宝阁同时发多路请求，这个账号已经因为自动化行为模式被风控升级过（见上方「铁律」），并发会放大这个风险。**验证码/登录依然必须人工完成**，账号管理只解决"哪个账号需要验证、状态如何"这个体验问题，不做任何验证码自动化——这一点用户主动问过"能否完全自动化登录/验证"，已经明确拒绝，不是后续可以商量放开的选项。

**数据模型**（`server/admin/store.js` 的 `accounts` 集合）：`{id, name, storageStatePath, buyerRoleId, buyerServerId, isActive, createdAt, updatedAt}`。首次启动 `ensureDefaultAccount()` 会把现有 `storageState.json` 包装成一条"默认账号"记录（不移动文件），标记为活跃，老用户零感知升级；`buyerRoleId`/`buyerServerId` 迁移自当时 `.env` 里的 `SWEEP_BUYER_ROLE_ID`/`SWEEP_BUYER_SERVER_ID`。之后新建的账号，登录态落在 `data/accounts/{id}.storageState.json`。

**架构选择：单例 + setter，而不是重写成 Map**。`cookieJar.js`/`state.js`/`poller.js` 结构没有推翻——因为只有一个账号活跃，它们代表的本来就是"当前活跃账号"的状态。`cookieJar.js` 新增 `setStorageStatePath(path)`，由 `accounts.js` 的 `switchActiveAccount()` 主动调用告知"现在该读哪个文件"，`cookieJar.js` 自己不 import `accounts.js`（避免循环依赖：`accounts.js → cookieJar.js` 和反向依赖会成环）。同理也考虑过给 `poller.js` 加 `pausePolling()` 导出供切换账号时用，但会形成 `accounts.js → poller.js → loginFlow.js → accounts.js` 的环，最终撤销这个改动——切换瞬间可能有一次旧账号数据短暂闪现，下一轮定时 tick 会自己纠正，接受这个已知的小竞态。`server/state.js` 的验证状态从单例对象改成了 `Map<accountId, verifyState>`，因为这个必须按账号区分。

**`loginFlow.js` 的 `runLoginFlow(accountId)`**：accountId 可选，不传时默认取当前活跃账号；针对指定账号自己的 `storageStatePath` 读写，只有验证的账号恰好是当前活跃账号时才会触发 `cookieJar.reload()` 和轮询恢复——这样可以对一个"非当前活跃"的账号单独打开验证窗口，不会打断正在跑的活跃账号的轮询状态。排查账号管理时发现并修复了一个和这次改动无关但影响验证可靠性的旧 bug：`probePasses()` 里的 `page.evaluate()` 调用漏传了 `PROBE_URL` 参数，导致浏览器端探测请求的 URL 始终是 `undefined`，探测从未真正打到目标接口——这很可能是之前"页面显示已登录但验证一直超时"问题的根因。

**扫货任务账号绑定**：`createSweepTask()` 记录创建时的活跃账号 id（不是动态取）。`sweepEngine.tick()` 里每个任务执行前检查 `task.accountId === getActiveAccount()?.id`，不一致直接 `continue`（不发任何请求，也不做到期判断），只在状态第一次变为"不匹配"时记一条 `account_inactive` history，避免每 30 秒刷重复日志；账号切回来时同理记一条 `account_active`。

**测试隔离**：`store.js` 用的是硬编码固定路径（`data/*.json`），没有依赖注入机制，`test/accounts.test.js` 采用"记录测试前文件内容快照 → 清空测试 → 断言 → `t.after` 回滚"的模式，跑完不会污染真实账号数据。**如果要手动做端到端验证（比如真的切换账号、真的打开验证窗口），必须在独立端口上跑（`PORT=xxxx npm start`），但要注意 `store.js` 的路径不看端口——同一份代码目录起的多个进程会共享同一份 `data/*.json`，测试完必须手动清理测试期间产生的账号/扫货任务数据，不能留在真实数据文件里。**
