# Findings & Decisions: RssFeedTeleBot 架构重构

## Final Outcome

RssFeedTeleBot 已从单文件、KV 数组状态重构为单 Worker 的模块化单体。入口、命令、Feed、Telegram、Poller 和存储边界独立，业务依赖可注入；事务性状态进入 D1，KV 只保留缓存型状态。最终自动化、迁移、bundle 和本地 Worker 验收全部通过。

## Implemented Architecture

### Composition and modules

- index.js 只负责 Worker HTTP/scheduled 组合、配置加载、Webhook 鉴权和 Update 生命周期。
- src/config.js 集中校验必需 bindings、secrets 和有界运行参数。
- src/security.js 负责常量时间 secret 比较、命令授权和目标聊天授权。
- src/commands.js 负责解析与编排，并通过 scoped D1 查询访问当前 chat/thread 的订阅。
- src/feeds.js 负责 URL 边界、逐跳重定向校验、受限读取、RSS/Atom 解析和条目身份。
- src/telegram.js 负责 HTML 安全渲染和 Telegram API 结构化结果。
- src/poller.js 负责公平轮转、稳定 aliases、Outbox 入队、受限消费和 operational lease。
- src/storage.js 负责所有参数化 D1 查询、旧 KV 迁移、租约、Outbox 和保留期。

### State ownership

- D1 表共 5 张：app_meta、subscriptions、processed_updates、operational_leases、deliveries。
- subscriptions 使用唯一约束消除并发 /add 覆盖和重复。
- processed_updates 通过 processing/completed 状态及 lease 区分完成重复、正在处理和失败重试。
- operational_leases 防止重叠 Cron 同时消费 Outbox；运行结束不遗留租约行。
- deliveries 按 feed/item/target 唯一，独立保存 pending、sent、dead、attempts 和 next_attempt_at。
- KV 仅保存 forwarding config、短期 callback/session、已见 aliases 和 poll cursor。

## Security Findings Resolved

- Webhook secret 为必需配置；错误 secret 在本地验收返回 403。
- update_id 必须是安全非负整数或纯数字字符串，重复 completed Update 返回 200。
- ADMIN_USER_IDS 存在时作为显式全局管理授权；未设置时私聊限本人、群聊要求管理员。
- 跨聊天 /set_forward 与 /forward_to 额外要求目标聊天管理员权限，同源/本人私聊目标除外。
- callback 在复制前按当前配置重验源聊天与目标聊天权限；权限撤销会消费 Session 且不会复制。
- RSS 的 channelName、列表和转发按钮仅展示 hostname；Feed/Worker 敏感 URL 日志仅保留 origin。
- 订阅列表展示安全 D1 #id；/del 使用 id + chat/thread 精确删除，旧名称匹配重名时拒绝批量删除。
- Feed URL 拒绝非 HTTP(S)、内嵌凭据、localhost 和私有 IP 字面量，并逐跳验证重定向与可选 ALLOWED_FEED_HOSTS。
- Feed 错误日志移除 credentials、query 和 fragment，避免 URL token 泄露。
- GitHub Actions 均固定到 commit SHA；本地 .env 及 .dev.vars 变体被忽略。

## Reliability Findings Resolved

- Feed 默认每轮最多 3 个，每个最多三次重定向；Telegram 默认最多处理 35 条，预算为 3 × 4 + 35 = 47。
- poll cursor 按实际选中 Feed 数推进，避免固定步长造成不公平。
- 条目成功入队后保存 canonical、GUID 和规范化 link aliases；GUID 变化或缺失时仍可去重。
- Outbox 按目标隔离部分失败，重试采用持久化退避，Telegram 429 停止本轮。
- MAX_DELIVERY_ATTEMPTS 默认 10；耗尽或永久错误进入 dead。
- 旧 completed Update、expired processing、sent 和 dead delivery 均有保留期清理。
- 投递语义明确为 at-least-once：Telegram 已接受但 D1 尚未标记 sent 时崩溃，后续重试可能重复。

## Deployment Findings

