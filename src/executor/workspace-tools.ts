/**
 * worker 回合的工作区工具：读、写、改文件，列目录、搜索，以及执行命令。
 *
 * 这些能力此前由 DSH 的 profile 提供；`VsCodeLmHost` 接管 worker 后必须自带。所有路径都
 * 限定在工单的 worktree 内，越界一律拒绝；输出有上限，超长时截断并标注原文长度。
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { TurnTool } from './host.ts'

/** 单个工具的输出上限，默认 60000 字符。 */
const DEFAULT_MAX_CHARS = 60_000
/** 命令的默认超时，默认 120 秒。 */
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
/** 列目录时跳过的目录。 */
const SKIPPED = new Set(['.git', 'node_modules', 'dist', 'lib', 'coverage', '.artifacts'])

/** 工作区工具：既有交给模型的 JSON Schema，也有执行体。 */
export interface WorkerTool extends TurnTool {
  /** 参数的 zod schema，执行前校验模型给的原始参数。 */
  readonly schema: z.ZodType
  /** 执行一次调用；抛错会被回传给模型当作工具失败。 */
  execute(args: unknown, signal: AbortSignal): Promise<unknown>
}
/** `workspaceTools` 的选项。 */
export interface WorkspaceToolsOptions {
  /** 工单的 worktree 绝对路径；所有工具都被限定在它内部。 */
  readonly directory: string
  /** 单个工具回传文本的上限，默认 60000 字符。 */
  readonly maxChars?: number
  /** 命令的默认超时，默认 120 秒。 */
  readonly commandTimeoutMs?: number
}

/**
 * 构造一组限定在 `directory` 内的工作区工具。
 * @param options 目录与上限。
 * @returns 按工具名索引前的工具列表。
 */
export function workspaceTools(options: WorkspaceToolsOptions): WorkerTool[] {
  const root = resolve(options.directory)
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  return [
    define('read_file', '读取工作区内一个文件的文本。大文件用 offset/limit 分页；返回内容带行号，便于引用。',
      z.object({
        path: z.string().min(1).describe('相对工单目录的文件路径。'),
        offset: z.number().int().min(1).optional().describe('起始行号，从 1 开始；默认 1。'),
        limit: z.number().int().min(1).max(2000).optional().describe('最多读取的行数，默认 400。'),
      }),
      async args => {
        const file = within(root, args.path)
        const info = await stat(file)
        if (info.isDirectory()) throw new Error(`${args.path} 是目录；请用 list_files`)
        const lines = (await readFile(file, 'utf8')).split('\n')
        const offset = args.offset ?? 1
        const limit = args.limit ?? 400
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const body = slice.map((line, index) => `${offset + index}\t${line}`).join('\n')
        return cap(body, maxChars, `${args.path} 共 ${lines.length} 行`)
      }),

    define('write_file', '覆盖写入工作区内的一个文件；父目录不存在时自动创建。整文件写入，局部修改请用 edit_file。',
      z.object({ path: z.string().min(1).describe('相对工单目录的文件路径。'), content: z.string().describe('完整的新内容。') }),
      async args => {
        const file = within(root, args.path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, args.content, 'utf8')
        return { path: args.path, bytes: Buffer.byteLength(args.content, 'utf8') }
      }),

    define('edit_file', '把文件里的一段原文替换成新文本；原文必须唯一，否则用 replace_all。返回替换次数。',
      z.object({
        path: z.string().min(1).describe('相对工单目录的文件路径。'),
        old_text: z.string().min(1).describe('要替换的原文，必须与文件内容逐字一致。'),
        new_text: z.string().describe('替换后的文本。'),
        replace_all: z.boolean().optional().describe('原文出现多次时是否全部替换，默认 false。'),
      }),
      async args => {
        const file = within(root, args.path)
        const text = await readFile(file, 'utf8')
        const occurrences = text.split(args.old_text).length - 1
        if (occurrences === 0) throw new Error(`在 ${args.path} 里找不到要替换的原文`)
        if (occurrences > 1 && args.replace_all !== true) throw new Error(`原文在 ${args.path} 里出现 ${occurrences} 次；请给出更长的唯一片段，或设 replace_all`)
        const next = args.replace_all === true ? text.split(args.old_text).join(args.new_text) : text.replace(args.old_text, args.new_text)
        await writeFile(file, next, 'utf8')
        return { path: args.path, replacements: args.replace_all === true ? occurrences : 1 }
      }),

    define('list_files', '列出工作区内的文件与目录，返回相对路径；用于确认改动位置。',
      z.object({
        path: z.string().optional().describe('相对的起始目录，默认工单目录根。'),
        depth: z.number().int().min(1).max(4).optional().describe('递归深度，默认 2。'),
      }),
      async args => walk(root, within(root, args.path ?? '.'), args.depth ?? 2, maxChars)),

    define('search', '在工作区内按正则搜索文件内容，返回命中的路径、行号与整行文本。',
      z.object({
        pattern: z.string().min(1).describe('JavaScript 正则；不支持 lookbehind。'),
        path: z.string().optional().describe('相对的起始目录，默认工单目录根。'),
        max_results: z.number().int().min(1).max(200).optional().describe('最多返回的命中数，默认 50。'),
      }),
      async (args, signal) => search(root, within(root, args.path ?? '.'), args.pattern, args.max_results ?? 50, maxChars, signal)),

    define('run_command', '在工作区根目录执行一条命令，返回退出码与输出。用于构建、测试与 git；长命令请拆小。',
      z.object({
        command: z.string().min(1).describe('要执行的命令行，例如 `pnpm test -- tests/x.spec.ts`。'),
        timeout_ms: z.number().int().min(1000).max(600_000).optional().describe('超时毫秒数，默认 120000。'),
      }),
      async (args, signal) => {
        const result = await run(args.command, root, Math.min(args.timeout_ms ?? commandTimeoutMs, 600_000), signal, maxChars)
        return result
      }),
  ]
}

