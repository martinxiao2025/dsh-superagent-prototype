# AGENTS.md — 阶段一实施约束基线

> 适用对象：在本项目 `d:\superagent-plugin`（仓库根即新项目目录）中工作的编码代理与开发者。
> 依据：`docs/00-phase1-agent-plugins-migration.md`、`docs/01-phase1-task-plan.md`，以及原型 `d:\dsh-superagent-prototype`（`main@8c32a9d`）的实际代码与配置。
> 语言：简体中文 | 编码：UTF-8（无 BOM） | 更新时间：2026-11-06
>
> 路径约定：`docs/…`、`src/…`、`tests/…`、`scripts/…`、`plugin/…` 均相对本文件所在的项目根 `d:\superagent-plugin`。原型目录只作只读参考，**不得**在原型里继续开发，也不得把产出写到其它路径或另建仓库。

## 1. 事实核对结论

### 1.1 已验证成立、必须遵守

| 事实 | 依据（可直接复核） |
| --- | --- |
| 主会话工具为 **14 个**，worker 工具为 **5 个** | `src/app/tools/main.ts`、`src/app/tools/executor.ts` 的 `name:` 字面量 |
| 主会话工具依赖真实 `Agent`：`prompt-preview` 用 `agent.id`，`orchestrator_eval_read` 的图片分支需要 `agent.ctx` 与 `agent.session` | `src/app/tools/main.ts`、`src/app/assessment.ts` 的 `read()` |
| 管理 API 要求 `x-orchestrator-request: 1` 且同源 | `src/app/http.ts` 的 `sameOrigin()` |
| 端口失败若走 `SetupError`，`Setup.run()` 返回 `false` 后 `Runtime.initialize()` 直接 `return`，整个编排停摆 | `src/app/setup.ts`、`src/app/runtime.ts` 的 `initialize()` |
| `lib/` 被 `.gitignore` 忽略，且 tsdown 第一份配置 `clean: true` 会清空它 | `.gitignore`、`tsdown.config.ts` |
| 现有编号文档为 `000`–`008`，编号连续且只能链接更早文档 | `tests/docs.spec.ts` |
| `docs/007-architecture.md` 的 Modules 表必须覆盖 `src` 全部文件、Tests 表必须覆盖全部 `*.spec.ts(x)` | `tests/docs.spec.ts` |
| 每个 `class` 声明前必须有 JSDoc | `tests/class-docs.spec.ts` |
| `skills/` 下的技能会被加载进 DSH 会话，且测试断言内置技能恰为 `dsh-superagent-feishu`、`dsh-superagent-github` | `src/app/skill-files.ts`、`tests/tools.spec.ts` |
| 面板文案必须中英双语，键与占位符一致 | `src/client/locales.ts`、`tests/locales.spec.ts` |
| 模型可见表面（工具、提示词、技能、输入）受防漂移测试约束 | `tests/model-surface.spec.ts` |
| Node `v24.19.0`、pnpm `11.7.0` 满足 `engines` | `node -v`、`pnpm -v`、`package.json` |
| 原型仓库远端为 `origin git@github.com:martinxiao2025/dsh-superagent-prototype.git`；新项目根不自动继承该远端 | 原型 `git remote -v`；本仓库 `git remote -v` 为空 |

### 1.2 已过时或与代码冲突的条目（不得照抄执行）

