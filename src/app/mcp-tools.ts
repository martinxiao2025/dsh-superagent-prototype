/** Maps the main Session's tools onto an MCP server, so the tool surface has exactly one source: `main.ts`. */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { UserError } from '../core/index.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import type { Tool } from './tools/tool.ts'

/** JSON Schema object MCP clients receive as a tool's `inputSchema`. */
interface InputSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}
/** The tools an MCP client sees: the same fourteen the DSH main Session registers, scoped by id only. */
export function mcpTools(host: MainToolsHost, id: string): Tool[] {
  return mainTools(host, { id })
}
const text = (value: unknown) => ({ type: 'text' as const,
  text: typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value) })
/** Turns a rejection into an MCP tool error while keeping the fixed `code` callers already match on. */
const failure = (error: unknown) => {
  const body = error instanceof UserError ? { error: error.message, code: error.code } : { error: error instanceof Error ? error.message : String(error) }
  return { content: [text(body)], isError: true }
}
/**
 * Registers `tools/list` and `tools/call` on `server`. Arguments are parsed with the tool's own zod schema before the
 * call, because MCP transports do not enforce input schemas and the schemas carry defaults, strictness, and refinements.
 */
export function mountTools(server: Server, tools: readonly Tool[]): void {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  // The generated schema is the single contract: strip only the meta key MCP does not need.
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
