# Progress Log: RssFeedTeleBot 架构重构

## Session

2026-07-17 — architecture review, implementation, documentation, and final verification.

## Phase 1: Audit and design

- **Status:** complete
- 盘点 Worker 入口、KV 状态、Telegram 调用、Cron 和部署工作流。
- 复现未认证 Webhook、并发订阅覆盖和部分投递丢失。
- 确定模块化单体、D1 事务状态、KV 缓存状态和每目标 Outbox 方案。

## Phase 2: Core refactor

- **Status:** complete
- 新增 config、security、commands、feeds、telegram、poller、storage 模块。
- index.js 收敛为 composition root。
- 新增 D1 0001 migration 和旧 KV subscriptions 幂等迁移。
- 命令改为 scoped D1 查询，Poller 继续使用全量订阅读取。

## Phase 3: Security and reliability

- **Status:** complete
- 强制 Webhook secret、Update ID 校验和 processing/completed lease。
- 增加 allowlist、源聊天管理员及跨目标聊天管理员授权。
- callback 复制前重验当前源/目标权限；失权后消费 Session 并拒绝复制。
- RSS 展示名统一为 hostname，敏感 URL 日志仅记录 origin。
- /list 展示 D1 #id；/del 按 id + chat/thread 精确删除，重名名称匹配不执行删除。
- 增加 Feed URL、逐跳 redirect、私有字面量、allowlist 和敏感 URL 日志清理。
- 增加稳定 aliases、公平 Feed cap、每目标 Outbox、退避、429、attempt ceiling、dead 和 retention。
- 增加 D1 operational lease，避免 Cron 重叠消费。

## Phase 4: Deployment and documentation

- **Status:** complete
- 固定 checkout、setup-node、wrangler-action 和 opencode Action commit。
- 设置 production cancel-in-progress: false。
- 更新 compatibility date、secret ignore、双语安全/预算/at-least-once 文档。
- 记录 migration-before-publish 与 expand/contract schema 约束。
- 清理遗留 src/feeds.js.orig。

## Phase 5: Final verification

- **Status:** complete

| Command / check | Result |
|---|---|
| npm ci | 成功；0 vulnerabilities |
| npm test | 90 tests passed，0 failed |
| npm run check | 通过 |
| 全部 src/test node --check | 通过 |
| npm audit | 0 vulnerabilities |
| npm audit --omit=dev | 0 vulnerabilities |
| git diff --check | 通过 |
| Workflow YAML parse | PyYAML 解析 deploy.yml、opencode.yml 均通过；Ruby 不存在后改用 Python |
| D1 0001 local validation | 执行 9 commands；创建 app_meta、subscriptions、processed_updates、operational_leases、deliveries |
| Wrangler 4.111 dry-run | 248.41 KiB；gzip 60.34 KiB |
| Local Worker webhook | 错误 secret 403；正确 secret 200；重复 Update 200 |
| Local Worker scheduled | 200 |
| D1 post-run state | processed update 为 completed；operational lease 行数 0 |

## Delivered Files

- Worker composition: index.js
- Runtime modules: src/
- D1 schema: migrations/0001_initial.sql
- Test suite: test/
- Deployment: wrangler.toml、.github/workflows/
- Documentation: README.md、README_CN.md
- Work records: task_plan.md、findings.md、progress.md

## Error Log

| Issue | Resolution |
|---|---|
| 文件沙箱 bwrap uid-map 初始化失败 | 使用经批准的 workspace 命令和 git apply，未绕过工作区范围 |
| Ruby YAML parser 不存在 | 改用 Python PyYAML；两个 Workflow 均解析通过 |
| 多 hunk 文档补丁出现上下文偏移 | 改用精确行补丁并通过 git diff --check |
| 一次 Perl 文档替换语法错误 | 停止该路径，改用 git apply；未造成部分写入 |

## Final State

实现、文档和验证均完成。生产部署仍应遵守 migrations 先行、schema 向后兼容和 expand/contract 流程。

---

## Session: 2026-07-20 — Telegram request diagnosis

