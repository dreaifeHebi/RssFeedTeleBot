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

---

# Interaction Improvement Plan: RSS and independent forwarding management (2026-07-20)

## Goal

在保留现有命令与权限边界的前提下，为 Bot 增加菜单优先的订阅管理体验，并支持每条订阅拥有可独立增删的多个消息转发目标。

## Current Phase

Complete — implementation, documentation, review, tests, and Worker dry-run finished; production is not deployed.

## Phases

- [x] U1：盘点现有命令、Callback、存储、Poller 与测试基线（complete）
- [x] U2：确定菜单、会话状态、独立转发模型与兼容策略（complete）
- [x] U3：实现 D1 增量迁移、存储 API 与 Poller 独立路由（complete）
- [x] U4：实现菜单式添加、列表、删除确认及转发管理（complete）
- [x] U5：补齐中英文文档与自动化测试，完成全量验证（complete）

## Compatibility and Safety Constraints

- 继续支持 /add、/list、/del、/set_forward、/del_forward 和 /forward_to。
- 明确区分“消息转发规则”和“复制订阅”。
- 新表采用 additive migration；没有独立规则的订阅继续继承现有 topic/global KV 转发配置。
- 所有 Callback 与输入会话必须绑定发起用户、源 chat 和 thread，并在写入时重新校验权限。
- 禁止关闭源投递且没有任何目标，避免消息静默丢失。
- 规则修改仅影响未来入队，不重写或重放已有 delivery。
- 不提交、不推送、不部署生产。

## Decisions

| Decision | Rationale |
|---|---|
| 独立转发存入 D1，而非 KV 数组 | 支持每订阅多目标、精确删除和参数化授权，避免 KV 并发覆盖与枚举困难 |
| 没有独立 settings 行时继承旧 KV | 保持升级前行为不变，无需迁移现有配置 |
| 菜单使用短 session token + KV TTL | Callback data 保持短小，状态可绑定用户/chat/thread，适合分步输入 |
| 旧命令继续作为快捷方式 | 降低现有用户迁移成本 |

## Errors Encountered
| source-only 三 hunk 补丁末段函数边界行号偏移 7 行 | 1 | Git 原子拒绝无部分写入；用 rg 获取当前函数行号后逐段应用 |
| source-only 两 hunk 补丁第二处仍因上下文起始行不匹配 | 1 | Git 原子拒绝无部分写入；改用 nl 获取插入点并执行 zero-context 插入 |
| ForceReply 三 hunk 补丁最后一处输入校验上下文未匹配 | 1 | Git 原子拒绝无部分写入；先应用 prompt 创建段，再按更新后精确行号插入消费端保护 |
| ForceReply 创建段补丁仍使用插入前旧函数坐标 | 1 | Git 原子拒绝无部分写入；核对累计增量后的 nl 行号，改为逐行 zero-context 编辑 |
| git apply 拒绝精确 ForceReply 单行删除，但 GNU patch dry-run 成功 | 1 | 确认为 git apply 对重度修改文件的偏移匹配问题；后续同样使用路径限定的 unified patch |
| 首次 GNU patch 合并 ForceReply hunk 的新行计数错误 | 1 | patch 在写入前报 malformed，rg 确认源码无部分变更且无 .orig/.rej；改为单一小 hunk 逐次应用 |
| prompt 绑定上下文 patch 未匹配并生成 .rej | 1 | 源码未变；经提升权限删除本轮生成的 reject，改用 dry-run 通过的精确 zero-context 补丁 |
| 双语文档补丁再次在 JavaScript template 中含 Markdown backtick | 1 | 脚本解析前失败、无写入；改用占位符生成 backtick 后重试 |
| 占位符文档补丁仍残留代码围栏的两个 backtick | 1 | 脚本解析前失败、无写入；将围栏三个字符全部替换为占位符 |
| 双语文档大补丁中文第二 hunk 上下文未匹配 | 1 | Git 原子拒绝无部分写入；读取精确行号后拆成每个 README 的小补丁 |
| storage SQL 补丁的 JavaScript template closing backtick 未占位 | 1 | 脚本解析前失败、无写入；改用占位字符生成 backtick |
| storage 两 hunk patch 仅参数 hunk 应用，SQL guard hunk 失败并生成 .rej | 1 | 立即确认 partial state；删除本轮 reject 后在精确行 389 插入 guard，使 placeholder 与 bind 恢复一致 |
| storage 测试两 hunk patch 的首段行数与第二 header 不一致 | 1 | patch 报 malformed 且确认无部分写入/残留；拆为参数替换和 SQL 断言两个补丁 |
| package + lockfile engine 多文件补丁在 lockfile 上下文未匹配 | 1 | Git 原子拒绝无部分写入；拆成两个精确单文件替换 |

