# Copilot 插件:agent-plugins 包与 MCP 端点

> 阶段一交付说明 | 语言:简体中文 | 编码:UTF-8(无 BOM)
> 上位方案:[00-phase1-agent-plugins-migration.md](00-phase1-agent-plugins-migration.md) | 架构:[007-architecture.md](007-architecture.md) | 部署:[006-deployment.md](006-deployment.md)

## 1. 定位

阶段一把现有 TS 守护进程原样保留,在其上增加两件东西:

1. 一个符合 agent-plugins-spec 1.0.0 的插件目录 `plugin/`;
2. 一个只绑定回环的 MCP Streamable HTTP 端点,把 DSH 主会话的 14 个工具原样暴露给 Copilot。

插件加载后,Copilot 成为与 Web 面板、DSH 主会话并列的第三个客户端。领域逻辑(Engine、Policy、Store、Executor、Sources)零改动,MCP 只做操作路由。

**支持环境(2026-11-06 用户确认):只支持并验证 Windows + VS Code Stable 的官方 Copilot / Copilot Chat。** Linux、macOS、WSL、其它编辑器/宿主、VS Code Insiders(已卸载)与 Copilot CLI(仅前置证据)都不在支持与验收范围;POSIX 专属对象(`#!/bin/sh` worker shim、systemd、POSIX 权限位、`scripts/dsh-superagent`)为**范围外**,不作为待办。

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

安装:把 `lib/plugin/`(或仓库 `plugin/` 加构建产物)整体放入 Copilot 客户端的 agent plugins 目录;目录由客户端约定,VS Code 与 M365 各不相同,以客户端文档为准。放入后在客户端启用该插件,`mcp.json` 指向本机守护进程。VS Code Stable 1.145 可在命令面板执行 `Chat: Install Plugin from Source` 并输入本机 `lib/plugin` 的**绝对路径**(`file:///` URI 会被拒),具体步骤见 §11.4。

保活由外部调度负责,Copilot 进程不必常驻:

- Windows(支持环境):用本仓库的 `scripts/dsh-superagent-windows.ps1 -Action start`(无第三方依赖,start/stop/status/supervise);需要开机自启时,由计划任务在登录时调用同一条命令。演练与实测见 §10;
- Linux/systemd(范围外,不实现也不验证):`scripts/dsh-superagent` 与 systemd 单元不属于本项目支持范围;
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
| 强杀后自动拉起要等约 30 秒 | `proper-lockfile` 的 `stateDir` 锁在硬杀后残留,需等满 `stale=30s` 才能接管;计划内重启请用 `-Action stop`,不要强杀(见 §10.4) |

## 8. 验收记录(2026-11-06)

| # | 验收项 | 结果 | 依据 |
| --- | --- | --- | --- |
| A1 | 规范合规 | 作者侧校验通过 | `node scripts/validate-plugin.mjs` 与 `--dir lib/plugin` 均退出 0;4 类负例(大写名称、schema 版本不一致、嵌套技能目录、未知字段)均退出 1。注意:该脚本是作者侧门禁,比规范对客户端的最低要求更严格(未知顶层字段直接失败、`mcpServers` 不得为空、MCP 仅允许回环 HTTP),不能据此宣称客户端一致性 |
| A2 | 构建打包 | 通过 | `pnpm build` 退出 0;`lib/plugin/` 含 `plugin.json`、`mcp.json`、3 个技能目录,无 BOM |
| A3 | MCP 连通 | 自动等价验证通过 | `tests/mcp.spec.ts`:真实 Streamable HTTP 握手、14 个工具、`orchestrator_read`、`orchestrator_route` 建票。inspector CLI/GUI 未执行:本地没有可独立启动的 MCP 守护进程(需要 DSH 宿主),以官方 SDK 客户端的真实 HTTP 链路作等价验证,不宣称已跑 inspector |
| A4 | Copilot 冒烟 | **通过**(2026-11-06 实测) | Windows + VS Code Stable `1.145.2`(commit `c4453f8e…`)的官方 Copilot Chat(内置 `GitHub.copilot-chat@0.73.0`)。插件 `dsh-superagent@0.1.0` 经 `Chat: Install Plugin from Source` 以绝对路径装入并启用,三个技能可见;宿主 `tools/list` 为 14 个,`runtime`/`mcp` 均 `ready`;在 Chat 内用模型 `DeepSeek V4.1 Flash`(`deepseek-flash`)真实调用 `orchestrator_read`(tickets)、`orchestrator_route`(accept 建票 `1d2e38c4…`)、`orchestrator_reply`(被领域规则以 `notReady` 拒绝,属真实结果)。权限档位与默认模型已持久化到用户设置。Copilot CLI 与已卸载的 Insiders 均不计入。明细见 §11 |
| A5 | 回归 | 通过(Windows) | 全量 1179 通过、26 跳过、0 失败。跳过的 3 类在测试文件内写明原因:worker shim 执行、`scripts/dsh-superagent` 服务脚本、飞书消费者假 CLI 都以 `#!/bin/sh` 脚本为被测对象,Windows 无法执行;另 1 项 POSIX 权限位断言。这些对象均为**范围外**(项目只支持 Windows),保留跳过但不当作通过,也不计入待办。此前 42 项失败中的 16 项已改为跨平台实现并真实通过。真实 GitHub/飞书触发仍未执行 |
| A6 | 保活演练 | 通过(Windows 机制演练) | 用 `scripts/dsh-superagent-windows.ps1 -Action drill` 对真实 `Runtime` 宿主做启动→`taskkill /F /T`→自动拉起→管理 API 与 MCP 探针复核:首次就绪 2416ms,强杀后 30152ms 恢复,13 次重启尝试,恢复前后 `tools/list` 均为 14 个、`runtime`/`mcp` 均 `ready`。详见 §10。systemd 等 POSIX 调度为**范围外**;真实 `dsh --profile` 宿主与计划任务开机自启不在本批验收内 |

