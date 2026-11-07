/** 独立进程入口：读取配置文件，启动 Runtime，并在配置或账号变更后进程内重启编排器。 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig, type Machine } from './deployment.ts'
import { consoleLogger, redactingLogger, type Logger } from './infra/logger.ts'
import { NodeSubprocess, type SubprocessRuntime } from './infra/subprocess.ts'
import { VsCodeLmHost } from './executor/vscode-lm.ts'

export { Config }
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'

/** 启动选项：`--config` 指定配置文件路径。 */
export interface MainOptions {
  /** 命令行参数，缺省取 `process.argv.slice(2)`。 */
  readonly argv?: string[]
  /** 已解析的配置；测试可直接注入，跳过文件读取。 */
  readonly config?: DeploymentConfig
  /** 日志实现；测试可替换。 */
  readonly logger?: Logger
  /** 子进程实现；测试可替换。 */
  readonly subprocess?: SubprocessRuntime
  /** 配置变更后的重启；缺省在进程内重建 Runtime。 */
  readonly restart?: () => void
}

/** 默认配置文件路径。 */
export const configPath = (): string => join(homedir(), '.dsh-superagent', 'config.json')

/** 读取 `--config` 参数；没有时返回默认路径。 */
export function configFile(argv: readonly string[]): string {
  const index = argv.indexOf('--config')
  if (index >= 0) {
    const path = argv[index + 1]
    if (!path) throw new Error('--config 需要一个文件路径；例如 --config C:\\Users\\me\\.dsh-superagent\\config.json')
    return path
  }
  return configPath()
}

/** 读取并校验配置文件；错误信息指出文件位置与必填字段。 */
export function loadConfig(argv: readonly string[] = []): DeploymentConfig {
  const path = configFile(argv)
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (error) {
    throw new Error(`无法读取配置文件 ${path}：${error instanceof Error ? error.message : String(error)}。`
      + '请创建它，例如 {"stateDir":"C:\\\\Users\\\\me\\\\.dsh-superagent","panelPort":3082,"mcpPort":3083}')
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error(`配置文件 ${path} 不是合法 JSON。`) }
  try {
    // `machineOf` 先检查未知键并给出可读提示，再按 schema 校验字段。
    machineOf(value as Record<string, unknown>)
    return Config.parse(value)
  } catch (error) {
    throw new Error(`配置文件 ${path} 无效：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 持有当前 `Runtime`，并在账号或配置变更时于进程内重建它：
 * 先释放数据库与状态目录锁，再用同一份宿主依赖启动新的编排器。
 */
class Supervisor {
  private runtime: Runtime | undefined
  private pending: Promise<void> | undefined
  private stopped = false
  /** 记录宿主依赖与机器设置。 */
  constructor(private readonly deps: { machine: Machine; logger: Logger; subprocess: SubprocessRuntime; host: VsCodeLmHost }) {}
  /** 启动第一个 Runtime 并等待它就绪。 */
  async start(): Promise<Runtime> {
    await this.pending
    if (this.stopped) throw new Error('dsh-superagent 已停止')
    const runtime = new Runtime({ machine: this.deps.machine, logger: this.deps.logger, subprocess: this.deps.subprocess,
      host: this.deps.host, restart: () => { void this.restart() } })
    this.runtime = runtime
    await runtime.ready
    return runtime
  }
  /** 停止并重建 Runtime；并发调用合并为一次。 */
  restart(): Promise<void> {
    this.pending ??= (async () => {
      const previous = this.runtime
      this.runtime = undefined
      await previous?.stop()
      const next = new Runtime({ machine: this.deps.machine, logger: this.deps.logger, subprocess: this.deps.subprocess,
        host: this.deps.host, restart: () => { void this.restart() } })
      this.runtime = next
      await next.ready
    })().finally(() => { this.pending = undefined })
    return this.pending
  }
  /** 停止当前 Runtime；之后不再重建。 */
  async stop(): Promise<void> {
    this.stopped = true
    await this.pending?.catch(() => { /* 重启失败不应阻止退出。 */ })
    await this.runtime?.stop()
    this.runtime = undefined
  }
}

/** 进程入口：解析配置、启动编排器，并在 SIGINT/SIGTERM 时优雅退出。 */
export async function main(options: MainOptions = {}): Promise<number> {
  const logger = redactingLogger(options.logger ?? consoleLogger)
  let config: DeploymentConfig
  let machine: Machine
  try {
    config = options.config ?? loadConfig(options.argv)
    machine = machineOf(config as unknown as Record<string, unknown>)
  } catch (error) {
    logger.error('dsh-superagent 无法启动：%s', error instanceof Error ? error.message : String(error))
    return 1
  }
  const host = new VsCodeLmHost({ model: config.model || undefined,
    log: (message, error) => { logger.warn('%s: %s', message, error instanceof Error ? error.message : error ?? '') } })
  const supervisor = new Supervisor({ machine, logger, subprocess: options.subprocess ?? new NodeSubprocess(), host })
  const shuttingDown = async (signal: string) => {
    logger.info('dsh-superagent 收到 %s，正在关闭', signal)
    await supervisor.stop().catch(error => { logger.error('关闭失败：%s', String(error)) })
    process.exit(0)
  }
  process.once('SIGINT', () => { void shuttingDown('SIGINT') })
  process.once('SIGTERM', () => { void shuttingDown('SIGTERM') })
  try {
    const runtime = await supervisor.start()
    logger.info(runtime.configured()
      ? `dsh-superagent 已就绪：面板 http://${machine.host}:${runtime.panelPort ?? machine.panelPort}`
      : `dsh-superagent 正在等待 setup：${runtime.setupProblem?.detail ?? ''}；打开面板 http://${machine.host}:${runtime.panelPort ?? machine.panelPort} 完成配置`)
    return 0
  } catch (error) {
    logger.error('dsh-superagent 启动失败：%s', error instanceof Error ? error.message : String(error))
    await supervisor.stop().catch(() => { /* 已在退出路径上。 */ })
    return 1
  }
}

/** 直接运行 `node lib/index.js` 时进入进程入口。 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().then(code => { if (code !== 0) process.exitCode = code })
}
