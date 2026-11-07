# 006 部署

本指南用于安装、配置和运行 dsh-superagent-cn。它涵盖账户、启动检查、升级与故障排查，建立在 [001 领域模型](001-domain.md) 至 [005 管理面板](005-panel.md) 的基础之上。

## 运行着什么

- **一个专用的 DeepSeek Harness profile**，在本指南中名为 `superagent`。从 Web profile 模板创建它。它加载本 bundle，并在 `127.0.0.1` 上提供其管理面板。请让它与你日常工作的 profile 分开：该插件会更改进程级的 `PATH` 与 git 设置，其进程也需要独立地重启与升级。
- **一个智能体 GitHub 账户。** 智能体以该账户评论、推送分支和发起拉取请求，所用 GitHub CLI 只以该账户登录。
- **可选：** 一个用于聊天请求的飞书机器人。

插件配置保存状态目录与机器限额。其余一切都用管理面板：仓库与账户在 Sources，允许列表在 Policy，执行器目录与命令在 Execution。

### 权限与隔离

该 bundle 为执行器定义了 `dsh-superagent-cn-worker`，为主 Session 定义了 `dsh-superagent-cn-router`。它们会出现在 DeepSeek Harness 的 preset 列表中，但仅供 dsh-superagent-cn 使用。不要在个人 Session 中选择它们，也不要禁用它们的配置行。本应用需要它们来创建和恢复自己的 Session。

在 Web UI 中打开空白的受管 Session 时，可能会选中该 profile 的默认 preset。dsh-superagent-cn 会在第一个回合之前恢复其按角色设定的 preset。

两个 preset 都以操作者的操作系统用户、按 `danger-full-access` 运行，并从订阅的线程读取消息。账户包装脚本默认选用智能体的凭据；它们并不隔离进程。执行器可以按路径执行程序，并读取操作者的主目录。若要隔离，请使用一个只含智能体凭据的专用操作系统账户。

## 前提条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+、Python 3.8+ 和 tmux
- GitHub CLI（`gh`）2.48 或更高版本。Source 的 CLI 字段必须指向 `gh` 或 `lark-cli` 包装脚本；宿主依赖它们的子命令与输出格式。
- github.com 上的一个仓库；不支持 GitHub Enterprise Server。要为每个工单创建检出，请保留一个本地克隆，prepare 命令可以从它添加 worktree。若该仓库使用 Git LFS，请安装 `git-lfs`。
- 为 DeepSeek Harness 配置好的模型提供方。除非 Eval 或 Execution 设置另指定模型，dsh-superagent-cn 使用该 profile 的默认模型。
- 飞书方面：`lark-cli`（以 1.0.90 测试过）和一个带机器人的飞书或 Lark 应用

## 账户

### 智能体 GitHub 账户

1. 为智能体创建一个 GitHub 用户账户，并给它仓库的写权限。GitHub App 不能充当智能体，因为 dsh-superagent-cn 要读取该账户的通知。
2. 给它一个只使用自身凭据的 GitHub CLI：

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

   以智能体账户登录；最后一条命令会打印其登录名。dsh-superagent-cn 以同样的方式读取登录名。

### 飞书机器人（可选）

1. 创建一个带机器人能力的自建应用。授予它接收消息事件、读取与发送群聊消息、读取群成员的权限，然后发布应用版本。
2. 给机器人自己的 `lark-cli` 配置，限定为机器人身份，并配一个包装脚本：

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent-cn" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent-cn" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent-cn"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   第一条命令从标准输入读取应用 secret。请使用单独的配置目录：`lark-cli` 每个应用 id 只允许一个 profile，而你的个人配置可能已经包含该应用的用户登录。

   宿主会拒绝能够以用户身份行事的 CLI。它从机器人配置中读取应用 id、飞书/Lark 品牌和机器人的 `open_id`。

   两个配置共用钥匙串中存放应用 secret 的条目。若只想移除机器人配置，删除其目录即可；不要运行 `lark-cli config remove`，那会影响共用的 secret。