| Error | Attempt | Resolution |
|---|---:|---|
| 首次新建规划文件误覆盖三份已跟踪历史记录 | 1 | 用户明确授权后，以当前 diff 的反向补丁完整恢复 Git 版本；业务代码未受影响 |
| 内置 apply_patch 因 bwrap loopback RTM_NEWADDR 失败 | 1–3 | 经用户明确授权，仅对本仓库使用带具体内容的提升权限 Git 补丁 |
| 提升权限调用 apply_patch 仍在内部触发同一 fs sandbox helper 错误 | 1 | 按用户授权改用内容固定、路径限定的 git apply 补丁；每次补丁后单独验证 |
| storage + poller tests 多文件补丁的 Poller 插入上下文偏移 | 1 | git apply 原子拒绝，确认两文件均未部分写入；拆成单文件补丁并按实际测试名定位 |
| U3 阶段更新补丁使用了不完整的 @@ hunk header | 1 | Git 在写入前拒绝；改为每个 hunk 都带完整旧/新行范围 |
| Callback 正则 + 删除过滤多 hunk 补丁首段含无变化上下文而匹配失败 | 1 | 确认原子拒绝无部分写入；移除无效首段并拆分为精确补丁 |
| 首次 commands/security 定向测试 18/19，复制按钮图标断言仍期望旧 📺 | 1 | 功能与安全测试均通过；更新预期为区分“复制订阅”的新 📋 文案并补菜单测试 |
| U4→U5 状态补丁连续三次因 header/上下文定位问题被 Git 原子拒绝 | 1–3 | 读取精确行号并改用 zero-context、路径限定的单行替换；前三次均无部分写入 |
| 首次双语 README 补丁的 JavaScript 模板含未转义 Markdown backtick | 1 | 命令在解析前失败、无写入；后续用占位字符生成 backtick |
| 中文 README 大上下文补丁首 hunk 未匹配 | 1 | Git 原子拒绝无写入；改为精确行号 zero-context 文档补丁 |
| 一次 rg 命令在双引号中包含 backtick，shell 尝试执行 SQL/DB | 1 | 仅产生 command-not-found、未写入；后续 shell 正则统一使用单引号 |
| 记录复审结果时误把内置 apply_patch 标记格式交给 git apply | 1 | Git 在写入前拒绝；改用标准 unified diff，未产生部分写入 |
| 首次标准补丁调用只定义了 JavaScript 变量但未传入 git apply stdin | 1 | Git 在写入前拒绝；改用带固定内容的 quoted heredoc，未产生部分写入 |
| commands 多 hunk 交互补丁最后一段因前置分页改动导致行上下文偏移 | 1 | Git 原子拒绝、确认无部分写入；拆分为路由、输入会话和目标处理三个小补丁 |
| 记录该错误与进展的多文件补丁在 progress 上下文未匹配 | 1 | Git 原子拒绝无部分写入；读取精确行号后改用 zero-context 追加 |
| 群聊消费端 zero-context guard 插入到既有 if ( 与条件之间 | 1 | node --check 与 commands 测试立即暴露 Unexpected token；替换完整条件块恢复结构 |
| 新回归测试 zero-context 追加落在上一 test 的尾部断言之前 | 1 | 21 项虽通过但被报告为嵌套 subtests；移动原尾部断言/闭包到新增测试之前后重跑 |
| GNU patch 成功/模糊匹配后留下两个 .orig 备份 | 1 | git status 发现后，经提升权限仅删除本轮生成的 src/commands.js.orig 与 test/commands.test.js.orig |
| git apply 再次拒绝重度修改 commands 文件的精确单行替换 | 1 | 无部分写入；改用路径限定、no-backup-if-mismatch 的 GNU unified patch 成功 |
| stale-input zero-context 插入落在 beginUiInput 函数外 | 1 | npm test 在模块加载时报 ReferenceError；定位顶层 src/commands.js:1108 后移动到函数体首行 |
| 新增 commands 测试文件结尾多一个空行 | 1 | git diff --check 精确报 test/commands.test.js:1387；删除 EOF 空行后复验 |
| SQLite cap test zero-context 追加再次落在原测试尾部断言之前 | 1 | 两项逻辑通过但报告为嵌套；移动原 scoped-cleanup 断言/闭包到新 test 之前后复跑 |
| progress zero-context 追加位于原 in_progress 状态之前 | 1 | 最终审计发现后，将 complete 状态移到 session 标题首部并删除旧状态行 |

## Interaction Final Verification

- npm test: 114/114 passed.
- npm run check: passed.
- git diff --check: passed.
- Wrangler 4.111.0 dry-run: passed, 322.01 KiB / gzip 73.89 KiB.
- Production migration/deploy, commit, push, and delivery replay were not performed.
