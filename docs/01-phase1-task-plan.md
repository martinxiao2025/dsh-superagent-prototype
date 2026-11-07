# 阶段一实施任务计划

> 依据：`docs/00-phase1-agent-plugins-migration.md`（阶段一：迁移到 agent-plugins 标准）
> 实施落点：**`d:\WorkSpace\dsh-superagent-prototype`（仓库根即当前项目目录，在原仓库内实施并保留历史与远端）**；基线 `main@8c32a9d`，工作在 `feat/phase1-agent-plugins`
> 版本基线：`0.1.0` | 约束基线：`AGENTS.md`
> 状态：执行中（批次 1/5 起） | 语言：简体中文 | 编码：UTF-8（无 BOM）
> **支持环境（2026-11-06 用户确认）：只支持并验证 Windows + VS Code Stable 的官方 Copilot / Copilot Chat。** Linux、macOS、WSL、其它编辑器/宿主、VS Code Insiders（已卸载）与 Copilot CLI（仅前置证据）均不在支持与验收范围；POSIX 专属对象（`#!/bin/sh` worker shim、systemd、POSIX 权限位、`scripts/dsh-superagent`）一律标为范围外，不再计入待办。详见 `AGENTS.md` §2.1。

## 0.0 后置修订：全量去 DSH（2026-11-07）

用户已选定**全量去 DSH**（方案 B）：删除 `@deepseek-ai/*` 依赖、`cordis.patch.yml`、DSH preset 与内嵌面板，`Runtime` 改为普通类并注入 `AgentHost`，面板改为自建回环网页，主会话由 `MainSession` 承担。执行顺序 B1（Runtime + MainSession）→ B2（测试迁移与删除证据）→ B3（DSH 清算）→ B4（持久队列、读游标与 `unread` 摘要）→ B5（真实端到端与生产收口），每片 `pnpm check` → 提交 → 推送。

因此本文件 §5 的任务表与 §7 验收矩阵中凡以 DSH 宿主 / bundle / preset 为对象的事项，以 B1–B5 的实际结果为准；编号文档侧的删除证据见 `docs/009` §10 与 `docs/010` §10。

## 0. 修订说明（2026-11-06）

**核对依据**：`docs/00-phase1-agent-plugins-migration.md`、本仓库 `main@8c32a9d` 基线与 `feat/phase1-agent-plugins` 分支当前代码、官方 1.0.0 两份 schema（已下载实读）、`AGENTS.md` 的约束基线。

**改了什么**

0. **实施根口径变更（2026-11-06，用户决策，不是文档纠错）**：实施根就是当前仓库 `d:\WorkSpace\dsh-superagent-prototype`，阶段一直接在原仓库内实施，保留 `main` 历史与 `origin` 远端。此前的「新建 `d:\superagent-plugin`、不导入 `.git`、原型只读」口径作废；T0.0 相应改为「在原仓库内建立基线」，不再执行 `robocopy`、`git init`。冲突与处理见 `AGENTS.md` §1.4。
1. **纠正 10 处与代码冲突的假设**（§2 B1–B10）：主会话工具实为 14 个、worker 实为 5 个；`mainTools` 需要真实 `Agent`（须引入 `ToolScope`）；端口占用不能走 `SetupError`（否则整个编排停摆）；管理 API 的 `x-orchestrator-request` 头 MCP 客户端不会发送；`lib/` 会被 tsdown `clean: true` 清空；文档编号只能续到 009；新增 SDK 运行时依赖需同步 `AGENTS.md`；内置技能不能挪进 `plugin/skills/`；健康条目需补中英文案；`homepage` 不得留占位符。
2. **任务拆分与补齐**：M0–M5 细化为 T0.1–T5.6 共 26 项；§5.0 增加「输入 / 产出 / 验收 / 预估」四列，每项都可独立判定完成；合并重复项（原「打包」「接线」并入 M1、M2），把过大的 M2 拆成作用域改造、映射层、端点、接线、文案五步。
3. **顺序按依赖链与风险重排**：基线 → 插件包与离线校验（零运行时风险，先锁合规）→ `ToolScope` 改造（唯一触及既有工具签名的改动，单独批次回归）→ MCP 映射与端点 → 测试防漂移 → 文档与主技能 → 验收。依据是：MCP 端点依赖 SDK 与作用域改造，测试依赖端点，文档依赖最终实现；而作用域改造一旦出错会影响既有 DSH 会话，必须最先被既有测试覆盖。
4. **批次 5 改为「按验收问题修复」**：A4（Copilot）与 A6（保活）需要用户环境配合，不预设修复内容，按实测结果逐项提交。
5. **细节修正**：MCP 的 DNS rebinding 白名单改为按实际监听端口生成（测试用 `mcpPort: 0` 时不能写死 3083）；T0.1 记录本机 pnpm 已为 11.7.0；新增 §11 执行记录，逐批写入真实输出。
6. **运行环境范围收敛（2026-11-06，用户确认）**：项目只支持 Windows + VS Code Stable 的官方 Copilot / Copilot Chat。验收矩阵与文档中的 POSIX 专属项（`#!/bin/sh` worker shim、systemd、POSIX 权限位、`scripts/dsh-superagent` 服务脚本）由「待验证」改为「范围外」；A4 固定为 Windows + VS Code Copilot，A6 只保留 Windows 保活演练，Copilot CLI 不计入正式验收。26 项跳过用例保留跳过并注明「范围外」，不伪装成通过。

**关键裁决**（§10 Q1–Q5，均按默认建议执行）：端口错误走健康条目；新增 `mcpEnabled`/`mcpPort`；不填占位地址；A4/A6 待用户配合；`AGENTS.md` 随 T4.4 纳入提交。

**未变**：阶段一非目标（不改领域逻辑、不做 MCP Apps、不做 CLI/C# 重写）、14 个工具面、仅回环监听、不引入 token。

## 1. 计划概览

### 1.1 目标

在不改动领域逻辑、不更换语言与运行时的前提下，让 dsh-superagent 成为一个符合 agent-plugins-spec 1.0.0 的 Copilot 插件：

1. 提交一个符合规范的插件目录（`plugin.json` + `mcp.json` + `skills/`），并通过官方 schema 的离线校验；
2. 在守护进程上新增独立的 MCP streamable-http 端点（`127.0.0.1:3083/mcp`），把主会话 14 个工具原样暴露给 Copilot；
3. 用自动化测试锁住「插件工具面 == DSH 主会话工具面」，并保证既有 Web 面板、DSH 会话、GitHub/飞书监听零回归；
4. 补齐安装、保活、安全边界与验收记录文档。

### 1.2 交付物

| 类别 | 交付物 |
| --- | --- |
| 插件包 | `plugin/plugin.json`、`plugin/mcp.json`、`plugin/skills/dsh-superagent/SKILL.md` |
| 构建与校验 | `scripts/build-plugin.mjs`、`scripts/validate-plugin.mjs`、`scripts/schemas/agent-plugins-1.0.0/*.json` |
| MCP 服务端 | `src/app/mcp.ts`、`src/app/mcp-tools.ts`、`src/app/tools/tool.ts` 的作用域改造 |
| 测试 | `tests/mcp.spec.ts`，以及测试夹具的两处小改 |
| 文档 | `docs/009-copilot-plugin.md`、`docs/007-architecture.md` 两张表、`docs/006-deployment.md` 配置表、`AGENTS.md` |
| 验收 | A1–A6 的实测记录（写入 `docs/009-copilot-plugin.md` 附录） |

### 1.3 明确不做

- 不改 `src/core`、Engine、Policy、Store、Executor、Sources 的领域行为；
- 不做 MCP Apps 面板、不做 CLI 驱动器、不做 C# 重写（阶段二/三/四）；
- 不做插件商店分发、签名、自动安装；
- 不为 MCP 引入 token/OAuth 鉴权；
- 不改 worker 的 5 个工具（`orchestrator_ack`、`orchestrator_thread_unrelated`、`orchestrator_thread_follow`、`orchestrator_trigger_handback`、`orchestrator_report`）。