## 安装

在一台还没有 `superagent` profile 的机器上，运行以下命令块一次：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent-cn && cd dsh-superagent-cn
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上面固定的版本是公开发布的；其他版本必须满足 `package.json` 中的 `engines.dsh`。

第四条命令从 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条安装本 bundle。设置 `DSH_HOME` 可把默认的 `~/.dsh` 目录放到别处。

只在新安装时才运行创建 profile 的那条命令。若 profile 已存在，该命令会替换它并删除其 `cordis.patch.yml`，包括机器配置。不要将它用于升级。

## 机器配置

将 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制为 `~/.dsh/profiles/superagent/cordis.patch.yml`（覆盖该文件），并把每个 `<placeholder>` 都替换掉。若使用飞书，还要在该文件中启用 `dsh-superagent-cn-feishu` 条目。`webserver` 条目设置管理面板的端口。

| 键 | 必填 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 中的命令垫片、智能体的 git 配置，以及默认情况下 `work` 中的工单目录。升级前请备份它 |
| `promptMaxChars`、`admissionContextMaxPages`、`admissionContextTimeoutMs` | 否 | 已保存提示词配置的大小上限，以及一次评估在多长时间内读取多少个线程页 |

首次启动后，可在 **Settings → Deployment** 或 DeepSeek Harness 插件管理器中编辑机器限额。更改无需重启即生效。`stateDir` 不能在那里更改。无效的值或未知的配置键会阻止启动；日志会指出是哪个键。

## 启动与停止

```sh
scripts/dsh-superagent-cn start
scripts/dsh-superagent-cn status
```

`start` 在 tmux session `dsh-superagent-cn` 中运行 `dsh --profile superagent`；其他 profile 则为 `dsh-<profile>`。它最多等待一分钟，等运行时就绪或报告 Setup 要求。首次运行时会打印缺失的 Setup 信息。它会拒绝重复实例，包括在本脚本之外启动的实例。

`stop` 与 `restart` 请求优雅关闭，并最多等待执行器五分钟。它们从不强行杀死进程，也不触碰其他 tmux session。

`status` 打印进程 id、健康状况和 Setup 问题。要针对其他 profile 或端口，可使用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 以四种退出码之一结束：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 服务没有运行、运行了两份、不响应，或其运行时报错；重启可能修复 |
| 2 | 服务在运行，但运行时之外的某个部分报错，例如某个 Source 或策略同步（`sync:<source id>`）；重启不能修复 |
| 3 | 服务在运行并等待 Setup；重启不能修复 |

仍在启动中的 Source 算作正常运行；Setup 无法检查的飞书机器人也是如此。

`status` 在 `errors` 下返回出错的部分及其详情，在 `setup` 下返回 Setup 要求。`start` 与 `restart` 把这些问题逐行打印；若服务一直起不来则退出码为 1。只有主动执行的 `stop` 才会暂停自动恢复。

每个 profile 都把日志与控制文件存放在 `.artifacts/` 之下：

- 启动日志：`dsh-superagent-cn-<profile>-<date>-<time>-<pid>.log`，其中的 pid 属于该脚本。只保留最新的 20 个。
- 控制文件：`control/profiles/<profile>/`，包含停止标记、锁和进程 id。

打开日志中打印的 URL，然后在侧边栏选择 **Superagent**。

### 每小时检查

请在你日常使用的 DeepSeek Harness profile（而非 `superagent`）中创建每小时检查。它必须在智能体服务宕机时仍能运行。让该 profile 中的智能体使用下面这段提示词创建每小时计划，并把检出路径填写进去：

