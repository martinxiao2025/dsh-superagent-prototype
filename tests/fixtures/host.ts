/**
 * 内存中的 DSH 主机夹具（同 tests/runtime.spec.ts），运行已配置的 Runtime，带有 GitHub 与 Feishu Source、
 * 允许成员 Alice（`ou_alice`）、监听聊天 `oc_team`，以及 `auto` eval 模式。用 `stop()` 停止它。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Runtime } from '../../src/app/runtime.ts'
import { Store } from '../../src/app/store.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuKind, feishuTrigger } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import { Commands } from '../../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../../src/infra/environment.ts'
import type { Trigger } from '../../src/core/index.ts'
import { testMachine } from './deployment.ts'

export const MEMBER = 'ou_alice'
export const CHAT = 'oc_team'

/** 构造一个来自 `oc_team` 中 Alice 的飞书提及 Trigger，用 `id` 中的数字作为以秒计的时间戳偏移。 */
export function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  const at = String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000)
  return feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: at,
    mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}

type RegisteredTool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
type FakeAgent = {
  id: string; status: string; inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  cancel: Mock; inject: Mock<(message: UserMessage) => void>; steer: Mock<(message: UserMessage) => void>; followup: Mock<(message: UserMessage) => void>
}
/** 一条文本消息，如同 DSH 的 job 工具与 subagent 发送通知那样。 */
const notice = (id: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'tool-jobs', form: 'notice' } }) as unknown as UserMessage
type HttpHandler = (req: unknown, res: unknown) => Promise<void>
type Delivery = { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }

/**
 * Executor 所使用的 DSH job registry，连同 DSH 的 job 工具：Session 可见的 job、它们的事件、wait 与
 * kill。`run` 启动 Session 拥有的 job，`output` 让它打印，`end` 结束它（如同其进程那样）；没有 wait
 * 收集到的结束会送达其 owner，owner 空闲时会被唤醒，如同 job 工具投递那样。`released` 统计结束所释放的
 * wait 数。
 * @param owner - Session 的 agent，结束会送达它。
 */
export function jobRegistry(owner: (sessionId: string) => FakeAgent | undefined = () => undefined) {
  type Job = { id: string; owner: string; status: string; label?: string }
  const jobs = new Map<string, Job>()
  const listeners = new Set<{ owner: string; listener: (event: { type: string }) => void }>()
  const waits = new Map<string, ((job: Job) => void)[]>()
  let released = 0
  const emit = (job: Job, type: string) => { for (const listener of [...listeners]) if (listener.owner === job.owner) listener.listener({ type }) }
  const end = (id: string, status = 'completed') => {
    const job = jobs.get(id)!
    job.status = status
    const waiting = waits.get(id) ?? []
    waits.delete(id); released += waiting.length
    for (const wake of waiting) wake({ ...job })
    emit(job, 'settled')
    const agent = waiting.length ? undefined : owner(job.owner)
    const ended = notice(`notice-${id}`, `Job ${id} ended: ${status}`)
    if (agent?.status === 'idle') agent.followup(ended)
    else agent?.inject(ended)
  }
  const service = {
    list: vi.fn((caller: string) => [...jobs.values()].filter(job => job.owner === caller)),
    // wait 随 job 结束，或在其信号中止时失败，此时 job 的结束未被收集。
    wait: vi.fn((id: string, _timeoutMs: number, _caller: string, signal?: AbortSignal) => new Promise<Job>((resolve, reject) => {
      const wake = (job: Job) => { signal?.removeEventListener('abort', abort); resolve(job) }
      const abort = () => { waits.set(id, (waits.get(id) ?? []).filter(item => item !== wake)); reject(new Error('wait aborted')) }
      waits.set(id, [...waits.get(id) ?? [], wake])
      signal?.addEventListener('abort', abort, { once: true })
    })),
    // 被 kill 的 job 稍后结束，如同其进程那样，在测试的假计时器下亦然。
    kill: vi.fn((id: string) => { queueMicrotask(() => { end(id, 'killed') }); return 'requested' }) as Mock<(id: string) => string>,
    events: { subscribe: (filter: { owner: string }, listener: (event: { type: string }) => void) => {
      const entry = { owner: filter.owner, listener }
      listeners.add(entry)
      return () => { listeners.delete(entry) }
    } },
  }
  return { service, end, output: (id: string) => { emit(jobs.get(id)!, 'output') }, get released() { return released },
    run: (owner: string, label?: string) => { const id = `bash-${jobs.size + 1}`; jobs.set(id, { id, owner, status: 'running', label }); return id } }
}

