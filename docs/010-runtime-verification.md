# 中文化后的真实运行验证记录

> 验证日期：2026-11-06 | 分支：`feat/phase1-agent-plugins` | 语言：简体中文 | 编码：UTF-8（无 BOM）
> 上位文档：[009-copilot-plugin.md](009-copilot-plugin.md) | 架构：[007-architecture.md](007-architecture.md) | 部署：[006-deployment.md](006-deployment.md)

## 1. 目的与验证边界

三组中文化（代码注释、面向人文案、模型运行时资产）完成后，单测只保证断言仍然通过，不保证**翻译后的提示词与工具描述在真实会话里仍可用**。本记录验证的是：真实模型客户端经 MCP 调用时，是否仍按预期选择工具、传对参数、读得懂中文错误，以及审核门是否仍然拦截。

两条验证路径严格区分：

| 路径 | 内容 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 真实客户端（Copilot CLI + 真实模型） | 模型读取中文工具描述与 SKILL.md，自行决定调用并回传结果 | 模型在中文描述下仍能选对工具、传对参数、理解中文拒绝 | 不代表 VS Code Copilot Chat 的行为 |
| 协议层（官方 MCP SDK 客户端） | 逐一调用主会话工具，校验返回结构与中文文案 | 端点、schema、错误与门禁的协议行为正确 | 不代表模型会这样调用 |

本机没有安装 `dsh` 宿主，因此 Runtime 由本地脚本启动：**Engine、Policy、Store、评估、MCP 端点、提示词拼装全部是产品代码**；DSH 宿主服务（agents、sessionController、subprocess、webServer）与 Source 输入由脚本替代。所有替代点在下文标注。

> **历史说明（2026-11-07）**：本节及第 3–9 节描述的是去 DSH 之前的验证方式，其中的 `dsh` 宿主、`sessionController`、`webServer` 已随 B1–B3 移除。当前 Runtime 由 `node lib/index.js --config <机器配置文件>` 启动，模型宿主是 VS Code 语言模型桥，真实端到端证据见 §12。

**支持环境（2026-11-06 用户确认）：Windows + VS Code Stable 的官方 Copilot / Copilot Chat。** 本文中的 Copilot CLI 路径只作前置证据，不计入 A4 正式验收；POSIX 专属对象（`#!/bin/sh`、systemd、权限位）为**范围外**，不作为待办。POSIX 服务脚本 `scripts/dsh-superagent` 属已废止历史，已删除（见 §13）。

## 2. 客户端探测结论

| 客户端 | 探测结果 | 能否用于本次验证 |
| --- | --- | --- |
| VS Code | `1.145.2`（commit `c4453f8e…`，安装根 `C:\Program Files\Microsoft VS Code`）；A4 实测口径见 `009` §11 | — |
| GitHub Copilot / Copilot Chat 扩展 | 内置扩展 `GitHub.copilot-chat@0.73.0`（`resources\app\extensions\copilot`），不出现在 `code --list-extensions` | 是，A4 已在 IDE 内实测通过 |
| GitHub Copilot CLI | 已安装 1.0.103，已登录，`-p` 非交互可用 | **是**，作为真实模型客户端 |
| `copilot plugin` / `copilot mcp` | 子命令可用；`--plugin-dir lib/plugin` 能加载本插件 | 是 |
| `dsh` 宿主 CLI | 未安装 | 否，改为脚本宿主 |
| `gh` CLI | 未安装（验证配置使用脚本替代的 CLI 路径） | 否 |

`copilot --plugin-dir ./lib/plugin plugin list --json` 的实际输出：插件 `dsh-superagent`、版本 0.1.0、来源 external、状态 enabled。这证明 `plugin/` 清单结构被真实客户端接受。

A4 的验收环境限定为 **Windows + VS Code Stable 1.145.2 的官方 Copilot Chat**；本节的 Copilot CLI 路径只作前置证据，**不计入 A4 验收**（见 `009` §11.1）。

## 3. 验证拓扑

```text
copilot CLI (真实模型) ── plugin --plugin-dir lib/plugin
        │                        └── mcp.json → http://127.0.0.1:3083/mcp
        ▼
Streamable HTTP MCP 端点（src/app/mcp.ts，真实）
        ▼
14 个主会话工具（真实）→ Engine / Policy / Store / 评估（真实）
        ▲
脚本宿主：3 条飞书 Trigger 预注入、假 agents/sessionController/subprocess（替代）
```

- 状态库：临时 stateDir 下的真实 SQLite，验证结束即丢弃，不进仓库。
- 三条预注入 Trigger（发送者 `ou_alice`，Policy 允许）：错别字修复请求、闲聊、退出码表格措辞请求。它们模拟 Source 到达，替代真实飞书事件。
- 未启动真实 worker：没有 DSH 会话与模型执行，`working/queued` 之后的实现环节不在本次范围。

## 4. 真实客户端执行记录

### 4.1 第一次运行：读取策略 + 接受/忽略

输入（中文，要求只用插件工具）：读取 `orchestrator_read` 的 policy 与 tickets，接受第一个候选、忽略第二个候选。