### 1.4 变更文件清单

| 类型 | 文件 |
| --- | --- |
| 新增 | `plugin/plugin.json`、`plugin/mcp.json`、`plugin/skills/dsh-superagent/SKILL.md` |
| 新增 | `scripts/build-plugin.mjs`、`scripts/validate-plugin.mjs`、`scripts/schemas/agent-plugins-1.0.0/plugin.schema.json`、`scripts/schemas/agent-plugins-1.0.0/mcp.schema.json` |
| 新增 | `src/app/mcp.ts`、`src/app/mcp-tools.ts`、`tests/mcp.spec.ts`、`docs/009-copilot-plugin.md` |
| 修改 | `package.json`、`src/app/tools/tool.ts`、`src/app/tools/main.ts`、`src/app/assessment.ts`、`src/app/runtime.ts`、`src/deployment.ts`、`src/client/locales.ts` |
| 修改 | `tests/fixtures/deployment.ts`、`tests/fixtures/host.ts`、`docs/007-architecture.md`、`docs/006-deployment.md`、`README.md`、`AGENTS.md` |

除此以外的文件不应出现在本阶段的提交中。

## 2. 基线核对：文档与代码的偏差

以下 10 项已在仓库 `main@8c32a9d` 基线中逐条核实。B1–B4 会直接影响实现方式，必须在开工前裁决。

| # | 文档说法 | 代码事实 | 建议处理 |
| --- | --- | --- | --- |
| B1 | §4.2 说「主会话 14 个工具」，§4.2 表尾说「worker 6 工具」，验收 A3 说「20 个工具列出」 | `src/app/tools/main.ts` 实际注册 14 个；`src/app/tools/executor.ts` 实际注册 5 个 | 以代码为准：MCP 暴露 14 个；A3 改为「14 个工具」；文档中「worker 6 工具」改为 5 |
| B2 | §4.2 假设工具可直接映射 | `mainTools(host, agent)` 的第二参数是 DSH `Agent`：`prompt-preview` 资源键取 `agent.id`；`orchestrator_eval_read` 的图片分支需要真实 Agent（`agent.ctx.get('attachments')`、`agent.session.requestHeader()`） | 新增 `ToolScope`（`id` 必填、`agent` 可选）；MCP 传入 `{ id: masterId }`，图片读取在 MCP 侧返回结构化拒绝 |
| B3 | §4.3 要求 `mcp-port-busy` 走 `SetupError` 并进入健康面板 | `Setup.run()` 捕获 `SetupError` 后返回 `false`，`Runtime.initialize()` 直接 `return`，整个编排停摆 | 端口失败不进入 `SetupError`；改为 `HealthBoard` 的 `mcp` 条目（`ready`/`error`），编排照常 |
| B4 | §4.1 提出「沿用同源自定义头，可行性待确认」 | 管理 API 要求 `x-orchestrator-request: 1`（`src/app/http.ts:75-79`），MCP 客户端不会发送该头 | 放弃自定义头；仅绑回环 + Streamable HTTP 传输的 DNS rebinding 防护（Host/Origin 白名单），残余风险写入 009 |
| B5 | §3.4 输出到 `lib/plugin/`；§5 说仓库 `plugin/` 也可用 | `lib/` 在 `.gitignore`；tsdown 第一份配置 `clean: true` 会清空 `lib/` | `plugin/` 为唯一源；`build-plugin` 必须在 `tsdown` 之后执行；`lib/plugin/` 只作产物 |
| B6 | §7 要求新增 `docs/009-copilot-plugin.md` | 现有编号文档为 000–008；`tests/docs.spec.ts` 要求编号连续、只能链接更早文档、两张表同步 | 新文档固定为 `009`，只链接 ≤008；同步补 `docs/007` 的 Modules 与 Tests 两张表 |
| B7 | 未提及新增运行时依赖 | `AGENTS.md` 声明「zod 与 proper-lockfile 为仅有的运行时依赖」 | 新增 `@modelcontextprotocol/sdk`（锁定精确版本），同步修改 `AGENTS.md` 与 007 的依赖说明 |
| B8 | §3.3 说三个技能都放 `plugin/skills/` | `skills/` 下的技能会被 `src/app/skill-files.ts` 加载进 DSH 会话，且 `tests/tools.spec.ts` 断言内置技能恰为 feishu/github 两个 | 主技能只放 `plugin/skills/`；构建时把现有两个技能拷贝进 `lib/plugin/skills/`，不复制源码 |
| B9 | 未提及面板文案 | `src/client/locales.ts` 需中英双语键；`tests/locales.spec.ts` 校验键与占位符一致 | 新增健康条目时补 `health.mcp` 两条文案；不新增 `SetupCode`，因此无需 `setup.*` |
| B10 | §3.1 示例 `homepage` 含占位符 `<org>` | 官方 schema 只校验 `homepage` 为字符串，占位符能通过但不可用 | 删除 `homepage`/`repository`，或填入真实地址；不要提交占位符 |

### 2.1 官方 schema 已核实

已下载并确认两份 1.0.0 schema 的约束（可直接作为校验输入）：

- `plugin.schema.json`：`additionalProperties: false`；必填仅 `$schema`、`name`；`name` 为 1–64 位小写字母/数字/`.`/`-`，首尾字母数字，禁止 `--` 与 `..`；可选 `version`、`description`、`author`、`homepage`、`repository`、`license`、`keywords`、`extensions`。
- `mcp.schema.json`：`additionalProperties: false`；必填 `$schema`、`mcpServers`；`streamable-http` 变体必填 `type`、`url`，可选 `headers`，其余字段一律非法。
- 规范正文：技能只扫描 `skills/` 的**直接子目录**中的 `SKILL.md`，不递归；缺少固定位置不算错误；客户端加载时不得联网取 schema。

## 3. 设计决策

| # | 决策 | 采纳方案 | 理由 / 替代 |
| --- | --- | --- | --- |
| D1 | MCP 端点归谁管理 | `Runtime` 拥有生命周期（`initialize` 启动、`shutdown` 停止），`src/index.ts` 不新增逻辑 | 组合根已持有 `toolHost`、`masterId`、`HealthBoard`、`lifetime`；放在 index 会重复接线 |
| D2 | 工具作用域 | 新增 `ToolScope { id: string; agent?: Agent }`；DSH 会话传 `{ id, agent }`，MCP 传 `{ id: masterId }` | 避免伪造 `Agent`；14 个工具的描述与 schema 仍只有 `main.ts` 一个事实源 |
| D3 | 端口占用 | 健康条目 `mcp` 置 `error`，端点停用，进程继续 | 端口冲突不应停掉编排；与 B3 一致 |
| D4 | 鉴权 | 只绑 `127.0.0.1:3083`；启用 DNS rebinding 防护（`allowedHosts`、`allowedOrigins`）；不引入 token | MCP 客户端无法带自定义头；回环绑定与端口私有性作为边界，残余风险入档 |
| D5 | 工具映射方式 | 直接调用 `mainTools(host, scope)`，把 `Tool` 转成 MCP `{name, description, inputSchema, handler}` | 防漂移；不复制描述文本 |
| D6 | 入参校验 | MCP 层先 `tool.schema.parse(args)` 再执行 | MCP SDK 不校验入参；跳过会丢失 `.strict()`、默认值与 `refine` |
| D7 | 结果编码 | 成功：`content: [{type:'text', text: JSON.stringify(result)}]`；失败：`isError: true` + 结构化文本 | 保持现有返回值形状（如 `{results}` 保序、拒绝项不断批）；不声明 `outputSchema`，避免第二份契约 |
| D8 | 配置开关 | `Config` 新增 `mcpEnabled`（默认 `true`）与 `mcpPort`（默认 `3083`），非 volatile | 测试需要 `mcpEnabled: false` 与 `mcpPort: 0`；端口变更需同步改 `mcp.json`，文档写明 |
| D9 | schema 校验 | 官方 schema 落到 `scripts/schemas/agent-plugins-1.0.0/`，用 `ajv`（devDependency）离线校验 `plugin/` 与 `lib/plugin/` | 满足 A1「不联网执行」；校验脚本同时检查版本一致性与技能结构 |
| D10 | 会话管理 | 每个 MCP 会话一个 `Server` + `StreamableHTTPServerTransport`；`DELETE` 关闭；10 分钟空闲回收；`stop()` 全部关闭 | 防止长连接泄漏；避免复用 transport 造成会话串扰 |

