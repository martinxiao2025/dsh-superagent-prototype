# Copilot 插件:agent-plugins 包与 MCP 端点

> 阶段一交付说明 | 语言:简体中文 | 编码:UTF-8(无 BOM)
> 上位方案:[00-phase1-agent-plugins-migration.md](00-phase1-agent-plugins-migration.md) | 架构:[007-architecture.md](007-architecture.md) | 部署:[006-deployment.md](006-deployment.md)

## 1. 定位

阶段一把现有 TS 守护进程原样保留,在其上增加两件东西:

1. 一个符合 agent-plugins-spec 1.0.0 的插件目录 `plugin/`;
2. 一个只绑定回环的 MCP Streamable HTTP 端点,把 DSH 主会话的 14 个工具原样暴露给 Copilot。

插件加载后,Copilot 成为与 Web 面板、DSH 主会话并列的第三个客户端。领域逻辑(Engine、Policy、Store、Executor、Sources)零改动,MCP 只做操作路由。

## 2. 插件包

| 路径 | 内容 |
| --- | --- |
| `plugin/plugin.json` | 清单:名称 `dsh-superagent`、版本与 `package.json` 同步、描述、关键词、许可证 |
| `plugin/mcp.json` | 声明一个 `streamable-http` 服务: `http://127.0.0.1:3083/mcp` |
| `plugin/skills/dsh-superagent/SKILL.md` | 主技能:面向 Copilot 的操作指南(候选、评估、路由、回复、设置、诚实边界) |
| `lib/plugin/` | 构建产物,含主技能与 `skills/` 下两个内置技能(`dsh-superagent-github`、`dsh-superagent-feishu`) |

规范约束:技能只扫描 `skills/` 的**直接子目录**中的 `SKILL.md`,不递归;`plugin.json` 与 `mcp.json` 的 `$schema` 版本必须一致;`mcp.json` 的 `streamable-http` 只允许 `type`、`url`、`headers`。两份官方 schema 以离线副本存放在 `scripts/schemas/agent-plugins-1.0.0/`,校验时不联网。

内置技能不能被放进 `plugin/skills/` 后再被 DSH 会话加载,因此构建时从仓库 `skills/` 拷入产物,源码位置不变。

## 3. 构建与校验

```bash
pnpm build          # tsdown 先构建 lib/,随后 node scripts/build-plugin.mjs 组装 lib/plugin/
pnpm plugin:check   # 校验 plugin/ 与 lib/plugin/,离线
pnpm check          # typecheck + test + build + plugin:check
```

`tsdown` 的第一份配置带 `clean: true`,会清空 `lib/`,所以插件打包必须在其之后执行;`package.json` 的 `build` 已按此顺序接好。

校验覆盖:官方 schema 的两份清单、`$schema` 版本一致性、`plugin.version` 与 `package.json` 一致、MCP URL 必须是回环 `http://…/mcp`、技能目录结构与 frontmatter 的 `name`/`description`、所有文本文件的 UTF-8(无 BOM)。任一项失败退出码为 1,并打印文件与原因。

## 4. 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mcpEnabled` | `true` | 是否启动 MCP 端点;修改后需重启 |
| `mcpPort` | `3083` | 回环端口;修改后需重启,并同步改 `plugin/mcp.json` 的 URL。`0` 表示由系统选端口,仅用于测试 |

两项都是非 volatile 配置:保存后不会立即生效,面板会提示重启。端口被占用时进程继续运行,健康面板的 `mcp` 条目显示 `error` 与占用端口,不影响 Web 面板、DSH 会话和 Source 监听。

## 5. 安全边界