实际调用链与结果：

| 步骤 | 模型调用 | 结果 |
| --- | --- | --- |
| 1 | `orchestrator_read {resource: "policy"}` | 返回「未知的上下文资源」，模型自行改用 `settings/policy` 成功取到策略 |
| 2 | `orchestrator_read {resource: "tickets"}` | 空列表 |
| 3 | `orchestrator_route`（accept + ignore 两条决策） | accept 生成工单 `state=working/queued`，reason 为中文「允许的发送者发出明确请求，由编排器路由」；ignore 返回中文理由 |

结论：中文工具描述与 JSON Schema 说明没有让模型传错参数（`decisions` 数组、`kind`、`trigger_id`、`title`、`worktree_name`、`acknowledgement` 全部正确）；模型对「未知资源」有自我纠正能力，但也暴露出 SKILL.md 的资源名错误（见 §6 问题 1）。

### 4.2 第二次运行：发现候选 → 建任务 → 撞审核门 → 记备注

输入（中文，要求只用插件工具，并逐字回传返回）：从 `triggers` 找出 docs/006 那条候选，accept，再以 `purpose=result` 回复，最后写一条 note。

实际结果：

| 步骤 | 模型调用 | 实际返回（节选） |
| --- | --- | --- |
| 1 | `orchestrator_read {resource: "triggers"}` | 三条候选，含 `trigger_id`、`thread`、`disposition`，末尾 `next_offset: null` |
| 2 | `orchestrator_route` accept | 新工单，中文标题「澄清 docs/006 退出码表格措辞」，`state=working/queued`，`strength=explicit` |
| 3 | `orchestrator_reply {purpose: "result"}` | **被拒绝**：`{"error":"工单尚未就绪，无法交付。把进展保持在内部，等待经过验证的 ready 汇报；不要把进展改标成答案，也不要通过其它渠道发送。","code":"notReady"}` |
| 4 | `orchestrator_ticket_note` | `{"reason":"已作为备注告知 worker","ticket":{...}}` |

结论：

- 审核门（只有经过验证的 ready 汇报之后才允许 `purpose=result`）由 Engine 判定，MCP 客户端无法用「我已完成」绕过，拒绝原因与下一步指引为中文且可读。
- 模型对中文拒绝的理解正确，第 3 步后没有改用其它工具硬推，也没有伪造进度。
- 模型在中文候选预览下正确识别了目标请求与来源（`thread` 为 `feishu:oc_team:om_3`）。

## 5. 协议层验证（官方 MCP SDK 客户端）

连接真实端点 `http://127.0.0.1:3083/mcp`，结果如下。

| 检查 | 实际结果 |
| --- | --- |
| `tools/list` | 恰为 14 个主会话工具，描述为中文 |
| `orchestrator_read triggers` / `settings/policy` / `tickets` / `ticket/<id>` | 结构正确；策略规则已是中文（「文案修复」「视觉修复」） |
| 未知工具 | `{"error":"未知工具 orchestrator_nope；请调用 tools/list 查看可用工具"}` |
| 非法参数 | `{"error":"参数无效","issues":[{"path":"decisions","message":"无效输入：期望 数组，实际接收 string"}]}` |
| 缺必填项 | `{"results":[{"kind":"accept","refused":"accept 需要 title"}]}` |
| 对未知工单回复结果 | `{"error":"未知工单","code":"unknownTicket"}` |
| 停止目标未知 | `{"results":[{"kind":"stop","decision":"ignore","reason":"停止目标未知或已结束"}]}` |
| 对显式请求做评估 | `{"error":"这是一个显式请求，应直接路由而不是评估：请用 orchestrator_route，传入它的 trigger_id 和 kind accept、attach、stop 或 ignore"}` |
| 状态请求 | `{"reason":"worker 并未在等待；未发送任何内容"}`（本环境无真实 worker） |
| 取消订阅 | `{"removed":false,"thread":"feishu:oc_team:om_9"}` |
| 提示词预览 | `orchestrator` 18058 字符、`worker` 14137 字符；读取 `prompt-preview/<id>` 得到中文提示词正文（角色、沟通、范围、投递规则均为中文） |

审核门与 SoD 的协议口径：`orchestrator_reply` 与 `orchestrator_route` 的每个决策都重新经过 Engine 的 Policy/Mandate 复验，返回的 `strength`、`reason`、`refused` 由引擎计算而不是回显客户端参数；`purpose=result` 在未就绪时被拒；停止未知目标被降级为 `ignore`。**未覆盖**：两个不同的人分别作为请求者与停止者的双人 SoD 场景（验证宿主只配置了一个允许发送者，且没有真实 worker 能推进到 `person/review`）。

## 6. 发现的问题与修复

