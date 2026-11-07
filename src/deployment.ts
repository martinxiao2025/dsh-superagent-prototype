/** 仓库访问与 agent CLI 身份相关的插件配置及启动校验。 */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from './infra/subprocess.ts'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} 绝对路径。`)
/** dsh-superagent 条目的插件配置。Volatile 字段无需重启即生效，因为 dsh-superagent 每次使用时都会读取它们；修改 `stateDir` 会重新挂载插件。 */
export const Config = s.object({
  stateDir: absolute('用于存放数据库、锁、worker shim、agent 的 git 配置，以及（默认）工单目录的目录。').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('可保存的提示词配置上限，以字符计。').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('一次评估最多可读取的 Thread 上下文页数。').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('评估期间单次上下文读取的时限，以毫秒计。').volatile(),
  mcpEnabled: s.boolean().default(true)
    .description('通过 MCP 在 127.0.0.1 上向 agent-plugins 客户端提供主会话的工具。修改后需重启生效。'),
  mcpPort: s.number().min(0).max(65535).step(1).default(3083)
    .description('/mcp 上 MCP 端点的回环端口；请同步更新 plugin/mcp.json。0 表示自动选择空闲端口。修改后需重启生效。'),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
  mcpEnabled: boolean
  mcpPort: number
}
const MOVED: Record<string, string> = {
  repository: 'GitHub Source 上', branchPrefix: 'Execution 设置的 prepare 命令中', github: 'GitHub Source 上',
  feishu: 'Feishu Source 上', author: '提示词文本中', repositoryPath: 'Execution 设置的 prepare 命令中',
  worktreeRoot: 'Execution 设置的工单目录中', blockedCommands: 'Execution 设置中',
}

/** 读取机器设置，并拒绝未知的配置键（同时指出已弃用的键迁移到了哪里）。 */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent 的配置包含它不使用的键：${unknown.map(key => MOVED[key] ? `${key}（现在位于${MOVED[key]}）` : key).join('、')}；docs/006-deployment.md 列出了这些键`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, mcpEnabled, mcpPort } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, mcpEnabled, mcpPort }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** 影响部署设置的 Source 配置键，变更后会触发重启。 */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** 将命令名或绝对路径解析为可执行文件，并忽略 worker shim 目录。 */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} 必须是命令名或绝对路径`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* 这里不是可执行文件；继续尝试 PATH 中的下一个目录。 */ }
  }
  throw new Error(`${name} 不是可执行文件${isAbsolute(name) ? '' : '（在 PATH 中）'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** 通过 DSH 的 worker 子进程服务执行启动检查，并从 PATH 中移除 worker shim 目录，好让 `gh` 包装脚本找到真正的二进制文件。 */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* 非 JSON 输出；由调用方上报设置失败。 */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** 校验 agent 的 GitHub CLI 身份，以及对所配置仓库的推送权限。 */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // 使用 GitHub 返回的规范仓库名，以便改名的仓库仍能匹配收到的通知。
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * 校验所配置的飞书 CLI 已以机器人身份完成鉴权，并限制在 strict mode `bot`。
 * worker 会以 `lark-cli` 调用该 CLI，因此若 CLI 同时允许用户身份，worker 就能以该用户身份行事。
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` 只会解开 `data`，而该端点把载荷放在 `bot` 下返回。
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
