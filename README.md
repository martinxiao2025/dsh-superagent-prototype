# dsh-superagent

> **研究原型，仅供参考，不是 DeepSeek 官方产品。** 这些代码来自团队日常开发工作，其中大量工程由编码代理完成。请把它当作研究代码，而不是可直接上线的软件：它仍可能有缺陷，编码风格与工程实践也可能不一致。在你自己的环境中使用前，请先审查并做适配。
>
> 为公开发布做过改编，因此它既不等于内部版本，也不等于《Exploring Super-agent Design: Towards a More Autonomous Agent System》一文描述的完整实现。文中部分设计是后续方向，本原型并未实现。

## 这是什么

dsh-superagent 是面向**单个 GitHub 仓库**的主动式编码代理，作为独立的本地进程运行（`node lib/index.js`）。它监听 GitHub（可选飞书）：当允许名单中的人请求工作时，它建立工单（ticket），在独立目录与 worker 会话中执行，最后回到原对话答复，例如给出一个 Pull Request。自带的面板网页显示哪些事项需要人来处理；模型回合经 VS Code 语言模型桥执行。

它的工作方式本身也是一种主张：**尽量少占用人的注意力，尽量多交付价值。** 会替整个团队行动的代理，也可能浪费整个团队的注意力；因此它只在被请求、或团队写下的规则允许时才行动，只在有人必须行动或能用到结果时才说话。[docs/000-philosophy.md](docs/000-philosophy.md) 说明了这条原则以及对运营者的要求。

阶段一新增了两样东西，领域逻辑没有改动：

1. 符合 agent-plugins-spec 1.0.0 的插件包 [`plugin/`](plugin)（清单、MCP 声明、主技能）；
2. 只绑定 `127.0.0.1` 的 MCP Streamable HTTP 端点，把主会话的 14 个工具原样暴露给 VS Code Copilot 等 agent-plugins 客户端。

## 支持的运行环境

**本项目只支持并验证 Windows + VS Code Stable 的官方 Copilot / Copilot Chat。** 其它环境不在支持与验证范围内，也不作为未完成任务：

- Linux、macOS、WSL 及其它编辑器/宿主不在支持范围；VS Code Insiders 已卸载，不纳入；Copilot CLI 只作前置证据，不计入验收。
- POSIX 专属对象为**范围外**：`scripts/dsh-superagent`（tmux/`ps`/`fcntl`）、产品生成的 `#!/bin/sh` worker shim、systemd 单元、POSIX 权限位断言、飞书消费者假 CLI 的 shebang 执行。对应测试在 Windows 上保持跳过并注明「范围外」，不当作通过。
- Windows 上的守护启停用 [`scripts/dsh-superagent-windows.ps1`](scripts/dsh-superagent-windows.ps1)，不依赖第三方服务包装器。
- 既有产品配置中沿用 POSIX 绝对路径语义的字段（如 `stateDir` 需以 `/` 开头）属于产品现状，不在本阶段跨平台改造范围内。

## 快速开始

### 前置要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | `^22.19.0` 或 `>=24.0.0` | 本机验证版本 `v24.19.0` |
| pnpm | `11.7.0` | 由 `package.json` 的 `packageManager` 锁定；可用 `corepack enable` 启用 |
| VS Code | Stable，已登录可用语言模型的账号 | 模型回合经 `extension/dsh-lm-bridge` 调用 `vscode.lm` |
| 其他（完整部署） | git 2.32+、GitHub CLI 2.48+ | 飞书来源另需 `lark-cli`；详见 [SETUP.md](SETUP.md) |

### 从源码构建与自检

```sh
pnpm install
pnpm build     # tsdown 构建 lib/，随后 node scripts/build-plugin.mjs 组装 lib/plugin/
pnpm check     # typecheck + test + build + plugin:check
```

`pnpm build` 的顺序不能颠倒：tsdown 的第一份配置带 `clean: true`，会清空 `lib/`，插件打包必须在其之后执行。