/**
 * 定义一个工作区工具：把 zod schema 转成模型可读的 JSON Schema，执行前校验参数。
 * @param name 工具名。
 * @param description 给模型的说明。
 * @param schema 参数 schema。
 * @param execute 执行体。
 * @returns 工具。
 */
function define<S extends z.ZodType>(name: string, description: string, schema: S,
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>): WorkerTool {
  return {
    name,
    description,
    inputSchema: jsonSchema(schema),
    schema,
    execute: async (args, signal) => execute(schema.parse(args), signal),
  }
}

/**
 * 把 zod schema 转成 JSON Schema，并去掉模型不需要的 `$schema` 声明。
 * @param schema 参数 schema。
 * @returns JSON Schema 对象。
 */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

/**
 * 把相对路径解析到 `root` 内；越界或绝对路径一律拒绝。
 * @param root 工单目录。
 * @param relative 模型给的相对路径。
 * @returns 绝对路径。
 */
function within(root: string, relative: string): string {
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`路径越界：${relative} 不在工单目录内`)
  }
  return target
}

/**
 * 递归列出目录，按深度与输出上限截断；跳过依赖与产物目录。
 * @param root 工单目录。
 * @param start 起始目录。
 * @param depth 递归深度。
 * @param maxChars 输出上限。
 * @returns 相对路径列表的文本。
 */
async function walk(root: string, start: string, depth: number, maxChars: number): Promise<string> {
  const found: string[] = []
  const visit = async (directory: string, level: number): Promise<void> => {
    if (level > depth) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue
      const full = resolve(directory, entry.name)
      found.push(full === root ? entry.name : full.slice(root.length + 1).split(sep).join('/') + (entry.isDirectory() ? '/' : ''))
      if (entry.isDirectory() && level < depth) await visit(full, level + 1)
      if (found.length > 2000) return
    }
  }
  await visit(start, 1)
  return cap(found.join('\n'), maxChars, `共 ${found.length} 个条目`)
}

/**
 * 在目录内递归搜索文本文件，按正则逐行匹配。
 * @param root 工单目录。
 * @param start 起始目录。
 * @param pattern 正则文本。
 * @param maxResults 命中上限。
 * @param maxChars 输出上限。
 * @param signal 中止信号。
 * @returns 命中文本。
 */
async function search(root: string, start: string, pattern: string, maxResults: number, maxChars: number, signal: AbortSignal): Promise<string> {
  const regex = new RegExp(pattern)
  const hits: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (signal.aborted || hits.length >= maxResults) return
      if (SKIPPED.has(entry.name)) continue
      const full = resolve(directory, entry.name)
      if (entry.isDirectory()) { await visit(full); continue }
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|css|html|txt|toml|sh|ps1)$/i.test(entry.name)) continue
      const info = await stat(full)
      if (info.size > 512 * 1024) continue
      const lines = (await readFile(full, 'utf8')).split('\n')
      for (let index = 0; index < lines.length && hits.length < maxResults; index += 1) {
        if (regex.test(lines[index]!)) hits.push(`${full.slice(root.length + 1).split(sep).join('/')}:${index + 1}: ${lines[index]!.trim()}`)
      }
    }
  }
  await visit(start)
  return hits.length ? cap(hits.join('\n'), maxChars, `命中 ${hits.length} 条`) : '没有命中'
}

/**
 * 在工作区根目录执行一条命令，收集输出；超时或中止时终止整棵进程树。
 * @param command 命令行。
 * @param cwd 工作目录。
 * @param timeoutMs 超时毫秒数。
 * @param signal 中止信号。
 * @param maxChars 每个输出流的上限。
 * @returns 退出码与输出。
 */
async function run(command: string, cwd: string, timeoutMs: number, signal: AbortSignal, maxChars: number) {
  return new Promise<{ exit_code: number; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let finished = false
    const kill = (reason: string) => {
      if (finished) return
      finished = true
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      else child.kill('SIGTERM')
      reject(new Error(reason))
    }
    const timer = setTimeout(() => kill(`命令在 ${timeoutMs} 毫秒后仍未结束，已终止：${command}`), timeoutMs)
    timer.unref?.()
    const abort = () => kill('调用方取消了命令')
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) })
    child.on('close', code => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolvePromise({ exit_code: code ?? -1, stdout: cap(stdout.trimEnd(), maxChars, `标准输出共 ${stdout.length} 字符`),
        stderr: cap(stderr.trimEnd(), maxChars, `标准错误共 ${stderr.length} 字符`) })
    })
  })
}

/**
 * 截断过长文本，并标注原文规模。
 * @param text 文本。
 * @param limit 上限字符数。
 * @param note 附在末尾的规模说明。
 * @returns 截断后的文本。
 */
function cap(text: string, limit: number, note: string): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（${note}，已截断）`
}