- 只监听 `127.0.0.1`,不监听 `0.0.0.0`,局域网不可达。
- 传输层启用 DNS rebinding 防护:`allowedHosts` 与 `allowedOrigins` 按实际监听端口生成,浏览器页面无法借同源策略驱动端点。
- 不引入 token/OAuth。任何能访问本机回环端口的进程都可以调用这些工具,这是阶段一接受的残余风险;信任边界是操作系统用户与权限,而不是网络。
- 权限口径不变:MCP 调用等价于一次面板操作,不绕过 Policy、Mandate 复验或授权判定。
- 每个 MCP 会话一个 `Server` 与一个 transport;`DELETE` 关闭会话,10 分钟无活动的会话被回收,`Runtime.stop()` 关闭全部连接与监听。
- 所有 `POST`(含 `initialize` 与已建会话的调用)都由端点自己限读请求体,上限 4 MB;超限返回 HTTP 413 与 JSON-RPC 错误,不是断连。头部 10 秒、整个请求 30 秒超时,慢客户端不会长期占用连接。
- 初始化失败只向客户端返回固定文案,原始错误写日志,避免把内部路径或实现细节暴露到端口上;工具自身的领域错误(`UserError` 的 `error` 与 `code`)仍原样返回,因为那是模型需要据以纠正的操作信息。

## 6. 安装与保活

安装:把 `lib/plugin/`(或仓库 `plugin/` 加构建产物)整体放入 Copilot 客户端的 agent plugins 目录;目录由客户端约定,VS Code 与 M365 各不相同,以客户端文档为准。放入后在客户端启用该插件,`mcp.json` 指向本机守护进程。

保活由外部调度负责,Copilot 进程不必常驻:

- Linux:systemd 单元 `Restart=always`,启动命令沿用 `scripts/dsh-superagent` 的 start;
- Windows:计划任务“开机启动”,失败时按计划任务的重启策略重跑同一脚本;
- 守护进程重启后,MCP 端点重新监听同一端口;streamable-http 的断线重试由 Copilot 客户端负责,规范未定义重连语义。

## 7. 排障

| 现象 | 原因与处理 |
| --- | --- |
| 健康面板 `mcp` 为 `error` | 端口被占用或无权监听;换 `mcpPort` 或释放端口,重启后重试 |
| 客户端收到 404 `Session 不存在` | 会话已被回收或守护进程重启;重新 initialize |
| 客户端收到 400 `第一个请求必须是 initialize` | 首帧不是 `initialize`;按 MCP 规范先握手 |
| 客户端收到 413 `MCP 请求体过大` | 单次请求体超过 4 MB;缩小 payload,不要重试同一请求 |
| 工具返回 `isError` 且带 `code` | 领域拒绝,原样展示 `error` 与 `code`;不要用改参或换工具绕过 |
| 读图片被拒 | MCP 侧没有 DSH 主会话的附件通道;改用线程文本,或提示用户到 DSH 会话读图 |
| `plugin:check` 报版本不一致 | `plugin.json` 的 `version` 必须等于 `package.json`;构建会注入,源文件需同步 |

## 8. 验收记录(2026-11-06)

| # | 验收项 | 结果 | 依据 |
| --- | --- | --- | --- |
| A1 | 规范合规 | 通过 | `node scripts/validate-plugin.mjs` 与 `--dir lib/plugin` 均退出 0;4 类负例(大写名称、schema 版本不一致、嵌套技能目录、未知字段)均退出 1 |
| A2 | 构建打包 | 通过 | `pnpm build` 退出 0;`lib/plugin/` 含 `plugin.json`、`mcp.json`、3 个技能目录,无 BOM |
| A3 | MCP 连通 | 自动等价验证通过 | `tests/mcp.spec.ts`:真实 Streamable HTTP 握手、14 个工具、`orchestrator_read`、`orchestrator_route` 建票;inspector GUI 未手工执行 |
| A4 | Copilot 冒烟 | 未执行 | 需要 VS Code Copilot 与用户账号,待用户配合 |
| A5 | 回归 | 通过(Windows) | 全量 1179 通过、26 跳过、0 失败。跳过的 3 类在测试文件内写明原因:worker shim 执行、`scripts/dsh-superagent` 服务脚本、飞书消费者假 CLI 都以 `#!/bin/sh` 脚本为被测对象,Windows 无法执行;另 1 项 POSIX 权限位断言。此前 42 项失败中的 16 项已改为跨平台实现并真实通过。真实 GitHub/飞书触发仍未执行 |
| A6 | 保活演练 | 未执行 | 需要 systemd/计划任务与真实部署,待用户环境 |

未闭合项如实保留,不以自动化结果替代人工验收。