### 启动与守护

完整安装（账号、机器配置、设置、验证）交给编码代理与运营者一起完成，指令在 [SETUP.md](SETUP.md)，细节在 [docs/006-deployment.md](docs/006-deployment.md)。最小路径是：

```powershell
pnpm install; pnpm build
# 首次运行前写一份机器配置，默认读取 ~/.dsh-superagent/config.json
pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action start
pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action status
```

最小机器配置只需 `{"stateDir": "C:\\Users\\me\\.dsh-superagent"}`；`panelPort`（默认 `3082`）与 `mcpPort`（默认 `3083`）可按需修改。守护脚本用 `-Config` 指定配置文件，日志与控制文件在 `.artifacts/` 下。

也可以前台直接运行 `node lib/index.js --config <配置文件>`，Ctrl+C 优雅退出。

### 接入 Copilot 等 agent-plugins 客户端

把构建产物 `lib/plugin/`（含 `plugin.json`、`mcp.json` 与 3 个技能目录）整体放入客户端的 agent plugins 目录，然后在客户端启用插件。目录位置由客户端约定，VS Code 与 M365 各不相同。VS Code Stable 1.145 可在命令面板执行 `Chat: Install Plugin from Source` 并输入 `lib/plugin` 的绝对路径（`file:///` URI 会被拒）；本机实测步骤见 `docs/009-copilot-plugin.md` §11.4。

`plugin/mcp.json` 指向 `http://127.0.0.1:3083/mcp`。若在机器配置里改了 `mcpPort`，这个 URL 必须同步修改；端点由本机守护进程提供，**客户端自身不能代替守护进程**。

## 目录结构

```text
.
├── src/
│   ├── core/       领域核心：Engine、模型、ports；不做 I/O，不改领域行为
│   ├── app/        应用层：Runtime、Store、HTTP、MainSession、Settings、Prompts、MCP（mcp.ts / mcp-tools.ts）
│   ├── executor/   HostExecutor、AgentHost 与 worker 回合
│   ├── sources/    GitHub / 飞书来源插件与注册表
│   ├── client/     React 面板
│   └── infra/      CLI 传输、环境、路径、HealthBoard
├── prompts/        内置提示词，每行一句
├── skills/         会话内置技能（dsh-superagent-github、dsh-superagent-feishu）
├── plugin/         插件源：plugin.json、mcp.json、skills/dsh-superagent/SKILL.md
├── locale/         面板双语文案 en.json / zh.json
├── docs/           设计文档 000–010 与计划文档 00、01
├── extension/      VS Code 语言模型桥扩展（dsh-lm-bridge）
├── scripts/
│   ├── build-plugin.mjs    组装 lib/plugin/
│   ├── validate-plugin.mjs 离线校验插件包
│   ├── schemas/            agent-plugins 1.0.0 官方 schema 离线副本
│   ├── dsh-superagent-windows.ps1  Windows 守护脚本（start/stop/status/drill）
│   └── dsh-superagent      POSIX 服务脚本（范围外，仅保留既有实现）
├── tests/          vitest 测试与共享夹具
├── lib/            构建产物（gitignore，不提交）
└── SETUP.md        与编码代理一起安装的指令
```

`plugin/` 是插件唯一事实源；`lib/plugin/` 只是构建产物，禁止手改。

## 插件能力与工具清单

插件包由三部分组成：`plugin/plugin.json`（清单，版本与 `package.json` 同步）、`plugin/mcp.json`（一个 `streamable-http` 服务）、`plugin/skills/dsh-superagent/SKILL.md`（面向 Copilot 的操作指南）。构建时还会把 `skills/` 下的两个内置技能拷入 `lib/plugin/skills/`，形成 3 个技能目录。

MCP 端点暴露的是 **主会话的同一批 14 个工具**，没有第二套实现；每次调用等价于一次面板操作，同样经过 Policy 与 Mandate 复验。