- D1 migrations 在 Worker 发布前执行。
- 后续 schema 必须保持旧 Worker 与新 Worker 都可运行，采用 expand/contract：先扩展、再发布应用、最后收缩。
- 生产 deployment concurrency 使用 cancel-in-progress: false，避免新事件中断 migration/deploy 中途状态。
- Wrangler compatibility date 为 2026-07-17。
- DNS 解析结果无法在应用层完全证明；严格 SSRF 边界仍依赖受控 DNS 或出口代理。

## Verification Evidence

| Verification | Evidence |
|---|---|
| Dependency install | npm ci 成功，报告 0 vulnerabilities |
| Unit/integration tests | npm test：90/90 passed |
| Static checks | npm run check 通过；src/test 全部 node --check 通过 |
| Dependency audit | npm audit 全量与 production 均为 0 |
| Diff hygiene | git diff --check 通过 |
| Workflow syntax | deploy.yml 与 opencode.yml 均由 PyYAML 解析通过；Ruby 不存在后改用 Python |
| D1 migration | 0001 本地执行 9 commands，创建 5 张表 |
| Worker bundle | Wrangler 4.111 dry-run：248.41 KiB，gzip 60.34 KiB |
| Local webhook | 错误 secret 403；正确 Update 200；重复 Update 200 |
| Local scheduled | scheduled 200；D1 Update 为 completed；poller lease 行数 0 |

## Residual Boundaries

- at-least-once 重复窗口属于外部 Telegram 调用与本地状态提交之间的固有限制。
- DNS rebinding/解析到私网地址仍需平台出口控制。
- 调高 MAX_FEEDS_PER_RUN 或 MAX_TELEGRAM_SENDS_PER_RUN 前，应依据当前套餐重新计算 subrequest 预算。

---

# Diagnostic Findings: Telegram network request failure (2026-07-20)

## Reported symptom

- Cloudflare Worker `sendMessage` 日志：`status: 0`、`retryable: true`、`permanent: false`、`retryAfterSeconds: 0`，底层错误被归一化为 `Telegram network request failed`。
- 需要判断它是请求未获得 HTTP 响应（DNS/TLS/连接/超时/Fetch 异常），还是 Telegram Bot API 域名/端点变化。

## Pending evidence

- Telegram API base URL 的代码来源与生产配置覆盖。
- Fetch 异常是否记录了原始 `error.name`、`error.message` 或 `cause`。
- Telegram 官方文档/公告是否存在近期 Bot API 域名变更。

## Code evidence

- `src/telegram.js:1,140` 将基址硬编码为 `https://api.telegram.org`，不存在环境变量或代理域名覆盖。
- `src/telegram.js:191-195` 捕获所有 fetch/响应体读取异常但丢弃原始异常；只有本地 10 秒计时器先触发时才会记录明确 timeout，否则统一为当前日志中的 `Telegram network request failed`。
- 因此 `status: 0` 表示代码没有拿到可分类的 Telegram HTTP 响应，不能由该日志继续区分 DNS、TLS、连接重置、平台 fetch 拒绝、redirect 拒绝或响应体读取失败。
- 外层 Webhook 在发送失败时只记录错误、不抛出；随后仍完成 Update 并返回 200，所以 Cloudflare 元数据中的 `statusCode: 200` 是 Worker 对 Telegram Webhook 的响应，不是 Telegram API 的响应状态。

## Current official evidence

- Telegram 官方 Bot API 当前仍明确要求 `https://api.telegram.org/bot<token>/METHOD_NAME`，与仓库硬编码 URL 完全一致。
- 官方 “Recent changes” 已列到 2026-07-14 的 Bot API 10.2；该更新内容为 Rich Messages 等 API 能力，没有宣布 Bot API 主机名迁移。
- 现有官方证据不支持“最近 Telegram 域名变化导致该错误”；至少不能把 `api.telegram.org` 换成传闻域名作为修复。
- Cloudflare 官方把 `Network connection lost` 定义为连接故障并建议捕获/重试；当前实现确实将任何 fetch 异常归为可重试，但由于丢弃原异常而无法进一步归因。

## Live verification

