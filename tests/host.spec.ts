import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CopilotCliHost, parseTurnOutput } from '../src/executor/copilot.ts'
import type { TurnRequest } from '../src/executor/host.ts'
import { FakeAgentHost } from './fixtures/agent-host.ts'

/** 替身 CLI：按 `--scenario` 模拟正常、失败、超时与不可解析的输出。 */
const SCRIPT = String.raw`
import { appendFileSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const at = argv.indexOf('--scenario')
const scenario = at >= 0 ? argv[at + 1] : 'ok'
const out = process.env.FAKE_OUTPUT_FILE
if (out) appendFileSync(out, JSON.stringify(argv) + '\n')
const mcpAt = argv.indexOf('--additional-mcp-config')
if (mcpAt >= 0 && out) {
  const spec = argv[mcpAt + 1] ?? ''
  if (spec.startsWith('@')) appendFileSync(out, 'MCP:' + readFileSync(spec.slice(1), 'utf8') + '\n')
}
if (argv.includes('--version')) {
  process.stdout.write('1.0.0-fake\n')
  process.exit(0)
}
if (scenario === 'fail') {
  process.stderr.write('模型不可用：配额已用尽\n')
  process.exit(3)
}
if (scenario === 'garbage') {
  process.stdout.write('{不是 JSON\n')
  process.exit(0)
}
if (scenario === 'hang') {
  setInterval(() => {}, 1000)
  process.stdin.resume()
} else {
  let input = ''
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => {
    if (process.env.FAKE_PROMPT_FILE) appendFileSync(process.env.FAKE_PROMPT_FILE, input)
    const text = scenario === 'json'
      ? JSON.stringify({ type: 'assistant.message', data: { content: [{ type: 'text', text: '完成：工单已就绪。' }] } })
      : '完成：工单已就绪。'
    process.stdout.write(text + '\n')
  })
}
`

let directory = ''
let cli = ''
let promptFile = ''
let argsFile = ''

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-host-spec-'))
  cli = join(directory, 'fake-cli.mjs')
  await writeFile(cli, SCRIPT, 'utf8')
  promptFile = join(directory, 'prompt.txt')
  argsFile = join(directory, 'args.jsonl')
})
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

/** 用替身脚本构造一个宿主；`scenario` 决定替身的行为。 */
function make(scenario: string, extra: { timeoutMs?: number } = {}): CopilotCliHost {
  return new CopilotCliHost({ command: process.execPath, commandArgs: [cli, '--scenario', scenario],
    env: { FAKE_PROMPT_FILE: promptFile, FAKE_OUTPUT_FILE: argsFile }, ...extra })
}
/** 派发并立即回收一个回合。 */
async function turn(host: CopilotCliHost, request: TurnRequest) {
  const handle = await host.dispatch(request)
  return host.collect(handle)
}
/** 最近一次调用的参数；跳过 MCP 配置的回显行。 */
async function lastArgs(): Promise<string[]> {
  const lines = (await readFile(argsFile, 'utf8')).trim().split('\n').filter(line => line.startsWith('['))
  return JSON.parse(lines[lines.length - 1] ?? '[]') as string[]
}
/** 最近一次记录的 MCP 配置文件内容。 */
async function lastMcp(): Promise<string> {
  const lines = (await readFile(argsFile, 'utf8')).trim().split('\n').filter(line => line.startsWith('MCP:'))
  return lines[lines.length - 1]?.slice(4) ?? ''
}
const request: TurnRequest = { sessionId: '0192f0f4-0000-7000-8000-000000000001', directory: '', prompt: '第一行\n第二行。' }