| 分组 | 工具 | 用途 |
| --- | --- | --- |
| 读取 | `orchestrator_read` | 读取资源的下一页：工单、会话、设置块、策略、概览，以及 `github/...`、`feishu/...` 快捷路径 |
| 评估 | `orchestrator_eval` | 按 `trigger_id` 载入候选的评估窗口 |
| 评估 | `orchestrator_eval_read` | 按 id 读取整条消息、后续会话页或仓库文本（图片附件本期不可读，见「已知限制」） |
| 评估 | `orchestrator_eval_decide` | 按已启用规则记录评估结论 |
| 路由 | `orchestrator_route` | 一次受理 1–20 条决策：接受、附加、停止或忽略 |
| 工单 | `orchestrator_ticket_retry` | 重试工单的启动 |
| 工单 | `orchestrator_ticket_request_status` | 向 worker 索取当前状态 |
| 工单 | `orchestrator_ticket_note` | 把事实作为上下文写给 worker，而非授权 |
| 触发 | `orchestrator_trigger_requeue` | 把触发重新排队 |
| 回复 | `orchestrator_reply` | 按用途回复：`result`、`attention`、`answer` |
| 会话 | `orchestrator_thread_unsubscribe` | 结束某个会话（thread）的投递 |
| 设置 | `orchestrator_settings_save` | 在明确的人工配置请求下保存一个设置块 |
| 设置 | `orchestrator_policy_sync` | 同步策略 |
| 设置 | `orchestrator_prompts_save` | 按 `baseRevision` 保存完整提示词配置；`preview: true` 只组合不保存 |

worker 侧另有 5 个自有工具（`orchestrator_ack`、`orchestrator_report`、`orchestrator_thread_unrelated`、`orchestrator_thread_follow`、`orchestrator_trigger_handback`），加上共享的 `orchestrator_read`，每个执行器共注册 6 个。这些工具不通过 MCP 暴露。

## 配置项

机器配置是一个 JSON 文件，默认 `~/.dsh-superagent/config.json`，可用 `--config` 或环境变量 `DSH_SUPERAGENT_CONFIG` 指定；首次启动后，面板的 **Settings → Deployment** 可以修改除进程级键以外的限额。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `stateDir` | 无（必填） | 绝对路径：数据库、锁文件、`worker-bin` 中的命令 shim、代理的 git 配置，以及默认情况下 `work` 中的工单目录。升级前请备份；无法在面板中修改 |
| `panelPort` | `3082` | 面板网页与管理 API 的回环端口；修改后需重启 |
| `host` | `127.0.0.1` | 面板与 MCP 端点的回环主机名，只允许 `127.0.0.1` 或 `localhost` |
| `mcpEnabled` | `true` | 是否启动回环 MCP 端点；修改后需重启 |
| `mcpPort` | `3083` | 回环端口；修改后需重启，并同步修改 `plugin/mcp.json` 的 URL。`0` 表示由系统挑一个空闲端口，仅用于测试 |
| `model` | 无 | 语言模型桥使用的模型 id；缺省使用 VS Code 里选中的模型 |
| `promptMaxChars` | `100000` | 保存的提示词配置的最大长度 |
| `admissionContextMaxPages` | `10` | 一次评估最多读取多少个会话（thread）页 |
| `admissionContextTimeoutMs` | `15000` | 一次评估读取上下文的超时（毫秒） |

除 `stateDir`、`panelPort`、`host`、`mcpEnabled`、`mcpPort` 外，其余限额保存后即可生效。端口被占用不会让编排停摆：进程继续运行，健康面板的 `mcp` 条目显示 `error` 与占用端口。

> `stateDir` 按运行时判断绝对路径，Windows 的 `D:\...` 与 POSIX 的 `/...` 都接受；相对路径会被拒绝并给出可读原因。

## 验证与测试