```text
Check dsh-superagent-cn: run `scripts/dsh-superagent-cn --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent-cn --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-cn-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` 会保留主动执行的停止。只有 `stop` 会写入标记；`start` 会清除它。`restart` 不写标记，因此检查可以恢复一次关闭超时的重启。

## 设置

在轮询或工作开始之前，Setup 必须成功。Overview 列出缺失的要求并链接到相应设置。设置更改会重新运行 Setup。如果你在应用之外修复了什么（例如 CLI 认证），请选择 **Check again**。

1. **Sources。** 设置 GitHub 仓库（`owner/name`）和智能体 CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常经由智能体账户的通知到达。提到该账户的新 Issue 或新评论会在下一次轮询时到达；通过编辑已有 Issue 正文加入的提及则不会。请改为发布新评论。飞书方面，设置机器人 CLI、群聊列表、每个群聊的全部接收或仅提及模式，以及是否接收单聊消息。
2. **Policy。** 两条示例规则可以编辑或删除。在 **On each Source** 之下，添加可以请求工作的 GitHub 账户和飞书用户；在某个列表里有人之前，任何请求都无法变成工单。飞书方面可以选择一个群聊作为列表的同步来源，同步在启动时以及点击 **Sync now** 时进行。
3. **Execution。** 目录根路径和一个 prepare 命令。要让每个工单都有一份仓库检出：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent-cn/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent-cn/$DSH_SUPERAGENT_TICKET"
   ```

   把个人 CLI（例如以你自己账户登录的那个）列入禁止命令。
4. **Prompts。** 设置团队段落：GitHub 披露行、审查机器人、提交作者和自动合并条件。

### 管理 API

管理面板使用一个本地 HTTP API，智能体也可以调用它。`SETUP.md` 用它保存设置，服务脚本会读取 `GET state`。

请求发送到 `http://127.0.0.1:<port>/orchestrator/api/`，并带上 `x-orchestrator-request: 1`。Host 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少请求头、或 `Origin` 来自其他站点时，会收到 403。

通过 API 进行的保存拥有管理面板的权限。与通过主 Session 工具进行的保存不同，它们可以更改执行环境和 Setup 账户字段。

智能体可以依赖这些路由和字段。`src/app/api.ts` 中的其他路由服务于管理面板，会随面板变化。

| 请求 | 响应 |
| --- | --- |
| `GET state` | 每个页面都要读取的内容：`setup`，含 `problem` 和 `feishuProblem`，两者各为 `null` 或一个 Setup 问题（含 `place`、`code`、`values` 和 `detail`），以及 Setup 解析出账户后的 `accounts`；`health`，每个部分一条（见下文），含 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail` 和 `at`；`load`，含 `running`（运行中的执行器 Session 数）、`queued`（排队中的工单数）和 `maxWorkers`；`paused`；以及 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval` 和 `executor`，各自带有自己的 `value` 与 `revision`；`sources`：各 Source 实例，每个带有 `id`、`kind`、`installed`、其所属块的 `value`（形如 `{"enabled": …, "config": {…}}`）、`revision`、其 kind 对应的表单，以及（若有）其 Setup `problem`；`policyVersion`；以及 `environment`，即执行环境的 `root` 与 `variables` |
| `GET sources` | 每个 Source 的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、其各部分的 `health`、其 Setup `problem`、最近一天的 `stats`、当天被它 `filtered` 的触发，以及当天被它 `dropped` 的消息（最新丢弃的在前），每条带有 `channel`、`preview`、（若它针对某个工单）`ticket`（`id` 和 `title`）、（若存储中存在）`thread`，以及 `dropped.at` 和 `dropped.reason`（`channelGone` 或 `channelIgnored`） |
| `PUT settings/<block>`，附带 `{"value": …, "revision": n}` | 保存一个块：返回 `saved`、该块新的 `revision`、`policy_changed` 和 `restarting`。`value` 是整个块，形式与 `GET settings` 中相同；缺失的键取其默认值 |
| `POST executor/pause`，附带 `{"paused": true}` 或 `false` | 暂停或恢复处理：返回 `paused` |
| `POST setup/check` | 通过重启 dsh-superagent-cn 再次运行 Setup：`restarting: true`。Setup 没有要修复的内容时会被拒绝 |
| `POST policy-sync/<source id>` | 立即同步该 Source 的允许列表：返回 `policy`，即该 Source 部分保存后的内容 |
| `GET prompts`，以及附带 `{"config", "baseRevision"}` 的 `PUT prompts` | 读取提示词配置：`current`，含其 `revision` 和 `config`；`defaults`；`sections`，即按 Session 读取顺序排列的团队段落；`skillName`，团队技能名称的模式；`builtin`，团队技能不能使用的名称；以及 `skillPrefix`，Session 加载技能名时所用的前缀。保存时返回新的 `revision` |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 重试或停止一个工单，与管理面板的操作相同 |