| # | 分类 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | 文案问题（既存，非中文化引入） | `plugin/skills/dsh-superagent/SKILL.md` 把可读资源写成 `tickets/<id>`、`threads/<id>`、`policy`、`overview`，而实际路由是 `ticket/<id>`、`thread/<key>`、`settings/policy`、`triggers`。真实模型第一次运行即撞上「未知的上下文资源」 | 改为实际资源名，并补上 `triggers`、`decisions`、`trigger/<id>`；`orchestrator_read` 的两处引用同步改为 `settings/policy` |
| 2 | 文案问题（漏译） | `src/policy.ts` 的默认规则仍是英文（`Copy fixes` / `Visual fixes`），它们会进入策略、评估与提示词，属模型可见资产 | 译为「文案修复」「视觉修复」，指令语义逐条对应；`tests/runtime.spec.ts` 的断言同步为新名称，强度不变 |
| 3 | 文案问题（漏译） | MCP 参数校验的默认消息仍来自 zod 英文包，出现 `Invalid input: expected array, received string` | `src/app/mcp-tools.ts` 启用 `z.config(z.locales.zhCN())`；自定义 refine 消息不受影响 |

未发现「行为缺陷」（逻辑错误）与「协议层问题」（握手、会话、错误映射、门禁绕过）。上述三条均为文案问题，其中第 1 条会实际误导模型，第 2、3 条影响中文可读性与资产一致性。

修复后的复验：协议探针得到 `无效输入：期望 数组，实际接收 string`；`settings/policy` 返回中文规则；真实模型第二次运行按修正后的 `triggers` 资源一次找对候选。

## 7. 未覆盖部分与原因

| 项目 | 状态 | 原因 |
| --- | --- | --- |
| VS Code Copilot Chat 冒烟（A4） | 通过 | Stable 1.145.2 内置 Copilot Chat 0.73.0；插件 `dsh-superagent` 启用、三技能可见、Model `DeepSeek V4.1 Flash`，三个工具真实调用（`orchestrator_reply` 被 `notReady` 拒绝属真实结果），明细见 `009` §11 |
| 真实 worker 执行（改代码 → 提交 → PR） | 未执行 | 没有 `dsh` 宿主与真实模型 worker，工单停在 `working/queued` |
| 双人 SoD（请求者与停止者不同） | 未覆盖 | 验证宿主只配置一个允许发送者，且无 worker 推进到 `person/review` |
| 保活演练（A6） | Windows 机制演练已通过 | 强杀后自动拉起已验证（`009` §10）；systemd 等 POSIX 调度**范围外**；真实 `dsh --profile` 宿主与计划任务开机自启不在本批验收内 |
| 真实 GitHub / 飞书事件 | 未执行 | 无凭据；Trigger 由脚本注入替代 |

## 8. 复现方式

```bash
pnpm build                                        # 生成 lib/plugin 供真实客户端加载
copilot --plugin-dir ./lib/plugin plugin list --json
copilot -p "<中文操作指令>" --plugin-dir ./lib/plugin --allow-all-tools -s
```

验证宿主脚本、MCP 探针与真实模型会话日志保存在本地 `.artifacts/verify/`（已被 `.gitignore` 忽略，不随仓库分发）。宿主以 `node --experimental-transform-types` 直接加载 `src/**` 的 TypeScript 源码，保证运行的是当前工作区代码而非过期构建产物。

## 9. 结论

中文化后的提示词、工具描述与 SKILL.md 在真实模型会话中可用：工具选择正确、参数完整、中文拒绝可读、审核门有效。发现的三个问题均属文案层，已修复并复验；没有为了通过验证而放宽任何测试断言。剩余未覆盖项集中在 VS Code 内的 A4 人工验证、DSH 宿主与真实凭据，已在 §7 如实保留。

## 10. B1/B2：去 DSH 的行为迁移与删除证据

移除 DeepSeek Harness 后，`Runtime` 不再是宿主服务，面板由自建回环网页提供（`src/app/panel.ts` + `src/client/main.tsx`），worker 与主会话都经 `AgentHost` 运行。下表的每一行回答两个问题：被删测试**测的行为是否仍存在**，以及**由谁取代**。凡记「能力终止」的条目，均已在 `009` 的能力清单中确认为本期放弃，不是遗漏。