| 文档说法 | 代码/配置事实 | 执行口径 |
| --- | --- | --- |
| `00` §4.2 表尾「worker 6 工具」 | 实际 5 个 | 以 5 为准；文档中的 6 属笔误 |
| `00` A3「20 个工具列出」 | 主会话实际 14 个 | 验收按 14；A3 的 20 作废 |
| `00` §4.3 端口占用走 `SetupError` | `Setup.run()` 吞掉 `SetupError` 后 `Runtime.initialize()` 提前返回，编排停摆 | 端口失败只写 `HealthBoard` 的 `mcp` 条目（`error`），进程继续 |
| `00` §4.1「沿用同源自定义头」 | MCP 客户端不会发 `x-orchestrator-request` | 放弃自定义头；只绑 `127.0.0.1` + Streamable HTTP 的 DNS rebinding 防护 |
| `00` §3.3「三个技能都放 `plugin/skills/`」 | `skills/` 会被 `skill-files.ts` 加载，且内置技能数被测试锁定为 2 | 主技能只放 `plugin/skills/`；另两个在构建时从 `skills/` 拷入 `lib/plugin/skills/` |
| `00` §3.4「产物到 `lib/plugin/`」被当作唯一来源 | `lib/` 被 gitignore 且 `clean: true` | `plugin/` 是唯一源，`lib/plugin/` 只是构建产物；`build` 必须在 `tsdown` 之后执行 |
| `00` §3.1 `homepage` 含 `<org>` 占位符 | 官方 schema 只校验字符串，占位符能通过但不可用 | 不写 `homepage`/`repository`，等真实地址 |
| `00` §7 要求新增 `docs/009-copilot-plugin.md` | 现有编号 `000`–`008` 连续 | 新文档固定 `009`，只能链接 `000`–`008` |
| 计划 T0.1 记录 pnpm `10.33.0` | 本机已是 `11.7.0` | 已修订为 11.7.0；换机再按需 corepack |
| `01` 的 `pnpm plugin:build` / `pnpm plugin:check` | 迁移时 `package.json` 已有这两个脚本（批次 1 落地） | 直接用 `pnpm plugin:build` / `pnpm plugin:check` |
| 计划把实施落点写成 `d:\dsh-superagent-prototype` | 用户 2026-11-06 硬性更正：新项目就在 `d:\superagent-plugin` | 已把原型源码/配置/测试导入本根；后续只在本根开发、提交，原型只读 |

### 1.3 无法在当前环境确认、需标记而非假设

- **A4（VS Code Copilot 冒烟）**：本机无 Copilot 客户端会话，无法自动验证；记录为「待用户配合」，不得写成通过。
- **A6（保活演练）**：需要 systemd/Windows 计划任务与真实守护进程部署，本机无法完整演练。
- **真实 GitHub/飞书触发（A5 第二轮）**：需要真实凭据与仓库，未执行前只报告测试回归结果。
- **官方 schema 的远端可用性**：已下载到本地校验输入目录后，校验过程禁止联网；schema 内容以本地文件为准。

冲突处理原则：**代码事实 > 计划文档 > 方案文档**。无法用代码裁决时，写入本节并上报，不自行假设。

### 1.4 迁入本根时的冲突与处理（2026-11-06）

| 冲突点 | 处理 | 遗留 |
| --- | --- | --- |
| 根目录已有 `AGENTS.md`（本文件），原型根也有一份未跟踪的同名开发指南 | **保留本文件**；原型那份不导入，其项目约定已由本文件 §2–§6 覆盖 | 如需逐字保留原型指南，另存 `docs/` 并说明，当前不做 |
| 根目录已有 `docs/00-…`、`docs/01-…`（两位编号），原型 `docs/000`–`008`（三位编号） | 两套并存；`tests/docs.spec.ts` 只匹配三位编号，不受影响；阶段一新增文档仍为 `docs/009-copilot-plugin.md` | 文档导航需人工区分「计划文档 00/01」与「设计文档 000–008」 |
| 原型 `.git` 含历史 | **不导入**；本根新建仓库，原型保留原历史只读 | 原型分支 `feat/phase1-agent-plugins` 与已做的批次 1 改动不再作为交付物，以本根为准 |
| 原型 `.zcode/`、`node_modules/`、`lib/` | **不导入**（本地工具、依赖与生成物） | 本根需重新 `pnpm install` 与 `pnpm build` |
| 根目录原有 `.screenshots/` | 原样保留，不读不写不提交 | 无 |

## 2. 项目定位与目录结构