## 4. 里程碑与依赖

```mermaid
flowchart LR
  M0[M0 环境与基线] --> M1[M1 插件包与构建校验]
  M1 --> M2[M2 MCP 端点与作用域改造]
  M2 --> M3[M3 测试与防漂移]
  M3 --> M4[M4 主技能与文档同步]
  M4 --> M5[M5 验收 A1-A6]
```

每个里程碑单独可验证、单独提交；M1–M4 的提交前都必须跑 `pnpm check`。

## 5. 任务分解

### 5.0 总览

预估单位为人日（单人）；「输入」是开工前必须已存在的事实，「产出」是提交里必须出现的文件或可观察状态。

| 编号 | 任务 | 输入 | 产出 | 前置 | 预估 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| T0.0 | 在当前仓库内建立实施基线 | 本仓库现有源码与 `main@8c32a9d` 历史（不复制、不新建仓库） | `feat/phase1-agent-plugins` 分支、干净工作区 | — | 0.2 | 分支正确；历史与 `origin` 远端保留；`git status` 干净 |
| T0.1 | 依赖安装与工具链对齐 | `package.json`、`pnpm-lock.yaml` | `node_modules/`、版本记录 | T0.0 | 0.2 | `pnpm install` 退出 0；`node -v`、`pnpm -v` 满足 `engines` |
| T0.2 | 分支与基线记录 | `main@8c32a9d` 的原型基线 | `feat/phase1-agent-plugins` 分支、§11 基线输出 | T0.1 | 0.1 | `pnpm typecheck/test/build` 三项真实结果留档 |
| T0.3 | 模型面基线快照 | `src/app/tools/*.ts`、`tests/model-surface.spec.ts` | 14/5 工具与 2 技能清单 | T0.2 | 0.1 | 清单逐名与代码一致 |
| T1.1 | `plugin.json` | 官方 `plugin.schema.json` | `plugin/plugin.json` | T0.2 | 0.1 | 通过官方 schema；无占位地址 |
| T1.2 | `mcp.json` | `plugin.json` 的版本 | `plugin/mcp.json` | T1.1 | 0.05 | 通过官方 schema；两份 `$schema` 版本一致 |
| T1.3 | 官方 schema 入库 | 官网两份 JSON | `scripts/schemas/agent-plugins-1.0.0/*.json` | T1.1 | 0.1 | 与下载件逐字一致（哈希比对） |
| T1.4 | 校验脚本 | 两份 schema、`plugin/` | `scripts/validate-plugin.mjs` | T1.3 | 0.3 | 正例退出 0；四类负例退出 1 |
| T1.5 | 打包脚本 | `plugin/`、`skills/` | `scripts/build-plugin.mjs` | T1.4 | 0.3 | `lib/plugin` 结构与方案 §3.4 一致；无 BOM |
| T1.6 | `package.json` 接线 | 脚本、SDK/ajv 版本 | `package.json`、`pnpm-lock.yaml` | T1.5 | 0.1 | `pnpm build`、`pnpm plugin:check` 可用 |
| T2.1 | 工具作用域改造 | `tools/tool.ts`、`main.ts`、`assessment.ts`、`runtime.ts` | `ToolScope` 与 4 处调用点 | T1.6 | 0.4 | 既有 `tools.spec`、`model-surface.spec` 全绿 |
| T2.2 | MCP 工具映射层 | `main.ts`、`ToolScope` | `src/app/mcp-tools.ts` | T2.1 | 0.5 | 14 个工具；描述与 schema 来自单一事实源 |
| T2.3 | MCP HTTP 端点 | SDK 1.32.2、`mcp-tools.ts` | `src/app/mcp.ts` | T2.2 | 0.8 | 握手、列工具、调用、DELETE 关闭全通 |
| T2.4 | 配置与 Runtime 接线 | `deployment.ts`、`runtime.ts` | `mcpEnabled`/`mcpPort`、端点生命周期 | T2.3 | 0.3 | 开关生效；`stop()` 后端口释放 |
| T2.5 | 健康与文案 | `locales.ts`、`HealthBoard` | `health.mcp` 中英双语 | T2.4 | 0.1 | `tests/locales.spec.ts` 通过 |
| T3.1 | 测试夹具扩展 | `tests/fixtures/host.ts` | Machine 覆盖、实际端口读取 | T2.5 | 0.2 | `mcpPort: 0` 时能读到实际端口 |
| T3.2 | 工具面防漂移 | `mcp-tools.ts`、`tools.spec.ts` | `tests/mcp.spec.ts`（工具面） | T3.1 | 0.3 | 名称/描述/schema 与 `main.ts` 逐项一致 |
| T3.3 | 协议链路 | SDK 内存与 HTTP 客户端 | 链路测试 | T3.2 | 0.5 | 握手 → 列表 → read → route 改状态 |
| T3.4 | 拒绝与恢复 | 错误映射实现 | 拒绝测试 | T3.3 | 0.3 | 非法参数结构化拒绝，紧随其后调用成功 |
| T3.5 | 端口占用与并发 | 健康条目、`Settings.save` revision | 占用/冲突测试 | T3.4 | 0.3 | 占用只报健康错误；过期 revision 被拒 |
| T3.6 | 全量回归 | 全部测试 | `pnpm check` 输出 | T3.5 | 0.2 | 全绿，无新增失败 |
| T4.1 | 主技能 | `prompts/orchestrator.md`、`admission.md`、`replies.md` | `plugin/skills/dsh-superagent/SKILL.md` | T3.6 | 0.6 | frontmatter 合规；只写操作路径与判据 |
| T4.2 | 插件文档 | 实现与验收输出 | `docs/009-copilot-plugin.md` | T4.1 | 0.6 | 8 节齐全；只链接 000–008 |
| T4.3 | 架构与部署文档 | `docs/007`、`docs/006`、`README.md` | 两张表与配置表 | T4.2 | 0.3 | `tests/docs.spec.ts` 通过 |
| T4.4 | 工作指南 | `AGENTS.md` | 依赖、命令、目录、技能说明 | T4.3 | 0.1 | 与实际命令和目录一致 |
| T5.1 | A1/A2 自动验收 | 校验脚本、`pnpm build` | 验收输出 | T4.4 | 0.1 | 退出码 0；目录结构与 §3.4 一致 |
| T5.2 | A3 inspector 验收 | `@modelcontextprotocol/inspector` | 工具清单与调用记录 | T5.1 | 0.2 | 握手成功、14 个工具、调用返回 |
| T5.3 | A4 Copilot 冒烟 | Windows + VS Code Stable Copilot | 冒烟记录 | T5.2 | 0.3 | 三技能可见；accept 全链路可查 |
| T5.4 | A5 回归观察 | 真实 GitHub/飞书触发 | 观察记录 | T5.3 | 0.3 | 面板、主会话评估、监听行为不变 |
| T5.5 | A6 保活演练 | Windows 守护脚本（systemd 范围外） | 演练记录 | T5.4 | 0.2 | kill 后自动拉起并重连 |
| T5.6 | 验收记录归档 | A1–A6 输出 | `docs/009` 附录 | T5.5 | 0.1 | 命令、输出、日期、执行人可追溯 |