/**
 * Executor 所使用的 DSH subagent。`spawn` 启动 Session 的子级，在其存活期间是一个 agent，此后对 Session 后代的
 * drain 会拒绝它；`settle` 结束一个子级，其结束会唤醒空闲的父级，或在等待父级子级返回之前向运行中的父级
 * steer。释放或中断一个子级会使其 settle；对后代的 drain 会注入它们的结束。catalog 列出 Session 曾有过的
 * 每个子级。
 */
export function subagentRuntime(agents: Map<string, FakeAgent>) {
  const children = new Map<string, { parent: string; live: boolean; settled: PromiseWithResolvers<void> }>()
  const closed = new Set<string>()
  const settle = (id: string, wake = true) => {
    const child = children.get(id)
    if (!child?.live) return
    child.live = false
    agents.delete(id)
    const parent = agents.get(child.parent), ended = notice(`settled-${id}`, `Subagent ${id} settled`)
    if (!wake) parent?.inject(ended)
    else if (parent?.status === 'idle') parent.followup(ended)
    else parent?.steer(ended)
    child.settled.resolve()
  }
  const service = {
    waitForChildren: vi.fn(async (parent: { id: string }) => {
      const live = [...children.values()].filter(child => child.parent === parent.id && child.live)
      await Promise.all(live.map(child => child.settled.promise))
      return live.length > 0
    }),
    listChildren: vi.fn(async (id: string) => [...children].filter(([, child]) => child.parent === id).map(([childId]) => ({ id: childId }))),
    drainChildren: vi.fn(async (_parent: { id: string }, ids: readonly string[]) => { for (const id of ids) settle(id) }),
    drainDescendants: vi.fn(async (parents: readonly { id: string }[]) => {
      for (const parent of parents) {
        closed.add(parent.id)
        for (const [id, child] of children) if (child.parent === parent.id) settle(id, false)
      }
    }),
    interrupt: vi.fn((id: string) => { settle(id) }),
  }
  const spawn = (parent: string) => {
    if (closed.has(parent)) throw new Error('DRAINING: the Session admits no new subagents')
    const id = `child-${children.size + 1}`
    children.set(id, { parent, live: true, settled: Promise.withResolvers<void>() })
    agents.set(id, { id, status: 'running', session: { header: { parentSession: parent } } } as never)
    return id
  }
  return { service, settle, spawn, live: (id: string) => !!children.get(id)?.live }
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
    return { done, collected: { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') } }
  }) }
  const agents = new Map<string, FakeAgent>()
  /** 每个 Session 的下一个 step，它会取走等待它的消息。 */
  const steps = new Map<string, () => void>(), claims = new Map<string, () => void>()
  const tools = new Map<string, Map<string, RegisteredTool>>()
  const deliveries = vi.fn<(request: Delivery) => void>()
  let http!: HttpHandler
  const resolveDefault = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
  const controller = {
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const sessionTools = new Map<string, RegisteredTool>()
      tools.set(sessionId, sessionTools)
      const register = (tool: RegisteredTool) => { sessionTools.set(tool.name, tool); return () => sessionTools.delete(tool.name) }
      agentCtx.reflect.provide('tools', { register, get: () => undefined, restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        // 取出一条待处理消息，如同 DSH 的 inbox 按 id 取出那样。
        remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      // 一个 step 会各取一次消息：所有等待 step 的消息，以及 turn 开始时队列中的下一条，并把它们写入
      // Session 的历史，除非在此之前被 `cut` 掉（如同在其 pre-step 中取消那样）；DSH 会逐一说明。
      const taken = new Set<string>()
      let turn = 0
      const take = (starts: boolean, cut = false) => {
        const agent = agents.get(sessionId)!
        const queued = starts ? inbox.nextTurn.filter(message => !taken.has(message.id)).slice(0, 1) : []
        for (const message of [...inbox.nextStep.filter(item => !taken.has(item.id)), ...queued]) {
          taken.add(message.id)
          ctx.emit('agent/inbox/claimed', { agent, message, turn } as never)
          if (!cut) ctx.emit('session/event', session as never, { type: 'user/message', data: message } as never)
        }
      }
      steps.set(sessionId, () => { take(false) })
      claims.set(sessionId, () => { take(false, true) })
      const deliver = (mode: 'queue' | 'steer') => vi.fn((message: UserMessage) => {
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        deliveries({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
        // 消息会唤醒空闲的 agent：其 turn 立即开始，DSH 会说明，其第一个 step 取走等待中的内容。
        const agent = agents.get(sessionId)!
        if (agent.status !== 'idle') return
        agent.status = 'running'
        ctx.emit('agent/status', { agent, status: 'running' } as never)
        turn++
        take(true)
      })
      const session = { id: sessionId, snapshotEvents: () => [], requestHeader: () => undefined, append: vi.fn() }
      let status = 'idle'
      const idle: (() => void)[] = []
      // 除非保留，取消会丢弃 inbox，且它所停止的 turn 稍后结束，DSH 会说明。
      const cancel = vi.fn((_cause: unknown, options?: { keepInbox?: boolean }) => {
        if (!options?.keepInbox) { inbox.nextTurn.length = 0; inbox.nextStep.length = 0 }
        if (status === 'idle') return
        queueMicrotask(() => {
          const agent = agents.get(sessionId)!
          if (agent.status === 'idle') return
          agent.status = 'idle'
          ctx.emit('agent/status', { agent, status: 'idle' } as never)
        })
      })
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), inject: vi.fn(), session, cancel,
        get status() { return status }, set status(next: string) { status = next; if (next === 'idle') for (const wake of idle.splice(0)) wake() },
        // 一旦其 turn 结束，如同 DSH 的那样。
        whenIdle: () => status === 'idle' ? Promise.resolve() : new Promise<void>(resolve => { idle.push(resolve) }) } as never)
    }),
    selectModel: vi.fn(async () => {}), resolveAgent: vi.fn(resolveDefault), rename: vi.fn(async () => {}),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }),
    inspect: vi.fn(async () => ({ events: [] })),
  }
  const reader = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
  const persistence = { flush: vi.fn(async () => {}), open: vi.fn(async () => reader) }
  const webServer = { host: '127.0.0.1', port: 3082, register: (route: { handler: HttpHandler }) => { http = route.handler; return () => {} } }
  const jobs = jobRegistry(id => agents.get(id))
  const subagents = subagentRuntime(agents)
  const services = { agents, llm: { resolveCallConfig: vi.fn(async (value: unknown) => value) }, sessionController: controller,
    sessionPersistence: persistence, workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess, webServer,
    jobs: jobs.service, subagents: subagents.service }
  const ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const seeded = new Store(join(directory, 'orchestrator.sqlite'))
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } }, feishu: { enabled: true, config: { cli: BOT } } }
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), sources }))
  seed?.(seeded)
  seeded.close()
  const runtime = new Runtime(ctx, testMachine({ stateDir: directory,
    ...(options.mcpPort === undefined ? {} : { mcpEnabled: true, mcpPort: options.mcpPort }) }), vi.fn())
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { ...sources, feishu: { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })
  deliveries.mockClear()

  /** 投递给 `sessionId` 的已解析 JSON 载荷。 */
  const relays = (sessionId: string) => deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)
    .map(call => JSON.parse(call.text) as Record<string, unknown>)
  const candidates = () => relays(runtime.masterId).filter(item => item.kind === 'candidate').map(item => item.trigger_id)
  const runTool = async (sessionId: string, name: string, args: unknown) => {
    const tool = tools.get(sessionId)?.get(name)
    if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
    return await tool.execute(args, { signal: new AbortController().signal }) as Record<string, unknown>
  }
  /** 用主 Session 的 orchestrator_route 路由一个 decision，并返回其结果；被拒绝时抛出原因。 */
  async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
    if (results[0]!.refused) throw new Error(String(results[0]!.refused))
    return results[0]!
  }
  async function acceptedTicket(trigger: Trigger) {
    runtime.receive(trigger)
    await runtime.idle()
    const result = await route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${trigger.id}`, worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' })
    await runtime.idle()
    const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    return { trigger, ticket, sessionId: `worker-${ticket.id}` }
  }
  async function api(method: string, path: string, json?: unknown) {
    let status = 0, text = ''
    const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  async function stop() { await runtime.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  /** Session 的模型进入下一个 step，取走自上次以来 steer 进来的消息。 */
  const step = (sessionId: string) => { steps.get(sessionId)!() }
  /** worker 的一个 step 取走等待它的内容，并在 Session 取走它之前被切断。 */
  const claim = (sessionId: string) => { claims.get(sessionId)!() }
  return { runtime, ctx, directory, agents, tools, deliveries, relays, candidates, runTool, route, acceptedTicket, api, controller, subprocess, hooks, resolveDefault, stop,
    jobs, subagents, step, claim, /** 端点启动后绑定的 MCP 端口。 */ mcpPort: () => runtime.mcpPort }
}
export type Host = Awaited<ReturnType<typeof startRuntime>>