未闭合项如实保留,不以自动化结果替代人工验收。

## 9. Agent Plugins 1.0.0 符合性核对(2026-11-06)

**规范来源**:<https://agent-plugins.org/specification> 与 <https://agent-plugins.org/plugin-authors/*> 实抓;**站点发布版本 1.0.0(Status: Published)**。规范仓库 `main` 另有 `spec/1.1.0.md`(Status: Working Draft),站点未发布,本次不作为依据。技能格式按 Agent Skills 规范核对(Agent Plugins §7.1 明确引用该规范为唯一事实源)。

**Schema 来源**:官方 `https://agent-plugins.org/schemas/1.0.0/{plugin,mcp}.schema.json` 实下载;与本地 `scripts/schemas/agent-plugins-1.0.0/` 两份的 SHA256 完全一致(`plugin` `0A4AAD95…B3AB883`,`mcp` `6539175B…6D3ACB`),校验过程仍离线。

| 条款 | 要求摘要 | 仓库现状 | 结论 | 证据 |
| --- | --- | --- | --- | --- |
| §4.1(1)(2) | 插件是单一根目录;根下必需 `plugin.json` | `plugin/` 与构建产物 `lib/plugin/` 各有一份 | 符合 | `plugin/plugin.json`、`lib/plugin/plugin.json` |
| §4.1(3)(4) | 包内路径必须留在插件根内;插件相对路径以 `./` 开头 | 包内无 `../` 或绝对文件路径;`mcp.json` 无 `command`/`cwd` | 符合 | `plugin/mcp.json` |
| §4.2 | 固定位置:`plugin.json`、`skills/`、`mcp.json`、反向域名扩展目录 | 前三者齐全;未使用扩展目录(可选) | 符合 | `plugin/` 顶层仅 `plugin.json`、`mcp.json`、`skills/` |
| §5.1 | `$schema` 与 `name` 必填;`$schema` 选择完整契约 | 两者均有,`$schema` 指向 1.0.0 | 符合 | `plugin/plugin.json` |
| §5.2 | 顶层字段封闭,只允许 10 个;未知字段由客户端报告后忽略,其余违规致命 | 仅用 `$schema`/`name`/`version`/`description`/`license`/`keywords`,无未知字段。校验脚本对未知字段直接失败,属作者侧更严格 | 包符合;脚本行为严于客户端 | `scripts/validate-plugin.mjs`;负例 `unknown` 退出 1 |
| §5.3 | `name` 1–64 字符,小写字母/数字/连字符/点,首尾字母数字,禁 `--` 与 `..` | `dsh-superagent` 满足 | 符合 | `plugin/plugin.json` |
| §5.4 | `version` 可选,SemVer 推荐 | `0.1.0`,与 `package.json` 一致 | 符合 | 两文件 `version` |
| §5.5 | `author`/`homepage`/`repository`/`license`/`keywords` 类型必须正确;元数据不校验语法 | `license` 为字符串、`keywords` 为字符串数组;未写 `homepage`/`repository` | 符合 | `plugin/plugin.json` |
| §6.1/§6.2 | 固定位置发现;单个组件失效不拖累其它组件 | 组件齐全;本仓库是插件作者,不实现客户端隔离逻辑 | 不适用(客户端行为) | — |
| §7.1 | 技能只在 `skills/` 一级子目录,`SKILL.md` 必须是常规文件;禁止递归发现;无效技能单独跳过 | `plugin/skills/dsh-superagent/`;构建后 3 个一级技能;无嵌套技能 | 符合 | `plugin/skills/`、`lib/plugin/skills/`;负例 `nested` 退出 1 |
| §7.2.1 | `mcp.json` 固定在根,只允许 `$schema` 与 `mcpServers`;服务器键名自定义 | 仅这两个顶层字段;键名 `dsh-superagent` | 符合 | `plugin/mcp.json` |
| §7.2.2 | `stdio` 需 `type`+`command`;`streamable-http` 需 `type`+`url`;`sse` 已弃用;非回环必须 HTTPS,回环可用 HTTP;URL 绝对、无用户信息与片段 | 使用 `streamable-http` + `http://127.0.0.1:3083/mcp`;无 headers、无凭据;未用 stdio(可选) | 符合 | `plugin/mcp.json` |
| §9.1/§9.2 | 只定义 `PLUGIN_ROOT`、`PLUGIN_DATA`;展开仅用于 `args`/`env` 值/`cwd`,单次不递归;不得覆盖保留变量 | 包内未使用任何 `${...}` 占位符,也不存在规范外变量 | 符合(未使用) | 全仓检索 `\$\{[^}]+\}` 无命中 |
| §10.1/§10.2 | 用 `$schema` 选择规则;版本不匹配时只使 MCP 配置失效,其余组件继续 | `plugin.json` 与 `mcp.json` 均为 1.0.0,与已发布 schema 一致;构建脚本强制两者相等 | 符合 | `scripts/build-plugin.mjs`、`scripts/validate-plugin.mjs` |
| §11 | 客户端一致性要求 | 本仓库不实现 Agent Plugins 客户端 | 不适用 | — |
| Agent Skills §Frontmatter | `name`/`description` 必填;`name` 1–64、小写字母数字连字符、无 `--`、与目录同名;`description` 1–1024;可选字段类型固定 | 3 个 `SKILL.md` 均只有合规的 `name`/`description`,目录同名 | 符合 | `plugin/skills/dsh-superagent/SKILL.md`、`lib/plugin/skills/*/SKILL.md` |
| 扩展命名空间 | `extensions` 与同名顶层目录均可选;未实现该命名空间的客户端应忽略 | 未使用 | 符合(未使用) | `plugin/` 顶层目录清单 |

