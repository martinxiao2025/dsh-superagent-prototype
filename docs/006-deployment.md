# 006 部署

本指南用于安装、配置与运维 dsh-superagent，涵盖账号、启动检查、升级与排障，并承接 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md)。

> **支持环境（2026-11-06 用户确认）**：Windows + VS Code Stable 的官方 Copilot / Copilot Chat。本文中的 POSIX 命令、`#!/bin/sh` 包装器、tmux 与 `scripts/dsh-superagent` 仅描述既有产品行为，属**范围外**；Windows 上的启停请用 `scripts/dsh-superagent-windows.ps1`。

## 运行内容

- **一个独立运行的编排进程**（`node lib/index.js --config <机器配置文件>`）。它在 `127.0.0.1` 上同时提供面板网页与 MCP 端点，状态放在机器配置的 `stateDir` 中。请给它一个专门的运行账号或至少专门的进程：它会修改自身进程的 `PATH` 与 git 设置，并需要独立重启与升级。
- **一个代理 GitHub 账号。** 代理以该账号发表评论、推送分支并创建拉取请求，方式是使用一个只以该账号登录的 GitHub CLI。
- **可选项：** 一个用于聊天请求的飞书机器人。

插件配置保存状态目录与机器限额。其余一切都通过面板完成：仓库与账号在 Sources，允许列表在 Policy，工作进程目录与命令在 Execution。

### 权限与隔离

进程内有两个角色：主会话（持有 14 个编排工具，负责评估、路由与回复）与每个工单一个 worker 会话。两者都经 `AgentHost` 运行，本仓库的实现是 VS Code 语言模型桥（`extension/dsh-lm-bridge`）：Runtime 通过只绑 `127.0.0.1` 的回合接口把提示词与工具交给 VS Code 的 `vscode.lm`。

两种角色都以操作者操作系统用户的身份运行，并从已订阅的 Thread 读取消息。账号包装器默认选择代理的凭证；它们并不隔离进程。worker 可以按路径执行程序，并读取操作者的主目录。如需隔离，请使用一个仅包含代理凭证的专用操作系统账号。

## 前置条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+
- GitHub CLI（`gh`）2.48 或更高版本。Source 的 CLI 字段必须指向 `gh` 或 `lark-cli` 包装器；编排器依赖它们的子命令与输出格式。
- 一个位于 github.com 上的仓库；不支持 GitHub Enterprise Server。若要为每个工单创建一份检出，请保留一个本地克隆，prepare 命令可以据此添加工作树。如果该仓库使用 Git LFS，请安装 `git-lfs`。
- VS Code Stable 并已登录有语言模型权限的账号（`extension/dsh-lm-bridge` 提供模型）。除非 Eval 或 Execution 设置指定了其他模型，dsh-superagent 使用 VS Code 中选中的模型。
- 使用飞书时：`lark-cli`（已在 1.0.90 上测试）以及一个带机器人的飞书或 Lark 应用

## 账号

### 代理 GitHub 账号

1. 为代理创建一个 GitHub 用户账号，并授予它对仓库的写权限。GitHub App 不能充当代理，因为 dsh-superagent 会读取该账号的通知。
2. 为它提供一个只使用自身凭证的 GitHub CLI：

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   以代理账号登录；最后一条命令会打印它的 login。dsh-superagent 也以同样的方式读取该 login。

### 飞书机器人（可选）

1. 创建一个具备机器人能力的自建应用。授予它接收消息事件、读取与发送聊天消息、读取聊天成员的权限，然后发布该应用版本。
2. 给该机器人一份自己的 `lark-cli` 配置（限定为机器人身份）以及一个包装器：

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   第一条命令从标准输入读取应用密钥。请使用独立的配置目录：`lark-cli` 对每个 app id 只允许一个 profile，而你的个人配置里可能已经包含该应用的用户登录。

   宿主会拒绝能够以用户身份操作的 CLI。它会从机器人配置中读取 app id、飞书/Lark 品牌以及机器人的 `open_id`。

   两份配置共享应用密钥的同一条钥匙串条目。若要只移除机器人配置，请删除它的目录；不要运行 `lark-cli config remove`，那会影响共享的密钥。

## 安装

```sh
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
```

`pnpm build` 先用 tsdown 生成 `lib/`，再用 `scripts/build-plugin.mjs` 组装 `lib/plugin/`。运行入口是 `lib/index.js`。

