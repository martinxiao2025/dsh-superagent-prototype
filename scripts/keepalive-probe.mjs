#!/usr/bin/env node
/**
 * A6 保活演练用的就绪探针。
 *
 * 用仓库已有的 MCP 客户端连接 `KEEPALIVE_MCP_URL`，执行 `initialize` + `tools/list`，
 * 再 GET 管理状态接口，把健康条目的 state 汇总成一行 JSON，供外部守护脚本判定就绪。
 *
 * 环境变量：
 *   KEEPALIVE_MCP_URL   缺省 `http://127.0.0.1:3083/mcp`
 *   KEEPALIVE_STATE_URL 缺省 `http://127.0.0.1:3082/orchestrator/api/state`
 *
 * 就绪时输出 `{"ok":true,"tools":14,"names":[...],"health":{...}}` 并以 0 退出；
 * 连接或握手失败时输出 `{"ok":false,"error":"..."}` 并以 1 退出。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const MCP_URL = process.env.KEEPALIVE_MCP_URL ?? 'http://127.0.0.1:3083/mcp'
const STATE_URL = process.env.KEEPALIVE_STATE_URL ?? 'http://127.0.0.1:3082/orchestrator/api/state'

/** 连接 MCP 端点、列出工具并读取管理状态，返回探针输出对象。 */
async function probe() {
  const client = new Client({ name: 'keepalive-probe', version: '0.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)))
    const listed = await client.listTools()
    const response = await fetch(STATE_URL, { headers: { 'x-orchestrator-request': '1' } })
    if (!response.ok) throw new Error(`状态接口返回 HTTP ${response.status}`)
    const state = await response.json()
    const health = Object.fromEntries(Object.entries(state?.health ?? {}).map(([name, entry]) => [name, entry?.state]))
    return { ok: true, tools: listed.tools.length, names: listed.tools.map(tool => tool.name), health }
  } finally {
    await client.close().catch(() => { /* 尚未建立连接时关闭失败是无害的。 */ })
  }
}

try {
  const result = await probe()
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exitCode = 1
}