- 已获取最新官方 `@cloudflare/workers-types@5.20260719.1`；当前 Workers `fetch` 仍接受 `RequestInit.signal`，`AbortController.abort(reason)` 也在类型中，现有调用形态没有因 API 类型变化失效。
- 2026-07-19 17:36:12 UTC 使用无效占位 token POST 官方端点，成功建立 HTTP/2 连接并收到正常 `401 application/json`，没有 `Location` 重定向。
- 该探测证明当前官方域名并非全局失效、请求路径也未强制迁移；但它来自本执行环境，不能单独证明发生错误时具体 Cloudflare colo 到 Telegram 的链路健康。
- `redirect: 'error'` 仍是潜在诊断分支：若上游真的返回 3xx，Workers fetch 会抛异常并被当前代码抹平成相同的 `status: 0`，需要保留原始异常或临时记录 redirect 才能确认。

## Change/status correlation

- 2026-07-14 Bot API 10.2 公告里确有一项将在 7 月 20 日自动启用的“域名”相关安全变化，但它只限制 Mini App 方法必须来自最初 Mini App origin；与服务端 Bot API `sendMessage` 主机名无关。
- Telegram 10.0 曾有 `message_thread_id` 服务端回归，但表现为正常 HTTP 400，且官方维护者已于 2026-05-08 确认修复；它不会产生当前 `status: 0`。
- Cloudflare 官方状态组件当前将 Workers、Workers Observability 标记为 operational；7 月 18 日的事件仅影响 Workers/Pages builds 启动，已解决，不对应运行时到 Telegram 的出站 fetch。
- 官方状态页没有支持“Cloudflare Workers 全局出站故障”的证据；这仍不能排除单个 colo、Cloudflare↔Telegram 路由或 Telegram 某边缘节点的短暂链路失败。

## Recent Telegram domain event

- 用户提到的“最近 TG 域名变动”很可能是 2026-07-13/14 的 `t.me` 短链接域名 serverHold：它曾从公共 DNS 下线约一天，随后恢复。
- `t.me` 用于频道、群组、用户和 Bot 的短链接/启动链接；本项目发送消息使用的是完全不同的 `api.telegram.org`，不经过 `t.me`。
- OFAC 7 月 13 日官方清单确实把 `t.me/FirstVPNService` 列为受制裁实体基础设施；DomainME 向媒体确认 `t.me` 因合规被 hold 后已恢复。
- 这次 `t.me` 事件与当前 `sendMessage` 的 `status: 0` 没有直接调用链关联，不能通过把 API 地址改成 `telegram.me` 或其他短链域名解决。

## Incident timeline

- 日志 ULID `01KXXPRF4Y...` 解码为 2026-07-19 17:28:38.814 UTC（东京时间 7 月 20 日 02:28:38.814），在 `t.me` 恢复约五天之后。
- 公开 Globalping 测量创建于 17:35:39 UTC，即错误后约 7 分钟；东京、新加坡、德国、洛杉矶四个探针均解析 `api.telegram.org` 为 `149.154.166.110`。
- 四地均完成 TLS 1.3 且证书授权通过，并对域名根路径收到正常 302；这反驳当时附近存在全球性 DNS/TLS/主机迁移，但不覆盖出错的 Cloudflare colo。
- 根路径 302 是 Telegram 把浏览器访问导向文档；本项目调用的精确 `/bot<token>/sendMessage` 路径另以无效 token 验证为直接 401、无重定向，因此当前没有证据说明 `redirect: 'error'` 实际触发。
- 本日志明确不是本地 10 秒计时器触发，因为该分支会记录 `Telegram request timed out after 10000ms`；更符合 fetch/响应读取在计时器之前抛出的瞬时连接类异常。

## Local verification and regression boundary

- `src/telegram.js` 仅出现在 2026-07-17 的重构提交 `df01f7a`；`redirect: 'error'`、10 秒超时和丢弃原异常均由该提交一次引入。
- 使用项目真实 `sendTelegramMessage` 与无效占位 token 调用精确 `sendMessage`，当前得到结构化 HTTP 401：`Unauthorized: invalid token specified`，证明该路径此刻不重定向且请求实现可完成网络往返。
- `node --test test/telegram.test.js`：11/11 通过；网络异常和超时分类按现有设计工作。
- 现有测试同时固化了“任意底层异常都只返回通用文案”的行为，因此测试通过不代表生产故障可诊断；它恰好解释为何本次日志无法显示 Workers 的原始异常。
- 若该错误只出现一次，应按瞬时上游/路由故障处理；若从 7 月 17 日部署后持续出现，才需重点比较新实现（尤其 `redirect: 'error'`、AbortController 和响应体读取）与旧实现，但当前实测暂不支持重定向假设。