合计约 7.6 人日；其中 T5.3、T5.5 依赖用户环境，其余可在本机闭环。

### M0 环境与基线

**T0.0 在当前仓库内建立实施基线**

1. 不新建目录、不复制源码：实施根就是已含原型历史的 `d:\WorkSpace\dsh-superagent-prototype`，阶段一直接在 `feat/phase1-agent-plugins` 分支提交。
2. 保留 `main@8c32a9d` 历史与 `origin` 远端；不改写已推送历史，不 force push。
3. 原有 `AGENTS.md`、`docs/00-…`、`docs/01-…`、`.screenshots/` 原样保留；口径变更记入 `AGENTS.md` §1.4。
4. 验收：`git status -sb` 显示工作区干净、分支为 `feat/phase1-agent-plugins`，提交历史含阶段一批次且与远端一致。

**T0.1 依赖安装与工具链对齐**

1. Node 只需满足 `package.json` 的 `engines` 最低支持版本（当前为 `^22.19.0 || >=24.0.0`），不要求与某个具体版本精确一致；本机 `node -v` 的实测值只作环境记录，不作为门槛。
2. pnpm 由 `packageManager: pnpm@11.7.0` 锁定；若换机后版本不符，先 `corepack prepare pnpm@11.7.0 --activate`。
3. 在本仓库根执行 `pnpm install`（无 `node_modules` 时需联网）。
4. 若安装失败或 Node 版本低于 `engines` 下限，记录实际错误并暂停，不得跳过基线直接开发。

**T0.2 分支与基线记录**

1. 在本仓库执行 `git switch -c feat/phase1-agent-plugins`（基线 `main@8c32a9d` 已存在，直接切出阶段一分支）。
2. 依次执行 `pnpm typecheck`、`pnpm test`、`pnpm build`，把真实输出（通过数、失败项、是否已有失败）记录到本计划的执行记录中。
3. Windows 上既有测试存在环境性失败（`sh`/`sleep`/`env` 缺失、symlink EPERM、POSIX 权限位、路径分隔符），必须逐条记录，**不得**改测试迁就；结论中区分「环境性失败」与「本阶段引入的失败」。

**T0.3 模型面基线快照**

记录以下事实，供 T3.2 与 T4.1 对齐：

- 主会话工具 14 个：`orchestrator_read`、`orchestrator_route`、`orchestrator_ticket_retry`、`orchestrator_ticket_request_status`、`orchestrator_ticket_note`、`orchestrator_trigger_requeue`、`orchestrator_eval`、`orchestrator_eval_read`、`orchestrator_eval_decide`、`orchestrator_reply`、`orchestrator_thread_unsubscribe`、`orchestrator_settings_save`、`orchestrator_policy_sync`、`orchestrator_prompts_save`。
- worker 工具 5 个：`orchestrator_ack`、`orchestrator_thread_unrelated`、`orchestrator_thread_follow`、`orchestrator_trigger_handback`、`orchestrator_report`。
- 内置技能 2 个：`dsh-superagent-github`、`dsh-superagent-feishu`。

### M1 插件包与构建校验

**T1.1 `plugin/plugin.json`**

按官方 schema 写最小但完整的清单：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "dsh-superagent",
  "version": "0.1.0",
  "description": "Proactive coding agent for one GitHub repository: evaluate requests, route tickets, and drive workers from Copilot.",
  "license": "MIT",
  "keywords": ["agent", "orchestrator", "github", "feishu"]
}
```

要点：`name` 与目录语义一致；不写 `homepage`/`repository` 占位符；`version` 必须与 `package.json` 一致（由 T1.4 校验）。

**T1.2 `plugin/mcp.json`**

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "dsh-superagent": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3083/mcp"
    }
  }
}
```

要点：只允许 `type` 与 `url` 两个字段；`$schema` 版本必须与 `plugin.json` 完全一致。

**T1.3 官方 schema 入库**

1. 下载 `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` 与 `.../mcp.schema.json`。
2. 原样保存到 `scripts/schemas/agent-plugins-1.0.0/`，不修改、不格式化、不加注释。
3. 记录来源 URL 与取得日期到执行记录；校验时不得联网。

**T1.4 `scripts/validate-plugin.mjs`**

校验内容（任何一项失败即退出码 1，并打印具体文件与原因）：

1. `plugin.json`、`mcp.json` 通过对应官方 schema（`ajv/dist/2020`，`strict: false`）。
2. 两份文件的 `$schema` 指向同一 1.0.0 版本。
3. `plugin.json.version === package.json.version`。
4. `mcpServers` 的每个 URL 为 `http://127.0.0.1:<port>/mcp` 或 `http://localhost:<port>/mcp`（回环 http 才合规）。
5. `skills/` 若存在：只允许直接子目录；每个技能目录必须有 `SKILL.md`；frontmatter 必须含单行 `name`、`description`；`name` 与目录名一致。
6. 所有文本文件为 UTF-8 且无 BOM。
7. 支持 `--dir <path>`，默认 `plugin`；`lib/plugin` 存在时一并校验。

负例自测（必须实际执行并记录）：改坏 `name` 大写、把两个 `$schema` 版本改成不同值、在 `skills/` 下多套一层目录、给 `mcp.json` 增加未知字段。

**T1.5 `scripts/build-plugin.mjs`**

1. 先删除 `lib/plugin`，再重建。
2. 拷贝 `plugin/plugin.json`，用 `package.json` 的 `version` 覆盖注入。
3. 拷贝 `plugin/mcp.json`。
4. 组装 `lib/plugin/skills/`：拷贝 `plugin/skills/` 下的所有直接子目录，再拷贝 `skills/dsh-superagent-github` 与 `skills/dsh-superagent-feishu`（单一事实源，避免复制维护）。
5. 统一写为 UTF-8 无 BOM、LF 换行；打印最终目录树。
6. 任一步失败以非零退出码结束，不产出半成品。

**T1.6 `package.json` 接线**

1. `dependencies` 增加 `@modelcontextprotocol/sdk`（安装后锁定精确版本，不用 `^`）。
2. `devDependencies` 增加 `ajv`（仅校验脚本使用）。
3. `files` 数组增加 `plugin`。
4. `scripts`：
   - `"plugin:build": "node scripts/build-plugin.mjs"`
   - `"plugin:check": "node scripts/validate-plugin.mjs && node scripts/validate-plugin.mjs --dir lib/plugin"`
   - `"build": "tsdown && node scripts/build-plugin.mjs"`
   - `"check": "pnpm typecheck && pnpm test && pnpm build && pnpm plugin:check"`
5. 说明：顺序不可颠倒，`tsdown` 的 `clean: true` 会清空 `lib/`。

**M1 完成判据**

- `pnpm build` 产出 `lib/plugin/{plugin.json,mcp.json,skills/…}`；
- `pnpm plugin:check` 通过；
- 四类负例均被拒绝；
- 此时 `lib/plugin/skills/` 只有 2 个技能，主技能在 M4 补齐。

### M2 MCP 端点与作用域改造

**T2.1 工具作用域改造（唯一触及既有工具签名的改动）**

1. `src/app/tools/tool.ts` 新增：

```ts
export interface ToolScope {
  /** 资源分页与 prompt-preview 的键：DSH 会话 id，或 MCP 使用的 masterId。 */
  readonly id: string
  /** 仅 DSH 会话提供；MCP 调用没有附件服务与模型路由。 */
  readonly agent?: Agent
}
```

2. `src/app/tools/main.ts`：`mainTools(host, scope: ToolScope)`；把 `agent.id` 改为 `scope.id`；`assessor.read(agent, …)` 改为 `assessor.read(scope.agent, …)`。
3. `src/app/assessment.ts`：`read(agent: Agent | undefined, read, signal)`；图片分支在 `agent === undefined` 时抛出固定英文错误：`Image reads are available only in the DSH main Session`。
4. `src/app/runtime.ts`：`mainTools(this.toolHost, { id: agent.id, agent })`。
5. 不改 `src/core`，不改工具描述与 schema。

