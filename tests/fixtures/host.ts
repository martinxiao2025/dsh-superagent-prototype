/**
 * 以 `FakeAgentHost` 驱动真实 `Runtime` 的集成夹具：真实的 Store、Engine、Sources 与面板，
 * 只有模型回合由测试替身承担。`startRuntime()` 返回的对象提供触发、工具、HTTP 与回合控制。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import type { AgentHost, HostHealth, HostState, TurnHandle, TurnRequest, TurnResult } from '../../src/executor/host.ts'
import type { Tool } from '../../src/app/tools/tool.ts'
import { Runtime } from '../../src/app/runtime.ts'
import { Store } from '../../src/app/store.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuTrigger } from '../../src/sources/feishu.ts'
import { Commands } from '../../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../../src/infra/environment.ts'
import type { Trigger } from '../../src/core/index.ts'
import { ticketOfSession } from '../../src/executor/messages.ts'
import { testMachine } from './deployment.ts'

export const MEMBER = 'ou_alice'
export const CHAT = 'oc_team'

/** 构造一个来自 `oc_team` 中 Alice 的飞书提及 Trigger，用 `id` 中的数字作为以秒计的时间戳偏移。 */
export function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  const at = String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000)
  return feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: at,
    mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}

/** 一次被记录下来的消息投递；`mode` 区分唤醒回合的派发与只注入的通知。 */
export interface Delivery { sessionId: string; mode: 'steer' | 'inject'; id: string; text: string }
/** 测试替身里的一个会话：记录收到的回合与状态，供断言读取。 */
export interface FakeAgent {
  readonly id: string
  status: 'idle' | 'running'
  readonly steer: Mock<(message: { content: { type: string; text: string }[] }) => void>
  readonly inject: Mock<(message: unknown) => void>
  readonly cancel: Mock
  readonly followup: Mock
  whenIdle(): Promise<void>
}
/** 尚未回收的回合；`settle` 决定它的结局，可重复调用但只有第一次生效。 */
interface Pending {
  readonly handle: TurnHandle
  readonly sessionId: string
  readonly settle: (result: TurnResult) => void
  readonly done: Promise<TurnResult>
  settled: boolean
}

/**
 * `AgentHost` 的测试替身：记录每次 `dispatch`，按当前状态立即或按测试指令给出结局。
 * 默认自动以 `replies` 中的下一条文本（或一句固定的完成语）结束回合，使 Runtime 的
 * 后台循环无需人工干预即可推进；需要精确控制时用 `hold()` 暂停自动结束再 `release()`。
 */
export class FakeAgentHost implements AgentHost {
  readonly requests: TurnRequest[] = []
  readonly agents = new Map<string, FakeAgent>()
  readonly deliveries: Mock<(delivery: Delivery) => void> = vi.fn()
  /** 每个会话预设的自动回复文本；空时使用默认完成语。 */
  readonly replies = new Map<string, string[]>()
  state: HostState = 'idle'
  detail = ''
  starts = 0
  /** 为真时 `dispatch` 不自动结束回合，直到 `release()` 被调用。 */
  auto = true
  private readonly pending: Pending[] = []
  private turn = 0