describe('CopilotCliHost', () => {
  it('自检为就绪，并记录 CLI 版本', async () => {
    const host = make('ok')
    await host.start()
    expect(host.health().state).toBe('ready')
    expect(host.health().detail).toContain('1.0.0-fake')
    await host.stop()
  })
  it('无法启动的命令被记为健康错误，而不是抛出', async () => {
    const host = new CopilotCliHost({ command: join(directory, '没有这个-cli') })
    await host.start()
    expect(host.health().state).toBe('error')
    expect(host.health().detail).toContain('ENOENT')
  })
  it('把提示词经 stdin 送达，并解析 JSONL 回复', async () => {
    const host = make('json')
    await host.start()
    const result = await turn(host, { ...request, directory, model: 'gpt-5.4' })
    expect(result.error).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('完成：工单已就绪。')
    expect(await readFile(promptFile, 'utf8')).toBe(request.prompt)
    const args = await lastArgs()
    expect(args).toContain('--allow-all-tools')
    expect(args[args.indexOf('--output-format') + 1]).toBe('json')
    expect(args[args.indexOf('--session-id') + 1]).toBe(request.sessionId)
    expect(args[args.indexOf('-C') + 1]).toBe(directory)
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.4')
    await host.stop()
  })
  it('把非零退出码的错误交给调用方', async () => {
    const host = make('fail')
    await host.start()
    const result = await turn(host, { ...request, directory })
    expect(result.exitCode).toBe(3)
    expect(result.error).toContain('模型不可用：配额已用尽')
    await host.stop()
  })
  it('超时终止回合并给出原因', async () => {
    const host = make('hang', { timeoutMs: 150 })
    await host.start()
    const result = await turn(host, { ...request, directory })
    expect(result.error).toContain('超时')
    expect(result.exitCode).not.toBe(0)
    await host.stop()
  })
  it('无法解析的输出被判为失败，而不是当成回复', async () => {
    const host = make('garbage')
    await host.start()
    const result = await turn(host, { ...request, directory })
    expect(result.text).toBe('')
    expect(result.error).toContain('解析')
    await host.stop()
  })
  it('把 MCP 配置写成 @ 文件传给 CLI，并在回收后删除', async () => {
    const host = make('json')
    await host.start()
    const result = await turn(host, { ...request, directory,
      mcp: [{ name: 'orchestrator', url: 'http://127.0.0.1:3083/worker/abc' }] })
    expect(result.error).toBeUndefined()
    const args = await lastArgs()
    const spec = args[args.indexOf('--additional-mcp-config') + 1] ?? ''
    expect(spec.startsWith('@')).toBe(true)
    expect(await lastMcp()).toContain('http://127.0.0.1:3083/worker/abc')
    expect(existsSync(spec.slice(1))).toBe(false)
    await host.stop()
  })
  it('停止会终止在途回合，并拒绝后续派发', async () => {
    const host = make('hang', { timeoutMs: 60_000 })
    await host.start()
    const handle = await host.dispatch({ ...request, directory })
    await host.stop()
    expect((await host.collect(handle)).exitCode).not.toBe(0)
    expect(host.health().state).toBe('stopped')
    await expect(host.dispatch({ ...request, directory })).rejects.toThrow('宿主已停止')
  })
})

describe('parseTurnOutput', () => {
  it('纯文本格式保留整段输出', () => {
    expect(parseTurnOutput('第一行\n第二行\n', 'text')).toEqual({ text: '第一行\n第二行', malformed: 0 })
  })
  it('JSONL 格式只取助手与结果事件', () => {
    const stdout = [
      JSON.stringify({ type: 'tool.call', data: { name: 'read' } }),
      JSON.stringify({ type: 'assistant.message', data: { content: [{ type: 'text', text: '已交付。' }] } }),
      JSON.stringify({ type: 'result', result: '完成。' }),
    ].join('\n')
    expect(parseTurnOutput(stdout, 'json')).toEqual({ text: '已交付。\n完成。', malformed: 0 })
  })
  it('混入无法解析的行时只计数，不丢弃可解析的回复', () => {
    const stdout = ['{坏行', JSON.stringify({ type: 'assistant.message', data: { content: [{ type: 'text', text: '好的。' }] } })].join('\n')
    expect(parseTurnOutput(stdout, 'json')).toEqual({ text: '好的。', malformed: 1 })
  })
})

describe('FakeAgentHost', () => {
  it('记录请求并按顺序回答，停止后不再就绪', async () => {
    const host = new FakeAgentHost([{ text: '第一步完成。' }, { text: '第二步完成。' }])
    await host.start()
    expect(host.health().state).toBe('ready')
    const first = await host.dispatch({ ...request, directory })
    expect((await host.collect(first)).text).toBe('第一步完成。')
    const second = await host.dispatch({ ...request, directory })
    expect((await host.collect(second)).text).toBe('第二步完成。')
    expect(host.requests).toHaveLength(2)
    await host.stop()
    expect(host.health().state).toBe('idle')
  })
})