**T2.2 `src/app/mcp-tools.ts`**

1. 导出 `McpTool`：`{ name, description, inputSchema, execute(args, signal) }`。
2. 导出 `mcpTools(host, id: string)`：调用 `mainTools(host, { id })` 映射；`inputSchema` 用 `z.toJSONSchema(tool.schema, { io: 'input' })` 生成，去掉 `$schema` 键，保留 `additionalProperties: false`。
3. `CallTool` 必须先 `tool.schema.safeParse(args ?? {})`，成功后再调用 `tool.execute(parsed.data, signal)`。
4. 错误统一转换：校验失败 → `{ error: '参数无效', issues }`；`UserError` → `{ error: message, code }`；其他 → `{ error: message }`，并以 `isError: true` 返回。
5. 导出 `mountTools(server, tools)`：在给定 `Server` 上注册 `tools/list` 与 `tools/call`，HTTP 层与测试共用。

**T2.3 `src/app/mcp.ts`**

1. 新增 `McpEndpoint` 类（必须带 JSDoc，`tests/class-docs.spec.ts` 强制）。
2. 宿主接口 `McpEndpointOptions` 包含：`port`、`tools: readonly Tool[]`、`health: HealthEntry`、`log`。
3. `start()`：
   - `node:http` 创建服务器，`listen(port, '127.0.0.1')`；
   - 只处理 `/mcp`；`POST` 解析 JSON（上限 4 MiB，超限返回 HTTP 413）后交给对应会话的 transport；`GET`/`DELETE` 按 `mcp-session-id` 查找；
   - 无会话的 `POST` 新建 `StreamableHTTPServerTransport`（`sessionIdGenerator`、`enableDnsRebindingProtection: true`、`allowedHosts`/`allowedOrigins` 按**实际监听端口**生成，`port: 0` 时取 `server.address()`，不得写死 3083）与 `Server` 并连接；
   - 会话空闲 10 分钟自动关闭；`DELETE` 立即关闭；
   - `listening` 时健康置 `ready`（detail 写明地址）；`EADDRINUSE` 等其他错误置 `error`（detail 写明端口与原因），进程不退出。
4. `stop()`：关闭所有会话、关闭 HTTP 服务器、清理定时器；响应 `lifetime` 的 abort。
5. 暴露只读 `port`（`server.address()`），供测试在 `port: 0` 时读取实际端口。

**T2.4 `src/deployment.ts` 与 `src/app/runtime.ts` 接线**

1. `Config` 增加 `mcpEnabled: s.boolean().default(true)` 与 `mcpPort: s.number().min(0).max(65535).step(1).default(3083)`；`Machine` 与 `machineOf` 同步；两者非 volatile。
2. 同步更新 `tests/fixtures/deployment.ts` 的 `testMachine` 默认值（`mcpEnabled: false`、`mcpPort: 0`），否则 `pnpm typecheck` 与既有测试无法通过。
3. `Runtime` 持有 `mcp?: McpEndpoint`，并在构造时认领 `mcp` 健康条目；`mcpEnabled` 为假时把该条目标为 `paused`。
4. 在 `initialize()` 中，`setup.run()` 成功且主会话 `sessions.ensure()` 之后启动端点（代码事实；原计划的“setup 之前启动”未采纳：工具需要主会话已就绪，等待 setup 期间由面板负责配置）。
5. `shutdown()` 中在关闭 Store 之前 `await this.mcp?.stop()`，保证端口释放。
6. `mcp.ts` 的 `SERVER_VERSION` 与 `package.json` 的 `version` 由 `tests/mcp.spec.ts` 断言一致，避免第二份版本长期漂移。

**T2.5 健康与文案**

1. `src/client/locales.ts` 增加 `health.mcp` 中文/英文各一条。
2. 不新增 `SetupCode`；端口错误只出现在 `mcp` 健康条目，面板概况按现有健康条目渲染。

**M2 完成判据**

- `pnpm typecheck` 通过；
- 既有 `pnpm test` 全绿（T2.1 不改变行为）；
- 临时脚本或 inspector 能完成握手并列出 14 个工具；
- 关闭进程后 3083 端口释放。

### M3 测试与防漂移

**T3.1 测试夹具扩展**

1. `tests/fixtures/host.ts`：`startRuntime(seed?, { mcpPort })` 支持覆盖 Machine 的 MCP 配置；`Host.mcpPort()` 读取实际端口。
2. 确认 `tests/fixtures/deployment.ts` 已在 T2.4 更新默认值（默认不监听端口），本任务只做覆盖能力。

**T3.2 工具面防漂移**

1. 断言 `mcpTools(runtime.toolHost, { id: masterId }).map(t => t.name)` 与 `h.tools.get(masterId)` 的键集合完全相等，长度为 14。
2. 对 3 个复杂 schema 做 JSON Schema 快照/结构断言：`orchestrator_route`（数组、20 项上限、`additionalProperties: false`）、`orchestrator_read`（默认值与上下限）、`orchestrator_settings_save`（`value` 为任意值、`source` 的条件校验）。
3. 断言每个 MCP 工具的描述与 `main.ts` 中的描述逐字一致。

**T3.3 协议链路**

1. 用 `InMemoryTransport.createLinkedPair()` 连接 `createToolServer` 与 MCP `Client`。
2. 流程：`initialize` → `tools/list` → `orchestrator_read tickets` → `orchestrator_route accept` → 断言 Store 出现 Ticket、返回 `{results:[…]}` 形状不变。
3. 再用 `mcpPort: 0` 起真实 HTTP 端点，用 `StreamableHTTPClientTransport` 复跑一次握手与 `tools/list`，验证 `mcp.json` 约定的 URL 形态可用。

**T3.4 拒绝与恢复**

1. `orchestrator_ticket_note` 传空 `text` → `isError: true`，payload 含 `issues`。
2. `orchestrator_read` 传未知资源 → 结构化拒绝；紧接着调用 `orchestrator_read tickets` 成功。
3. 未配置完成（无主会话 Agent 且无 setup）时：`tools/list` 可用，`orchestrator_eval_read` 的图片分支返回固定错误而非崩溃。

**T3.5 端口占用与双入口并发**

1. 同端口启动第二个端点 → 第二个健康条目为 `error`，Runtime 仍为 `ready`。
2. MCP 与面板同时保存同一设置块，使用过期 `revision` 的一方得到冲突错误，且不覆盖新值。

**T3.6 全量回归**

执行 `pnpm check`，并单独确认以下既有测试未受影响：`tests/tools.spec.ts`、`tests/model-surface.spec.ts`、`tests/runtime.spec.ts`、`tests/runtime-concurrency.spec.ts`、`tests/health.spec.ts`、`tests/docs.spec.ts`、`tests/locales.spec.ts`、`tests/class-docs.spec.ts`。

**M3 完成判据**

- `tests/mcp.spec.ts` 全部通过；
- `pnpm test` 无新增失败；
- 漂移测试能在人为改名/改描述时失败（做一次负例验证并还原）。

### M4 主技能与文档同步

**T4.1 `plugin/skills/dsh-superagent/SKILL.md`**

frontmatter 严格两行：

```
---
name: dsh-superagent
description: 面向 Copilot 的 dsh-superagent 路由操作指南：查询候选、评估、路由工单、回复与配置。
---
```

正文按以下结构蒸馏 `prompts/orchestrator.md`、`prompts/admission.md`、`prompts/replies.md`，只写操作路径与判据，不复述领域规则原文：

