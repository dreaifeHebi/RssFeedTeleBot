# Task Plan: RssFeedTeleBot 架构重构与可靠性加固

## Goal

将 RssFeedTeleBot 从单文件、KV 读改写驱动的 Worker 重构为可测试的模块化单体，并完成 Webhook 鉴权、命令授权、D1 状态迁移、可靠 Outbox、定时任务并发控制、网络边界、部署供应链和双语文档的端到端验证。

## Current Status

Complete — implementation and final verification finished on 2026-07-17.

## Phases

### Phase 1: 架构审查与目标设计

- [x] 盘点入口、调用链、存储职责和 Cloudflare 部署边界
- [x] 复现未认证 Webhook、KV 并发覆盖和多目标部分投递问题
- [x] 选择“单 Worker + 模块化单体 + D1 事务状态 + KV 缓存状态”
- **Status:** complete

### Phase 2: 模块化与持久化重构

- [x] 拆分 config、security、commands、feeds、telegram、poller、storage
- [x] 增加 D1 0001 migration 与旧 KV subscriptions 幂等迁移
- [x] 将订阅、Update claim、operational lease 和每目标 Outbox 落到 D1
- [x] 保持 KV 仅负责转发配置、短期 Session、已见历史和轮询游标
- **Status:** complete

### Phase 3: 安全与可靠性加固

- [x] 强制 Telegram Webhook secret，并校验 update_id
- [x] 增加 allowlist/群管理员授权及跨目标聊天管理员校验
- [x] callback 复制前重验当前源/目标权限，失权时消费 Session 并拒绝复制
- [x] RSS 安全展示名仅使用 hostname，敏感 URL 日志仅记录 origin
- [x] 订阅列表显示 D1 #id；删除按 id + chat/thread 精确执行，重名旧命令拒绝删除
- [x] 对初始 Feed URL 和每跳重定向执行协议、凭据、私有字面量与主机白名单校验
- [x] 增加 Feed 轮转上限、稳定 aliases、每目标 Outbox、退避、429、dead 与保留期清理
- [x] 使用 Webhook lease 和 scheduled operational lease 处理失败恢复与重叠运行
- **Status:** complete

### Phase 4: 部署与文档收口

- [x] 固定 GitHub Actions commit SHA，并禁止取消进行中的生产部署
- [x] 更新 Wrangler compatibility date、密钥忽略规则和双语 README
- [x] 记录 Free-tier 默认预算 3 × 4 + 35 = 47
- [x] 记录 at-least-once 重复窗口、DNS/出口边界和 expand/contract 迁移约束
- **Status:** complete

### Phase 5: 最终验证

- [x] npm ci、npm test、npm run check 与逐文件语法检查
- [x] npm audit 全量及 production 审计
- [x] Git diff、Workflow YAML、D1 migration 与 Wrangler bundle 验证
- [x] 本地 Worker Webhook、重复 Update、scheduled 与 D1 状态验收
- **Status:** complete

## Key Decisions

| Decision | Rationale |
|---|---|
| 保持单 Worker，拆成模块化单体 | 当前规模不需要微服务；模块边界和依赖注入已足以提升可维护性与测试性 |
| 事务性状态迁移到 D1 | 唯一约束、参数化查询、批处理和租约语义不适合 KV 读改写 |
| KV 只保留缓存型状态 | 已见历史、转发配置、短期 Session 和游标允许最终一致性 |
| Outbox 采用每条目/每目标记录 | 可隔离部分失败，并为重试、dead 和保留期提供明确状态 |
| 默认调度预算保持 47 次外部请求 | 在 Workers Free 50 次 subrequest 上限内保留少量余量 |
| Migration 先于 Worker 发布 | 后续 schema 变更必须向后兼容，并使用 expand/contract 部署 |
| 明确 at-least-once | Telegram 接受消息后、D1 标记 sent 前崩溃仍可能产生重复，不能声称 exactly-once |

## Verification Gate

| Check | Result |
|---|---|
| npm ci | 成功；0 vulnerabilities |
| npm test | 90/90 passed |
| npm run check | 通过 |
| src/test 全部 node --check | 通过 |
| npm audit（全量 / production） | 0 / 0 |
| git diff --check | 通过 |
| 两个 Workflow YAML | PyYAML 解析通过；Ruby 不存在后改用 Python |
| D1 migration 0001 | 本地执行 9 commands；创建 5 张表 |
| Wrangler 4.111 dry-run | 248.41 KiB；gzip 60.34 KiB |
| 本地 Worker 验收 | 错误 secret 403；正确及重复 Update 200；scheduled 200 |
| D1 最终状态 | Update 为 completed；poller operational lease 行数为 0 |

## Remaining Operational Boundaries

- 投递为 at-least-once，崩溃窗口内允许重复。
- 应用层无法验证主机名的真实 DNS 解析结果，严格 SSRF 防护仍需要 DNS/出口策略。
- 提高 Feed 或 Telegram 上限前必须重新核对当前 Cloudflare 套餐的 subrequest 限制。

---

# Diagnostic Plan: Telegram network request failure (2026-07-20)

## Goal