## 机器配置

机器配置是一个 JSON 文件，默认 `~/.dsh-superagent/config.json`，可用 `--config` 或环境变量 `DSH_SUPERAGENT_CONFIG` 指定。最小内容：

```json
{ "stateDir": "C:\\Users\\me\\.dsh-superagent", "panelPort": 3082, "mcpPort": 3083 }
```

| 键 | 必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁文件、`worker-bin` 中的命令 shim、代理的 git 配置，以及默认情况下 `work` 中的工单目录。升级前请备份 |
| `panelPort` | 否 | 面板网页的端口，默认 `3082`；`0` 表示由系统挑选 |
| `host` | 否 | 面板与 MCP 端点的回环主机名，只允许 `127.0.0.1`（默认）或 `localhost` |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | 否 | 保存的提示词配置的最大长度，以及一次评估在多长时间内读取多少个 Thread 页 |
| `mcpEnabled`, `mcpPort` | 否 | 供 agent-plugins 客户端使用的回环 MCP 端点是否运行，以及运行在哪个端口（默认 `3083`；`0` 表示为测试挑一个空闲端口）。两者都需要重启；请让 `plugin/mcp.json` 指向同一个端口 |
| `model` | 否 | 语言模型桥使用的模型 id；缺省使用 VS Code 里选中的模型 |

面板的 **Settings → Deployment** 可以修改除 `stateDir`、`panelPort` 外的限额，保存后无需重启（`mcpEnabled` 与 `mcpPort` 除外）。无效的值或未知的配置键会导致启动失败；日志会指明是哪个键。

## 启动与停止

直接运行产品入口（前台，Ctrl+C 优雅退出）：

```powershell
node lib/index.js --config C:\Users\me\.dsh-superagent\config.json
```

Windows 上推荐用仓库自带的守护脚本，它不依赖第三方服务包装器，也不需要管理员权限：

```powershell
pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action start
pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action status
pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action stop
```

- `start` 以隐藏的 `pwsh` 守护循环启动 `node lib/index.js --config <Config>`，等待健康就绪；`-Command` 可替换被测命令，`-Config`、`-Profile`、`-Url` 也可由 `DSH_SUPERAGENT_CONFIG`、`DSH_SUPERAGENT_PROFILE`、`DSH_SUPERAGENT_URL` 提供。
- 子进程的 stdout/stderr 写到 `.artifacts/logs/dsh-superagent-<profile>-<date>-<time>-<pid>.{out,err}.log`，守护事件写到 `...-supervisor.log`；控制文件在 `.artifacts/control/windows/<profile>/`。
- 崩溃后按 1 秒延迟自动拉起，重启次数写入 `restarts.count`；`stop` 写停止标记并结束整棵进程树，`start` 清除标记。强杀会在 `stateDir` 留下锁，需等 `stale=30s` 才可接管，因此恢复约需 15–30 秒；计划内重启请用 `stop` 再 `start`。
- 该守护随用户会话存在，注销后停止；需要开机自启时，用计划任务在登录时调用 `-Action start`。本仓库未注册计划任务。
- `status` 输出守护进程、子进程、重启次数、健康状态与安装问题的 JSON，运行时就绪时退出 0，否则退出 1。
- 强制终止演练：`pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action drill`，它启动、强杀整棵进程树、等待自动拉起并用管理 API 与 MCP 探针确认恢复，证据写入 `.artifacts/keepalive/`。

打开日志中打印的 URL（默认 `http://127.0.0.1:3082`）即为面板网页。

### 每小时检查

请把这套检查放在一个**独立于代理进程**的地方，例如另一个终端里的计划任务或你自己的代理会话；它必须在代理服务停止时仍能运行：

```text
运行 `pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action status` 并读它的 JSON：supervisor 与 health.runtime.state 都正常时什么都不做、也不说话；manuallyStopped 为 true 时保持停止；health 中有条目为 error 时汇报该条目与它的 detail，除非已经说过同一条；否则调用 `-Action start`（它会清掉停止标记并重新拉起），成功后不说话，仍失败则读 .artifacts/logs 下最新的日志与 docs/006-deployment.md 的排障一节，能修就修，并告诉我原因与所做改动。
```

## 设置