| 被删/重写的测试 | 被测行为是否仍存在 | 取代者或终止理由 |
| --- | --- | --- |
| `tests/background.spec.ts` | 否 | DSH 会话的 shell 作业（`ctx.jobs`）与子智能体（`ctx.subagents`）随宿主移除；`AgentHost` 的回合只有 dispatch/collect，没有后台作业概念。能力终止（清单第 4 条） |
| `tests/bundle-patch.spec.ts` | 否 | bundle 补丁与执行器会话的智能体 preset 属 DSH 安装形态；插件包改用官方 schema 校验，preset 能力终止（清单第 3 条） |
| `tests/client.spec.tsx` | 部分 | 客户端插件注册、侧边栏与跨会话轮询终止；页面渲染仍由 `panel-*.spec.tsx` 覆盖，导入约束由 `controls.spec.tsx` 覆盖 |
| `tests/delivery.spec.ts` | 是，形式不同 | 投递去重从 DSH 智能体事件的 `AgentDelivery` 变为 `MainSession` 的后台回合 + 按 requestId 持久去重；由 `runtime.spec.ts`、`followups.spec.ts` 的 relay 断言覆盖 |
| `tests/feishu-image.spec.ts` | 否 | 图片附件读取本期放弃，见「已知限制」；`assessment.read` 的 image 分支保留加回位置 |
| `tests/navigation.spec.ts` | 否 | 从面板跳进 DSH 会话终止；面板改为独立网页，不再有宿主会话可跳转（清单第 1 条） |
| `tests/retry-health.spec.ts` | 部分 | 模型预算重试的 DSH 健康项终止（清单第 8 条）；主会话回合失败改为上报 `models` 健康，由 `health.spec.ts` 覆盖 |
| `tests/role-models.spec.ts` | 部分 | 用角色模型初始化 DSH 会话终止；两种角色的模型仍从设置读取，由 `tools.spec.ts` 合成模型、`model-surface.spec.ts` 覆盖 |
| `tests/runtime-concurrency.spec.ts` | 是 | 重叠工作不再由宿主事件驱动，而由执行器按工单串行 + effect 队列保证；`runtime.spec.ts` 覆盖并发 `stop()` 只停一次、失败不阻塞后续回合 |
| `tests/runtime.spec.ts`（旧 1705 行） | 是 | 重写为在 `AgentHost` 替身与回环 HTTP 上运行整个应用：启动、接收/接受、环境与转录、暂停补跑、回合失败、并发停止 |
| `tests/tools.spec.ts` 的「`agent/disposed` 释放工具」 | 否 | 工具面不再按 DSH 智能体生命周期挂载；`Runtime.tools(ticket?)` 每次按工单组装，由同一文件的工具形状断言覆盖 |
| `tests/settings.spec.ts` 的模型名校验竞态 | 部分 | 模型可用性检查依赖 DSH 会话；保留设置块保存与暂停去重，模型名不再在建会话时校验 |
| `tests/health.spec.ts`（旧三例） | 部分 | 逐部件健康项改为：`models` 回合失败/恢复、`reply` 重试、同名通知去重三条，断言对象改为 Runtime 实际维护的条目 |
| `tests/panel-deployment.spec.tsx`（旧例） | 是 | 部署页改为只读展示：限制展示、禁用输入、无保存栏、setup 失败提示与重新检查 |

`pnpm check` 在本批收口时为退出码 0：55 个测试文件（54 通过、1 个整组跳过）、983 通过、12 跳过、0 失败，构建与插件校验通过。2026-11-07 的清理删除了 15 项只在 POSIX 上运行的 `service-script` 用例，因此跳过数由 26 变为 12（11 项 POSIX 专属 + 1 项无桥时的 e2e 整组跳过）。当本机有真实的 VS Code 语言模型桥时，`tests/e2e-bridge.spec.ts` 会实跑，同一套断言的结果是 **984 通过 / 11 跳过 / 0 失败**（见 §14.3）。

## 11. 已知限制：图片附件

本期不读取工单中的图片附件。具体表现：**带图工单只能读文字**，`orchestrator_eval_read` 的图片分支返回固定错误并说明不可读，评估指令也据此要求「依赖截图措辞或视觉事实时给出 `unavailable`」；面板与 MCP 两侧行为一致。

后续加回位置：`src/app/assessment.ts` 的 `read()` 中 `resource === 'image'` 分支——把它从固定错误恢复为读取附件并交给评估；同时恢复 `prompts/admission.md` 的图片段落与 `tests/feishu-image.spec.ts` 级别的覆盖。该限制同时写入仓库根 `README.md` 的「已知限制」与 `docs/007` 的「读取资源」一节。

## 12. B5：真实端到端（模型 → 改文件 → ready → 交付）

去 DSH 之后必须证明的不再是「插件被宿主加载」，而是「一条工单能从受理走到真实交付」。该验证由 `tests/e2e-bridge.spec.ts` 承担：真实 `Runtime`、真实工具面、真实 SQLite，只有工单来源用夹具构造；模型回合经 `VsCodeLmHost` 走 VS Code 语言模型桥，是本仓库唯一的真实模型通路。

| 项目 | 实测结果 |
| --- | --- |
| 命令 | `pnpm test -- tests/e2e-bridge.spec.ts` |
| 结果 | `1 passed`，`1 passed (1)`，耗时 14082 ms |
| 模型 | 桥当前选中模型 `deepseek-flash`（由桥健康回报，未硬编码） |
| 流程 | 飞书提及 → `orchestrator_route` 受理（`worktree_name` `fix-typo`）→ 真实回合读 `README.md` → 把 `teh` 改为 `the` → 汇报 `ready` → `orchestrator_reply`（`purpose=result`）返回 `{status:"sent"}` |
| 断言 | 转录条数 > 1；worker 文本长度 > 10；`latestReport(ticket)?.state === 'ready'`；磁盘上 `README.md` 含 `the widget factory`；结果交付回执为 `sent` |

失败与修正记录（都属于验证脚本自身的问题，不是产品行为）：

