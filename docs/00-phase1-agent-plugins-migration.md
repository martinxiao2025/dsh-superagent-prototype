# 阶段一:迁移到 agent-plugins 标准的方案

> 项目:dsh-superagent → Copilot 插件迁移 | 阶段:Phase 1 / 4
> 状态:方案定稿 | 语言:简体中文 | 编码:UTF-8(无 BOM)
> 规范依据:[agent-plugins-spec 1.0.0](https://github.com/agentplugins/agent-plugins-spec)([agent-plugins.org](https://agent-plugins.org))

> **2026-11-06 修订(以代码事实为准)**:本文保留原始方案,实施口径与偏差裁决见 [01-phase1-task-plan.md](01-phase1-task-plan.md) §0/§2。已知差异:A3 的工具数是 **14**(非 20);worker 自有工具 **5** 个(加共享 `orchestrator_read`,每个执行器注册 6 个);端口冲突只写 `mcp` 健康条目,不走 `SetupError`;MCP 不使用 `x-orchestrator-request` 自定义头,只绑回环并启用 DNS rebinding 防护;`plugin.json` 不写占位 `homepage`;内置技能留在仓库 `skills/`,构建时拷入 `lib/plugin/skills/`。

## 1. 定位与迁移思路

总迁移路线分四个阶段,本文档只覆盖**阶段一**:

| 阶段 | 内容 | 状态 |
|---|---|---|
| **一(本文档)** | **最小改造:现有 TS 守护进程照常运行,新增合规插件包 + MCP 端点** | 待实施 |
| 二 | 面板 MCP Apps 化(`ui://` 资源 + postMessage 通道) | 方案见架构文档第 6 节 |
| 三 | worker 执行器 CLI 化(`IAgentCliDriver` 驱动 Copilot/ZCode/dsh CLI) | 方案见架构文档第 5 节 |
| 四 | C#/.NET 全量重写守护进程 | 方案见架构与实施计划文档 |

**阶段一核心思路:不重写、不换语言、不换运行时。** dsh-superagent(TS/DSH 守护进程)保持现有部署形态与全部行为不变,仅做两件事:

1. 打包一个符合 agent-plugins-spec 1.0.0 的**插件目录**(`plugin.json` + `mcp.json` + `skills/`);
2. 在守护进程上新增一个 **MCP streamable-http 端点**,把现有管理能力以 MCP 工具暴露。

Copilot(VS Code GitHub Copilot / M365 Copilot)加载插件后,即可在聊天中查询与操控守护进程,成为与 Web 面板、DSH 主会话并列的**第三个交互入口**——零风险验证插件链路,为后续阶段铺路。

## 2. 目标与非目标

**目标**
- 插件目录通过 agent-plugins-spec 1.0.0 官方 schema 校验;
- Copilot 中:技能可见可加载、MCP 工具可列出可调用;
- 经 MCP 工具完成一次完整 Ticket 流转(查询候选 → 路由决策 → 查看工单);
- 守护进程现有功能(Web 面板、DSH 会话、GitHub/飞书监听)回归无变化。

**非目标(明确不做)**
- 不改任何领域逻辑(`src/core`、Engine、Policy、Store 零改动);
- 不动 worker 执行面(DshExecutor 照常经 DSH 会话执行);
- 不做 MCP Apps 面板、不做 C#、不做 CLI 驱动器(阶段二/三/四);
- 不做插件商店分发与签名(规范不定义安装,手动放置插件目录)。

## 3. 迁移物清单

### 3.1 插件清单 `plugin/plugin.json`

schema 封闭(未知顶层字段违规但非致命),只声明元数据:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "dsh-superagent",
  "version": "0.1.0",
  "description": "Proactive coding agent for one GitHub repository: evaluate requests, route tickets, and drive workers from Copilot.",
  "keywords": ["agent", "orchestrator", "github", "feishu"],
  "homepage": "https://github.com/<org>/dsh-superagent"
}
```

### 3.2 MCP 声明 `plugin/mcp.json`

采用 **streamable-http** 变体指向本机守护进程。规范要求:非 loopback 主机必须 HTTPS;**HTTP 仅允许 localhost / 回环 IP 字面量**——守护进程只绑定 `127.0.0.1`,天然满足。`mcp.json` 的 `$schema` 版本必须与 `plugin.json` 一致,否则 MCP 配置无效。

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

> 端口选择说明:守护进程现有面板挂在 DSH webServer(profile 端口 3082)之下。MCP 端点**独立监听 3083**,避免 DSH webServer 对 GET+SSE 长连接、同源头校验的干扰;3083 只绑回环,并在启动时探测端口占用(`SetupError` 报告,沿用原型固定问题码机制)。

### 3.3 技能 `plugin/skills/`

| 技能 | 来源 | 处理 |
|---|---|---|
| `dsh-superagent-github` | 原型 `skills/dsh-superagent-github/SKILL.md` | **直接复用**(已是标准 SKILL.md,含 name/description frontmatter) |
| `dsh-superagent-feishu` | 原型 `skills/dsh-superagent-feishu/SKILL.md` | **直接复用** |
| `dsh-superagent`(新增主技能) | 蒸馏 `prompts/orchestrator.md` + `admission.md` + `replies.md` | 新写:面向 Copilot 用户的 router 操作指南——如何查候选(`orchestrator_eval`)、如何路由(`orchestrator_route`:accept/attach/stop/ignore 的判据)、何时回复、一次一个具体问题、诚实报告;不含 DSH 会话专属措辞 |

规范要求:技能位于 `skills/` 下**直接子目录**的 `SKILL.md`(不递归);每个技能遵循 agentskills.io 的 SKILL.md 格式(frontmatter 含 `name`、`description`)。原型两个技能已满足;主技能新写时同样遵守。

### 3.4 打包脚本 `scripts/build-plugin.mjs`

组装产物到 `lib/plugin/`:

```
lib/plugin/
├─ plugin.json          # 自 plugin/ 注入构建版本号
├─ mcp.json
└─ skills/
    ├─ dsh-superagent/SKILL.md
    ├─ dsh-superagent-github/SKILL.md
    └─ dsh-superagent-feishu/SKILL.md
