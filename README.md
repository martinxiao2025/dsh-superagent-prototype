# dsh-superagent

> **研究原型，仅供参考，不是 DeepSeek 官方产品。** 这些代码来自团队日常开发工作，其中大量工程由编码代理完成。请把它当作研究代码，而不是可直接上线的软件：它仍可能有缺陷，编码风格与工程实践也可能不一致。在你自己的环境中使用前，请先审查并做适配。
>
> 为公开发布做过改编，因此它既不等于内部版本，也不等于《Exploring Super-agent Design: Towards a More Autonomous Agent System》一文描述的完整实现。文中部分设计是后续方向，本原型并未实现。

## 这是什么

dsh-superagent 是面向**单个 GitHub 仓库**的主动式编码代理，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/)（DSH）bundle 的形式运行。它监听 GitHub（可选飞书）：当允许名单中的人请求工作时，它建立工单（ticket），在独立的 DSH 会话（Session）与目录中执行，最后回到原对话答复，例如给出一个 Pull Request。Web 面板显示哪些事项需要人来处理。

它的工作方式本身也是一种主张：**尽量少占用人的注意力，尽量多交付价值。** 会替整个团队行动的代理，也可能浪费整个团队的注意力；因此它只在被请求、或团队写下的规则允许时才行动，只在有人必须行动或能用到结果时才说话。[docs/000-philosophy.md](docs/000-philosophy.md) 说明了这条原则以及对运营者的要求。

阶段一新增了两样东西，领域逻辑没有改动：

1. 符合 agent-plugins-spec 1.0.0 的插件包 [`plugin/`](plugin)（清单、MCP 声明、主技能）；
2. 只绑定 `127.0.0.1` 的 MCP Streamable HTTP 端点，把 DSH 主会话的 14 个工具原样暴露给 VS Code Copilot 等 agent-plugins 客户端。

## 快速开始

### 前置要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | `^22.19.0` 或 `>=24.0.0` | 本机验证版本 `v24.19.0` |
| pnpm | `11.7.0` | 由 `package.json` 的 `packageManager` 锁定；可用 `corepack enable` 启用 |
| DSH | 满足 `engines.dsh`（`^0.2.1-alpha.2`） | 只有安装成 bundle 时才需要；公开版 `0.2.1-rc.3` 可用 |
| 其他（完整部署） | git 2.32+、tmux、Python 3.8+、GitHub CLI 2.48+ | 飞书来源另需 `lark-cli`；详见 [SETUP.md](SETUP.md) |

### 从源码构建与自检

```sh
pnpm install
pnpm build     # tsdown 构建 lib/，随后 node scripts/build-plugin.mjs 组装 lib/plugin/
pnpm check     # typecheck + test + build + plugin:check
```

`pnpm build` 的顺序不能颠倒：tsdown 的第一份配置带 `clean: true`，会清空 `lib/`，插件打包必须在其之后执行。

### 安装成 DSH bundle

完整安装（账号、profile、机器配置、设置、验证）交给编码代理与运营者一起完成，指令在 [SETUP.md](SETUP.md)，细节在 [docs/006-deployment.md](docs/006-deployment.md)。最小路径是：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null   # 仅在 profile 不存在时执行
dsh plugin --profile superagent add "link:$PWD"
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`--from-default-profile` 会替换已有 profile 并删除其中的 `cordis.patch.yml`；profile 已存在时不要执行它，改为编辑该文件。

### 接入 Copilot 等 agent-plugins 客户端

把构建产物 `lib/plugin/`（含 `plugin.json`、`mcp.json` 与 3 个技能目录）整体放入客户端的 agent plugins 目录，然后在客户端启用插件。目录位置由客户端约定，VS Code 与 M365 各不相同。VS Code Stable 1.119 可在命令面板执行 `Chat: Install Plugin from Source` 并指向本机的 `lib/plugin`；本机人工步骤见 `docs/009-copilot-plugin.md` §11.4。

`plugin/mcp.json` 指向 `http://127.0.0.1:3083/mcp`。若在机器配置里改了 `mcpPort`，这个 URL 必须同步修改；端点由本机守护进程提供，**客户端自身不能代替守护进程**。

## 目录结构

```text
.
├── src/
│   ├── core/       领域核心：Engine、模型、ports；不做 I/O，不改领域行为
│   ├── app/        应用层：Runtime、Store、HTTP、Sessions、Settings、Prompts、MCP（mcp.ts / mcp-tools.ts）
│   ├── executor/   DshExecutor 与 worker 会话
│   ├── sources/    GitHub / 飞书来源插件与注册表
│   ├── client/     React 面板
│   └── infra/      CLI 传输、环境、路径、HealthBoard
├── prompts/        内置提示词，每行一句
├── skills/         DSH 内置技能（dsh-superagent-github、dsh-superagent-feishu）
├── plugin/         插件源：plugin.json、mcp.json、skills/dsh-superagent/SKILL.md
├── locale/         面板双语文案 en.json / zh.json
├── docs/           设计文档 000–010 与计划文档 00、01
├── examples/       示例 profile 配置
├── scripts/
│   ├── build-plugin.mjs    组装 lib/plugin/
│   ├── validate-plugin.mjs 离线校验插件包
│   ├── schemas/            agent-plugins 1.0.0 官方 schema 离线副本
│   └── dsh-superagent      部署后的服务管理脚本（start/stop/restart/status）
├── tests/          vitest 测试与共享夹具
├── lib/            构建产物（gitignore，不提交）
└── SETUP.md        与编码代理一起安装的指令
```