  /** 记录一次启动；配置了 `startError` 时把原因写进健康而不抛出。 */
  async start(): Promise<void> {
    this.starts++
    this.state = this.startError ? 'error' : 'ready'
    this.detail = this.startError ? String(this.startError) : '测试宿主可用'
  }
  /** 可选：让 `start()` 报告为不可用。 */
  startError?: string
  /** 最近一次健康观测。 */
  health(): HostHealth { return { state: this.state, detail: this.detail, at: new Date().toISOString() } }
  /** 派发一个回合；宿主未就绪时抛出，与真实宿主一致。 */
  async dispatch(request: TurnRequest): Promise<TurnHandle> {
    if (this.state !== 'ready') throw new Error(`宿主不可用：${this.detail}`)
    this.requests.push(request)
    const startedAt = new Date().toISOString()
    const handle: TurnHandle = { sessionId: request.sessionId, startedAt }
    this.deliveries({ sessionId: request.sessionId, mode: 'steer', id: `turn-${++this.turn}`, text: request.prompt })
    const agent = this.agentOf(request.sessionId)
    agent.status = 'running'
    agent.steer({ content: [{ type: 'text', text: request.prompt }] })
    let resolve!: (result: TurnResult) => void
    const done = new Promise<TurnResult>(settle => { resolve = settle })
    const entry: Pending = { handle, sessionId: request.sessionId, done, settled: false,
      settle: result => { if (entry.settled) return; entry.settled = true; agent.status = 'idle'; resolve(result) } }
    this.pending.push(entry)
    if (this.auto) queueMicrotask(() => this.settle(request.sessionId, startedAt))
    return handle
  }
  /** 回收一个回合；结算后取出该条目，信号中止时以失败结局返回，不抛出。 */
  async collect(handle: TurnHandle, options: { signal?: AbortSignal } = {}): Promise<TurnResult> {
    const entry = this.pending.find(item => item.handle === handle)
    if (!entry) return this.result(handle.sessionId, handle.startedAt, '', '回合已结束')
    const aborted = new Promise<TurnResult>(resolve => {
      options.signal?.addEventListener('abort', () => resolve(this.result(handle.sessionId, handle.startedAt, '', '回合已中止')), { once: true })
    })
    const result = await Promise.race([entry.done, aborted])
    this.pending.splice(this.pending.indexOf(entry), 1)
    return result
  }
  /** 终止所有在途回合并停止宿主。 */
  async stop(): Promise<void> {
    this.state = 'stopped'
    for (const entry of [...this.pending]) entry.settle(this.result(entry.sessionId, entry.handle.startedAt, '', '宿主已停止'))
  }
  /** 预置某个会话接下来若干回合的回复文本。 */
  reply(sessionId: string, ...texts: string[]): void {
    this.replies.set(sessionId, [...this.replies.get(sessionId) ?? [], ...texts])
  }
  /** 暂停自动结束，改为由测试用 `release()` 决定结局。 */
  hold(): void { this.auto = false }
  /** 结束 `sessionId` 最早的一个未结算在途回合。 */
  release(sessionId: string, text: string): void {
    const entry = this.pending.find(item => item.sessionId === sessionId && !item.settled)
    entry?.settle(this.result(sessionId, entry.handle.startedAt, text, undefined))
  }
  /** 让某个会话的下一个未结算回合以失败结束。 */
  fail(sessionId: string, error: string): void {
    const entry = this.pending.find(item => item.sessionId === sessionId && !item.settled)
    entry?.settle(this.result(sessionId, entry.handle.startedAt, '', error))
  }
  /** 取一个会话的替身，没有就创建。 */
  agentOf(sessionId: string): FakeAgent {
    const existing = this.agents.get(sessionId)
    if (existing) return existing
    let status: 'idle' | 'running' = 'idle'
    const idle: (() => void)[] = []
    const agent: FakeAgent = {
      id: sessionId, steer: vi.fn(), inject: vi.fn(), cancel: vi.fn(), followup: vi.fn(),
      get status() { return status }, set status(next) { status = next; if (next === 'idle') for (const wake of idle.splice(0)) wake() },
      whenIdle: () => status === 'idle' ? Promise.resolve() : new Promise<void>(resolve => { idle.push(resolve) }),
    }
    this.agents.set(sessionId, agent)
    return agent
  }
  /** 自动回合的结局：优先使用预设回复，否则是一句固定的完成语。 */
  private settle(sessionId: string, startedAt: string): void {
    const entry = this.pending.find(item => item.sessionId === sessionId && !item.settled)
    if (!entry) return
    const replies = this.replies.get(sessionId) ?? []
    entry.settle(this.result(sessionId, startedAt, replies.shift() ?? 'worker 完成了一轮工作', undefined))
  }
  /** 组装一个回合结局。 */
  private result(sessionId: string, startedAt: string, text: string, error: string | undefined): TurnResult {
    const endedAt = new Date().toISOString()
    return { sessionId, text, exitCode: error ? 1 : 0, startedAt: startedAt || endedAt, endedAt, ...error ? { error } : {} }
  }
}

/**
 * @param seed - 在 Runtime 打开数据库之前写入，例如更早版本存储的记录。
 * @param options - `mcpPort` 在该回环端口上启用 MCP 端点；0 表示向操作系统申请一个空闲端口。
 */