```

打包即拷贝与变量注入,**无编译产物**(MCP server 在守护进程内,不随插件分发)。同步更新 `package.json` 的 `files` 数组纳入 `plugin/`。

## 4. 唯一实质代码改动:MCP 端点与工具映射

新增文件(遵循原型模块表纪律,`docs/007-architecture.md` 模块/测试表同步登记):

### 4.1 `src/app/mcp.ts` — MCP server 端点

- 依赖 `@modelcontextprotocol/sdk`(server 侧 streamable-http transport),挂在守护进程新起的独立回环 HTTP 监听(3083),路径 `/mcp`;
- 注册 §4.2 的工具集;初始化握手按 MCP 规范(session id、协议版本协商);
- 鉴权与安全:仅绑 `127.0.0.1`;沿用原型管理 API 的同源思路(要求自定义头 `x-orchestrator-request: 1` 的等价校验按 MCP 握手可行性在实现时确认,不可行则以回环 + 端口私有性为准并记录决策)。

### 4.2 工具映射层 `src/app/mcp-tools.ts`

把**主会话 14 个应用工具**中面向人/评估的全部映射为 MCP 工具,复用 `src/app/tools/main.ts` 的工具描述符与 zod schema(zod 4 `z.toJSONSchema` 生成 `inputSchema`):

| MCP 工具 | 来源 | 说明 |
|---|---|---|
| `orchestrator_read` | 同名工具 | 资源分页读取,只读,最常用的查询入口 |
| `orchestrator_route` | 同名工具 | 1–20 个决策批量路由,每项独立 Engine 命令 |
| `orchestrator_eval` / `orchestrator_eval_read` / `orchestrator_eval_decide` | 同名工具 | 评估三件套:Copilot 会话成为与 DSH 主会话并列的评估者(拉取式,Engine 零改动——主会话本就是 Engine 的客户端,这是六边形架构的红利) |
| `orchestrator_ticket_retry` / `orchestrator_ticket_request_status` / `orchestrator_ticket_note` | 同名工具 | 工单管理 |
| `orchestrator_trigger_requeue` | 同名工具 | 保留既有拒绝规则(Executor 属主的跟进不回 Eval) |
| `orchestrator_reply` | 同名工具 | 经 Outbox 回 GitHub/飞书 |
| `orchestrator_thread_unsubscribe` | 同名工具 | 退订 |
| `orchestrator_settings_save` / `orchestrator_policy_sync` / `orchestrator_prompts_save` | 同名工具 | 配置管理;`origin` 固定为 `tool` |
| (不映射) | worker 6 工具 | 属 Executor 会话内部工具,阶段一不暴露 |

结果形状沿用原型路由结果约定(`{results}` 保序、拒绝项含原因不断批)。

### 4.3 接线与配置

- `src/index.ts` 插件启动时创建 MCP 端点(可经机器配置开关,默认开);
- 新增 `SetupError` 码:`mcp-port-busy` 等,进入现有健康面板;
- 权限口径:MCP 工具的每次调用等价于一次面板操作,**不**绕过 Policy——授权判定仍只发生在 Trigger 进入与 Mandate 复验处,MCP 层只做操作路由,与现有管理 API 一致。

### 4.4 测试 `tests/mcp.spec.ts`

- 工具清单与 schema 与 `src/app/tools/main.ts` 描述符一致(防漂移,风格对齐 `model-surface.spec.ts`);
- 以 SDK 内存传输(streamable-http 的 in-memory 等价物)跑:握手 → 列工具 → 调 `orchestrator_read` → 调 `orchestrator_route` 断言 Engine 状态变化;
- 拒绝路径:非法参数返回结构化错误且不影响后续调用。

## 5. 部署与保活

- **守护进程**:沿用现有 DSH bundle 部署(`scripts/dsh-superagent` 已提供 start/stop/status);
- **保活**:外部调度保证 24/7——Linux systemd 单元(`Restart=always`,复用 `scripts/dsh-superagent` 命令);Windows 计划任务(开机启动 + 失败重启);不依赖 Copilot 进程存活;
- **插件安装**:手动将 `lib/plugin/`(或仓库 `plugin/`)放入 Copilot 客户端的插件目录(客户端自定,如 VS Code 的 agent plugins 目录);文档中写明放置路径与启用步骤;
- **重连语义**:规范未定义断线重启策略;streamable-http 断线由 Copilot 客户端自行重试,验收时实测 VS Code 行为并记录。

## 6. 验收标准

| # | 验收项 | 通过标准 |
|---|---|---|
| A1 | 规范合规 | `plugin.json`/`mcp.json` 通过官方 1.0.0 JSON schema 校验(下载 schema 至独立目录仅作校验输入,不联网执行) |
| A2 | 构建打包 | `pnpm check` 全绿;`lib/plugin/` 结构与 §3.4 一致 |
| A3 | MCP 连通 | MCP inspector 连 `http://127.0.0.1:3083/mcp`:握手成功、20 个工具列出、任选工具调用返回 |
| A4 | Copilot 冒烟(需用户配合) | VS Code Copilot 加载插件:三个技能可见;聊天中 `@dsh-superagent` 查候选 → 路由 accept → Ticket 创建 → worker 执行 → 结果可查 |
| A5 | 回归 | 既有 Web 面板、DSH 主会话评估、GitHub 监听行为不变(现有测试全绿 + 一轮真实触发观察) |
| A6 | 保活演练 | kill 守护进程 → 调度器拉起 → Copilot 侧重连恢复可用 |

