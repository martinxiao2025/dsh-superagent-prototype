/** A loopback Streamable HTTP MCP endpoint that exposes the main Session's tools to agent-plugins clients. */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { HealthEntry } from '../infra/health.ts'
import { mountTools } from './mcp-tools.ts'
import type { Tool } from './tools/tool.ts'

const PATH = '/mcp'
/** Largest request body the endpoint reads; the test asserts the 413 by sending one byte more. */
export const MAX_BODY = 4 * 1024 * 1024
const IDLE_MS = 10 * 60 * 1000
const SWEEP_MS = 60 * 1000
const HEADERS_TIMEOUT_MS = 10 * 1000
const REQUEST_TIMEOUT_MS = 30 * 1000
/** Reported in `initialize`; `tests/mcp.spec.ts` asserts it equals `package.json`'s version. */
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
/** Replies in JSON-RPC shape so clients see the failure before any session exists. */
const rpcError = (res: ServerResponse, status: number, code: number, message: string): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}
/** Marks a body the endpoint rejected and already answered. */
const Rejected: unique symbol = Symbol('rejected')
/** The body exceeded `MAX_BODY`; the caller answers 413 instead of resetting the connection. */
class BodyTooLarge extends Error {}
/** Reads and parses a request body, bounded so a client cannot exhaust memory; it stops buffering once over the limit. */
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
    if (tooLarge) { reject(new BodyTooLarge('The MCP request body is too large')); return }
    if (size === 0) { resolve(undefined); return }
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
    catch { reject(new Error('The MCP request body is not JSON')) }
  })
  req.on('error', reject)
})

/**
 * Owns one loopback listener and one transport per MCP session. It binds `127.0.0.1` only and enables the transport's
 * DNS rebinding protection, so a browser page cannot drive the orchestrator through this port.
 */
export class McpEndpoint {
  private readonly sessions = new Map<string, Session>()
  private http?: HttpServer
  private sweepTimer?: NodeJS.Timeout
  private bound?: number
  private stopping?: Promise<void>
  constructor(private readonly options: McpEndpointOptions) {}
  /** The port actually bound; differs from the configured one when that was 0. */
  get port(): number { return this.bound ?? this.options.port }
  /** Starts listening; rejects when the port is unavailable so the caller can report it in health. */
  async start(): Promise<void> {
    const http = createServer((req, res) => { void this.handle(req, res) })
    this.http = http
    // Bound slow clients: headers must arrive quickly, and the whole request within a loopback-sized window.
    http.headersTimeout = HEADERS_TIMEOUT_MS
    http.requestTimeout = REQUEST_TIMEOUT_MS
    http.on('clientError', (error, socket) => {
      this.options.log('MCP client error', error)
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { http.off('listening', listening); reject(error) }
      const listening = () => { http.off('error', failed); resolve() }
      http.once('error', failed)
      http.once('listening', listening)
      http.listen(this.options.port, '127.0.0.1')
    })
    // An error after startup has no startup promise to reject; without a listener it would end the process.
    http.on('error', error => { this.options.log('MCP server error', error) })
    const address = http.address()
    this.bound = typeof address === 'object' && address ? address.port : this.options.port
    this.sweepTimer = setInterval(() => { void this.sweep() }, SWEEP_MS)
    this.sweepTimer.unref()
    this.options.health.set({ state: 'ready', detail: `MCP endpoint on http://127.0.0.1:${this.port}${PATH}` })
  }
  /** Stops listening and closes every session; repeated calls share one promise. */
  stop(): Promise<void> { return this.stopping ??= this.closeAll() }
  private async closeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)))
    const http = this.http
    if (http) {
      await new Promise<void>(resolve => { http.close(() => { resolve() }); http.closeAllConnections() })
    }
    this.options.health.set({ state: 'paused', detail: 'MCP endpoint stopped' })
  }
  /** The host and origin values the transport accepts for DNS rebinding protection. */
  private allowed(): string[] { return [`127.0.0.1:${this.port}`, `localhost:${this.port}`] }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (path !== PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end(`MCP is served at ${PATH}`)
      return
    }
    const header = req.headers['mcp-session-id']
    const id = typeof header === 'string' ? header : undefined
    const session = id ? this.sessions.get(id) : undefined
    if (session) {
      session.last = Date.now()
      // Read POST bodies here too, so the 4 MB cap covers every request, not only initialize.
      if (req.method !== 'POST') { await this.forward(session.transport, req, res); return }
      const body = await this.receive(req, res)
      if (body !== Rejected) await this.forward(session.transport, req, res, body)
      return
    }
    if (id) { rpcError(res, 404, -32001, 'Session not found; initialize a new session'); return }
    if (req.method !== 'POST') { rpcError(res, 400, -32000, 'Only POST can start an MCP session; use the mcp-session-id header after initialize'); return }
    const body = await this.receive(req, res)
    if (body === Rejected) return
    if (!isInitializeRequest(body)) { rpcError(res, 400, -32000, 'The first request must be initialize'); return }
    try {
      await this.open(req, res, body)
    } catch (error) {
      // The client sees a fixed message; the detail stays in the log so a path or stack cannot leak over the port.
      this.options.log('MCP initialize failed', error)
      if (!res.headersSent) rpcError(res, 500, -32603, 'The MCP session could not be initialized')
      else res.end()
    }
  }
  /** Reads one body, answering the client itself when it is too large or not JSON. */
  private async receive(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    try { return await readBody(req) }
    catch (error) {
      const tooLarge = error instanceof BodyTooLarge
      this.options.log('MCP request body rejected', error)
      if (!res.headersSent) {
        rpcError(res, tooLarge ? 413 : 400, -32600, tooLarge ? 'The MCP request body is too large' : 'The MCP request body is not JSON')
      }
      return Rejected
    }
  }
  /** Creates the session's server and transport, then hands it the initialize request. */
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
      await transport.close().catch(() => { /* Closing an unconnected transport is harmless. */ })
      throw error
    }
  }
  private async forward(transport: StreamableHTTPServerTransport, req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
    try { await transport.handleRequest(req, res, body) }
    catch (error) {
      this.options.log('MCP request failed', error)
      if (!res.headersSent) rpcError(res, 500, -32603, 'The MCP request failed')
      else res.end()
    }
  }
  /** Closes one session and forgets it. */
  private async close(id: string): Promise<void> {
    const session = this.sessions.get(id)
    this.sessions.delete(id)
    if (session) await session.transport.close().catch(() => { /* Already closed. */ })
  }
  /** Reclaims sessions that have been idle past `IDLE_MS`, so disconnected clients do not pin transports forever. */
  private async sweep(): Promise<void> {
    const deadline = Date.now() - IDLE_MS
    const idle = [...this.sessions.entries()].filter(([, session]) => session.last < deadline).map(([id]) => id)
    await Promise.allSettled(idle.map(id => this.close(id)))
  }
}
