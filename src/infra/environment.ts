/**
 * 进程环境与 CLI shim：把 git、gh、lark-cli 绑定到部署的账号，并阻止不允许的命令。
 * worker 读取的变量名中避开 `KEY|PASSWORD|SECRET|TOKEN`，因为 DSH 会从子进程中剥离形似凭据的变量。
 * 这里提供的是默认路径层面的护栏，而非操作系统级的安全边界，因为 worker 以运维人员的 OS 用户身份运行。
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** 项目较早名称（`dsh-tag`、`dsh-go`、`dsh-freelancer`）下写入文件的标记；这些文件同样归 `dsh-superagent` 所有并被替换。 */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** worker 需要的命令，`blockedCommands` 无法阻止它们：各 shim 与 git。 */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * 告诉 git 作用于哪个仓库、工作树与索引的变量。在 git 内部启动的宿主（例如通过
 * `git rebase --exec`）会把它们传下去，而在其下启动的 git 会作用于那个仓库。GIT_CEILING_DIRECTORIES
 * 会保留：它不指向任何仓库，并在运维人员选定的位置停止 git 的仓库搜索。
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * 返回环境变量覆盖，用于剥离环境中已有的 GitHub token、交互式提示、宿主自身环境可能指定的仓库，
 * 以及运维人员的 git 身份/配置覆盖。
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // worker 的 git 从其目录确定仓库，绝不从宿主环境。
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // 清除环境中的 git 配置覆盖；否则通过环境传入的配置会作用于 agent 运行的每条 git 命令。
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // 凭据助手无答案时，git 必须失败而不是提示；`GIT_ASKPASS: ''` 也会覆盖 `core.askPass` 与 `SSH_ASKPASS`。
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // 清除运维人员的提交身份变量；提示词会指定提交身份，而运维环境变量会覆盖 worker 设置的值。
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** 当普通文件的前两行中包含 dsh-superagent 标记时为 true；符号链接、目录或其他非普通文件永不算作 dsh-superagent 写入的。 */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* 文件尚不存在。 */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * 把 worker 的 CLI shim 与隔离的 git 配置文件原子地写入 state 目录，拒绝覆盖非本程序写入的文件。
 * 每个 shim 在 exec 前从 PATH 中移除 shim 目录，使按名称解析 `gh` 或 `lark-cli` 的包装脚本能到达真正的二进制文件。
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // worker 可能并发运行：把每个 shim 写入临时文件再原子重命名，使任何命令都不会绕过 shim 目录去解析。
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  await shim('gh', run(github.cli))
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // 让 git 在没有 worker 显式设置身份时拒绝提交，而不是从运维人员的 OS 用户猜测。
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // 包含 Git LFS 过滤器，因为运维人员的全局 gitconfig（通常存放它们）已被忽略。
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** 应用环境变量覆盖，并把 worker shim 置于 `process.env.PATH` 最前，返回一个恢复回调。 */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** 通过 DSH 子进程运行时启动命令，该运行时会剥离形似凭据的环境变量。 */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** 校验 worker 的 git 调用能解析到部署的 GitHub 凭据助手。 */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` 用 NUL 分隔字段，且从不对路径加引号。
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
}

/**
 * 校验工单目录的本地或 worktree git 配置未定义自定义的 `credential.*` 或 `http.*extraheader`
 * 键——agent 的 git 会从仓库自身配置中读取它们并据此行动。
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // 没有匹配的键时，`git config --get-regexp` 以退出码 1 结束。
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