```sh
pnpm typecheck                    # tsc --noEmit
pnpm test                         # vitest 全量
pnpm test -- tests/mcp.spec.ts    # 单文件
pnpm build                        # tsdown，随后组装 lib/plugin/
pnpm plugin:check                 # 校验 plugin/ 与 lib/plugin/，离线
pnpm check                        # 以上全部串起来，提交前必跑
node scripts/validate-plugin.mjs [--dir <path>]   # 单独校验某个插件目录
```

`plugin:check` 依赖先构建：它同时校验 `plugin/`（1 个技能）与 `lib/plugin/`（3 个技能）。校验覆盖官方 schema、`$schema` 版本一致性、`plugin.version` 与 `package.json` 一致、MCP URL 必须是回环 `http://…/mcp`、技能目录结构与 frontmatter，以及所有文本文件的 UTF-8（无 BOM）；任一项失败退出码为 1 并打印原因。

当前基线（2026-11-07，Windows）：`pnpm check` 退出 0，全量测试 **990 通过 / 26 跳过 / 0 失败**（56 个测试文件）。跳过的 26 项都源于被测对象本身是 POSIX 专属实现（产品生成的 `#!/bin/sh` worker shim、`scripts/dsh-superagent` 服务脚本、飞书消费者的假 CLI、一处 POSIX 权限位断言）；它们在 Windows 上**范围外**，测试文件内用 `skipIf(platform)` 写明原因，保留跳过但不当作通过，也不计入剩余待办。`tests/e2e-bridge.spec.ts` 走真实 VS Code 语言模型桥，找不到桥时整组跳过，不计入通过。

## 已知限制

- **研究原型**：不保证生产可用，接口与行为可能变化。
- **回环即身份**：端点只监听 `127.0.0.1` 并启用 DNS rebinding 防护，但不引入 token/OAuth；任何能访问本机回环端口的进程都能调用这些工具，信任边界是操作系统用户与权限。
- **图片附件不可读（已知限制）**：本期不读取工单中的图片附件，**带图工单只能读文字**；`orchestrator_eval_read` 的图片分支返回固定错误并说明不可读，评估指令据此要求依赖截图措辞或视觉事实时给出 `unavailable`。后续加回位置是 `src/app/assessment.ts` 的 `read()` 中 `resource === 'image'` 分支，详见 [docs/010](docs/010-runtime-verification.md) §11。
- **客户端差异**：agent plugins 目录与启用方式由各客户端约定；规范未定义 `streamable-http` 的重连语义，断线重试由客户端负责。
- **必须常驻守护进程**：插件只是客户端入口，端点由 `scripts/dsh-superagent-windows.ps1 -Action start` 启动的守护进程提供。
- **未闭合的人工验收**：VS Code Copilot 冒烟（A4）客户端已就位、待 IDE 内人工验证（CLI 与 Insiders 不计入）；真实 GitHub/飞书触发（A5 第二轮）未执行，当前只报告自动化回归结果。
- **平台覆盖**：支持环境是 Windows + VS Code Stable 的官方 Copilot / Copilot Chat；POSIX 专属对象（服务脚本、worker shim、systemd、权限位）为范围外，不再作为待验证或待支持项。

## 文档

按编号顺序阅读，每篇只依赖更早的文档：

- [000 理念](docs/000-philosophy.md)
- [001 领域模型](docs/001-domain.md)
- [002 授权](docs/002-authorization.md)
- [003 执行](docs/003-execution.md)
- [004 提示词](docs/004-prompts.md)
- [005 面板](docs/005-panel.md)
- [006 部署](docs/006-deployment.md)
- [007 架构](docs/007-architecture.md)
- [008 手册](docs/008-cookbook.md)
- [009 Copilot 插件](docs/009-copilot-plugin.md)
- [010 真实运行验证](docs/010-runtime-verification.md)

## 许可

[MIT](LICENSE)