健康条目按职责分组：

| 条目 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 正在等待模型额度重试的 Session |
| `evals` | 最近一小时内不可用、其后既无判断也未被标记处理的 Eval |
| `assessment`、`launch`、`delivery`、`relay`、`notice`、`reply` | [003 执行](003-execution.md) 中描述的已存储工作；`delivery` 统计等待中的工作，`reply` 则覆盖渠道消息 |
| `worker` | 执行器 Session 的事件处理；在首次失败后出现 |
| `github`、`feishu`、`history` | Source 轮询、事件与历史恢复 |
| `sync:<source id>` | 允许列表同步 |

拒绝响应带有状态码和 `error`，其英文文本为：

- 400：无效的值（`issues`，各含自己的 `path`）、失败的账户检查（`setup`）、一条固定文案的拒绝（`code` 和 `values`），或请求体不是 JSON 或过大。
- 404：不存在的东西。
- 409：修订号已过期。
- 500：其他一切情况。

各个块：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 的 config 含 `repository` 和 `cli`，以及默认关闭的开关 `observeIssues`、`observePulls`、`observeComments` 和 `observeCi`——它们接收仓库中每个新 Issue、新拉取请求和评论，以及默认分支的 CI；飞书的 config 含 `cli`、形如 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`（或 `"all"`）的 `chats`、`directMessages`，以及取值 `"none"` 或 `"mentions"` 的 `otherChats`。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可以成为推断候选的机器人。`admission` 行的键：飞书为群聊 id、`other` 或 `direct`，GitHub 为 `issues`、`pulls`、`comments` 或 `ci`；未设置的单元格取其默认值（见 [002 授权](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停是一项独立的设置 `paused`，由 `POST executor/pause` 设置。

更改仓库或 CLI 会先运行相应的 Setup 检查。检查失败返回 400，详情在 `setup` 中。成功更改账户，或在 Setup 尚未完成时进行的任何保存，都返回 `restarting: true`。应用重启期间 API 暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup 检查

Setup 使用 DeepSeek Harness 的子进程服务，与执行器 shell 相同。它会移除名称中含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

Setup 会验证 GitHub 仓库和智能体的推送权限，写入执行器环境，并检查 git 对 github.com 只使用智能体凭据。飞书 Setup 失败只会禁用飞书 Source。

Setup 写入的进程环境：

- `<stateDir>/worker-bin` 中的**命令垫片**，位于 `PATH` 的最前面：`gh` 运行智能体的 CLI；`lark-cli` 运行机器人的 CLI；被禁止的命令会失败。垫片在运行目标之前会先把自己的目录从 `PATH` 中移除。
- `<stateDir>/worker-gitconfig` 中的 **git 配置**：替换操作者的全局与系统级 git 配置。它选择智能体 CLI 作为 github.com 的凭据助手，把 GitHub SSH 地址改写为 HTTPS，并定义 Git LFS 过滤器。个人 git 设置（如 HTTP 代理）不生效。这里不设置提交身份，git 永远不会提示输入凭据，且 `GH_TOKEN` 和 `GITHUB_TOKEN` 会被移除。

`worker-bin` 或 `worker-gitconfig` 中任何不是由 dsh-superagent-cn 写入的文件都会使 Setup 停止。若某个工单目录位于一个自身配置添加了凭据的 git 仓库内，该工单会失败。

## 试一试

使用允许列表中的某个 GitHub 账户，发起一个 Issue，或发布一条包含 `@<agent login> <request>` 的评论。在一个轮询间隔内（默认一分钟），Overview 应该会显示一个工单。智能体会确认该请求，在自己的 Session 和目录中工作，并在原始对话中交付。飞书方面，在已配置的群聊中提及机器人即可。

## 升级

1. 等到没有执行器正处于回合之中。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent-cn restart` 并检查其状态。

