/** 仅限回环的 Streamable HTTP MCP 端点，把主 Session 的工具暴露给 agent-plugins 客户端。 */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { HealthEntry } from '../infra/health.ts'
import { mountTools } from './mcp-tools.ts'
import type { Tool } from './tools/tool.ts'

const PATH = '/mcp'
/** 端点读取的最大请求体；测试会多发一个字节来断言 413。 */
export const MAX_BODY = 4 * 1024 * 1024
const IDLE_MS = 10 * 60 * 1000
const SWEEP_MS = 60 * 1000
const HEADERS_TIMEOUT_MS = 10 * 1000
const REQUEST_TIMEOUT_MS = 30 * 1000
/** 在 `initialize` 中上报；`tests/mcp.spec.ts` 断言它等于 `package.json` 的版本。 */
export const SERVER_VERSION = '0.1.0'

export interface McpEndpointOptions {
  readonly port: number
  readonly tools: readonly Tool[]
  readonly health: HealthEntry
  readonly log: (message: string, error?: unknown) => void
}
interface Session {
  readonly transport: StreamableHTTPServerTransport
  readonly server: Server
  last: number
}
/** 以 JSON-RPC 形状回复，使客户端在任何 session 建立之前也能看到失败。 */
const rpcError = (res: ServerResponse, status: number, code: number, message: string): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}
/** 标记端点已经拒绝并已答复的请求体。 */
const Rejected: unique symbol = Symbol('rejected')
/** 请求体超过 `MAX_BODY`；调用方直接答复 413，而不是重置连接。 */
class BodyTooLarge extends Error {}
/** 读取并解析请求体，并加以限额以免客户端耗尽内存；超过上限后立即停止缓冲。 */
const readBody = (req: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  req.on('data', chunk => {
    if (tooLarge) return
    size += chunk.length
    if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; return }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (tooLarge) { reject(new BodyTooLarge('MCP 请求体过大')); return }
    if (size === 0) { resolve(undefined); return }
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
    catch { reject(new Error('MCP 请求体不是 JSON')) }
  })
  req.on('error', reject)
})

/**
 * 持有单个回环监听器，并为每个 MCP session 持有一个 transport。只绑定 `127.0.0.1` 并启用 transport 的
 * DNS rebinding 防护，使浏览器页面无法经此端口驱动编排器。
 */
