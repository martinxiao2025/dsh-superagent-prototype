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

## 2. 客户端探测结论

| 客户端 | 探测结果 | 能否用于本次验证 |
| --- | --- | --- |
| VS Code | 已安装 1.145.1 | — |
| GitHub Copilot / Copilot Chat 扩展 | **未安装**（`code --list-extensions` 中只有第三方扩展：`automatalabs.copilot-mcp` 0.0.97、`ikaros.glm-for-vscode-copilot` 0.13.1、`johnny-zhao.oai-compatible-copilot` 0.4.2） | 否，A4 仍无法执行 |
| GitHub Copilot CLI | 已安装 1.0.103，已登录，`-p` 非交互可用 | **是**，作为真实模型客户端 |
| `copilot plugin` / `copilot mcp` | 子命令可用；`--plugin-dir lib/plugin` 能加载本插件 | 是 |
| `dsh` 宿主 CLI | 未安装 | 否，改为脚本宿主 |
| `gh` CLI | 未安装（验证配置使用脚本替代的 CLI 路径） | 否 |

`copilot --plugin-dir ./lib/plugin plugin list --json` 的实际输出：插件 `dsh-superagent`、版本 0.1.0、来源 external、状态 enabled。这证明 `plugin/` 清单结构被真实客户端接受。

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
| VS Code Copilot Chat 冒烟（A4） | 未执行 | 本机未安装官方 Copilot / Copilot Chat 扩展，无账号会话；不能用第三方扩展替代 |
| 真实 worker 执行（改代码 → 提交 → PR） | 未执行 | 没有 `dsh` 宿主与真实模型 worker，工单停在 `working/queued` |
| 双人 SoD（请求者与停止者不同） | 未覆盖 | 验证宿主只配置一个允许发送者，且无 worker 推进到 `person/review` |
| 保活演练（A6） | 未执行 | 需要 systemd / Windows 计划任务与真实部署 |
| 真实 GitHub / 飞书事件 | 未执行 | 无凭据；Trigger 由脚本注入替代 |

## 8. 复现方式

```bash
pnpm build                                        # 生成 lib/plugin 供真实客户端加载
copilot --plugin-dir ./lib/plugin plugin list --json
copilot -p "<中文操作指令>" --plugin-dir ./lib/plugin --allow-all-tools -s
```

验证宿主脚本、MCP 探针与真实模型会话日志保存在本地 `.artifacts/verify/`（已被 `.gitignore` 忽略，不随仓库分发）。宿主以 `node --experimental-transform-types` 直接加载 `src/**` 的 TypeScript 源码，保证运行的是当前工作区代码而非过期构建产物。

## 9. 结论

中文化后的提示词、工具描述与 SKILL.md 在真实模型会话中可用：工具选择正确、参数完整、中文拒绝可读、审核门有效。发现的三个问题均属文案层，已修复并复验；没有为了通过验证而放宽任何测试断言。剩余未覆盖项集中在缺少真实 Copilot Chat 客户端、DSH 宿主与真实凭据，已在 §7 如实保留。