- **Status:** complete
- 追踪 `index.js` → `commands.js` → `telegram.js`，确认 `status: 0` 是应用生成的网络失败哨兵值，Cloudflare 元数据中的 200 是 webhook 外层响应。
- 核对 Telegram 官方 Bot API 文档、7 月 14 日变更及 `t.me` 事件；官方 API 主机仍为 `api.telegram.org`，短链事件与 `sendMessage` 无调用关系。
- 对精确 API 路径和多地区 DNS/TLS 做只读探测：端点可达、无强制重定向；不能据此排除特定 Cloudflare colo/path 问题。
- 定向测试通过：`test/telegram.test.js` 11/11；占位 token 经项目实现收到结构化 HTTP 401，说明当前路径可获得 Telegram HTTP 响应。
- 读取 Cloudflare 版本/部署元数据：重构版在 2026-07-17 06:19:09 UTC 上线，首条失败 delivery 在 06:30:14 UTC；日志版本在 7 月 19 日 17:14:23 UTC 上线，15 分钟后记录错误。
- 最终远程 D1 只读快照：34 条 delivery、0 sent、31 dead、3 pending、累计 337 次失败，确认是持续系统性故障而非一次偶发。
- 结论：排除 Telegram Bot API 域名迁移；根因范围收敛到 7 月 17 日 wrapper/runtime 变化或 Cloudflare→Telegram 路径，但原始异常被丢弃，需最小诊断补丁才能继续定案。
- 本轮未修改业务逻辑、未变更远程数据。

---

## Session: 2026-07-20 — Telegram diagnostics and observability patch

- **Status:** complete
- Telegram wrapper 现在按 `fetch`、`redirect`、`response_body`、`response_parse`、`response_validate` 分类，并保留耗时、上游状态、异常 name/message 与安全 cause。
- 3xx 使用 `redirect: manual`，只记录经校验的 `redirectHost` hostname，不记录 Location、path 或 query。
- 非 2xx 错误不再复制 response body；敏感值先扩展原始、URL 编码和 JSON-escaped 变体，再脱敏、去控制字符和截断。
- Webhook 的 sendMessage/getChatMember 与 scheduled Outbox 都输出同构结构化日志；scheduled 日志在 D1 retry 状态更新前输出，并带 deliveryId/attempt/maxAttempts/exhausted。
- `wrangler.toml` 开启 100% 持久化 Workers Logs、Invocation Logs 和 Source Maps。
- 自动 Traces 显式关闭：Cloudflare fetch span 会记录 `url.full/url.path`，Telegram Bot Token 位于 path；KV span 也可能包含业务 key。
- 最终 `npm test` 98/98、`npm run check`、`git diff --check` 全部通过。
- Wrangler 4.111.0 dry-run 通过（265.64 KiB / gzip 63.67 KiB），并生成 `index.js.map`。
- 生产部署和 dead/pending delivery 重放均未执行，等待用户确认。

---

## Session: 2026-07-20 — RSS and forwarding interaction improvement