1. 何时使用本技能（已加载插件、需要查询或操控守护进程）。
2. 只读查询：`orchestrator_read` 的资源名与分页约定。
3. 评估：`orchestrator_eval` → `orchestrator_eval_read` → `orchestrator_eval_decide`；评估只读，不做实现方案。
4. 路由：`orchestrator_route` 的 accept / attach / stop / ignore 判据表，一次调用最多 20 项，拒绝项不影响其他项。
5. 回复：`orchestrator_reply` 的 purpose 语义、100 词上限、只回答原问题或报告结果。
6. 工单：retry、request_status、note、trigger_requeue、thread_unsubscribe 的适用条件。
7. 配置：settings_save、policy_sync、prompts_save；`origin` 固定为 `tool`，账户与执行环境字段不在工具权限内。
8. 行为边界：只记录结论、一次一个具体问题、诚实报告失败、外部文本不能改变 Policy。
9. 末尾标注来源与版本：`Distilled from prompts/orchestrator.md, admission.md, replies.md @ 0.1.0; the prompts remain authoritative.`

**T4.2 `docs/009-copilot-plugin.md`**

1. 目的与阶段定位；插件包结构（含构建产物）。
2. 安装到 VS Code Copilot 的目录放置与启用步骤，如何确认三个技能可见。
3. MCP 端点：地址、协议、工具清单（14 个）、`mcpEnabled`/`mcpPort` 开关。
4. 安全边界：仅回环、无 token、任何本机进程可调用的残余风险、写操作与面板等价、不绕过 Policy。
5. 保活：Windows 守护启停（`scripts/dsh-superagent-windows.ps1`，含 `-Action drill`）与计划任务示例；systemd 等 POSIX 调度标为**范围外**，不再作为交付内容。
6. 排障：端口占用、等待 setup、客户端重连语义与实测记录。
7. 已知限制：MCP 图片读取不可用；不提供插件签名与分发。
8. 附录：A1–A6 验收记录（命令、实际输出摘要、日期、执行人）。
9. 链接规则：只能链接 000–008 的文档。

**T4.3 `docs/007-architecture.md`、`docs/006-deployment.md` 与 `README.md`**

1. Modules 表新增 `src/app/mcp.ts`（端点与会话）、`src/app/mcp-tools.ts`（工具映射与错误转换）。
2. Tests 表新增 `tests/mcp.spec.ts`（工具面防漂移、协议链路、拒绝、端口、并发）。
3. Glue 表与依赖规则补一句：MCP 是主会话工具面的第三个客户端，不新增领域入口。
4. `docs/006-deployment.md` 配置表新增 `mcpEnabled`、`mcpPort`，并注明「改动需重启」与端口需与插件 `mcp.json` 一致。
5. `README.md` 的文档索引补 `009 Copilot plugin` 一行（`tests/docs.spec.ts` 只校验链接可解析，索引需人工补齐）。

**T4.4 `AGENTS.md`**

1. 运行时依赖改为「zod、proper-lockfile 与 `@modelcontextprotocol/sdk`」。
2. 常用命令补 `pnpm plugin:build`、`pnpm plugin:check`。
3. 目录表补 `plugin/`（agent-plugins 源）与 `lib/plugin/`（构建产物）。
4. 技能说明补主技能的位置与「不进 `skills/`」的原因。

**M4 完成判据**

- `pnpm build && pnpm plugin:check` 通过，`lib/plugin/skills/` 含 3 个技能；
- `pnpm check` 全绿（含 docs、locales、class-docs）；
- 人为删除 Modules 表任一行时 `tests/docs.spec.ts` 失败（负例验证后还原）。

### M5 验收

**T5.1 A1/A2**

```powershell
pnpm install
pnpm check
Get-ChildItem -Recurse lib\plugin | Select-Object FullName
node scripts/validate-plugin.mjs
node scripts/validate-plugin.mjs --dir lib/plugin
```

通过标准：校验退出码 0；`pnpm check` 全绿；目录结构与方案 §3.4 一致。

**T5.2 A3**

```powershell
npx -y @modelcontextprotocol/inspector --cli http://127.0.0.1:3083/mcp --method tools/list
```

通过标准：握手成功；列出 14 个工具；任选 `orchestrator_read` 调用返回分页结果。记录工具名与数量。

**T5.3 A4（需用户配合）**

在 VS Code Copilot 中放置 `lib/plugin/`，启用后确认：三个技能可见；聊天中查候选 → accept → Ticket 创建 → worker 执行 → 结果可查。截图或文本记录关键步骤。

**T5.4 A5**

1. 运行完整 `pnpm test`；
2. 观察一轮真实 GitHub 触发：监听 → 候选 → 主会话评估 → 路由；
3. 打开 Web 面板核对 Ticket、线程、设置与健康条目；
4. 确认 MCP 调用与面板操作互不覆盖（revision 冲突按预期拒绝）。

**T5.5 A6**

1. Windows：用 `scripts/dsh-superagent-windows.ps1 -Action drill` 强杀真实宿主，确认自动拉起；
2. （可选，Windows）由计划任务在登录时调用 `-Action start` 实现开机自启；
3. Copilot 侧重新连接，确认 `tools/list` 恢复。

systemd/`kill -9` 等 POSIX 调度为**范围外**，不再作为 A6 步骤。

**T5.6 验收记录归档**

把 A1–A6 的命令、真实输出摘要、失败与修复过程、日期写入 `docs/009-copilot-plugin.md` 附录；不得只写「通过」。

## 6. 提交批次

| 批次 | 范围 | 提交信息（Conventional Commits） | 提交前验证 |
| --- | --- | --- | --- |
| 1 | M0 + M1 | `feat(plugin): add agent-plugins package and offline schema checks` | `pnpm check`（含新增 `plugin:check`） |
| 2 | M2 | `feat(mcp): serve the main session's tools over streamable HTTP` | `pnpm check` + 手工握手 |
| 3 | M3 | `test(mcp): lock the MCP tool surface to the main session` | `pnpm check` |
| 4 | M4 | `docs(plugin): document Copilot installation, keepalive and limits` | `pnpm check` |
| 5 | M5 修复 | 按实际验收问题提交，一次一个问题 | `pnpm check` |

纪律：

- 只暂存本批次文件，不夹带 `.zcode/`、无关格式化或未跟踪文件；
- 不提前 push；
- 每批次结束给出真实命令输出，不以「应该通过」代替。

## 7. 验收矩阵

| # | 验收项 | 验证方式 | 通过标准 | 责任 |
| --- | --- | --- | --- | --- |
| A1 | 规范合规 | `node scripts/validate-plugin.mjs`、`--dir lib/plugin` | 两份清单通过官方 1.0.0 schema；`$schema` 一致；版本一致 | 实施 |
| A2 | 构建打包 | `pnpm check`、目录树检查 | 全绿；`lib/plugin` 结构与 §3.4 一致 | 实施 |
| A3 | MCP 连通 | MCP inspector CLI/UI 连 `http://127.0.0.1:3083/mcp` | 握手、14 工具、调用返回 | 实施 |
| A4 | Copilot 冒烟 | Windows + VS Code Stable 的官方 Copilot Chat 加载插件（CLI、Insiders、其他宿主不计入） | 插件与三技能可见；accept 全链路可查 | 用户 + 实施 |
| A5 | 回归 | `pnpm test` + 一轮真实触发 + 面板核对 | 面板、主会话评估、监听行为不变 | 实施 |
| A6 | 保活演练 | Windows 守护脚本：强杀进程 → 自动拉起 → 客户端重连（systemd 等 POSIX 调度范围外） | 自动恢复，工具可用 | 用户 + 实施 |