安装检查必须先成功，轮询或工作才能开始。概览会列出缺失的要求，并链接到相应设置。改动设置会重新运行安装检查。如果你在应用之外修好了某件事，例如 CLI 认证，请选择 **Check again**。

1. **Sources。** 设置 GitHub 仓库（`owner/name`）与代理 CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常通过代理账号的通知到达。新的 Issue 或提到该账号的评论会在下一次轮询时到达；通过编辑已有 Issue 正文来添加提及则不会。请改为发表一条新评论。使用飞书时，设置机器人 CLI、聊天、每个聊天的“接收全部”或“仅接收提及”模式，以及是否接收私信。
2. **Policy。** 两条示例规则可以编辑或删除。在 **On each Source** 下，添加可以请求工作的 GitHub 账号与飞书用户；在某个列表中有第一个人之前，任何请求都无法变成工单。使用飞书时，可以选择一个聊天，在启动时以及点 **Sync now** 时从它同步该列表。
3. **Execution。** 目录根与一个 prepare 命令。若要为每个工单提供该仓库的一份检出：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   把你的个人 CLI（例如登录到你本人账号的那个）列为被阻止的命令。
4. **Prompts。** 设置团队相关段落：GitHub 披露声明、评审机器人、提交作者以及自动合并条件。

### VS Code 扩展通知

语言模型桥扩展带一个可选的主动提醒，用来告诉人“有工单在等你”。它由扩展自己的两个 VS Code 设置决定，Runtime 不读它们：

| 设置键 | 默认值 | 谁读它 | 行为 |
| --- | --- | --- | --- |
| `dsh.superagent.notify` | `false`（不打扰） | `extension/dsh-lm-bridge/notify.js` 与 `extension.js` | 关闭时**不发起任何轮询**，也没有提醒；开启后每 60 秒请求一次本机面板的 `GET /orchestrator/api/overview` |
| `dsh.superagent.panelUrl` | `http://127.0.0.1:3082` | 同上 | 轮询与“打开面板”按钮使用的地址；只接受回环 `http`，非回环地址会被拒绝并写日志 |

提醒规则只有三条：首次轮询只建立基线，不把已有的积压当成新工作；之后只有出现此前没见过的“等待人工处理”工单才弹一次提醒；工单离开该列表后再次进入会重新提醒。提醒里最多列出三个标题，附一个「打开面板」按钮。失败（面板未启动、端口不对）只写扩展输出面板的日志，不影响模型桥与回合。

### 管理 API

面板网页使用一个本地 HTTP API，代理也可以调用它。`SETUP.md` 用它保存设置，Windows 守护脚本则读取 `GET state`。

把请求发到 `http://127.0.0.1:<port>/orchestrator/api/`，并带上 `x-orchestrator-request: 1`。主机必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少请求头，或 `Origin` 来自其他站点，都会收到 403。

通过 API 保存与在面板中保存具有相同权限。与通过主会话工具做的保存不同，它们可以修改执行环境与安装检查的账号字段。

代理可以依赖下列路由与字段。`src/app/api.ts` 中的其他路由服务于面板，并随面板变化。

| 请求 | 响应 |
| --- | --- |
| `GET state` | 每个页面读取的内容：`setup`，含 `problem` 与 `feishuProblem`，各自为 `null` 或一个安装检查问题（带 `place`、`code`、`values` 与 `detail`），以及安装检查解析之后的 `accounts`；`health`，每个部分一个条目（见下文），带 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail` 与 `at`；`load`，即 Executor 会话的 `running`、工单的 `queued` 与 `maxWorkers`；`paused`；以及 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval` 与 `executor`，各自带 `value` 与 `revision`；`sources`：各 Source 实例，每个带 `id`、`kind`、`installed`、其块的 `value`（`{"enabled": …, "config": {…}}`）与 `revision`、其类型对应的表单，以及（存在时）它的安装检查 `problem`；`policyVersion`；以及 `environment`，即执行环境的 `root` 与 `variables` |
| `GET sources` | 每个 Source 的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、其各部分的 `health`、它的安装检查 `problem`、最近一天的 `stats`、该日内它 `filtered` 掉的 Trigger，以及该日内它 `dropped` 的消息（最新的丢在前，每条带 `channel`、`preview`、若属于某个工单则带 `ticket`（`id` 与 `title`）、若存储中存在则带 `thread`，以及 `dropped.at` 与 `dropped.reason`，即 `channelGone` 或 `channelIgnored`） |
| `PUT settings/<block>`，带上 `{"value": …, "revision": n}` | 保存一个块：`saved`、该块新的 `revision`、`policy_changed` 与 `restarting`。`value` 是整个块，与 `GET settings` 持有的形式一致；缺失的键取其默认值 |
| `POST executor/pause`，带上 `{"paused": true}` 或 `false` | 暂停或恢复处理：`paused` |
| `POST setup/check` | 通过重启 dsh-superagent 再次运行安装检查：`restarting: true`。当安装检查无内容可修时被拒绝 |
| `POST policy-sync/<source id>` | 立即同步该 Source 的允许列表：`policy`，即该 Source 部分按保存的形式 |
| `GET prompts`、`PUT prompts`，带上 `{"config", "baseRevision"}` | 读取提示词配置：`current`，带其 `revision` 与 `config`；`defaults`；`sections`，即会话读取顺序下的团队段落；`skillName`，即团队技能名的模式；`builtin`，即团队技能不能使用的名称；以及 `skillPrefix`，即会话加载技能名时所加的前缀。或者保存它：返回新的 `revision` |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 重试或停止一个工单，与面板所做的相同 |