export class McpEndpoint {
  private readonly sessions = new Map<string, Session>()
  private http?: HttpServer
  private sweepTimer?: NodeJS.Timeout
  private bound?: number
  private stopping?: Promise<void>
  constructor(private readonly options: McpEndpointOptions) {}
  /** 实际绑定的端口；当配置值为 0 时与配置值不同。 */
  get port(): number { return this.bound ?? this.options.port }
  /** 开始监听；端口不可用时拒绝，以便调用方在健康状态中上报。 */
  async start(): Promise<void> {
    const http = createServer((req, res) => { void this.handle(req, res) })
    this.http = http
    // 启动之后的错误没有启动 promise 可拒绝；若没有监听器，它会终结进程。
    http.on('error', error => { this.options.log('MCP 服务器错误', error) })
    // 约束慢客户端：请求头必须尽快到达，整个请求需在回环场景合理的窗口内完成。
    http.headersTimeout = HEADERS_TIMEOUT_MS
    http.requestTimeout = REQUEST_TIMEOUT_MS
    http.on('clientError', (error, socket) => {
      this.options.log('MCP 客户端错误', error)
      socket.destroy()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { http.off('listening', listening); reject(error) }
        const listening = () => { http.off('error', failed); resolve() }
        http.once('error', failed)
        http.once('listening', listening)
        http.listen(this.options.port, '127.0.0.1')
      })
    } catch (error) {
      // 监听失败不会留下可停止的监听器；忘掉该 server，使 `stop()` 不会报告过期的端点。
      this.http = undefined
      http.close(() => { /* 从未监听过的 server 没有可关闭的内容。 */ })
      throw error
    }
    const address = http.address()
    this.bound = typeof address === 'object' && address ? address.port : this.options.port
    this.sweepTimer = setInterval(() => { void this.sweep() }, SWEEP_MS)
    this.sweepTimer.unref()
    this.options.health.set({ state: 'ready', detail: `MCP 端点位于 http://127.0.0.1:${this.port}${PATH}` })
  }
  /** 停止监听并关闭所有 session；重复调用共享同一个 promise。 */
  stop(): Promise<void> { return this.stopping ??= this.closeAll() }
  private async closeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)))
    const http = this.http
    if (http) {
      await new Promise<void>(resolve => { http.close(() => { resolve() }); http.closeAllConnections() })
    }
    this.options.health.set({ state: 'paused', detail: 'MCP 端点已停止' })
  }
  /** transport 为 DNS rebinding 防护所接受的 host 与 origin 值。 */
  private allowed(): string[] { return [`127.0.0.1:${this.port}`, `localhost:${this.port}`] }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (path !== PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end(`MCP 服务位于 ${PATH}`)
      return
    }
    const header = req.headers['mcp-session-id']
    const id = typeof header === 'string' ? header : undefined
    const session = id ? this.sessions.get(id) : undefined
    if (session) {
      session.last = Date.now()
      // 这里也读取 POST 请求体，使 4 MB 上限覆盖每个请求，而不只是 initialize。
      if (req.method !== 'POST') { await this.forward(session.transport, req, res); return }
      const body = await this.receive(req, res)
      if (body !== Rejected) await this.forward(session.transport, req, res, body)
      return
    }
    if (id) { rpcError(res, 404, -32001, 'Session 不存在；请初始化新的 Session'); return }
    if (req.method !== 'POST') { rpcError(res, 400, -32000, '只有 POST 能创建 MCP Session；initialize 之后请使用 mcp-session-id 请求头'); return }
    const body = await this.receive(req, res)
    if (body === Rejected) return
    if (!isInitializeRequest(body)) { rpcError(res, 400, -32000, '第一个请求必须是 initialize'); return }
    try {
      await this.open(req, res, body)
    } catch (error) {
      // 客户端只看到固定消息；细节留在日志中，避免路径或堆栈经该端口泄漏。
      this.options.log('MCP initialize 失败', error)
      if (!res.headersSent) rpcError(res, 500, -32603, 'MCP Session 无法初始化')
      else res.end()
    }
  }
  /** 读取一个请求体；过大或非 JSON 时由端点自行答复客户端。 */
  private async receive(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    try { return await readBody(req) }
    catch (error) {
      const tooLarge = error instanceof BodyTooLarge
      this.options.log('MCP 请求体被拒绝', error)
      if (!res.headersSent) {
        rpcError(res, tooLarge ? 413 : 400, -32600, tooLarge ? 'MCP 请求体过大' : 'MCP 请求体不是 JSON')
      }
      return Rejected
    }
  }
  /** 创建该 session 的 server 与 transport，然后把 initialize 请求交给它。 */
  private async open(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    let server: Server | undefined
    const hosts = this.allowed()
    const origins = hosts.map(host => `http://${host}`)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: hosts,
      allowedOrigins: origins,
      onsessioninitialized: id => {
        if (server) this.sessions.set(id, { transport, server, last: Date.now() })
      },
      onsessionclosed: id => { this.sessions.delete(id) },
    })
    server = new Server({ name: 'dsh-superagent', version: SERVER_VERSION }, { capabilities: { tools: {} } })
    mountTools(server, this.options.tools)
    try {
      await server.connect(transport)
      await this.forward(transport, req, res, body)
    } catch (error) {
      await transport.close().catch(() => { /* 关闭未连接的 transport 是无害的。 */ })
      throw error
    }
  }
  private async forward(transport: StreamableHTTPServerTransport, req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
    try { await transport.handleRequest(req, res, body) }
    catch (error) {
      this.options.log('MCP 请求失败', error)
      if (!res.headersSent) rpcError(res, 500, -32603, 'MCP 请求失败')
      else res.end()
    }
  }
  /** 关闭一个 session 并遗忘它。 */
  private async close(id: string): Promise<void> {
    const session = this.sessions.get(id)
    this.sessions.delete(id)
    if (session) await session.transport.close().catch(() => { /* 已经关闭。 */ })
  }
  /** 回收空闲超过 `IDLE_MS` 的 session，使断开的客户端不会永久占住 transport。 */
  private async sweep(): Promise<void> {
    const deadline = Date.now() - IDLE_MS
    const idle = [...this.sessions.entries()].filter(([, session]) => session.last < deadline).map(([id]) => id)
    await Promise.allSettled(idle.map(id => this.close(id)))
  }
}