状态（2026-11-06）：A1/A2 通过；A3 以官方 SDK 客户端走真实 HTTP 链路作**等价验证**，inspector CLI/UI 未执行（本地没有可独立启动的 MCP 宿主进程）；A6 已用 Windows 守护脚本对真实 `Runtime` 完成强制终止演练并通过（首次就绪 2416ms，`taskkill /F` 后 30152ms 恢复，恢复前后 14 个工具、`runtime`/`mcp` 均 `ready`，详见 `docs/009-copilot-plugin.md` §10）；A4 已在 **Windows + VS Code Stable 1.145.2 的官方 Copilot Chat（内置 0.73.0）** 中实测通过：插件 `dsh-superagent@0.1.0` 启用、三个技能可见、宿主 14 个工具、用 `DeepSeek V4.1 Flash` 真实调用 `orchestrator_read`/`orchestrator_route`/`orchestrator_reply`（第三个被领域规则以 `notReady` 拒绝，属真实结果），Copilot CLI 与已卸载的 Insiders 均不计入（见 §11）；A5 仅完成测试回归，真实 GitHub/飞书触发未执行。A3 的 inspector 不标为“通过”。

## 8. 风险登记

| # | 风险 | 触发信号 | 缓解 | 验证 |
| --- | --- | --- | --- | --- |
| R1 | `z.toJSONSchema` 对 `refine`/联合/`unknown` 的表示与预期不同 | 某工具 `inputSchema` 缺字段或类型错误 | 复杂 schema 手写 JSON Schema 覆盖；T3.2 结构断言 | `tests/mcp.spec.ts` |
| R2 | MCP SDK 与 zod 4 或 Node 版本不兼容 | 握手/编译失败 | 安装后锁定精确版本；必要时降级 SDK 并记录 | 内存传输 + 真实 HTTP 两条链路 |
| R3 | DNS rebinding 白名单与 Copilot 客户端行为冲突 | inspector 通过、Copilot 握手 403 | 先保留 `allowedHosts`，必要时去掉 `allowedOrigins`（仅回环）并记录决策 | A3/A4 |
| R4 | `ToolScope` 改造影响 DSH 工具 | 既有 `tools.spec`/`model-surface.spec` 失败 | Runtime 仍传真实 Agent；只把 `agent.id` 改 `scope.id` | `pnpm check` |
| R5 | 图片读取在 MCP 不可用 | `orchestrator_eval_read` 的 `image` 返回拒绝 | 明确结构化错误 + 009 已知限制；A4 不测图片 | T3.4 |
| R6 | 主技能与提示词语义漂移 | 技能描述与 `prompts/` 冲突 | 技能只写操作路径与判据；标注来源与版本；权威仍在 `prompts/` | 人工评审 |
| R7 | 双入口并发写设置 | 面板与 MCP 同时保存 | 沿用 `Settings.save` 的 revision 机制 | T3.5 |
| R8 | 构建顺序错误导致插件产物被清空 | `lib/plugin` 缺失 | `build` 串成 `tsdown && plugin:build`；`plugin:check` 兜底 | A2 |
| R9 | 端口占用影响守护进程 | 3083 被其他程序占用 | 健康条目报错、端点停用、编排继续 | T3.5 |
| R10 | 仓库已有未跟踪文件被误提交 | `git status` 出现 `.zcode/`、`AGENTS.md` | 按文件暂存，提交前核对 `git diff --cached --name-only` | 每批次 |

## 9. 完成定义（DoD）

- [ ] `plugin.json`、`mcp.json` 通过官方 1.0.0 schema 离线校验，且 `$schema`、版本一致；
- [ ] `pnpm build` 产物含 `lib/plugin/{plugin.json,mcp.json,skills/×3}`；
- [ ] `pnpm check` 全绿（typecheck、全部测试、build、plugin:check）；
- [ ] `tests/mcp.spec.ts` 覆盖：工具面防漂移、内存传输链路、真实 HTTP 握手、非法参数拒绝、端口占用、并发写冲突；
- [ ] MCP 暴露 14 个工具，描述与 schema 来自 `src/app/tools/main.ts` 单一事实源；
- [ ] 端口失败只影响 `mcp` 健康条目，不影响 Web 面板、DSH 会话与监听；
- [ ] `docs/009-copilot-plugin.md` 含安装、安全、保活、排障、已知限制与 A1–A6 实测记录；
- [ ] `docs/007` 两张表、`docs/006` 配置表、`AGENTS.md` 同步完成；
- [ ] A1–A6 全部按真实命令验证并记录，未通过项如实列出。

## 10. 待确认事项

| # | 事项 | 默认建议 |
| --- | --- | --- |
| Q1 | 是否接受 B3 的调整：端口错误走健康条目而非 `SetupError` | 接受（否则端口占用会让整个守护进程停在 setup） |
| Q2 | 是否接受新增 `mcpEnabled`/`mcpPort` 两个机器配置 | 接受（测试需要 `port: 0`，部署需要应急换端口） |
| Q3 | `plugin.json` 是否填写 `homepage`/`repository` | 暂不填，留待有正式仓库地址时补 |
| Q4 | A4/A6 需要用户配合的时间窗口 | 由用户指定，实施方先完成 A1/A2/A3/A5 |
| Q5 | 是否把 `AGENTS.md` 纳入本阶段提交 | 是（T4.4 会修改它，且它当前未被跟踪） |

## 11. 执行记录