**结论**:插件的包结构、清单、MCP 配置、技能发现与 frontmatter 均符合 Agent Plugins 1.0.0 与 Agent Skills 规范;未发现需要改代码或改包结构的不符项。校验脚本比规范对客户端的最低行为更严格,已在 A1 与本表中注明,不据此宣称客户端一致性。A6 已按 §10 完成 Windows 机制演练并通过;A4 已在 Stable 1.145.2 内置 Copilot Chat 0.73.0 中实测通过(§11);真实 GitHub/飞书触发未执行。

## 10. A6 Windows 保活演练(2026-11-06)

### 10.1 既有机制与方案取舍

- 产品自带的 `scripts/dsh-superagent` 依赖 tmux、`ps` 与 `fcntl`,只能在 POSIX 上运行;按 §1 的支持环境,它属于**范围外**,Windows 等价物是本仓库的 PowerShell 守护脚本。`tests/service-script.spec.ts` 在 Windows 上按其被测对象(`#!/bin/sh`)跳过并注明范围外。systemd 也不再是备选方案。
- 备选方案与取舍:
  - **计划任务**:能开机自启,但需要注册任务与 XML,演练时难以在单次命令内完成启停与清理;
  - **nssm**:本机未安装,且任务要求不擅自联网安装第三方工具,排除;
  - **仓库自带 supervisor**:无额外依赖、无需管理员权限、可直接演练,选此方案。代价是它随用户会话存在,注销后停止;若要开机自启,仍需由计划任务在登录时调用 `-Action start`,本次未注册。