## 7. 工作量与顺序

| 任务 | 估算 |
|---|---|
| 插件清单 + 打包脚本 + schema 校验脚本 | 0.5 天 |
| 主技能 `dsh-superagent/SKILL.md`(蒸馏提示词) | 1 天 |
| `src/app/mcp.ts` + `mcp-tools.ts` + 接线 | 2–3 天 |
| `tests/mcp.spec.ts` + 模块表/文档同步(`docs/007` 两表、`docs/009-copilot-plugin.md`、`AGENTS.md`) | 1–2 天 |
| inspector 与 VS Code 冒烟、保活配置 | 1 天 |
| **合计** | **约 5–7 个工作日**(单人) |

实施顺序:清单与打包 → MCP 端点与工具 → 测试 → 主技能 → 冒烟验收。

## 8. 风险与对策(阶段一特定)

| 风险 | 对策 |
|---|---|
| DSH webServer 与新监听的端口/生命周期冲突 | 独立 3083 + 启动探测 + `SetupError` 报告;验收 A6 演练 |
| zod → JSON Schema 细节差异(description 丢失、联合类型表示) | 映射层单测逐一比对;复杂 schema 手写 JSON Schema |
| Copilot 对 streamable-http 的兼容细节(会话保持、头要求) | inspector 先行隔离验证;必要时在 3083 前加极薄适配,不动领域层 |
| 主技能与提示词语义漂移 | 主技能只作行为指南,权威语义仍在 `prompts/`(DSH 会话)与工具描述中;技能文档标注来源与版本 |
| 双入口并发操作(面板 + MCP 同时写设置) | 全部写入走既有 `Settings.save` 的 revision 机制,天然防覆盖;测试补一例并发拒绝 |

## 9. 后续阶段衔接

阶段一交付后:阶段二在 `mcp.ts` 上增加 `ui://` 资源与面板 postMessage 通道(架构文档 §6);阶段三以 `IAgentCliDriver` 替换 DshExecutor 对 DSH 进程内 API 的依赖(架构文档 §5);阶段四整体 C# 化(实施计划文档 M0–M6)。阶段一的 MCP 工具面与插件包结构**在后续阶段原样保留**,是全程稳定契约。
