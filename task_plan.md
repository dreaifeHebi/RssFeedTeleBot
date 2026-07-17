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