## Operational impact

- 该结构化错误日志只由 webhook 命令路径的 `reportTelegramFailure` 产生；定时 Outbox 走另一条持久化重试路径。
- `commands.send()` 虽然返回失败结果，但所有调用方只 `await`、不检查也不抛出；因此本次可重试网络失败不会让 Telegram 重投 webhook。
- Worker 随后把 Update 标记 completed 并返回 200，所以这条命令回复已丢失，不能由当前代码自动补发；日志中的 `retryable: true` 对 webhook 回复实际上只是分类信息。
- 重构前实现也会吞掉 sendMessage 异常并返回 `false`，但会把原始 Error 打进日志；当前实现提升了结构化与脱敏，却把最关键的异常类型/message 一并丢掉了。

## Why the issue looks new

- 当前 HEAD/tag `v0.1.5` 的提交 `dd0e7bd`（2026-07-20 02:13:16 JST）标题就是 `fix(telegram): log failed command replies`。
- 报错时间是 02:28:38 JST，仅晚约 15 分钟；该提交只给以前静默返回的失败补上结构化日志和测试，没有修改 `src/telegram.js` 的 API 域名或 fetch 行为。
- 因而“目前才看到这条 webhook 日志”是新可观测性暴露了原先会被吞掉的失败，而不是这次提交或 Telegram 域名变动新造出的连接故障；远程 D1 数据进一步证明底层失败并非偶发。
- 但 `dd0e7bd` 只记录了已归一化结果，未恢复重构前的原始 Error 信息，所以成功暴露了“有故障”，仍不足以回答“是哪一种网络故障”。

## Production D1 evidence

- 只读远程 D1 查询（`rows_written: 0`）显示：31 条 delivery 已在 10 次重试后全部 dead，错误均为 `Telegram network request failed (delivery attempts exhausted at 10)`。
- 另有 3 条 pending，各已失败 9 次且同为 `Telegram network request failed`；累计可确认 337 次失败尝试（31×10 + 3×9），不是单次偶发日志。
- D1 中没有任何 sent delivery。最早记录创建于 2026-07-17 06:30:14 UTC；Cloudflare 部署历史确认重构版 version 15 已在 06:19:09 UTC 以 100% 流量上线，因此第一次失败出现在部署后约 11 分钟，与新 Outbox/Telegram wrapper 上线边界高度相关。
- 失败持续覆盖 7 月 17–19 日，而 `t.me` 已在 7 月 14 日恢复；时间线进一步排除短链域名事件。
- 精确 API 端点在普通网络和多地区探针都正常，因此优先级应从“瞬时单次网络故障”上调为“7 月 17 日后 Worker 特定的系统性回归或 Cloudflare→Telegram 持续路径问题”。
- 当前证据仍无法在 `redirect: 'error'`、兼容日期从 2024-02-04 跳到 2026-07-17、Workers 出站链路、或响应读取异常之间定案，因为原始异常被 catch 丢弃。

## Final production correlation

- 报错中的 version `e5cf7403-a8ee-453b-815d-1351fd19d5ec` 于 2026-07-19 17:14:23 UTC 以 100% 流量部署；报错发生在 17:28:38 UTC，确定来自当前 v0.1.5 观测版本。
- 该版本运行 `compatibility_date = 2026-07-17` 和 `nodejs_compat`；部署元数据没有显示 Telegram 域名或代理绑定覆盖。
- 2026-07-19 17:48:17 UTC 的最终只读 D1 快照仍为 34 条：0 sent、31 dead、3 pending、累计 337 次失败；查询 `rows_written: 0`。
- 综合证据：可以排除 `t.me` 短链域名事件和 Telegram Bot API 主机迁移；可以确认生产故障持续且系统性；但在补充原始 fetch/body-read 异常信息前，不能负责任地把根因锁定到某一个 Worker runtime 或网络分支。