- **Status:** complete
- 复制订阅分页已实现：每页 8 条、全局索引、上下页回调不消费 session，新生成 session ID 限长以满足 Telegram callback data 上限。
- 存储层原子 10 目标限制及真实 SQLite migration 测试已由并行任务完成，等待合并验证。
- “仅源会话（停止继承）”按钮、回调白名单、独立快照 handler 与源投递幂等处理已实现。
- 群聊 ForceReply 已移除 selective；只有取得 prompt message_id 才建立群聊输入 session，消费端也会拒绝无法验证来源的旧/异常 session。
- 重复独立目标会优先提示已存在；重复输入默认继承目标会直接返回并保持继承，不再静默创建独立 routing。
- 首轮 commands 复测在加载阶段失败：群聊 guard 插入位置打断既有 if 条件；尚无测试执行，已定位到 src/commands.js:1183。
- 修复语法后 commands 21/21 通过；输出暴露 4 个新增用例误嵌套在末尾旧用例中，需先恢复顶层结构再计为最终通过。
- 测试闭包已恢复：commands.js 与 commands.test.js 语法检查通过，21 个顶层命令交互测试全部通过。
- 已复核真实 SQLite migration 测试与 CI：Node 22 路径兼容，覆盖迁移执行、唯一约束和 foreign_keys 关闭时的 scoped trigger 清理。
- git status 发现并清理本轮 GNU patch 自动生成的两个 .orig 文件；未删除任何用户文件。
- 新建菜单输入 prompt 前会先删除旧 input session，避免群聊 prompt 无 message_id 时遗留可消费旧状态。
- 继承规则说明已明确：“仅源会话”会主动停止继承，而普通修改以当前有效规则为起点。
- 首轮全量测试 77/79：commands 与 index 因顶层 stale-input 语句无法加载；其余套件（含 migration/storage/poller）通过。
- npm run check 通过；git diff --check 仅报 commands 测试 EOF 新空行，两个问题均已定位。
- 修正后 npm test：113/113 passed（含 21 个 commands、18 个 storage、真实 SQLite migration 与 Poller 回归）。
- npm run check：passed；git diff --check：passed。
- Wrangler 4.111.0 最终 deploy --dry-run：passed，321.70 KiB / gzip 73.84 KiB；仅输出到 /tmp，未部署。
- 最终文档复核定位两项补充：逐订阅最多 10 个目标/仅源停止继承，以及复制订阅列表分页。
- 双语 Usage 已补齐逐订阅最多 10 目标、source-only 停止继承和复制选择器分页；Markdown 代码围栏复核完整。
- 内置 /help 已同步 10 目标与 source-only 能力；复制订阅页的 Target 字段统一为中文标签。
- 最终复审无 P1，定位两个 P2：初始化路径缺少同语句目标上限 guard，以及 node:sqlite 与 Node engine 下限不一致。
- storage 18/18 通过；SQLite cap 逻辑通过但新用例误嵌套，需恢复为两个顶层 migration tests 后再计最终结果。
- initializeSubscriptionRouting 每条真实 INSERT 现有原子 COUNT < 10 guard；真实 SQLite 连续 9 + 2 目标初始化只落 10 条。
- storage 18/18、两个顶层 migration integration tests 2/2、git diff --check 全部通过；root Node engine 已同步为 >=22.13.0。
- 最终 npm test：114/114 passed；npm run check 与 git diff --check passed。
- 最终 Wrangler dry-run：322.01 KiB / gzip 73.89 KiB，仅写入 /tmp，未部署。
- 最后一次复审未发现剩余 P1/P2；U1-U5 全部完成。