- 新增 `scripts/dsh-superagent-windows.ps1`(start / supervise / stop / status / drill),用隐藏的 `pwsh` 守护循环启动子进程、留存 stdout/stderr、按 1 秒延迟重启,并用停止标记区分“手动停止”与“崩溃”。子进程 PID 在强杀前会核对命令行,避免 PID 复用误杀。
- 本机没有 `dsh` 宿主,因此演练用 `scripts/keepalive-host.mjs` 启动**真实 `Runtime`**:真实 SQLite、真实管理 HTTP(`127.0.0.1:3082`)与真实 MCP(`127.0.0.1:3083/mcp`)、14 个真实工具;假 DSH 服务只替换宿主注入部分。`scripts/keepalive-probe.mjs` 用官方 SDK 客户端做 `initialize` + `tools/list`。

### 10.2 复跑命令

```powershell
pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action drill `
  -Profile host -Command 'node --experimental-transform-types scripts/keepalive-host.mjs' -TimeoutSeconds 90
```

`-Action start` / `stop` / `status` 用于日常启停;`status` 输出 JSON,退出码 0 表示守护与健康均正常。证据写入 `.artifacts/keepalive/drill-<时间戳>.json`(已 gitignore)。

2026-11-06 修复:`-Action stop` 原先只写 `manually-stopped` 标记而不清理,导致停止后再 `start` 被“存在手动停止标记”拒绝。现在子进程与守护进程全部退出后自动清标记;已实测“启动 → 探针 14 工具 → 停止 → 再次启动”可用。

### 10.3 实测结果(退出码 0)

| 观测项 | 实测值 |
| --- | --- |
| 首次就绪耗时 | 2416 ms |
| 强杀方式 | `taskkill /F /T /PID 30988`,确认进程已退出 |
| 恢复耗时(强杀→健康且探针通过) | 30152 ms |
| 自动重启尝试次数 | 13 次(每次失败后 1 秒重试) |
| 恢复前后 `tools/list` | 均为 14 个,名称一致 |
| 恢复后健康 | `runtime=ready`、`mcp=ready`;`relay`/`notice`/`launch`/`delivery`/`assessment`/`reply`/`evals`/`models`/`sync:feishu` 均 `ready` |
| 证据文件 | `.artifacts/keepalive/drill-20261106-203750.json` |
| 守护日志 | `.artifacts/logs/dsh-superagent-host-supervisor.log` |

日志逐条记录了每次子进程的 `start` / `exit code=1` / `restart scheduled`,以及最终成功拉起;失败子进程 stderr 为 `Lock file is already being held`。

### 10.4 关键发现:硬杀后的 30 秒锁窗口

`Runtime` 用 `proper-lockfile` 锁定 `stateDir`,参数为 `stale: 30_000`,存活期间每 15 秒刷新一次锁时间。进程被 `taskkill /F` 后锁目录残留,新进程立即启动会以 `Lock file is already being held` 退出;必须等到“锁 mtime + 30 秒”才可接管。因此:

- 恢复耗时下限约 15 秒、上限约 30 秒,本次为 30.1 秒,13 次重试均属预期;
- 计划内重启应先 `stop`(优雅结束,释放锁),不要用强杀;
- 不要为了缩短恢复时间擅自调小 `stale`,那属于产品行为变更,需另行决策;
- 守护脚本必须接受“启动失败后重试”,不能把一次失败当作永久故障。

### 10.5 未覆盖范围

- 真实 `dsh --profile superagent --no-open` 进程:本机未安装 DSH 宿主,未执行;
- Windows 计划任务注册与开机自启、systemd 路径:未执行;
- Copilot 客户端在重启后的重连:依赖 A4,当前未验证;
- 宿主脚本只启动 `Runtime`,未启动 Source 轮询器,故 `feishu`/`history`/`github` 在演练中为 `starting`,与本项要验证的“进程自愈 + MCP 工具面恢复”无关。

## 11. A4 冒烟盘点(2026-11-06)

### 11.1 验收口径

A4 的验证环境写死为 **Windows + VS Code Stable 的官方 Copilot / Copilot Chat**,只认其中真实发生的验证行为(插件可见、技能可见、工具可列并可调用)。

- 实测版本:VS Code Stable `1.145.2`(commit `c4453f8ea430795f941c1b2ff6c9321135a74a02`,安装根 `C:\Program Files\Microsoft VS Code`),内置 Copilot Chat `GitHub.copilot-chat@0.73.0`。2026-11-06 首次盘点时为 `1.119.0`(内置 Chat `0.47.0`),用户随后手工升级;升级后旧的 1.119.0 进程已不存在,运行中只有 1.145.2。
- VS Code Insiders:用户已手工卸载,**不纳入本次验证范围**;脚本与文档均不再探测 Insiders,不存在时也不计失败。
- Copilot CLI(`copilot --plugin-dir …`):只作前置证据单列,**不计入 A4 验收**。
- 其他编辑器与宿主:不计入。

当前状态:**通过**(2026-11-06 在 Stable 1.145.2 内实测完成插件安装、技能可见、工具列表与三个工具的真实调用)。`scripts/copilot-smoke.ps1` 仍是只读盘点脚本,其自动输出 `a4Status=client-ready-manual-pending` 表示"自动前置条件齐备",不能单独作为 A4 结论;A4 的结论以本节实测为准。

### 11.2 客户端就位情况与安装结果

| 项 | 实测 | 结论 |
| --- | --- | --- |
| VS Code Stable | `1.145.2`,commit `c4453f8e…`,安装根 `C:\Program Files\Microsoft VS Code`;`code --version` 与运行中进程一致 | 就位 |
| Copilot Chat | 内置扩展 `GitHub.copilot-chat@0.73.0`,清单在 `resources\app\extensions\copilot\package.json`,`engines ^1.145.2`;内置扩展不出现在 `code --list-extensions` | 就位,无需市场安装 |
| `GitHub.copilot` 补全扩展 | 未安装 | 非 A4 必需;插件平台由内置 Chat 提供 |
| 登录状态 | Chat 面板可正常发起会话,仅记"已登录";未读取、复制或截图任何 token/cookie | 已登录 |
| 模型 | 选择器显示 `DeepSeek V4.1 Flash`(id `deepseek-flash`,元数据标注 `0 credits`);Free 配额不再构成阻塞 | 可用 |
| 权限档位 | 界面显示 `Autopilot · Allow all`;工具调用不再逐次确认 | 生效 |
| Agent Plugins 能力 | 命令 `workbench.action.chat.installPluginFromSource`、`managePlugins` 可用 | 能力存在 |
| 插件安装 | `Chat: Install Plugin from Source` 拒绝 `file:///d:/…/lib/plugin`,原文 `Invalid plugin spec. Use: plugin-name@marketplace-name, owner/repo, or a URL`;改填绝对路径 `D:\WorkSpace\dsh-superagent-prototype\lib\plugin` 后成功,落到 `~/.copilot/installed-plugins/_direct/plugin`(`dsh-superagent@0.1.0`) | 已安装并启用 |
| 三个技能 | `dsh-superagent`、`dsh-superagent-github`、`dsh-superagent-feishu` 均可见 | 可见 |