1. 首轮真实回合在 86 秒后报 `Cannot read properties of undefined (reading 'transcript')`——`KV` 常量应从 `src/kv.ts` 导入，而不是从 `src/core/index.ts`。
2. 转录文本提取为空——文本在 `message.content[].text`，需要先展开 `content`。
3. 空工作目录里模型反复读 `README.md` 失败，撞上限后整回合失败：`[回合失败] 模型侧失败：回合工具调用超过 24 轮仍未结束，已中止`。修法是在受理后、`drain()` 前把真实 `README.md` 写进 `ticket.execution.directory`，让回合有可读的文件。

**观察到的硬边界**：桥对单个回合设有 24 轮工具调用上限，超限即整回合失败（错误文案可读、落进转录，工单按普通回合失败处理，可重试）。因此「空目录里让模型自行摸索」不是有效场景，工单的执行目录必须真的存在且可用。

该测试在没有桥发现文件时会整组跳过（`describe.skipIf(!info)`），跳过不计入通过；本机 2026-11-07 是真实执行并通过的。

## 13. B6：清理与标准化

### 13.1 死代码删除

| 删除对象 | 检索证据 | 被测行为是否仍存在 | 取代者 |
| --- | --- | --- | --- |
| `scripts/dsh-superagent` | 全文只被 `tests/service-script.spec.ts`、README 与历史文档引用；脚本首行依赖 `shutil.which('dsh')` 与 `dsh --profile`，去 DSH 后该二进制不再存在 | 否。POSIX 下的 start/stop/status/drill 随 DSH profile 一起终止 | `scripts/dsh-superagent-windows.ps1`（本项目唯一支持的平台） |
| `tests/service-script.spec.ts` | 整个文件 `test.skipIf(process.platform === 'win32')`，在本项目支持的 Windows 上从未执行 | 否，被测对象已删除 | 同上；Windows 守护脚本由 `scripts/copilot-smoke.ps1` 与 `-Action drill` 实测覆盖 |
| `src/executor/copilot.ts` | `CopilotCliHost` 只被 `tests/host.spec.ts` 引用；`src/index.ts` 只构造 `VsCodeLmHost`，配置里也没有选择宿主的键 | 否。经 `copilot` CLI 跑回合的能力随支持范围收敛而终止（理由见 13.4） | `VsCodeLmHost`（`vscode.lm` 扩展桥），是本机唯一真实模型通路 |
| `tests/host.spec.ts` | 整文件只覆盖 `CopilotCliHost` 与 `parseTurnOutput` | 否，被测对象已删除 | `tests/vscode-lm.spec.ts` 覆盖宿主与桥协议 |

删除后跳过用例由 26 项降为 11 项，均为仍在产品的 POSIX 专属对象（worker shim、飞书消费者假 CLI、权限位断言）；再加上 `tests/e2e-bridge.spec.ts` 在无桥时的整组跳过，本机全量为 12 项跳过。

### 13.2 代码注释中的 DSH 残留

| 位置 | 原文 | 处理 |
| --- | --- | --- |
| `src/app/effects.ts` | `DshExecutor` | 改为 `HostExecutor` |
| `src/infra/health.ts` | `DshExecutor` | 改为 `HostExecutor` |
| `src/executor/agent.ts` | 「这是 `DshExecutor` 的去 DSH 版本」 | 改为直接描述回合语义 |
| `src/sources/feishu.ts` | 「Cordis 插件入口」 | 改为「Source 入口」 |
| `src/app/runtime.ts` | 「不再依赖 DSH 或 Cordis」「替代 DSH 的 cordis 插件装载」 | 改为描述注入与生命周期 |

残留扫描命令与口径：在 `src/`、`tests/`、`scripts/`、`plugin/`、`extension/` 内检索 `@deepseek-ai`、`cordis`、`DshExecutor`、`executor/dsh`、`keepalive-host`、`sessionController`、`ctx.agents`、`ctx.jobs`、`ctx.subagents`、`ctx.webServer`。结果：代码引用为 0；`dsh`、`DSH_SUPERAGENT_*`、`dsh-superagent` 作为产品名保留；`tests/controls.spec.tsx` 中「不引用 `@deepseek-ai/`」是一条防回归断言，不是残留。

### 13.3 agent-plugins 1.0.0 核对表

离线 schema 放在 `scripts/schemas/agent-plugins-1.0.0/`，校验命令 `node scripts/validate-plugin.mjs`（源目录）与 `node scripts/validate-plugin.mjs --dir lib/plugin`（打包产物），两者都必须退出 0，且校验过程不联网。

