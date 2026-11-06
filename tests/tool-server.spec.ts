/**
 * `ToolServer` 的单元测试：只绑回环、按回合一次性令牌鉴权、未知回合拒绝、
 * 工具失败以文本回传而不算传输失败、结果超长截断。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ToolServer } from '../src/executor/tool-server.ts'

/** 每个用例结束后要关闭的服务。 */
const servers: ToolServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

/** 启动一个注册了 `turn-1` 的工具服务，`callTool` 由用例决定。 */
async function serve(callTool: (call: { name: string; arguments: unknown }, signal?: AbortSignal) => Promise<unknown>, maxResultChars?: number) {
  const server = new ToolServer({ timeoutMs: 1000, ...(maxResultChars === undefined ? {} : { maxResultChars }) })
  servers.push(server)
  const endpoint = await server.register('turn-1', callTool)
  return { server, endpoint }
}

/** 向端点发一次调用，返回状态码与解析后的响应体。 */
async function call(endpoint: { base: string; token: string }, body: unknown, token = endpoint.token) {
  const response = await fetch(`${endpoint.base}/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

describe('ToolServer', () => {
  it('serves a registered turn on a loopback port', async () => {
    const { server, endpoint } = await serve(async call => ({ echoed: call.name, path: (call.arguments as { path: string }).path }))
    expect(server.listening).toBeGreaterThan(0)
    expect(endpoint.base).toContain(`127.0.0.1:${server.listening}`)
    const result = await call(endpoint, { name: 'read', arguments: { path: 'src/app.ts' } })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ result: JSON.stringify({ echoed: 'read', path: 'src/app.ts' }) })
  })

  it('rejects a wrong token and an unknown turn without invoking the tool', async () => {
    let invoked = 0
    const { endpoint } = await serve(async () => { invoked += 1; return 'ok' })
    const denied = await call(endpoint, { name: 'read', arguments: {} }, 'wrong')
    expect(denied.status).toBe(401)
    expect(invoked).toBe(0)
    const missing = await fetch(`${endpoint.base.replace('turn-1', 'turn-9')}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read', arguments: {} }),
    })
    expect(missing.status).toBe(404)
    expect(invoked).toBe(0)
  })

  it('rejects a non-POST route and a malformed body', async () => {
    const { endpoint } = await serve(async () => 'ok')
    const wrongRoute = await fetch(`${endpoint.base}`, { headers: { authorization: `Bearer ${endpoint.token}` } })
    expect(wrongRoute.status).toBe(404)
    const badBody = await fetch(`${endpoint.base}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: '{',
    })
    expect(badBody.status).toBe(400)
  })

  it('returns a tool failure as model-visible text instead of a transport error', async () => {
    const { endpoint } = await serve(async () => { throw new Error('文件不存在：src/missing.ts') })
    const result = await call(endpoint, { name: 'read', arguments: { path: 'src/missing.ts' } })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ error: '文件不存在：src/missing.ts' })
  })

  it('caps an oversized tool result', async () => {
    const { endpoint } = await serve(async () => 'x'.repeat(200), 50)
    const result = await call(endpoint, { name: 'read', arguments: {} })
    expect(String(result.body.result)).toContain('已截断')
    // JSON 序列化后首字符是引号，所以截断点落在 49 个 x 之后。
    expect(String(result.body.result)).toBe(`"${'x'.repeat(49)}…（共 202 字符，已截断）`)
  })

  it('stops serving after unregister and after stop', async () => {
    const { server, endpoint } = await serve(async () => 'ok')
    server.unregister('turn-1')
    expect((await call(endpoint, { name: 'read', arguments: {} })).status).toBe(404)
    await server.stop()
    expect(server.listening).toBe(0)
    await expect(fetch(`${endpoint.base}/call`, { method: 'POST', body: '{}' })).rejects.toThrow()
  })
})
