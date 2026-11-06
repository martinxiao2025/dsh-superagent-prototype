/**
 * `VsCodeLmHost` 与桥协议的单元测试：用一个本机假桥覆盖鉴权失败、无可用模型、
 * 正常回合、超时、取消与桥不可用；不依赖真实 VS Code。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeClient, bridgeFilePath, readBridgeInfo, type BridgeTurn } from '../src/executor/bridge.ts'
import { VsCodeLmHost } from '../src/executor/vscode-lm.ts'

/** 假桥接受的令牌。 */
const TOKEN = 'test-token'

/** 假桥的行为选项。 */
interface FakeOptions {
  /** 服务端期望的令牌；缺省为 `TOKEN`。 */
  readonly token?: string
  /** `/health` 的响应；缺省为就绪且模型为 `deepseek-flash`。 */
  readonly health?: { readonly state: string; readonly model?: string; readonly detail?: string }
  /** 回合结局：`done` 在 `afterMs` 后完成，`running` 永不结束，`failed` 带配额错误，`noModel` 直接 503。 */
  readonly turn?: 'done' | 'running' | 'failed' | 'noModel'
  /** `done` 或 `failed` 的延迟毫秒数，默认 20。 */
  readonly afterMs?: number
  /** 收到工具定义时，假桥回调 Runtime 的工具端点并把结果写进回合文本。 */
  readonly echoTool?: boolean
}

/** 一个跑在回环地址上的假桥。 */
interface FakeBridge {
  /** 发现文件路径。 */
  readonly file: string
  /** 实际端口。 */
  readonly port: number
  /** 收到的请求，形如 `GET /health`。 */
  readonly calls: string[]
  /** 已结束的回合 id。 */
  readonly cancelled: string[]
  /** 派发时收到的请求体。 */
  readonly dispatched: Array<Record<string, unknown>>
  /** 工具回调端点返回的原始响应体。 */
  readonly toolResults: Array<Record<string, unknown>>
  /** 关闭服务并删除临时目录。 */
  close(): Promise<void>
}