`dsh-superagent` 是面向单个 GitHub 仓库的主动式编码代理，以 DSH bundle 形式运行；阶段一目标是新增合规插件包与 MCP 端点，不改领域逻辑。

| 路径 | 性质 | 可否手改 |
| --- | --- | --- |
| `src/core/` | 领域核心（Engine、模型、ports） | 可改，但本阶段禁止改行为；不得做 I/O、不得导入 core 之外（Node 哈希除外） |
| `src/app/` | 应用层（Runtime、Store、HTTP、Sessions、Settings、Prompts） | 可改；MCP 相关新增文件放这里 |
| `src/executor/` | DshExecutor 与 worker 会话 | 本阶段不改 |
| `src/sources/` | Source 插件与注册表 | 本阶段不改；**禁止导入 `src/app`** |
| `src/client/` | React 面板 | 可改文案键；只允许从宿主导入类型与少数纯值模块 |
| `src/infra/` | CLI 传输、环境、路径、HealthBoard | 可改；不得承载领域规则 |
| `prompts/` | 内置提示词，**每行一句** | 可改；评估指令只在 `prompts/admission.md` |
| `skills/` | DSH 内置技能（feishu、github） | 可改；**不得新增**会被加载的第三个内置技能 |
| `docs/` | 设计文档 `000`–`008` + 计划文档 `00`/`01` | 可改；新增编号只能续到 `009`，且只能链接更早编号 |
| `locale/` | 面板双语文案 `en.json` / `zh.json` | 可改；键必须成对 |
| `tests/` | vitest 测试与共享夹具 | 可改；**禁止**为通过验证而删测试或放宽断言 |
| `scripts/dsh-superagent` | 部署后的服务管理脚本 | 可改；改动需 `tests/service-script.spec.ts` 通过 |
| `plugin/` | **本阶段新增的插件源**（`plugin.json`、`mcp.json`、`skills/`） | 可手改，是唯一事实源 |
| `lib/` | tsdown 构建产物（ESM 主包 + CJS 客户端） | **禁止手改**，会被下次构建清空 |
| `lib/plugin/` | 插件打包产物 | **禁止手改**，由 `scripts/build-plugin.mjs` 生成 |
| `node_modules/`、`coverage/`、`.artifacts/` | 依赖与测试产物 | **禁止手改、禁止提交** |
| `pnpm-lock.yaml` | pnpm 生成的锁文件 | **禁止手写**；只由 `pnpm install` 更新 |
| `<stateDir>/orchestrator.sqlite` 等 | 运行时数据（默认在配置的 stateDir） | **禁止**提交或手改 |

## 3. 任务执行流程

1. **读计划**：每次开工先读 `docs/01-phase1-task-plan.md` 的 §0（修订说明）、§5（任务分解）、§6（提交批次）、§11（执行记录），以及本文件的 §1。
2. **按批次推进**：顺序为批次 1（M0+M1）→ 2（M2）→ 3（M3）→ 4（M4）→ 5（M5 修复）。不得跳过前置批次；每批必须能独立验证。
3. **每批验证**：
   - 通用：`pnpm check`（= typecheck + test + build + plugin:check，T1.6 后生效）。
   - 批次 1：`node scripts/validate-plugin.mjs` 与 `node scripts/validate-plugin.mjs --dir lib/plugin`，并实跑 4 类负例。
   - 批次 2：`pnpm typecheck` + 既有测试全绿 + 一次真实握手（`tools/list` 得到 14 项）。
   - 批次 3：`pnpm test -- tests/mcp.spec.ts` 与全量 `pnpm test`。
   - 批次 4：`tests/docs.spec.ts`、`tests/locales.spec.ts`、`tests/class-docs.spec.ts` 必须绿。
   - 批次 5：按 §7 验收矩阵逐项记录真实命令与输出。
