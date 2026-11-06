/** 以 `copilot` CLI 的非交互模式（`-p`）运行真实 agent 回合的宿主实现。 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHost, HostHealth, TurnHandle, TurnRequest, TurnResult } from './host.ts'

/** 提示词交给 CLI 的方式。`stdin` 避免把多行中文放进命令行，Windows 上尤其重要。 */
export type PromptMode = 'stdin' | 'argument'
/** CopilotCliHost 的选项。全部可注入，以便用替身脚本做单元测试。 */
export interface CopilotCliHostOptions {
  /** 可执行文件；默认 `copilot`。测试传 `process.execPath`。 */
  readonly command?: string
  /** 追加在可执行文件之后的固定参数，例如替身脚本路径。 */
  readonly commandArgs?: readonly string[]
  /** 单个回合的超时，默认 30 分钟。 */
  readonly timeoutMs?: number
  /** 自检超时，默认 15 秒。 */
  readonly verifyTimeoutMs?: number
  /** 每次调用都带的权限参数；默认只放开工具确认，不动路径与 URL。 */
  readonly flags?: readonly string[]
  /** 提示词注入方式；默认 `stdin`。 */
  readonly promptMode?: PromptMode
  /** 追加的环境变量，与 `process.env` 合并。 */
  readonly env?: NodeJS.ProcessEnv
  /** 自检用的参数；默认 `--version`。 */
  readonly versionArgs?: readonly string[]
  /** 诊断日志；不会写入提示词或输出正文。 */
  readonly log?: (message: string, error?: unknown) => void
}
/** 一个在途回合的进程与它的原始输出。 */
interface Running {
  readonly child: ReturnType<typeof spawn>
  readonly startedAt: string
  readonly directory: string
  readonly cleanup: () => Promise<void>
  stdout: string
  stderr: string
  timedOut: boolean
  timer: NodeJS.Timeout
  done: Promise<TurnResult>
}
/**
 * 通过 Copilot CLI 驱动真实 agent 回合。一个回合就是一个进程：派发即启动，
 * 回收即等待退出，因此不存在常驻会话与后台作业需要额外观测。
 *
 * Windows 上 `copilot` 通常是 `.cmd` 垫片，Node 不允许以 `shell: false` 启动它；
 * 此时 `start()` 会把原因写进 `health()`，由调用方改指真实入口，而不是静默失败。
 */