| 核对项 | 规范要求 | 实测 | 结论 |
| --- | --- | --- | --- |
| `$schema` 版本 | 精确等于 `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`；`mcp.json` 用同名 `mcp.schema.json` | 两份文件都是 1.0.0，没有混用旧版本 | 符合 |
| `plugin.json` 字段封闭 | 1.0.0 只允许 `$schema`、`name`、`version`、`description`、`author`、`homepage`、`repository`、`license`、`keywords`、`extensions`，且 `additionalProperties: false` | 只用了 `$schema`、`name`、`version`、`description`、`license`、`keywords` 六个字段；`author`、`homepage`、`repository` 在拿到真实地址前不写 | 符合 |
| 名称规则 | `name` 非空、不以 `-` 开头、不含 `--` 与 `..`、长度受限 | `dsh-superagent` | 符合 |
| 必填项 | `$schema` 与 `name` | 都在 | 符合 |
| 版本一致性 | `plugin.json.version` 与 `package.json.version` 一致 | 都是 `0.1.0`；`validate-plugin.mjs` 显式比对 | 符合 |
| `mcp.json` 结构 | 顶层只有 `$schema` 与 `mcpServers`；服务器条目带 `type` 与 `url` | 一个服务器 `dsh-superagent`，`streamable-http` + `http://127.0.0.1:3083/mcp` | 符合 |
| MCP 监听面 | 只允许回环 | 地址是 `127.0.0.1`；校验脚本额外拒绝非回环与非 `/mcp` 路径 | 符合（比 schema 更严） |
| `skills/` 一级目录 | 每个技能是 `skills/<name>/SKILL.md`，不允许嵌套或散文件 | `plugin/skills/` 只有 `dsh-superagent/`；打包产物另有 `dsh-superagent-feishu/`、`dsh-superagent-github/` | 符合 |
| 技能 frontmatter | `name`、`description` 必填，`name` 与目录名一致 | 三个技能逐一核对，全部一致 | 符合 |
| 扩展命名空间 | 若用 `extensions`，键必须是反向域名；未声明时视为不使用 | 没有 `extensions` 字段；VS Code 扩展走独立安装，不通过插件清单分发 | 符合（不使用） |
| 离线校验 | 校验不得联网 | 只用本地 schema 与本地文件 | 符合 |

### 13.4 简洁性检查

| 检查项 | 证据 | 处理 |
| --- | --- | --- |
| 无人消费的宿主实现 | `CopilotCliHost` 只被 `tests/host.spec.ts` 引用，`src/index.ts` 只构造 `VsCodeLmHost`；Copilot CLI 又不在支持环境内 | 删除 `src/executor/copilot.ts` 与 `tests/host.spec.ts`（行为终止，见 13.1 的取代者列） |
| 无人消费的配置项 | `MachineSchema` 的 `stateDir`、`promptMaxChars`、`mcpEnabled`、`mcpPort`、`panelPort`、`host`、`model`、`github`、`feishu`、`executor` 在 `src/` 内都有读取方 | 无需删除 |
| 只在 Windows 上失效的绝对路径判断 | `ExecutorConfigSchema.directory` 用 `startsWith('/')` 判断绝对路径，Windows 的 `C:\work` 会被拒绝 | 改用 `node:path.isAbsolute`，并在 `tests/policy.spec.ts` 增加接受/拒绝各一例 |
| 注释与实现不符 | `src/executor/workspace-tools.ts` 首段写「此前由 DSH 的 profile 提供」 | 改为直接描述当前实现 |
| 错误码与文案不一致 | 拒绝一律 `UserError(code, values)`，`code` 来自 `USER_ERRORS`，由 `tests/errors.spec.ts` 与各工具用例覆盖 | 无漂移 |
| 重复的统计逻辑 | 资源页 `tickets`/`triggers` 的 `unread` 只由 `src/app/resources.ts` 的 `unread()` 计算一次，面板不二次统计 | 无需合并 |
| 一次性抽象 | `scripts/keepalive-probe.mjs` 被 Windows 守护脚本的 `drill` 调用，不是死文件 | 保留 |

## 14. B7：真机验证（Windows + VS Code Stable）

环境：Windows，VS Code Stable `1.145.2`，以 `code --extensionDevelopmentPath=extension/dsh-lm-bridge` 打开的扩展开发宿主；运行时 `node lib/index.js --config <stateDir 外的 config.json>`；桥发现文件 `~/.dsh-superagent/lm-bridge.json` 记录 `model: deepseek-flash`（DeepSeek V4.1 Flash）。

### 14.1 发现并修复的缺陷：面板空白页

| 项目 | 内容 |
| --- | --- |
| 现象 | `GET /` 返回 303 字节外壳，但页面空白；`GET /main.js` 与 `/panel/main.js` 均 404，浏览器控制台报 `#root` 为空、`/@vite/client` ERR_ABORTED |
| 根因 | `PanelServer` 的默认静态目录多了一层 `'..'`：构建产物是 `lib/index.js` + `lib/panel/main.js`，而默认值指向仓库根 `panel/`（不存在） |
| 修复 | `src/app/panel.ts` 的构造函数改为 `join(dirname(fileURLToPath(import.meta.url)), 'panel')`，即构建产物同级的 `lib/panel` |
| 验证 | 重建后 `GET /main.js` 返回 `200 text/javascript`、1,171,690 字节；浏览器打开 `http://127.0.0.1:3082/` 渲染出「概览 / 待处理工单 0 / 系统问题 3 / 过去 24 小时 / 执行器」等真实文案，控制台只有一条 React DevTools 提示，无报错 |
| 真实数据 | `GET /orchestrator/api/overview` 返回真实问题列表：`github/repositoryUnset`（GitHub Source 没有指定仓库）、`no-source`、`no-allowed`，`policyVersion` 为真实哈希 |