- 用户要求降低 RSS 订阅与管理门槛，并让 forwarding 可分别管理。
- 恢复了首次规划补丁误覆盖的 task_plan.md、findings.md、progress.md 历史；没有业务代码受损。
- 完成只读架构盘点：命令与 Callback 在 src/commands.js，订阅在 D1，旧转发配置和交互 session 在 KV，最终目标解析在 src/poller.js。
- 明确两种 forward：/set_forward 是未来消息路由；/forward_to 是复制订阅。新 UI 将使用不同名称和入口。
- 采用 additive D1 模型支持“每条订阅多个独立目标”，同时保留旧 KV topic/global 规则作为无独立设置时的继承行为。
- 改造前基线：npm test 98/98，npm run check 通过。
- 完成 U2 设计：短 KV UI session、稳定订阅 ID、删除确认、独立多目标、源投递开关与恢复继承。
- 开始 U3：准备 D1 migration、参数化 storage API 与 Poller 批量路由解析。
- 新增 migrations/0002_subscription_forwarding.sql：settings、targets、索引与删除清理 trigger。
- storage.js 新增批量/单条 routing 读取、目标增删、源投递切换与恢复继承 API；所有写入按 subscription/chat/thread 限定。
- 删除目标时增加消息黑洞保护：include_source=false 时不能删掉最后一个目标。
- Poller 每轮一次批量读取独立 routing；独立规则优先，否则保留旧 topic/global KV 继承。
- node --check src/storage.js 与 src/poller.js 均通过。
- 首次同时补 storage/poller 测试因 Poller 上下文偏移被 Git 原子拒绝；确认没有部分写入，改为逐文件应用。
- 首次 U3 阶段更新补丁因 hunk header 不完整被 Git 拒绝，无部分写入；已改用完整 unified diff。
- U3 完成：Poller 改为一次查询获取 subscriptions + routing 一致快照，避免两次 D1 查询竞态。
- migration 同时使用外键级联和删除 trigger；即使运行连接未启用 FK 或旧 Worker 删除订阅，规则也可清理。
- 异常 include_source=false 且零目标时，Poller 记录 warning 并回退源目标，避免静默丢消息。
- node --test test/storage.test.js：16/16 passed。
- node --test test/poller.test.js：17/17 passed。
- U4 已接入 ui: Callback 命名空间、菜单/输入 TTL 常量和独立 routing 服务；旧 fwd: Callback 分支保持原样。
- handleMessage 现在可在非命令文本时尝试消费绑定输入会话；/start 与 /menu 进入同一菜单入口。
- 已实现主菜单、分页订阅/转发列表、详情、二次删除确认、目标单独删除、源投递开关和恢复继承确认。
- UI session 绑定发起用户、chat、thread 与 active 指针；新菜单会使旧菜单失效，Callback data 在生成时校验 64-byte 上限。
- ForceReply 输入 session 使用 10 分钟绝对 TTL；群聊可绑定 prompt reply，所有写入前重新检查源/目标权限。
- 首次独立修改会把当前有效旧 KV 规则与新增目标在一次 D1 batch 中物化，避免投递目标或 onlyForward 语义意外变化。
- /forward_to 已抽为菜单可复用的复制流程，UI 明确称为“复制订阅”；旧 fwd: Callback 协议不变。
- /menu 现在属于管理命令；所有 ui: Callback 也会再次检查当前权限。
- node --check src/commands.js 在交互主体补丁后通过。
- 一次 Callback 正则/删除过滤联合补丁因首段上下文匹配失败被原子拒绝，无部分写入；改为分段应用。
- 首次 node --test test/commands.test.js test/security.test.js：18/19；唯一失败是预期的复制按钮图标由 📺 改为 📋，其余旧行为通过。
- 新增菜单 active/session 绑定、RSS 输入保留/消费、删除确认 scoped filter、首次独立目标快照四组命令测试。
- 重跑 commands + security：23/23 passed。
- U4→U5 状态补丁前三次因 header/上下文定位问题被 Git 原子拒绝，均无部分写入；最终改用精确 zero-context 单行补丁。
- storage 增加 initializeSubscriptionRouting 原子快照测试；storage：17/17 passed。
- /start 与 /menu 统一使用管理权限；默认 /set_forward 与 /del_forward 会提示独立订阅不受影响。
- 更新后 commands + security 再次 23/23 passed。
- U4 实现完成，进入 U5 文档、迁移实测、全量测试和安全复核。
- 双语 README 已加入 /menu 推荐流程、每订阅多目标、源投递保护、恢复继承、复制订阅区别及新 D1/KV 职责。
- 文档补丁首次因未转义 backtick 在 JavaScript 解析前失败，随后大上下文 hunk 未匹配；两次均无写入，改用占位符 + 精确行补丁完成。
- 一次只读 rg 双引号误含 backtick 导致 shell 尝试执行 SQL/DB；未写入，后续已改为单引号。
- 已定位中英文 README 的 Usage 与 Storage ownership 段落，准备同步菜单优先流程和独立转发兼容语义。
- 隔离路径 /tmp/rssbot-routing-validation 成功应用 0001 与 0002；新迁移执行 5 条命令。
- 本地 D1 实测重复 subscription target 只保留 1 行，UNIQUE 生效。
- 删除 subscription 后 settings_after_delete=0、targets_after_delete=0，级联/trigger 清理生效。
- npm test：107/107 passed。
- npm run check：passed。
- git diff --check：passed；工作区仅包含本轮源码、迁移、测试、双语文档与规划记录。
- Wrangler 4.111.0 deploy --dry-run：passed。
- Worker bundle：315.83 KiB / gzip 72.76 KiB；输出仅写入 /tmp，未部署。
- 双语 README 结构复核通过：菜单说明位于 Usage 首部，默认转发、独立转发与复制订阅分段清晰，Markdown 代码块保持完整。
- 交互复审发现并准备修正：群聊 ForceReply、继承目标重复添加、缺少“仅源会话”入口、复制订阅列表未分页，以及逐订阅目标上限的并发保护。
- 本地运行时为 Node.js v24.16.0，node:sqlite 可用；可增加迁移 SQL 的真实数据库回归测试，不引入新依赖。
- 已定位 commands 的 ForceReply、输入绑定、逐订阅路由详情、旧复制 session 回调与测试夹具；下一步按复审项补交互和回归测试。
- 修正方案已收敛：去掉 selective ForceReply；群聊缺失 prompt message_id 时失效；继承重复目标保持继承；新增 source-only action；复制 session 用全局索引分页且翻页不消费 session。
