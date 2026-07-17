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
