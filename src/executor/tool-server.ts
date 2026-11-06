/**
 * 回合工具回调端点：扩展宿主在模型调用工具时把调用 POST 到这里，由 Runtime 执行并把结果回传。
 *
 * 只绑 `127.0.0.1` 的随机端口，每个回合一个一次性令牌；端口与令牌只出现在一次已鉴权的
 * 桥请求体里，不落盘、不写日志。端点不做领域判断，工具实现由调用方注册。
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ToolCall } from './host.ts'

/** 请求体上限：工具参数远小于它。 */
const MAX_BODY = 1024 * 1024
/** 单次工具调用的默认超时。 */
const DEFAULT_TIMEOUT_MS = 120_000
/** 回传结果文本的默认上限，避免把超大文件内容塞回模型。 */
const DEFAULT_MAX_CHARS = 60_000

/** `ToolServer` 的选项。 */
export interface ToolServerOptions {
  /** 单次工具调用的超时，默认 120 秒。 */
  readonly timeoutMs?: number
  /** 回传结果的最大字符数，默认 60000。 */
  readonly maxResultChars?: number
  /** 诊断日志；不记录令牌、参数正文或结果正文。 */
  readonly log?: (message: string, error?: unknown) => void
}
/** 一次注册的结果：扩展需要的基地址与一次性令牌。 */
export interface ToolEndpoint {
  /** 形如 `http://127.0.0.1:<port>/turns/<turnId>`。 */
  readonly base: string
  /** 该回合的令牌。 */
  readonly token: string
}
/** 一个回合注册的工具处理器。 */
interface Registration {
  readonly token: string
  readonly callTool: (call: ToolCall, signal?: AbortSignal) => Promise<unknown>
}

/**
 * 回合工具回调服务。生命周期跟随宿主：第一次注册时启动，`stop()` 时关闭，
 * 中途卸载某个回合不会影响其它回合。
 */
export class ToolServer {
  private server: Server | undefined
  private port = 0
  private readonly registrations = new Map<string, Registration>()
  private readonly timeoutMs: number
  private readonly maxResultChars: number
  private readonly log: (message: string, error?: unknown) => void
  /** 记录选项；端口与令牌在启动时决定。 */
  constructor(options: ToolServerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxResultChars = options.maxResultChars ?? DEFAULT_MAX_CHARS
    this.log = options.log ?? (() => {})
  }
  /** 为 `turnId` 注册工具处理器，必要时先启动服务；返回扩展要用的基地址与令牌。 */
  async register(turnId: string, callTool: Registration['callTool']): Promise<ToolEndpoint> {
    await this.start()
    const token = randomBytes(24).toString('hex')
    this.registrations.set(turnId, { token, callTool })
    return { base: `http://127.0.0.1:${this.port}/turns/${encodeURIComponent(turnId)}`, token }
  }
  /** 卸载一个回合；已卸载的回合再收到调用会被拒绝。 */
  unregister(turnId: string): void { this.registrations.delete(turnId) }
  /** 当前监听端口；未启动时为 0。 */
  get listening(): number { return this.port }
  /** 启动回环服务；已启动时为空操作。 */
  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.log('dsh-superagent 工具回调处理失败：%s', error)
        json(response, 500, { error: '内部错误' })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve()
      })
    })
    this.server = server
  }
  /** 关闭服务并丢弃全部注册；重复调用是幂等的。 */
  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = 0
    this.registrations.clear()
    if (!server) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  /** 校验来源、令牌与路由，然后执行一次工具调用。 */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!loopback(request) || (request.headers.host ?? '').toLowerCase() !== `127.0.0.1:${this.port}`) {
      json(response, 403, { error: '只接受本机回环请求' })
      return
    }
    const segments = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.split('/').filter(Boolean)
    if (segments.length !== 3 || segments[0] !== 'turns' || segments[2] !== 'call' || request.method !== 'POST') {
      json(response, 404, { error: '未知路由' })
      return
    }
    const registration = this.registrations.get(segments[1]!)
    if (!registration) {
      json(response, 404, { error: '该回合的工具端点已关闭' })
      return
    }
    if (!sameToken(request.headers.authorization, registration.token)) {
      json(response, 401, { error: '令牌无效' })
      return
    }
    let body: { name?: unknown; arguments?: unknown }
    try {
      body = JSON.parse(await readBody(request)) as { name?: unknown; arguments?: unknown }
    } catch (error) {
      json(response, 400, { error: `请求体不是合法 JSON：${messageOf(error)}` })
      return
    }
    if (typeof body.name !== 'string' || body.name === '') {
      json(response, 400, { error: '缺少工具名' })
      return
    }
    const signal = AbortSignal.timeout(this.timeoutMs)
    try {
      const result = await registration.callTool({ name: body.name, arguments: body.arguments ?? {} }, signal)
      json(response, 200, { result: cap(JSON.stringify(result ?? null), this.maxResultChars) })
    } catch (error) {
      // 工具失败不算传输失败：把可读原因回给模型，让它在同一回合内纠正。
      json(response, 200, { error: cap(messageOf(error), 4000) })
    }
  }
}

/** 判断请求是否来自回环地址。 */
function loopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 常数时间比较 Bearer 令牌。 */
function sameToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return given.length === expected.length && given.equals(expected)
}

/** 读取请求体，超过上限时中断。 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) { request.destroy(); reject(new Error(`请求体超过 ${MAX_BODY} 字节`)); return }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** 写 JSON 响应；连接已断开时忽略。 */
function json(response: ServerResponse, status: number, body: unknown): void {
  try {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  } catch {
    // 连接可能已被扩展侧取消。
  }
}

/** 截断过长文本并标注原始长度。 */
function cap(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（共 ${text.length} 字符，已截断）`
}

/** 取一句可诊断的消息。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}