export async function startRuntime(seed?: (store: Store) => void, options: { mcpPort?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-host-'))
  const AGENT = join(directory, 'agent-gh'), BOT = join(directory, 'lark-bot')
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : repository)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  const scoped = 'git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$'
  const answers: Record<string, string> = {
    [`${AGENT} api user`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(AGENT)}\0`,
    [scoped]: `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(AGENT)}\0`,
  }
  /** prepare 命令（`sh -c`）在它被设置期间会等待它。 */
  const hooks: { prepare?: Promise<void> } = {}
  const subprocess = { spawn: vi.fn((spec: { argv: readonly string[] }) => {
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const exited = { exitCode: 0, signal: null }
    const done = argv[0] === 'sh' && hooks.prepare ? hooks.prepare.then(() => exited) : Promise.resolve(exited)
    return { done, collected: { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') },
      stdin: { end: () => {} }, stdout: Readable.from([]), stderr: Readable.from([]), kill: () => true }
  }) }
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n')
  const seeded = new Store(join(directory, 'orchestrator.sqlite'))
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } }, feishu: { enabled: true, config: { cli: BOT } } }
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), sources }))
  seed?.(seeded)
  seeded.close()
  const host = new FakeAgentHost()
  const runtime = new Runtime({ machine: testMachine({ stateDir: directory, promptMaxChars: reference(100000),
    ...(options.mcpPort === undefined ? {} : { mcpEnabled: true, mcpPort: options.mcpPort }) }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, subprocess, host, restart: () => {} })
  await runtime.ready
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { ...sources, feishu: { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })
  host.deliveries.mockClear()

  /** 把一次提示词中的最后一段 JSON 解析出来；找不到时返回 undefined。 */
  const jsonTail = (text: string): Record<string, unknown> | undefined => {
    const body = text.trimEnd()
    for (let start = body.lastIndexOf('{'); start >= 0; start = body.lastIndexOf('{', start - 1)) {
      try { const value = JSON.parse(body.slice(start)) as unknown; if (value && typeof value === 'object') return value as Record<string, unknown> } catch { /* 继续向前找 */ }
    }
    return undefined
  }
  /** 投递给 `sessionId` 的已解析 JSON 载荷，按投递顺序。 */
  const relays = (sessionId: string) => host.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)
    .map(call => jsonTail(call.text)).filter((value): value is Record<string, unknown> => value !== undefined)
  /** 主会话尚未注入的待办通知；同一名称只保留最新一条。 */
  const notices = (): Record<string, unknown>[] => {
    const pending = (runtime.sessions as unknown as { notices: Map<string, { text: string }> }).notices
    return [...pending.values()].map(item => JSON.parse(item.text) as Record<string, unknown>)
  }
  const candidates = () => relays(runtime.masterId).filter(item => item.kind === 'candidate').map(item => item.trigger_id)
  /** 取一个会话（主会话或 `worker-<ticketId>`）的当前工具。 */
  const toolMap = (sessionId: string): Map<string, Tool> | undefined => {
    const ticketId = ticketOfSession(sessionId)
    const ticket = ticketId === undefined ? undefined : runtime.store.tickets.get(ticketId)
    if (ticketId !== undefined && !ticket) return undefined
    return new Map(runtime.tools(ticket).map(item => [item.name, item]))
  }
  const runTool = async (sessionId: string, name: string, args: unknown) => {
    const tool = toolMap(sessionId)?.get(name)
    if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
    return await tool.execute(tool.schema.parse(args), new AbortController().signal) as Record<string, unknown>
  }
  /** 用主 Session 的 orchestrator_route 路由一个 decision，并返回其结果；被拒绝时抛出原因。 */
  async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
    if (results[0]!.refused) throw new Error(String(results[0]!.refused))
    return results[0]!
  }
  /** 驱动 effect 与主会话队列到空闲；回合未结束时不要调用（effect 会等它结束）。 */
  async function drain() {
    for (let round = 0; round < 4; round++) { await runtime.effects.idle(); await runtime.idle() }
    await runtime.sessions.idle()
  }
  /** 接受一个 trigger 为工单，但不等待 launch effect 完成（用于需要人工控制回合的测试）。 */
  async function accept(trigger: Trigger) {
    runtime.receive(trigger)
    await runtime.idle()
    const result = await route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${trigger.id}`, worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' })
    const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    return { trigger, ticket, sessionId: `worker-${ticket.id}`, result }
  }
  /** 接受一个 trigger 并等 worker 的第一回合结束。 */
  async function acceptedTicket(trigger: Trigger) {
    const accepted = await accept(trigger)
    await drain()
    return { trigger, ticket: runtime.store.tickets.get(accepted.ticket.id)!, sessionId: accepted.sessionId }
  }
  async function api(method: string, path: string, json?: unknown) {
    let status = 0, text = ''
    const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
    const origin = `127.0.0.1:${runtime.panelPort}`
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: origin, 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await runtime.handle(req as never, { headersSent: false, writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } } as never)
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  async function stop() {
    await runtime.stop()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  }
  /** 驱动主会话队列与 effect 队列到空闲。 */
  const settle = drain
  return { runtime, directory, host, agents: host.agents, deliveries: host.deliveries, relays, notices, candidates, tools: { get: toolMap },
    runTool, route, accept, acceptedTicket, api, subprocess, hooks, stop, settle, drain, mcpPort: () => runtime.mcpPort }
}
/** 夹具返回值类型。 */
export type Host = Awaited<ReturnType<typeof startRuntime>>
/** 可变的机器级限制引用。 */
const reference = (value: number) => ({ get: () => value })