以下为 1.119.0 时期的安装尝试,保留作历史记录(升级到 1.145.2 后不再有内置版本冲突问题):

用户授权后执行的安装命令与真实输出:

```
code --install-extension GitHub.copilot-chat --force
Installing extensions...
Updating the extension 'github.copilot-chat' to the version 0.48.1
Installing extension 'github.copilot-chat'...
Error while installing extension github.copilot-chat: Extension 'github.copilot-chat' is a built-in extension with version '0.47.0' and cannot be downgraded to version '0.45.1'.
Failed Installing Extensions: github.copilot-chat
exit=1
```

`GitHub.copilot` 同样以 1 退出(它依赖的内置 Chat 版本冲突)。结论:**不通过市场安装**,直接使用内置 Chat `0.47.0`;不需要重启 IDE。安装前后 `code --list-extensions`(共 58 项)都没有 `github.copilot` 与 `github.copilot-chat`,后者的能力由内置扩展提供。

### 11.3 自动化已完成的项(前置证据,不计入 A4)

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 只读盘点 | `pwsh -NoProfile -File scripts/copilot-smoke.ps1` | 退出 0;5 个必需项全部 ok;`a4Status=client-ready-manual-pending` |
| 插件产物 | 同上 | `lib/plugin` 为 `dsh-superagent@0.1.0` |
| 三个技能 | 同上 | `dsh-superagent`、`dsh-superagent-github`、`dsh-superagent-feishu` |
| 宿主工具面 | 启动 `scripts/keepalive-host.mjs` 后运行 `node scripts/keepalive-probe.mjs` | `{"ok":true,"tools":14,...}`;`runtime=ready`、`mcp=ready` |
| 插件包可被真实客户端读取 | `copilot --plugin-dir lib/plugin plugin list --json` | 列出 `dsh-superagent`;**CLI,不计入 A4 验收** |