4. **提交**：每批一次 commit，信息用 Conventional Commits（如 `feat(plugin): add agent-plugins package and offline schema checks`）。
   - 只暂存本批次文件：`git add <具体文件>`，禁止 `git add -A`。
   - 提交前跑 `git diff --cached --name-only`，确认没有 `.zcode/`、`lib/`、`node_modules/`、临时脚本、数据库。
   - 提交后把真实结果写入计划 §11，不得用「应该通过」代替。
5. **推送**：仅在用户要求且远端凭证可用时 `git push`；失败就如实报告并继续本地批次。

## 4. 代码与文件约束

### 4.1 编码与格式

- 所有新建/修改的文本文件保存为 **UTF-8（无 BOM）**；脚本与源码统一 LF。
- 提交前可用以下命令抽查 BOM（返回值应为空）：

```powershell
Get-ChildItem -Recurse -File src,tests,scripts,plugin,docs -Include *.ts,*.tsx,*.mjs,*.json,*.md |
  Where-Object { [System.IO.File]::ReadAllBytes($_.FullName)[0..2] -join ',' -eq '239,187,191' } |
  Select-Object -ExpandProperty FullName
```

### 4.2 命名与分层

- Engine 命令方法：祈使动词 + 宾语（`stopTicket`、`bindThread`），可被拒绝。
- 适配器上报事实：过去时（`assignmentStarted`、`deliveryFailed`）；查询：名词（`candidate`）。
- 人或代理可触发的拒绝一律 `UserError(code, values)`，`code` 必须来自 `src/core/errors.ts` 的 `USER_ERRORS`。
- 显式窄依赖：类只接收以 `Pick` 命名的接口（`ExecutorHost`、`MainToolsHost` 等）。
- 每种状态只有一个 writer（Settings 只由 `Settings` 写、Outbox 回执只由 Outbox 写）。
- MCP 是新客户端，不是新领域入口：**禁止**在 `src/app/mcp*.ts` 里写领域规则或直接改 Store 状态，只能调用现有工具/Engine 命令。

### 4.3 文档与文案

- 新增编号文档：`docs/009-copilot-plugin.md` 是唯一允许的新编号；只能在 `000`–`008` 之后，且链接只能指向更早编号。
- 新增模块或测试后，必须同步 `docs/007-architecture.md` 的 Modules 表与 Tests 表，否则 `tests/docs.spec.ts` 失败。
- 新增面板文案必须同时写 `src/client/locales.ts` 的中英文，键与占位符一致。
- 新增运行时依赖必须同时更新 `AGENTS.md`（实施仓库根）与 `docs/007` 的依赖说明。
- 官方 schema 作为离线校验输入放在 `scripts/schemas/agent-plugins-1.0.0/`，**不得**在校验时联网。

## 5. 生成物同步方式

| 生成物 | 生成命令 | 同步规则 |
| --- | --- | --- |
| `lib/`（主包 + 客户端） | `pnpm build` / `pnpm exec tsdown` | 不提交；改动源码后重新构建验证 |
| `lib/plugin/` | `pnpm plugin:build`（T1.6 后）或 `node scripts/build-plugin.mjs` | 不提交；由 `plugin/` 与 `skills/` 生成 |
| `pnpm-lock.yaml` | `pnpm install --no-frozen-lockfile`（仅新增/变更依赖时） | 必须提交；禁止手改 |
| `docs/007` 两张表 | 手工维护 | 新增文件后立即同步 |
| 健康条目文案 | 手工维护 `src/client/locales.ts` | 与 `HealthBoard.claim()` 的条目名一一对应 |

构建顺序纪律：`tsdown` 必须在前（`clean: true` 会清空 `lib/`），`build-plugin` 必须在其后；不得把两者顺序颠倒。

## 6. 安全规则

