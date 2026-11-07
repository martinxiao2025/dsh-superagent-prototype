/** 探测仓库与账号 CLI，配置 worker 执行环境与命令 shim，并跟踪 setup 是否就绪。 */
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Logger } from '../infra/logger.ts'
import type { SubprocessRuntime } from '../infra/subprocess.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly logger: Logger
  readonly subprocess: SubprocessRuntime
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * 通过探测 CLI 解析目标仓库、GitHub 账号与可选的飞书机器人，然后写入并应用供 worker 进程使用的隔离 git 与 shim 环境。
 * `Runtime` 在启动时运行它来决定编排是否就绪；`Settings` 则用它校验账号变更、更新被禁命令的 shim 并安排重启。
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** 去掉 worker shim 目录后的 PATH，使宿主自身的 CLI 调用能命中真正的二进制。 */
  private readonly path: string
  /** 把 agent 子进程指向隔离的 git 配置与命令 shim 的环境变量。 */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** 宿主命令环境：已应用 agent 的 git 变量，且 PATH 中排除了 worker shim 目录。 */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent 正在等待 setup：${this.problem?.detail ?? 'setup 尚未运行'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** 解析部署账号并应用 worker 环境：把 `SetupError` 失败记录到 `problem`/`feishuProblem`，其余意外错误原样抛出。 */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** 触发重启以重新运行 setup；若 setup 与飞书均已健康则拒绝，以免打断运行中的 assignment。 */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** 把重启推迟到下一个宏任务，好让当前 HTTP 或工具调用方先收到响应。 */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** 保存前校验被修改 Source 块的账号 CLI，忽略属于其他块的 setup 错误。 */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** 按 worker shell 的运行方式探测 CLI，并用 `stateDir` 作为 `cwd`，因为它在仓库克隆有效之前就已存在。 */
  private probe() {
    const { subprocess, machine, lifetime } = this.host
    return workerProbe(subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      this.host.logger.warn('dsh-superagent 跳过飞书：%s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, this.host.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
