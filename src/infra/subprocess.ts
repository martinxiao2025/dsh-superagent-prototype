/** 本地子进程运行时：替换 DSH 的 subprocess 服务，接口只保留 setup 与工单目录校验用到的部分。 */
import { spawn } from 'node:child_process'

/**
 * 形似凭据的环境变量名：派生子进程时剥离，避免把运维人员的 token/密钥传给 worker 的
 * git、gh、lark-cli。名字按 `_` 分段，命中整段才算（`PATH`、`HOME` 不受影响）。
 */
export const SENSITIVE_ENV_PATTERN = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|COOKIE|AUTH|SESSION|KEY)(_|$)/i
/** 过滤掉凭据形态的变量，返回可传给子进程的环境。 */
const withoutSecrets = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).flatMap(([name, value]) => value === undefined || SENSITIVE_ENV_PATTERN.test(name) ? [] : [[name, value]]))

/** 已收集输出的读取器；`readFrom(offset)` 返回该偏移之后的文本与下一偏移。 */
export interface SubprocessOutputReader {
  readFrom(offset: number): { text: string; next?: number }
}
/** 一次子进程运行的结局：正常退出时 `exitCode` 是状态码，被信号终止时为 `null`。 */
export interface SubprocessDone { exitCode: number | null }
/** 启动参数；`stdio` 只支持忽略 stdin 与收集有上限的 stdout/stderr。 */
export interface SpawnOptions {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Record<string, string>
  /** 收到中止信号后等待进程退出的宽限期，超时则强制结束。 */
  readonly graceMs: number
  readonly signal?: AbortSignal
  readonly stdio: { readonly stdin: 'ignore'; readonly stdout: { readonly maxBytes: number }; readonly stderr: { readonly maxBytes: number } }
}
/** 正在运行的子进程句柄。 */
export interface SubprocessHandle {
  readonly done: Promise<SubprocessDone>
  readonly collected: { readonly stdout?: SubprocessOutputReader; readonly stderr?: SubprocessOutputReader }
}
/** 本地运行时接口；测试可注入替身。 */
export interface SubprocessRuntime {
  spawn(options: SpawnOptions): SubprocessHandle
}

/** 把字节缓冲截断到 `maxBytes`，超出部分丢弃并附一行提示，避免内存无限增长。 */
class BoundedOutput implements SubprocessOutputReader {
  private text = ''
  private truncated = false
  /** 记录上限与已读偏移。 */
  constructor(private readonly maxBytes: number) {}
  /** 追加一块输出；超过上限的部分被舍弃。 */
  push(chunk: Buffer): void {
    if (this.text.length >= this.maxBytes) { this.truncated = true; return }
    const room = this.maxBytes - this.text.length
    const piece = chunk.toString('utf8')
    this.text += piece.length <= room ? piece : piece.slice(0, room)
    if (piece.length > room) this.truncated = true
  }
  /** 返回 `offset` 之后的文本；实现仍返回 `next`，类型上与 DSH 的读取器保持兼容。 */
  readFrom(offset: number): { text: string; next?: number } {
    const body = this.text.slice(offset)
    return { text: this.truncated ? `${body}\n…输出已截断` : body, next: this.text.length }
  }
}

/** 用 `node:child_process` 实现 `SubprocessRuntime`；环境变量合并到 `process.env` 上，并剥离凭据形态的项。 */
export class NodeSubprocess implements SubprocessRuntime {
  /** 启动一个子进程并立即返回句柄；凭据形态的环境变量不会传给子进程。 */
  spawn(options: SpawnOptions): SubprocessHandle {
    const [program = '', ...args] = options.argv
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: { ...withoutSecrets(process.env), ...withoutSecrets(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = new BoundedOutput(options.stdio.stdout.maxBytes)
    const stderr = new BoundedOutput(options.stdio.stderr.maxBytes)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    const done = new Promise<SubprocessDone>(resolve => {
      let settled = false
      const finish = (exitCode: number | null): void => { if (!settled) { settled = true; resolve({ exitCode }) } }
      child.on('error', () => finish(null))
      child.on('close', (code, signal) => finish(signal ? null : code))
      const stop = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill()
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, options.graceMs)
        timer.unref()
      }
      if (options.signal) {
        if (options.signal.aborted) stop()
        else options.signal.addEventListener('abort', stop, { once: true })
      }
    })
    return { done, collected: { stdout, stderr } }
  }
}
