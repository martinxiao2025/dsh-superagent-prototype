/**
 * The MCP surface: the same fourteen tools the DSH main Session registers, over Streamable HTTP on loopback only, with
 * argument validation, structured failures, and a noisy port that must not stop the orchestrator.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { readFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MAX_BODY, SERVER_VERSION } from '../src/app/mcp.ts'
import { mountTools } from '../src/app/mcp-tools.ts'
import { mainTools, type MainToolsHost } from '../src/app/tools/main.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

type TextContent = { type: 'text'; text: string }
const payload = (result: unknown) => JSON.parse((result as { content: TextContent[] }).content[0]!.text) as Record<string, any>
/** A client and server pair over an in-memory transport, closed by the test. */
async function inMemory(tools: ReturnType<typeof mainTools>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = new Server({ name: 'dsh-superagent-test', version: '0.0.0' }, { capabilities: { tools: {} } })
  mountTools(server, tools)
  await server.connect(serverTransport)
  const client = new Client({ name: 'dsh-superagent-test', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, server }
}
/** Connects a client to the running endpoint, or fails when the endpoint did not start. */
async function connect(host: Host) {
  const port = host.mcpPort()
  expect(port).toBeTypeOf('number')
  const client = new Client({ name: 'dsh-superagent-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  return client
}
const listening = async (server: NetServer, port = 0): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
})
const closeNet = (server: NetServer) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

describe('MCP tool surface', () => {
  it('lists exactly the main Session tools, with their descriptions and input schemas', async () => {
    const tools = mainTools({} as MainToolsHost, { id: 'mcp-test' })
    const { client, server } = await inMemory(tools)
    try {
      const listed = await client.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(tools.map(tool => tool.name))
      expect(listed.tools.map(tool => tool.description)).toEqual(tools.map(tool => tool.description))
      for (const [index, tool] of tools.entries()) {
        const { $schema: _ignored, ...expected } = z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>
        expect(listed.tools[index]!.inputSchema).toEqual(expected)
      }
      expect(listed.tools).toHaveLength(14)
    } finally { await client.close(); await server.close() }
  })

  it('passes no DSH Agent to the assessor, so an MCP image read is refused instead of faked', async () => {
    const agents: unknown[] = []
    const host = { assessor: { read: async (agent: unknown) => { agents.push(agent); return { ok: true } } } } as unknown as MainToolsHost
    const read = mainTools(host, { id: 'mcp-test' }).find(tool => tool.name === 'orchestrator_eval_read')!
    const result = await read.execute({ trigger_id: 't', resource: 'image', image_id: 'a/b', offset: 0 }, new AbortController().signal)
    expect(agents).toEqual([undefined])
    expect(result).toEqual({ ok: true })
  })

  it('reports the package version in initialize', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(SERVER_VERSION).toBe(pkg.version)
  })
})

describe('MCP endpoint', () => {
  let host: Host | undefined
  afterEach(async () => { await host?.stop(); host = undefined })
  it('handshakes, lists, reads, and routes into the Engine, then refuses bad arguments and keeps serving', async () => {
    host = await startRuntime(undefined, { mcpPort: 0 })
    const client = await connect(host)
    try {
      const listed = await client.listTools()
      expect(listed.tools).toHaveLength(14)
      const read = await client.callTool({ name: 'orchestrator_read', arguments: { resource: 'tickets' } })
      expect(read.isError).toBeFalsy()
      expect(payload(read)).toBeTypeOf('object')

      const trigger = feishu('mcp1', 'the build is broken, please fix it')
      host.runtime.receive(trigger)
      await host.runtime.idle()
      const routed = await client.callTool({ name: 'orchestrator_route', arguments: { decisions: [{
        kind: 'accept', trigger_id: trigger.id, title: 'Fix the broken build', worktree_name: 'fix-mcp', acknowledgement: '收到，开始修复。' }] } })
      expect(routed.isError).toBeFalsy()
      const ticket = (payload(routed).results as { ticket?: { ticket_id: string } }[])[0]?.ticket
      expect(ticket?.ticket_id).toBeTruthy()
      expect(host.runtime.store.tickets.get(ticket!.ticket_id)?.id).toBe(ticket!.ticket_id)

      const invalid = await client.callTool({ name: 'orchestrator_route', arguments: { decisions: 'not a list' } })
      expect(invalid.isError).toBe(true)
      expect(payload(invalid).issues.length).toBeGreaterThan(0)
      const unknown = await client.callTool({ name: 'orchestrator_nope', arguments: {} })
      expect(unknown.isError).toBe(true)
      const after = await client.callTool({ name: 'orchestrator_read', arguments: { resource: 'tickets' } })
      expect(after.isError).toBeFalsy()
    } finally { await client.close() }
    const port = host.mcpPort()!
    await host.stop()
    host = undefined
    const reuse = createServer()
    try { await listening(reuse, port) } finally { await closeNet(reuse) }
  }, 30_000)

  it('bounds every request body and answers with a JSON-RPC error rather than resetting the socket', async () => {
    host = await startRuntime(undefined, { mcpPort: 0 })
    const url = `http://127.0.0.1:${host.mcpPort()}/mcp`
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    const init = await fetch(url, { method: 'POST', headers, body: 'x'.repeat(MAX_BODY + 1) })
    expect(init.status).toBe(413)
    expect(((await init.json()) as { error: { message: string } }).error.message).toBe('The MCP request body is too large')
    const malformed = await fetch(url, { method: 'POST', headers, body: '{' })
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: { message: string } }).error.message).toBe('The MCP request body is not JSON')

    // An established session must be bounded too, not only initialize.
    const transport = new StreamableHTTPClientTransport(new URL(url))
    const client = new Client({ name: 'dsh-superagent-test', version: '0.0.0' })
    await client.connect(transport)
    try {
      expect(transport.sessionId).toBeTypeOf('string')
      const established = await fetch(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': transport.sessionId! },
        body: 'x'.repeat(MAX_BODY + 1) })
      expect(established.status).toBe(413)
      expect((await client.listTools()).tools).toHaveLength(14)
    } finally { await client.close() }
  }, 30_000)

  it('reports a busy port in health and keeps the orchestrator running', async () => {
    const blocker = createServer()
    const port = await listening(blocker)
    try {
      host = await startRuntime(undefined, { mcpPort: port })
      expect(host.mcpPort()).toBeUndefined()
      expect(host.runtime.health.mcp?.state).toBe('error')
      expect(host.runtime.store.settings().sources.github?.enabled).toBe(true)
    } finally { await closeNet(blocker) }
  }, 30_000)
})