重启会结束正在运行的派工，并附上恢复说明启动接替者。团队文本与被覆盖的提示词部分会保留；未被覆盖的部分跟随新默认内容。升级后请检查被标记为 **Default updated** 的部分。

被更新版本迁移过的数据库无法被旧版本打开。因此回滚必须使用升级前的备份。升级 DeepSeek Harness 本身之后，请重启运行中的实例，使管理面板加载相匹配的工件。

### 智能体 preset

worker 与 router 这两个 preset 会在 5 秒后把 shell 命令转入后台。Session 缺少其 preset 就无法加载。只要相应 Session 仍在使用，就请保留 `cordis.patch.yml` 中的 `dsh-superagent-cn-worker` 和 `dsh-superagent-cn-router` 行；否则恢复会以 `agent-preset/not-found` 失败。

## 故障排查

Setup 问题会显示在 Overview 上并附有指向修复方法的链接，使用管理面板的语言；日志与 API 则显示下面的英文文本。

| 症状 | 原因与修复 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上设置智能体的 CLI |
| `The agent GitHub CLI was not found.` | 设置包装脚本的绝对路径，或 `PATH` 上的一个命令名 |
| `The agent GitHub CLI cannot read its account` | 用 `auth login` 为包装脚本登录 |
| `@… cannot read …` 或 `@… cannot push to …` | 给智能体账户仓库的写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上设置仓库，即 `owner/name` |
| 工单失败并报 `The prepare command failed: …` | 输出会指明原因，例如克隆路径不对；修好命令后重试该工单 |
| `git does not read the github.com credential configuration dsh-superagent-cn writes` | 安装 git 2.32 或更高版本 |
| 工单失败并报 `The git configuration of the repository in … sets …` | 从克隆的 `.git/config` 中移除被点名的凭据或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent-cn` | 把被点名的文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或另选一个 `stateDir` |
| `The bot lark-cli allows user identities` | 让飞书 Source 指向仅限机器人的配置，如上文“飞书机器人”一节所示 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查配置的应用 id 与 secret |
| `The Feishu bot is not a member of the chat.` | 在群聊的设置中把机器人加入群聊；下一次尝试即可成功 |
| `status` 以退出码 2 结束 | 某个部分报错，重启不能修复：`errors` 按“管理 API”一节所列点名每个部分及其详情；每个部分恢复正常后会自行清除自己的条目 |
| `status` 以退出码 3 结束 | Setup 在等待：`setup` 说明缺少什么，Overview 会链接到能修复它的设置 |
| `status` 以退出码 1 结束 | 服务没有运行、运行了两份、不响应，或其运行时报错；输出与最新日志会说明是哪种 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | 某个 CLI 失败且没有打印原因；以操作者的用户身份手动运行被点名的程序，查看它自己的报错 |
| 管理面板提示 dsh-superagent-cn 没有响应 | 它正在重启，或因自身配置而未能启动；DeepSeek Harness 日志会指明原因 |
| `dsh-superagent-cn configuration has keys it does not use`（日志） | 移除被点名的键；消息会说明每个值现在存放在哪里 |
| 日志提示该插件与正在运行的 dsh 不兼容 | 安装 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| DeepSeek Harness 升级后管理面板显示 "Failed to load plugins" | 重启运行中的实例 |
| 提及之后毫无动静 | 检查作者是否在该 Source 的允许列表中、该 Source 是否开启、处理是否未被暂停。在 GitHub 上，通过编辑 Issue 正文加入的提及不会被接收；请在评论中提及智能体 |