---

# Implementation Findings: Telegram diagnostics and observability (2026-07-20)

## Requirements

- 需要在不暴露 token/消息内容的前提下保留原始异常类别、受控错误文本、cause code、失败阶段与耗时。
- Webhook 命令和 scheduled Outbox 两条发送路径都必须产出可检索的结构化错误。
- Wrangler 配置应显式启用持久化日志与 traces，并通过当前本地 schema/dry-run 验证。
- 本轮只准备补丁和部署配置；生产发布及失败 delivery 重放不在默认授权范围。

## Toolchain baseline

- 项目当前 Wrangler 为 4.111.0，满足 v4 要求。
- 本地技能索引提供完整 observability configuration/patterns/gotchas 参考。
- 最终配置仍需以 Wrangler 4.111 schema 和最新官方文档双重校验。

## Workers best-practice constraints

- Workers 官方实践要求显式开启 `observability`，错误使用结构化 JSON 和 `console.error`。
- Telegram API JSON 响应体有明确的小体量边界，读取文本用于解析错误是可接受的；诊断仍需把 fetch 与 body-read 分成不同阶段。
- 所有异步发送必须 await；现有路径满足这一点，补丁不引入 floating promise。
- 自动 Workers Traces 不能用于当前 Telegram 调用：fetch span 会持久化 `url.full/url.path`，而 Bot Token 位于 path；这不是采样率问题，必须显式关闭。

## Review and source-of-truth notes

- Wrangler 4.111 自带的 `config-schema.json` 是配置字段与结构的权威本地校验来源。
- 诊断对象应保持 plain serializable fields，不把原始 `Error` 对象跨日志/存储边界传递。
- 本地 observability 概览含有可能过时的 retention/pricing 描述；配置字段和产品行为必须再用最新官方文档核对。

## Observability setup direction

- 初始故障定位启用 100% Workers Logs、Invocation Logs 与 Source Maps；自动 Traces 因 Token/业务 key 属性泄露风险保持关闭。
- `observability.enabled` 控制 Workers Logs，`observability.traces.enabled` 控制 traces；两者采样配置要按 schema 精确落位。
- `Date.now()` 与应用阶段字段提供安全的毫秒级请求定位；不能用会收集完整 URL 的自动 fetch trace 换取更多网络细节。
- 配置生效需要重新部署，dry-run 只能验证 schema/bundle，不能打开生产侧采集。

## Logging pattern selection

- 当前故障定位不需要新增 Analytics Engine binding；Workers Logs 的结构化 `console.error({...})` 已能按字段过滤。
- 记录固定 operation/phase、错误分类、cause code 和 duration；不记录 request URL、chat id、payload 或 token。

## Verified current Cloudflare configuration

- 2026-06/07 官方文档确认 TOML 使用 `[observability]`、`[observability.logs]` 与 `[observability.traces]`。
- Wrangler 4.111 schema 明确支持 logs 的 `enabled/head_sampling_rate/invocation_logs/persist` 与 traces 的 `enabled/head_sampling_rate/persist`。
- 当前 `wrangler.toml` 完全没有 observability 配置，因此当前版本不会因配置文件而保证持久化日志/trace。
- 故障定位期间采用 logs=100%、persist=true；traces 显式 disabled，避免 `url.full/url.path` 暴露 Telegram Bot Token。
- 同时启用 `upload_source_maps = true`，让平台对未捕获异常的堆栈映射回源码；应用日志自身不记录 stack。

## Current logging surface

- Telegram 核心实现 303 行，相关 command/poller 测试已有较好覆盖，可用小范围补丁扩展而无需重构。
- Webhook command 失败集中经 `commands.js:655-675` 输出结构化 JSON。
- scheduled Outbox 在 `poller.js` 中消费 `sendTelegramMessage` 结果，但当前没有对应 `console.error`，只把通用错误写入 D1。
- 补丁必须让两条路径都记录同一组安全诊断字段，否则 Cron 的 337 次失败仍无法在 Workers Logs 中定位。

## Telegram diagnostic design

