/** 在部署配置的账号下运行 gh、lark-cli 与 git 命令的子进程封装。 */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/**
 * Commands 在 CLI 调用失败时抛出的错误，捕获 stderr 诊断、API 错误码与退出状态，且不回显命令参数。
 * Source 的 channel 与轮询器会检查其 code，以区分已删除的会话与可重试的失败。
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** 从失败的子进程中提取经过净化的错误，不回显可能包含消息文本的 argv。 */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* 非 JSON 的 CLI 诊断信息会在下方保留。 */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` 在 HTTP 错误（例如 `gh: Not Found (HTTP 404)`）以及 `gh: HTTP 304` 时以非零状态退出，而 ETag 轮询依赖后者。
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return '输出的内容超过允许大小'
  // `execFile` 超时会以 SIGTERM 终止进程并设置 `killed: true`。
  if (killed && signal === 'SIGTERM') return `在 ${TIMEOUT_MS / 1000} 秒后超时`
  if (signal) return `被 ${signal} 停止`
  if (typeof code === 'number') return `退出码为 ${code}`
  return typeof code === 'string' ? `无法运行：${code}` : '失败'
}
export interface Tally { skipped: number }
/** 按 schema 解析数组元素，跳过无效项并递增 `tally.skipped`。 */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** 重写飞书错误 232011（机器人不在群中），并附带修复指引。 */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = '飞书机器人不在该群中。请在群设置中添加机器人，然后重试。'
  return new CliError(hint, error.code, error.exitCode)
}
/**
 * 以部署账号凭据、超时与中止信号执行 gh、lark-cli 与 git 子进程。
 * 把 GitHub API 调用限制在已配置的仓库，并把 CLI 失败转换为 CliError 供 Source、MasterAssessor、Outbox 与 Settings 使用。
 */
export class Commands {
  /**
   * @param resolved - 返回已解析的部署设置；setup 仍在进行时抛出。
   * @param environment - 覆盖每个命令的 `process.env` 变量（例如隔离的 git 设置）。
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  async run(program: string, args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      return stdout
    } catch (error) { throw commandError(error, program) }
  }
  /** 运行 agent 的 GitHub CLI 并解析其 JSON 输出；调用方应优先使用 `api`，它被限制在已配置仓库并会校验输出。 */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.deployment.github.cli, args)) as T }
  /**
   * 调用已配置仓库内某个路径的 GitHub API；提供 schema 时校验 JSON 输出，
   * 省略时返回 CLI 的原始输出（例如原始文件或 `--include` 头）。
   * @throws CliError 失败时抛出，GitHub 的 HTTP 状态放在 `code` 中。
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.deployment.github.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** 抓取已配置仓库内 GitHub API 列表的全部分页，跳过未通过 schema 校验的条目。 */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub 调用仅限于已配置的仓库')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /**
   * 运行飞书机器人的 `lark-cli` 并返回 JSON 中的 `data` 负载。
   * @throws CliError 失败时抛出，携带飞书的错误码（机器人不在群中时重写 232011）。
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('飞书 Source 没有可用的机器人 CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? '飞书命令失败'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** 使用 agent 隔离的 git 环境与凭据助手，运行 PATH 上的 `git`。 */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