/** 读取请求体文本。 */
function readAll(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/**
 * 启动假桥：校验令牌、响应健康检查、维护回合快照，并记录请求。
 * @param options 假桥行为。
 * @returns 假桥句柄。
 */
async function fakeBridge(options: FakeOptions = {}): Promise<FakeBridge> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-lm-bridge-'))
  const file = join(directory, 'lm-bridge.json')
  const calls: string[] = []
  const cancelled: string[] = []
  const dispatched: Array<Record<string, unknown>> = []
  const toolResults: Array<Record<string, unknown>> = []
  const turns = new Map<string, BridgeTurn>()
  const timers: NodeJS.Timeout[] = []
  let created = 0
  const accepted = `Bearer ${options.token ?? TOKEN}`
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    calls.push(`${request.method} ${url.pathname}`)
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(body))
    }
    if (request.headers.authorization !== accepted) {
      json(401, { error: '令牌无效' })
      return
    }
    if (url.pathname === '/health') {
      json(200, options.health ?? { state: 'ready', model: 'deepseek-flash' })
      return
    }
    if (url.pathname === '/turns' && request.method === 'POST') {
      if (options.turn === 'noModel') {
        json(503, { error: '没有可用模型' })
        return
      }
      created += 1
      const turnId = String(created)
      const outcome = options.turn ?? 'done'
      turns.set(turnId, { state: 'running', text: '' })
      void (async () => {
        const body = JSON.parse(await readAll(request)) as Record<string, unknown>
        dispatched.push(body)
        let text = '已修复'
        const tools = Array.isArray(body.tools) ? body.tools as Array<{ name: string }> : []
        if (options.echoTool && tools.length > 0 && typeof body.toolBase === 'string') {
          const toolResponse = await fetch(`${body.toolBase}/call`, {
            method: 'POST',
            headers: { authorization: `Bearer ${String(body.toolToken)}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: tools[0]!.name, arguments: { path: 'src/app.ts' } }),
          })
          const echoed = await toolResponse.json() as Record<string, unknown>
          toolResults.push(echoed)
          text = `工具返回：${String(echoed.result)}`
        }
        const timer = setTimeout(() => {
          if (outcome === 'done') turns.set(turnId, { state: 'done', text, model: 'deepseek-flash', toolCalls: tools.length,
            usage: { inputTokens: 12, outputTokens: 5, estimated: true } })
          else if (outcome === 'failed') turns.set(turnId, { state: 'failed', text: '', error: { kind: 'quota', message: '配额不足' } })
        }, options.afterMs ?? 20)
        timers.push(timer)
        json(202, { turnId })
      })()
      return
    }
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] === 'turns' && segments.length === 2) {
      const turnId = segments[1]!
      if (request.method === 'DELETE') {
        cancelled.push(turnId)
        turns.set(turnId, { state: 'cancelled', text: '', error: { kind: 'cancelled', message: '回合已取消' } })
        response.writeHead(204)
        response.end()
        return
      }
      json(200, turns.get(turnId) ?? { state: 'running', text: '' })
      return
    }
    json(404, { error: '未知路由' })
  })
  const port = await new Promise<number>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  writeFileSync(file, JSON.stringify({ port, token: TOKEN }), 'utf8')
  return {
    file,
    port,
    calls,
    cancelled,
    dispatched,
    toolResults,
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      await new Promise<void>(resolve => { server.close(() => resolve()) })
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** 临时目录，用于“发现文件不存在”的用例。 */
const temporary = (): string => mkdtempSync(join(tmpdir(), 'dsh-lm-bridge-missing-'))

/** 每个用例结束后需要关闭的假桥。 */
const bridges: FakeBridge[] = []
const directories: string[] = []

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('VsCodeLmHost', () => {
  it('normalizes the discovery file and rejects invalid content', async () => {
    const directory = temporary()
    directories.push(directory)
    const file = join(directory, 'lm-bridge.json')
    expect(bridgeFilePath({ DSH_LM_BRIDGE_FILE: file })).toBe(file)
    expect(await readBridgeInfo(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ port: 1 }), 'utf8')
    expect(await readBridgeInfo(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ port: 1234, token: 'abc', model: 'deepseek-flash' }), 'utf8')
    expect(await readBridgeInfo(file)).toEqual({ port: 1234, token: 'abc', pid: undefined, model: 'deepseek-flash', startedAt: undefined })
  })

  it('runs a turn through the bridge and keeps model, usage and text', async () => {
    const bridge = await fakeBridge()
    bridges.push(bridge)
    const host = new VsCodeLmHost({ file: bridge.file, discoverMs: 0, pollMs: 5 })
    await host.start()
    expect(host.health()).toMatchObject({ state: 'ready', detail: 'VS Code 语言模型桥：deepseek-flash' })
    const handle = await host.dispatch({ sessionId: 'ticket-1', directory: tmpdir(), prompt: '修复工单' })
    const result = await host.collect(handle)
    expect(result).toMatchObject({ sessionId: 'ticket-1', text: '已修复', exitCode: 0, model: 'deepseek-flash' })
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5, estimated: true })
    expect(result.error).toBeUndefined()
    expect(bridge.calls.slice(0, 2)).toEqual(['GET /health', 'POST /turns'])
    expect(bridge.calls.filter(call => call === 'GET /turns/1').length).toBeGreaterThan(0)
    await host.stop()
    expect(host.health().state).toBe('stopped')
  })

  it('distinguishes an unauthorized bridge from a missing one', async () => {
    const bridge = await fakeBridge()
    bridges.push(bridge)
    writeFileSync(bridge.file, JSON.stringify({ port: bridge.port, token: 'wrong-token' }), 'utf8')
    const host = new VsCodeLmHost({ file: bridge.file, discoverMs: 0 })
    await host.start()
    expect(host.health().state).toBe('error')
    expect(host.health().detail).toContain('模型访问未授权')
    await expect(host.dispatch({ sessionId: 's', directory: tmpdir(), prompt: 'p' }))
      .rejects.toMatchObject({ kind: 'bridgeUnavailable' })
  })

  it('reports no available model through health and dispatch', async () => {
    const bridge = await fakeBridge({ health: { state: 'noModel', detail: 'selectChatModels 返回空列表' }, turn: 'noModel' })
    bridges.push(bridge)
    const host = new VsCodeLmHost({ file: bridge.file, discoverMs: 0 })
    await host.start()
    expect(host.health().state).toBe('error')
    expect(host.health().detail).toContain('桥未就绪（noModel）')
    await expect(host.dispatch({ sessionId: 's', directory: tmpdir(), prompt: 'p' }))
      .rejects.toMatchObject({ kind: 'noModel' })
  })

  it('maps a missing discovery file to bridgeUnavailable', async () => {
    const directory = temporary()
    directories.push(directory)
    const host = new VsCodeLmHost({ file: join(directory, 'absent.json'), discoverMs: 0 })
    await host.start()
    expect(host.health().state).toBe('error')
    expect(host.health().detail).toContain('找不到桥发现文件')
    await expect(host.dispatch({ sessionId: 's', directory: tmpdir(), prompt: 'p' }))
      .rejects.toMatchObject({ kind: 'bridgeUnavailable' })
  })

  it('cancels the bridge turn when the caller times out', async () => {
    const bridge = await fakeBridge({ turn: 'running' })
    bridges.push(bridge)
    const host = new VsCodeLmHost({ file: bridge.file, discoverMs: 0, pollMs: 5, timeoutMs: 120 })
    await host.start()
    const handle = await host.dispatch({ sessionId: 's', directory: tmpdir(), prompt: 'p' })
    const result = await host.collect(handle)
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain('回合超时')
    expect(bridge.cancelled).toEqual(['1'])
  })

  it('cancels the bridge turn when the caller aborts', async () => {
    const bridge = await fakeBridge({ turn: 'running' })
    bridges.push(bridge)
    const host = new VsCodeLmHost({ file: bridge.file, discoverMs: 0, pollMs: 5 })
    await host.start()
    const handle = await host.dispatch({ sessionId: 's', directory: tmpdir(), prompt: 'p' })
    const controller = new AbortController()
    const collecting = host.collect(handle, { signal: controller.signal })
    controller.abort()
    const result = await collecting
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain('回合已取消')
    expect(bridge.cancelled).toEqual(['1'])
  })

  it('surfaces a model-side failure with its kind', async () => {
    const bridge = await fakeBridge({ turn: 'failed' })
    bridges.push(bridge)
    const host = new VsCodeLmHost({ file: bridge.file, discoverMs: 0, pollMs: 5 })
    await host.start()
    const handle = await host.dispatch({ sessionId: 's', directory: tmpdir(), prompt: 'p' })
    const result = await host.collect(handle)
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain('配额不足')
  })

  it('passes tools to the bridge and serves tool calls on a loopback endpoint', async () => {
    const bridge = await fakeBridge({ echoTool: true })
    bridges.push(bridge)
    const host = new VsCodeLmHost({ file: bridge.file, discoverMs: 0, pollMs: 5 })
    await host.start()
    const seen: Array<{ name: string; arguments: unknown }> = []
    const handle = await host.dispatch({
      sessionId: 'ticket-1', directory: tmpdir(), prompt: '修好它',
      tools: [{ name: 'read_file', description: '读取工作区文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
      callTool: async call => { seen.push(call); return { content: 'export const a = 1' } },
    })
    const result = await host.collect(handle)
    expect(seen).toEqual([{ name: 'read_file', arguments: { path: 'src/app.ts' } }])
    expect(bridge.toolResults).toEqual([{ result: JSON.stringify({ content: 'export const a = 1' }) }])
    expect(result.text).toBe(`工具返回：${JSON.stringify({ content: 'export const a = 1' })}`)
    expect(result.toolCalls).toBe(1)
    const sent = bridge.dispatched[0]!
    expect(sent.tools).toHaveLength(1)
    expect(typeof sent.toolBase).toBe('string')
    expect(sent.toolBase).toContain('127.0.0.1')
    expect(typeof sent.toolToken).toBe('string')
    await host.stop()
  })

  it('does not send a tool endpoint when the turn has no tools', async () => {
    const bridge = await fakeBridge()
    bridges.push(bridge)
    const host = new VsCodeLmHost({ file: bridge.file, discoverMs: 0, pollMs: 5 })
    await host.start()
    const handle = await host.dispatch({ sessionId: 's', directory: tmpdir(), prompt: 'p' })
    await host.collect(handle)
    expect(bridge.dispatched[0]!.toolBase).toBeUndefined()
    expect(bridge.dispatched[0]!.tools).toBeUndefined()
    await host.stop()
  })

  it('maps an HTTP 401 to unauthorized in the client', async () => {
    const bridge = await fakeBridge({ token: 'expected-token' })
    bridges.push(bridge)
    const client = new BridgeClient({ port: bridge.port, token: 'wrong-token' })
    await expect(client.health()).rejects.toMatchObject({ kind: 'unauthorized' })
  })
})