以上是前置证据:它们证明包、端点与工具面可用;A4 的结论以 §11.4 与 §11.5 的 IDE 内实测为准。

同时修复 `scripts/dsh-superagent-windows.ps1` 的一个缺陷:`-Action stop` 写入的 `manually-stopped` 标记原先不会被清理,导致停止后再 `start` 一律被拒。现在进程全部退出后自动清标记;已实测"启动 → 探针 14 工具 → 停止 → 再次启动"可用。

### 11.4 IDE 内实测步骤与真实结果(2026-11-06)

以下步骤在 Windows + VS Code Stable 1.145.2 的官方 Copilot Chat 内真实执行;截图保存在 `.artifacts/screenshots/`(不提交)。

1. **装入插件**:`Ctrl+Shift+P` → `Chat: Install Plugin from Source`(命令 id `workbench.action.chat.installPluginFromSource`)。
   - 先输入 `file:///d:/WorkSpace/dsh-superagent-prototype/lib/plugin`,被拒,原文:`Invalid plugin spec. Use: plugin-name@marketplace-name, owner/repo, or a URL`。
   - 改填绝对路径 `D:\WorkSpace\dsh-superagent-prototype\lib\plugin` 后安装成功,插件位于 `~/.copilot/installed-plugins/_direct/plugin`,版本 `dsh-superagent@0.1.0`,状态启用。
   - 备选(本次未用):`chat.pluginLocations` 是**机器级**(scope `MACHINE`)设置,只能写在用户设置 `%APPDATA%\Code\User\settings.json`;写工作区 `.vscode/settings.json` 无效。
2. **登录与模型**:Chat 面板已登录(只记状态,不读凭据);模型选择器显示 `DeepSeek V4.1 Flash`(id `deepseek-flash`)。
3. **确认技能可见**:插件详情可见 `dsh-superagent`、`dsh-superagent-github`、`dsh-superagent-feishu` 三项。
4. **启动宿主**:

   ```powershell
   pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action start -Profile a4 -Command 'node --experimental-transform-types scripts/keepalive-host.mjs'
   node scripts/keepalive-probe.mjs
   ```

   实测:`{"ok":true,"tools":14,...}`,`runtime=ready`、`mcp=ready`;`feishu`/`history`/`github` 为 `starting`(宿主脚本不启动 Source 轮询器,与本项无关)。
5. **权限档位**:Chat 面板切到 `Autopilot` + `Allow all`。该选择器只改内存态,重载窗口即回落到 `Manual permissions`;持久默认见 §11.6。
6. **真实调用**(Agent 模式、允许工具):三个工具依次调用,结果见 §11.5。
7. **收尾**:`-Action stop -Profile a4` 停止宿主,随后跑 `pnpm check`。

### 11.5 三个工具的真实调用记录

| 工具 | 入参 | 实际返回/界面变化 | 证据 |
| --- | --- | --- | --- |
| `orchestrator_read` | `resource=tickets` | 返回 `{"items":[{"ticket_id":"1d2e38c416e4d7634c460ed8c481100f","title":"…","state":"working",…}]}`;首轮 `triggers` 也正常返回候选列表 | `a4-tools-chat.png` |
| `orchestrator_route` | `action=accept`,`worktree_name=verify-login-link` | 首次用 `worktree_name=a4-verify` 被拒(规则要求 1–4 个小写英文词且首段仅字母),模型原样报错后用 `verify-login-link` 成功,建票 `1d2e38c416e4d7634c460ed8c481100f`;MCP 直连复核可见该票 `state=working` | `a4-tools-chat.png`;MCP 复核 |
| `orchestrator_reply` | `purpose=result` | 被领域规则拒绝,`code=notReady`,原文"工单尚未就绪,无法交付。把进展保持在内部,等待经过验证的 ready 汇报;不要把进展标成答案,也不要通过其它渠道发送。" 工单仍为 `working/queued`,没有真实 worker 跑完;按事实记录,不重试、不改写 | `a4-tools-chat.png` |

