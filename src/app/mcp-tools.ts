/** 把主 Session 的工具映射到 MCP server，使工具面只有一个来源：`main.ts`。 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { UserError } from '../core/index.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import type { Tool } from './tools/tool.ts'

/** MCP 客户端作为工具 `inputSchema` 收到的 JSON Schema 对象。 */
interface InputSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}
/** MCP 客户端看到的工具：与 DSH 主 Session 注册的 14 个完全相同，仅按 id 限定作用域。 */
export function mcpTools(host: MainToolsHost, id: string): Tool[] {
  return mainTools(host, { id })
}
const text = (value: unknown) => ({ type: 'text' as const,
  text: typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value) })
/** 把拒绝转换为 MCP 工具错误，同时保留调用方已匹配的固定 `code`。 */
const failure = (error: unknown) => {
  const body = error instanceof UserError ? { error: error.message, code: error.code } : { error: error instanceof Error ? error.message : String(error) }
  return { content: [text(body)], isError: true }
}
/**
 * 在 `server` 上注册 `tools/list` 与 `tools/call`。调用前先用工具自身的 zod schema 解析参数，
 * 因为 MCP 传输层不强制校验输入 schema，而这些 schema 带有默认值、严格模式与 refine 约束。
 */
export function mountTools(server: Server, tools: readonly Tool[]): void {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  // 生成的 schema 就是唯一契约：只去掉 MCP 不需要的元数据键。
  const schemaOf = (tool: Tool): InputSchema => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>
    return { type: 'object', ...schema } as InputSchema
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: schemaOf(tool) })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name)
    if (!tool) return failure(new Error(`Unknown tool ${request.params.name}; call tools/list for the available tools`))
    const parsed = tool.schema.safeParse(request.params.arguments ?? {})
    if (!parsed.success) {
      return { content: [text({ error: 'Invalid arguments', issues: parsed.error.issues.map(issue => ({
        path: issue.path.join('.'), message: issue.message })) })], isError: true }
    }
    try { return { content: [text(await tool.execute(parsed.data, extra.signal))] } }
    catch (error) { return failure(error) }
  })
}
