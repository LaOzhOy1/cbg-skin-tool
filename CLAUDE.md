# 项目须知

## 铁律：探测/调试藏宝阁接口时，禁止短时间内多次发请求

这个账号历史上已经因为短时间内大量请求被风控标记（`CAPTCHA_AUTH` → `AUTO_LOGIN` → `MOBILE_AUTH` 逐级升级，详见 README「已知限制」）。风控信任分不容易涨回来，但很容易因为脚本式的高频探测再次跌下去。

**因此：**
- 任何调试、排查、验证登录态是否恢复，都不允许写脚本连续 `fetch` 真实接口（`get_aggregate_equip_type_list`、`recommend.py` 等）去反复试探。
- 需要确认状态时，优先读本地已有信号：`/api/status`、`/api/verify/status`、日志、`storageState.json` 时间戳，而不是直接打真实站点。
- 如果确实需要打一次真实接口确认，最多打一次，打完之后不要在几分钟内因为“再看看”又打第二次。
- 观察站点行为（比如记录页面/接口命名）优先用被动监听（浏览器 `page.on('response')` 之类），不要用轮询脚本反复主动请求。

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