1. **密钥与凭证**：不得把 token、cookie、私钥、`gh` 凭据、飞书 app secret、真实 session id 写入仓库、文档、测试夹具或提交信息。示例统一用占位符（`<org>`、`127.0.0.1`、`ou_bot`）。
2. **不得为通过验证而降低标准**：禁止删除、跳过（`.skip`/`.todo`）、注释掉测试，禁止放宽断言、放宽 schema、改验收标准；失败就修代码或如实上报。
3. **Git 安全**：禁止 `git push --force`、`git push -f`、改写已推送历史（rebase/amend 公开提交）、修改远端地址；不得擅自 `git reset --hard`、`git clean -fd`、`git checkout -- .`。
4. **破坏性操作先确认**：删除目录/文件、覆盖未提交改动、清空数据库、重置分支，必须先征得用户同意（见 §8）。
5. **外部网络与依赖**：新增依赖必须说明理由、锁定精确版本（不用 `^`）、更新锁文件与文档；校验脚本必须离线可跑；不得引入需要联网的运行时行为。
6. **监听面**：MCP 端点只允许绑定 `127.0.0.1`，不得改为 `0.0.0.0` 或局域网地址；不得绕过回环限制；不引入 token/OAuth 作为阶段一方案。
7. **权限口径**：MCP 调用等价于一次面板操作，不得绕过 Policy 与 Mandate 复验；不得新增授权旁路。
8. **数据面**：`stateDir` 下的 SQLite、日志、附件不得提交；调试输出写到临时目录，不写入仓库。

## 7. 提交前检查清单

- [ ] 本批次只改了计划中列出的文件（对照 `01` §1.4 与 §5）。
- [ ] `pnpm check` 全绿，或失败项与本批无关且已记录。
- [ ] `git diff --cached --name-only` 不含 `.zcode/`、`lib/`、`node_modules/`、`.sqlite`、截图、临时脚本。
- [ ] 新增文件已同步 `docs/007` 两张表与所需文案。
- [ ] 文本文件为 UTF-8 无 BOM。
- [ ] 提交信息说明了本批范围与验证结果。
- [ ] 未执行任何 force push / 历史改写 / 未确认的删除。

## 8. 做之前必须先问

出现以下任一情况，先停下来问用户，不得自行决定：

1. 需要改变远端地址、向远端强推/改写历史，或把仓库迁到其他路径、另建仓库（本根已是唯一仓库根）。
2. 需要删除或覆盖未提交的改动、用户数据、数据库、`lib/` 之外的任何目录。
3. 需要新增/升级运行时依赖，或让校验/构建依赖联网。
4. 需要修改 `src/core` 的领域行为、`prompts/` 的语义、Policy 规则、既有工具的描述或 schema。
5. 需要新增或重命名设置项、`SetupCode`、健康条目、locale 键（会影响面板与文档契约）。
6. 需要改变 MCP 监听地址、鉴权模型、插件安装路径或分发方式。
7. 需要真实 GitHub/飞书凭据，或需要在 VS Code Copilot、systemd、Windows 计划任务中做验收（A4/A6）。
8. 文档与代码冲突且无法用代码事实裁决（记录到 §1.3 并上报）。
9. 计划中的验收标准无法满足，需要放宽或跳过。

## 9. 命令速查

| 命令 | 用途 |
| --- | --- |
| `pnpm install --no-frozen-lockfile` | 仅在依赖变更时更新锁文件 |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest 全量 |
| `pnpm test -- tests/mcp.spec.ts` | 单文件测试 |
| `pnpm build` | tsdown 构建（T1.6 后自动含插件打包） |
| `pnpm check` | 提交前必跑 |
| `node scripts/validate-plugin.mjs [--dir <path>]` | 离线校验插件包 |
| `node scripts/build-plugin.mjs` | 组装 `lib/plugin/` |
| `git diff --cached --name-only` | 提交前核对暂存范围 |

## 10. 维护

- 本文件与 `docs/01-phase1-task-plan.md` 同步维护：计划的任务/验收变化时，先改本文件的 §1 与 §3。
- 发现新的事实冲突，追加到 §1.2/§1.3，并在当批简报中说明。
- 本文件自身也是 UTF-8 无 BOM；修改后跑 §4.1 的 BOM 抽查。
