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
- Windows:用本仓库的 `scripts/dsh-superagent-windows.ps1 -Action start`(无第三方依赖,start/stop/status/supervise);需要开机自启时,由计划任务在登录时调用同一条命令。演练与实测见 §10;
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
| A4 | Copilot 冒烟 | 未通过(客户端缺失) | 本机 VS Code stable `1.119.0` 与 Insiders `1.144.0-insider` 均未安装官方 `GitHub.copilot` / `GitHub.copilot-chat`;只有第三方聊天扩展。Copilot CLI `1.0.103` 存在且能加载本插件,但 CLI 不等价于 VS Code Copilot,故不标为通过。盘点与可执行清单见 §11 |
| A5 | 回归 | 通过(Windows) | 全量 1179 通过、26 跳过、0 失败。跳过的 3 类在测试文件内写明原因:worker shim 执行、`scripts/dsh-superagent` 服务脚本、飞书消费者假 CLI 都以 `#!/bin/sh` 脚本为被测对象,Windows 无法执行;另 1 项 POSIX 权限位断言。此前 42 项失败中的 16 项已改为跨平台实现并真实通过。真实 GitHub/飞书触发仍未执行 |
| A6 | 保活演练 | 通过(Windows 机制演练) | 用 `scripts/dsh-superagent-windows.ps1 -Action drill` 对真实 `Runtime` 宿主做启动→`taskkill /F /T`→自动拉起→管理 API 与 MCP 探针复核:首次就绪 2416ms,强杀后 30152ms 恢复,13 次重启尝试,恢复前后 `tools/list` 均为 14 个、`runtime`/`mcp` 均 `ready`。详见 §10。真实 `dsh --profile` 宿主与计划任务长期部署仍未验证 |

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

**结论**:插件的包结构、清单、MCP 配置、技能发现与 frontmatter 均符合 Agent Plugins 1.0.0 与 Agent Skills 规范;未发现需要改代码或改包结构的不符项。校验脚本比规范对客户端的最低行为更严格,已在 A1 与本表中注明,不据此宣称客户端一致性。A6 已按 §10 完成 Windows 机制演练并通过;A4 仍因官方 Copilot 客户端缺失而未通过(§11);真实 GitHub/飞书触发未执行。

## 10. A6 Windows 保活演练(2026-11-06)

### 10.1 既有机制与方案取舍

- 产品自带的 `scripts/dsh-superagent` 依赖 tmux、`ps` 与 `fcntl`,只能在 POSIX 上运行;`tests/service-script.spec.ts` 在 Windows 上按其被测对象(`#!/bin/sh`)跳过。文档原先的保活建议是 systemd 或 Windows 计划任务,但本机没有部署过任何守护。
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

## 11. A4 冒烟前置盘点(2026-11-06)

### 11.1 环境实测

| 项 | 实测 | 结论 |
| --- | --- | --- |
| VS Code stable | `1.119.0` | 已安装;未安装官方 `GitHub.copilot` 与 `GitHub.copilot-chat` |
| VS Code Insiders | `1.144.0-insider` | 已安装;同样没有官方 Copilot 扩展,只有第三方 `ltmoerdani.zai-copilot-chat@0.7.0`、`vizards.deepseek-v4-for-copilot@0.9.5` |
| Copilot CLI | `GitHub Copilot CLI 1.0.103` | 已安装;`~/.copilot/config.json` 存在,`copilot plugin list --json` 与 `copilot mcp list --json` 均退出 0。未读取任何 token/密钥内容 |
| 插件包加载 | `copilot --plugin-dir lib/plugin plugin list --json` | 能列出 `dsh-superagent`,说明包结构与清单可被真实客户端读取 |
| MCP 端点 | 盘点时未启动 | 需要先运行守护脚本 |

与 `docs/010-runtime-verification.md` 记录的 `1.145.1` 不同,本次实测 stable 为 `1.119.0`、Insiders 为 `1.144.0-insider`;差异如实记录,不改写旧记录。

### 11.2 结论

**A4 未通过,原因是客户端缺失,不是代码或清单问题。** VS Code 侧没有官方 Copilot Chat,无法验证“插件出现在 Copilot 中、工具可被模型调用”;Copilot CLI 能加载插件只是等价前置证据,不能替代 VS Code 冒烟。

### 11.3 可执行清单与自动化

```powershell
pwsh -NoProfile -File scripts/copilot-smoke.ps1
# 只读盘点;当前因官方扩展缺失以 1 退出

pwsh -NoProfile -File scripts/copilot-smoke.ps1 -Editor insiders -Install
# 显式安装 GitHub.copilot 与 GitHub.copilot-chat,需要联网与有效订阅

pwsh -NoProfile -File scripts/copilot-smoke.ps1 -RunModel
# 额外做一次真实模型非交互冒烟,会消耗配额
```

需要用户动手的最小步骤:

1. 在目标 VS Code(Stable 或 Insiders)安装官方 `GitHub.copilot` 与 `GitHub.copilot-chat`,并登录有 Copilot 权限的账号;
2. 按客户端文档启用 `lib/plugin` 作为 agent plugin,确认插件与三个技能可见;
3. 先运行 `scripts/dsh-superagent-windows.ps1 -Action start`,再在 Copilot 中确认 14 个工具出现;
4. 依次调用 `orchestrator_read`(tickets)、`orchestrator_route`、`orchestrator_reply`,记录返回;
5. 把插件页与工具调用截图放到 `.artifacts/screenshots/`(不提交),作为 A4 的人工证据。

除第 1、2、5 步必须由用户在客户端完成外,其余步骤已可由脚本或 MCP 探针自动复核;在官方扩展安装并登录前,A4 保持“未通过(客户端缺失)”。