export class CopilotCliHost implements AgentHost {
  private state: HostHealth = { state: 'idle', detail: '尚未启动', at: new Date().toISOString() }
  private readonly running = new Map<TurnHandle, Running>()
  private readonly command: string
  private readonly commandArgs: readonly string[]
  private readonly timeoutMs: number
  private readonly verifyTimeoutMs: number
  private readonly flags: readonly string[]
  private readonly promptMode: PromptMode
  private readonly env: NodeJS.ProcessEnv
  private readonly versionArgs: readonly string[]
  private readonly log: (message: string, error?: unknown) => void
  /** 记录选项，默认值在这里集中决定，便于测试整体替换。 */
  constructor(options: CopilotCliHostOptions = {}) {
    this.command = options.command ?? 'copilot'
    this.commandArgs = options.commandArgs ?? []
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? 15_000
    this.flags = options.flags ?? ['--allow-all-tools']
    this.promptMode = options.promptMode ?? 'stdin'
    this.env = { ...process.env, ...options.env }
    this.versionArgs = options.versionArgs ?? ['--version']
    this.log = options.log ?? (() => {})
  }
  /** 运行一次 `--version` 自检；失败只记录状态，不抛出。 */
  async start(): Promise<void> {
    const at = new Date().toISOString()
    try {
      const version = await this.verify()
      this.state = { state: 'ready', detail: `Copilot CLI ${version}`, at }
    } catch (error) {
      this.state = { state: 'error', detail: describe(error), at }
      this.log('dsh-superagent 无法启动 Copilot CLI 宿主：%s', error)
    }
  }
  /** 最近一次自检或停止后的状态。 */
  health(): HostHealth { return this.state }
  /** 启动一个回合进程，并立刻返回它的回执。 */
  async dispatch(request: TurnRequest): Promise<TurnHandle> {
    if (this.state.state === 'stopped') throw new Error('宿主已停止，无法派发回合')
    const start = new Date().toISOString()
    const handle: TurnHandle = { sessionId: request.sessionId, startedAt: start }
    const extra = await this.mcpArgs(request)
    const args = [...this.commandArgs, ...this.flags, '--output-format', 'json', '--session-id', request.sessionId, '-C', request.directory,
      ...(request.model ? ['--model', request.model] : []), ...extra.args, ...(this.promptMode === 'argument' ? ['-p', request.prompt] : [])]
    const child = spawn(this.command, args, { env: this.env, windowsHide: true })
    let timer: NodeJS.Timeout | undefined
    const running: Running = {
      child, startedAt: start, directory: request.directory, cleanup: extra.cleanup, stdout: '', stderr: '', timedOut: false,
      timer: undefined as unknown as NodeJS.Timeout,
      done: undefined as unknown as Promise<TurnResult>,
    }
    child.stdout?.on('data', chunk => { running.stdout += String(chunk) })
    child.stderr?.on('data', chunk => { running.stderr += String(chunk) })
    const done = new Promise<TurnResult>(resolve => {
      let settled = false
      const finish = (result: TurnResult): void => {
        if (settled) return
        settled = true
        clearTimeout(running.timer)
        // 先删掉临时的 MCP 配置文件再交回结果，调用方拿到的结局不依赖删除是否及时。
        void running.cleanup().catch(() => undefined).then(() => resolve(result))
      }
      child.on('error', error => finish({ sessionId: request.sessionId, text: '', exitCode: -1, startedAt: start,
        endedAt: new Date().toISOString(), error: `无法启动 ${this.command}：${describe(error)}` }))
      child.on('close', code => {
        const parsed = parseTurnOutput(running.stdout, 'json')
        let error: string | undefined
        if (running.timedOut) error = `回合在 ${this.timeoutMs} 毫秒后超时并被终止`
        else if (code !== 0) error = running.stderr.trim().slice(0, 2000) || `CLI 退出码为 ${code ?? -1}`
        else if (!parsed.text) error = '未能从 CLI 输出中解析出回复'
        finish({ sessionId: request.sessionId, text: parsed.text, exitCode: code ?? -1, startedAt: start,
          endedAt: new Date().toISOString(), ...(error ? { error } : {}) })
      })
      running.timer = setTimeout(() => {
        // 超时先礼后兵：SIGTERM 给 CLI 一次收尾机会，5 秒后仍不退出则强杀。
        running.timedOut = true
        child.kill()
        setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000).unref()
      }, this.timeoutMs)
      running.timer.unref()
    })
    running.done = done
    this.running.set(handle, running)
    child.stdin?.on('error', () => { /* CLI 提前退出时写入 stdin 会失败，结局以退出码为准。 */ })
    if (this.promptMode === 'stdin') child.stdin?.end(request.prompt)
    else child.stdin?.end()
    return handle
  }
  /** 等待回合结束；中止信号会终止进程，结局仍以进程退出码为准。 */
  async collect(handle: TurnHandle, options: { signal?: AbortSignal } = {}): Promise<TurnResult> {
    const running = this.running.get(handle)
    if (!running) throw new Error(`未知的回合：${handle.sessionId}`)
    const abort = (): void => { running.child.kill() }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      return await running.done
    } finally {
      options.signal?.removeEventListener('abort', abort)
      this.running.delete(handle)
    }
  }
  /** 终止所有在途回合并把状态置为已停止；已派发的回执仍可回收。 */
  async stop(): Promise<void> {
    this.state = { state: 'stopped', detail: '已停止', at: new Date().toISOString() }
    const entries = [...this.running.values()]
    for (const entry of entries) entry.child.kill()
    await Promise.all(entries.map(entry => entry.done.catch(() => undefined)))
  }
  /** 运行自检命令并返回它的第一行输出。 */
  private verify(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.commandArgs, ...this.versionArgs], { env: this.env, windowsHide: true })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error(`自检在 ${this.verifyTimeoutMs} 毫秒后超时`)) }, this.verifyTimeoutMs)
      timer.unref()
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(stderr.trim() || `退出码为 ${code ?? -1}`))
        else resolve(stdout.trim().split(/\r?\n/)[0] ?? '')
      })
    })
  }
  /**
   * 把回合的 MCP 服务器写成临时配置文件。用 `@路径` 传递，避免把含引号的 JSON
   * 塞进命令行；回合结束后删除该文件。
   */
  private async mcpArgs(request: TurnRequest): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
    const servers = request.mcp ?? []
    if (servers.length === 0) return { args: [], cleanup: async () => undefined }
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-'))
    const file = join(directory, 'mcp.json')
    const config = { mcpServers: Object.fromEntries(servers.map(server => [server.name, { type: 'http', url: server.url }])) }
    await writeFile(file, JSON.stringify(config), 'utf8')
    return { args: ['--additional-mcp-config', `@${file}`], cleanup: async () => { await rm(directory, { recursive: true, force: true }) } }
  }
}
/** 从 CLI 输出里取出回复文本；同时兼容纯文本与 JSONL 两种格式。 */
export interface ParsedTurn {
  /** 解析出的回复；空串表示没有可用回复。 */
  readonly text: string
  /** 无法解析为 JSON 的行数；纯文本输出时为 0。 */
  readonly malformed: number
}
/**
 * 解析一个回合的 stdout。`text` 格式把整段输出当作回复；`json` 格式逐行解析 JSONL，
 * 只取助手或结果事件里的文本字段。事件形状按 CLI 的通用约定做尽力识别，因此无法
 * 识别的行只计数、不报错；`json` 格式下一行都无法解析时返回空回复，由调用方判为失败。
 */
export function parseTurnOutput(stdout: string, format: 'text' | 'json' = 'json'): ParsedTurn {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return { text: '', malformed: 0 }
  if (format === 'text') return { text: lines.join('\n'), malformed: 0 }
  const events: unknown[] = []
  let malformed = 0
  for (const line of lines) {
    try { events.push(JSON.parse(line) as unknown) } catch { malformed += 1 }
  }
  if (events.length === 0) return { text: '', malformed }
  const text = events.flatMap(event => assistantText(event)).join('\n').trim()
  return { text, malformed }
}
/** 从一个事件里取出助手或结果文本；其它事件返回空数组。 */
function assistantText(event: unknown): string[] {
  if (!isRecord(event)) return []
  const type = typeof event.type === 'string' ? event.type : ''
  const role = typeof event.role === 'string' ? event.role : ''
  const assistant = /assistant|completion|final/i.test(type) || role === 'assistant' || typeof event.result === 'string'
  if (!assistant) return []
  return textValues(isRecord(event.data) ? event.data : event)
}
/** 在有限深度内收集文本字段，避免把工具输出或元数据当成回复。 */
function textValues(value: unknown, depth = 0): string[] {
  if (depth > 3) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(item => textValues(item, depth + 1))
  if (!isRecord(value)) return []
  return ['text', 'content', 'result', 'message', 'delta'].flatMap(key => textValues(value[key], depth + 1))
}
/** 判断一个值是否是可索引的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
/** 把未知错误转成一句可诊断的话，不带堆栈。 */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${error.message}（${code}）` : error.message
  }
  return String(error)
}