### 14.2 MCP 与 Copilot Chat 的阻塞点

运行时启动日志为「正在等待 setup：GitHub Source 没有指定仓库」，`Runtime.initialize()` 在 setup 未完成时不会执行 `startMcp()`，因此 `127.0.0.1:3083/mcp` 连不上（ECONNREFUSED）。本机没有 `gh` 命令、`lark-cli auth status` 返回 `ok:false, not_configured`，无法完成真实 setup，所以**真实 Copilot Chat 窗口内的 `tools/list` 与技能可见性本轮未能验证**。插件包本身的 14 个工具、3 个技能与 `$schema` 一致性由 `tests/mcp.spec.ts`、`tests/model-surface.spec.ts`、`pnpm plugin:check` 覆盖，此前的 A4 记录见 `docs/009-copilot-plugin.md` §11。

### 14.3 真实端到端重跑

| 项目 | 实测 |
| --- | --- |
| 命令 | `pnpm test -- tests/e2e-bridge.spec.ts`（桥由真实扩展提供） |
| 结果 | `1 passed`，28177 ms；同一次 `pnpm check` 全量 984 通过 / 11 跳过 / 0 失败（55 个测试文件） |
| 模型 | `deepseek-flash` |
| 流程 | 飞书提及 → 受理 → 真实回合读 `README.md` → 改 `teh` 为 `the` → 汇报 `ready` → `orchestrator_reply` 返回 `{status:"sent"}` |

### 14.4 主动通知开关的真机行为

验证方式：用 `127.0.0.1:3089` 的桩服务返回与面板同形的 `overview.person`，把 VS Code 用户设置里的 `dsh.superagent.notify` 置为 `true`、`dsh.superagent.panelUrl` 指向桩服务，读取扩展输出日志（`%APPDATA%\Code\User\globalStorage\dsh-superagent.dsh-lm-bridge\bridge.log`）。

| 步骤 | 观测 |
| --- | --- |
| 打开开关 | `05:41:21 通知已开启：每 60 秒轮询 http://127.0.0.1:3089` |
| 新增 `T-1001` | `05:42:21 通知：dsh-superagent：修复登录页的 500 错误 等待你处理` |
| 再新增 `T-1002`/`T-1003`/`T-1004` | 各只出现一条通知行；同一批未变化的工单不重复提醒 |
| 关闭开关 | `05:51:34 通知已关闭（dsh.superagent.notify = false），不轮询面板` |
| 关闭后新增 `T-1005` | 等待 70 秒无任何通知行，开关关闭时确实安静 |
| 恢复 | 用户设置已还原（两个键都已移除） |

像素级证据缺失的原因：扩展开发宿主窗口以管理员权限运行且被编辑器窗口遮挡，非提权进程的 `SetForegroundWindow` 被 UIPI 拒绝，`PrintWindow` 只能取到未重绘的旧帧，因此没有拿到通知卡片的截图。通知调用的证据是扩展日志中的原文，判定与文案逻辑由 `tests/extension-notify.spec.ts` 的 5 项用例覆盖。

## 15. B8：打通 setup 的 Windows 缺陷与真实验收状态

本轮目标是把 setup 在真实机器上跑通，再进 Copilot Chat 验证工具面与技能面。结论是：**setup 链路已修好，唯一剩余阻塞是 `gh` 未登录；A4 本轮未重跑，A5 未执行。**

### 15.1 凭据与工具盘点（只读，不含任何 token 内容）

| 项目 | 实测 |
| --- | --- |
| `gh` | 便携版 `2.103.3`，位于 `%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe`（未加入 PATH） |
| `gh auth status` | 退出码 `1`：`You are not logged into any GitHub hosts. To log in, run: gh auth login` |
| `gh api user` | 退出码 `4`：`gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.` |
| 环境变量 | `GH_TOKEN`、`GITHUB_TOKEN` 均未设置；`%APPDATA%\GitHub CLI\hosts.yml` 不存在 |
| 仓库与远端 | `origin git@github.com:martinxiao2025/dsh-superagent-prototype.git`；SSH 认证可用（`git ls-remote` 成功），但产品只通过配置项 `cli` 调用 `gh`，不读取 ssh 凭据 |
| `lark-cli` | 存在 `1.0.98`（`~/.trae-cn/plugins/.../lark-cli.exe`），`auth status` 返回 `ok:false, not_configured`，因此按 `feishuNoApp` 处理；飞书是可选 Source，不阻塞 GitHub |

### 15.2 缺陷一：等待 setup 时面板无法保存 Source 配置