健康条目按职责分组：

| 条目 | 报告内容 |
| --- | --- |
| `runtime` | 应用自身 |
| `models` | 主会话回合失败；下一次成功回合后恢复 |
| `evals` | 最近一小时内不可用、且其后没有判定或驳回的 Eval |
| `assessment`、`launch`、`delivery`、`relay`、`notice`、`reply` | [003 执行](003-execution.md) 中描述的已存储工作；delivery 统计等待中的工作，reply 则涵盖 Channel 消息 |
| `worker` | Executor 会话的事件处理；首次失败后才出现 |
| `github`、`feishu`、`history` | Source 轮询、事件与历史恢复 |
| `sync:<source id>` | 允许列表同步 |

拒绝响应带有一个状态码与 `error`，即其英文原文：

- 400：无效的值（`issues`，每条带其 `path`）、账号检查失败（`setup`）、固定拒绝（`code` 与 `values`），或请求体不是 JSON 或过大。
- 404：不存在的内容。
- 409：过期的 revision。
- 500：其他任何情况。

各个块：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 的配置有 `repository` 与 `cli`，以及开关 `observeIssues`、`observePulls`、`observeComments` 与 `observeCi`（默认关闭），它们接收仓库中每个新 Issue、新拉取请求与评论，以及默认分支的 CI；飞书的配置有 `cli`、形如 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` 的 `chats`（或 `"all"`）、`directMessages`，以及取值为 `"none"` 或 `"mentions"` 的 `otherChats`。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出那些消息可以成为推断候选者的机器人。`admission` 的一行以聊天 id 为键，飞书用 `other` 或 `direct`，GitHub 用 `issues`、`pulls`、`comments` 或 `ci`；未设置的单元格取其默认值（见 [002 授权](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 与 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 与 `blockedCommands`。处理的暂停是它自己的一个设置项 `paused`，由 `POST executor/pause` 设置。

修改仓库或 CLI 会先运行相应的安装检查。检查失败会返回 400，详情在 `setup` 中。账号修改成功，或在安装检查待处理期间做任何保存，都会返回 `restarting: true`。应用重启期间 API 暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## 安装检查

安装检查通过与 worker 相同的子进程通道执行，并移除名称中含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

安装检查会核实 GitHub 仓库与代理的推送权限，写入工作进程环境，并检查 git 对 github.com 只使用代理凭证。飞书的安装检查失败只会禁用飞书 Source。

安装检查写入的进程环境：

- **命令 shim**：位于 `<stateDir>/worker-bin`，在 `PATH` 中最靠前：`gh` 运行代理的 CLI；`lark-cli` 运行机器人的 CLI；被阻止的命令会失败。shim 在运行其目标之前，会把自己所在的目录从 `PATH` 中移除。
- **git 配置**：位于 `<stateDir>/worker-gitconfig`：取代操作者的全局与系统 git 配置。它把代理 CLI 选为 github.com 的凭证 helper，把 GitHub 的 SSH 地址改写为 HTTPS，并定义 Git LFS 过滤器。诸如 HTTP 代理之类的个人 git 设置不会生效。这里不设置提交身份，git 从不提示输入凭证，且 `GH_TOKEN` 与 `GITHUB_TOKEN` 会被移除。

`worker-bin` 或 `worker-gitconfig` 中不是由 dsh-superagent 写入的文件会中止安装检查。工单目录位于某个 git 仓库内，而该仓库自身的配置添加了凭证时，该工单会失败。

## 试用

用一个被允许的 GitHub 账号提交一个 Issue，或发表一条包含 `@<agent login> <request>` 的评论。在一个轮询周期内（默认一分钟），概览应显示一个工单。代理会确认该请求，在它自己的会话与目录中工作，并在原对话中交付结果。使用飞书时，在已配置的聊天中提及该机器人。

## 升级

1. 等到没有 Executor 正在一轮处理当中。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent-windows.ps1 -Action stop` 再 `-Action start`，并检查其状态。

