# 006 部署

本指南用于安装、配置与运维 dsh-superagent，涵盖账号、启动检查、升级与排障，并承接 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md)。

## 运行内容

- **一个专用的 DeepSeek Harness 配置档案**，本指南中称为 `superagent`。请从 Web 档案模板创建它。它加载本 bundle，并在 `127.0.0.1` 上提供其面板。请把它与你日常工作的档案分开：本插件会修改进程级的 `PATH` 与 git 设置，而且它的进程需要独立重启与升级。
- **一个代理 GitHub 账号。** 代理以该账号发表评论、推送分支并创建拉取请求，方式是使用一个只以该账号登录的 GitHub CLI。
- **可选项：** 一个用于聊天请求的飞书机器人。

插件配置保存状态目录与机器限额。其余一切都通过面板完成：仓库与账号在 Sources，允许列表在 Policy，工作进程目录与命令在 Execution。

### 权限与隔离

本 bundle 为 Executor 定义了 `dsh-superagent-worker`，为主会话定义了 `dsh-superagent-router`。它们会出现在 DeepSeek Harness 的预设列表中，但仅供 dsh-superagent 使用。请不要把它们选用于个人会话，也不要禁用它们的配置行。应用需要它们来创建与恢复自己的会话。

在 Web UI 中打开一个空白的托管会话，可能会选中该档案的默认预设。dsh-superagent 会在第一轮之前恢复其按角色区分的预设。

两个预设都以操作者操作系统用户的身份、在 `danger-full-access` 下运行，并从已订阅的 Thread 读取消息。账号包装器默认选择代理的凭证；它们并不隔离进程。工作进程可以按路径执行程序，并读取操作者的主目录。如需隔离，请使用一个仅包含代理凭证的专用操作系统账号。

## 前置条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+、Python 3.8+ 以及 tmux
- GitHub CLI（`gh`）2.48 或更高版本。Source 的 CLI 字段必须指向 `gh` 或 `lark-cli` 包装器；宿主依赖它们的子命令与输出格式。
- 一个位于 github.com 上的仓库；不支持 GitHub Enterprise Server。若要为每个工单创建一份检出，请保留一个本地克隆，prepare 命令可以据此添加工作树。如果该仓库使用 Git LFS，请安装 `git-lfs`。
- 一个为 DeepSeek Harness 配置好的模型提供方。除非 Eval 或 Execution 设置指定了其他模型，dsh-superagent 使用该档案的默认模型。
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

在一台还没有 `superagent` 档案的机器上，执行一次下面这段内容：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上面锁定的版本是公开版本；其他版本必须满足 `package.json` 中的 `engines.dsh`。

第四条命令会依据 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条命令安装本 bundle。设置 `DSH_HOME` 可以改变默认的 `~/.dsh` 目录位置。

只在全新安装时执行创建档案的命令。如果该档案已存在，那条命令会替换它并删除它的 `cordis.patch.yml`，其中包含机器配置。升级时不要使用它。

## 机器配置

把 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，替换该文件，并替换其中每一个 `<placeholder>`。使用飞书时，还要在那里启用 `dsh-superagent-feishu` 条目。`webserver` 条目设置面板的端口。

| 键 | 必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁文件、`worker-bin` 中的命令 shim、代理的 git 配置，以及默认情况下 `work` 中的工单目录。升级前请备份 |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | 否 | 保存的提示词配置的最大长度，以及一次评估在多长时间内读取多少个 Thread 页 |
| `mcpEnabled`, `mcpPort` | 否 | 供 agent-plugins 客户端使用的回环 MCP 端点是否运行，以及运行在哪个端口（默认 `3083`；`0` 表示为测试挑一个空闲端口）。两者都需要重启；请让 `plugin/mcp.json` 指向同一个端口 |

首次启动后，在 **Settings → Deployment** 或 DeepSeek Harness Plugin Manager 中修改机器限额。更改无需重启即可生效，但 `mcpEnabled` 与 `mcpPort` 除外。`stateDir` 无法在那里修改。无效的值或未知的配置键会导致启动失败；日志会指明是哪个键。

