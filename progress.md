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