重启会结束正在运行的分配，并以恢复说明启动替代者。团队文本与被覆盖的提示词片段会保留；没有覆盖的片段则跟随新的默认值。升级后请检查标记为 **Default updated** 的片段。

由较新版本迁移过的数据库无法被较旧版本打开。因此回滚需要升级前的备份。升级 VS Code 或语言模型桥扩展本身之后，请重启正在运行的实例，以便重新连接桥的发现文件。

## 排障

安装检查问题会以面板语言显示在概览上，并附修复链接；日志与 API 则显示下文的中文原文。

| 现象 | 原因与修复 |
| --- | --- |
| `未设置 agent 的 GitHub CLI。` | 在 GitHub 卡片上设置代理的 CLI |
| `未找到 agent 的 GitHub CLI。` | 设置包装器的绝对路径，或 `PATH` 上的某个命令名 |
| `agent 的 GitHub CLI 无法读取其账号` | 用 `auth login` 登录该包装器 |
| `@… 无法读取 …` 或 `@… 无法推送 …` | 授予代理账号对该仓库的写权限 |
| `GitHub Source 没有指定仓库。` | 在 GitHub 卡片上设置仓库，格式为 `owner/name` |
| 工单失败并报 `prepare 命令失败：…` | 输出会指明原因，例如克隆路径错误；修正该命令后重试该工单 |
| `git 不会读取 dsh-superagent 写入的 github.com 凭证配置` | 安装 git 2.32 或更高版本 |
| 工单失败并报 `位于 … 的仓库 git 配置设置了 …` | 从该克隆的 `.git/config` 中移除所指的凭证或 `http.*.extraheader` 设置 |
| `… 不是由 dsh-superagent 写入的` | 把所指文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或改选另一个 `stateDir` |
| `机器人 lark-cli 允许用户身份` | 让飞书 Source 指向仅机器人身份的配置，如上面的“飞书机器人”所述 |
| `机器人 lark-cli 无法工作。` 或 `应用 … 的机器人身份状态为 …` | 检查该配置的 app id 与密钥 |
| `飞书机器人不在该群中。` | 在该聊天的设置中把机器人加入聊天；下一次尝试即会成功 |
| `status` 以 1 退出 | 守护进程未运行、运行了两份、无响应，或其运行时报告错误；输出与最新日志会说明是哪一种 |
| `… 在 90 秒后超时`、`… 被 … 停止`、`… 退出码为 …` 或 `… 无法运行：…` | 某个 CLI 失败但没有打印原因；以操作者用户手动运行所指程序，查看它自己的消息 |
| 面板提示 dsh-superagent 无响应 | 它正在重启，或因配置问题没有启动；`.artifacts/logs` 下最新的日志会指明原因 |
| `dsh-superagent 的配置包含它不使用的键`（日志） | 移除所指的键；消息会说明每个值现在位于何处 |
| 工单停在 `working` 不动，`worker` 健康为 error | 语言模型桥不可用：确认 VS Code 已打开工作区、`dsh-lm-bridge` 扩展已启用，并重启实例重新连接发现文件 |
| 模型回合报 `no model` 或 `模型不可用` | 在 VS Code 中选择一个可用的模型，或在机器配置里设置 `model` |
| 提及之后没有任何反应 | 检查作者是否在该 Source 的允许列表中、该 Source 是否开启、处理是否未被暂停。在 GitHub 上，通过编辑 Issue 正文添加的提及不会被接收；请在评论中提及代理 |