补充观察:Chat 曾提示 `The model only supports 128 tools, 19 tools were not provided to the model`。这是当前模型声明的工具上限与客户端工具总数之差,本插件的 14 个工具均在已提供范围内(三个调用均成功),不影响 A4 结论。

### 11.6 已知环境变更与默认值(2026-11-06)

| 变更 | 事实 | 影响 |
| --- | --- | --- |
| VS Code 升级 | `1.119.0` → `1.145.2`(内置 Copilot Chat `0.47.0` → `0.73.0`);旧 1.119.0 进程已不存在 | A4 口径改为 1.145.2 |
| 用户级默认档位 | 用户设置 `%APPDATA%\Code\User\settings.json` 写入 `"chat.defaultConfiguration": { "mode": "autopilot", "approvals": "allowAll" }`(用户级、持久) | 新窗口/新会话默认 `Autopilot · Allow all`,工具调用不再逐次确认;重载窗口后复核通过 |
| 用户级默认模型 | 同一文件写入 `"chat.defaultModel": "deepseek-flash"`(用户级、持久) | 新会话默认模型为 `DeepSeek V4.1 Flash`;重载后复核通过 |
| `chat.permissions.default` | 分别写入 `autoApprove`、`autopilot` 均不生效,重载后新会话仍是 `Manual permissions`;该键在 workbench bundle 中有 schema,但运行时读取未生效 | 不使用该键,以 `chat.defaultConfiguration` 为准 |
| `team-develop-agent` 插件 | 请求卸载时它已不在 `~/.copilot/installed-plugins/_direct/`(`_direct` 下仅剩 `plugin`,即 `dsh-superagent`);`code --list-extensions` 也无该扩展 | 对 `dsh-superagent`、三个技能与 14 个工具无影响;无需重新校验 A4 关键步骤 |
| `team-develop-agent` 残留 | 仍有 `C:\Users\61054\.copilot\plugin-data\team-develop-agent` 与 `%APPDATA%\Code\agentPlugins\file-c-3A-…-direct-team-develop-agent` | **未删除**,等用户确认后再清理(AGENTS §8.2);只清理该插件自身 |
| 权限作用范围 | `chat.defaultConfiguration` 为用户级,仅影响新会话的模式与工具审批,不影响其它设置 | 无安全旁路:工具仍走 Policy/Mandate 复验,"Allow all" 只是免去客户端逐次确认 |

### 11.7 质量自查与修复(四维度,2026-11-06)

| 维度 | 发现 | 处理 |
| --- | --- | --- |
| 准确 | `worktree_name` 的描述只写"1–4 个小写英文词",未说明**第一段只能是小写字母**;A4 中模型用 `a4-verify` 被正则拒绝,只能靠报错试错 | 描述与校验错误文案都补"第一段只能是小写字母(不能含数字)";正则与规则不变,仅让模型第一次就能写对 |
| 标准 | `orchestrator_prompts_save` 的 `baseRevision` 在描述里写"必需",schema 却是可选;缺参时抛普通 `Error`,既无 `code` 也没有参数路径 | 增加对象级 `refine`:`preview=false` 且缺 `baseRevision` 时在参数校验阶段拒绝,提示"先用 orchestrator_read prompts 读取当前修订";直接调用 `execute` 的兜底文案同步改写 |
| 交互 | `orchestrator_reply` 的 `ticket_id` 没有描述,模型难以判断与 `trigger_id` 的分工 | 补描述:除 `answer` 外的回复用 `ticket_id`,`answer` 用 `trigger_id` 点名原始问题 |
| 简洁 | 14 个工具无重复职责:`orchestrator_route` 已是一次多决策入口,`orchestrator_eval_*`(主动候选)与 `orchestrator_ticket_*`(工单生命周期)语义不同 | 不合并、不增删工具与参数;仅改文案与 schema 校验,对外契约(名称/参数/枚举/返回)不变 |

验证:`pnpm check` 退出 0——1179 通过、26 跳过(范围外)、0 失败;`plugin/` 与 `lib/plugin/` 两处校验通过;`tests/mcp.spec.ts` 的 14 工具与 `tools/list` 契约断言未改。