## 启动与停止

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` 在 tmux 会话 `dsh-superagent`（若是其他档案则为 `dsh-<profile>`）中运行 `dsh --profile superagent`。它最多等待一分钟，等运行时进入就绪状态或报告某项安装要求。首次运行时它会打印缺失的安装信息。它会拒绝重复实例，包括在本脚本之外启动的实例。

`stop` 与 `restart` 请求优雅关闭，并为 Executor 最多等待五分钟。它们从不强制杀死进程，也不会触碰其他 tmux 会话。

`status` 打印进程 id、健康状态与安装问题。若要使用其他档案或端口，请用 `--profile` 与 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 与 `DSH_SUPERAGENT_URL`。

`status`、`start` 与 `restart` 以四种退出码之一退出：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 它未运行、运行了两份、无响应，或其运行时报告错误；重启可能修复 |
| 2 | 它在运行，但运行时之外的某一部分报告错误，例如某个 Source 或某个 Policy 同步（`sync:<source id>`）；重启无法修复 |
| 3 | 它在运行并等待安装检查；重启无法修复 |

仍在启动中的 Source 视为正常运行。安装检查无法检查的飞书机器人同样如此。

`status` 在 `errors` 下返回失败的部分及其详情，在 `setup` 下返回安装要求。`start` 与 `restart` 以多行形式打印这些问题；如果服务始终没起来，它们以 1 退出。只有主动执行的 `stop` 才会暂停自动恢复。

每个档案都把日志与控制文件存放在 `.artifacts/` 下：

- 启动日志：`dsh-superagent-<profile>-<date>-<time>-<pid>.log`，其中 pid 属于该脚本。只保留最新的 20 份。
- 控制文件：`control/profiles/<profile>/`，包含停止标记、锁与进程 id。

打开日志中打印的 URL，然后在侧边栏中选择 **Superagent**。

### 每小时检查

请在你日常使用的 DeepSeek Harness 档案中创建这个每小时检查，而不要创建在 `superagent` 里。它必须在代理服务停止时仍持续运行。在该档案中让一个代理用下面这段提示词创建每小时计划，并把检出路径填进去：

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` 会保留主动执行的停止。只有 `stop` 会写入该标记；`start` 会清除它。`restart` 不写标记，因此该检查可以恢复一次关闭超时的重启。

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

### 管理 API

面板使用一个本地 HTTP API，代理也可以调用它。`SETUP.md` 用它保存设置，服务脚本则读取 `GET state`。

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
| `models` | 正在等待模型预算重试的会话 |
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

安装检查使用 DeepSeek Harness 的子进程服务，与工作进程的 shell 相同。它会移除名称中含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

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
4. 运行 `scripts/dsh-superagent restart` 并检查其状态。

重启会结束正在运行的分配，并以恢复说明启动替代者。团队文本与被覆盖的提示词片段会保留；没有覆盖的片段则跟随新的默认值。升级后请检查标记为 **Default updated** 的片段。

由较新版本迁移过的数据库无法被较旧版本打开。因此回滚需要升级前的备份。升级 DeepSeek Harness 本身之后，请重启正在运行的实例，以便面板加载匹配的产物。

### 代理预设

工作进程与路由预设会在 5 秒后把 shell 命令移到后台。会话缺少其预设就无法加载。在这些会话使用期间，请把 `dsh-superagent-worker` 与 `dsh-superagent-router` 两行保留在 `cordis.patch.yml` 中；否则恢复会以 `agent-preset/not-found` 失败。

## 排障

安装检查问题会以面板语言显示在概览上，并附修复链接；日志与 API 则显示下文的英文原文。

| 现象 | 原因与修复 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上设置代理的 CLI |
| `The agent GitHub CLI was not found.` | 设置包装器的绝对路径，或 `PATH` 上的某个命令名 |
| `The agent GitHub CLI cannot read its account` | 用 `auth login` 登录该包装器 |
| `@… cannot read …` 或 `@… cannot push to …` | 授予代理账号对该仓库的写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上设置仓库，格式为 `owner/name` |
| 工单失败并报 `The prepare command failed: …` | 输出会指明原因，例如克隆路径错误；修正该命令后重试该工单 |
| `git does not read the github.com credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
| 工单失败并报 `The git configuration of the repository in … sets …` | 从该克隆的 `.git/config` 中移除所指的凭证或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent` | 把所指文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或改选另一个 `stateDir` |
| `The bot lark-cli allows user identities` | 让飞书 Source 指向仅机器人身份的配置，如上面的“飞书机器人”所述 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查该配置的 app id 与密钥 |
| `The Feishu bot is not a member of the chat.` | 在该聊天的设置中把机器人加入聊天；下一次尝试即会成功 |
| `status` 以 2 退出 | 某一部分报告错误，重启无法修复：`errors` 会列出每个部分（如“管理 API”下所列）及其详情；各部分恢复工作后会自行清除自己的条目 |
| `status` 以 3 退出 | 安装检查在等待：`setup` 说明缺少什么，概览会链接到可修复该问题的设置 |
| `status` 以 1 退出 | 服务未运行、运行了两份、无响应，或其运行时报告错误；输出与最新日志会说明是哪一种 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | 某个 CLI 失败但没有打印原因；以操作者用户手动运行所指程序，查看它自己的消息 |
| 面板提示 dsh-superagent 无响应 | 它正在重启，或因配置问题没有启动；DeepSeek Harness 的日志会指明原因 |
| `dsh-superagent configuration has keys it does not use`（日志） | 移除所指的键；消息会说明每个值现在位于何处 |
| 日志提示该插件与正在运行的 dsh 不兼容 | 安装一个在 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| DeepSeek Harness 升级后，面板显示 "Failed to load plugins" | 重启正在运行的实例 |
| 提及之后没有任何反应 | 检查作者是否在该 Source 的允许列表中、该 Source 是否开启、处理是否未被暂停。在 GitHub 上，通过编辑 Issue 正文添加的提及不会被接收；请在评论中提及代理 |