`plugin/` 是插件唯一事实源；`lib/plugin/` 只是构建产物，禁止手改。

## 插件能力与工具清单

插件包由三部分组成：`plugin/plugin.json`（清单，版本与 `package.json` 同步）、`plugin/mcp.json`（一个 `streamable-http` 服务）、`plugin/skills/dsh-superagent/SKILL.md`（面向 Copilot 的操作指南）。构建时还会把 `skills/` 下的两个内置技能拷入 `lib/plugin/skills/`，形成 3 个技能目录。

MCP 端点暴露的是 **DSH 主会话的同一批 14 个工具**，没有第二套实现；每次调用等价于一次面板操作，同样经过 Policy 与 Mandate 复验。

| 分组 | 工具 | 用途 |
| --- | --- | --- |
| 读取 | `orchestrator_read` | 读取资源的下一页：工单、会话、设置块、策略、概览，以及 `github/...`、`feishu/...` 快捷路径 |
| 评估 | `orchestrator_eval` | 按 `trigger_id` 载入候选的评估窗口 |
| 评估 | `orchestrator_eval_read` | 按 id 读取整条消息、后续会话页或仓库文本（图片需 DSH 主会话，MCP 侧会被拒绝） |
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

机器配置在 profile 的 `cordis.patch.yml`（示例见 [examples/profile.cordis.patch.yml](examples/profile.cordis.patch.yml)），首次启动后也可在 **Settings → Deployment** 或 DeepSeek Harness Plugin Manager 中修改。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `stateDir` | 无（必填） | 绝对路径：数据库、锁文件、`worker-bin` 中的命令 shim、代理的 git 配置，以及默认情况下 `work` 中的工单目录。升级前请备份；无法在面板中修改 |
| `mcpEnabled` | `true` | 是否启动回环 MCP 端点；修改后需重启 |
| `mcpPort` | `3083` | 回环端口；修改后需重启，并同步修改 `plugin/mcp.json` 的 URL。`0` 表示由系统挑一个空闲端口，仅用于测试 |
| `promptMaxChars` | `100000` | 保存的提示词配置的最大长度 |
| `admissionContextMaxPages` | `10` | 一次评估最多读取多少个会话（thread）页 |
| `admissionContextTimeoutMs` | `15000` | 一次评估读取上下文的超时（毫秒） |

除 `stateDir`、`mcpEnabled`、`mcpPort` 外，其余限额保存后即可生效。端口被占用不会让编排停摆：进程继续运行，健康面板的 `mcp` 条目显示 `error` 与占用端口。

> `stateDir` 的校验要求以 `/` 开头的绝对路径，沿用 POSIX 语义；在原生 Windows 路径（如 `D:\...`）下会被拒绝，请使用 WSL 或等价的 POSIX 环境。

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

当前基线（2026-11-06，Windows）：`pnpm check` 退出 0，全量测试 **1177 通过 / 26 跳过 / 0 失败**。跳过的 26 项都源于被测对象本身是 POSIX 专属实现：产品生成的 `#!/bin/sh` worker shim、`scripts/dsh-superagent` 服务脚本、飞书消费者的假 CLI，以及一处 POSIX 权限位断言；对应测试文件内用 `skipIf(platform)` 写明原因，未把跳过当通过。

## 已知限制

- **研究原型**：不保证生产可用，接口与行为可能变化。
- **回环即身份**：端点只监听 `127.0.0.1` 并启用 DNS rebinding 防护，但不引入 token/OAuth；任何能访问本机回环端口的进程都能调用这些工具，信任边界是操作系统用户与权限。
- **图片读取**：MCP 侧没有 DSH 主会话的附件通道，`orchestrator_eval_read` 的图片分支会被拒绝并给出原因。
- **客户端差异**：agent plugins 目录与启用方式由各客户端约定；规范未定义 `streamable-http` 的重连语义，断线重试由客户端负责。
- **必须常驻守护进程**：插件只是客户端入口，端点由 `scripts/dsh-superagent start` 启动的守护进程提供。
- **未闭合的人工验收**：VS Code Copilot 冒烟（A4）客户端已就位、待 IDE 内人工验证（CLI 与 Insiders 不计入）；systemd/计划任务长期保活未验证（A6 的 Windows 机制演练已通过）；真实 GitHub/飞书触发（A5 第二轮）未执行，当前只报告自动化回归结果。
- **平台覆盖**：自动化验证在 Windows 完成；POSIX 专属对象按上述方式跳过，Linux 行为仍需在目标环境复核。

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