| 项目 | 内容 |
| --- | --- |
| 现象 | setup 未完成时 `GET settings` 里没有 `source:github`/`source:feishu`；`PUT /orchestrator/api/settings/source:github` 返回 404，无法填写仓库与 CLI，形成「要配置才能过 setup、要过 setup 才能配置」的死锁 |
| 根因 | Source kind 只由 `startGithub`/`startFeishu` 注册，而它们排在 `Setup.run()` 成功之后；`Settings.save` 对未注册 kind 抛 `sourceNotInstalled`，路由对未注册实例返回 404 |
| 修复 | `Runtime.initialize()` 在 setup 失败分支提前注册两个 kind 并记下注销函数，`shutdown()` 时释放；`startGithub`/`startFeishu` 改为「未注册才补注册」，避免重复注册 |
| 回归 | `tests/settings.spec.ts`：setup 被 mock 为未完成时保存 `source:github` 成功（修复前报「github 这个 Source 类型未安装」） |
| 现场 | 重启运行时后 `GET settings` 返回 `feishu installed=True`、`github installed=True`，`PUT` 从 404 变为进入账号校验（400），链路已通 |

### 15.3 缺陷二：probe 使用 POSIX `env` 前缀，Windows 上 setup 永远失败

| 项目 | 内容 |
| --- | --- |
| 现象 | `PUT source:github` 返回 400 `agentCliSignedOut`，`output` 为 `env PATH=… gh.exe api user 在完成前被停止`——即使 CLI 已登录也会失败 |
| 根因 | `workerProbe` 以 `['env', 'PATH=…', …argv]` 启动；Windows 没有 `env` 可执行文件，`NodeSubprocess` 的 `child.on('error')` 以 `exitCode = null` 结束，`runAsWorker` 把它翻译成「在完成前被停止」。`resolveFeishuBot` 同样用 `env` 传 `LARKSUITE_CLI_NO_*`，存在同一问题 |
| 修复 | `Probe` 增加可选的 `env` 参数；`workerProbe` 改用 `runAsWorker` 的 `env` 选项传 `PATH`；`resolveFeishuBot` 用同一通道传两个 `LARKSUITE_CLI_NO_*` 变量。命令本身不再带前缀，POSIX 与 Windows 行为一致 |
| 回归 | `tests/deployment.spec.ts` 新增「worker probe」用例，断言 `argv` 不含 `env`、`PATH` 经 `spawn` 的 `env` 传入且已剔除 worker shim 目录；飞书用例断言两个通知变量经 `env` 传入 |
| 现场 | 修复后真实 `PUT` 的 `output` 变为 `gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.`，即 CLI 自己的输出——证明探针确实执行了 `gh`，只剩登录问题 |

### 15.4 本轮真实命令与结果

| 项目 | 实测 |
| --- | --- |
| 运行时 | `node lib/index.js --config C:\Users\61054\.dsh-superagent\config.json`，面板 `http://127.0.0.1:3082` |
| 设置读取 | `GET /orchestrator/api/settings`（带同源 `Origin`/`Referer` 与 `x-orchestrator-request: 1`）`200`，两个 Source 均 `installed=True` |
| 设置保存 | `PUT /orchestrator/api/settings/source:github`，`repository=martinxiao2025/dsh-superagent-prototype`、`cli=<gh.exe 绝对路径>`，返回 `400` `agentCliSignedOut`，`output` 为 gh 自身提示 |
| 测试基线 | `pnpm check` 全绿：985 通过 / 12 跳过 / 0 失败（55 个测试文件，其中 1 个整组跳过） |

### 15.5 A4 与 A5 的真实状态

| 项 | 状态 | 依据 |
| --- | --- | --- |
| A4（VS Code Stable + Copilot Chat 冒烟） | **本轮未重跑**；历史记录仍为 `009` §11 的通过记录 | setup 未通过时 `Runtime.initialize()` 不执行 `startMcp()`，`127.0.0.1:3083/mcp` 不可用，Copilot Chat 无法列出工具与技能；本轮没有构造替代证据，也不把插件校验通过当作 A4 通过 |
| A5 第二轮（真实 GitHub 事件触发） | **未执行** | 缺可用的 `gh` 登录，运行时停在 `repositoryUnset`；没有真实事件进入队列 |
| 通知卡片截图 | **未取得** | 原因同 §14.4（UIPI 拒绝前台切换），本轮未重试，不用日志冒充截图 |

### 15.6 剩余缺口与唯一手工步骤

要让 setup 真正通过，需要在本机由人工完成 **`gh auth login`**（浏览器或一次性码），或由运维人员自行设置 `GH_TOKEN`；本文与任何提交都不记录该值。完成后重启运行时，`repositoryUnset` 应消失，`GET /orchestrator/api/overview` 的 `github/repositoryUnset` 问题项清除，`3083/mcp` 开始监听。

之后才算能进入下一轮验收：

1. A4：在 Stable + Copilot Chat 中确认插件加载、3 个技能可见、`tools/list` 为 14 个，并真实调用 `orchestrator_read` 与 `orchestrator_route`。
2. A5：向目标仓库投放一条真实事件，确认进入候选并完成一次路由。
3. 通知截图：在非提权的前台会话中触发，补一张像素证据（不提交）。