| 批次 | 日期 | 命令 / 动作 | 真实结果 | 提交 |
| --- | --- | --- | --- | --- |
| 基线 | 2026-11-06 | `git status`、`node -v`、`pnpm -v` | 原型 `main@8c32a9d`；未跟踪 `.zcode/`、`AGENTS.md`；Node 满足 `engines`（环境记录，不作门槛）、pnpm 11.7.0 | — |
| 迁入 | 2026-11-06 | `robocopy … /XD node_modules lib .zcode .git /XF AGENTS.md` | 源码/测试/配置/脚本/技能已入本根；`AGENTS.md`、`docs/00`、`docs/01`、`.screenshots` 未覆盖 | `73ccce7` |
| 基线测试（原型） | 2026-11-06 | `vitest run --reporter=json` | 8 个文件失败，全部为 Windows 环境性：`sh`/`sleep`/`env`/`gh` ENOENT、symlink EPERM、POSIX 权限位、`docs.spec` 反斜杠路径。非本阶段代码引入 | — |
| 1 | 2026-11-06 | `pnpm install`、`pnpm build`、`node scripts/validate-plugin.mjs` | 安装退出 0；`lib/plugin` 生成；正例退出 0；4 类负例均退出 1 | `5f9c999` |
| 2 | 2026-11-06 | `pnpm typecheck`、`vitest run tests/tools.spec.ts tests/model-surface.spec.ts` | typecheck 退出 0；两组防漂移测试通过；MCP 端点、映射层、配置、健康与文案落地 | `38726b4` |
| 3 | 2026-11-06 | `vitest run tests/mcp.spec.ts`、全量 `vitest run` | mcp 4 项全过（握手、14 工具、read、route 建票、非法参数、端口占用）；全量 1159 通过 / 42 失败 / 8 文件，与基线完全一致 | `3a4b5bd` |
| 4 | 2026-11-06 | `pnpm build`、`pnpm plugin:check` | `plugin/` 1 技能、`lib/plugin/` 3 技能均 valid；009、006、README、AGENTS 同步 | `781ab5d` |
| A1/A2 | 2026-11-06 | 正例 + 4 负例 + 构建 | 全部符合预期；`lib/plugin/` 结构与方案 §3.4 一致；全仓跟踪文件 BOM 数为 0 | 本批 |
| A3–A6 | 2026-11-06 | 见 `docs/009-copilot-plugin.md` §8 | A3 自动等价通过，inspector 未执行；A4 因官方客户端缺失未通过；A5 仅测试回归，真实触发未执行 | 本批 |
| A6 保活演练 | 2026-11-06 | `pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action drill -Profile host -Command 'node --experimental-transform-types scripts/keepalive-host.mjs'` | 退出 0；首次就绪 2416ms；`taskkill /F /T` 后 30152ms 恢复，13 次重启尝试；恢复前后 `tools/list` 均 14 个、`runtime`/`mcp` 均 `ready`；发现并记录 `proper-lockfile` 的 30 秒锁窗口；证据 `.artifacts/keepalive/drill-20261106-203750.json` | 本批 |
| A4 范围收敛与客户端就位 | 2026-11-06 | `pwsh -NoProfile -File scripts/copilot-smoke.ps1`、`code --install-extension GitHub.copilot-chat --force`、`node scripts/keepalive-probe.mjs` | 用户卸载 Insiders 后，A4 范围收敛为 Windows + VS Code Stable 1.119.0 的官方 Copilot Chat；Stable 内置 `GitHub.copilot-chat@0.47.0` 就位，市场安装因“内置版本不可降级”退出 1；`scripts/copilot-smoke.ps1` 改为 Stable-only（去掉 `-Editor`/`-RunModel`，CLI 仅作前置证据），5 个必需项全部 ok、`a4Status=client-ready-manual-pending`；宿主探针 14 工具；`-Action stop` 不再残留手动停止标记。A4 保持“客户端就位、待人工验证”，不标通过 | 本批 |
| 中文化·文档与技能 | 2026-11-06 | 逐文件翻译后跑 `pnpm check` | `docs/000`–`009`、README、`plugin/skills/**` 与 `skills/**` 转简体中文；标识符、工具名、路径、协议值保持英文 | `c89721f`、`b084c0f` |
| 中文化·代码注释 | 2026-11-06 | `pnpm check` | `src/**`、`scripts/**`、`tests/**` 的 174 个文件的 `//`、`/* */`、JSDoc 全部中文；逻辑与断言未改 | `92f3007` |
| 中文化·面向人文案 | 2026-11-06 | `pnpm check` | `USER_ERRORS`、健康条目、CLI/脚本输出、`plugin.json`/`package.json` 描述等 81 个文件；`locale/en.json` 与英文语言包按设计保留 | `dcaff6e` |
| 中文化·模型运行时资产 | 2026-11-06 | `pnpm check`、`tests/model-surface.spec.ts` | `prompts/**`、14 个主会话工具的描述与 schema 说明、executor 指令共 38 个文件；工具名、参数名、机器解析串未翻译 | `330df33` |
| 真实运行验证 | 2026-11-06 | `copilot -p … --plugin-dir lib/plugin`、官方 MCP SDK 探针、`pnpm check` | 真实 Copilot CLI 1.0.103 两次会话跑通（读候选、建工单、审核门 `notReady`、备注）；协议层 14 工具、中文错误、提示词预览正常；修复 3 个文案问题（SKILL 资源名、默认规则漏译、zod 英文默认消息），记录见 `docs/010-runtime-verification.md` | `dab5a99` |
| 进度登记 | 2026-11-06 | `pnpm check`、`git push origin feat/phase1-agent-plugins` | `AGENTS.md`、README、本表与 `docs/010` 对齐当前编号与状态；`pnpm check` 全绿；远端 `feat/phase1-agent-plugins` 与本地一致 | 本批 |
| 全量核对与修复 | 2026-11-06 | `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm plugin:check` | 安装 314 个包退出 0；typecheck 退出 0；全量 1179 通过 / 26 跳过 / 0 失败；`lib/plugin` 3 个技能；两处插件校验通过。核对发现并修复 1 个 Windows 跨盘符缺陷：`promptFile` 收到绝对路径时被 `join` 拼坏（包根在 D:、临时目录在 C:）；`tests/mcp.spec.ts` 增补「参数拒绝后继续服务」与「过期 revision 被拒」两例；T2.2/T2.3/T2.4/T3.1 与 `docs/007` 测试表按代码事实更正。本机 node v24.2.0 仅作环境记录，门槛以 `engines` 为准 | 本批 |
| Agent Plugins 1.0.0 合规核对 | 2026-11-06 | 实抓 `agent-plugins.org/specification` 与作者指南；下载官方两份 schema 比对 SHA256；`node scripts/validate-plugin.mjs`（正例 2 处 + 4 类负例） | 站点发布版 1.0.0；仓库 `main` 的 1.1.0 为 Working Draft 不作依据。官方 schema 与本地两份 SHA256 完全一致（`plugin` `0A4AAD95…`、`mcp` `6539175B…`；工作区 CRLF 由 `core.autocrlf` 产生，归一后与仓库内容一致）。逐条核对 §4–§11 与 Agent Skills frontmatter，包结构/清单/MCP/技能均符合，无不符项；校验脚本属作者侧门禁、严于客户端下限，已在 `docs/009` §9 注明。A3 仍为 SDK 真实 HTTP 等价验证，inspector 未执行；A6 已在 Windows 机制演练通过；A4 当时待 IDE 内人工验证（后于本批实测通过）；真实触发未执行 | 本批 |
| 运行环境范围收敛 | 2026-11-06 | 全文检索 `systemd`/POSIX/跨平台表述；更新 `AGENTS.md`、`README.md`、`docs/01`、`docs/00`、`docs/009`、`docs/010` | 用户确认项目只支持 Windows + VS Code Stable 的官方 Copilot / Copilot Chat；POSIX 专属项（`#!/bin/sh`、systemd、权限位、`scripts/dsh-superagent`）由「未验证/待验证」改为「范围外」；A4 固定 Windows + VS Code Copilot，A6 只保留 Windows 演练；26 项跳过保留并注明范围外。`pnpm check` 全绿 | 本批 |
| A4 实测通过 | 2026-11-06 | VS Code Stable 1.145.2（内置 Copilot Chat 0.73.0）；`Chat: Install Plugin from Source` 用绝对路径；模型 `DeepSeek V4.1 Flash`；宿主探针 | 插件 `dsh-superagent@0.1.0` 启用、三技能可见；`tools/list=14`、`runtime`/`mcp` 均 `ready`；`orchestrator_read`(tickets)、`orchestrator_route`(accept 建票 `1d2e38c4…`)、`orchestrator_reply`(`notReady` 拒绝，真实结果)；用户设置 `chat.defaultConfiguration={mode:autopilot,approvals:allowAll}` 与 `chat.defaultModel=deepseek-flash` 已持久化并重载复核；截图 `.artifacts/screenshots/a4-*.png`(不提交) | 本批 |
| 工具面质量自查 | 2026-11-06 | 按简洁/标准/准确/交互四维度核对 14 个工具与 schema;`pnpm check` | 修复 3 处:①`worktree_name` 描述补"第一段只能是小写字母"(`a4-verify` 曾因此被拒);②`orchestrator_prompts_save` 增加 `baseRevision` 的对象级 `refine` 并改写兜底文案;③`orchestrator_reply` 补 `ticket_id` 描述。工具数量/名称/参数/返回未变;1179 通过、26 跳过 | 本批 |

未闭合项（截至本批）：真实 worker 执行（无 `dsh` 宿主与真实模型 worker）、双人 SoD（验证宿主只有一个允许发送者）、真实 GitHub/飞书事件（无凭据）。A6 的 Windows 机制演练已通过；真实 `dsh --profile` 宿主与计划任务长期部署不在本批验收内。systemd 等 POSIX 调度、Windows 上跳过的 26 项测试（`#!/bin/sh` worker shim、`scripts/dsh-superagent` 服务脚本、飞书假 CLI、POSIX 权限位）均为**范围外**，保留跳过并已在测试文件写明原因，不视为通过，也不计入待办。

路径与版本口径（2026-11-06，用户决策）：实施根就是当前仓库 `d:\WorkSpace\dsh-superagent-prototype`，阶段一在原仓库内实施并保留 `main@8c32a9d` 历史与 `origin` 远端；`d:\superagent-plugin` 从未存在，相关表述已全部改为本根。Node 只要求不低于 `package.json` 的 `engines` 下限（当前 `^22.19.0 || >=24.0.0`），不锁定具体版本；本机 `node v24.2.0` 仅作环境记录，不作为要求或验收条件。