判定生产 Worker 的 `sendMessage` 出现 `status: 0` / `Telegram network request failed` 是否与 Telegram 域名变化有关，并给出有证据的根因范围与下一步。

## Current Phase

Complete — diagnosis and evidence collection finished; no business code changed.

## Phases

- [x] D1：检查 Telegram 请求构造、异常归类与部署配置（complete）
- [x] D2：核对 Telegram 官方 Bot API 域名及近期变更（complete）
- [x] D3：运行定向测试/网络探测并区分 DNS、TLS、超时与 API 响应（complete）
- [x] D4：汇总结论、证据和建议；不经授权不改业务代码（complete）

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| workspace 命令首次触发 `bwrap: setting up uid map: Permission denied` | 1 | 按沙箱策略改为经批准的只读命令；未扩大工作区写入范围 |
| 内置 apply_patch 与 shell apply_patch 均因 fs sandbox helper 的 loopback RTM_NEWADDR 失败；首次 `git apply` 补丁计数也有误 | 1–3 | 改为逐文件、精确 hunk 计数的 `git apply`，仍只写工作区计划文件 |

---

# Implementation Plan: Telegram diagnostics and Workers observability (2026-07-20)

## Goal

为 Telegram 出站请求增加可区分 fetch、redirect、响应读取与超时故障的安全诊断字段；通过 Wrangler 开启 100% 持久化 Workers Logs、Invocation Logs 与 Source Maps，并因 Bot Token 位于 URL path 中而显式关闭自动 Traces。

## Current Phase

Complete — patch, documentation, security review, tests, and Wrangler dry-run finished; production is not deployed.

## Phases

- [x] I1：检查完整调用链、日志路径、测试和最新 observability 配置（complete）
- [x] I2：实现 Telegram 分阶段异常诊断及严格脱敏（complete）
- [x] I3：配置安全的 Workers Logs/Source Maps 并补充双语运维文档（complete）
- [x] I4：补齐测试，运行全量校验和 Wrangler dry-run（complete）
- [x] I5：汇总部署与线上验证步骤；未经明确授权不部署生产（complete）

## Safety Constraints

- 不记录 Telegram bot token、完整 Bot API URL、chat text 或请求 payload。
- 保持现有公开返回结构兼容；诊断字段只用于结构化日志/内部结果。
- 不自动重放 dead/pending delivery，避免修复前后重复发送。

## Implementation Errors

| Error | Attempt | Resolution |
|---|---:|---|
| 首次追加 toolchain finding 的 fallback patch 行号偏移 | 1 | 读取文件尾部确认真实行号；未造成写入 |
| 多文件 fallback patch 的 task_plan 上下文不存在 | 2 | 确认前一 hunk 计数不足导致尾部未写入，改用单文件且逐行核算 hunk 数量 |
| observability findings hunk 的新增行数少计一行，末行被忽略，后续追加行号失配 | 1 | 读取实际 EOF，补齐遗漏行并按“原上下文 + 新增行”重新核算 |
| Phase I1→I2 的手写 hunk 总行数多计一行，`git apply` 报损坏 | 1 | 改用 `git apply --recount` 让 Git 从内容重新核算，后续 fallback patch 统一使用该模式 |
| 单个大型 telegram.js fallback patch 即使使用 recount 仍在首 hunk 匹配失败 | 1 | 确认文件未发生部分写入；拆为按常量、导出、核心请求和 helper 的小型单文件补丁 |
| poller.js 多 hunk patch 在首个 import hunk 匹配失败 | 1 | 确认无部分写入；沿用已验证策略拆成 import/default、queue、validation/helper 三个小补丁 |
| 首次定向测试 31/37，通过语法检查但 6 个旧 deepEqual/redirect 断言失败 | 1 | 失败均为预期结构变化（diagnostic、source、manual redirect、invalid_json 文案）；进入 I4 时更新并扩展安全测试 |
| 同时追加 task_plan/progress 的多文件 patch 因 progress 上下文不存在而整体失败 | 1 | 不重复多文件写法，继续使用单文件 patch 并先读取实际 EOF |
| 内置 apply_patch 持续因 bwrap loopback 失败，git/patch 又无法替换未提交新增行；一次多命令 ed 搜索未完整命中 | 1–3 | 立即运行语法与分段检查，确认仅 helper 插入成功；随后改用逐段精确行号 ed，恢复并验证全部目标代码 |
| 安全复核发现自动 fetch Trace 会持久化含 Bot Token 的 `url.full/url.path` | 1 | 保留 100% Workers Logs 和 Source Maps，将 `[observability.traces]` 显式设为 `enabled=false`，双语文档同步说明 |
| 安全复核复现非 2xx response body 与 JSON-escaped payload 可能绕过原始值替换 | 1 | 非 2xx 错误固定为 `Telegram HTTP <status>`；敏感值增加 JSON/URL 编码变体脱敏和回归测试 |

## Final Verification

- `npm test`: 98/98 passed.
- `npm run check`: passed.
- `git diff --check`: passed.
- Wrangler 4.111.0 dry-run: passed, 265.64 KiB / gzip 63.67 KiB.
- Dry-run artifact includes `index.js.map`.
- Production deploy and delivery replay were not performed.