- 在 API wrapper 内维护阶段：`fetch`、`response_body`、`response_validation`；catch 时同时保留已知 response status。
- 网络失败结果新增 plain `diagnostic` 对象，包含 failureType、phase、durationMs、timedOut、异常 name/message、cause name/code/message 和 responseStatus。
- 用户可见 `error`、retryable/permanent 语义保持不变；诊断对象只由日志调用方展开，不写入消息文本。
- 异常文本必须截断，并至少清除 token、Bot API URL、payload text、chat id、callback id；不记录 stack、原始 body 或请求 payload。
- 非异常的 invalid response/invalid JSON 也附上明确 failureType，避免仍然只看到同一通用错误。

## Full command-path review

- `reportTelegramFailure` 当前只清理 result.error；新增诊断必须显式白名单选择并再次脱敏，不能直接 spread result/Error。
- `getChatMember` 失败在 `lookupChatMember` 抛错后可能被权限层吞掉，因此应在 throw 前输出 operation=getChatMember 的同构日志。
- 将 fetch redirect 模式改为 `manual` 并显式拒绝 3xx，可把 redirect 从普通 fetch reject 中可靠拆出，同时仍不跟随任何可能泄露 token 的 Location。
- 不记录 Location 或 response URL；只记录固定 `upstreamHost=api.telegram.org` 和安全的 status/content-type/body length。
- 不能保证 Cloudflare 一定暴露 DNS 与 TLS 的独立错误码，但阶段日志加自动 fetch trace 能保证区分 fetch/redirect/body/timeout，并保留平台给出的最细线索。

## Scheduled delivery requirements

- `poller.js` 已有可注入 logger，失败日志应在 `markDeliveryRetry` 之前写出，避免持久化操作再失败时丢失首要证据。
- 日志用 deliveryId、attempt、maxAttempts、exhausted 关联 D1；不记录 chatId、threadId 或 message。
- D1 `last_error` 也必须使用先脱敏后截断的安全文案，不能原样持久化任意 result.error。
- HTTP 429 后停止本轮发送的既有控制流保持不变；成功 delivery 不写 error 日志。

## Test and entrypoint implications

- Telegram 单测需更新 `redirect` 断言为 manual，并覆盖 fetch exception/cause、redirect、body read、invalid JSON 与两阶段 timeout。
- 命令测试需验证诊断白名单和“先脱敏再截断”；当前实现先截断后替换，token 落在边界时可能留下部分敏感串。
- Poller 测试需捕获 JSON 日志，验证 deliveryId/attempt/exhausted 以及 token/chat/message/URL 不出现。
- Telegram 失败日志必须在 `markDeliveryRetry` 前输出，测试还应覆盖后者抛错时日志仍存在。
- Worker invocation 日志本身已由 Cloudflare 自动附加 request/cron/version 元数据，因此应用日志无需复制 Ray、完整 request URL 或 colo。

## Documentation placement

- 两份 README 的手动部署段落之后适合新增“Telegram diagnostics / 可观测性”小节。
- 文档应说明配置在下一次部署才生效、故障期日志 100% sampling、自动 traces 的 Token 风险，以及按 operation/failurePhase/deliveryId 查询。

## Final security review and verification

- Cloudflare 官方 spans 属性页明确列出自动 fetch span 的 `url.full` 与 `url.path`；Telegram Bot API URL 将 Token 放在 path，所以配置必须用 `[observability.traces] enabled = false`，即使 Worker 流量低也不能通过降低采样率解决。
- Telegram 非 2xx 响应体可能由代理/WAF 回显请求内容。最终实现只返回 `Telegram HTTP <status>`，保留 status、retry_after 和 body length，不保留 description/rawBody。
- 异常可能回显 `init.body`，其中换行和引号已 JSON 转义；最终脱敏覆盖原始、URL encoded 与 JSON-escaped 敏感值变体。
- 3xx 只解析并记录经过 hostname label 校验的 `redirectHost`；不保存 Location/path/query，可用于确认是否真的出现域名迁移。
- 最终全量测试 98/98；Wrangler 4.111.0 dry-run 通过并生成 source map；生产尚未部署。
